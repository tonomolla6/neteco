import {
  initiateRedsysPayment,
  PaymentError,
  processRedsysNotification,
  type PaymentInventoryGateway,
  type PaymentRuntimeConfiguration
} from '../catalog/payments'
import { INVENTORY_COORDINATOR_NAME, type AssignResult } from '../catalog/inventory'
import type { RedsysEnvelope } from './redsys'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function json(body: unknown, status: number) {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
}

async function readText(request: Request, limit: number): Promise<string> {
  if (Number(request.headers.get('content-length')) > limit) throw new PaymentError('invalid_input', 'Body too large')
  if (!request.body) throw new PaymentError('invalid_input', 'Missing body')
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) {
        await reader.cancel()
        throw new PaymentError('invalid_input', 'Body too large')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new PaymentError('invalid_input', 'Invalid UTF-8')
  }
}

export function paymentInventoryGateway(env: CloudflareEnv): PaymentInventoryGateway {
  return {
    async assign(payload) {
      const stub = env.INVENTORY.get(env.INVENTORY.idFromName(INVENTORY_COORDINATOR_NAME))
      const response = await stub.fetch(
        new Request('https://inventory.invalid/command', {
          method: 'POST',
          body: JSON.stringify({ type: 'assign', commandId: crypto.randomUUID(), payload })
        })
      )
      const body = (await response.json()) as AssignResult
      if (
        (response.status === 200 && (body.outcome === 'assigned' || body.outcome === 'replayed')) ||
        (response.status === 409 && body.outcome === 'expired')
      )
        return body
      throw new PaymentError('infrastructure', 'Inventory coordinator unavailable')
    }
  }
}

export interface PaymentHttpDependencies {
  database: D1Database
  configuration: () => PaymentRuntimeConfiguration | null
  inventory: PaymentInventoryGateway
  now: () => string
  /** PAY-022: optional hook run only after a verified, captured notification; a failure makes the bank retry. */
  afterCaptured?: (envelope: RedsysEnvelope, now: string) => Promise<void>
}

/** Returns null for unrelated routes. Bank return URLs never mutate payments. */
export async function handlePaymentHttp(request: Request, deps: PaymentHttpDependencies): Promise<Response | null> {
  const path = new URL(request.url).pathname
  const start = path.match(/^\/api\/orders\/([^/]+)\/payment-intents$/)
  const notify = path === '/api/payments/redsys/notification'
  if (!start && !notify) return null
  if (request.method !== 'POST') return json({ error: { code: 'method_not_allowed' } }, 405)
  try {
    let orderToken: string | undefined
    if (start) {
      orderToken = request.headers.get('authorization')?.match(/^Order ([A-Za-z0-9_-]{43,86})$/)?.[1]
      if (!UUID.test(start[1]!) || !orderToken) return json({ error: { code: 'unauthorized' } }, 401)
    }
    const configuration = deps.configuration()
    if (!configuration) return json({ error: { code: 'payments_unavailable' } }, 503)
    const correlationId = crypto.randomUUID()
    const now = deps.now()
    if (start) {
      if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json')
        return json({ error: { code: 'invalid_input' } }, 400)
      let body: unknown
      try {
        body = JSON.parse(await readText(request, 4096))
      } catch {
        return json({ error: { code: 'invalid_input' } }, 400)
      }
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => key !== 'method'))
        return json({ error: { code: 'invalid_input' } }, 400)
      const method = (body as { method?: unknown }).method
      if (method !== 'card' && method !== 'bizum') return json({ error: { code: 'invalid_input' } }, 400)
      if (method === 'bizum' && !configuration.bizumEnabled) return json({ error: { code: 'method_unavailable' } }, 422)
      const result = await initiateRedsysPayment(
        deps.database,
        {
          orderId: start[1]!,
          orderToken: orderToken!,
          method,
          now,
          correlationId,
          idempotencyKey: request.headers.get('idempotency-key') ?? ''
        },
        configuration
      )
      return json(result.body, result.status)
    }
    if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/x-www-form-urlencoded')
      return json({ error: { code: 'invalid_notification' } }, 400)
    const form = new URLSearchParams(await readText(request, 32768))
    const fields = ['Ds_MerchantParameters', 'Ds_SignatureVersion', 'Ds_Signature'] as const
    if (
      [...form.keys()].some((key) => !fields.includes(key as (typeof fields)[number])) ||
      fields.some((key) => form.getAll(key).length !== 1)
    )
      return json({ error: { code: 'invalid_notification' } }, 400)
    const envelope: RedsysEnvelope = {
      Ds_MerchantParameters: form.get('Ds_MerchantParameters')!,
      Ds_SignatureVersion: form.get('Ds_SignatureVersion')!,
      Ds_Signature: form.get('Ds_Signature')!
    }
    const result = await processRedsysNotification(
      deps.database,
      envelope,
      configuration,
      { correlationId, now },
      deps.inventory
    )
    if (result.outcome === 'captured' && deps.afterCaptured) await deps.afterCaptured(envelope, now)
    if (result.outcome === 'mismatch') return json({ error: { code: 'invalid_notification' } }, 422)
    return new Response('OK', { headers: { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' } })
  } catch (error) {
    if (error instanceof PaymentError && error.code !== 'infrastructure') {
      const status =
        error.code === 'unauthorized'
          ? 401
          : error.code === 'invalid_input' || error.code === 'invalid_notification'
            ? 400
            : 409
      return json({ error: { code: error.code } }, status)
    }
    return json({ error: { code: 'internal' } }, 500)
  }
}
