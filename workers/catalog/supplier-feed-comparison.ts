import { authorizeD1Session, type VerifiedSessionClaims } from './authorization'
import {
  type StageSupplierFeedInput,
  type ReviewFeedItemInput,
  type ApplyApprovedFeedItemsInput,
  type SupplierFeedReviewItem,
  type ExistingSupplierItem,
  stageSupplierFeedInputSchema,
  reviewFeedItemInputSchema,
  applyApprovedFeedItemsInputSchema,
  computeSupplierFeedDiff,
  assertCanPublishFeedItem
} from '../../shared/supplier-feed-comparison'

export class SupplierFeedError extends Error {
  constructor(
    readonly code: string,
    message?: string
  ) {
    super(message ? `${code}: ${message}` : code)
    this.name = 'SupplierFeedError'
  }
}

async function sha256Hex(data: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data))
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('')
}

export async function authorizeCatalog(
  database: D1Database,
  claims: VerifiedSessionClaims,
  now?: string
): Promise<void> {
  const resWrite = await authorizeD1Session(database, claims, 'catalog.write', {
    now,
    requireMfa: true
  })
  if (resWrite.allowed) return

  const resManage = await authorizeD1Session(database, claims, 'administration.manage', {
    now,
    requireMfa: true
  })
  if (resManage.allowed) return

  if (resWrite.code === 'unauthenticated' || resManage.code === 'unauthenticated') {
    throw new SupplierFeedError('unauthenticated', 'Session unauthenticated or expired')
  }
  throw new SupplierFeedError('forbidden', 'Requires catalog.write permission')
}

export type SupplierFeedOptions = {
  now?: string
}

export async function stageAndCompareSupplierFeed(
  database: D1Database,
  claims: VerifiedSessionClaims,
  rawInput: StageSupplierFeedInput,
  options?: SupplierFeedOptions
): Promise<{
  importId: string
  itemsCount: number
  altasCount: number
  cambiosCount: number
  bajasCount: number
}> {
  const now = options?.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  await authorizeCatalog(database, claims, now)

  const input = stageSupplierFeedInputSchema.parse(rawInput)
  const importId = crypto.randomUUID()
  const payloadHash = await sha256Hex(JSON.stringify(input))

  // Retrieve existing known items for this supplier from previous review items or supplier offerings
  const existingRows = await database
    .prepare(
      `SELECT supplier_sku, product_id, variant_id, after_payload_json
       FROM supplier_feed_review_items
       WHERE supplier_id = ? AND status IN ('approved', 'applied', 'pending_review')`
    )
    .bind(input.supplierId)
    .all<{
      supplier_sku: string
      product_id: string | null
      variant_id: string | null
      after_payload_json: string | null
    }>()

  const existingItems: ExistingSupplierItem[] = (existingRows.results || []).map((row) => {
    let parsed: Record<string, unknown> = {}
    if (row.after_payload_json) {
      try {
        parsed = JSON.parse(row.after_payload_json)
      } catch {
        // fallback
      }
    }
    return {
      supplierSku: row.supplier_sku,
      productId: row.product_id,
      variantId: row.variant_id,
      name: String(parsed.name || row.supplier_sku),
      priceCents: typeof parsed.priceCents === 'number' ? parsed.priceCents : 0,
      leadTimeDays: typeof parsed.leadTimeDays === 'number' ? parsed.leadTimeDays : undefined,
      stockQuantity: typeof parsed.stockQuantity === 'number' ? parsed.stockQuantity : undefined
    }
  })

  // Compute clean diff
  const diff = computeSupplierFeedDiff(existingItems, input.items)
  const altasCount = diff.altas.length
  const cambiosCount = diff.cambios.length
  const bajasCount = diff.bajas.length
  const totalItemsCount = input.items.length

  // Insert import record
  await database
    .prepare(
      `INSERT INTO supplier_feed_imports (
         id, supplier_id, feed_name, feed_hash, status,
         items_count, altas_count, cambios_count, bajas_count,
         version, created_by, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'analyzed', ?, ?, ?, ?, 1, ?, ?, ?)`
    )
    .bind(
      importId,
      input.supplierId,
      input.feedName,
      payloadHash,
      totalItemsCount,
      altasCount,
      cambiosCount,
      bajasCount,
      claims.identityId,
      now,
      now
    )
    .run()

  // Insert all altas in pending_review
  for (const alta of diff.altas) {
    const itemId = crypto.randomUUID()
    await database
      .prepare(
        `INSERT INTO supplier_feed_review_items (
           id, import_id, supplier_id, supplier_sku, diff_type,
           status, is_published, before_payload_json, after_payload_json,
           diff_details_json, version, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'alta', 'pending_review', 0, NULL, ?, ?, 1, ?, ?)`
      )
      .bind(
        itemId,
        importId,
        input.supplierId,
        alta.supplierSku,
        JSON.stringify(alta.afterPayload),
        JSON.stringify(alta.diffDetails),
        now,
        now
      )
      .run()
  }

  // Insert all cambios in pending_review
  for (const cambio of diff.cambios) {
    const itemId = crypto.randomUUID()
    await database
      .prepare(
        `INSERT INTO supplier_feed_review_items (
           id, import_id, supplier_id, supplier_sku, diff_type,
           product_id, variant_id, status, is_published,
           before_payload_json, after_payload_json, diff_details_json,
           version, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'cambio', ?, ?, 'pending_review', 0, ?, ?, ?, 1, ?, ?)`
      )
      .bind(
        itemId,
        importId,
        input.supplierId,
        cambio.supplierSku,
        cambio.productId ?? null,
        cambio.variantId ?? null,
        JSON.stringify(cambio.beforePayload),
        JSON.stringify(cambio.afterPayload),
        JSON.stringify(cambio.diffDetails),
        now,
        now
      )
      .run()
  }

  // Insert all bajas in pending_review
  for (const baja of diff.bajas) {
    const itemId = crypto.randomUUID()
    await database
      .prepare(
        `INSERT INTO supplier_feed_review_items (
           id, import_id, supplier_id, supplier_sku, diff_type,
           product_id, variant_id, status, is_published,
           before_payload_json, after_payload_json, diff_details_json,
           version, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'baja', ?, ?, 'pending_review', 0, ?, NULL, ?, 1, ?, ?)`
      )
      .bind(
        itemId,
        importId,
        input.supplierId,
        baja.supplierSku,
        baja.productId ?? null,
        baja.variantId ?? null,
        JSON.stringify(baja.beforePayload),
        JSON.stringify(baja.diffDetails),
        now,
        now
      )
      .run()
  }

  // Log command and audit
  const commandId = crypto.randomUUID()
  await database
    .prepare(
      `INSERT INTO supplier_feed_commands (
         command_id, import_id, actor_id, action,
         expected_version, result_version, payload_hash, input_json, created_at
       ) VALUES (?, ?, ?, 'stage_feed', 0, 1, ?, ?, ?)`
    )
    .bind(commandId, importId, claims.identityId, payloadHash, JSON.stringify(input), now)
    .run()

  await database
    .prepare(
      `INSERT INTO supplier_feed_audit (
         command_id, actor_id, import_id, action, payload_hash, input_json, created_at
       ) VALUES (?, ?, ?, 'stage_feed', ?, ?, ?)`
    )
    .bind(commandId, claims.identityId, importId, payloadHash, JSON.stringify(input), now)
    .run()

  return {
    importId,
    itemsCount: totalItemsCount,
    altasCount,
    cambiosCount,
    bajasCount
  }
}

export async function reviewSupplierFeedItem(
  database: D1Database,
  claims: VerifiedSessionClaims,
  rawInput: ReviewFeedItemInput,
  options?: SupplierFeedOptions
): Promise<{ itemId: string; newStatus: string; version: number }> {
  const now = options?.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  await authorizeCatalog(database, claims, now)

  const input = reviewFeedItemInputSchema.parse(rawInput)

  const item = await database
    .prepare(`SELECT id, version, status FROM supplier_feed_review_items WHERE id = ?`)
    .bind(input.itemId)
    .first<{ id: string; version: number; status: string }>()

  if (!item) {
    throw new SupplierFeedError('not_found', 'Review item not found')
  }

  if (item.version !== input.expectedVersion) {
    throw new SupplierFeedError('version_conflict', `Expected version ${input.expectedVersion}, found ${item.version}`)
  }

  const newVersion = item.version + 1
  await database
    .prepare(
      `UPDATE supplier_feed_review_items
       SET status = ?, review_decision_by = ?, review_decision_at = ?, review_notes = ?,
           version = ?, updated_at = ?
       WHERE id = ? AND version = ?`
    )
    .bind(
      input.decision,
      claims.identityId,
      now,
      input.reviewNotes ?? null,
      newVersion,
      now,
      input.itemId,
      item.version
    )
    .run()

  return {
    itemId: input.itemId,
    newStatus: input.decision,
    version: newVersion
  }
}

export async function applyApprovedFeedItems(
  database: D1Database,
  claims: VerifiedSessionClaims,
  rawInput: ApplyApprovedFeedItemsInput,
  options?: SupplierFeedOptions
): Promise<{ appliedCount: number }> {
  const now = options?.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  await authorizeCatalog(database, claims, now)

  const input = applyApprovedFeedItemsInputSchema.parse(rawInput)

  // Verify that EVERY item requested is approved:
  // "nunca se publican silenciosamente"
  for (const itemId of input.itemIds) {
    const item = await database
      .prepare(`SELECT id, status, is_published FROM supplier_feed_review_items WHERE id = ? AND import_id = ?`)
      .bind(itemId, input.importId)
      .first<{ id: string; status: string; is_published: number }>()

    if (!item) {
      throw new SupplierFeedError('not_found', `Item ${itemId} not found`)
    }

    try {
      assertCanPublishFeedItem({ status: item.status, isPublished: item.is_published })
    } catch {
      throw new SupplierFeedError(
        'unreviewed_feed_cannot_publish',
        `Item ${itemId} has status '${item.status}'. Only 'approved' items may be applied/published.`
      )
    }
  }

  // Mark items as applied and published
  for (const itemId of input.itemIds) {
    await database
      .prepare(
        `UPDATE supplier_feed_review_items
         SET status = 'applied', is_published = 1, updated_at = ?
         WHERE id = ?`
      )
      .bind(now, itemId)
      .run()
  }

  return { appliedCount: input.itemIds.length }
}

export async function getSupplierFeedImport(
  database: D1Database,
  importId: string
): Promise<{
  id: string
  supplierId: string
  feedName: string
  status: string
  itemsCount: number
  altasCount: number
  cambiosCount: number
  bajasCount: number
  version: number
  createdAt: string
}> {
  const row = await database
    .prepare(
      `SELECT id, supplier_id, feed_name, status, items_count, altas_count,
              cambios_count, bajas_count, version, created_at
       FROM supplier_feed_imports
       WHERE id = ?`
    )
    .bind(importId)
    .first<{
      id: string
      supplier_id: string
      feed_name: string
      status: string
      items_count: number
      altas_count: number
      cambios_count: number
      bajas_count: number
      version: number
      created_at: string
    }>()

  if (!row) {
    throw new SupplierFeedError('not_found', 'Feed import not found')
  }

  return {
    id: row.id,
    supplierId: row.supplier_id,
    feedName: row.feed_name,
    status: row.status,
    itemsCount: row.items_count,
    altasCount: row.altas_count,
    cambiosCount: row.cambios_count,
    bajasCount: row.bajas_count,
    version: row.version,
    createdAt: row.created_at
  }
}

export async function listSupplierFeedReviewItems(
  database: D1Database,
  importId: string,
  filterStatus?: string
): Promise<SupplierFeedReviewItem[]> {
  let query = `
    SELECT id, import_id, supplier_id, supplier_sku, diff_type,
           product_id, variant_id, status, is_published,
           before_payload_json, after_payload_json, diff_details_json,
           review_decision_by, review_decision_at, review_notes,
           version, created_at, updated_at
    FROM supplier_feed_review_items
    WHERE import_id = ?
  `
  const bindings: unknown[] = [importId]

  if (filterStatus) {
    query += ` AND status = ?`
    bindings.push(filterStatus)
  }

  query += ` ORDER BY created_at ASC`

  const rows = await database
    .prepare(query)
    .bind(...bindings)
    .all<{
      id: string
      import_id: string
      supplier_id: string
      supplier_sku: string
      diff_type: string
      product_id: string | null
      variant_id: string | null
      status: string
      is_published: number
      before_payload_json: string | null
      after_payload_json: string | null
      diff_details_json: string
      review_decision_by: string | null
      review_decision_at: string | null
      review_notes: string | null
      version: number
      created_at: string
      updated_at: string
    }>()

  return (rows.results || []).map((r) => ({
    id: r.id,
    importId: r.import_id,
    supplierId: r.supplier_id,
    supplierSku: r.supplier_sku,
    diffType: r.diff_type as SupplierFeedReviewItem['diffType'],
    productId: r.product_id,
    variantId: r.variant_id,
    status: r.status as SupplierFeedReviewItem['status'],
    isPublished: r.is_published,
    beforePayload: r.before_payload_json ? JSON.parse(r.before_payload_json) : null,
    afterPayload: r.after_payload_json ? JSON.parse(r.after_payload_json) : null,
    diffDetails: JSON.parse(r.diff_details_json),
    reviewDecisionBy: r.review_decision_by,
    reviewDecisionAt: r.review_decision_at,
    reviewNotes: r.review_notes,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }))
}
