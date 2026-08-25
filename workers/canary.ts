import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'
import { listPublishedCategories } from './catalog/categories'
import { listPublishedProducts, type ProductSort } from './catalog/products'
import { expireExpiredReservations, InventoryError, isCanonicalInventoryInstant } from './catalog/inventory'
export { InventoryCoordinator } from './inventory-coordinator'

const QUEUE_MESSAGE_VERSION = 1

interface ExpiryQueueMessage {
  version: number
  type: string
  messageId: string
  correlationId: string
  /** Canonical UTC instant this delivery was scheduled for; stale values are ignored by the SQL gate. */
  before: string
}

function parseExpiryMessage(
  body: unknown
): { ok: true; message: ExpiryQueueMessage } | { ok: false; permanent: boolean } {
  if (typeof body !== 'object' || body === null) return { ok: false, permanent: true }
  const raw = body as Record<string, unknown>
  if (raw.version !== QUEUE_MESSAGE_VERSION) return { ok: false, permanent: true }
  if (raw.type !== 'inventory.expire') return { ok: false, permanent: true }
  for (const key of ['messageId', 'correlationId'] as const)
    if (
      typeof raw[key] !== 'string' ||
      !(raw[key] as string).length ||
      (raw[key] as string).length > 200 ||
      [...(raw[key] as string)].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    )
      return { ok: false, permanent: true }
  if (!isCanonicalInventoryInstant(raw.before)) return { ok: false, permanent: true }
  return {
    ok: true,
    message: {
      before: raw.before as string,
      correlationId: raw.correlationId as string,
      messageId: raw.messageId as string,
      type: raw.type as string,
      version: QUEUE_MESSAGE_VERSION
    }
  }
}

export interface CanaryCheck {
  ok: boolean
  detail?: string
}

export interface CanaryHealth {
  ok: boolean
  service: 'neteco-cloudflare-canary'
  checks: {
    d1: CanaryCheck
    durableObjects: CanaryCheck
    inventory: CanaryCheck
    kv: CanaryCheck
    queues: CanaryCheck
    r2: CanaryCheck
    workflows: CanaryCheck
  }
}

function bindingCheck(value: unknown, methods: string[]): CanaryCheck {
  const binding = value as Record<string, unknown> | undefined
  const ok = !!binding && methods.every((method) => typeof binding[method] === 'function')
  return ok ? { ok } : { ok, detail: 'binding_missing_or_invalid' }
}

export async function inspectCanaryBindings(env: CloudflareEnv): Promise<CanaryHealth> {
  let d1: CanaryCheck
  try {
    const result = await env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>()
    d1 = result?.ok === 1 ? { ok: true } : { ok: false, detail: 'probe_failed' }
  } catch {
    d1 = { ok: false, detail: 'probe_failed' }
  }

  const checks = {
    d1,
    durableObjects: bindingCheck(env.COORDINATOR, ['idFromName', 'get']),
    inventory: bindingCheck(env.INVENTORY, ['idFromName', 'get']),
    kv: bindingCheck(env.CACHE, ['get', 'put']),
    queues: bindingCheck(env.ASYNC_JOBS, ['send']),
    r2: bindingCheck(env.MEDIA, ['get', 'put']),
    workflows: bindingCheck(env.CATALOG_WORKFLOW, ['create', 'get'])
  }

  return {
    ok: Object.values(checks).every((check) => check.ok),
    service: 'neteco-cloudflare-canary',
    checks
  }
}

export class CanaryCoordinator implements DurableObject {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: CloudflareEnv
  ) {}

  fetch(): Response {
    return Response.json({ ok: true, id: this.state.id.toString(), environment: this.env.APP_ENV })
  }
}

export class CanaryWorkflow extends WorkflowEntrypoint<CloudflareEnv, { correlationId: string }> {
  override async run(event: WorkflowEvent<{ correlationId: string }>, step: WorkflowStep) {
    return step.do('validate platform bindings', async () => ({
      ok: true,
      correlationId: event.payload.correlationId,
      environment: this.env.APP_ENV
    }))
  }
}

export default {
  async fetch(request: Request, env: CloudflareEnv): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === 'GET' && url.pathname === '/api/categories') {
      try {
        return Response.json(await listPublishedCategories(env.DB), {
          headers: { 'cache-control': 'public, max-age=60, stale-while-revalidate=300' }
        })
      } catch {
        return Response.json(
          { error: 'catalog_unavailable' },
          { status: 503, headers: { 'cache-control': 'no-store' } }
        )
      }
    }
    if (request.method === 'GET' && url.pathname === '/api/products') {
      try {
        const page = Math.max(Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1, 1)
        const limit = Math.min(Math.max(Number.parseInt(url.searchParams.get('limit') ?? '24', 10) || 24, 1), 100)
        const requestedSort = url.searchParams.get('sort') ?? 'default'
        const sort: ProductSort = ['name', 'price_asc', 'price_desc'].includes(requestedSort)
          ? (requestedSort as ProductSort)
          : 'default'
        const result = await listPublishedProducts(env.DB, {
          category: url.searchParams.get('category')?.slice(0, 180) || undefined,
          search: url.searchParams.get('q')?.trim().slice(0, 160) || undefined,
          page,
          limit,
          sort
        })
        if (!result) {
          return Response.json(
            { error: 'category_not_found' },
            { status: 404, headers: { 'cache-control': 'no-store' } }
          )
        }
        return Response.json(result, {
          headers: { 'cache-control': 'public, max-age=30, stale-while-revalidate=120' }
        })
      } catch {
        return Response.json(
          { error: 'catalog_unavailable' },
          { status: 503, headers: { 'cache-control': 'no-store' } }
        )
      }
    }
    if (request.method !== 'GET' || url.pathname !== '/health') {
      return Response.json({ error: 'not_found' }, { status: 404 })
    }

    const health = await inspectCanaryBindings(env)
    return Response.json(health, {
      status: health.ok ? 200 : 503,
      headers: { 'cache-control': 'no-store' }
    })
  },

  async queue(batch: MessageBatch, env: CloudflareEnv): Promise<void> {
    const processedInBatch = new Set<string>()
    await Promise.all(
      batch.messages.map(async (message) => {
        const parsed = parseExpiryMessage(message.body)
        // Permanent malformations are acknowledged without retry loops; the
        // dead-letter queue plus max_retries bound everything transient.
        if (!parsed.ok) {
          console.log(JSON.stringify({ event: 'inventory.queue.permanent_skip' }))
          message.ack()
          return
        }
        if (processedInBatch.has(parsed.message.messageId)) {
          message.ack() // duplicate inside the same delivery batch: at-least-once, process once
          return
        }
        processedInBatch.add(parsed.message.messageId)
        try {
          await expireExpiredReservations(env.DB, {
            at: parsed.message.before,
            correlationId: parsed.message.correlationId
          })
          message.ack()
        } catch (error) {
          if (error instanceof InventoryError && error.code === 'invalid_input') {
            console.log(
              JSON.stringify({ event: 'inventory.queue.permanent_reject', messageId: parsed.message.messageId })
            )
            message.ack()
            return
          }
          console.log(
            JSON.stringify({
              event: 'inventory.queue.retry',
              messageId: parsed.message.messageId,
              attempt: message.attempts
            })
          )
          message.retry({ delaySeconds: Math.min(30 * 2 ** message.attempts, 300) })
        }
      })
    )
  }
} satisfies ExportedHandler<CloudflareEnv>
