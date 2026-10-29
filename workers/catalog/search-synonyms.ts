import {
  searchSynonymPreviewInputSchema,
  searchSynonymCommandInputSchema,
  searchSynonymReceiptSchema,
  searchSynonymItemSchema,
  searchSynonymPreviewSchema,
  normalizeSynonymTerm,
  type SearchSynonymItem,
  type SearchSynonymPreview,
  type SearchSynonymReceipt
} from '../../shared/search-synonyms'
import { authorizeD1Session, type VerifiedSessionClaims } from './authorization'
import { publicSearchTermsSql, searchPublishedProducts, synonymTermData } from './search'

export class SearchSynonymError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}
function fail(code: string): never {
  throw new SearchSynonymError(code)
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
async function hash(value: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')
}
function mapFailure(error: unknown): never {
  if (error instanceof SearchSynonymError) throw error
  const message = error instanceof Error ? error.message : ''
  if (message.includes('synonym_authority_changed')) fail('forbidden')
  if (message.includes('synonym_preview_stale')) fail('preview_stale')
  if (message.includes('synonym_version_conflict')) fail('version_conflict')
  throw error
}
const keyValid = (key: string) => /^[A-Za-z0-9._:-]{1,200}$/.test(key)
export async function readSearchSynonymReceipt(
  database: D1Database,
  claims: VerifiedSessionClaims,
  key: string,
  instant?: string
): Promise<SearchSynonymReceipt | null> {
  if (!keyValid(key)) fail('invalid_input')
  await authorize(database, claims, instant)
  const row = await database
    .prepare('SELECT response FROM search_synonym_commands WHERE actor_id=? AND idempotency_key=?')
    .bind(claims.identityId, key)
    .first<{ response: string }>()
  await authorize(database, claims, instant)
  return row ? searchSynonymReceiptSchema.parse(JSON.parse(row.response)) : null
}
export async function readSearchSynonym(
  database: D1Database,
  claims: VerifiedSessionClaims,
  id: string,
  instant?: string
): Promise<SearchSynonymItem | null> {
  await authorize(database, claims, instant)
  const row = await database
    .prepare('SELECT snapshot FROM search_synonyms_current WHERE synonym_id=?')
    .bind(id)
    .first<{ snapshot: string }>()
  await authorize(database, claims, instant)
  return row ? searchSynonymItemSchema.parse(JSON.parse(row.snapshot)) : null
}
export async function listSearchSynonyms(
  database: D1Database,
  claims: VerifiedSessionClaims,
  query: { page?: number; perPage?: number; q?: string } = {},
  instant?: string
) {
  const page = query.page ?? 1,
    perPage = query.perPage ?? 25,
    q = query.q ?? ''
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > 1000000 ||
    !Number.isSafeInteger(perPage) ||
    perPage < 1 ||
    perPage > 100 ||
    q.length > 160 ||
    /[\p{Cc}\p{Cf}]/u.test(q)
  )
    fail('invalid_input')
  await authorize(database, claims, instant)
  const pattern = `%${normalizeSynonymTerm(q).replace(/[\\%_]/g, '\\$&')}%`,
    where = "action<>'retire' AND source_normalized LIKE ? ESCAPE '\\'"
  const results = await database.batch([
    database.prepare(`SELECT count(*) total FROM search_synonyms_current WHERE ${where}`).bind(pattern),
    database
      .prepare(
        `SELECT snapshot FROM search_synonyms_current WHERE ${where} ORDER BY source_normalized,synonym_id LIMIT ? OFFSET ?`
      )
      .bind(pattern, perPage, (page - 1) * perPage)
  ])
  if (results.some((result) => !result.success)) throw new Error('synonym_read_failed')
  await authorize(database, claims, instant)
  return {
    source: 'cloudflare' as const,
    items: (results[1]!.results as Array<{ snapshot: string }>).map((row) =>
      searchSynonymItemSchema.parse(JSON.parse(row.snapshot))
    ),
    total: (results[0]!.results[0] as { total: number }).total,
    page,
    perPage
  }
}
export async function createSearchSynonymPreview(
  database: D1Database,
  claims: VerifiedSessionClaims,
  input: unknown
): Promise<SearchSynonymPreview> {
  const parsed = searchSynonymPreviewInputSchema.safeParse(input)
  if (!parsed.success) fail('invalid_input')
  await authorize(database, claims)
  const { draft, query } = parsed.data,
    source = normalizeSynonymTerm(draft.sourceTerm)
  const baseline = await database
    .prepare('SELECT count(*) revision FROM search_synonym_commands')
    .first<{ revision: number }>()
  const existing = draft.id ? await readSearchSynonym(database, claims, draft.id) : null
  if (draft.id && (!existing || existing.retired || existing.version !== draft.expectedVersion))
    fail('version_conflict')
  const duplicate = await database
    .prepare(
      "SELECT synonym_id FROM search_synonyms_current WHERE source_normalized=? AND action<>'retire' AND synonym_id<>?"
    )
    .bind(source, draft.id ?? '')
    .first()
  if (duplicate) fail('source_conflict')
  const termsSql = publicSearchTermsSql(query)
  const beforeTerms = (
    await database
      .prepare(`SELECT term FROM (${termsSql.sql})`)
      .bind(...termsSql.parameters)
      .all<{ term: string }>()
  ).results.map((row) => row.term)
  const original = normalizeSynonymTerm(query)
  // Remove the edited mapping, then add only the proposed direct mapping.
  let afterTerms = beforeTerms
  if (existing && normalizeSynonymTerm(existing.sourceTerm) === original) afterTerms = [original]
  if (source === original && draft.active && draft.action === 'save')
    afterTerms = [original, ...draft.replacements.map(normalizeSynonymTerm)]
  const before = await searchPublishedProducts(database, query, undefined, beforeTerms),
    after = await searchPublishedProducts(database, query, undefined, afterTerms)
  const createdAt = now(),
    expiresAt = new Date(Date.parse(createdAt) + 15 * 60 * 1000).toISOString().replace('.000Z', 'Z'),
    previewId = crypto.randomUUID(),
    targetId = draft.id ?? crypto.randomUUID()
  const content = {
    source: 'cloudflare' as const,
    previewId,
    expiresAt,
    draft,
    query,
    before: before.items.map(({ slug, name }) => ({ slug, name })),
    after: after.items.map(({ slug, name }) => ({ slug, name })),
    beforeTerms,
    afterTerms
  }
  const previewHash = await hash(JSON.stringify(content)),
    response = { ...content, previewHash }
  await authorize(database, claims)
  try {
    await database
      .prepare(
        `INSERT INTO search_synonym_previews(id,actor_id,session_id,session_version,target_id,expected_version,base_revision,source_normalized,draft,term_data,response,hash,created_at,expires_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .bind(
        previewId,
        claims.identityId,
        claims.sessionId,
        claims.sessionVersion,
        targetId,
        draft.expectedVersion,
        baseline!.revision,
        source,
        JSON.stringify(draft),
        JSON.stringify(draft.replacements.map(synonymTermData)),
        JSON.stringify(response),
        previewHash,
        now(),
        expiresAt
      )
      .run()
  } catch (error) {
    mapFailure(error)
  }
  return searchSynonymPreviewSchema.parse(response)
}
export async function executeSearchSynonymCommand(
  database: D1Database,
  claims: VerifiedSessionClaims,
  input: unknown,
  options: { idempotencyKey: string; now?: string; target?: string | null; action?: 'save' | 'retire' }
): Promise<SearchSynonymReceipt> {
  const parsed = searchSynonymCommandInputSchema.safeParse(input)
  if (!parsed.success || !keyValid(options.idempotencyKey)) fail('invalid_input')
  await authorize(database, claims, options.now)
  const prior = await readSearchSynonymReceipt(database, claims, options.idempotencyKey, options.now)
  if (prior) {
    if (
      (options.target !== undefined &&
        (options.target === null ? prior.item.version !== 1 : prior.item.id !== options.target)) ||
      (options.action && prior.action !== options.action)
    )
      fail('invalid_input')
    const row = await database
      .prepare('SELECT preview_hash FROM search_synonym_commands WHERE actor_id=? AND idempotency_key=?')
      .bind(claims.identityId, options.idempotencyKey)
      .first<{ preview_hash: string }>()
    if (prior.previewId !== parsed.data.previewId || row?.preview_hash !== parsed.data.previewHash)
      fail('idempotency_conflict')
    await authorize(database, claims, options.now)
    return prior
  }
  const p = await database
    .prepare('SELECT * FROM search_synonym_previews WHERE id=? AND actor_id=?')
    .bind(parsed.data.previewId, claims.identityId)
    .first<{
      id: string
      hash: string
      expires_at: string
      response: string
      draft: string
      target_id: string
      expected_version: number
      source_normalized: string
      term_data: string
    }>()
  if (!p || p.hash !== parsed.data.previewHash) fail('preview_invalid')
  if (p.expires_at <= now(options.now)) fail('preview_expired')
  const preview = searchSynonymPreviewSchema.parse(JSON.parse(p.response)),
    { previewHash, ...content } = preview
  if ((await hash(JSON.stringify(content))) !== previewHash) fail('preview_invalid')
  const draft = preview.draft,
    createdAt = now(options.now),
    commandId = crypto.randomUUID()
  if (
    (options.target !== undefined && options.target !== draft.id) ||
    (options.action && options.action !== draft.action)
  )
    fail('invalid_input')
  const item: SearchSynonymItem = {
    id: p.target_id,
    sourceTerm: draft.sourceTerm,
    replacements: draft.replacements,
    active: draft.action === 'retire' ? false : draft.active,
    version: p.expected_version + 1,
    updatedAt: createdAt,
    retired: draft.action === 'retire'
  }
  const receipt: SearchSynonymReceipt = { source: 'cloudflare', commandId, previewId: p.id, action: draft.action, item }
  await authorize(database, claims, options.now)
  try {
    await database
      .prepare(
        `INSERT INTO search_synonym_commands(id,actor_id,session_id,session_version,idempotency_key,preview_id,preview_hash,synonym_id,expected_version,version,source_normalized,action,active,snapshot,term_data,response,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .bind(
        commandId,
        claims.identityId,
        claims.sessionId,
        claims.sessionVersion,
        options.idempotencyKey,
        p.id,
        p.hash,
        p.target_id,
        p.expected_version,
        item.version,
        p.source_normalized,
        draft.action,
        Number(draft.active),
        JSON.stringify(item),
        p.term_data,
        JSON.stringify(receipt),
        createdAt
      )
      .run()
  } catch (error) {
    const winner = await readSearchSynonymReceipt(database, claims, options.idempotencyKey, options.now)
    if (winner) {
      const priorRow = await database
        .prepare('SELECT preview_hash FROM search_synonym_commands WHERE actor_id=? AND idempotency_key=?')
        .bind(claims.identityId, options.idempotencyKey)
        .first<{ preview_hash: string }>()
      if (winner.previewId !== p.id || priorRow?.preview_hash !== p.hash) fail('idempotency_conflict')
      await authorize(database, claims, options.now)
      return winner
    }
    mapFailure(error)
  }
  await authorize(database, claims, options.now)
  return searchSynonymReceiptSchema.parse(receipt)
}
