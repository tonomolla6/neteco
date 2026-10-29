import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { returnsFixture, CLAIMS, BUYER_CLAIMS, utc } from './d1-returns-fixture'
import { splitDemoSql } from '../../scripts/lib/d1-demo-sql'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { handleAdminPromotionsHttp } from '../../workers/catalog/admin-promotions-http'
import { promotionBasketPreviewResponseSchema } from '../../shared/promotion-basket-preview'

const origin = 'https://basket-preview.neteco.test'
const path = '/api/admin/promotions/basket-preview'
const configuration = { password: 'synthetic-basket-preview-cookie-password-over32', maxAgeSeconds: 3600 }
let fixture: Awaited<ReturnType<typeof returnsFixture>>, cookie: string, customerCookie: string
const input = () => ({
  lines: [{ variantId: 'v-1-1', quantity: 2 }],
  destination: { postalCode: '46870', city: 'Ontinyent' },
  customerId: null,
  rule: {
    id: '80000000-0000-4000-8000-000000000012',
    version: 1,
    code: 'BASKET101',
    status: 'active',
    channel: 'online',
    startsAt: utc(-3600000),
    endsAt: null,
    benefit: { kind: 'fixed', grossCents: 101 },
    scope: { kind: 'all' },
    segment: 'all',
    totalLimit: null,
    perCustomerLimit: null,
    volumeMode: 'stack_volume'
  }
})
beforeEach(async () => {
  fixture = await returnsFixture()
  for (const file of [
    '0072_promotions.sql',
    '0073_promotion_admin_commands.sql',
    '0074_order_purchase_reference.sql'
  ]) {
    await fixture.database.batch(
      splitDemoSql(await readFile('db/d1/migrations/' + file, 'utf8')).map((sql) => fixture.database.prepare(sql))
    )
  }
  fixture.sqlite.exec(
    "INSERT OR IGNORE INTO permissions VALUES('catalog.write','catalog','write','Synthetic'); INSERT INTO role_permissions VALUES('operator','catalog.write')"
  )
  cookie = (await issueD1SessionCookie(fixture.database, CLAIMS, configuration))!.split(';')[0]!
  customerCookie = (await issueD1SessionCookie(fixture.database, BUYER_CLAIMS, configuration))!.split(';')[0]!
})
afterEach(() => fixture?.sqlite.close())
async function call({
  value = input(),
  suffix = '',
  headers = {},
  method = 'POST',
  database = fixture.database,
  raw
}: {
  value?: unknown
  suffix?: string
  headers?: Record<string, string>
  method?: string
  database?: D1Database
  raw?: BodyInit
} = {}) {
  return (await handleAdminPromotionsHttp(
    new Request(origin + path + suffix, {
      method,
      headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', ...headers },
      ...(method === 'GET' ? {} : { body: raw ?? JSON.stringify(value) })
    }),
    { database, origin, sessionCookieConfiguration: configuration }
  ))!
}
function domainSnapshot() {
  return Object.fromEntries(
    [
      'carts',
      'cart_lines',
      'checkout_quotes',
      'shipping_quotes',
      'orders',
      'order_lines',
      'promotion_rules',
      'promotion_admin_commands',
      'promotion_redemptions',
      'inventory_balances',
      'inventory_movements'
    ].map((table) => [table, fixture.sqlite.prepare('SELECT * FROM ' + table).all()])
  )
}
it('simulates actual catalog prices and shipping without creating carts, quotes, orders, stock or promotion history', async () => {
  const before = domainSnapshot()
  const response = await call()
  expect(response.status).toBe(200)
  const preview = promotionBasketPreviewResponseSchema.parse(await response.json())
  expect(preview).toMatchObject({ source: 'cloudflare', simulation: true })
  expect(preview.lines).toEqual([expect.objectContaining({ variantId: 'v-1-1', quantity: 2 })])
  expect(preview.totals.base.grossCents).toBe(1000)
  expect(preview.totals.proposed.grossCents).toBe(899)
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  expect(response.headers.get('set-cookie')).toBeNull()
  expect(domainSnapshot()).toEqual(before)
})
it.each(['catalog.write', 'administration.manage'])(
  'requires the current %s grant, not merely a cached role',
  async (permission) => {
    fixture.sqlite
      .prepare('DELETE FROM role_permissions WHERE role_code=? AND permission_code=?')
      .run('operator', permission)
    expect((await call()).status).toBe(403)
  }
)
it.each(['email', 'mfa', 'revoked'])('rejects current %s authority loss', async (boundary) => {
  if (boundary === 'email')
    fixture.sqlite.prepare('UPDATE identities SET email_verified_at=NULL WHERE id=?').run(CLAIMS.identityId)
  if (boundary === 'mfa')
    fixture.sqlite.prepare('UPDATE auth_sessions SET mfa_verified=0 WHERE id=?').run(CLAIMS.sessionId)
  if (boundary === 'revoked')
    fixture.sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(utc(), CLAIMS.sessionId)
  expect((await call()).status).toBe(boundary === 'revoked' ? 401 : 403)
})
it('never grants simulation to a buyer or anonymous caller', async () => {
  expect((await call({ headers: { Cookie: customerCookie } })).status).toBe(403)
  expect((await call({ headers: { Cookie: '' } })).status).toBe(401)
})
it.each([
  { ...input(), priceGrossCents: 1 },
  { ...input(), lines: [{ variantId: 'v-1-1', quantity: 2, priceGrossCents: 1 }] },
  {
    ...input(),
    lines: [
      { variantId: 'v-1-1', quantity: 2 },
      { variantId: 'v-1-1', quantity: 1 }
    ]
  },
  { ...input(), lines: Array.from({ length: 101 }, (_, index) => ({ variantId: 'v-' + index, quantity: 1 })) }
])('rejects supplied authority facts and invalid basket shapes', async (value) => {
  expect((await call({ value })).status).toBe(400)
})
it('rejects query parameters and cross-origin requests', async () => {
  expect((await call({ suffix: '?price=1' })).status).toBe(400)
  expect((await call({ headers: { Origin: 'https://foreign.neteco.test' } })).status).toBe(403)
})
it('bounds the real body stream and rejects malformed UTF8 and JSON', async () => {
  expect((await call({ raw: ' '.repeat(65537) })).status).toBe(413)
  expect((await call({ raw: new Uint8Array([0xff]) })).status).toBe(400)
  expect((await call({ raw: '{' })).status).toBe(400)
  expect((await call({ headers: { 'Content-Type': 'text/plain' } })).status).toBe(415)
})
it('reports an opaque unavailable response on real D1 failure, never a simulated empty success', async () => {
  const database = {
    prepare() {
      throw new Error('synthetic_private_database_failure')
    }
  } as unknown as D1Database
  const response = await call({ database })
  expect(response.status).toBe(503)
  expect(await response.json()).toEqual({ error: { code: 'service_unavailable' } })
})
it('never releases protected basket costs after revocation during a redundant post-core permission read', async () => {
  let atomicReads = 0,
    revoked = false
  const database = new Proxy(fixture.database, {
    get(target, key) {
      if (key !== 'prepare') {
        const value = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      }
      return (sql: string) => {
        const statement = target.prepare(sql)
        const bind = statement.bind.bind(statement)
        statement.bind = (...values: unknown[]) => {
          const bound = bind(...values)
          const first = bound.first.bind(bound)
          bound.first = async (...args: Parameters<typeof bound.first>) => {
            if (atomicReads >= 2 && sql.includes('AS permitted') && values[1] === 'catalog.write') {
              fixture.sqlite
                .prepare(
                  "DELETE FROM role_permissions WHERE role_code='operator' AND permission_code='administration.manage'"
                )
                .run()
              revoked = true
            }
            const result = await first(...args)
            if (sql.includes('AS permissions')) atomicReads++
            return result
          }
          return bound
        }
        return statement
      }
    }
  }) as D1Database
  const response = await call({ database })
  // If the atomic intersection remains the final database await, there is no
  // redundant single-permission window in which this revocation can occur.
  expect(atomicReads).toBe(2)
  expect(response.status).toBe(revoked ? 403 : 200)
  if (revoked) expect(await response.json()).toEqual({ error: { code: 'forbidden' } })
})
