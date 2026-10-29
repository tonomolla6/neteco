import { supportKnowledgeQuerySchema, supportKnowledgeFeedbackInputSchema } from '../../shared/support-knowledge'
import { catalogPolicyUuidSchema } from '../../shared/catalog-publication-policy'
import { ownsSupportNamespace, supportJson, supportBytes, type SupportHttpDependencies } from './http'
import {
  listSupportKnowledge,
  recordSupportKnowledgeFeedback,
  readSupportKnowledgeFeedback,
  SupportKnowledgeError,
  type SupportKnowledgeDependencies
} from './knowledge'
export interface SupportKnowledgeHttpDependencies extends SupportKnowledgeDependencies {
  origin: string
  edgeGate?: SupportHttpDependencies['edgeGate']
}
function error(code: string, status: number) {
  return supportJson({ error: { code } }, status)
}
export async function handleSupportKnowledgeHttp(
  request: Request,
  deps: SupportKnowledgeHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url),
    prefix = '/api/support/knowledge'
  if (!ownsSupportNamespace(url.pathname, prefix)) return null
  const receipt = /^\/api\/support\/knowledge\/feedback\/([0-9a-f-]{36})$/.exec(url.pathname)
  const list = url.pathname === prefix,
    write = url.pathname === prefix + '/feedback'
  if (!list && !write && !receipt) return error('invalid_input', 400)
  if (request.method !== (write ? 'POST' : 'GET'))
    return supportJson({ error: { code: 'method_not_allowed' } }, 405, { Allow: write ? 'POST' : 'GET' })
  if (!deps.enabled) return error('knowledge_unavailable', 503)
  try {
    const origin = new URL(deps.origin)
    if (origin.protocol !== 'https:' || origin.origin !== deps.origin) return error('knowledge_unavailable', 503)
    if (
      request.headers.get('sec-fetch-site') === 'cross-site' ||
      (write
        ? request.headers.get('origin') !== deps.origin
        : request.headers.has('origin') && request.headers.get('origin') !== deps.origin)
    )
      return error('csrf_rejected', 403)
    if (list) {
      const query: Record<string, unknown> = {}
      for (const [key, value] of url.searchParams) {
        if (!['q', 'page', 'perPage', 'category'].includes(key) || url.searchParams.getAll(key).length !== 1)
          return error('invalid_input', 400)
        if (key === 'page' || key === 'perPage') {
          if (!/^[1-9][0-9]{0,6}$/.test(value)) return error('invalid_input', 400)
          query[key] = Number(value)
        } else query[key] = value
      }
      const parsed = supportKnowledgeQuerySchema.safeParse(query)
      if (!parsed.success) return error('invalid_input', 400)
      return supportJson(
        await listSupportKnowledge(
          { ...deps, feedbackEnabled: deps.feedbackEnabled === true && !!deps.edgeGate },
          parsed.data
        )
      )
    }
    if (url.search) return error('invalid_input', 400)
    if (!deps.feedbackEnabled) return error('feedback_unavailable', 503)
    const gate = await deps.edgeGate?.(request, 'contact')
    if (gate === 'limited') return supportJson({ error: { code: 'rate_limited' } }, 429, { 'Retry-After': '60' })
    if (gate !== 'allowed') return error('abuse_control_unavailable', 503)
    if (receipt) {
      if (!catalogPolicyUuidSchema.safeParse(receipt[1]).success) return error('invalid_input', 400)
      const result = await readSupportKnowledgeFeedback(deps, receipt[1]!)
      return result ? supportJson(result) : error('not_found', 404)
    }
    const key = request.headers.get('idempotency-key')
    if (!catalogPolicyUuidSchema.safeParse(key).success) return error('invalid_input', 400)
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? ''))
      return error('unsupported_media_type', 415)
    let timer: ReturnType<typeof setTimeout> | undefined
    let raw: unknown
    try {
      const bytes = await Promise.race([
        supportBytes(request, 4096),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            void request.body?.cancel().catch(() => {})
            reject(new Error('body_timeout'))
          }, 8000)
        })
      ])
      raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    } catch (cause) {
      return error(
        String(cause).includes('body_too_large') ? 'body_too_large' : 'invalid_input',
        String(cause).includes('body_too_large') ? 413 : 422
      )
    } finally {
      if (timer) clearTimeout(timer)
    }
    const body = supportKnowledgeFeedbackInputSchema.safeParse(raw)
    if (!body.success) return error('invalid_input', 422)
    return supportJson(await recordSupportKnowledgeFeedback(deps, body.data, key!))
  } catch (cause) {
    if (cause instanceof SupportKnowledgeError)
      return error(
        cause.code,
        ['article_unavailable', 'idempotency_conflict'].includes(cause.code)
          ? 409
          : cause.code === 'invalid_input'
            ? 422
            : 503
      )
    return error('knowledge_unavailable', 503)
  }
}
