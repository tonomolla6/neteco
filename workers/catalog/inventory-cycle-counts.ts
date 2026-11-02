import type { VerifiedSessionClaims } from './authorization'
import {
  InventoryPlanningError,
  authorizePlanning,
  canonicalJson,
  isUuid,
  planningNow,
  recordCommandStatement,
  shiftGuard,
  runIdempotent,
  sha256Hex,
  type PlanningOptions
} from './inventory-planning-core'
import {
  countDecisionInputSchema,
  createCountPlanInputSchema,
  planTransitionInputSchema,
  recountInputSchema,
  submitCountInputSchema
} from '../../shared/inventory-planning'

function parse<T>(schema: { safeParse: (v: unknown) => { success: boolean; data?: T } }, input: unknown): T {
  const parsed = schema.safeParse(input)
  if (!parsed.success) throw new InventoryPlanningError('invalid_input')
  return parsed.data as T
}

interface PlanRow {
  id: string
  name: string
  scheduled_for: string
  blind: number
  status: 'planned' | 'counting' | 'review' | 'closed' | 'cancelled'
  version: number
}
interface LineRow {
  variant_id: string
  location_id: string
  expected_quantity: number | null
  counted_quantity: number | null
  counted_by: string | null
  status: 'pending' | 'counted' | 'recount' | 'approved' | 'rejected'
  version: number
}

const COMMAND_EXISTS = 'SELECT 1 FROM inventory_planning_commands WHERE command_id=?1'
const OPEN_PLAN = "('planned','counting','review')"

async function loadPlan(database: D1Database, planId: string) {
  if (!isUuid(planId)) throw new InventoryPlanningError('not_found')
  const plan = await database
    .prepare('SELECT id,name,scheduled_for,blind,status,version FROM cycle_count_plans WHERE id=?1')
    .bind(planId)
    .first<PlanRow>()
  if (!plan) throw new InventoryPlanningError('not_found')
  return plan
}
async function loadLine(database: D1Database, planId: string, variantId: string) {
  const line = await database
    .prepare(
      `SELECT variant_id,location_id,expected_quantity,counted_quantity,counted_by,status,version
       FROM cycle_count_lines WHERE plan_id=?1 AND variant_id=?2`
    )
    .bind(planId, variantId)
    .first<LineRow>()
  if (!line) throw new InventoryPlanningError('not_found')
  return line
}
const eventStatement = (
  database: D1Database,
  e: {
    planId: string
    variantId: string | null
    kind: string
    counted?: number | null
    actor: string
    note?: string | null
    now: string
  },
  guardSql?: string,
  guardBinds: unknown[] = []
) => {
  const base = `INSERT INTO cycle_count_events(id,plan_id,variant_id,kind,counted_quantity,actor_id,note,created_at)`
  const binds = [crypto.randomUUID(), e.planId, e.variantId, e.kind, e.counted ?? null, e.actor, e.note ?? null, e.now]
  return guardSql
    ? database
        .prepare(`${base} SELECT ?1,?2,?3,?4,?5,?6,?7,?8 WHERE EXISTS(${shiftGuard(guardSql)})`)
        .bind(...binds, ...guardBinds)
    : database.prepare(`${base} VALUES(?1,?2,?3,?4,?5,?6,?7,?8)`).bind(...binds)
}
async function ensureRecorded(database: D1Database, commandId: string) {
  const stored = await database
    .prepare('SELECT 1 AS ok FROM inventory_planning_commands WHERE command_id=?1')
    .bind(commandId)
    .first()
  if (!stored) throw new InventoryPlanningError('version_conflict')
}

export async function createCountPlan(
  database: D1Database,
  claims: VerifiedSessionClaims,
  input: unknown,
  commandId: string,
  options?: PlanningOptions
) {
  await authorizePlanning(database, claims, 'inventory.write', options)
  const data = parse<{ name: string; scheduledFor: string; blind: boolean; variantIds: string[] }>(
    createCountPlanInputSchema,
    input
  )
  if (new Set(data.variantIds).size !== data.variantIds.length) throw new InventoryPlanningError('invalid_input')
  const now = planningNow(options)
  const payloadHash = await sha256Hex(canonicalJson({ action: 'plan', ...data }))
  return runIdempotent(database, { commandId, scope: 'cycle_count', payloadHash }, async () => {
    const marks = data.variantIds.map((_, i) => `?${i + 1}`).join(',')
    const { results: targets } = await database
      .prepare(
        `SELECT b.variant_id variantId, b.location_id locationId FROM inventory_balances b
         JOIN inventory_locations l ON l.id=b.location_id AND l.active=1 AND l.kind='warehouse'
         WHERE b.variant_id IN (${marks})`
      )
      .bind(...data.variantIds)
      .all<{ variantId: string; locationId: string }>()
    if (targets.length !== data.variantIds.length) throw new InventoryPlanningError('invalid_input')
    const { results: busy } = await database
      .prepare(
        `SELECT l.variant_id FROM cycle_count_lines l JOIN cycle_count_plans p ON p.id=l.plan_id
         WHERE p.status IN ${OPEN_PLAN} AND l.variant_id IN (${marks}) LIMIT 1`
      )
      .bind(...data.variantIds)
      .all()
    if (busy.length) throw new InventoryPlanningError('invalid_state')
    const id = crypto.randomUUID()
    const response = { id, status: 'planned', version: 1, lines: targets.length, blind: data.blind }
    await authorizePlanning(database, claims, 'inventory.write', options)
    await database.batch([
      database
        .prepare(
          `INSERT INTO cycle_count_plans(id,name,scheduled_for,blind,status,version,created_by,created_at,updated_at)
           VALUES(?1,?2,?3,?4,'planned',1,?5,?6,?6)`
        )
        .bind(id, data.name, data.scheduledFor, data.blind ? 1 : 0, claims.identityId, now),
      ...targets.map((t) =>
        database
          .prepare(
            `INSERT INTO cycle_count_lines(plan_id,variant_id,location_id,status,version) VALUES(?1,?2,?3,'pending',1)`
          )
          .bind(id, t.variantId, t.locationId)
      ),
      eventStatement(database, { planId: id, variantId: null, kind: 'planned', actor: claims.identityId, now }),
      recordCommandStatement(database, {
        commandId,
        actorId: claims.identityId,
        scope: 'cycle_count',
        action: 'plan',
        targetId: id,
        payloadHash,
        response,
        now
      })
    ])
    return response
  })
}

export async function startCountPlan(
  database: D1Database,
  claims: VerifiedSessionClaims,
  planId: string,
  input: unknown,
  commandId: string,
  options?: PlanningOptions
) {
  await authorizePlanning(database, claims, 'inventory.write', options)
  const data = parse<{ expectedVersion: number }>(planTransitionInputSchema, input)
  const now = planningNow(options)
  const payloadHash = await sha256Hex(canonicalJson({ action: 'start', planId, ...data }))
  return runIdempotent(database, { commandId, scope: 'cycle_count', payloadHash }, async () => {
    const plan = await loadPlan(database, planId)
    if (plan.status !== 'planned') throw new InventoryPlanningError('invalid_state')
    if (plan.version !== data.expectedVersion) throw new InventoryPlanningError('version_conflict')
    const version = plan.version + 1
    const response = { id: planId, status: 'counting', version }
    await authorizePlanning(database, claims, 'inventory.write', options)
    await database.batch([
      database
        .prepare(
          `UPDATE cycle_count_plans SET status='counting', version=version+1, updated_at=?3
           WHERE id=?1 AND version=?2 AND status='planned'`
        )
        .bind(planId, plan.version, now),
      recordCommandStatement(database, {
        commandId,
        actorId: claims.identityId,
        scope: 'cycle_count',
        action: 'start',
        targetId: planId,
        payloadHash,
        response,
        now,
        afterChange: true
      }),
      // Snapshot the book quantity once, when counting starts (variance is measured against it).
      database
        .prepare(
          `UPDATE cycle_count_lines SET version=version+1, expected_quantity=(SELECT b.physical_quantity FROM inventory_balances b
             WHERE b.variant_id=cycle_count_lines.variant_id AND b.location_id=cycle_count_lines.location_id)
           WHERE plan_id=?1 AND EXISTS(SELECT 1 FROM inventory_planning_commands WHERE command_id=?2)`
        )
        .bind(planId, commandId),
      eventStatement(
        database,
        { planId, variantId: null, kind: 'started', actor: claims.identityId, now },
        COMMAND_EXISTS,
        [commandId]
      )
    ])
    await ensureRecorded(database, commandId)
    return response
  })
}

export async function submitCount(
  database: D1Database,
  claims: VerifiedSessionClaims,
  planId: string,
  input: unknown,
  commandId: string,
  options?: PlanningOptions
) {
  await authorizePlanning(database, claims, 'inventory.write', options)
  const data = parse<{ variantId: string; countedQuantity: number; expectedLineVersion: number }>(
    submitCountInputSchema,
    input
  )
  const now = planningNow(options)
  const payloadHash = await sha256Hex(canonicalJson({ action: 'count', planId, ...data }))
  return runIdempotent(database, { commandId, scope: 'cycle_count', payloadHash }, async () => {
    const plan = await loadPlan(database, planId)
    if (plan.status !== 'counting') throw new InventoryPlanningError('invalid_state')
    const line = await loadLine(database, planId, data.variantId)
    if (line.status !== 'pending' && line.status !== 'recount') throw new InventoryPlanningError('invalid_state')
    if (line.version !== data.expectedLineVersion) throw new InventoryPlanningError('version_conflict')
    const lineVersion = line.version + 1
    const remaining = (await database
      .prepare(
        `SELECT COUNT(*) n FROM cycle_count_lines WHERE plan_id=?1 AND variant_id<>?2 AND status IN ('pending','recount')`
      )
      .bind(planId, data.variantId)
      .first<{ n: number }>())!.n
    // Blind plans never echo book quantity or variance back to the counter.
    const response: Record<string, unknown> = {
      planId,
      variantId: data.variantId,
      status: 'counted',
      lineVersion,
      planStatus: remaining === 0 ? 'review' : 'counting'
    }
    if (!plan.blind) {
      response.expectedQuantity = line.expected_quantity
      response.discrepancy = data.countedQuantity - (line.expected_quantity ?? 0)
    }
    await authorizePlanning(database, claims, 'inventory.write', options)
    await database.batch([
      database
        .prepare(
          `UPDATE cycle_count_lines SET counted_quantity=?3, counted_by=?4, status='counted', version=version+1
           WHERE plan_id=?1 AND variant_id=?2 AND version=?5 AND status IN ('pending','recount')
             AND EXISTS(SELECT 1 FROM cycle_count_plans WHERE id=?1 AND status='counting')`
        )
        .bind(planId, data.variantId, data.countedQuantity, claims.identityId, line.version),
      recordCommandStatement(database, {
        commandId,
        actorId: claims.identityId,
        scope: 'cycle_count',
        action: 'count',
        targetId: planId,
        payloadHash,
        response,
        now,
        afterChange: true
      }),
      eventStatement(
        database,
        {
          planId,
          variantId: data.variantId,
          kind: 'counted',
          counted: data.countedQuantity,
          actor: claims.identityId,
          now
        },
        COMMAND_EXISTS,
        [commandId]
      ),
      database
        .prepare(
          `UPDATE cycle_count_plans SET status='review', version=version+1, updated_at=?2
           WHERE id=?1 AND status='counting' AND EXISTS(SELECT 1 FROM inventory_planning_commands WHERE command_id=?3)
             AND NOT EXISTS(SELECT 1 FROM cycle_count_lines WHERE plan_id=?1 AND status IN ('pending','recount'))`
        )
        .bind(planId, now, commandId)
    ])
    await ensureRecorded(database, commandId)
    return response
  })
}

export async function requestRecount(
  database: D1Database,
  claims: VerifiedSessionClaims,
  planId: string,
  input: unknown,
  commandId: string,
  options?: PlanningOptions
) {
  await authorizePlanning(database, claims, 'inventory.write', options)
  const data = parse<{ variantId: string; expectedLineVersion: number; note: string }>(recountInputSchema, input)
  const now = planningNow(options)
  const payloadHash = await sha256Hex(canonicalJson({ action: 'recount', planId, ...data }))
  return runIdempotent(database, { commandId, scope: 'cycle_count', payloadHash }, async () => {
    const plan = await loadPlan(database, planId)
    if (plan.status !== 'review') throw new InventoryPlanningError('invalid_state')
    const line = await loadLine(database, planId, data.variantId)
    if (line.status !== 'counted') throw new InventoryPlanningError('invalid_state')
    if (line.version !== data.expectedLineVersion) throw new InventoryPlanningError('version_conflict')
    const lineVersion = line.version + 1
    const response = { planId, variantId: data.variantId, status: 'recount', lineVersion, planStatus: 'counting' }
    await authorizePlanning(database, claims, 'inventory.write', options)
    await database.batch([
      database
        .prepare(
          `UPDATE cycle_count_lines SET counted_quantity=NULL, counted_by=NULL, status='recount', version=version+1
           WHERE plan_id=?1 AND variant_id=?2 AND version=?3 AND status='counted'
             AND EXISTS(SELECT 1 FROM cycle_count_plans WHERE id=?1 AND status='review')`
        )
        .bind(planId, data.variantId, line.version),
      recordCommandStatement(database, {
        commandId,
        actorId: claims.identityId,
        scope: 'cycle_count',
        action: 'recount',
        targetId: planId,
        payloadHash,
        response,
        now,
        afterChange: true
      }),
      eventStatement(
        database,
        {
          planId,
          variantId: data.variantId,
          kind: 'recount_requested',
          counted: line.counted_quantity,
          actor: claims.identityId,
          note: data.note,
          now
        },
        COMMAND_EXISTS,
        [commandId]
      ),
      database
        .prepare(
          `UPDATE cycle_count_plans SET status='counting', version=version+1, updated_at=?2
           WHERE id=?1 AND status='review' AND EXISTS(SELECT 1 FROM inventory_planning_commands WHERE command_id=?3)`
        )
        .bind(planId, now, commandId)
    ])
    await ensureRecorded(database, commandId)
    return response
  })
}

export async function decideCountLine(
  database: D1Database,
  claims: VerifiedSessionClaims,
  planId: string,
  input: unknown,
  commandId: string,
  options?: PlanningOptions
) {
  await authorizePlanning(database, claims, 'inventory.write', options)
  const data = parse<{
    variantId: string
    expectedLineVersion: number
    decision: 'approve' | 'reject'
    rootCause?: string
    note: string
  }>(countDecisionInputSchema, input)
  const now = planningNow(options)
  const payloadHash = await sha256Hex(canonicalJson({ action: 'decide', planId, ...data }))
  return runIdempotent(database, { commandId, scope: 'cycle_count', payloadHash }, async () => {
    const plan = await loadPlan(database, planId)
    if (plan.status !== 'review') throw new InventoryPlanningError('invalid_state')
    const line = await loadLine(database, planId, data.variantId)
    if (line.status !== 'counted') throw new InventoryPlanningError('invalid_state')
    if (line.version !== data.expectedLineVersion) throw new InventoryPlanningError('version_conflict')
    // Four-eyes: whoever counted a line cannot approve or reject it.
    if (line.counted_by === claims.identityId) throw new InventoryPlanningError('approval_self')

    const delta = line.counted_quantity! - (line.expected_quantity ?? 0)
    if (delta !== 0 && !data.rootCause) throw new InventoryPlanningError('root_cause_required')
    const lineVersion = line.version + 1
    const approve = data.decision === 'approve'
    const status = approve ? 'approved' : 'rejected'
    const applied = approve && delta !== 0
    const movementId = applied ? crypto.randomUUID() : null
    const response = {
      planId,
      variantId: data.variantId,
      status,
      lineVersion,
      discrepancy: delta,
      rootCause: data.rootCause ?? null,
      adjusted: applied,
      movementId
    }
    const statements: D1PreparedStatement[] = []
    if (applied) {
      const live = await database
        .prepare(
          `SELECT b.physical_quantity physical, b.blocked_quantity blocked, b.version,
             COALESCE((SELECT SUM(rl.quantity) FROM inventory_reservation_lines rl
               JOIN inventory_reservations r ON r.id=rl.reservation_id
               WHERE rl.variant_id=b.variant_id AND rl.location_id=b.location_id AND r.status='reserved'),0) reserved
           FROM inventory_balances b WHERE b.variant_id=?1 AND b.location_id=?2`
        )
        .bind(data.variantId, line.location_id)
        .first<{ physical: number; blocked: number; version: number; reserved: number }>()
      if (!live) throw new InventoryPlanningError('not_found')
      if (live.physical + delta < live.blocked + live.reserved) throw new InventoryPlanningError('insufficient_stock')
      // Movement first, guarded by the balance version read above; the balance update then
      // requires that movement. Both run in one transaction, so a concurrent change to the
      // balance makes both no-ops (version_conflict) and never leaves a half-applied adjustment.
      statements.push(
        database
          .prepare(
            `INSERT INTO inventory_movements(id,variant_id,location_id,movement_type,physical_delta,reserved_delta,
               reference_type,reference_id,idempotency_key,correlation_id,reason,created_at)
             SELECT ?1,?2,?3,'adjustment',?4,0,'cycle_count',?5,?6,?7,?8,?9
             WHERE EXISTS(SELECT 1 FROM inventory_balances WHERE variant_id=?2 AND location_id=?3 AND version=?10)
               AND EXISTS(SELECT 1 FROM cycle_count_lines WHERE plan_id=?5 AND variant_id=?2 AND version=?11 AND status='counted')`
          )
          .bind(
            movementId,
            data.variantId,
            line.location_id,
            delta,
            planId,
            `cycle-count:${planId}:${data.variantId}`,
            commandId,
            `Cycle count ${data.rootCause}: ${data.note}`.slice(0, 500),
            now,
            live.version,
            line.version
          ),
        database
          .prepare(
            `UPDATE inventory_balances SET physical_quantity=physical_quantity+?3, version=version+1, updated_at=?4
             WHERE variant_id=?1 AND location_id=?2 AND version=?5 AND EXISTS(SELECT 1 FROM inventory_movements WHERE id=?6)`
          )
          .bind(data.variantId, line.location_id, delta, now, live.version, movementId)
      )
    }
    statements.push(
      database
        .prepare(
          `UPDATE cycle_count_lines SET status=?3, root_cause=?4, decision_note=?5, decided_by=?6, movement_id=?7,
             version=version+1 WHERE plan_id=?1 AND variant_id=?2 AND version=?8 AND status='counted'
             AND (?7 IS NULL OR EXISTS(SELECT 1 FROM inventory_movements WHERE id=?7))`
        )
        .bind(
          planId,
          data.variantId,
          status,
          data.rootCause ?? null,
          data.note,
          claims.identityId,
          movementId,
          line.version
        ),
      recordCommandStatement(database, {
        commandId,
        actorId: claims.identityId,
        scope: 'cycle_count',
        action: approve ? 'approve' : 'reject',
        targetId: planId,
        payloadHash,
        response,
        now,
        afterChange: true
      }),
      eventStatement(
        database,
        {
          planId,
          variantId: data.variantId,
          kind: status,
          counted: line.counted_quantity,
          actor: claims.identityId,
          note: data.rootCause ? `${data.rootCause}: ${data.note}` : data.note,
          now
        },
        COMMAND_EXISTS,
        [commandId]
      ),
      database
        .prepare(
          `UPDATE cycle_count_plans SET status='closed', version=version+1, updated_at=?2
           WHERE id=?1 AND status='review' AND EXISTS(SELECT 1 FROM inventory_planning_commands WHERE command_id=?3)
             AND NOT EXISTS(SELECT 1 FROM cycle_count_lines WHERE plan_id=?1 AND status NOT IN ('approved','rejected'))`
        )
        .bind(planId, now, commandId)
    )
    await authorizePlanning(database, claims, 'inventory.write', options)
    await database.batch(statements)
    await ensureRecorded(database, commandId)
    return response
  })
}

export async function cancelCountPlan(
  database: D1Database,
  claims: VerifiedSessionClaims,
  planId: string,
  input: unknown,
  commandId: string,
  options?: PlanningOptions
) {
  await authorizePlanning(database, claims, 'inventory.write', options)
  const data = parse<{ expectedVersion: number }>(planTransitionInputSchema, input)
  const now = planningNow(options)
  const payloadHash = await sha256Hex(canonicalJson({ action: 'cancel', planId, ...data }))
  return runIdempotent(database, { commandId, scope: 'cycle_count', payloadHash }, async () => {
    const plan = await loadPlan(database, planId)
    if (!['planned', 'counting', 'review'].includes(plan.status)) throw new InventoryPlanningError('invalid_state')
    if (plan.version !== data.expectedVersion) throw new InventoryPlanningError('version_conflict')
    const version = plan.version + 1
    const response = { id: planId, status: 'cancelled', version }
    await authorizePlanning(database, claims, 'inventory.write', options)
    await database.batch([
      database
        .prepare(
          `UPDATE cycle_count_plans SET status='cancelled', version=version+1, updated_at=?3
           WHERE id=?1 AND version=?2 AND status IN ${OPEN_PLAN}`
        )
        .bind(planId, plan.version, now),
      recordCommandStatement(database, {
        commandId,
        actorId: claims.identityId,
        scope: 'cycle_count',
        action: 'cancel',
        targetId: planId,
        payloadHash,
        response,
        now,
        afterChange: true
      })
    ])
    await ensureRecorded(database, commandId)
    return response
  })
}

export async function readCountPlan(
  database: D1Database,
  claims: VerifiedSessionClaims,
  planId: string,
  options?: PlanningOptions
) {
  await authorizePlanning(database, claims, 'inventory.read', options)
  const plan = await loadPlan(database, planId)
  // Blind counting: book quantity and variance stay hidden until the plan reaches review.
  const hidden = plan.blind === 1 && (plan.status === 'planned' || plan.status === 'counting')
  const { results } = await database
    .prepare(
      `SELECT l.variant_id variantId, v.sku, l.status, l.version, l.counted_quantity countedQuantity,
              l.expected_quantity expectedQuantity, l.root_cause rootCause, l.decision_note decisionNote,
              l.movement_id movementId, l.counted_by countedBy
       FROM cycle_count_lines l JOIN variants v ON v.id=l.variant_id WHERE l.plan_id=?1 ORDER BY v.sku`
    )
    .bind(planId)
    .all<{
      variantId: string
      sku: string
      status: string
      version: number
      countedQuantity: number | null
      expectedQuantity: number | null
      rootCause: string | null
      decisionNote: string | null
      movementId: string | null
      countedBy: string | null
    }>()
  const lines = results.map((row) => {
    const { expectedQuantity, countedBy, ...rest } = row
    const visible = !hidden
    return {
      ...rest,
      countedByMe: countedBy === claims.identityId,
      ...(visible
        ? {
            expectedQuantity,
            discrepancy:
              row.countedQuantity === null || expectedQuantity === null ? null : row.countedQuantity - expectedQuantity
          }
        : {}),
      // In blind plans the counter must not see earlier counts of others either while counting.
      ...(hidden && row.status === 'counted'
        ? { countedQuantity: row.countedBy === claims.identityId ? row.countedQuantity : null }
        : {})
    }
  })
  return {
    id: plan.id,
    name: plan.name,
    scheduledFor: plan.scheduled_for,
    blind: plan.blind === 1,
    status: plan.status,
    version: plan.version,
    lines
  }
}

export async function listCountPlans(
  database: D1Database,
  claims: VerifiedSessionClaims,
  options?: PlanningOptions & { status?: string; limit?: number }
) {
  await authorizePlanning(database, claims, 'inventory.read', options)
  const limit = Math.min(Math.max(options?.limit ?? 50, 1), 100)
  const { results } = await database
    .prepare(
      `SELECT p.id, p.name, p.scheduled_for scheduledFor, p.blind, p.status, p.version,
              (SELECT COUNT(*) FROM cycle_count_lines l WHERE l.plan_id=p.id) lines
       FROM cycle_count_plans p WHERE (?1 IS NULL OR p.status=?1) ORDER BY p.scheduled_for DESC, p.id LIMIT ?2`
    )
    .bind(options?.status ?? null, limit)
    .all()
  return results
}
