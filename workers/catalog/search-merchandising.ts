import { z } from 'zod'
import { catalogPolicyOwnJson, catalogPolicyUuidSchema } from '../../shared/catalog-publication-policy'
import { normalizeSynonymTerm } from '../../shared/search-synonyms'
import { authorizeD1Session, type VerifiedSessionClaims } from './authorization'
import { canonicalJson, sha256Hex } from './inventory'
import { SEARCH_MERCHANDISING_MAX_WEIGHT } from './search'

/** SEA-013. Boost/bury of one product and redirects to an internal store path, per
 * normalized search term. Same architecture as the synonyms: append-only revisions
 * (the audit trail and the durable receipt), CAS by version, command idempotency by
 * key + payload hash and a fresh `catalog.write` + MFA check around every read/write.
 * Public search only ever reads live rules, see `search.ts`. */
export const SEARCH_MERCHANDISING_MAX_VALIDITY_DAYS = 180
const DAY_MS = 24 * 60 * 60 * 1000

export class SearchMerchandisingError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}
function fail(code: string): never {
  throw new SearchMerchandisingError(code)
}
const now = (value?: string) => {
  if (
    value !== undefined &&
    (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString().replace(/\.\d{3}Z$/, 'Z') !== value)
  )
    fail('invalid_input')
  return value ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}
async function authorize(database: D1Database, claims: VerifiedSessionClaims, instant?: string) {
  const result = await authorizeD1Session(database, claims, 'catalog.write', { requireMfa: true, now: now(instant) })
  if (!result.allowed) fail(result.code)
}
const keyValid = (key: string) => /^[A-Za-z0-9._:-]{1,200}$/.test(key)

/** Only relative store paths, never a URL, scheme, host, dot segment, encoding or fragment.
 * Mirrors the CHECK in migration 0091, which is the last line of defense. */
export function isAllowedSearchRedirectPath(path: string) {
  if (path.length < 2 || path.length > 300 || !/^[A-Za-z0-9._~/?=&,+-]+$/.test(path)) return false
  if (path.includes('//') || path.includes('..')) return false
  const parts = path.split('?')
  if (parts.length > 2) return false
  const [pathname = '', query] = parts
  if (query !== undefined && query.length === 0) return false
  if (/(^|\/)\.(\/|$)/.test(pathname)) return false
  if (pathname.startsWith('/producto/'))
    return query === undefined && /^\/producto\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(pathname)
  return /^\/(?:catalogo|contenido|recursos)(?:\/|$)/.test(pathname)
}

const own = (value: unknown) => {
  try {
    return catalogPolicyOwnJson(value)
  } catch {
    return undefined
  }
}
const noControls = (value: string) => !/[\p{Cc}\p{Cf}]/u.test(value)
const term = z
  .string()
  .min(2)
  .max(160)
  .refine(noControls)
  .transform((value) => value.trim().replace(/\s+/gu, ' '))
  .pipe(z.string().min(2).max(160))
  .refine((value) => /[\p{L}\p{N}]/u.test(normalizeSynonymTerm(value)) && normalizeSynonymTerm(value).length >= 2)
const reason = z.string().trim().min(3).max(500).refine(noControls)
const instant = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  .refine((value) => {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) && new Date(parsed).toISOString().replace(/\.\d{3}Z$/, 'Z') === value
  })
const version = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const kind = z.enum(['boost', 'bury', 'redirect'])

const saveSchema = z
  .object({
    action: z.literal('save'),
    id: catalogPolicyUuidSchema.nullable(),
    expectedVersion: version,
    term,
    kind,
    productId: catalogPolicyUuidSchema.nullable(),
    weight: z.number().int().min(1).max(SEARCH_MERCHANDISING_MAX_WEIGHT).nullable(),
    redirectPath: z.string().max(300).nullable(),
    reason,
    validFrom: instant,
    validUntil: instant
  })
  .strict()
  .superRefine((value, context) => {
    const issue = (message: string) => context.addIssue({ code: 'custom', message })
    if ((value.id === null) !== (value.expectedVersion === 0)) issue('La identidad y versión no corresponden.')
    const span = Date.parse(value.validUntil) - Date.parse(value.validFrom)
    if (!(span > 0 && span <= SEARCH_MERCHANDISING_MAX_VALIDITY_DAYS * DAY_MS)) issue('La vigencia no es válida.')
    if (value.kind === 'redirect') {
      if (value.productId !== null || value.weight !== null) issue('Una redirección no lleva producto ni peso.')
      if (value.redirectPath === null || !isAllowedSearchRedirectPath(value.redirectPath))
        issue('La ruta de redirección debe ser una ruta interna permitida.')
    } else if (value.productId === null || value.weight === null || value.redirectPath !== null)
      issue('Boost y bury requieren producto y peso, sin ruta.')
  })
const retireSchema = z
  .object({
    action: z.literal('retire'),
    id: catalogPolicyUuidSchema,
    expectedVersion: version.refine((value) => value >= 1),
    reason
  })
  .strict()
export const searchMerchandisingInputSchema = z.preprocess(own, z.union([saveSchema, retireSchema]))
export type SearchMerchandisingInput = z.infer<typeof saveSchema> | z.infer<typeof retireSchema>

const snapshotSchema = z
  .object({
    id: catalogPolicyUuidSchema,
    term,
    termNormalized: z.string().min(2).max(160),
    kind,
    productId: catalogPolicyUuidSchema.nullable(),
    weight: z.number().int().min(1).max(SEARCH_MERCHANDISING_MAX_WEIGHT).nullable(),
    redirectPath: z.string().max(300).nullable(),
    reason,
    validFrom: instant,
    validUntil: instant,
    status: z.enum(['active', 'retired']),
    authorId: catalogPolicyUuidSchema,
    version: version.refine((value) => value > 0),
    updatedAt: instant
  })
  .strict()
export type SearchMerchandisingSnapshot = z.infer<typeof snapshotSchema>
const stateSchema = z.enum(['live', 'scheduled', 'expired', 'retired'])
const viewSchema = snapshotSchema.extend({ state: stateSchema }).strict()
export type SearchMerchandisingItem = z.infer<typeof viewSchema>
export const searchMerchandisingReceiptSchema = z
  .object({
    source: z.literal('cloudflare'),
    commandId: catalogPolicyUuidSchema,
    action: z.enum(['save', 'retire']),
    item: snapshotSchema
  })
  .strict()
export type SearchMerchandisingReceipt = z.infer<typeof searchMerchandisingReceiptSchema>

const stateOf = (item: SearchMerchandisingSnapshot, at: string): SearchMerchandisingItem['state'] =>
  item.status === 'retired' ? 'retired' : at < item.validFrom ? 'scheduled' : at >= item.validUntil ? 'expired' : 'live'
const view = (row: { snapshot: string }, at: string): SearchMerchandisingItem => {
  const item = snapshotSchema.parse(JSON.parse(row.snapshot))
  return viewSchema.parse({ ...item, state: stateOf(item, at) })
}

function mapFailure(error: unknown): never {
  if (error instanceof SearchMerchandisingError) throw error
  const message = error instanceof Error ? error.message : ''
  const known: Array<[string, string]> = [
    ['merchandising_authority_changed', 'forbidden'],
    ['merchandising_version_conflict', 'version_conflict'],
    ['search_merchandising_commands.rule_id', 'version_conflict'],
    ['merchandising_rule_conflict', 'rule_conflict'],
    ['merchandising_rule_limit', 'rule_limit'],
    ['merchandising_expiry_invalid', 'expiry_invalid'],
    ['merchandising_product_unavailable', 'product_unavailable'],
    ['merchandising_redirect_target_unavailable', 'redirect_target_unavailable'],
    ['merchandising_retire_content', 'version_conflict']
  ]
  for (const [fragment, code] of known) if (message.includes(fragment)) fail(code)
  throw error
}

export async function readSearchMerchandisingReceipt(
  database: D1Database,
  claims: VerifiedSessionClaims,
  key: string,
  at?: string
): Promise<SearchMerchandisingReceipt | null> {
  if (!keyValid(key)) fail('invalid_input')
  await authorize(database, claims, at)
  const row = await database
    .prepare('SELECT response FROM search_merchandising_commands WHERE actor_id=? AND idempotency_key=?')
    .bind(claims.identityId, key)
    .first<{ response: string }>()
  await authorize(database, claims, at)
  return row ? searchMerchandisingReceiptSchema.parse(JSON.parse(row.response)) : null
}
export async function readSearchMerchandisingRule(
  database: D1Database,
  claims: VerifiedSessionClaims,
  id: string,
  at?: string
): Promise<SearchMerchandisingItem | null> {
  const instantNow = now(at)
  await authorize(database, claims, at)
  const row = await database
    .prepare('SELECT snapshot FROM search_merchandising_current WHERE rule_id=?')
    .bind(id)
    .first<{ snapshot: string }>()
  await authorize(database, claims, at)
  return row ? view(row, instantNow) : null
}
export async function readSearchMerchandisingHistory(
  database: D1Database,
  claims: VerifiedSessionClaims,
  id: string,
  at?: string
) {
  const instantNow = now(at)
  await authorize(database, claims, at)
  const rows = await database
    .prepare('SELECT snapshot FROM search_merchandising_commands WHERE rule_id=? ORDER BY version')
    .bind(id)
    .all<{ snapshot: string }>()
  await authorize(database, claims, at)
  if (!rows.results.length) return null
  return { source: 'cloudflare' as const, items: rows.results.map((row) => view(row, instantNow)) }
}
export async function listSearchMerchandisingRules(
  database: D1Database,
  claims: VerifiedSessionClaims,
  query: { page?: number; perPage?: number; q?: string; status?: 'open' | 'retired' | 'all' } = {},
  at?: string
) {
  const page = query.page ?? 1,
    perPage = query.perPage ?? 25,
    q = query.q ?? '',
    status = query.status ?? 'open'
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > 1000000 ||
    !Number.isSafeInteger(perPage) ||
    perPage < 1 ||
    perPage > 100 ||
    q.length > 160 ||
    !noControls(q) ||
    !['open', 'retired', 'all'].includes(status)
  )
    fail('invalid_input')
  const instantNow = now(at)
  await authorize(database, claims, at)
  const pattern = `%${normalizeSynonymTerm(q).replace(/[\\%_]/g, '\\$&')}%`,
    statusSql = status === 'open' ? "status<>'retired'" : status === 'retired' ? "status='retired'" : '1=1',
    where = `${statusSql} AND term_normalized LIKE ? ESCAPE '\\'`
  const results = await database.batch([
    database.prepare(`SELECT count(*) total FROM search_merchandising_current WHERE ${where}`).bind(pattern),
    database
      .prepare(
        `SELECT snapshot FROM search_merchandising_current WHERE ${where} ORDER BY term_normalized,rule_id LIMIT ? OFFSET ?`
      )
      .bind(pattern, perPage, (page - 1) * perPage)
  ])
  if (results.some((result) => !result.success)) throw new Error('merchandising_read_failed')
  await authorize(database, claims, at)
  return {
    source: 'cloudflare' as const,
    items: (results[1]!.results as Array<{ snapshot: string }>).map((row) => view(row, instantNow)),
    total: (results[0]!.results[0] as { total: number }).total,
    page,
    perPage
  }
}

export async function executeSearchMerchandisingCommand(
  database: D1Database,
  claims: VerifiedSessionClaims,
  input: unknown,
  options: { idempotencyKey: string; now?: string; target?: string | null; action?: 'save' | 'retire' }
): Promise<SearchMerchandisingReceipt> {
  const parsed = searchMerchandisingInputSchema.safeParse(input)
  if (!parsed.success || !keyValid(options.idempotencyKey)) fail('invalid_input')
  const data = parsed.data
  if (
    (options.target !== undefined && options.target !== data.id) ||
    (options.action !== undefined && options.action !== data.action)
  )
    fail('invalid_input')
  await authorize(database, claims, options.now)
  const payloadHash = await sha256Hex(canonicalJson(data))
  const replay = async () => {
    const row = await database
      .prepare('SELECT payload_hash,response FROM search_merchandising_commands WHERE actor_id=? AND idempotency_key=?')
      .bind(claims.identityId, options.idempotencyKey)
      .first<{ payload_hash: string; response: string }>()
    if (!row) return null
    if (row.payload_hash !== payloadHash) fail('idempotency_conflict')
    await authorize(database, claims, options.now)
    return searchMerchandisingReceiptSchema.parse(JSON.parse(row.response))
  }
  const prior = await replay()
  if (prior) return prior

  const createdAt = now(options.now),
    commandId = crypto.randomUUID()
  let existing: SearchMerchandisingSnapshot | null = null
  if (data.id) {
    const row = await database
      .prepare('SELECT snapshot FROM search_merchandising_current WHERE rule_id=?')
      .bind(data.id)
      .first<{ snapshot: string }>()
    existing = row ? snapshotSchema.parse(JSON.parse(row.snapshot)) : null
    if (!existing || existing.status === 'retired' || existing.version !== data.expectedVersion)
      fail('version_conflict')
  }
  const content =
    data.action === 'retire'
      ? { ...existing!, reason: data.reason, status: 'retired' as const }
      : {
          id: data.id ?? crypto.randomUUID(),
          term: data.term,
          termNormalized: normalizeSynonymTerm(data.term),
          kind: data.kind,
          productId: data.productId,
          weight: data.weight,
          redirectPath: data.redirectPath,
          reason: data.reason,
          validFrom: data.validFrom,
          validUntil: data.validUntil,
          status: 'active' as const
        }
  const item: SearchMerchandisingSnapshot = snapshotSchema.parse({
    id: content.id,
    term: content.term,
    termNormalized: content.termNormalized,
    kind: content.kind,
    productId: content.productId,
    weight: content.weight,
    redirectPath: content.redirectPath,
    reason: content.reason,
    validFrom: content.validFrom,
    validUntil: content.validUntil,
    status: content.status,
    authorId: claims.identityId,
    version: data.expectedVersion + 1,
    updatedAt: createdAt
  })
  const receipt: SearchMerchandisingReceipt = { source: 'cloudflare', commandId, action: data.action, item }
  await authorize(database, claims, options.now)
  try {
    await database
      .prepare(
        `INSERT INTO search_merchandising_commands(id,actor_id,session_id,session_version,idempotency_key,payload_hash,rule_id,expected_version,version,term_normalized,kind,product_id,weight,redirect_path,reason,valid_from,valid_until,status,snapshot,response,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
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
        item.termNormalized,
        item.kind,
        item.productId,
        item.weight,
        item.redirectPath,
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
      if (failure instanceof SearchMerchandisingError) throw failure
      return null
    })
    if (winner) return winner
    mapFailure(error)
  }
  await authorize(database, claims, options.now)
  return searchMerchandisingReceiptSchema.parse(receipt)
}
