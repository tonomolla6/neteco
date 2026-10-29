import {
  createPackingSuggestion,
  decidePackingSuggestion,
  deleteIncompatibility,
  getPackingSuggestion,
  listPackingConfig,
  setIncompatibility,
  upsertBoxType,
  upsertProductProfile
} from './packing-optimizer'
import {
  methodNotAllowed,
  opsError,
  opsJson,
  readJson,
  resolveActor,
  type OpsHttpDependencies
} from './shipping-ops-common'

const BASE = '/api/admin/packing-optimizer'

export function ownsPackingOptimizerNamespace(path: string): boolean {
  return path === BASE || path.startsWith(`${BASE}/`)
}

function segments(path: string): string[] | null {
  try {
    return path
      .slice(BASE.length)
      .split('/')
      .filter(Boolean)
      .map((part) => decodeURIComponent(part))
  } catch {
    return null
  }
}

export async function handlePackingOptimizerHttp(
  request: Request,
  deps: OpsHttpDependencies
): Promise<Response | null> {
  const path = new URL(request.url).pathname
  if (!ownsPackingOptimizerNamespace(path)) return null
  const actor = await resolveActor(request, deps)
  if (!actor) return opsJson({ error: { code: 'unauthorized' } }, 401)
  const parts = segments(path)
  if (!parts) return opsJson({ error: { code: 'invalid_input' } }, 400)
  const db = deps.database
  const now = deps.now?.()
  const method = request.method
  try {
    if (parts.length === 0) {
      if (method !== 'GET') return methodNotAllowed()
      return opsJson(await listPackingConfig(db, actor.identityId))
    }
    const [section, key, tail] = parts
    if (section === 'boxes' && key && parts.length === 2) {
      if (method !== 'PUT') return methodNotAllowed()
      const box = await upsertBoxType(db, { actorId: actor.identityId, code: key, input: await readJson(request), now })
      return opsJson({ box })
    }
    if (section === 'profiles' && key && parts.length === 2) {
      if (method !== 'PUT') return methodNotAllowed()
      const profile = await upsertProductProfile(db, {
        actorId: actor.identityId,
        sku: key,
        input: await readJson(request),
        now
      })
      return opsJson({ profile })
    }
    if (section === 'incompatibilities' && parts.length === 1) {
      if (method !== 'PUT') return methodNotAllowed()
      const body = (await readJson(request)) as { classA?: string; classB?: string; reason?: string }
      await setIncompatibility(db, {
        actorId: actor.identityId,
        classA: String(body?.classA),
        classB: String(body?.classB),
        reason: String(body?.reason)
      })
      return opsJson({ ok: true })
    }
    if (section === 'incompatibilities' && key && tail && parts.length === 3) {
      if (method !== 'DELETE') return methodNotAllowed()
      await deleteIncompatibility(db, { actorId: actor.identityId, classA: key, classB: tail })
      return opsJson({ ok: true })
    }
    if (section === 'suggestions' && parts.length === 1) {
      if (method !== 'POST') return methodNotAllowed()
      const suggestion = await createPackingSuggestion(db, {
        actorId: actor.identityId,
        input: await readJson(request),
        now
      })
      return opsJson({ suggestion }, 201)
    }
    if (section === 'suggestions' && key && parts.length === 2) {
      if (method !== 'GET') return methodNotAllowed()
      return opsJson({ suggestion: await getPackingSuggestion(db, actor.identityId, key) })
    }
    if (section === 'suggestions' && key && tail === 'decision' && parts.length === 3) {
      if (method !== 'POST') return methodNotAllowed()
      const suggestion = await decidePackingSuggestion(db, {
        actorId: actor.identityId,
        suggestionId: key,
        input: await readJson(request),
        now
      })
      return opsJson({ suggestion })
    }
    return opsJson({ error: { code: 'not_found' } }, 404)
  } catch (error) {
    return opsError(error)
  }
}
