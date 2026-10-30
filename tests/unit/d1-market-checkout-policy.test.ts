import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { returnsFixture, CLAIMS, BUYER_CLAIMS, utc } from './d1-returns-fixture'
import {
  configureCheckoutMarket,
  readCheckoutMarket,
  calculateCheckoutMarket
} from '../../workers/catalog/market-checkout-policy'
let f: Awaited<ReturnType<typeof returnsFixture>>
const key = '11111111-1111-4111-8111-111111111111',
  second = '22222222-2222-4222-8222-222222222222'
const opts = { now: () => utc() }
const input = {
  market: 'GB',
  currency: 'GBP',
  expectedVersion: 0,
  exchangeNumerator: 86,
  exchangeDenominator: 100,
  goodsTaxBps: 2000,
  shippingNetMinor: 450,
  shippingTaxBps: 2000,
  termsVersion: 'gb-terms-v1',
  paymentMethods: ['card', 'bank_transfer']
} as const
beforeEach(async () => {
  f = await returnsFixture()
  f.sqlite.exec(await readFile('db/d1/migrations/0106_inventory_lots_costing_forecast.sql', 'utf8'))
  f.sqlite.exec(await readFile('db/d1/migrations/0118_recall_market_messaging.sql', 'utf8'))
})
afterEach(() => f?.sqlite.close())
const save = (raw: unknown = input, id = key, claims = CLAIMS) =>
  configureCheckoutMarket(f.database, claims, id, raw, opts)
it('persists an audited market profile and exact idempotent replay', async () => {
  const receipt = await save()
  expect(receipt).toMatchObject({ market: 'GB', version: 1 })
  expect(await save()).toEqual(receipt)
  expect(await readCheckoutMarket(f.database, CLAIMS, 'GB', opts)).toMatchObject({
    currency: 'GBP',
    version: 1,
    termsVersion: 'gb-terms-v1',
    paymentMethods: ['card', 'bank_transfer']
  })
})
it('calculates exchange, goods and shipping taxes using one profile', async () => {
  await save()
  const profile = await readCheckoutMarket(f.database, CLAIMS, 'GB', opts)
  expect(calculateCheckoutMarket(profile, 10000)).toMatchObject({
    market: 'GB',
    currency: 'GBP',
    goodsNetMinor: 8600,
    goodsTaxMinor: 1720,
    shippingNetMinor: 450,
    shippingTaxMinor: 90,
    totalMinor: 10860,
    termsVersion: 'gb-terms-v1',
    paymentMethods: ['card', 'bank_transfer']
  })
})
it('rejects changed idempotency payload and stale version', async () => {
  await save()
  await expect(save({ ...input, currency: 'EUR' })).rejects.toMatchObject({ code: 'conflict' })
  await expect(save(input, second)).rejects.toMatchObject({ code: 'conflict' })
})
it('records the next version without changing the previous snapshot', async () => {
  await save()
  await save({ ...input, expectedVersion: 1, goodsTaxBps: 2100 }, second)
  expect((await readCheckoutMarket(f.database, CLAIMS, 'GB', opts)).version).toBe(2)
  expect(f.sqlite.prepare('SELECT count(*) n FROM checkout_market_commands').get()).toEqual({ n: 2 })
  expect(() => f.sqlite.exec('DELETE FROM checkout_market_commands')).toThrow()
})
it('rejects unauthorized and revoked administrators', async () => {
  await expect(save(input, key, BUYER_CLAIMS)).rejects.toMatchObject({ code: 'mfa_required' })
  f.sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(utc(), CLAIMS.sessionId)
  await expect(save()).rejects.toMatchObject({ code: 'unauthenticated' })
})
it('enforces live authority at commit', async () => {
  const batch = f.database.batch.bind(f.database)
  f.database.batch = async (statements) => {
    f.sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(utc(), CLAIMS.sessionId)
    return batch(statements)
  }
  await expect(save()).rejects.toMatchObject({ code: 'unauthenticated' })
  expect(f.sqlite.prepare('SELECT count(*) n FROM checkout_market_commands').get()).toEqual({ n: 0 })
})
it.each([
  { ...input, market: 'gb' },
  { ...input, currency: 'EURO' },
  { ...input, exchangeDenominator: 0 },
  { ...input, goodsTaxBps: 10001 },
  { ...input, paymentMethods: [] },
  { ...input, paymentMethods: ['card', 'card'] },
  { ...input, termsVersion: 'https://bad.invalid' },
  { ...input, extra: true }
])('rejects invalid policy %j', async (raw) => {
  await expect(save(raw)).rejects.toMatchObject({ code: 'invalid_input' })
})
it('rejects unknown markets and unsafe amounts', async () => {
  await expect(readCheckoutMarket(f.database, CLAIMS, 'ZZ', opts)).rejects.toMatchObject({ code: 'not_found' })
  await save()
  const profile = await readCheckoutMarket(f.database, CLAIMS, 'GB', opts)
  expect(() => calculateCheckoutMarket(profile, Number.MAX_SAFE_INTEGER)).toThrow('invalid_input')
})
