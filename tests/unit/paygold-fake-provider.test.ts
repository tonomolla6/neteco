import { expect, it } from 'vitest'
import { createFakePayGoldService } from './paygold-fake-fixture'
const body = {
  paymentIntentId: '68000000-0000-4000-8000-000000000004',
  amountCents: 1500,
  expiresAt: '2030-01-01T12:05:00Z',
  redirect: {
    actionUrl: 'https://sis-t.redsys.es:25443/sis/realizarPago',
    method: 'POST',
    fields: { Ds_MerchantParameters: 'test', Ds_Signature: 'sig', Ds_SignatureVersion: 'HMAC_SHA512_V2' }
  },
  idempotencyKey: 'paygold:synthetic'
}
const request = (input: unknown = body) =>
  new Request('https://paygold.internal/create', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input)
  })
it('returns the same synthetic link on replay and rejects conflicting command data', async () => {
  const fake = createFakePayGoldService('https://paygold.example.test')
  const first = await fake.fetch(request()),
    second = await fake.fetch(request())
  expect(await first.json()).toEqual(await second.json())
  expect((await fake.fetch(request({ ...body, amountCents: 1501 }))).status).toBe(409)
})
it('redeems only the exact unexpired link and never contacts a real provider', async () => {
  const fake = createFakePayGoldService('https://paygold.example.test')
  const created = (await (await fake.fetch(request())).json()) as { url: string; expiresAt: string }
  expect(fake.redeem(created.url, '2030-01-01T12:04:59Z')).toEqual(body.redirect)
  expect(fake.redeem(created.url, created.expiresAt)).toBeNull()
  expect(fake.redeem(`${created.url}x`, '2030-01-01T12:00:00Z')).toBeNull()
  expect(fake.redeem(created.url, 'invalid')).toBeNull()
})
it('rejects malformed inputs without issuing a link', async () => {
  const fake = createFakePayGoldService('https://paygold.example.test')
  expect((await fake.fetch(request({ ...body, amountCents: 0 }))).status).toBe(400)
  expect((await fake.fetch(request({ ...body, extra: true }))).status).toBe(400)
})
