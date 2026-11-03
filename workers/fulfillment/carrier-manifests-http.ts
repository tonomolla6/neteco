import { createLocalCarrierManifestAdapter, type CarrierManifestAdapter } from './carrier-manifest-adapter'
import {
  cancelManifest,
  closeManifest,
  confirmPickup,
  createManifest,
  getManifest,
  getManifestDocument,
  listManifests,
  schedulePickup,
  setManifestItem
} from './carrier-manifests'
import {
  ShippingOpsError,
  methodNotAllowed,
  opsError,
  opsJson,
  readJson,
  resolveActor,
  type OpsHttpDependencies
} from './shipping-ops-common'
import type { ManifestStatus } from '../../shared/carrier-manifests'
import { verifySessionCookie } from '../auth/session-cookie'
import { authorizeD1Session } from '../catalog/authorization'

const BASE = '/api/admin/carrier-manifests'

export function ownsCarrierManifestsNamespace(path: string): boolean {
  return path === BASE || path.startsWith(`${BASE}/`)
}

export interface CarrierManifestsHttpDependencies extends OpsHttpDependencies {
  adapter?: CarrierManifestAdapter
}

export async function handleCarrierManifestsHttp(
  request: Request,
  deps: CarrierManifestsHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsCarrierManifestsNamespace(url.pathname)) return null
  const actor = await resolveActor(request, deps)
  if (!actor) return opsJson({ error: { code: 'unauthorized' } }, 401)
  if (!deps.sessionProvider && deps.sessionCookieConfiguration) {
    const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
    if (!claims) return opsJson({ error: { code: 'unauthorized' } }, 401)
    const authorization = await authorizeD1Session(deps.database, claims, 'administration.manage', {
      now: deps.now?.()
    })
    if (!authorization.allowed) {
      const status = authorization.code === 'unauthenticated' ? 401 : 403
      return opsJson({ error: { code: status === 401 ? 'unauthorized' : 'forbidden' } }, status)
    }
  }
  const db = deps.database
  const now = deps.now?.()
  const adapter = deps.adapter ?? createLocalCarrierManifestAdapter()
  const actorId = actor.identityId
  const parts = url.pathname.slice(BASE.length).split('/').filter(Boolean)
  const method = request.method
  try {
    if (parts.length === 0) {
      if (method === 'GET') {
        const limitParam = url.searchParams.get('limit')
        const limit = limitParam === null ? undefined : Number(limitParam)
        if (limit !== undefined && !Number.isFinite(limit)) throw new ShippingOpsError('invalid_input')
        const status = (url.searchParams.get('status') ?? undefined) as ManifestStatus | undefined
        return opsJson({ manifests: await listManifests(db, actorId, { status, limit }) })
      }
      if (method === 'POST')
        return opsJson({ manifest: await createManifest(db, { actorId, input: await readJson(request), now }) }, 201)
      return methodNotAllowed()
    }
    const id = parts[0]!
    if (parts.length === 1) {
      if (method !== 'GET') return methodNotAllowed()
      return opsJson({ manifest: await getManifest(db, actorId, id) })
    }
    const action = parts.slice(1).join('/')
    if (action.startsWith('documents/') && parts.length === 3) {
      if (method !== 'GET') return methodNotAllowed()
      const kind = parts[2]
      if (kind !== 'manifest_csv' && kind !== 'pickup_receipt') throw new ShippingOpsError('invalid_input')
      const doc = await getManifestDocument(db, actorId, id, kind)
      return new Response(doc.content, {
        status: 200,
        headers: {
          'content-type': doc.contentType,
          'content-disposition': `attachment; filename="${kind}-${id}.${kind === 'manifest_csv' ? 'csv' : 'txt'}"`,
          'cache-control': 'private, no-store',
          'x-content-type-options': 'nosniff',
          'x-document-sha256': doc.sha256
        }
      })
    }
    const write = async <T>(run: (input: unknown) => Promise<T>) => {
      if (method !== 'POST') return methodNotAllowed()
      return opsJson({ manifest: await run(await readJson(request)) })
    }
    switch (action) {
      case 'items':
        return await write((input) => setManifestItem(db, { actorId, manifestId: id, input, now }))
      case 'close':
        return await write((input) => closeManifest(db, { actorId, manifestId: id, input, adapter, now }))
      case 'pickup':
        return await write((input) => schedulePickup(db, { actorId, manifestId: id, input, adapter, now }))
      case 'pickup/confirm':
        return await write((input) => confirmPickup(db, { actorId, manifestId: id, input, now }))
      case 'cancel':
        return await write((input) => cancelManifest(db, { actorId, manifestId: id, input, now }))
      default:
        return opsJson({ error: { code: 'not_found' } }, 404)
    }
  } catch (error) {
    return opsError(error)
  }
}
