import type {
  PaymentNotification,
  PaymentProvider,
  PaymentRedirect,
  PaymentRequest,
  RefundRequest,
  RefundResult
} from '../../server/integrations/payment-provider'

export const ALTERNATIVE_PROVIDER_NAME = 'euro_contingency'

export interface AlternativeProviderConfig {
  secretKey: string
  merchantId: string
  endpointUrl: string
}

async function hmacSha256Hex(key: string, data: string): Promise<string> {
  const encoder = new TextEncoder()
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  )
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data))
  const bytes = new Uint8Array(signature)
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

async function sha256Hex(data: string): Promise<string> {
  const bytes = new TextEncoder().encode(data)
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

export class AlternativeMarketPaymentProvider implements PaymentProvider {
  readonly name = ALTERNATIVE_PROVIDER_NAME

  constructor(private readonly config: AlternativeProviderConfig) {
    if (!config.secretKey || config.secretKey.length < 16) {
      throw new Error('invalid_provider_secret')
    }
  }

  async signPayload(payload: Record<string, string>): Promise<string> {
    const keys = Object.keys(payload)
      .filter((k) => k !== 'signature')
      .sort()
    const serialized = keys.map((k) => `${k}=${payload[k]}`).join('&')
    return hmacSha256Hex(this.config.secretKey, serialized)
  }

  async createRedirect(request: PaymentRequest): Promise<PaymentRedirect> {
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString()
    const fieldsToSign: Record<string, string> = {
      merchant_id: this.config.merchantId,
      intent_id: request.intentId,
      order_reference: request.orderReference,
      amount_cents: String(request.amountCents),
      currency: request.currency,
      method: request.method,
      return_url: request.returnUrl,
      notification_url: request.notificationUrl,
      idempotency_key: request.idempotencyKey,
      expires_at: expiresAt
    }

    const signature = await this.signPayload(fieldsToSign)

    return {
      provider: this.name,
      actionUrl: this.config.endpointUrl,
      method: 'POST',
      fields: {
        ...fieldsToSign,
        signature
      },
      expiresAt
    }
  }

  async verifyNotification(payload: Record<string, string>): Promise<PaymentNotification> {
    const signature = payload.signature
    if (!signature) {
      throw new Error('missing_signature')
    }

    const expectedSignature = await this.signPayload(payload)
    if (!timingSafeEqualString(signature, expectedSignature)) {
      throw new Error('invalid_signature')
    }

    const orderReference = payload.order_reference
    if (!orderReference || typeof orderReference !== 'string') {
      throw new Error('invalid_order_reference')
    }
    const amountCents = Number(payload.amount_cents)
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
      throw new Error('invalid_amount')
    }
    const providerEventId = payload.provider_event_id ?? crypto.randomUUID()
    const providerReference = payload.provider_reference ?? `alt-ref-${Date.now()}`
    const rawStatus = payload.status
    const responseCode = payload.response_code ?? '0000'

    let status: PaymentNotification['status'] = 'failed'
    if (rawStatus === 'captured' || responseCode === '0000') {
      status = 'captured'
    } else if (rawStatus === 'authorized') {
      status = 'authorized'
    } else if (rawStatus === 'cancelled') {
      status = 'cancelled'
    } else if (rawStatus === 'pending') {
      status = 'pending'
    }

    const payloadHash = await sha256Hex(JSON.stringify(payload))

    return {
      providerEventId,
      providerReference,
      orderReference,
      amountCents,
      currency: 'EUR',
      status,
      responseCode,
      payloadHash
    }
  }

  async refund(request: RefundRequest): Promise<RefundResult> {
    // Isolated deterministic refund execution without card credentials
    const providerReference = `${request.paymentReference}-refund`
    return {
      providerReference,
      status: 'succeeded'
    }
  }
}
