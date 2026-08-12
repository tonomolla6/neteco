import { createCipheriv, createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import type {
  PaymentNotification,
  PaymentProvider,
  PaymentRedirect,
  PaymentRequest,
  RefundRequest,
  RefundResult
} from './payment-provider'

export const REDSYS_SIGNATURE_VERSION = 'HMAC_SHA512_V2'
export const REDSYS_REDIRECT_URLS = {
  sandbox: 'https://sis-t.redsys.es:25443/sis/realizarPago',
  production: 'https://sis.redsys.es/sis/realizarPago'
} as const
export const REDSYS_REST_URLS = {
  sandbox: 'https://sis-t.redsys.es:25443/sis/rest/trataPeticionREST',
  production: 'https://sis.redsys.es/sis/rest/trataPeticionREST'
} as const

const orderSchema = z.string().regex(/^[A-Za-z0-9]{5,12}$/)
const merchantCodeSchema = z.string().regex(/^\d{9}$/)
const terminalSchema = z.string().regex(/^\d{1,3}$/)

const notificationParametersSchema = z
  .object({
    DS_ORDER: orderSchema,
    DS_AMOUNT: z.string().regex(/^\d{1,12}$/),
    DS_CURRENCY: z.string().regex(/^\d{3}$/),
    DS_MERCHANTCODE: merchantCodeSchema,
    DS_TERMINAL: terminalSchema,
    DS_TRANSACTIONTYPE: z.string(),
    DS_RESPONSE: z.string().regex(/^\d{1,4}$/),
    DS_AUTHORISATIONCODE: z.string().optional()
  })
  .passthrough()

const signedEnvelopeSchema = z.object({
  Ds_SignatureVersion: z.literal(REDSYS_SIGNATURE_VERSION),
  Ds_MerchantParameters: z.string().min(1),
  Ds_Signature: z.string().min(1)
})

type RedsysParameters = Record<string, string>
type Fetcher = typeof globalThis.fetch

export interface RedsysConfiguration {
  environment: keyof typeof REDSYS_REDIRECT_URLS
  merchantCode: string
  terminal: string
  secretKey: string
  currency?: string
  merchantName: string
}

function base64Url(buffer: Buffer) {
  return buffer.toString('base64url')
}

export function encodeMerchantParameters(parameters: RedsysParameters) {
  return base64Url(Buffer.from(JSON.stringify(parameters), 'utf8'))
}

export function decodeMerchantParameters(encoded: string): RedsysParameters {
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  } catch {
    throw new Error('Invalid Redsys merchant parameters')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid Redsys merchant parameters')
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key.toUpperCase(), String(entry)]))
}

export function deriveOperationKey(secretKey: string, orderReference: string) {
  const order = orderSchema.parse(orderReference)
  const key = Buffer.from(secretKey.slice(0, 16).padEnd(16, '0'), 'utf8')
  if (key.byteLength !== 16) throw new Error('Redsys secret must start with single-byte characters')
  const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16))
  return Buffer.concat([cipher.update(order, 'utf8'), cipher.final()])
}

export function signMerchantParameters(merchantParameters: string, secretKey: string, orderReference?: string) {
  const decoded = orderReference ? undefined : decodeMerchantParameters(merchantParameters)
  const order = orderReference ?? decoded?.DS_ORDER ?? decoded?.DS_MERCHANT_ORDER
  if (!order) throw new Error('Redsys order is missing')
  return base64Url(
    createHmac('sha512', deriveOperationKey(secretKey, order).toString('base64'))
      .update(merchantParameters, 'utf8')
      .digest()
  )
}

export function verifyMerchantSignature(merchantParameters: string, signature: string, secretKey: string) {
  const expected = Buffer.from(signMerchantParameters(merchantParameters, secretKey), 'base64url')
  const actual = Buffer.from(signature, 'base64url')
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected)
}

function notificationStatus(responseCode: string): PaymentNotification['status'] {
  const response = Number(responseCode)
  if (response >= 0 && response <= 99) return 'captured'
  if ([9997, 9998, 9999].includes(response)) return 'pending'
  if (response === 9915) return 'cancelled'
  return 'failed'
}

function paddedTerminal(terminal: string) {
  return terminal.padStart(3, '0')
}

function expiresIn(minutes: number) {
  return new Date(Date.now() + minutes * 60_000).toISOString()
}

export class RedsysPaymentProvider implements PaymentProvider {
  readonly name = 'redsys'
  readonly configuration: Required<RedsysConfiguration>

  constructor(
    configuration: RedsysConfiguration,
    private readonly fetcher: Fetcher = globalThis.fetch
  ) {
    this.configuration = {
      ...configuration,
      merchantCode: merchantCodeSchema.parse(configuration.merchantCode),
      terminal: paddedTerminal(terminalSchema.parse(configuration.terminal)),
      currency: configuration.currency ?? '978',
      secretKey: z.string().min(1).parse(configuration.secretKey),
      merchantName: z.string().min(1).max(25).parse(configuration.merchantName)
    }
  }

  async createRedirect(request: PaymentRequest): Promise<PaymentRedirect> {
    const orderReference = orderSchema.parse(request.orderReference)
    if (request.currency !== 'EUR' || this.configuration.currency !== '978') {
      throw new Error('Redsys provider is configured exclusively for EUR')
    }
    if (!Number.isSafeInteger(request.amountCents) || request.amountCents <= 0) {
      throw new Error('Redsys amount must be a positive safe integer')
    }
    if (request.method === 'bank_transfer') {
      throw new Error('Bank transfer is not a Redsys redirect method')
    }
    const returnUrl = new URL(request.returnUrl)
    const failureUrl = new URL(request.returnUrl)
    returnUrl.searchParams.set('payment', 'returned')
    failureUrl.searchParams.set('payment', 'failed')

    const parameters: RedsysParameters = {
      DS_MERCHANT_ORDER: orderReference,
      DS_MERCHANT_MERCHANTCODE: this.configuration.merchantCode,
      DS_MERCHANT_TERMINAL: this.configuration.terminal,
      DS_MERCHANT_CURRENCY: this.configuration.currency,
      DS_MERCHANT_TRANSACTIONTYPE: '0',
      DS_MERCHANT_AMOUNT: String(request.amountCents),
      DS_MERCHANT_MERCHANTURL: new URL(request.notificationUrl).toString(),
      DS_MERCHANT_URLOK: returnUrl.toString(),
      DS_MERCHANT_URLKO: failureUrl.toString(),
      DS_MERCHANT_MERCHANTNAME: this.configuration.merchantName
    }
    if (request.method === 'bizum') parameters.DS_MERCHANT_PAYMETHODS = 'z'

    const merchantParameters = encodeMerchantParameters(parameters)
    return {
      provider: this.name,
      actionUrl: REDSYS_REDIRECT_URLS[this.configuration.environment],
      method: 'POST',
      fields: {
        Ds_SignatureVersion: REDSYS_SIGNATURE_VERSION,
        Ds_MerchantParameters: merchantParameters,
        Ds_Signature: signMerchantParameters(merchantParameters, this.configuration.secretKey, orderReference)
      },
      expiresAt: expiresIn(30)
    }
  }

  async verifyNotification(payload: Record<string, string>): Promise<PaymentNotification> {
    const envelope = signedEnvelopeSchema.parse({
      Ds_SignatureVersion: payload.Ds_SignatureVersion ?? payload.DS_SIGNATUREVERSION,
      Ds_MerchantParameters: payload.Ds_MerchantParameters ?? payload.DS_MERCHANTPARAMETERS,
      Ds_Signature: payload.Ds_Signature ?? payload.DS_SIGNATURE
    })
    if (!verifyMerchantSignature(envelope.Ds_MerchantParameters, envelope.Ds_Signature, this.configuration.secretKey)) {
      throw new Error('Invalid Redsys signature')
    }
    const parameters = notificationParametersSchema.parse(decodeMerchantParameters(envelope.Ds_MerchantParameters))
    if (
      parameters.DS_MERCHANTCODE !== this.configuration.merchantCode ||
      paddedTerminal(parameters.DS_TERMINAL) !== this.configuration.terminal ||
      parameters.DS_CURRENCY !== this.configuration.currency ||
      parameters.DS_TRANSACTIONTYPE !== '0'
    ) {
      throw new Error('Redsys notification does not match the configured terminal')
    }

    const payloadHash = createHash('sha256').update(envelope.Ds_MerchantParameters, 'utf8').digest('hex')
    return {
      providerEventId: `${parameters.DS_ORDER}:${parameters.DS_RESPONSE}:${payloadHash.slice(0, 16)}`,
      orderReference: parameters.DS_ORDER,
      amountCents: Number(parameters.DS_AMOUNT),
      currency: 'EUR',
      status: notificationStatus(parameters.DS_RESPONSE),
      responseCode: parameters.DS_RESPONSE.padStart(4, '0'),
      payloadHash
    }
  }

  async refund(request: RefundRequest): Promise<RefundResult> {
    const orderReference = orderSchema.parse(request.orderReference)
    if (!Number.isSafeInteger(request.amountCents) || request.amountCents <= 0) {
      throw new Error('Refund amount must be a positive safe integer')
    }
    const merchantParameters = encodeMerchantParameters({
      DS_MERCHANT_ORDER: orderReference,
      DS_MERCHANT_MERCHANTCODE: this.configuration.merchantCode,
      DS_MERCHANT_TERMINAL: this.configuration.terminal,
      DS_MERCHANT_CURRENCY: this.configuration.currency,
      DS_MERCHANT_TRANSACTIONTYPE: '3',
      DS_MERCHANT_AMOUNT: String(request.amountCents)
    })
    const response = await this.fetcher(REDSYS_REST_URLS[this.configuration.environment], {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        Ds_SignatureVersion: REDSYS_SIGNATURE_VERSION,
        Ds_MerchantParameters: merchantParameters,
        Ds_Signature: signMerchantParameters(merchantParameters, this.configuration.secretKey, orderReference)
      })
    })
    if (!response.ok) throw new Error(`Redsys refund transport failed (${response.status})`)
    const envelope = signedEnvelopeSchema.parse(await response.json())
    if (!verifyMerchantSignature(envelope.Ds_MerchantParameters, envelope.Ds_Signature, this.configuration.secretKey)) {
      throw new Error('Invalid Redsys refund signature')
    }
    const parameters = decodeMerchantParameters(envelope.Ds_MerchantParameters)
    if (parameters.DS_ORDER !== orderReference || parameters.DS_RESPONSE !== '0900') {
      throw new Error(`Redsys refund rejected (${parameters.DS_RESPONSE ?? 'unknown'})`)
    }
    return {
      providerReference: parameters.DS_AUTHORISATIONCODE ?? request.paymentReference,
      status: 'succeeded'
    }
  }
}
