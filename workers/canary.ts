import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'
import { listPublishedCategories } from './catalog/categories'
import { listPublishedProducts, type ProductSort } from './catalog/products'
import { expireExpiredReservations, InventoryError, isCanonicalInventoryInstant } from './catalog/inventory'
import { CartError, getCart } from './catalog/cart'
import { cartDoName } from './cart-coordinator'
import { compensateStaleAttempts, getOrderView } from './catalog/checkout'
export { InventoryCoordinator } from './inventory-coordinator'
export { CartCoordinator } from './cart-coordinator'

const CART_BODY_LIMIT_BYTES = 4096
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function cartErrorResponse(error: unknown): Response {
  if (error instanceof CartError)
    return noStoreJson(
      { error: { code: error.code } },
      error.code === 'invalid_input'
        ? 400
        : error.code === 'unauthorized'
          ? 401
          : error.code === 'empty_cart' || error.code === 'variant_not_available'
            ? 422
            : 409
    )
  return noStoreJson({ error: { code: 'internal' } }, 500)
}

function noStoreJson(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
}

function bearerCartToken(request: Request): string | null {
  const match = (request.headers.get('authorization') ?? '').match(/^Cart ([A-Za-z0-9_-]{43,86})$/)
  return match ? match[1]! : null
}

async function readLimitedJson(request: Request): Promise<Record<string, unknown> | null> {
  const declaredLength = Number(request.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > CART_BODY_LIMIT_BYTES) return null
  if (!request.body) return {}
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    totalBytes += value.byteLength
    if (totalBytes > CART_BODY_LIMIT_BYTES) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  let raw: string
  try {
    raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
  if (!raw.length) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function serverNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

async function dispatchCartCommand(env: CloudflareEnv, command: Record<string, unknown>): Promise<Response> {
  const cartId = typeof command.cartId === 'string' ? command.cartId : `create:${crypto.randomUUID()}`
  const stub = env.CARTS.get(env.CARTS.idFromName(cartDoName(cartId)))
  const response = await stub.fetch(
    new Request('https://cart-coordinator.invalid/command', {
      method: 'POST',
      body: JSON.stringify(command)
    })
  )
  return noStoreJson(await response.json(), response.status)
}

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
    carts: CanaryCheck
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
    carts: bindingCheck(env.CARTS, ['idFromName', 'get']),
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
    if (request.method === 'POST' && url.pathname === '/api/carts') {
      try {
        const body = await readLimitedJson(request)
        if (!body) return noStoreJson({ error: { code: 'invalid_input' } }, 400)
        const cartId = crypto.randomUUID()
        const correlationId =
          typeof body.correlationId === 'string'
            ? body.correlationId
            : (request.headers.get('x-correlation-id') ?? 'api')
        return await dispatchCartCommand(env, {
          cartId,
          commandId: crypto.randomUUID(),
          payload: { correlationId: correlationId.slice(0, 200), now: serverNow() },
          type: 'create'
        })
      } catch {
        return noStoreJson({ error: { code: 'internal' } }, 500)
      }
    }
    const cartRoute =
      url.pathname.match(/^\/api\/carts\/([0-9a-f-]{36})$/) ?? url.pathname.match(/^\/api\/carts\/([^/]+)$/)
    if (request.method === 'GET' && cartRoute) {
      try {
        if (!UUID_PATTERN.test(cartRoute[1]!)) return noStoreJson({ error: { code: 'unauthorized' } }, 401)
        const token = bearerCartToken(request)
        if (!token) return noStoreJson({ error: { code: 'unauthorized' } }, 401)
        const view = await getCart(env.DB, { cartId: cartRoute[1]!, now: serverNow(), token })
        return noStoreJson(view, 200)
      } catch (error) {
        return cartErrorResponse(error)
      }
    }
    const itemRoute = url.pathname.match(/^\/api\/carts\/([^/]+)\/items\/([^/]+)$/)
    if (request.method === 'PUT' && itemRoute) {
      try {
        const [, cartId, variantIdRaw] = itemRoute
        if (!UUID_PATTERN.test(cartId!)) return noStoreJson({ error: { code: 'unauthorized' } }, 401)
        const token = bearerCartToken(request)
        if (!token) return noStoreJson({ error: { code: 'unauthorized' } }, 401)
        const idempotencyKey = request.headers.get('idempotency-key')
        if (!idempotencyKey || idempotencyKey.length > 200)
          return noStoreJson({ error: { code: 'invalid_input' } }, 400)
        if (!UUID_PATTERN.test(variantIdRaw!)) return noStoreJson({ error: { code: 'invalid_input' } }, 400)
        const body = await readLimitedJson(request)
        if (!body) return noStoreJson({ error: { code: 'invalid_input' } }, 400)
        const expectedVersion = body.expectedVersion
        const quantity = body.quantity
        if (typeof expectedVersion !== 'number' || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1)
          return noStoreJson({ error: { code: 'invalid_input' } }, 400)
        if (typeof quantity !== 'number' || !Number.isSafeInteger(quantity))
          return noStoreJson({ error: { code: 'invalid_input' } }, 400)
        return await dispatchCartCommand(env, {
          cartId,
          commandId: idempotencyKey,
          payload: {
            cartId,
            correlationId: String(request.headers.get('x-correlation-id') ?? 'api').slice(0, 200),
            expectedVersion,
            idempotencyKey,
            now: serverNow(),
            quantity,
            token,
            variantId: variantIdRaw!
          },
          type: 'mutate'
        })
      } catch {
        return noStoreJson({ error: { code: 'internal' } }, 500)
      }
    }
    const quoteRoute = url.pathname.match(/^\/api\/carts\/([^/]+)\/quote$/)
    if (request.method === 'POST' && quoteRoute) {
      try {
        const cartId = quoteRoute[1]!
        if (!UUID_PATTERN.test(cartId)) return noStoreJson({ error: { code: 'unauthorized' } }, 401)
        const token = bearerCartToken(request)
        if (!token) return noStoreJson({ error: { code: 'unauthorized' } }, 401)
        const idempotencyKey = request.headers.get('idempotency-key')
        if (!idempotencyKey || idempotencyKey.length > 200)
          return noStoreJson({ error: { code: 'invalid_input' } }, 400)
        const body = await readLimitedJson(request)
        if (!body) return noStoreJson({ error: { code: 'invalid_input' } }, 400)
        const expectedVersion = body.expectedVersion
        if (typeof expectedVersion !== 'number' || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1)
          return noStoreJson({ error: { code: 'invalid_input' } }, 400)
        return await dispatchCartCommand(env, {
          cartId,
          commandId: idempotencyKey,
          payload: {
            cartId,
            correlationId: String(request.headers.get('x-correlation-id') ?? 'api').slice(0, 200),
            expectedVersion,
            idempotencyKey,
            now: serverNow(),
            token
          },
          type: 'quote'
        })
      } catch {
        return noStoreJson({ error: { code: 'internal' } }, 500)
      }
    }
    const shippingRoute = url.pathname.match(/^\/api\/carts\/([^/]+)\/shipping-options$/)
    if (request.method === 'POST' && shippingRoute) {
      try {
        const cartId = shippingRoute[1]!
        if (!UUID_PATTERN.test(cartId)) return noStoreJson({ error: { code: 'unauthorized' } }, 401)
        const token = bearerCartToken(request)
        if (!token) return noStoreJson({ error: { code: 'unauthorized' } }, 401)
        const idempotencyKey = request.headers.get('idempotency-key')
        if (!idempotencyKey || idempotencyKey.length > 200)
          return noStoreJson({ error: { code: 'invalid_input' } }, 400)
        const body = await readLimitedJson(request)
        if (!body) return noStoreJson({ error: { code: 'invalid_input' } }, 400)
        if (typeof body.expectedVersion !== 'number' || !Number.isSafeInteger(body.expectedVersion))
          return noStoreJson({ error: { code: 'invalid_input' } }, 400)
        return await dispatchCartCommand(env, {
          cartId,
          commandId: idempotencyKey,
          payload: {
            cartId,
            correlationId: String(request.headers.get('x-correlation-id') ?? 'api').slice(0, 200),
            destination: body.destination ?? null,
            expectedVersion: body.expectedVersion,
            idempotencyKey,
            now: serverNow(),
            token
          },
          type: 'shipping-options'
        })
      } catch {
        return noStoreJson({ error: { code: 'internal' } }, 500)
      }
    }
    const orderRoute = url.pathname.match(/^\/api\/carts\/([^/]+)\/orders$/)
    if (request.method === 'POST' && orderRoute) {
      try {
        const cartId = orderRoute[1]!
        if (!UUID_PATTERN.test(cartId)) return noStoreJson({ error: { code: 'unauthorized' } }, 401)
        const token = bearerCartToken(request)
        if (!token) return noStoreJson({ error: { code: 'unauthorized' } }, 401)
        const idempotencyKey = request.headers.get('idempotency-key')
        if (!idempotencyKey || idempotencyKey.length > 200)
          return noStoreJson({ error: { code: 'invalid_input' } }, 400)
        const body = await readLimitedJson(request)
        if (!body) return noStoreJson({ error: { code: 'invalid_input' } }, 400)
        if (
          typeof body.expectedVersion !== 'number' ||
          !Number.isSafeInteger(body.expectedVersion) ||
          typeof body.selectedOptionIndex !== 'number' ||
          !Number.isSafeInteger(body.selectedOptionIndex)
        )
          return noStoreJson({ error: { code: 'invalid_input' } }, 400)
        return await dispatchCartCommand(env, {
          cartId,
          commandId: idempotencyKey,
          payload: {
            consentPrivacy: body.consentPrivacy === true,
            consentTos: body.consentTos === true,
            contactEmail: String(body.contactEmail ?? ''),
            correlationId: String(request.headers.get('x-correlation-id') ?? 'api').slice(0, 200),
            expectedVersion: body.expectedVersion,
            idempotencyKey,
            now: serverNow(),
            billingAddress: body.billingAddress ?? null,
            quoteId: String(body.quoteId ?? ''),
            selectedOptionHash: String(body.selectedOptionHash ?? ''),
            selectedOptionIndex: body.selectedOptionIndex,
            shippingAddress: body.shippingAddress ?? null,
            shippingQuoteId: String(body.shippingQuoteId ?? ''),
            token
          },
          type: 'checkout'
        })
      } catch {
        return noStoreJson({ error: { code: 'internal' } }, 500)
      }
    }
    const orderGetRoute = url.pathname.match(/^\/api\/orders\/([^/]+)$/)
    if (request.method === 'GET' && orderGetRoute) {
      try {
        if (!UUID_PATTERN.test(orderGetRoute[1]!)) return noStoreJson({ error: { code: 'unauthorized' } }, 401)
        const match = (request.headers.get('authorization') ?? '').match(/^Order ([A-Za-z0-9_-]{43,86})$/)
        if (!match) return noStoreJson({ error: { code: 'unauthorized' } }, 401)
        const view = await getOrderView(env.DB, {
          orderId: orderGetRoute[1]!,
          token: match[1]!
        })
        // Unknown id and wrong token are indistinguishable.
        if (!view) return noStoreJson({ error: { code: 'unauthorized' } }, 401)
        return noStoreJson(view, 200)
      } catch {
        return noStoreJson({ error: { code: 'internal' } }, 500)
      }
    }
    if (request.method !== 'GET' || url.pathname !== '/health') {
      return Response.json({ error: { code: 'not_found' } }, { status: 404 })
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
          await compensateStaleAttempts(env.DB, { at: parsed.message.before })
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
