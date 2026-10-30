import { expect, it, vi } from 'vitest'
import worker from '../../workers/canary'

const origin = 'https://shop.example.invalid'
const env = (extra: Record<string, unknown> = {}) =>
  ({ APP_ENV: 'local', DB: { prepare: vi.fn() }, ...extra }) as unknown as CloudflareEnv

it('exposes wallet capabilities closed by default through the worker dispatcher', async () => {
  const res = await worker.fetch(new Request(`${origin}/api/payments/wallet-capabilities`), env())
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ wallets: { apple_pay: false, google_pay: false }, fallback: 'redirect' })
})
it('serves the Apple verification file only when wallet payments are enabled and configured', async () => {
  const path = `${origin}/.well-known/apple-developer-merchantid-domain-association`
  expect((await worker.fetch(new Request(path), env())).status).toBe(404)
  const enabled = await worker.fetch(
    new Request(path),
    env({ WALLET_PAYMENTS_ENABLED: 'true', APPLE_PAY_DOMAIN_ASSOCIATION: 'proof-from-bank' })
  )
  expect(enabled.status).toBe(200)
  expect(await enabled.text()).toBe('proof-from-bank')
})
it('owns the wallet start route and does not fall through to the card route', async () => {
  const res = await worker.fetch(
    new Request(`${origin}/api/orders/not-a-uuid/wallet-payment-intents`, { method: 'POST' }),
    env()
  )
  expect(res.status).toBe(401)
})
