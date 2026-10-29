import { describe, expect, it } from 'vitest'
import { REDSYS_OFFICIAL_CONTRACT } from '../fixtures/redsys-official'
import {
  createRedsysRedirect,
  decodeMerchantParameters,
  deriveOperationKey,
  encodeMerchantParameters,
  signMerchantParameters,
  verifyMerchantSignature,
  verifyRedsysNotification
} from '../../workers/payments/redsys'

const configuration = {
  bizumEnabled: false,
  environment: 'sandbox' as const,
  merchantCode: REDSYS_OFFICIAL_CONTRACT.sandbox.merchantCode,
  merchantName: 'NETECO',
  secretKey: REDSYS_OFFICIAL_CONTRACT.sandbox.secretKey,
  terminal: REDSYS_OFFICIAL_CONTRACT.sandbox.terminal
}

describe('Worker-native Redsys HMAC_SHA512_V2', () => {
  it('rejects ambiguous parameter names and non-string signed values', () => {
    for (const json of [
      '{"Ds_Order":"12345","DS_ORDER":"54321"}',
      '{"Ds_Order":{"value":"12345"}}',
      '{"Ds_Order":12345}',
      '{"Ds_Order":null}'
    ]) {
      expect(() => decodeMerchantParameters(btoa(json))).toThrow('Invalid Redsys merchant parameters')
    }
  })

  it('rejects noncanonical encodings of an otherwise valid signature', async () => {
    const vector = REDSYS_OFFICIAL_CONTRACT.signature
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
    const last = alphabet.indexOf(vector.signature.at(-1)!)
    const alias = vector.signature.slice(0, -1) + alphabet[last + 1]
    // Only unused padding bits change: a permissive decoder accepts this alias.
    expect(Buffer.from(alias, 'base64url')).toEqual(Buffer.from(vector.signature, 'base64url'))
    await expect(verifyMerchantSignature(vector.merchantParameters, alias, configuration.secretKey)).resolves.toBe(
      false
    )
  })

  it('matches Redsys official AES operation-key and HMAC vectors', async () => {
    const vector = REDSYS_OFFICIAL_CONTRACT.signature
    const key = await deriveOperationKey(configuration.secretKey, vector.order)
    expect(btoa(String.fromCharCode(...key))).toBe(vector.operationKeyBase64)
    await expect(signMerchantParameters(vector.merchantParameters, configuration.secretKey)).resolves.toBe(
      vector.signature
    )
    await expect(
      verifyMerchantSignature(vector.merchantParameters, vector.signature, configuration.secretKey)
    ).resolves.toBe(true)
  })

  it('round-trips UTF-8 parameters and fails closed on malformed input', async () => {
    const encoded = encodeMerchantParameters({ Ds_Order: '12345', value: 'á' })
    expect(decodeMerchantParameters(encoded)).toEqual({ DS_ORDER: '12345', VALUE: 'á' })
    expect(() => decodeMerchantParameters('not-json')).toThrow('Invalid Redsys')
    expect(() => decodeMerchantParameters(btoa('[]'))).toThrow('Invalid Redsys')
    await expect(verifyMerchantSignature(encoded, 'broken', configuration.secretKey)).resolves.toBe(false)
    await expect(deriveOperationKey('á', '12345')).rejects.toThrow('single-byte ASCII')
    await expect(signMerchantParameters(encodeMerchantParameters({ VALUE: 'missing' }), 'secret')).rejects.toThrow(
      'order is missing'
    )
  })

  it('builds hosted card redirects and gates Bizum by terminal capability', async () => {
    const redirect = await createRedsysRedirect(configuration, {
      amountCents: 999,
      expiresAt: '2026-08-27T10:30:00Z',
      merchantOrder: '1234567890',
      method: 'card',
      notificationUrl: 'https://shop.example/api/payments/redsys/notification',
      returnUrl: 'https://shop.example/pago/retorno?order=internal-id'
    })
    expect(redirect).toMatchObject({
      actionUrl: 'https://sis-t.redsys.es:25443/sis/realizarPago',
      expiresAt: '2026-08-27T10:30:00Z',
      method: 'POST',
      provider: 'redsys'
    })
    expect(redirect.fields.Ds_SignatureVersion).toBe('HMAC_SHA512_V2')
    expect(decodeMerchantParameters(redirect.fields.Ds_MerchantParameters)).toMatchObject({
      DS_MERCHANT_AMOUNT: '999',
      DS_MERCHANT_CURRENCY: '978',
      DS_MERCHANT_MERCHANTURL: 'https://shop.example/api/payments/redsys/notification',
      DS_MERCHANT_ORDER: '1234567890',
      DS_MERCHANT_TERMINAL: '001'
    })
    expect(JSON.stringify(redirect)).not.toMatch(/pan|cvc|expirydate|cardnumber/i)
    await expect(
      createRedsysRedirect(configuration, {
        amountCents: 999,
        expiresAt: '2026-08-27T10:30:00Z',
        merchantOrder: '1234567890',
        method: 'bizum',
        notificationUrl: 'https://shop.example/notify',
        returnUrl: 'https://shop.example/return'
      })
    ).rejects.toThrow('Bizum is not enabled')
    const bizum = await createRedsysRedirect(
      { ...configuration, bizumEnabled: true },
      {
        amountCents: 999,
        expiresAt: '2026-08-27T10:30:00Z',
        merchantOrder: '1234567890',
        method: 'bizum',
        notificationUrl: 'https://shop.example/notify',
        returnUrl: 'https://shop.example/return'
      }
    )
    expect(decodeMerchantParameters(bizum.fields.Ds_MerchantParameters)).toMatchObject({
      DS_MERCHANT_PAYMETHODS: 'z'
    })
  })

  it('verifies normalized notification facts and rejects terminal/signature mismatches', async () => {
    const parameters = encodeMerchantParameters({
      Ds_Amount: '999',
      Ds_AuthorisationCode: 'ABC123',
      Ds_Currency: '978',
      Ds_MerchantCode: configuration.merchantCode,
      Ds_Order: '1234567890',
      Ds_Response: '0000',
      Ds_Terminal: '1',
      Ds_TransactionType: '0'
    })
    const envelope = {
      Ds_MerchantParameters: parameters,
      Ds_Signature: await signMerchantParameters(parameters, configuration.secretKey),
      Ds_SignatureVersion: 'HMAC_SHA512_V2'
    }
    await expect(verifyRedsysNotification(configuration, envelope)).resolves.toMatchObject({
      amountCents: 999,
      currencyCode: '978',
      merchantOrder: '1234567890',
      providerReference: '1234567890:ABC123',
      responseCode: '0000',
      status: 'captured'
    })
    await expect(verifyRedsysNotification(configuration, { ...envelope, Ds_Signature: 'invalid' })).rejects.toThrow(
      'signature'
    )
    const wrongTerminal = encodeMerchantParameters({
      ...decodeMerchantParameters(parameters),
      DS_TERMINAL: '2'
    })
    await expect(
      verifyRedsysNotification(configuration, {
        ...envelope,
        Ds_MerchantParameters: wrongTerminal,
        Ds_Signature: await signMerchantParameters(wrongTerminal, configuration.secretKey)
      })
    ).rejects.toThrow('configured terminal')
  })
})
