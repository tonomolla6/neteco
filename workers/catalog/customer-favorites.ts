import { validateQuantity } from '../../server/domain/money'
import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import { sellableExpression } from './inventory'
import { publicationValidityExpression } from './publication-validity'

const MAX_NAMED_LISTS = 20
const MAX_ITEMS = 100
const MAX_QUANTITY = 999 // Same hard ceiling as the D1 cart.
const DEFAULT_NAME = 'Favoritos'

export type FavoriteResult =
  | { ok: true; id: string }
  | {
      ok: false
      code: 'unauthenticated' | 'invalid_input' | 'not_found' | 'limit_reached' | 'already_exists' | 'not_available'
    }

export interface FavoriteItem {
  variantId: string
  /** Server-owned compatibility mapping; never infer a cart ID from a UUID or SKU. */
  cartVariantId: number | null
  sku: string
  quantity: string
  name: string
  slug: string
  format: string
  unitLabel: string
  minimumQuantity: number
  maximumQuantity: number | null
  quantityIncrement: number
  available: boolean
  reason: 'unpublished' | 'quantity_changed' | 'out_of_stock' | 'cart_unmapped' | null
}

export interface FavoriteList {
  id: string
  name: string
  isDefault: boolean
  items: FavoriteItem[]
}

const ownerSql = `SELECT c.id FROM auth_sessions s
  JOIN identities i ON i.id = s.identity_id AND i.session_version = s.session_version
  JOIN customers c ON c.id = i.customer_id AND c.status = 'active'
  WHERE s.id = ? AND s.identity_id = ? AND s.session_version = ?
    AND i.status = 'active' AND i.email_verified_at IS NOT NULL AND i.email_verified_at <= ?
    AND (s.mfa_verified = 1 OR NOT EXISTS (
      SELECT 1 FROM identity_mfa m WHERE m.identity_id = i.id AND m.verified_at IS NOT NULL))
    AND s.revoked_at IS NULL AND s.created_at <= ? AND s.expires_at > ?`

type Owner = { binds: readonly [string, string, number, string, string, string]; now: string }

function canonicalNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

async function owner(request: Request, configuration: SessionCookieConfiguration): Promise<Owner | null> {
  const claims = await verifySessionCookie(request, configuration)
  if (!claims) return null
  const now = canonicalNow()
  return { binds: [claims.sessionId, claims.identityId, claims.sessionVersion, now, now, now], now }
}

async function active(database: D1Database, current: Owner) {
  return Boolean(
    await database
      .prepare(ownerSql)
      .bind(...current.binds)
      .first<{ id: string }>()
  )
}

function validName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value === value.trim() &&
    value.length >= 1 &&
    value.length <= 80 &&
    !hasControlCharacters(value)
  )
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && !hasControlCharacters(value)
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
}

const variantRead = `SELECT v.id, v.minimum_quantity AS minimumQuantity,
    v.maximum_quantity AS maximumQuantity, v.quantity_increment AS quantityIncrement
  FROM variants v
  JOIN products p ON p.id = v.product_id AND p.status = 'published'
  JOIN categories c ON c.id = p.category_id AND c.status = 'published'
  WHERE v.id = ? AND v.status = 'published' AND ${publicationValidityExpression('p')}`

type VariantRules = { id: string; minimumQuantity: number; maximumQuantity: number | null; quantityIncrement: number }

function permittedQuantity(value: unknown, rules: VariantRules): value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_QUANTITY) return false
  try {
    validateQuantity(value, rules)
    return true
  } catch {
    return false
  }
}

// This is a read-time observation only. Cart mutation and quote must re-check.
const itemRowsSql = `SELECT l.id AS listId, l.name AS listName, l.is_default AS isDefault,
    i.variant_id AS variantId, v.legacy_id AS cartVariantId, i.quantity, v.sku, p.name AS productName, p.slug,
    v.format, v.unit_label AS unitLabel, v.minimum_quantity AS minimumQuantity,
    v.maximum_quantity AS maximumQuantity, v.quantity_increment AS quantityIncrement,
    CASE WHEN v.status = 'published' AND p.status = 'published' AND c.status = 'published'
      AND ${publicationValidityExpression('p')}
      THEN 1 ELSE 0 END AS published,
    CASE WHEN v.backorder_allowed = 1 THEN 1 ELSE 0 END AS backorderAllowed,
    COALESCE((SELECT TOTAL(${sellableExpression()}) FROM inventory_balances b
      WHERE b.variant_id = v.id), 0) AS sellable
  FROM customer_favorite_lists l
  LEFT JOIN customer_favorite_items i ON i.list_id = l.id
  LEFT JOIN variants v ON v.id = i.variant_id
  LEFT JOIN products p ON p.id = v.product_id
  LEFT JOIN categories c ON c.id = p.category_id
  WHERE l.customer_id = (${ownerSql})
  ORDER BY l.is_default DESC, l.created_at, l.id, i.created_at, i.variant_id`

type ItemRow = {
  listId: string
  listName: string
  isDefault: number
  variantId: string | null
  cartVariantId: number | null
  quantity: number | null
  sku: string | null
  productName: string | null
  slug: string | null
  format: string | null
  unitLabel: string | null
  minimumQuantity: number | null
  maximumQuantity: number | null
  quantityIncrement: number | null
  published: number
  backorderAllowed: number
  sellable: number
}

/** Null means no verified, currently active customer session; never an empty foreign list. */
export async function listD1CustomerFavorites(
  database: D1Database,
  request: Request,
  configuration: SessionCookieConfiguration
): Promise<{ lists: FavoriteList[] } | null> {
  const current = await owner(request, configuration)
  if (!current || !(await active(database, current))) return null
  const rows = (
    await database
      .prepare(itemRowsSql)
      .bind(...current.binds)
      .all<ItemRow>()
  ).results
  // Do not turn a session revoked between the first check and guarded read into
  // an apparently valid empty account (or disclose a stale result).
  if (!(await active(database, current))) return null
  const lists: FavoriteList[] = []
  for (const row of rows) {
    let list = lists[lists.length - 1]
    if (list?.id !== row.listId) {
      list = { id: row.listId, name: row.listName, isDefault: row.isDefault === 1, items: [] }
      lists.push(list)
    }
    if (
      !row.variantId ||
      !row.sku ||
      !row.productName ||
      !row.slug ||
      !row.format ||
      !row.unitLabel ||
      row.quantity === null
    )
      continue
    const quantityValid = permittedQuantity(row.quantity, {
      id: row.variantId,
      minimumQuantity: row.minimumQuantity ?? 1,
      maximumQuantity: row.maximumQuantity,
      quantityIncrement: row.quantityIncrement ?? 1
    })
    const reason = !row.published
      ? 'unpublished'
      : !quantityValid
        ? 'quantity_changed'
        : !row.backorderAllowed && row.sellable < row.quantity
          ? 'out_of_stock'
          : !Number.isSafeInteger(row.cartVariantId) || Number(row.cartVariantId) < 1
            ? 'cart_unmapped'
            : null
    list.items.push({
      variantId: row.variantId,
      cartVariantId:
        Number.isSafeInteger(row.cartVariantId) && Number(row.cartVariantId) > 0 ? row.cartVariantId : null,
      sku: row.sku,
      quantity: String(row.quantity),
      name: row.productName,
      slug: row.slug,
      format: row.format,
      unitLabel: row.unitLabel,
      minimumQuantity: row.minimumQuantity ?? 1,
      maximumQuantity: row.maximumQuantity,
      quantityIncrement: row.quantityIncrement ?? 1,
      available: reason === null,
      reason
    })
  }
  return { lists }
}

/** A named list is private to the current customer and cannot impersonate the default. */
export async function createD1FavoriteList(
  database: D1Database,
  request: Request,
  configuration: SessionCookieConfiguration,
  name: unknown
): Promise<FavoriteResult> {
  if (!validName(name) || name === DEFAULT_NAME) return { ok: false, code: 'invalid_input' }
  const current = await owner(request, configuration)
  if (!current) return { ok: false, code: 'unauthenticated' }
  const id = crypto.randomUUID()
  const row = await database
    .prepare(
      `INSERT INTO customer_favorite_lists(id, customer_id, name, is_default, created_at, updated_at)
    SELECT ?, owner.id, ?, 0, ?, ? FROM (${ownerSql}) owner
    WHERE (SELECT count(*) FROM customer_favorite_lists WHERE customer_id = owner.id AND is_default = 0) < ${MAX_NAMED_LISTS}
      AND NOT EXISTS (SELECT 1 FROM customer_favorite_lists WHERE customer_id = owner.id AND name = ?)
    RETURNING id`
    )
    .bind(id, name, current.now, current.now, ...current.binds, name)
    .first<{ id: string }>()
  if (row) return { ok: true, id: row.id }
  if (!(await active(database, current))) return { ok: false, code: 'unauthenticated' }
  const duplicate = await database
    .prepare(`SELECT 1 FROM customer_favorite_lists WHERE customer_id = (${ownerSql}) AND name = ?`)
    .bind(...current.binds, name)
    .first()
  return { ok: false, code: duplicate ? 'already_exists' : 'limit_reached' }
}

export async function renameD1FavoriteList(
  database: D1Database,
  request: Request,
  configuration: SessionCookieConfiguration,
  listId: unknown,
  name: unknown
): Promise<FavoriteResult> {
  if (!validId(listId) || !validName(name) || name === DEFAULT_NAME) return { ok: false, code: 'invalid_input' }
  const current = await owner(request, configuration)
  if (!current) return { ok: false, code: 'unauthenticated' }
  const row = await database
    .prepare(
      `UPDATE customer_favorite_lists SET name = ?, updated_at = ?
    WHERE id = ? AND is_default = 0 AND customer_id = (${ownerSql})
      AND NOT EXISTS (SELECT 1 FROM customer_favorite_lists same
        WHERE same.customer_id = customer_favorite_lists.customer_id AND same.name = ? AND same.id <> customer_favorite_lists.id)
    RETURNING id`
    )
    .bind(name, current.now, listId, ...current.binds, name)
    .first<{ id: string }>()
  if (row) return { ok: true, id: row.id }
  if (!(await active(database, current))) return { ok: false, code: 'unauthenticated' }
  const owned = await database
    .prepare(`SELECT 1 FROM customer_favorite_lists WHERE id = ? AND is_default = 0 AND customer_id = (${ownerSql})`)
    .bind(listId, ...current.binds)
    .first()
  return { ok: false, code: owned ? 'already_exists' : 'not_found' }
}

export async function deleteD1FavoriteList(
  database: D1Database,
  request: Request,
  configuration: SessionCookieConfiguration,
  listId: unknown
): Promise<FavoriteResult> {
  if (!validId(listId)) return { ok: false, code: 'invalid_input' }
  const current = await owner(request, configuration)
  if (!current) return { ok: false, code: 'unauthenticated' }
  const row = await database
    .prepare(
      `DELETE FROM customer_favorite_lists
    WHERE id = ? AND is_default = 0 AND customer_id = (${ownerSql}) RETURNING id`
    )
    .bind(listId, ...current.binds)
    .first<{ id: string }>()
  if (row) return { ok: true, id: row.id }
  return { ok: false, code: (await active(database, current)) ? 'not_found' : 'unauthenticated' }
}

function returnedId(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || !('id' in value)) return null
  return typeof value.id === 'string' ? value.id : null
}

async function classifyFailedSave(
  database: D1Database,
  current: Owner,
  variantId: string,
  quantity: number,
  listId: string | undefined
): Promise<FavoriteResult | null> {
  if (!(await active(database, current))) return { ok: false, code: 'unauthenticated' }
  const latestRules = await database.prepare(variantRead).bind(variantId).first<VariantRules>()
  if (!latestRules) return { ok: false, code: 'not_available' }
  if (!permittedQuantity(quantity, latestRules)) return { ok: false, code: 'invalid_input' }
  const target = listId === undefined ? 'l.is_default = 1' : 'l.id = ?'
  const list = await database
    .prepare(`SELECT l.id FROM customer_favorite_lists l WHERE l.customer_id = (${ownerSql}) AND ${target}`)
    .bind(...current.binds, ...(listId === undefined ? [] : [listId]))
    .first<{ id: string }>()
  if (!list) return listId === undefined ? null : { ok: false, code: 'not_found' }
  const contents = await database
    .prepare(
      `SELECT count(*) AS itemCount, count(*) FILTER (WHERE variant_id = ?) AS matchingCount
      FROM customer_favorite_items WHERE list_id = ?`
    )
    .bind(variantId, list.id)
    .first<{ itemCount: number; matchingCount: number }>()
  if (contents && contents.itemCount >= MAX_ITEMS && contents.matchingCount === 0)
    return { ok: false, code: 'limit_reached' }
  return null
}

/** Existing Node/UI POST has no listId; omission stores in the private default. */
export async function saveD1CustomerFavorite(
  database: D1Database,
  request: Request,
  configuration: SessionCookieConfiguration,
  input: { variantId: unknown; quantity?: unknown; listId?: unknown }
): Promise<FavoriteResult> {
  if (!validId(input.variantId) || (input.listId !== undefined && !validId(input.listId)))
    return { ok: false, code: 'invalid_input' }
  const variantId = input.variantId
  const listId = input.listId
  const quantity = input.quantity ?? 1
  if (typeof quantity !== 'number' || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY)
    return { ok: false, code: 'invalid_input' }
  const current = await owner(request, configuration)
  if (!current) return { ok: false, code: 'unauthenticated' }
  if (!(await active(database, current))) return { ok: false, code: 'unauthenticated' }
  const rules = await database.prepare(variantRead).bind(variantId).first<VariantRules>()
  if (!rules) return { ok: false, code: 'not_available' }
  if (!permittedQuantity(quantity, rules)) return { ok: false, code: 'invalid_input' }

  const writeNonce = crypto.randomUUID()
  const createDefault = database
    .prepare(
      `INSERT INTO customer_favorite_lists(id, customer_id, name, is_default, created_at, updated_at)
      SELECT ?, owner.id, '${DEFAULT_NAME}', 1, ?, ? FROM (${ownerSql}) owner
      WHERE NOT EXISTS (SELECT 1 FROM customer_favorite_lists existing
        WHERE existing.customer_id = owner.id AND existing.is_default = 1)
      ON CONFLICT(customer_id, name) DO NOTHING`
    )
    .bind(crypto.randomUUID(), current.now, current.now, ...current.binds)
  const target = listId === undefined ? `l.is_default = 1` : `l.id = ?`
  const saveItem = database
    .prepare(
      `INSERT INTO customer_favorite_items(list_id, variant_id, quantity, write_nonce, created_at, updated_at)
    SELECT l.id, v.id, ?, ?, ?, ?
    FROM customer_favorite_lists l
    JOIN (${ownerSql}) owner ON owner.id = l.customer_id
    JOIN variants v ON v.id = ? AND v.status = 'published'
    JOIN products p ON p.id = v.product_id AND p.status = 'published'
    JOIN categories c ON c.id = p.category_id AND c.status = 'published'
    WHERE ${target}
      AND ${publicationValidityExpression('p')}
      AND ? >= v.minimum_quantity AND (v.maximum_quantity IS NULL OR ? <= v.maximum_quantity)
      AND (? - v.minimum_quantity) % v.quantity_increment = 0
      AND (EXISTS (SELECT 1 FROM customer_favorite_items WHERE list_id = l.id AND variant_id = v.id)
        OR (SELECT count(*) FROM customer_favorite_items WHERE list_id = l.id) < ${MAX_ITEMS})
    ON CONFLICT(list_id, variant_id) DO UPDATE SET quantity = excluded.quantity,
      write_nonce = excluded.write_nonce, updated_at = excluded.updated_at
    RETURNING list_id AS id`
    )
    .bind(
      quantity,
      writeNonce,
      current.now,
      current.now,
      ...current.binds,
      variantId,
      ...(listId === undefined ? [] : [listId]),
      quantity,
      quantity,
      quantity
    )
  // D1 batch is one transaction. If the guarded INSERT selected no row (e.g.
  // publication or quantity changed), the invalid quantity aborts everything,
  // including the newly created default list.
  const requireWrite = database
    .prepare(
      `INSERT INTO customer_favorite_items(list_id, variant_id, quantity, write_nonce, created_at, updated_at)
      SELECT 'favorite-guard:' || ?, 'favorite-guard:' || ?, 0, ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM customer_favorite_items WHERE write_nonce = ?)`
    )
    .bind(writeNonce, writeNonce, writeNonce, current.now, current.now, writeNonce)
  try {
    const results = await database.batch(
      listId === undefined ? [createDefault, saveItem, requireWrite] : [saveItem, requireWrite]
    )
    const id = returnedId(results[listId === undefined ? 1 : 0]?.results[0])
    if (!id) throw new Error('favorite_write_missing_returning_row')
    return { ok: true, id }
  } catch (error) {
    const classified = await classifyFailedSave(database, current, variantId, quantity, listId)
    if (classified) return classified
    throw error
  }
}

export async function removeD1CustomerFavorite(
  database: D1Database,
  request: Request,
  configuration: SessionCookieConfiguration,
  variantId: unknown,
  listId?: unknown
): Promise<FavoriteResult> {
  if (!validId(variantId) || (listId !== undefined && !validId(listId))) return { ok: false, code: 'invalid_input' }
  const current = await owner(request, configuration)
  if (!current) return { ok: false, code: 'unauthenticated' }
  const target = listId === undefined ? 'l.is_default = 1' : 'l.id = ?'
  const row = await database
    .prepare(
      `DELETE FROM customer_favorite_items
    WHERE variant_id = ? AND list_id IN (
      SELECT l.id FROM customer_favorite_lists l JOIN (${ownerSql}) owner ON owner.id = l.customer_id
      WHERE ${target}) RETURNING list_id AS id`
    )
    .bind(variantId, ...current.binds, ...(listId === undefined ? [] : [listId]))
    .first<{ id: string }>()
  if (row) return { ok: true, id: row.id }
  return { ok: false, code: (await active(database, current)) ? 'not_found' : 'unauthenticated' }
}

/** Re-read immediately before cart transfer; caller must still use setCartLine and quoteCart. */
export async function prepareD1FavoriteListForCart(
  database: D1Database,
  request: Request,
  configuration: SessionCookieConfiguration,
  listId: unknown
): Promise<
  | {
      outcome: 'ready'
      ready: Array<{ variantId: string; cartVariantId: number; quantity: number; unitLabel: string }>
      unavailable: FavoriteItem[]
    }
  | { outcome: 'unauthenticated' | 'not_found' | 'invalid_input' }
> {
  if (!validId(listId)) return { outcome: 'invalid_input' }
  const result = await listD1CustomerFavorites(database, request, configuration)
  if (!result) return { outcome: 'unauthenticated' }
  const list = result.lists.find((entry) => entry.id === listId)
  if (!list) return { outcome: 'not_found' }
  return {
    outcome: 'ready',
    ready: list.items
      .filter((item) => item.available && item.cartVariantId !== null)
      .map((item) => ({
        variantId: item.variantId,
        cartVariantId: item.cartVariantId!,
        quantity: Number(item.quantity),
        unitLabel: item.unitLabel
      })),
    unavailable: list.items.filter((item) => !item.available)
  }
}
