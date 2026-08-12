import { z } from 'zod'
import { RedsysPaymentProvider } from '../../integrations/redsys'
import { confirmMockPayment, markPaymentRedirectPending } from '../../services/orders'
import { validateRuntimeConfiguration } from '../../utils/runtime-config'

const schema = z.object({
  orderId: z.string().regex(/^[A-Za-z0-9]{5,12}$/),
  token: z.string().uuid(),
  method: z.enum(['tarjeta', 'bizum'])
})

export default defineEventHandler(async (event) => {
  const body = await readValidatedBody(event, schema.parse)
  const runtime = validateRuntimeConfiguration(useRuntimeConfig(event))
  const correlationId = event.context.correlationId ?? crypto.randomUUID()

  if (runtime.paymentProvider === 'mock') {
    const order = await confirmMockPayment({
      publicNumber: body.orderId,
      guestToken: body.token,
      method: body.method,
      correlationId
    })
    return { ok: true, order, redirect: null }
  }

  const order = await markPaymentRedirectPending({
    publicNumber: body.orderId,
    guestToken: body.token,
    method: body.method
  })
  const provider = new RedsysPaymentProvider({
    environment: runtime.redsys.environment,
    merchantCode: runtime.redsys.merchantCode,
    terminal: runtime.redsys.terminal,
    secretKey: runtime.redsys.secretKey,
    currency: runtime.redsys.currency,
    merchantName: runtime.redsys.merchantName
  })
  const returnUrl = new URL('/pago/retorno', runtime.public.baseUrl)
  returnUrl.searchParams.set('order', order.public_number)
  const redirect = await provider.createRedirect({
    intentId: order.payment_intent_id,
    orderReference: order.public_number,
    amountCents: order.amount_cents,
    currency: 'EUR',
    method: body.method === 'tarjeta' ? 'card' : 'bizum',
    returnUrl: returnUrl.toString(),
    notificationUrl: new URL('/api/payments/redsys/notification', runtime.public.baseUrl).toString(),
    idempotencyKey: order.idempotency_key
  })
  return { ok: true, redirect }
})
