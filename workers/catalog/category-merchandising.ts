import { z } from 'zod'
import {
  CATEGORY_MERCHANDISING_POPULARITY_DAYS,
  categoryMerchandisingCampaignSchema,
  categoryMerchandisingGuardrailsSchema,
  categoryMerchandisingInputSchema,
  categoryMerchandisingState,
  categoryMerchandisingWeightsSchema,
  rankCategoryProducts,
  type CategoryMerchandisingInput,
  type CategoryProductSignals
} from '../../shared/category-merchandising'
import { catalogPolicyUuidSchema } from '../../shared/catalog-publication-policy'
import { authorizeD1Session, type VerifiedSessionClaims } from './authorization'
import { canonicalJson, sellableExpression, sha256Hex } from './inventory'
import { effectiveB2BSourceExpression, effectiveGrossCentsExpression, inlineEffectivePricingSql } from './pricing'

/** SEA-015. Persistence, preview and storefront application of category merchandising rules.
 * Same architecture as the search rules (SEA-013): append-only revisions are the audit trail and the
 * durable receipt, CAS by version, idempotency by key + payload hash, and a fresh `catalog.write` + MFA
 * check around every read and write. The public listing only ever reads a live rule through
 * `readLiveCategoryOrder`. */
export class CategoryMerchandisingError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}
const fail = (code: string): never => {
  throw new CategoryMerchandisingError(code)
}
const SECONDS = /\.\d{3}Z$/
const now = (value?: string) => {
  if (
    value !== undefined &&
    (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString().replace(SECONDS, 'Z') !== value)
  )
    fail('invalid_input')
  return value ?? new Date().toISOString().replace(SECONDS, 'Z')
}
async function authorize(database: D1Database, claims: VerifiedSessionClaims, instant?: string) {
  const result = await authorizeD1Session(database, claims, 'catalog.write', { requireMfa: true, now: now(instant) })
  if (!result.allowed) fail(result.code)
}
const keyValid = (key: string) => /^[A-Za-z0-9._:-]{1,200}$/.test(key)
const instant = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
const version = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const reason = z.string().trim().min(3).max(500)

const snapshotSchema = z
  .object({
    id: catalogPolicyUuidSchema,
    categoryId: catalogPolicyUuidSchema,
    weights: categoryMerchandisingWeightsSchema,
    guardrails: categoryMerchandisingGuardrailsSchema,
    campaign: categoryMerchandisingCampaignSchema,
    reason,
    validFrom: instant,
    validUntil: instant,
    status: z.enum(['active', 'retired']),
    authorId: catalogPolicyUuidSchema,
    version: version.refine((value) => value > 0),
    updatedAt: instant
  })
  .strict()
export type CategoryMerchandisingSnapshot = z.infer<typeof snapshotSchema>
const stateSchema = z.enum(['live', 'scheduled', 'expired', 'retired'])
const viewSchema = snapshotSchema.extend({ state: stateSchema }).strict()
export type CategoryMerchandisingItem = z.infer<typeof viewSchema>
export const categoryMerchandisingReceiptSchema = z
  .object({
    source: z.literal('cloudflare'),
    commandId: catalogPolicyUuidSchema,
    action: z.enum(['save', 'retire']),
    item: snapshotSchema
  })
  .strict()
export type CategoryMerchandisingReceipt = z.infer<typeof categoryMerchandisingReceiptSchema>

const view = (row: { snapshot: string }, at: string): CategoryMerchandisingItem => {
  const item = snapshotSchema.parse(JSON.parse(row.snapshot))
  return viewSchema.parse({ ...item, state: categoryMerchandisingState(item, at) })
}

function mapFailure(error: unknown): never {
  if (error instanceof CategoryMerchandisingError) throw error
  const message = error instanceof Error ? error.message : ''
  const known: Array<[string, string]> = [
    ['category_merchandising_authority_changed', 'forbidden'],
    ['category_merchandising_version_conflict', 'version_conflict'],
    ['category_merchandising_commands.rule_id', 'version_conflict'],
    ['category_merchandising_rule_conflict', 'rule_conflict']
  ]
  for (const [fragment, code] of known) if (message.includes(fragment)) fail(code)
  throw error
}

export async function readCategoryMerchandisingReceipt(
  database: D1Database,
  claims: VerifiedSessionClaims,
  key: string,
  at?: string
): Promise<CategoryMerchandisingReceipt | null> {
  if (!keyValid(key)) fail('invalid_input')
  await authorize(database, claims, at)
  const row = await database
    .prepare('SELECT response FROM category_merchandising_commands WHERE actor_id=? AND idempotency_key=?')
    .bind(claims.identityId, key)
    .first<{ response: string }>()
  await authorize(database, claims, at)
  return row ? categoryMerchandisingReceiptSchema.parse(JSON.parse(row.response)) : null
}
export async function readCategoryMerchandisingRule(
  database: D1Database,
  claims: VerifiedSessionClaims,
  id: string,
  at?: string
): Promise<CategoryMerchandisingItem | null> {
  const instantNow = now(at)
  await authorize(database, claims, at)
  const row = await database
    .prepare('SELECT snapshot FROM category_merchandising_current WHERE rule_id=?')
    .bind(id)
    .first<{ snapshot: string }>()
  await authorize(database, claims, at)
  return row ? view(row, instantNow) : null
}
export async function readCategoryMerchandisingHistory(
  database: D1Database,
  claims: VerifiedSessionClaims,
  id: string,
  at?: string
) {
  const instantNow = now(at)
  await authorize(database, claims, at)
  const rows = await database
    .prepare('SELECT snapshot FROM category_merchandising_commands WHERE rule_id=? ORDER BY version')
    .bind(id)
    .all<{ snapshot: string }>()
  await authorize(database, claims, at)
  if (!rows.results.length) return null
  return { source: 'cloudflare' as const, items: rows.results.map((row) => view(row, instantNow)) }
}
export async function listCategoryMerchandisingRules(
  database: D1Database,
  claims: VerifiedSessionClaims,
  query: { page?: number; perPage?: number; categoryId?: string; status?: 'open' | 'retired' | 'all' } = {},
  at?: string
) {
  const page = query.page ?? 1,
    perPage = query.perPage ?? 25,
    status = query.status ?? 'open'
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > 1_000_000 ||
    !Number.isSafeInteger(perPage) ||
    perPage < 1 ||
    perPage > 100 ||
    !['open', 'retired', 'all'].includes(status) ||
    (query.categoryId !== undefined && !catalogPolicyUuidSchema.safeParse(query.categoryId).success)
  )
    fail('invalid_input')
  const instantNow = now(at)
  await authorize(database, claims, at)
  const statusSql = status === 'open' ? "status<>'retired'" : status === 'retired' ? "status='retired'" : '1=1'
  const where = `${statusSql} AND (?1 IS NULL OR category_id=?1)`
  const results = await database.batch([
    database
      .prepare(`SELECT count(*) total FROM category_merchandising_current WHERE ${where}`)
      .bind(query.categoryId ?? null),
    database
      .prepare(
        `SELECT snapshot FROM category_merchandising_current WHERE ${where} ORDER BY category_id,rule_id LIMIT ?2 OFFSET ?3`
      )
      .bind(query.categoryId ?? null, perPage, (page - 1) * perPage)
  ])
  if (results.some((result) => !result.success)) throw new Error('category_merchandising_read_failed')
  await authorize(database, claims, at)
  return {
    source: 'cloudflare' as const,
    items: (results[1]!.results as Array<{ snapshot: string }>).map((row) => view(row, instantNow)),
    total: (results[0]!.results[0] as { total: number }).total,
    page,
    perPage
  }
}

/** Published categories an administrator can attach a rule to (bounded; the tree is small). */
export async function listMerchandisableCategories(database: D1Database, claims: VerifiedSessionClaims, at?: string) {
  await authorize(database, claims, at)
  const { results } = await database
    .prepare(
      "SELECT id, name, slug, parent_id AS parentId FROM categories WHERE status='published' ORDER BY lower(name), id LIMIT 500"
    )
    .all<{ id: string; name: string; slug: string; parentId: string | null }>()
  await authorize(database, claims, at)
  return results
}

async function assertReferences(
  database: D1Database,
  data: Extract<CategoryMerchandisingInput, { action: 'save' }>,
  at: string
) {
  const category = await database
    .prepare("SELECT 1 AS ok FROM categories WHERE id=?1 AND status='published'")
    .bind(data.categoryId)
    .first()
  if (!category) fail('category_unavailable')
  if (!(data.validUntil > at)) fail('expiry_invalid')
  if (data.campaign.productIds.length) {
    const found = await database
      .prepare(
        "SELECT count(*) AS n FROM products WHERE status='published' AND id IN (SELECT value FROM json_each(?1))"
      )
      .bind(JSON.stringify(data.campaign.productIds))
      .first<{ n: number }>()
    if (found?.n !== data.campaign.productIds.length) fail('product_unavailable')
  }
  if (data.campaign.campaignId) {
    const campaign = await database
      .prepare('SELECT 1 AS ok FROM commercial_campaigns WHERE id=?1')
      .bind(data.campaign.campaignId)
      .first()
      .catch(() => null)
    if (!campaign) fail('campaign_unavailable')
  }
}

export async function executeCategoryMerchandisingCommand(
  database: D1Database,
  claims: VerifiedSessionClaims,
  input: unknown,
  options: { idempotencyKey: string; now?: string; target?: string | null; action?: 'save' | 'retire' }
): Promise<CategoryMerchandisingReceipt> {
  const parsed = categoryMerchandisingInputSchema.safeParse(input)
  if (!parsed.success || !keyValid(options.idempotencyKey)) fail('invalid_input')
  const data = parsed.data as CategoryMerchandisingInput
  if (
    (options.target !== undefined && options.target !== data.id) ||
    (options.action !== undefined && options.action !== data.action)
  )
    fail('invalid_input')
  await authorize(database, claims, options.now)
  const payloadHash = await sha256Hex(canonicalJson(data))
  const replay = async () => {
    const row = await database
      .prepare(
        'SELECT payload_hash,response FROM category_merchandising_commands WHERE actor_id=? AND idempotency_key=?'
      )
      .bind(claims.identityId, options.idempotencyKey)
      .first<{ payload_hash: string; response: string }>()
    if (!row) return null
    if (row.payload_hash !== payloadHash) fail('idempotency_conflict')
    await authorize(database, claims, options.now)
    return categoryMerchandisingReceiptSchema.parse(JSON.parse(row.response))
  }
  const prior = await replay()
  if (prior) return prior

  const createdAt = now(options.now),
    commandId = crypto.randomUUID()
  let existing: CategoryMerchandisingSnapshot | null = null
  if (data.id) {
    const row = await database
      .prepare('SELECT snapshot FROM category_merchandising_current WHERE rule_id=?')
      .bind(data.id)
      .first<{ snapshot: string }>()
    existing = row ? snapshotSchema.parse(JSON.parse(row.snapshot)) : null
    if (!existing || existing.status === 'retired' || existing.version !== data.expectedVersion)
      fail('version_conflict')
    if (data.action === 'save' && existing!.categoryId !== data.categoryId) fail('version_conflict')
  }
  if (data.action === 'save') await assertReferences(database, data, createdAt)
  const content =
    data.action === 'retire'
      ? { ...existing!, reason: data.reason, status: 'retired' as const }
      : {
          id: data.id ?? crypto.randomUUID(),
          categoryId: data.categoryId,
          weights: data.weights,
          guardrails: data.guardrails,
          campaign: data.campaign,
          reason: data.reason,
          validFrom: data.validFrom,
          validUntil: data.validUntil,
          status: 'active' as const
        }
  const item = snapshotSchema.parse({
    id: content.id,
    categoryId: content.categoryId,
    weights: content.weights,
    guardrails: content.guardrails,
    campaign: content.campaign,
    reason: content.reason,
    validFrom: content.validFrom,
    validUntil: content.validUntil,
    status: content.status,
    authorId: claims.identityId,
    version: data.expectedVersion + 1,
    updatedAt: createdAt
  })
  const receipt: CategoryMerchandisingReceipt = { source: 'cloudflare', commandId, action: data.action, item }
  await authorize(database, claims, options.now)
  try {
    await database
      .prepare(
        `INSERT INTO category_merchandising_commands(id,actor_id,session_id,session_version,idempotency_key,payload_hash,rule_id,expected_version,version,category_id,reason,valid_from,valid_until,status,snapshot,response,created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .bind(
        commandId,
        claims.identityId,
        claims.sessionId,
        claims.sessionVersion,
        options.idempotencyKey,
        payloadHash,
        item.id,
        data.expectedVersion,
        item.version,
        item.categoryId,
        item.reason,
        item.validFrom,
        item.validUntil,
        item.status,
        JSON.stringify(item),
        JSON.stringify(receipt),
        createdAt
      )
      .run()
  } catch (error) {
    const winner = await replay().catch((failure: unknown) => {
      if (failure instanceof CategoryMerchandisingError) throw failure
      return null
    })
    if (winner) return winner
    mapFailure(error)
  }
  await authorize(database, claims, options.now)
  return categoryMerchandisingReceiptSchema.parse(receipt)
}

/** ---- signals ---- */
export const CATEGORY_SIGNAL_LIMIT = 500
export interface CategorySignalRow extends CategoryProductSignals {
  name: string
  slug: string
}
/** One bounded statement for the whole category tree: no per-product queries. Pure reads over the
 * published catalogue; publication validity is applied again by the public listing itself. */
export async function loadCategorySignals(
  database: D1Database,
  input: {
    categoryId: string
    instant: string
    customerId: string | null
    campaignProductIds: readonly string[]
    campaignActive: boolean
  }
): Promise<{ products: CategorySignalRow[]; truncated: boolean }> {
  const at = input.instant.replace(SECONDS, 'Z')
  const since = new Date(Date.parse(at) - CATEGORY_MERCHANDISING_POPULARITY_DAYS * 86_400_000)
    .toISOString()
    .replace(SECONDS, 'Z')
  const gross = inlineEffectivePricingSql(effectiveGrossCentsExpression('v'), at)
  const source = inlineEffectivePricingSql(effectiveB2BSourceExpression('v', '?3'), at)
  const { results } = await database
    .prepare(
      `WITH RECURSIVE tree(id) AS (
         SELECT id FROM categories WHERE id=?1 AND status='published'
         UNION SELECT child.id FROM categories child JOIN tree parent ON child.parent_id=parent.id WHERE child.status='published'
       ), page AS (
         SELECT p.id, p.name, p.slug,
           row_number() OVER (ORDER BY p.featured DESC, lower(p.name), p.id) AS baselineRank
         FROM products p WHERE p.status='published' AND p.category_id IN (SELECT id FROM tree)
         ORDER BY baselineRank LIMIT ?4
       ), vp AS (
         SELECT v.id AS vid, v.product_id AS pid, v.cost_net_cents AS cost, v.backorder_allowed AS bo,
           t.rate_basis_points AS rate, ${gross} AS gross, ${source} AS source,
           COALESCE((SELECT SUM(${sellableExpression()}) FROM inventory_balances b WHERE b.variant_id=v.id),0) AS stock
         FROM variants v JOIN tax_classes t ON t.id=v.tax_class_id
         WHERE v.status='published' AND v.product_id IN (SELECT id FROM page)
       ), vm AS (
         SELECT pid, stock, bo, source,
           CASE WHEN cost IS NOT NULL AND gross*10000/(10000+rate)>0
             THEN (gross*10000/(10000+rate)-cost)*10000/(gross*10000/(10000+rate)) END AS margin
         FROM vp
       ), sales AS (
         SELECT v.product_id AS pid, SUM(ol.quantity) AS units FROM order_lines ol
         JOIN order_payment_states ps ON ps.order_id=ol.order_id AND ps.status='paid' AND ps.updated_at>=?2
         JOIN variants v ON v.id=ol.variant_id
         WHERE v.product_id IN (SELECT id FROM page) GROUP BY v.product_id
       )
       SELECT page.id AS productId, page.name AS name, page.slug AS slug, page.baselineRank AS baselineRank,
         COALESCE((SELECT SUM(stock) FROM vm WHERE vm.pid=page.id),0) AS sellableStock,
         COALESCE((SELECT MAX(bo) FROM vm WHERE vm.pid=page.id),0) AS backorder,
         (SELECT MIN(margin) FROM vm WHERE vm.pid=page.id) AS marginBps,
         COALESCE((SELECT units FROM sales WHERE sales.pid=page.id),0) AS units30d,
         EXISTS(SELECT 1 FROM vm WHERE vm.pid=page.id AND vm.source<>'public') AS contract
       FROM page ORDER BY page.baselineRank`
    )
    .bind(input.categoryId, since, input.customerId, CATEGORY_SIGNAL_LIMIT + 1)
    .all<{
      productId: string
      name: string
      slug: string
      baselineRank: number
      sellableStock: number
      backorder: number
      marginBps: number | null
      units30d: number
      contract: number
    }>()
  const flagged = new Set(input.campaignActive ? input.campaignProductIds : [])
  const products = results.slice(0, CATEGORY_SIGNAL_LIMIT).map((row): CategorySignalRow => ({
    productId: row.productId,
    name: row.name,
    slug: row.slug,
    baselineRank: row.baselineRank,
    sellableStock: row.sellableStock,
    backorderAllowed: row.backorder === 1,
    marginBps: row.marginBps,
    units30d: row.units30d,
    contract: row.contract === 1,
    campaign: flagged.has(row.productId)
  }))
  return { products, truncated: results.length > CATEGORY_SIGNAL_LIMIT }
}

async function campaignIsActive(database: D1Database, campaignId: string | null, at: string) {
  if (campaignId === null) return true
  const row = await database
    .prepare("SELECT 1 AS ok FROM commercial_campaigns WHERE id=?1 AND status='active' AND start_at<=?2 AND end_at>?2")
    .bind(campaignId, at)
    .first()
    .catch(() => null)
  return Boolean(row)
}

/** ---- administrative preview ---- */
const previewInputSchema = z
  .object({
    categoryId: catalogPolicyUuidSchema,
    ruleId: catalogPolicyUuidSchema.nullable(),
    companyId: z.string().min(1).max(100).nullable(),
    draft: z
      .object({
        weights: categoryMerchandisingWeightsSchema,
        guardrails: categoryMerchandisingGuardrailsSchema,
        campaign: categoryMerchandisingCampaignSchema
      })
      .strict()
      .nullable()
  })
  .strict()
  .refine((value) => (value.ruleId === null) !== (value.draft === null))

export async function previewCategoryMerchandising(
  database: D1Database,
  claims: VerifiedSessionClaims,
  rawInput: unknown,
  at?: string
) {
  const parsed = previewInputSchema.safeParse(rawInput)
  if (!parsed.success) fail('invalid_input')
  const input = parsed.data!
  const instantNow = now(at)
  await authorize(database, claims, at)
  const category = await database
    .prepare("SELECT 1 AS ok FROM categories WHERE id=?1 AND status='published'")
    .bind(input.categoryId)
    .first()
  if (!category) fail('category_unavailable')
  let content = input.draft
  let ruleRef: { id: string; version: number } | null = null
  if (input.ruleId) {
    const row = await database
      .prepare('SELECT snapshot FROM category_merchandising_current WHERE rule_id=?1 AND category_id=?2')
      .bind(input.ruleId, input.categoryId)
      .first<{ snapshot: string }>()
    if (!row) fail('not_found')
    const stored = snapshotSchema.parse(JSON.parse(row!.snapshot))
    content = { weights: stored.weights, guardrails: stored.guardrails, campaign: stored.campaign }
    ruleRef = { id: stored.id, version: stored.version }
  }
  let customerId: string | null = null
  if (input.companyId) {
    const company = await database
      .prepare("SELECT customer_id FROM companies WHERE id=?1 AND status='approved'")
      .bind(input.companyId)
      .first<{ customer_id: string }>()
    if (!company) fail('company_unavailable')
    customerId = company!.customer_id
  }
  const campaign = content!.campaign
  const loaded = await loadCategorySignals(database, {
    categoryId: input.categoryId,
    instant: instantNow,
    customerId,
    campaignProductIds: campaign.productIds,
    campaignActive: await campaignIsActive(database, campaign.campaignId, instantNow)
  })
  await authorize(database, claims, at)
  const ranking = rankCategoryProducts(content!, loaded.products)
  const byId = new Map(loaded.products.map((product) => [product.productId, product]))
  return {
    source: 'cloudflare' as const,
    rule: ruleRef,
    truncated: loaded.truncated,
    items: ranking.items.map((item) => {
      const signals = byId.get(item.productId)!
      return {
        ...item,
        name: signals.name,
        slug: signals.slug,
        sellableStock: signals.sellableStock,
        backorderAllowed: signals.backorderAllowed,
        marginBps: signals.marginBps,
        units30d: signals.units30d,
        contract: signals.contract,
        campaign: signals.campaign
      }
    })
  }
}

/** ---- storefront application ---- */
const SAFE_ID = /^[A-Za-z0-9._:-]{1,100}$/
export interface LiveCategoryOrder {
  ruleId: string
  version: number
  front: string[]
  back: string[]
}
/** The live rule of a published category, evaluated for the storefront. null when no rule applies, when
 * nothing would move, or when the feature's tables are not there yet: the default order is then untouched. */
export async function readLiveCategoryOrder(
  database: D1Database,
  categorySlug: string,
  options: { instant: string; customerId: string | null }
): Promise<LiveCategoryOrder | null> {
  const at = options.instant.replace(SECONDS, 'Z')
  let row: { snapshot: string } | null
  try {
    row = await database
      .prepare(
        `SELECT cur.snapshot AS snapshot FROM category_merchandising_current cur
         JOIN categories c ON c.id=cur.category_id AND c.status='published'
         WHERE c.slug=?1 AND cur.status='active' AND cur.valid_from<=?2 AND cur.valid_until>?2 LIMIT 1`
      )
      .bind(categorySlug, at)
      .first<{ snapshot: string }>()
  } catch (error) {
    if (error instanceof Error && /no such (table|view)/i.test(error.message)) return null
    throw error
  }
  if (!row) return null
  const rule = snapshotSchema.parse(JSON.parse(row.snapshot))
  const loaded = await loadCategorySignals(database, {
    categoryId: rule.categoryId,
    instant: at,
    customerId: options.customerId,
    campaignProductIds: rule.campaign.productIds,
    campaignActive:
      rule.campaign.productIds.length > 0 && (await campaignIsActive(database, rule.campaign.campaignId, at))
  })
  const ranking = rankCategoryProducts(rule, loaded.products)
  const front = ranking.boostedIds.filter((id) => SAFE_ID.test(id))
  const back = ranking.demotedIds.filter((id) => SAFE_ID.test(id))
  return front.length || back.length ? { ruleId: rule.id, version: rule.version, front, back } : null
}

/** ORDER BY prefix for the product listing. The ids come from our own database and are re-validated
 * against a strict whitelist, so no quote or separator can ever reach the SQL text. */
export function categoryOrderSqlPrefix(order: LiveCategoryOrder): string {
  const list = (ids: readonly string[]) => {
    if (!ids.every((id) => SAFE_ID.test(id))) throw new Error('unsafe_category_order_id')
    return `',${ids.join(',')},'`
  }
  const front = list(order.front),
    back = list(order.back),
    key = "',' || p.id || ','"
  return `CASE WHEN instr(${front}, ${key}) > 0 THEN instr(${front}, ${key})
    WHEN instr(${back}, ${key}) > 0 THEN 2000000 + instr(${back}, ${key})
    ELSE 1000000 END, `
}
