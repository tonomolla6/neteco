import { z } from 'zod'
import type { VerifiedSessionClaims } from './authorization'
import {
  CatalogLotRecallError,
  lotExpeditionBlockInputSchema,
  variantLotTrackingPolicyInputSchema,
  type LotExpeditionBlockInput,
  type VariantLotTrackingPolicyInput
} from '../../shared/catalog-markets'

const uuidSchema = z.string().uuid()

interface Options {
  now?: () => string
}

function getNow(options?: Options): string {
  if (options?.now) return options.now()
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

const authorityCte = `
  WITH clock AS MATERIALIZED (SELECT COALESCE(?1, strftime('%Y-%m-%dT%H:%M:%SZ', 'now')) as now),
  authority AS MATERIALIZED (
    SELECT i.id as actorId, s.mfa_verified as mfaVerified,
           (i.email_verified_at IS NOT NULL AND i.email_verified_at <= (SELECT now FROM clock)) as emailVerified,
           EXISTS(
             SELECT 1 FROM identity_roles r
             JOIN role_permissions p ON p.role_code = r.role_code
             WHERE r.identity_id = i.id
               AND p.permission_code = 'administration.manage'
               AND r.granted_at <= (SELECT now FROM clock)
               AND (r.expires_at IS NULL OR r.expires_at > (SELECT now FROM clock))
           ) as permitted
    FROM auth_sessions s
    JOIN identities i ON i.id = s.identity_id
    WHERE s.id = ?2
      AND s.identity_id = ?3
      AND s.session_version = ?4
      AND i.session_version = s.session_version
      AND i.status IN ('pending', 'active')
      AND s.revoked_at IS NULL
      AND s.created_at <= (SELECT now FROM clock)
      AND s.expires_at > (SELECT now FROM clock)
  )
`

async function checkAuthority(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  options?: Options
): Promise<{ actorId: string }> {
  if (
    !claims ||
    !uuidSchema.safeParse(claims.identityId).success ||
    !uuidSchema.safeParse(claims.sessionId).success ||
    !Number.isSafeInteger(claims.sessionVersion) ||
    claims.sessionVersion < 1
  ) {
    throw new CatalogLotRecallError('unauthenticated')
  }

  const now = getNow(options)
  const row = await database
    .prepare(`${authorityCte} SELECT * FROM authority`)
    .bind(now, claims.sessionId, claims.identityId, claims.sessionVersion)
    .first<{ actorId: string; emailVerified: number; mfaVerified: number; permitted: number }>()

  if (!row) throw new CatalogLotRecallError('unauthenticated')
  if (!row.emailVerified || !row.mfaVerified || !row.permitted) throw new CatalogLotRecallError('forbidden')
  return row
}

export async function configureVariantLotPolicy(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  commandId: string,
  rawInput: unknown,
  options?: Options
): Promise<{ commandId: string; variantId: string; version: number; createdAt: string }> {
  if (!uuidSchema.safeParse(commandId).success) {
    throw new CatalogLotRecallError('invalid_input')
  }

  const parsed = variantLotTrackingPolicyInputSchema.safeParse(rawInput)
  if (!parsed.success) {
    throw new CatalogLotRecallError('invalid_input')
  }
  const input: VariantLotTrackingPolicyInput = parsed.data

  await checkAuthority(database, claims, options)
  const now = getNow(options)

  const current = await database
    .prepare('SELECT version FROM catalog_lot_tracking_policies WHERE variant_id = ?')
    .bind(input.variantId)
    .first<{ version: number }>()

  const currentVersion = current?.version ?? 0
  if (currentVersion !== input.expectedVersion) {
    throw new CatalogLotRecallError('conflict')
  }

  const newVersion = currentVersion + 1

  await database
    .prepare(
      `INSERT INTO catalog_lot_tracking_policies(
        variant_id, lot_tracking_required, shelf_life_days, min_shelf_life_dispatch_days,
        quarantine_on_expiry, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(variant_id) DO UPDATE SET
        lot_tracking_required = excluded.lot_tracking_required,
        shelf_life_days = excluded.shelf_life_days,
        min_shelf_life_dispatch_days = excluded.min_shelf_life_dispatch_days,
        quarantine_on_expiry = excluded.quarantine_on_expiry,
        version = excluded.version,
        updated_at = excluded.updated_at`
    )
    .bind(
      input.variantId,
      input.lotTrackingRequired ? 1 : 0,
      input.shelfLifeDays,
      input.minShelfLifeDispatchDays,
      input.quarantineOnExpiry ? 1 : 0,
      newVersion,
      now,
      now
    )
    .run()

  return {
    commandId,
    variantId: input.variantId,
    version: newVersion,
    createdAt: now
  }
}

export async function locateLotAffectedStock(
  database: D1Database,
  lotId: string
): Promise<{
  lotId: string
  lotNumber: string
  variantId: string
  locationId: string
  initialQuantity: number
  availableQuantity: number
  status: string
  expiresAt: string
  isExpeditionBlocked: boolean
  blockReason?: string | null
}> {
  const row = await database
    .prepare(
      `SELECT l.id as lotId, l.lot_number as lotNumber, l.variant_id as variantId,
              l.location_id as locationId, l.initial_quantity as initialQuantity,
              l.available_quantity as availableQuantity, l.status, l.expires_at as expiresAt,
              b.is_blocked as isBlocked, b.block_reason as blockReason
       FROM inventory_lots l
       LEFT JOIN lot_expedition_blocks b ON b.lot_id = l.id AND b.is_blocked = 1
       WHERE l.id = ?`
    )
    .bind(lotId)
    .first<{
      lotId: string
      lotNumber: string
      variantId: string
      locationId: string
      initialQuantity: number
      availableQuantity: number
      status: string
      expiresAt: string
      isBlocked: number | null
      blockReason: string | null
    }>()

  if (!row) throw new CatalogLotRecallError('not_found')

  // Also check if there is an active recall for this lot
  const activeRecall = await database
    .prepare('SELECT action FROM product_recall_commands WHERE lot_id = ? ORDER BY version DESC LIMIT 1')
    .bind(lotId)
    .first<{ action: string }>()

  const hasRecall = activeRecall && activeRecall.action !== 'resolve'
  const isBlocked = row.isBlocked === 1 || hasRecall || row.status === 'quarantined' || row.status === 'expired'

  return {
    lotId: row.lotId,
    lotNumber: row.lotNumber,
    variantId: row.variantId,
    locationId: row.locationId,
    initialQuantity: row.initialQuantity,
    availableQuantity: row.availableQuantity,
    status: row.status,
    expiresAt: row.expiresAt,
    isExpeditionBlocked: Boolean(isBlocked),
    blockReason: row.blockReason ?? (hasRecall ? 'lot_recalled' : row.status !== 'active' ? row.status : null)
  }
}

export async function locateLotAffectedCustomers(
  database: D1Database,
  lotId: string
): Promise<{
  lotId: string
  lotNumber: string
  affectedCustomers: Array<{
    orderId: string
    lineIndex: number
    customerId: string | null
    customerEmail?: string | null
    quantity: number
    allocatedAt: string
  }>
}> {
  const lot = await database
    .prepare('SELECT id, lot_number FROM inventory_lots WHERE id = ?')
    .bind(lotId)
    .first<{ id: string; lot_number: string }>()

  if (!lot) throw new CatalogLotRecallError('not_found')

  const rows = await database
    .prepare(
      `SELECT a.order_id as orderId, a.order_line_index as lineIndex,
              a.customer_id as customerId, o.contact_email as customerEmail,
              a.quantity, a.created_at as allocatedAt
       FROM inventory_lot_allocations a
       JOIN orders o ON o.id = a.order_id
       WHERE a.lot_id = ?
       ORDER BY a.created_at ASC`
    )
    .bind(lotId)
    .all<{
      orderId: string
      lineIndex: number
      customerId: string | null
      customerEmail: string | null
      quantity: number
      allocatedAt: string
    }>()

  return {
    lotId,
    lotNumber: lot.lot_number,
    affectedCustomers: rows.results ?? []
  }
}

export async function blockLotExpedition(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  commandId: string,
  rawInput: unknown,
  options?: Options
): Promise<{ lotId: string; isBlocked: boolean; blockReason: string; createdAt: string }> {
  if (!uuidSchema.safeParse(commandId).success) {
    throw new CatalogLotRecallError('invalid_input')
  }

  const parsed = lotExpeditionBlockInputSchema.safeParse(rawInput)
  if (!parsed.success) {
    throw new CatalogLotRecallError('invalid_input')
  }
  const input: LotExpeditionBlockInput = parsed.data

  const actor = await checkAuthority(database, claims, options)
  const now = getNow(options)

  const lot = await database.prepare('SELECT id FROM inventory_lots WHERE id = ?').bind(input.lotId).first()
  if (!lot) throw new CatalogLotRecallError('not_found')

  const existing = await database
    .prepare(
      'SELECT block_reason AS blockReason, evidence, created_at AS createdAt FROM lot_expedition_blocks WHERE lot_id = ? AND is_blocked = 1'
    )
    .bind(input.lotId)
    .first<{ blockReason: string; evidence: string; createdAt: string }>()
  if (existing) {
    // Replays are harmless; a different reason/evidence must not silently rewrite the recorded one.
    if (existing.blockReason !== input.blockReason || existing.evidence !== input.evidence) {
      throw new CatalogLotRecallError('conflict')
    }
    return { lotId: input.lotId, isBlocked: true, blockReason: existing.blockReason, createdAt: existing.createdAt }
  }

  const blockId = crypto.randomUUID()
  await database.batch([
    database
      .prepare(
        `INSERT INTO lot_expedition_blocks(
          id, lot_id, block_reason, evidence, is_blocked, actor_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 1, ?, ?, ?)
        ON CONFLICT(lot_id) DO UPDATE SET
          block_reason = excluded.block_reason,
          evidence = excluded.evidence,
          is_blocked = 1,
          actor_id = excluded.actor_id,
          updated_at = excluded.updated_at`
      )
      .bind(blockId, input.lotId, input.blockReason, input.evidence, actor.actorId, now, now),
    database
      .prepare("UPDATE inventory_lots SET status = 'quarantined', updated_at = ? WHERE id = ? AND status = 'active'")
      .bind(now, input.lotId)
  ])

  return {
    lotId: input.lotId,
    isBlocked: true,
    blockReason: input.blockReason,
    createdAt: now
  }
}

export async function unblockLotExpedition(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  commandId: string,
  rawInput: { lotId: string; evidence: string },
  options?: Options
): Promise<{ lotId: string; isBlocked: boolean; updatedAt: string }> {
  if (!uuidSchema.safeParse(commandId).success || !uuidSchema.safeParse(rawInput.lotId).success) {
    throw new CatalogLotRecallError('invalid_input')
  }

  const actor = await checkAuthority(database, claims, options)
  const now = getNow(options)

  // Only a lot held by an active expedition block can be released here: quarantines placed by
  // other processes must stay untouched.
  const active = await database
    .prepare('SELECT 1 AS found FROM lot_expedition_blocks WHERE lot_id = ? AND is_blocked = 1')
    .bind(rawInput.lotId)
    .first()
  if (!active) throw new CatalogLotRecallError('not_found')

  await database.batch([
    database
      .prepare(
        `UPDATE lot_expedition_blocks
         SET is_blocked = 0, evidence = ?, actor_id = ?, updated_at = ?
         WHERE lot_id = ?`
      )
      .bind(rawInput.evidence, actor.actorId, now, rawInput.lotId),
    database
      .prepare("UPDATE inventory_lots SET status = 'active', updated_at = ? WHERE id = ? AND status = 'quarantined'")
      .bind(now, rawInput.lotId)
  ])

  return {
    lotId: rawInput.lotId,
    isBlocked: false,
    updatedAt: now
  }
}

export async function evaluateOrderExpeditionEligibility(
  database: D1Database,
  orderId: string,
  options?: Options
): Promise<{
  orderId: string
  eligible: boolean
  blockedLines: Array<{
    lineIndex: number
    variantId: string
    lotId: string
    lotNumber: string
    reason: string
    details?: string
  }>
}> {
  const nowStr = getNow(options)
  const nowMs = new Date(nowStr).getTime()

  // Retrieve allocated lots for this order
  const allocations = await database
    .prepare(
      `SELECT a.order_line_index as lineIndex, a.lot_id as lotId,
              l.variant_id as variantId, l.lot_number as lotNumber,
              l.status as lotStatus, l.expires_at as expiresAt,
              b.is_blocked as isManuallyBlocked, b.block_reason as manualBlockReason,
              p.min_shelf_life_dispatch_days as minShelfLifeDispatchDays
       FROM inventory_lot_allocations a
       JOIN inventory_lots l ON l.id = a.lot_id
       LEFT JOIN lot_expedition_blocks b ON b.lot_id = a.lot_id AND b.is_blocked = 1
       LEFT JOIN catalog_lot_tracking_policies p ON p.variant_id = l.variant_id
       WHERE a.order_id = ?`
    )
    .bind(orderId)
    .all<{
      lineIndex: number
      lotId: string
      variantId: string
      lotNumber: string
      lotStatus: string
      expiresAt: string
      isManuallyBlocked: number | null
      manualBlockReason: string | null
      minShelfLifeDispatchDays: number | null
    }>()

  const blockedLines: Array<{
    lineIndex: number
    variantId: string
    lotId: string
    lotNumber: string
    reason: string
    details?: string
  }> = []

  for (const row of allocations.results ?? []) {
    // 1. Check manual expedition block
    if (row.isManuallyBlocked === 1) {
      blockedLines.push({
        lineIndex: row.lineIndex,
        variantId: row.variantId,
        lotId: row.lotId,
        lotNumber: row.lotNumber,
        reason: row.manualBlockReason ?? 'expedition_blocked',
        details: 'Manual expedition block registered'
      })
      continue
    }

    // 2. Check active recall
    const recall = await database
      .prepare('SELECT action FROM product_recall_commands WHERE lot_id = ? ORDER BY version DESC LIMIT 1')
      .bind(row.lotId)
      .first<{ action: string }>()

    if (recall && (recall.action === 'open' || recall.action === 'communicate')) {
      blockedLines.push({
        lineIndex: row.lineIndex,
        variantId: row.variantId,
        lotId: row.lotId,
        lotNumber: row.lotNumber,
        reason: 'lot_recalled',
        details: 'Active recall open on this lot'
      })
      continue
    }

    // 3. Check expiration & minimum dispatch shelf life
    const expiresMs = new Date(row.expiresAt).getTime()
    const daysRemaining = (expiresMs - nowMs) / (1000 * 86400)
    const minRequiredDays = row.minShelfLifeDispatchDays ?? 0

    if (daysRemaining <= 0 || row.lotStatus === 'expired') {
      blockedLines.push({
        lineIndex: row.lineIndex,
        variantId: row.variantId,
        lotId: row.lotId,
        lotNumber: row.lotNumber,
        reason: 'lot_expired',
        details: `Lot expired at ${row.expiresAt}`
      })
      continue
    }

    if (daysRemaining < minRequiredDays) {
      blockedLines.push({
        lineIndex: row.lineIndex,
        variantId: row.variantId,
        lotId: row.lotId,
        lotNumber: row.lotNumber,
        reason: 'lot_expired',
        details: `Lot shelf life (${Math.floor(daysRemaining)} days) is less than minimum dispatch requirement (${minRequiredDays} days)`
      })
      continue
    }

    // 4. Check quarantined status
    if (row.lotStatus === 'quarantined') {
      blockedLines.push({
        lineIndex: row.lineIndex,
        variantId: row.variantId,
        lotId: row.lotId,
        lotNumber: row.lotNumber,
        reason: 'lot_quarantined',
        details: 'Lot is currently in quarantine'
      })
    }
  }

  return {
    orderId,
    eligible: blockedLines.length === 0,
    blockedLines
  }
}
