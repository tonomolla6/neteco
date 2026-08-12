import { createHash } from 'node:crypto'
import { RedsysPaymentProvider } from '../../../integrations/redsys'
import { processPaymentNotification, recordRejectedWebhook } from '../../../services/orders'
import { validateRuntimeConfiguration } from '../../../utils/runtime-config'

function stringPayload(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, String(entry)]))
}

function payloadHash(payload: Record<string, string>) {
  const canonical = Object.keys(payload)
    .sort()
    .map((key) => `${key}=${payload[key]}`)
    .join('&')
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

export default defineEventHandler(async (event) => {
  const runtime = validateRuntimeConfiguration(useRuntimeConfig(event))
  const correlationId = event.context.correlationId ?? crypto.randomUUID()
  const payload = stringPayload(await readBody(event))
  const provider = new RedsysPaymentProvider({
    environment: runtime.redsys.environment,
    merchantCode: runtime.redsys.merchantCode,
    terminal: runtime.redsys.terminal,
    secretKey: runtime.redsys.secretKey,
    currency: runtime.redsys.currency,
    merchantName: runtime.redsys.merchantName
  })

  let notification
  try {
    notification = await provider.verifyNotification(payload)
  } catch {
    await recordRejectedWebhook({
      payloadHash: payloadHash(payload),
      correlationId,
      reason: 'signature_or_terminal_validation_failed'
    })
    throw createError({ statusCode: 400, statusMessage: 'Invalid payment notification' })
  }
  const result = await processPaymentNotification(notification, correlationId)
  if (!result.accepted) {
    throw createError({ statusCode: 422, statusMessage: 'Payment notification does not match the order' })
  }
  setResponseHeader(event, 'content-type', 'text/plain; charset=utf-8')
  return 'OK'
})
