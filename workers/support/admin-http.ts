import { executeSupportAdminCommand, listSupportTickets, readSupportTicket } from './operations'
import { executeSupportMacroCommand, listSupportMacros, previewSupportMacro } from './macros'
import {
  ownsSupportNamespace,
  supportBoundary,
  supportFailure,
  supportHttpActor,
  supportJson,
  supportRequestKey,
  supportPagination,
  supportBody,
  supportMutationQuota,
  supportAttachmentHttp,
  type SupportHttpDependencies
} from './http'
export const ownsAdminSupportNamespace = (path: string) => ownsSupportNamespace(path, '/api/admin/support')
export async function handleAdminSupportHttp(
  request: Request,
  deps: SupportHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsAdminSupportNamespace(url.pathname)) return null
  try {
    const boundary = await supportBoundary(request, deps, 'admin')
    if (boundary) return boundary
    const actor = await supportHttpActor(request, deps, 'admin')
    const macroRoot = url.pathname === '/api/admin/support/macros',
      macro = /^\/api\/admin\/support\/macros\/([^/]+)$/.exec(url.pathname),
      preview = /^\/api\/admin\/support\/([^/]+)\/macro-preview$/.exec(url.pathname)
    if (macroRoot || macro || preview) {
      if (request.method === 'GET' && (macroRoot || macro)) {
        const allowed = macroRoot ? 'afterMacroId' : 'beforeVersion'
        if ([...url.searchParams.keys()].some((k) => k !== allowed) || url.searchParams.getAll(allowed).length > 1)
          return supportJson({ error: { code: 'invalid_input' } }, 400)
        const cursor = url.searchParams.get(allowed)
        return supportJson(
          await listSupportMacros(
            deps.database,
            actor.claims,
            macroRoot
              ? cursor === null
                ? {}
                : { afterMacroId: cursor }
              : {
                  macroId: macro![1]!,
                  ...(cursor === null ? {} : { beforeVersion: /^[1-9][0-9]*$/.test(cursor) ? Number(cursor) : 0 })
                }
          )
        )
      }
      if (url.searchParams.size) return supportJson({ error: { code: 'invalid_input' } }, 400)
      if ((macro && request.method === 'PUT') || (preview && request.method === 'POST')) {
        const key = supportRequestKey(request),
          quota = await supportMutationQuota(deps, actor, 'admin')
        if (quota) return quota
        const body = await supportBody(request)
        return supportJson(
          preview
            ? await previewSupportMacro(deps.database, actor.claims, preview[1]!, body)
            : await executeSupportMacroCommand(deps.database, actor.claims, macro![1]!, body, { idempotencyKey: key })
        )
      }
      return supportJson({ error: { code: 'method_not_allowed' } }, 405)
    }
    const attachment = /^\/api\/admin\/support\/([^/]+)\/attachments(?:\/([^/]+))?$/.exec(url.pathname)
    if (attachment) {
      if (url.searchParams.size) return supportJson({ error: { code: 'invalid_input' } }, 400)
      return await supportAttachmentHttp(request, deps, actor, attachment[1]!, attachment[2])
    }
    const root = url.pathname === '/api/admin/support',
      match = /^\/api\/admin\/support\/([^/]+)$/.exec(url.pathname),
      ref = match?.[1]
    if (!root && !ref) return supportJson({ error: { code: 'invalid_input' } }, 400)
    if (request.method === 'GET') {
      const page = supportPagination(url, true, root)
      return supportJson(
        root
          ? await listSupportTickets(deps.database, actor.claims, 'admin', page)
          : await readSupportTicket(deps.database, actor.claims, 'admin', ref!, page, !!deps.storage)
      )
    }
    if (root || request.method !== 'PUT') return supportJson({ error: { code: 'method_not_allowed' } }, 405)
    if (url.searchParams.size) return supportJson({ error: { code: 'invalid_input' } }, 400)
    const key = supportRequestKey(request),
      quota = await supportMutationQuota(deps, actor, 'admin')
    if (quota) return quota
    return supportJson(
      await executeSupportAdminCommand(deps.database, actor.claims, ref!, await supportBody(request), {
        idempotencyKey: key
      })
    )
  } catch (error) {
    return supportFailure(error)
  }
}
