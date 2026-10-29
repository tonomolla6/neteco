import { listSupportTickets, readSupportTicket, replySupportCustomer } from './operations'
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
export const ownsCustomerSupportNamespace = (path: string) => ownsSupportNamespace(path, '/api/account/support')
export async function handleCustomerSupportHttp(
  request: Request,
  deps: SupportHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsCustomerSupportNamespace(url.pathname)) return null
  try {
    const boundary = await supportBoundary(request, deps, 'customer')
    if (boundary) return boundary
    const actor = await supportHttpActor(request, deps, 'customer')
    const attachment = /^\/api\/account\/support\/([^/]+)\/attachments(?:\/([^/]+))?$/.exec(url.pathname)
    if (attachment) {
      if (url.searchParams.size) return supportJson({ error: { code: 'invalid_input' } }, 400)
      return await supportAttachmentHttp(request, deps, actor, attachment[1]!, attachment[2])
    }
    const root = url.pathname === '/api/account/support',
      match = /^\/api\/account\/support\/([^/]+)$/.exec(url.pathname),
      ref = match?.[1]
    if (!root && !ref) return supportJson({ error: { code: 'invalid_input' } }, 400)
    if (request.method === 'GET') {
      const page = supportPagination(url)
      return supportJson(
        root
          ? await listSupportTickets(deps.database, actor.claims, 'customer', page)
          : await readSupportTicket(deps.database, actor.claims, 'customer', ref!, page, !!deps.storage)
      )
    }
    if (root || request.method !== 'POST') return supportJson({ error: { code: 'method_not_allowed' } }, 405)
    if (url.searchParams.size) return supportJson({ error: { code: 'invalid_input' } }, 400)
    const key = supportRequestKey(request),
      quota = await supportMutationQuota(deps, actor, 'customer')
    if (quota) return quota
    return supportJson(
      await replySupportCustomer(deps.database, actor.claims, ref!, await supportBody(request), {
        idempotencyKey: key
      }),
      201
    )
  } catch (error) {
    return supportFailure(error)
  }
}
