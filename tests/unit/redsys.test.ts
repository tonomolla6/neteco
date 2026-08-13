import { describe, expect, it, vi } from 'vitest'
import { deterministicUuid } from '../fixtures/deterministic'
import { REDSYS_OFFICIAL_CONTRACT } from '../fixtures/redsys-official'
import {
  decodeMerchantParameters,
  deriveOperationKey,
  encodeMerchantParameters,
  RedsysPaymentProvider,
  signMerchantParameters,
  verifyMerchantSignature
} from '../../server/integrations/redsys'

const SECRET = REDSYS_OFFICIAL_CONTRACT.sandbox.secretKey

function provider(
  fetcher: typeof fetch = fetch,
  overrides: Partial<ConstructorParameters<typeof RedsysPaymentProvider>[0]> = {}
) {
  return new RedsysPaymentProvider(
    {
      environment: 'sandbox',
      merchantCode: REDSYS_OFFICIAL_CONTRACT.sandbox.merchantCode,
      terminal: REDSYS_OFFICIAL_CONTRACT.sandbox.terminal,
      secretKey: SECRET,
      merchantName: 'NETECO',
      ...overrides
    },
    fetcher
  )
}

function signedNotification(response = '0000', overrides: Record<string, string | undefined> = {}) {
  const values = {
    Ds_Order: '1234567890',
    Ds_Amount: '999',
    Ds_Currency: '978',
    Ds_MerchantCode: '999008881',
    Ds_Terminal: '1',
    Ds_TransactionType: '0',
    Ds_Response: response,
    Ds_Date: '13/08/2026',
    Ds_Hour: '12:00',
    ...overrides
  }
  const merchantParameters = encodeMerchantParameters(
    Object.fromEntries(Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined))
  )
  return {
    Ds_SignatureVersion: 'HMAC_SHA512_V2',
    Ds_MerchantParameters: merchantParameters,
    Ds_Signature: signMerchantParameters(merchantParameters, SECRET, '1234567890')
  }
}

function refundResponse(amount: string, overrides: Record<string, string> = {}) {
  return encodeMerchantParameters({
    Ds_Order: '1234567890',
    Ds_Amount: amount,
    Ds_Currency: '978',
    Ds_MerchantCode: '999008881',
    Ds_Terminal: '1',
    Ds_TransactionType: '3',
    Ds_Response: '0900',
    ...overrides
  })
}

describe('Redsys HMAC_SHA512_V2', () => {
  it('matches the official operation-key and signature vectors', () => {
    const vector = REDSYS_OFFICIAL_CONTRACT.signature
    expect(deriveOperationKey(SECRET, vector.order).toString('base64')).toBe(vector.operationKeyBase64)
    expect(signMerchantParameters(vector.merchantParameters, SECRET)).toBe(vector.signature)
    expect(verifyMerchantSignature(vector.merchantParameters, vector.signature, SECRET)).toBe(true)
    expect(REDSYS_OFFICIAL_CONTRACT.sources.signature).toMatch(/^https:\/\/pagosonline\.redsys\.es\//)
  })

  it('round-trips parameters and rejects malformed values and signatures', () => {
    const encoded = encodeMerchantParameters({ Ds_Order: '12345', value: 'á' })
    expect(decodeMerchantParameters(encoded)).toEqual({ DS_ORDER: '12345', VALUE: 'á' })
    expect(() => decodeMerchantParameters('not-json')).toThrow('Invalid Redsys')
    expect(() =>
      decodeMerchantParameters(encodeMerchantParameters({}) && Buffer.from('null').toString('base64url'))
    ).toThrow('Invalid Redsys')
    expect(() => decodeMerchantParameters(Buffer.from('[]').toString('base64url'))).toThrow('Invalid Redsys')
    expect(verifyMerchantSignature(encoded, 'broken', SECRET)).toBe(false)
    expect(() => deriveOperationKey('á', '12345')).toThrow('single-byte')
    expect(() => signMerchantParameters(encodeMerchantParameters({ VALUE: 'missing-order' }), SECRET)).toThrow(
      'order is missing'
    )
    for (const invalidOrder of ['x123456789012', '123456789012x']) {
      expect(() => deriveOperationKey(SECRET, invalidOrder)).toThrow()
    }
  })
})

describe('Redsys payment provider', () => {
  it('creates card and Bizum hosted redirects without payment credentials', async () => {
    const base = {
      intentId: deterministicUuid('unit:redsys:intent'),
      orderReference: '1234567890',
      amountCents: 999,
      currency: 'EUR' as const,
      returnUrl: 'https://shop.example/pedido/NE-1',
      notificationUrl: 'https://shop.example/api/payments/redsys/notification',
      idempotencyKey: 'test'
    }
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-12T10:00:00.000Z'))
    const card = await provider().createRedirect({ ...base, method: 'card' })
    const bizum = await provider().createRedirect({ ...base, method: 'bizum' })
    vi.useRealTimers()
    expect(card).toMatchObject({
      provider: 'redsys',
      actionUrl: 'https://sis-t.redsys.es:25443/sis/realizarPago',
      method: 'POST',
      expiresAt: '2026-08-12T10:30:00.000Z'
    })
    expect(card.fields.Ds_SignatureVersion).toBe('HMAC_SHA512_V2')
    expect(decodeMerchantParameters(card.fields.Ds_MerchantParameters!)).toEqual({
      DS_MERCHANT_ORDER: '1234567890',
      DS_MERCHANT_MERCHANTCODE: '999008881',
      DS_MERCHANT_TERMINAL: '001',
      DS_MERCHANT_CURRENCY: '978',
      DS_MERCHANT_TRANSACTIONTYPE: '0',
      DS_MERCHANT_AMOUNT: '999',
      DS_MERCHANT_MERCHANTURL: 'https://shop.example/api/payments/redsys/notification',
      DS_MERCHANT_URLOK: 'https://shop.example/pedido/NE-1?payment=returned',
      DS_MERCHANT_URLKO: 'https://shop.example/pedido/NE-1?payment=failed',
      DS_MERCHANT_MERCHANTNAME: 'NETECO'
    })
    expect(decodeMerchantParameters(bizum.fields.Ds_MerchantParameters!)).toMatchObject({
      DS_MERCHANT_AMOUNT: '999',
      DS_MERCHANT_PAYMETHODS: 'z'
    })
    expect(JSON.stringify(card)).not.toMatch(/pan|cvc|cardnumber/i)
    await expect(provider().createRedirect({ ...base, method: 'bank_transfer' })).rejects.toThrow('Bank transfer')
    await expect(provider().createRedirect({ ...base, amountCents: 0, method: 'card' })).rejects.toThrow(
      'positive safe integer'
    )
    await expect(provider().createRedirect({ ...base, amountCents: 1.5, method: 'card' })).rejects.toThrow(
      'positive safe integer'
    )
    await expect(provider().createRedirect({ ...base, currency: 'USD' as 'EUR', method: 'card' })).rejects.toThrow(
      'exclusively for EUR'
    )
    expect(() => provider(undefined, { currency: '840' })).toThrow()
    const production = await provider(undefined, {
      environment: 'production',
      merchantCode: '123456789',
      secretKey: 'unit-only-noncredential-key',
      currency: '978'
    }).createRedirect({ ...base, method: 'card' })
    expect(production.actionUrl).toBe('https://sis.redsys.es/sis/realizarPago')
    for (const orderReference of ['x123456789012', '123456789012x']) {
      await expect(provider().createRedirect({ ...base, orderReference, method: 'card' })).rejects.toThrow()
    }
    for (const merchantCode of ['x999008881', '999008881x']) {
      expect(() => provider(undefined, { merchantCode })).toThrow()
    }
    for (const terminal of ['x1', '1x', '1234']) {
      expect(() => provider(undefined, { terminal })).toThrow()
    }
  })

  it.each(REDSYS_OFFICIAL_CONTRACT.responseCases)('maps official response %s to %s', async (response, status) => {
    const result = await provider().verifyNotification(signedNotification(response))
    expect(result).toMatchObject({
      orderReference: '1234567890',
      amountCents: 999,
      currency: 'EUR',
      status,
      responseCode: response
    })
    expect(result.providerEventId).toBe(`1234567890:0:${response}:occurred:13/08/2026:12:00`)
    expect(result.payloadHash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('rejects tampering and terminal mismatches', async () => {
    const tampered = signedNotification()
    tampered.Ds_Signature = `x${tampered.Ds_Signature}`
    await expect(provider().verifyNotification(tampered)).rejects.toThrow('Invalid Redsys signature')
    await expect(
      provider().verifyNotification(signedNotification('0000', { Ds_MerchantCode: '123456789' }))
    ).rejects.toThrow('configured terminal')
    await expect(provider().verifyNotification(signedNotification('0000', { Ds_Terminal: '2' }))).rejects.toThrow(
      'configured terminal'
    )
    await expect(provider().verifyNotification(signedNotification('0000', { Ds_Currency: '840' }))).rejects.toThrow(
      'configured terminal'
    )
    await expect(
      provider().verifyNotification(signedNotification('0000', { Ds_TransactionType: '1' }))
    ).rejects.toThrow('configured terminal')
    for (const overrides of [
      { Ds_Order: 'x123456789012' },
      { Ds_Order: '123456789012x' },
      { Ds_Amount: 'x999' },
      { Ds_Amount: '999x' },
      { Ds_Currency: 'x978' },
      { Ds_Currency: '978x' },
      { Ds_Response: 'x0000' },
      { Ds_Response: '0000x' }
    ]) {
      await expect(provider().verifyNotification(signedNotification('0000', overrides))).rejects.toThrow()
    }
    await expect(provider().verifyNotification(signedNotification('0000', { Ds_Amount: '0' }))).rejects.toThrow(
      'Invalid Redsys amount'
    )
  })

  it('accepts the all-uppercase notification envelope used by some Redsys clients', async () => {
    const signed = signedNotification()
    await expect(
      provider().verifyNotification({
        DS_SIGNATUREVERSION: signed.Ds_SignatureVersion,
        DS_MERCHANTPARAMETERS: signed.Ds_MerchantParameters,
        DS_SIGNATURE: signed.Ds_Signature
      })
    ).resolves.toMatchObject({ status: 'captured', responseCode: '0000' })
  })

  it('uses a stable authorization reference and deterministic fallback without optional occurrence fields', async () => {
    await expect(
      provider().verifyNotification(signedNotification('0000', { Ds_AuthorisationCode: 'AUTH42' }))
    ).resolves.toMatchObject({
      providerEventId: '1234567890:0:0000:authorization:AUTH42',
      providerReference: '1234567890:AUTH42'
    })
    await expect(
      provider().verifyNotification(signedNotification('0000', { Ds_Date: undefined, Ds_Hour: undefined }))
    ).resolves.toMatchObject({
      providerEventId: '1234567890:0:0000:occurred:unknown:unknown',
      providerReference: undefined
    })
  })

  it('sends and validates a signed refund', async () => {
    const responseParameters = refundResponse('500', { Ds_AuthorisationCode: 'ABC123' })
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          Ds_SignatureVersion: 'HMAC_SHA512_V2',
          Ds_MerchantParameters: responseParameters,
          Ds_Signature: signMerchantParameters(responseParameters, SECRET)
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    )
    await expect(
      provider(fetcher).refund({
        paymentReference: 'pay-1',
        orderReference: '1234567890',
        amountCents: 500,
        reason: 'customer_request',
        idempotencyKey: 'refund-1'
      })
    ).resolves.toEqual({ providerReference: 'ABC123', status: 'succeeded' })
    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher.mock.calls[0]![0]).toBe('https://sis-t.redsys.es:25443/sis/rest/trataPeticionREST')
    expect(fetcher.mock.calls[0]![1]).toMatchObject({
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' }
    })
    const requestEnvelope = JSON.parse(String(fetcher.mock.calls[0]![1]?.body)) as Record<string, string>
    expect(requestEnvelope.Ds_SignatureVersion).toBe('HMAC_SHA512_V2')
    expect(decodeMerchantParameters(requestEnvelope.Ds_MerchantParameters!)).toEqual({
      DS_MERCHANT_ORDER: '1234567890',
      DS_MERCHANT_MERCHANTCODE: '999008881',
      DS_MERCHANT_TERMINAL: '001',
      DS_MERCHANT_CURRENCY: '978',
      DS_MERCHANT_TRANSACTIONTYPE: '3',
      DS_MERCHANT_AMOUNT: '500'
    })
  })

  it('uses the payment reference when Redsys omits an authorization code', async () => {
    const responseParameters = refundResponse('1')
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          Ds_SignatureVersion: 'HMAC_SHA512_V2',
          Ds_MerchantParameters: responseParameters,
          Ds_Signature: signMerchantParameters(responseParameters, SECRET)
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    )
    await expect(
      provider(fetcher).refund({
        paymentReference: 'pay-fallback',
        orderReference: '1234567890',
        amountCents: 1,
        reason: 'customer_request',
        idempotencyKey: 'refund-fallback'
      })
    ).resolves.toEqual({ providerReference: 'pay-fallback', status: 'succeeded' })
  })

  it('fails closed on invalid refund requests and provider responses', async () => {
    const request = {
      paymentReference: 'pay-1',
      orderReference: '1234567890',
      amountCents: 500,
      reason: 'customer_request',
      idempotencyKey: 'refund-errors'
    }
    await expect(provider().refund({ ...request, amountCents: 0 })).rejects.toThrow('positive safe integer')
    await expect(provider().refund({ ...request, amountCents: 1.5 })).rejects.toThrow('positive safe integer')

    await expect(
      provider(vi.fn<typeof fetch>().mockResolvedValue(new Response('down', { status: 503 }))).refund(request)
    ).rejects.toThrow('transport failed')

    const validParameters = refundResponse('500')
    const invalidSignatureFetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          Ds_SignatureVersion: 'HMAC_SHA512_V2',
          Ds_MerchantParameters: validParameters,
          Ds_Signature: 'invalid'
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    )
    await expect(provider(invalidSignatureFetcher).refund(request)).rejects.toThrow('refund signature')

    for (const parameters of [
      refundResponse('500', { Ds_Order: '9999999999' }),
      refundResponse('500', { Ds_Response: '0101' }),
      refundResponse('499'),
      refundResponse('500', { Ds_Currency: '840' }),
      refundResponse('500', { Ds_MerchantCode: '123456789' }),
      refundResponse('500', { Ds_Terminal: '2' }),
      refundResponse('500', { Ds_TransactionType: '0' })
    ]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            Ds_SignatureVersion: 'HMAC_SHA512_V2',
            Ds_MerchantParameters: parameters,
            Ds_Signature: signMerchantParameters(parameters, SECRET)
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
      await expect(provider(fetcher).refund(request)).rejects.toThrow()
    }
  })
})
