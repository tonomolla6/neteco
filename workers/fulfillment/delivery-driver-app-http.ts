import {
  applyDeliveryEvent,
  getDeliveryEvidence,
  getDriverManifest,
  getRouteReport,
  syncDeliveryEvents
} from './delivery-driver-app'
import {
  methodNotAllowed,
  opsError,
  opsJson,
  readJson,
  resolveActor,
  type OpsHttpDependencies
} from './shipping-ops-common'

const DRIVER = '/api/delivery'
const ADMIN = '/api/admin/delivery-app'
const MAX_BODY_BYTES = 600_000

export function ownsDeliveryDriverAppNamespace(path: string): boolean {
  return path === DRIVER || path.startsWith(`${DRIVER}/`) || path === ADMIN || path.startsWith(`${ADMIN}/`)
}

export async function handleDeliveryDriverAppHttp(
  request: Request,
  deps: OpsHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  const path = url.pathname
  if (!ownsDeliveryDriverAppNamespace(path)) return null
  const actor = await resolveActor(request, deps)
  if (!actor) return opsJson({ error: { code: 'unauthorized' } }, 401)
  const db = deps.database
  const now = deps.now?.()
  const identityId = actor.identityId
  try {
    if (path.startsWith(`${DRIVER}/`)) {
      const section = path.slice(DRIVER.length + 1)
      if (section === 'manifest') {
        if (request.method !== 'GET') return methodNotAllowed()
        const routeDate = url.searchParams.get('date') ?? undefined
        return opsJson(await getDriverManifest(db, { identityId, routeDate, now }))
      }
      if (section === 'events') {
        if (request.method !== 'POST') return methodNotAllowed()
        const input = await readJson(request, MAX_BODY_BYTES)
        return opsJson({ result: await applyDeliveryEvent(db, { identityId, input, now }) })
      }
      if (section === 'sync') {
        if (request.method !== 'POST') return methodNotAllowed()
        const input = await readJson(request, MAX_BODY_BYTES)
        return opsJson(await syncDeliveryEvents(db, { identityId, input, now }))
      }
      return opsJson({ error: { code: 'not_found' } }, 404)
    }
    const parts = path.slice(ADMIN.length).split('/').filter(Boolean)
    if (request.method !== 'GET') return methodNotAllowed()
    if (parts.length === 3 && parts[0] === 'routes' && parts[2] === 'report')
      return opsJson(await getRouteReport(db, identityId, decodeURIComponent(parts[1]!)))
    if (parts.length === 3 && parts[0] === 'stops' && parts[2] === 'evidence') {
      const evidence = await getDeliveryEvidence(db, identityId, decodeURIComponent(parts[1]!))
      return new Response(evidence.bytes as BodyInit, {
        status: 200,
        headers: {
          'content-type': evidence.mime,
          'cache-control': 'private, no-store',
          'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'none'; sandbox",
          'x-evidence-sha256': evidence.sha256
        }
      })
    }
    return opsJson({ error: { code: 'not_found' } }, 404)
  } catch (error) {
    return opsError(error)
  }
}
