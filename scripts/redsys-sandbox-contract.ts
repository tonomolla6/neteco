import { randomBytes } from 'node:crypto'
import { REDSYS_REDIRECT_URLS, RedsysPaymentProvider } from '../server/integrations/redsys'

function required(name: string) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required for the opt-in Redsys sandbox contract`)
  return value
}

if (process.env.REDSYS_CONTRACT_SANDBOX !== '1') {
  throw new Error('Set REDSYS_CONTRACT_SANDBOX=1 to acknowledge the external sandbox request')
}
if (process.env.APP_ENV === 'production' || process.env.REDSYS_ENV !== 'sandbox') {
  throw new Error('The Redsys contract gate only runs with APP_ENV!=production and REDSYS_ENV=sandbox')
}

const callbackBaseUrl = new URL(required('REDSYS_CONTRACT_CALLBACK_BASE_URL'))
if (callbackBaseUrl.protocol !== 'https:') throw new Error('REDSYS_CONTRACT_CALLBACK_BASE_URL must use HTTPS')

const provider = new RedsysPaymentProvider({
  environment: 'sandbox',
  merchantCode: required('REDSYS_MERCHANT_CODE'),
  terminal: required('REDSYS_TERMINAL'),
  secretKey: required('REDSYS_SECRET_KEY'),
  currency: '978',
  merchantName: process.env.REDSYS_MERCHANT_NAME?.trim() || 'NETECO CONTRACT'
})
const orderReference = randomBytes(5).toString('hex').toUpperCase()
const redirect = await provider.createRedirect({
  intentId: `sandbox-contract:${orderReference}`,
  orderReference,
  amountCents: 145,
  currency: 'EUR',
  method: 'card',
  returnUrl: new URL(`/pedido/${orderReference}`, callbackBaseUrl).toString(),
  notificationUrl: new URL('/api/payments/redsys/notification', callbackBaseUrl).toString(),
  idempotencyKey: `sandbox-contract:${orderReference}`
})
if (redirect.actionUrl !== REDSYS_REDIRECT_URLS.sandbox) throw new Error('Unexpected Redsys sandbox endpoint')

const response = await fetch(redirect.actionUrl, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(redirect.fields as Record<string, string>),
  redirect: 'manual',
  signal: AbortSignal.timeout(10_000)
})
if (response.status < 200 || response.status >= 400) {
  throw new Error(`Redsys sandbox rejected the signed redirect (${response.status})`)
}

process.stdout.write(
  `${JSON.stringify({ event: 'redsys.sandbox.contract.accepted', status: response.status, orderReference })}\n`
)
