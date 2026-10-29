import { z } from 'zod'
import { checkAdministrativeEdgeLimit } from '../auth/edge-limit'
import { validateSessionCookieConfiguration, type SessionCookieConfiguration } from '../auth/session-cookie'
import {
  createD1FavoriteList,
  deleteD1FavoriteList,
  listD1CustomerFavorites,
  prepareD1FavoriteListForCart,
  removeD1CustomerFavorite,
  renameD1FavoriteList,
  saveD1CustomerFavorite,
  type FavoriteResult
} from './customer-favorites'

export interface CustomerFavoritesHttpDependencies {
  database: D1Database
  edgeLimiter: RateLimit
  configuration: () => (SessionCookieConfiguration & { origin: string; tokenPepper: string }) | null
}

const root = '/api/account/favorites'
const variantIdentifier = z.union([z.string().uuid(), z.number().int().positive().safe()])
const saveSchema = z
  .object({
    variantId: variantIdentifier,
    quantity: z.number().int().min(1).max(999).optional(),
    listId: z.string().uuid().optional()
  })
  .strict()
const nameSchema = z.object({ name: z.string().min(1).max(80) }).strict()

function json(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store', ...headers } })
}
function error(code: string, status: number, headers: Record<string, string> = {}) {
  return json({ error: { code } }, status, headers)
}
function mutationResult(result: FavoriteResult, status = 200): Response {
  if (result.ok) return json({ ok: true, id: result.id }, status)
  const statuses = {
    unauthenticated: 401,
    invalid_input: 400,
    not_found: 404,
    not_available: 422,
    already_exists: 409,
    limit_reached: 409
  }
  return error(result.code, statuses[result.code])
}
class BodyError extends Error {
  constructor(
    readonly status: number,
    readonly code: string
  ) {
    super(code)
  }
}
async function readJson(request: Request): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? ''))
    throw new BodyError(415, 'json_required')
  const declared = request.headers.get('content-length')
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > 4096))
    throw new BodyError(413, 'body_too_large')
  if (!request.body) throw new BodyError(400, 'invalid_body')
  const reader = request.body.getReader()
  const bytes = new Uint8Array(4096)
  let offset = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      if (offset + chunk.value.byteLength > bytes.length) {
        await reader.cancel()
        throw new BodyError(413, 'body_too_large')
      }
      bytes.set(chunk.value, offset)
      offset += chunk.value.byteLength
    }
  } finally {
    reader.releaseLock()
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset))) as unknown
  } catch {
    throw new BodyError(400, 'invalid_body')
  }
}

/** UUIDs are durable catalog identifiers. Numeric storefront IDs resolve only
 * through the unique D1 mapping, never via coercion, email, SKU or client hints. */
async function resolveVariant(database: D1Database, identifier: string | number): Promise<string | null> {
  const column = typeof identifier === 'number' ? 'legacy_id' : 'id'
  const row = await database
    .prepare(`SELECT id FROM variants WHERE ${column} = ?`)
    .bind(identifier)
    .first<{ id: string }>()
  return row?.id ?? null
}

/** Owns the entire favorites namespace so unsupported subroutes cannot fall
 * through to a legacy Node/PostgreSQL handler. All mutations are origin guarded. */
export async function handleCustomerFavoritesHttp(
  request: Request,
  deps: CustomerFavoritesHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  const path = url.pathname
  if (path !== root && !path.startsWith(`${root}/`)) return null
  const lists = path === `${root}/lists`
  const listItem = /^\/api\/account\/favorites\/lists\/([^/]+)$/.exec(path)
  const preparation = /^\/api\/account\/favorites\/lists\/([^/]+)\/cart$/.exec(path)
  const favoriteItem = /^\/api\/account\/favorites\/([^/]+)$/.exec(path)
  if (path !== root && !lists && !listItem && !preparation && !favoriteItem) return error('not_found', 404)
  const allowed = path === root ? 'GET, POST' : lists || preparation ? 'POST' : listItem ? 'PUT, DELETE' : 'DELETE'
  if (!allowed.split(', ').includes(request.method)) return error('method_not_allowed', 405, { allow: allowed })
  try {
    const configuration = deps.configuration()
    if (!configuration) return error('authentication_unavailable', 503)
    validateSessionCookieConfiguration(configuration)
    const origin = new URL(configuration.origin)
    if (origin.protocol !== 'https:' || origin.origin !== configuration.origin)
      throw new Error('invalid_favorites_origin')
    if (
      ((request.method !== 'GET' || request.headers.has('origin')) &&
        request.headers.get('origin') !== configuration.origin) ||
      request.headers.get('sec-fetch-site') === 'cross-site'
    )
      return error('csrf_rejected', 403)
    const edge = await checkAdministrativeEdgeLimit(
      request,
      deps.edgeLimiter,
      configuration.tokenPepper,
      'authentication'
    )
    if (edge === 'unavailable') return error('abuse_control_unavailable', 503)
    if (edge === 'limited') return error('rate_limited', 429, { 'retry-after': '60' })
    // Authentication precedes variant resolution to avoid an anonymous catalog
    // existence oracle. The service checks again in every SQL mutation/read.
    const account = await listD1CustomerFavorites(deps.database, request, configuration)
    if (!account) return error('unauthenticated', 401)
    const queryKeys = [...url.searchParams.keys()]
    if (queryKeys.some((key) => key !== 'listId') || (queryKeys.length && (!favoriteItem || lists)))
      return error('invalid_input', 400)
    if (path === root && request.method === 'GET') return json(account)
    if (listItem || preparation) {
      const id = (listItem ?? preparation)![1]!
      if (!z.string().uuid().safeParse(id).success) return error('invalid_input', 400)
      if (preparation) {
        if (request.body) return error('invalid_input', 400)
        const result = await prepareD1FavoriteListForCart(deps.database, request, configuration, id)
        return result.outcome === 'ready'
          ? json(result)
          : error(
              result.outcome,
              result.outcome === 'unauthenticated' ? 401 : result.outcome === 'not_found' ? 404 : 400
            )
      }
      if (request.method === 'DELETE')
        return mutationResult(await deleteD1FavoriteList(deps.database, request, configuration, id))
      const parsed = nameSchema.safeParse(await readJson(request))
      if (!parsed.success) return error('invalid_body', 400)
      return mutationResult(await renameD1FavoriteList(deps.database, request, configuration, id, parsed.data.name))
    }
    if (lists) {
      const parsed = nameSchema.safeParse(await readJson(request))
      if (!parsed.success) return error('invalid_body', 400)
      return mutationResult(await createD1FavoriteList(deps.database, request, configuration, parsed.data.name), 201)
    }
    if (favoriteItem) {
      const raw = favoriteItem[1]!
      const identifier = /^\d+$/.test(raw) ? Number(raw) : raw
      if (!variantIdentifier.safeParse(identifier).success) return error('invalid_input', 400)
      const values = url.searchParams.getAll('listId')
      if (values.length > 1 || (values.length === 1 && !z.string().uuid().safeParse(values[0]).success))
        return error('invalid_input', 400)
      const variantId = await resolveVariant(deps.database, identifier)
      if (!variantId) return error('not_found', 404)
      return mutationResult(await removeD1CustomerFavorite(deps.database, request, configuration, variantId, values[0]))
    }
    const parsed = saveSchema.safeParse(await readJson(request))
    if (!parsed.success) return error('invalid_body', 400)
    const variantId = await resolveVariant(deps.database, parsed.data.variantId)
    if (!variantId) return error('not_available', 422)
    const result = await saveD1CustomerFavorite(deps.database, request, configuration, { ...parsed.data, variantId })
    return result.ok
      ? json({ listId: result.id, variantId, quantity: parsed.data.quantity ?? 1 }, 201)
      : mutationResult(result)
  } catch (caught) {
    if (caught instanceof BodyError) return error(caught.code, caught.status)
    return error('favorites_unavailable', 503)
  }
}
