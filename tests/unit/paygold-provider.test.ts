import { expect, it, vi } from 'vitest'
import { createBoundPayGoldProvider } from '../../workers/payments/paygold-provider'
const input = {
  paymentIntentId: '68000000-0000-4000-8000-000000000004',
  amountCents: 1500,
  expiresAt: '2026-10-30T12:00:00Z',
  redirect: {
    actionUrl: 'https://sis-t.redsys.es:25443/sis/realizarPago',
    method: 'POST' as const,
    fields: { Ds_MerchantParameters: 'test', Ds_Signature: 'sig', Ds_SignatureVersion: 'HMAC_SHA512_V2' as const }
  },
  idempotencyKey: 'paygold:synthetic'
}
it('uses only the configured internal service and preserves the checkout redirect and expiry', async () => {
  const fetch = vi.fn(async (request: Request) => {
    expect(new URL(request.url).hostname).toBe('paygold.internal')
    expect(await request.json()).toEqual(input)
    return Response.json({ url: 'https://paygold.example.invalid/link', expiresAt: input.expiresAt })
  })
  expect(await createBoundPayGoldProvider({ fetch }).create(input)).toEqual({
    url: 'https://paygold.example.invalid/link',
    expiresAt: input.expiresAt
  })
  expect(fetch).toHaveBeenCalledTimes(1)
})
it.each([400, 500])('rejects provider HTTP status %s', async (status) => {
  await expect(
    createBoundPayGoldProvider({
      fetch: async () =>
        Response.json({ url: 'https://paygold.example.invalid/link', expiresAt: input.expiresAt }, { status })
    }).create(input)
  ).rejects.toThrow()
})
it.each([
  { url: 'https://paygold.example.invalid/link', expiresAt: input.expiresAt, extra: 'x' },
  { url: 'bad', expiresAt: input.expiresAt },
  null
])('rejects untrusted response shape %#', async (body) => {
  await expect(createBoundPayGoldProvider({ fetch: async () => Response.json(body) }).create(input)).rejects.toThrow()
})
it('rejects an oversized provider response', async () => {
  await expect(
    createBoundPayGoldProvider({
      fetch: async () => new Response('x'.repeat(5000), { headers: { 'content-type': 'application/json' } })
    }).create(input)
  ).rejects.toThrow()
})
