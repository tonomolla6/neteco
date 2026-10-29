import type { VerifiedSessionClaims } from './authorization'
import {
  InventoryPlanningError,
  authorizePlanning,
  canonicalJson,
  planningNow,
  recordCommandStatement,
  runIdempotent,
  sha256Hex,
  type PlanningOptions
} from './inventory-planning-core'
import {
  reorderEvaluateInputSchema,
  reorderPolicyInputSchema,
  suggestionDecisionInputSchema
} from '../../shared/inventory-planning'

export interface ReorderPolicyView {
  variantId: string
  sku: string
  leadTimeDays: number
  reviewDays: number
  demandWindowDays: number
  orderMultiple: number
  minOrderQuantity: number
  safetyStock: number
  version: number
  updatedAt: string
}
export interface PurchaseSuggestionView {
  id: string
  variantId: string
  sku: string
  status: 'pending' | 'approved' | 'rejected' | 'superseded'
  positionQuantity: number
  safetyStock: number
  leadTimeDays: number
  dailyDemand: number
  reorderPoint: number
  suggestedQuantity: number
  approvedQuantity: number | null
  decisionNote: string | null
  version: number
  createdAt: string
}

const MAX_QTY = 1_000_000

function parse<T>(schema: { safeParse: (v: unknown) => { success: boolean; data?: T } }, input: unknown): T {
  const parsed = schema.safeParse(input)
  if (!parsed.success) throw new InventoryPlanningError('invalid_input')
  return parsed.data as T
}

/** Pure reorder math (testable): reorder point = demand*lead + safety; order up to demand*(lead+review) + safety. */
export function computeReorder(args: {
  position: number
  safetyStock: number
  leadTimeDays: number
  reviewDays: number
  demandMilliPerDay: number
  orderMultiple: number
  minOrderQuantity: number
}) {
  const reorderPoint = Math.ceil((args.demandMilliPerDay * args.leadTimeDays) / 1000) + args.safetyStock
  const target = Math.ceil((args.demandMilliPerDay * (args.leadTimeDays + args.reviewDays)) / 1000) + args.safetyStock
  const needed = args.position <= reorderPoint
  const raw = Math.max(target - args.position, args.minOrderQuantity)
  const suggestedQuantity = Math.min(MAX_QTY, Math.ceil(raw / args.orderMultiple) * args.orderMultiple)
  return { reorderPoint, target, needed, suggestedQuantity }
}

export async function upsertReorderPolicy(
  database: D1Database,
  claims: VerifiedSessionClaims,
  input: unknown,
  commandId: string,
  options?: PlanningOptions
) {
  await authorizePlanning(database, claims, 'inventory.write', options)
  const data = parse(reorderPolicyInputSchema, input)
  const now = planningNow(options)
  const payloadHash = await sha256Hex(canonicalJson({ action: 'policy', ...data }))
  return runIdempotent(database, { commandId, scope: 'reorder', payloadHash }, async () => {
    const variant = await database.prepare('SELECT id FROM variants WHERE id = ?1').bind(data.variantId).first()
    if (!variant) throw new InventoryPlanningError('not_found')
    const current = await database
      .prepare('SELECT version FROM inventory_reorder_policies WHERE variant_id = ?1')
      .bind(data.variantId)
      .first<{ version: number }>()
    if ((current?.version ?? 0) !== data.expectedVersion) throw new InventoryPlanningError('version_conflict')
    const version = data.expectedVersion + 1
    const response = { variantId: data.variantId, version }
    await authorizePlanning(database, claims, 'inventory.write', options)
    const write = current
      ? database
          .prepare(
            `UPDATE inventory_reorder_policies SET lead_time_days=?2, review_days=?3, demand_window_days=?4,
             order_multiple=?5, min_order_quantity=?6, version=?7, updated_by=?8, updated_at=?9
             WHERE variant_id=?1 AND version=?10`
          )
          .bind(
            data.variantId,
            data.leadTimeDays,
            data.reviewDays,
            data.demandWindowDays,
            data.orderMultiple,
            data.minOrderQuantity,
            version,
            claims.identityId,
            now,
            data.expectedVersion
          )
      : database
          .prepare(
            `INSERT INTO inventory_reorder_policies(variant_id,lead_time_days,review_days,demand_window_days,order_multiple,min_order_quantity,version,updated_by,updated_at)
             VALUES(?1,?2,?3,?4,?5,?6,1,?7,?8)`
          )
          .bind(
            data.variantId,
            data.leadTimeDays,
            data.reviewDays,
            data.demandWindowDays,
            data.orderMultiple,
            data.minOrderQuantity,
            claims.identityId,
            now
          )
    await database.batch([
      write,
      recordCommandStatement(database, {
        commandId,
        actorId: claims.identityId,
        scope: 'reorder',
        action: 'policy',
        targetId: data.variantId,
        payloadHash,
        response,
        now,
        afterChange: true
      })
    ])
    const stored = await database
      .prepare('SELECT 1 AS ok FROM inventory_planning_commands WHERE command_id = ?1')
      .bind(commandId)
      .first()
    if (!stored) throw new InventoryPlanningError('version_conflict')
    return response
  })
}

export async function readReorderPolicies(
  database: D1Database,
  claims: VerifiedSessionClaims,
  options?: PlanningOptions & { limit?: number }
): Promise<ReorderPolicyView[]> {
  await authorizePlanning(database, claims, 'inventory.read', options)
  const limit = Math.min(Math.max(options?.limit ?? 100, 1), 200)
  const { results } = await database
    .prepare(
      `SELECT p.variant_id variantId, v.sku, p.lead_time_days leadTimeDays, p.review_days reviewDays,
              p.demand_window_days demandWindowDays, p.order_multiple orderMultiple,
              p.min_order_quantity minOrderQuantity, v.safety_stock safetyStock, p.version, p.updated_at updatedAt
       FROM inventory_reorder_policies p JOIN variants v ON v.id = p.variant_id
       ORDER BY v.sku LIMIT ?1`
    )
    .bind(limit)
    .all<ReorderPolicyView>()
  return results
}

interface EvalRow {
  variantId: string
  sku: string
  leadTimeDays: number
  reviewDays: number
  demandWindowDays: number
  orderMultiple: number
  minOrderQuantity: number
  safetyStock: number
  physical: number
  blocked: number
  reserved: number
  outflow: number
  incoming: number
  pendingId: string | null
  pendingVersion: number | null
  pendingBasis: string | null
}

/** Single-query (no N+1) evaluation of every policy against live ledger facts. */
async function readEvaluationRows(database: D1Database, now: string, variantIds?: string[]) {
  const filter = variantIds?.length ? `WHERE p.variant_id IN (${variantIds.map((_, i) => `?${i + 2}`).join(',')})` : ''
  const { results } = await database
    .prepare(
      `SELECT p.variant_id variantId, v.sku, p.lead_time_days leadTimeDays, p.review_days reviewDays,
        p.demand_window_days demandWindowDays, p.order_multiple orderMultiple, p.min_order_quantity minOrderQuantity,
        v.safety_stock safetyStock,
        COALESCE((SELECT SUM(physical_quantity) FROM inventory_balances b WHERE b.variant_id=p.variant_id),0) physical,
        COALESCE((SELECT SUM(blocked_quantity) FROM inventory_balances b WHERE b.variant_id=p.variant_id),0) blocked,
        COALESCE((SELECT SUM(l.quantity) FROM inventory_reservation_lines l
                  JOIN inventory_reservations r ON r.id=l.reservation_id
                  WHERE l.variant_id=p.variant_id AND r.status='reserved'),0) reserved,
        COALESCE((SELECT -SUM(m.physical_delta) FROM inventory_movements m
                  WHERE m.variant_id=p.variant_id AND m.movement_type IN ('ship','allocate')
                    AND m.created_at >= strftime('%Y-%m-%dT%H:%M:%SZ', ?1, '-' || p.demand_window_days || ' days')),0) outflow,
        COALESCE((SELECT SUM(s.approved_quantity) FROM inventory_purchase_suggestions s
                  WHERE s.variant_id=p.variant_id AND s.status='approved'
                    AND s.updated_at >= strftime('%Y-%m-%dT%H:%M:%SZ', ?1, '-' || p.lead_time_days || ' days')),0) incoming,
        s.id pendingId, s.version pendingVersion, s.basis_hash pendingBasis
       FROM inventory_reorder_policies p
       JOIN variants v ON v.id=p.variant_id
       LEFT JOIN inventory_purchase_suggestions s ON s.variant_id=p.variant_id AND s.status='pending'
       ${filter} ORDER BY v.sku LIMIT 200`
    )
    .bind(now, ...(variantIds ?? []))
    .all<EvalRow>()
  return results
}

export async function evaluateReorderSuggestions(
  database: D1Database,
  claims: VerifiedSessionClaims,
  input: unknown,
  commandId: string,
  options?: PlanningOptions
) {
  await authorizePlanning(database, claims, 'inventory.write', options)
  const data = parse(reorderEvaluateInputSchema, input)
  const now = planningNow(options)
  const variantIds = data.variantIds ? [...new Set(data.variantIds)].sort() : undefined
  const payloadHash = await sha256Hex(canonicalJson({ action: 'evaluate', variantIds: variantIds ?? null }))
  return runIdempotent(database, { commandId, scope: 'reorder', payloadHash }, async () => {
    const rows = await readEvaluationRows(database, now, variantIds)
    const statements: D1PreparedStatement[] = []
    const response = { evaluated: rows.length, created: [] as string[], superseded: [] as string[], unchanged: 0 }
    for (const row of rows) {
      const demandMilli = Math.round((row.outflow * 1000) / row.demandWindowDays)
      const position = row.physical - row.blocked - row.reserved + row.incoming
      const result = computeReorder({ ...row, position, demandMilliPerDay: demandMilli })
      const basisHash = await sha256Hex(
        canonicalJson({
          v: row.variantId,
          position,
          safety: row.safetyStock,
          lead: row.leadTimeDays,
          demandMilli,
          rop: result.reorderPoint,
          qty: result.suggestedQuantity
        })
      )
      if (result.needed && row.pendingBasis === basisHash) {
        response.unchanged++
        continue
      }
      if (!result.needed && !row.pendingId) {
        response.unchanged++
        continue
      }
      if (row.pendingId) {
        statements.push(
          database
            .prepare(
              `UPDATE inventory_purchase_suggestions SET status='superseded', version=version+1, updated_at=?3
               WHERE id=?1 AND version=?2 AND status='pending'`
            )
            .bind(row.pendingId, row.pendingVersion, now)
        )
        response.superseded.push(row.pendingId)
      }
      if (result.needed) {
        const id = crypto.randomUUID()
        statements.push(
          database
            .prepare(
              `INSERT INTO inventory_purchase_suggestions(id,variant_id,status,position_quantity,safety_stock,lead_time_days,
                 daily_demand_milli,reorder_point,suggested_quantity,basis_hash,generated_by,version,created_at,updated_at)
               VALUES(?1,?2,'pending',?3,?4,?5,?6,?7,?8,?9,?10,1,?11,?11)`
            )
            .bind(
              id,
              row.variantId,
              position,
              row.safetyStock,
              row.leadTimeDays,
              demandMilli,
              result.reorderPoint,
              result.suggestedQuantity,
              basisHash,
              claims.identityId,
              now
            )
        )
        response.created.push(id)
      }
    }
    await authorizePlanning(database, claims, 'inventory.write', options)
    statements.push(
      recordCommandStatement(database, {
        commandId,
        actorId: claims.identityId,
        scope: 'reorder',
        action: 'evaluate',
        targetId: 'warehouse',
        payloadHash,
        response,
        now
      })
    )
    await database.batch(statements)
    return response
  })
}

export async function readPurchaseSuggestions(
  database: D1Database,
  claims: VerifiedSessionClaims,
  options?: PlanningOptions & { status?: PurchaseSuggestionView['status']; limit?: number }
): Promise<PurchaseSuggestionView[]> {
  await authorizePlanning(database, claims, 'inventory.read', options)
  const limit = Math.min(Math.max(options?.limit ?? 50, 1), 200)
  const { results } = await database
    .prepare(
      `SELECT s.id, s.variant_id variantId, v.sku, s.status, s.position_quantity positionQuantity,
              s.safety_stock safetyStock, s.lead_time_days leadTimeDays, s.daily_demand_milli / 1000.0 dailyDemand,
              s.reorder_point reorderPoint, s.suggested_quantity suggestedQuantity, s.approved_quantity approvedQuantity,
              s.decision_note decisionNote, s.version, s.created_at createdAt
       FROM inventory_purchase_suggestions s JOIN variants v ON v.id=s.variant_id
       WHERE (?1 IS NULL OR s.status=?1) ORDER BY s.created_at DESC, s.id LIMIT ?2`
    )
    .bind(options?.status ?? null, limit)
    .all<PurchaseSuggestionView>()
  return results
}

export async function decidePurchaseSuggestion(
  database: D1Database,
  claims: VerifiedSessionClaims,
  suggestionId: string,
  input: unknown,
  commandId: string,
  options?: PlanningOptions
) {
  await authorizePlanning(database, claims, 'inventory.write', options)
  const data = parse(suggestionDecisionInputSchema, input)
  const now = planningNow(options)
  const payloadHash = await sha256Hex(canonicalJson({ action: 'decide', suggestionId, ...data }))
  return runIdempotent(database, { commandId, scope: 'reorder', payloadHash }, async () => {
    const row = await database
      .prepare('SELECT status, version FROM inventory_purchase_suggestions WHERE id=?1')
      .bind(suggestionId)
      .first<{ status: string; version: number }>()
    if (!row) throw new InventoryPlanningError('not_found')
    if (row.status !== 'pending') throw new InventoryPlanningError('invalid_state')
    if (row.version !== data.expectedVersion) throw new InventoryPlanningError('version_conflict')
    const approved = data.decision === 'approve'
    const status = approved ? 'approved' : 'rejected'
    const response = { id: suggestionId, status, version: data.expectedVersion + 1 }
    await authorizePlanning(database, claims, 'inventory.write', options)
    await database.batch([
      database
        .prepare(
          `UPDATE inventory_purchase_suggestions SET status=?3, approved_quantity=?4, decided_by=?5, decision_note=?6,
           version=version+1, updated_at=?7 WHERE id=?1 AND version=?2 AND status='pending'`
        )
        .bind(
          suggestionId,
          data.expectedVersion,
          status,
          approved ? data.approvedQuantity : null,
          claims.identityId,
          data.note,
          now
        ),
      recordCommandStatement(database, {
        commandId,
        actorId: claims.identityId,
        scope: 'reorder',
        action: approved ? 'approve' : 'reject',
        targetId: suggestionId,
        payloadHash,
        response,
        now,
        afterChange: true
      })
    ])
    const stored = await database
      .prepare('SELECT 1 AS ok FROM inventory_planning_commands WHERE command_id=?1')
      .bind(commandId)
      .first()
    if (!stored) throw new InventoryPlanningError('version_conflict')
    return response
  })
}
