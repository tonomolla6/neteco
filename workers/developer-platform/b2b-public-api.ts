import { z } from 'zod'
import { b2bPublicOpenApi } from './b2b-public-contract'

type Dependencies = { database: D1Database; now?: string }
type Key = { id: string; environment: 'live' | 'sandbox'; scopes: string; quota_daily: number; version: number }
type Entry = { id: string; reference: string; version: number; created_at: string; payload_hash: string }
const inputSchema = z.object({ reference: z.string().trim().min(1).max(100) }).strict()
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(value, { status, headers: { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', ...headers } })
const error = (code: string, status: number, headers: Record<string, string> = {}) => json({ error: { code } }, status, headers)
async function hash(value: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
export function ownsB2bPublicApiNamespace(pathname: string) {
  for (let i = 0; i < 4; i++) {
    if (/^\/api\/b2b(?:[/\\%]|$)/i.test(pathname)) return true
    try { const next = decodeURIComponent(pathname); if (next === pathname) break; pathname = next } catch { break }
  }
  return false
}
async function boundedJson(request: Request) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? '')) return null
  if (!request.body) return null
  const reader = request.body.getReader()
  const bytes = new Uint8Array(4096)
  let size = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      if (size + part.value.length > bytes.length) { await reader.cancel(); return null }
      bytes.set(part.value, size)
      size += part.value.length
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size))) as unknown
  } catch { return null } finally { reader.releaseLock() }
}
export async function handleB2bPublicApi(request: Request, deps: Dependencies): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsB2bPublicApiNamespace(url.pathname)) return null
  if (url.pathname === '/api/b2b/v1/openapi.json' && !url.search) return request.method === 'GET' ? json(b2bPublicOpenApi) : error('method_not_allowed', 405, { allow: 'GET' })
  const sandboxCatalog = url.pathname === '/api/b2b/v1/sandbox/catalog'
  if ((url.pathname !== '/api/b2b/v1/requests' && !sandboxCatalog) || url.search) return error('not_found', 404)
  if (!(sandboxCatalog ? ['GET'] : ['GET', 'POST']).includes(request.method)) return error('method_not_allowed', 405, { allow: sandboxCatalog ? 'GET' : 'GET, POST' })
  const instant = deps.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  if (!Number.isFinite(Date.parse(instant)) || new Date(instant).toISOString().replace(/\.\d{3}Z$/, 'Z') !== instant)
    return error('service_unavailable', 503)
  const bearer = /^Bearer ((?:sbx_|live_)[0-9a-f]{64})$/.exec(request.headers.get('authorization') ?? '')
  if (!bearer) return error('unauthenticated', 401)
  try {
    const keyHash = await hash(bearer[1]!)
    const findKey = () => deps.database.prepare(`SELECT id,environment,scopes,quota_daily,version FROM b2b_public_keys WHERE key_hash=? AND status='active'`).bind(keyHash).first<Key>()
    const key = await findKey()
    if (!key || !bearer[1]!.startsWith(key.environment === 'sandbox' ? 'sbx_' : 'live_')) return error('unauthenticated', 401)
    if (sandboxCatalog && key.environment !== 'sandbox') return error('not_found', 404)
    const required = request.method === 'GET' ? 'requests.read' : 'requests.write'
    if (!key.scopes.split(' ').includes(required)) return error('forbidden', 403)
    const day = instant.slice(0, 10)
    const quota = await deps.database.prepare(`INSERT INTO b2b_public_quota(key_id,day,used)
      SELECT id,?2,1 FROM b2b_public_keys WHERE id=?1 AND status='active' AND version=?3
      ON CONFLICT(key_id,day) DO UPDATE SET used=used+1 WHERE used < ?4 RETURNING used`).bind(key.id, day, key.version, key.quota_daily).first<{ used: number }>()
    if (!quota) return error('quota_exceeded', 429)
    const generation = key.environment === 'sandbox' ? day : 'live'
    let result: Response
    if (sandboxCatalog) {
      result = json({ items: [{ id: 'synthetic-1', name: 'Producto de prueba', priceCents: 1200 }] })
    } else if (request.method === 'GET') {
      const rows = await deps.database.prepare(`SELECT id,reference,version,created_at FROM b2b_public_requests WHERE key_id=? AND generation=? ORDER BY created_at,id LIMIT 100`).bind(key.id, generation).all<Omit<Entry, 'payload_hash'>>()
      result = json({ items: rows.results.map((row) => ({ id: row.id, reference: row.reference, version: row.version, createdAt: row.created_at })) })
    } else {
      const command = request.headers.get('idempotency-key') ?? ''
      if (!/^[A-Za-z0-9._:-]{1,128}$/.test(command)) return error('invalid_idempotency_key', 400)
      const parsed = inputSchema.safeParse(await boundedJson(request))
      if (!parsed.success) return error('invalid_input', 422)
      const digest = await hash(JSON.stringify(parsed.data))
      const created = await deps.database.prepare(`INSERT INTO b2b_public_requests(id,key_id,generation,command_id,payload_hash,reference,version,created_at)
       SELECT ?1,id,?2,?3,?4,?5,1,?6 FROM b2b_public_keys WHERE id=?7 AND status='active' AND version=?8 AND (' '||scopes||' ') LIKE '% requests.write %'
       ON CONFLICT(key_id,generation,command_id) DO NOTHING RETURNING id,reference,version,created_at,payload_hash`).bind(crypto.randomUUID(), generation, command, digest, parsed.data.reference, instant, key.id, key.version).first<Entry>()
      const row = created ?? await deps.database.prepare(`SELECT id,reference,version,created_at,payload_hash FROM b2b_public_requests WHERE key_id=? AND generation=? AND command_id=?`).bind(key.id, generation, command).first<Entry>()
      if (!row) return error('unauthenticated', 401)
      if (row.payload_hash !== digest) return error('idempotency_conflict', 409)
      result = json({ id: row.id, reference: row.reference, version: row.version, createdAt: row.created_at }, created ? 201 : 200)
    }
    const current = await findKey()
    if (!current || current.version !== key.version || !current.scopes.split(' ').includes(required)) return error('unauthenticated', 401)
    return result
  } catch { return error('service_unavailable', 503) }
}

/** Logical reset occurs at UTC midnight; this bounded maintenance removes expired rows. */
export async function resetB2bSandbox(database: D1Database, now: string) {
  if (!Number.isFinite(Date.parse(now)) || new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z') !== now) throw new Error('invalid_instant')
  const day = now.slice(0, 10)
  await database.batch([
    database.prepare(`DELETE FROM b2b_public_requests WHERE id IN (SELECT id FROM b2b_public_requests WHERE generation<>'live' AND generation<? LIMIT 500)`).bind(day),
    database.prepare(`DELETE FROM b2b_public_quota WHERE rowid IN (SELECT rowid FROM b2b_public_quota WHERE day<? LIMIT 500)`).bind(day)
  ])
}
