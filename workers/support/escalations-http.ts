import { z } from 'zod'
import { supportUuid } from '../../shared/support-operations'
import {
  executeSupportEscalationCommand,
  executeSupportRunbookCommand,
  readSupportEscalation,
  listSupportEscalations,
  listSupportRunbooks,
  readSupportEscalationCommand
} from './escalations'
import { SupportError, supportChecked } from './operations'
import {
  supportBoundary,
  supportBody,
  supportHttpActor,
  supportJson,
  supportMutationQuota,
  type SupportHttpDependencies
} from './http'
export function ownsSupportEscalationsNamespace(path: string) {
  if (path.length > 4096) return false
  for (let attempt = 0; attempt < 3; attempt++) {
    if (/^\/api\/admin\/support\/(?:escalations(?:\/|$)|SOP-[0-9A-F]{24}\/escalation(?:\/|$))/i.test(path)) return true
    try {
      const next = decodeURIComponent(path)
      if (next === path) break
      path = next
    } catch {
      break
    }
  }
  return false
}
const statuses: Record<string, number> = {
  unauthenticated: 401,
  forbidden: 403,
  email_unverified: 403,
  mfa_required: 403,
  not_found: 404,
  invalid_input: 422,
  body_too_large: 413,
  version_conflict: 409,
  ticket_version_conflict: 409,
  idempotency_conflict: 409,
  invalid_transition: 409,
  owner_unavailable: 409,
  runbook_unavailable: 409,
  retention_expired: 409
}
export async function handleSupportEscalationsHttp(
  request: Request,
  deps: SupportHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsSupportEscalationsNamespace(url.pathname)) return null
  try {
    const boundary = await supportBoundary(request, deps, 'admin')
    if (boundary) return boundary
    const actor = await supportHttpActor(request, deps, 'admin')
    const root = url.pathname === '/api/admin/support/escalations',
      library = url.pathname === '/api/admin/support/escalations/runbooks'
    const runbook = /^\/api\/admin\/support\/escalations\/runbooks\/([^/]+)\/commands(?:\/([^/]+))?$/.exec(url.pathname)
    const ticket = /^\/api\/admin\/support\/(SOP-[0-9A-F]{24})\/escalation(?:\/commands(?:\/([^/]+))?)?$/.exec(
      url.pathname
    )
    if (!root && !library && !runbook && !ticket) return supportJson({ error: { code: 'not_found' } }, 404)
    if ([...url.searchParams.keys()].some((key) => url.searchParams.getAll(key).length !== 1))
      throw new SupportError('invalid_input')
    const query = Object.fromEntries(url.searchParams)
    if (root && request.method === 'GET')
      return supportJson(await listSupportEscalations(deps.database, actor.claims, query))
    if (library && request.method === 'GET') {
      if (url.searchParams.size) throw new SupportError('invalid_input')
      return supportJson(await listSupportRunbooks(deps.database, actor.claims))
    }
    const command = url.pathname.includes('/commands'),
      target = runbook?.[1] ?? ticket?.[1],
      key = runbook?.[2] ?? ticket?.[2]
    if (ticket && !command && request.method === 'GET')
      return supportJson(await readSupportEscalation(deps.database, actor.claims, target!, query))
    if (url.searchParams.size) throw new SupportError('invalid_input')
    if (key && request.method === 'GET') {
      const hash = supportChecked(
        z.string().regex(/^[a-f0-9]{64}$/),
        request.headers.get('X-Neteco-Command-Payload-Hash')
      )
      return supportJson(await readSupportEscalationCommand(deps.database, actor.claims, target!, key, hash))
    }
    if (target && command && !key && request.method === 'POST') {
      const idempotencyKey = supportChecked(supportUuid, request.headers.get('Idempotency-Key'))
      const quota = await supportMutationQuota(deps, actor, 'admin')
      if (quota) return quota
      const body = await supportBody(request)
      return supportJson(
        runbook
          ? await executeSupportRunbookCommand(deps.database, actor.claims, target, body, { idempotencyKey })
          : await executeSupportEscalationCommand(deps.database, actor.claims, target, body, { idempotencyKey }),
        201
      )
    }
    return supportJson({ error: { code: 'method_not_allowed' } }, 405)
  } catch (error) {
    const code =
      error instanceof SupportError && Object.hasOwn(statuses, error.code) ? error.code : 'service_unavailable'
    return supportJson({ error: { code } }, statuses[code] ?? 503)
  }
}
