import { authorizeD1Session, type VerifiedSessionClaims } from '../catalog/authorization'
import {
  type BundleComponentView,
  type BundleDetailView,
  type BundleItemInput,
  type BundlePricingResult,
  type BundleSector,
  type BundleTask,
  bundleCreateSchema,
  bundleIntentHash,
  bundleSelectionSchema,
  bundleUpdateSchema,
  calculateBundleAvailability,
  calculateBundlePricing
} from '../../shared/bundles'

export class BundleError extends Error {
  constructor(
    readonly code:
      | 'invalid_input'
      | 'unauthenticated'
      | 'forbidden'
      | 'not_found'
      | 'conflict'
      | 'version_conflict'
      | 'margin_floor_breached'
  ) {
    super(code)
    this.name = 'BundleError'
  }
}

function fail(code: BundleError['code']): never {
  throw new BundleError(code)
}

function resolveNow(now?: string | (() => string)): string {
  if (typeof now === 'function') return now()
  if (now) return now
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export async function createD1Bundle(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  input: {
    commandId: string
    idempotencyKey: string
    title: string
    slug: string
    description: string
    sector: BundleSector
    task: BundleTask
    bundlePriceCents: number
    items: BundleItemInput[]
    now?: string
  }
): Promise<BundleDetailView> {
  const now = resolveNow(input.now)
  if (!claims?.identityId) fail('unauthenticated')

  const authAdmin = await authorizeD1Session(db, claims, 'administration.manage', { now })
  if (!authAdmin.allowed) {
    const authCatalog = await authorizeD1Session(db, claims, 'catalog.write', { now })
    if (!authCatalog.allowed) fail('forbidden')
  }

  const parsed = bundleCreateSchema.safeParse(input)
  if (!parsed.success) fail('invalid_input')

  // Check idempotency replay
  const existingCommand = await db
    .prepare(`SELECT receipt_json FROM bundle_commands WHERE actor_id = ? AND idempotency_key = ?`)
    .bind(claims.identityId, input.idempotencyKey)
    .first<{ receipt_json: string }>()

  if (existingCommand?.receipt_json) {
    return JSON.parse(existingCommand.receipt_json) as BundleDetailView
  }

  // Check existing slug
  const existingBundle = await db
    .prepare(`SELECT id FROM bundles WHERE slug = ?`)
    .bind(input.slug)
    .first<{ id: string }>()

  if (existingBundle) fail('conflict')

  const bundleId = input.commandId // or crypto.randomUUID()
  const payloadHash = await bundleIntentHash({
    action: 'create_bundle',
    title: input.title,
    slug: input.slug,
    bundlePriceCents: input.bundlePriceCents,
    items: input.items
  })

  const statements: D1PreparedStatement[] = []

  // Insert bundle
  statements.push(
    db
      .prepare(
        `INSERT INTO bundles (
          id, slug, title, description, sector, task, bundle_price_cents,
          status, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?)`
      )
      .bind(
        bundleId,
        input.slug,
        input.title,
        input.description,
        input.sector,
        input.task,
        input.bundlePriceCents,
        now,
        now
      )
  )

  // Insert items
  let sortOrder = 0
  for (const item of input.items) {
    statements.push(
      db
        .prepare(
          `INSERT INTO bundle_items (
            id, bundle_id, variant_id, quantity, min_quantity, max_quantity, sort_order
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          crypto.randomUUID(),
          bundleId,
          item.variantId,
          item.quantity,
          item.minQuantity ?? 1,
          item.maxQuantity ?? 50,
          sortOrder++
        )
    )
  }

  // Build receipt view for command journal
  const receiptView: BundleDetailView = {
    id: bundleId,
    slug: input.slug,
    title: input.title,
    description: input.description,
    sector: input.sector,
    task: input.task,
    bundlePriceCents: input.bundlePriceCents,
    status: 'active',
    version: 1,
    equivalentStandaloneCents: input.bundlePriceCents,
    savingsCents: 0,
    savingsPercent: 0,
    maxAvailableKits: 0,
    inStock: true,
    items: [],
    createdAt: now,
    updatedAt: now
  }

  statements.push(
    db
      .prepare(
        `INSERT INTO bundle_commands (
          command_id, actor_id, action, idempotency_key, expected_version,
          applied_version, payload_hash, input_json, receipt_json, created_at
        ) VALUES (?, ?, 'create_bundle', ?, 0, 1, ?, ?, ?, ?)`
      )
      .bind(
        input.commandId,
        claims.identityId,
        input.idempotencyKey,
        payloadHash,
        JSON.stringify(input),
        JSON.stringify(receiptView),
        now
      )
  )

  await db.batch(statements)

  const created = await getD1BundleBySlug(db, input.slug, now)
  if (!created) fail('not_found')
  return created
}

export async function updateD1Bundle(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  input: {
    commandId: string
    idempotencyKey: string
    bundleId: string
    expectedVersion: number
    title?: string
    description?: string
    sector?: BundleSector
    task?: BundleTask
    bundlePriceCents?: number
    status?: 'draft' | 'active' | 'archived'
    now?: string
  }
): Promise<BundleDetailView> {
  const now = resolveNow(input.now)
  if (!claims?.identityId) fail('unauthenticated')

  const authAdmin = await authorizeD1Session(db, claims, 'administration.manage', { now })
  if (!authAdmin.allowed) {
    const authCatalog = await authorizeD1Session(db, claims, 'catalog.write', { now })
    if (!authCatalog.allowed) fail('forbidden')
  }

  const parsed = bundleUpdateSchema.safeParse(input)
  if (!parsed.success) fail('invalid_input')

  // Check command idempotency
  const existingCommand = await db
    .prepare(`SELECT receipt_json FROM bundle_commands WHERE actor_id = ? AND idempotency_key = ?`)
    .bind(claims.identityId, input.idempotencyKey)
    .first<{ receipt_json: string }>()

  if (existingCommand?.receipt_json) {
    return JSON.parse(existingCommand.receipt_json) as BundleDetailView
  }

  const current = await db.prepare(`SELECT * FROM bundles WHERE id = ?`).bind(input.bundleId).first<{
    id: string
    slug: string
    title: string
    description: string
    sector: BundleSector
    task: BundleTask
    bundle_price_cents: number
    status: 'draft' | 'active' | 'archived'
    version: number
    created_at: string
    updated_at: string
  }>()

  if (!current) fail('not_found')
  if (current.version !== input.expectedVersion) fail('version_conflict')

  const nextVersion = current.version + 1
  const title = input.title ?? current.title
  const description = input.description ?? current.description
  const sector = input.sector ?? current.sector
  const task = input.task ?? current.task
  const bundlePriceCents = input.bundlePriceCents ?? current.bundle_price_cents
  const status = input.status ?? current.status

  const payloadHash = await bundleIntentHash({
    action: 'update_bundle',
    bundleId: input.bundleId,
    expectedVersion: input.expectedVersion,
    input
  })

  const statements: D1PreparedStatement[] = []

  statements.push(
    db
      .prepare(
        `UPDATE bundles SET
          title = ?, description = ?, sector = ?, task = ?,
          bundle_price_cents = ?, status = ?, version = ?, updated_at = ?
        WHERE id = ? AND version = ?`
      )
      .bind(
        title,
        description,
        sector,
        task,
        bundlePriceCents,
        status,
        nextVersion,
        now,
        input.bundleId,
        input.expectedVersion
      )
  )

  const dummyReceipt: BundleDetailView = {
    id: current.id,
    slug: current.slug,
    title,
    description,
    sector,
    task,
    bundlePriceCents,
    status,
    version: nextVersion,
    equivalentStandaloneCents: bundlePriceCents,
    savingsCents: 0,
    savingsPercent: 0,
    maxAvailableKits: 0,
    inStock: true,
    items: [],
    createdAt: current.created_at,
    updatedAt: now
  }

  statements.push(
    db
      .prepare(
        `INSERT INTO bundle_commands (
          command_id, actor_id, action, idempotency_key, expected_version,
          applied_version, payload_hash, input_json, receipt_json, created_at
        ) VALUES (?, ?, 'update_bundle', ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        input.commandId,
        claims.identityId,
        input.idempotencyKey,
        input.expectedVersion,
        nextVersion,
        payloadHash,
        JSON.stringify(input),
        JSON.stringify(dummyReceipt),
        now
      )
  )

  await db.batch(statements)

  const updated = await getD1BundleBySlug(db, current.slug, now)
  if (!updated) fail('not_found')
  return updated
}

export async function archiveD1Bundle(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  input: {
    commandId: string
    idempotencyKey: string
    bundleId: string
    expectedVersion: number
    now?: string
  }
): Promise<BundleDetailView> {
  return updateD1Bundle(db, claims, {
    commandId: input.commandId,
    idempotencyKey: input.idempotencyKey,
    bundleId: input.bundleId,
    expectedVersion: input.expectedVersion,
    status: 'archived',
    now: input.now
  })
}

export async function getD1BundleBySlug(
  db: D1Database,
  slug: string,
  _nowIso?: string
): Promise<BundleDetailView | null> {
  const bundleRow = await db
    .prepare(
      `SELECT
        id, slug, title, description, sector, task, bundle_price_cents,
        status, version, created_at, updated_at
      FROM bundles
      WHERE slug = ?`
    )
    .bind(slug)
    .first<{
      id: string
      slug: string
      title: string
      description: string
      sector: BundleSector
      task: BundleTask
      bundle_price_cents: number
      status: 'draft' | 'active' | 'archived'
      version: number
      created_at: string
      updated_at: string
    }>()

  if (!bundleRow) return null

  // Fetch components joined with variants, products, price versions, and inventory
  const itemsRows = await db
    .prepare(
      `SELECT
        bi.id,
        bi.variant_id,
        bi.quantity,
        bi.min_quantity,
        bi.max_quantity,
        bi.sort_order,
        v.sku AS variant_sku,
        v.format AS variant_name,
        p.name AS product_title,
        COALESCE(tc.rate_basis_points / 10000.0, 0.21) AS tax_rate,
        COALESCE(
          (SELECT gross_cents FROM variant_price_versions
           WHERE variant_id = v.id AND status = 'approved'
           ORDER BY valid_from DESC LIMIT 1),
          v.price_gross_cents,
          0
        ) AS unit_price_cents,
        COALESCE(
          (SELECT physical_quantity - blocked_quantity FROM inventory_balances
           WHERE variant_id = v.id
           ORDER BY version DESC LIMIT 1),
          0
        ) AS effective_stock
      FROM bundle_items bi
      JOIN variants v ON v.id = bi.variant_id
      JOIN products p ON p.id = v.product_id
      LEFT JOIN tax_classes tc ON tc.id = v.tax_class_id
      WHERE bi.bundle_id = ?
      ORDER BY bi.sort_order ASC`
    )
    .bind(bundleRow.id)
    .all<{
      id: string
      variant_id: string
      quantity: number
      min_quantity: number
      max_quantity: number
      sort_order: number
      variant_sku: string
      variant_name: string
      product_title: string
      tax_rate: number
      unit_price_cents: number
      effective_stock: number
    }>()

  const items: BundleComponentView[] = (itemsRows.results || []).map((row) => ({
    id: row.id,
    variantId: row.variant_id,
    variantSku: row.variant_sku,
    variantName: row.variant_name,
    productTitle: row.product_title,
    unitPriceCents: row.unit_price_cents,
    taxRate: row.tax_rate,
    defaultQuantity: row.quantity,
    minQuantity: row.min_quantity,
    maxQuantity: row.max_quantity,
    effectiveStock: row.effective_stock
  }))

  const maxAvailableKits = calculateBundleAvailability(
    items.map((i) => ({ effectiveStock: i.effectiveStock, quantity: i.defaultQuantity }))
  )

  const pricing = calculateBundlePricing({
    baseBundlePriceCents: bundleRow.bundle_price_cents,
    kitQuantity: 1,
    components: items.map((i) => ({
      unitPriceCents: i.unitPriceCents,
      taxRate: i.taxRate,
      defaultQuantity: i.defaultQuantity
    }))
  })

  return {
    id: bundleRow.id,
    slug: bundleRow.slug,
    title: bundleRow.title,
    description: bundleRow.description,
    sector: bundleRow.sector,
    task: bundleRow.task,
    bundlePriceCents: bundleRow.bundle_price_cents,
    status: bundleRow.status,
    version: bundleRow.version,
    equivalentStandaloneCents: pricing.equivalentStandaloneCents,
    savingsCents: pricing.savingsCents,
    savingsPercent: pricing.savingsPercent,
    maxAvailableKits,
    inStock: maxAvailableKits > 0,
    items,
    createdAt: bundleRow.created_at,
    updatedAt: bundleRow.updated_at
  }
}

export async function listD1Bundles(
  db: D1Database,
  filters?: { sector?: string; task?: string; includeArchived?: boolean },
  nowIso?: string
): Promise<{ items: BundleDetailView[] }> {
  let query = `SELECT slug FROM bundles WHERE 1=1`
  const bindings: unknown[] = []

  if (!filters?.includeArchived) {
    query += ` AND status = 'active'`
  }
  if (filters?.sector) {
    query += ` AND sector = ?`
    bindings.push(filters.sector)
  }
  if (filters?.task) {
    query += ` AND task = ?`
    bindings.push(filters.task)
  }

  query += ` ORDER BY created_at DESC`

  const rows = await db
    .prepare(query)
    .bind(...bindings)
    .all<{ slug: string }>()

  const items: BundleDetailView[] = []
  for (const row of rows.results || []) {
    const detail = await getD1BundleBySlug(db, row.slug, nowIso)
    if (detail) items.push(detail)
  }

  return { items }
}

export async function calculateD1BundleSelection(
  db: D1Database,
  input: {
    bundleId: string
    kitQuantity?: number
    customQuantities?: Record<string, number>
  }
): Promise<BundlePricingResult & { inStock: boolean; maxAvailableKits: number }> {
  const parsed = bundleSelectionSchema.safeParse(input)
  if (!parsed.success) fail('invalid_input')

  const bundleRow = await db
    .prepare(`SELECT slug, bundle_price_cents FROM bundles WHERE id = ?`)
    .bind(input.bundleId)
    .first<{ slug: string; bundle_price_cents: number }>()

  if (!bundleRow) fail('not_found')

  const detail = await getD1BundleBySlug(db, bundleRow.slug)
  if (!detail) fail('not_found')

  const kitQty = input.kitQuantity ?? 1

  const componentsForPricing = detail.items.map((item) => {
    const customQty =
      input.customQuantities && typeof input.customQuantities[item.variantId] === 'number'
        ? input.customQuantities[item.variantId]!
        : item.defaultQuantity
    return {
      variantId: item.variantId,
      unitPriceCents: item.unitPriceCents,
      taxRate: item.taxRate,
      defaultQuantity: item.defaultQuantity,
      customQuantity: customQty
    }
  })

  const pricing = calculateBundlePricing({
    baseBundlePriceCents: bundleRow.bundle_price_cents,
    kitQuantity: kitQty,
    components: componentsForPricing
  })

  const maxAvailableKits = calculateBundleAvailability(
    detail.items.map((item) => {
      const customQty =
        input.customQuantities && typeof input.customQuantities[item.variantId] === 'number'
          ? input.customQuantities[item.variantId]!
          : item.defaultQuantity
      return {
        effectiveStock: item.effectiveStock,
        quantity: customQty
      }
    })
  )

  return {
    ...pricing,
    maxAvailableKits,
    inStock: maxAvailableKits >= kitQty
  }
}
