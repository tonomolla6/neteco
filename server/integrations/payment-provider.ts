export interface PaymentRequest {
  intentId: string
  orderReference: string
  amountCents: number
  currency: 'EUR'
  method: 'card' | 'bizum' | 'bank_transfer'
  returnUrl: string
  notificationUrl: string
  idempotencyKey: string
}

export interface PaymentRedirect {
  provider: string
  actionUrl: string
  method: 'POST'
  fields: Record<string, string>
  expiresAt: string
}

export interface PaymentNotification {
  providerEventId: string
  providerReference?: string
  orderReference: string
  amountCents: number
  currency: 'EUR'
  status: 'authorized' | 'captured' | 'pending' | 'failed' | 'cancelled'
  responseCode: string
  payloadHash: string
}

export interface RefundRequest {
  paymentReference: string
  orderReference: string
  amountCents: number
  reason: string
  idempotencyKey: string
}

export interface RefundResult {
  providerReference: string
  status: 'pending' | 'succeeded'
}

export interface PaymentProvider {
  readonly name: string
  createRedirect(request: PaymentRequest): Promise<PaymentRedirect>
  verifyNotification(payload: Record<string, string>): Promise<PaymentNotification>
  refund(request: RefundRequest): Promise<RefundResult>
}
