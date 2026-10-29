import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { prepareNativeAuditAdminMfa } from '../../scripts/lib/audit-native-admin-mfa'
import { handleD1AdminOrdersRequest } from '../../workers/catalog/admin-orders-http'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { fulfillmentFixture, ACTOR, CLAIMS, SESSION, utc } from './d1-fulfillment-fixture'

const origin = 'https://shop-audit.neteco.test'
const configuration = { password: 'synthetic-admin-mfa-acceptance-secret-32-characters', maxAgeSeconds: 3600 }
let fixture: Awaited<ReturnType<typeof fulfillmentFixture>>
let cookie: string
let now: string
let orderId: string

beforeEach(async () => {
  fixture = await fulfillmentFixture()
  now = utc()
  orderId = await fixture.order('pickup', false)
  const issued = await issueD1SessionCookie(fixture.database, CLAIMS, configuration)
  expect(issued).not.toBeNull()
  cookie = issued!.split(';')[0]!
})
afterEach(() => fixture?.sqlite.close())

async function read() {
  const response = await handleD1AdminOrdersRequest(
    new Request(origin + '/api/admin/orders?pagination=cursor&sortKey=id&sortDir=asc', { headers: { cookie } }),
    { database: fixture.database, origin, sessionCookieConfiguration: configuration, now }
  )
  expect(response).not.toBeNull()
  return response!
}
function enroll() {
  fixture.sqlite
    .prepare(
      "INSERT INTO identity_mfa(identity_id,encrypted_secret,recovery_code_hashes,verified_at,updated_at) VALUES(?,'synthetic-fixture-only','[]',?,?)"
    )
    .run(ACTOR, utc(-60000), utc(-60000))
}
function domain() {
  return JSON.stringify(
    [
      'identity_roles',
      'role_permissions',
      'auth_sessions',
      'orders',
      'order_lines',
      'inventory_balances',
      'inventory_movements',
      'inventory_reservations',
      'payment_intents'
    ].map((table) => fixture.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
  )
}

describe('isolated native audit administrator enrollment against real cursor authority', () => {
  it('rejects a session MFA boolean without actual enrollment', async () => {
    expect(fixture.sqlite.prepare('SELECT mfa_verified FROM auth_sessions WHERE id=?').get(SESSION)).toMatchObject({
      mfa_verified: 1
    })
    const response = await read()
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: { code: 'mfa_required' } })
  })
  it('prepares actual synthetic enrollment before releasing real private order rows', async () => {
    const before = domain()
    await prepareNativeAuditAdminMfa(fixture.database, ACTOR, now)
    const response = await read()
    expect(response.status).toBe(200)
    const body = (await response.json()) as { items: Array<{ id: string }> }
    expect(body.items.map((item) => item.id)).toEqual([orderId])
    expect(domain()).toBe(before)
  })
  it('is idempotent without overwriting enrollment or granting roles or economic effects', async () => {
    const before = domain()
    await prepareNativeAuditAdminMfa(fixture.database, ACTOR, now)
    const enrollment = fixture.sqlite.prepare('SELECT * FROM identity_mfa WHERE identity_id=?').get(ACTOR)
    expect(enrollment).toBeDefined()
    await prepareNativeAuditAdminMfa(fixture.database, ACTOR, utc(1000))
    expect(fixture.sqlite.prepare('SELECT * FROM identity_mfa WHERE identity_id=?').get(ACTOR)).toEqual(enrollment)
    expect(domain()).toBe(before)
  })
  it('still rejects an enrolled identity whose session MFA is not verified', async () => {
    enroll()
    fixture.sqlite.prepare('UPDATE auth_sessions SET mfa_verified=0 WHERE id=?').run(SESSION)
    const response = await read()
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: { code: 'mfa_required' } })
  })
  it.each(['enrollment', 'role'] as const)('revokes private reads immediately after %s removal', async (kind) => {
    enroll()
    expect((await read()).status).toBe(200)
    if (kind === 'enrollment') fixture.sqlite.prepare('DELETE FROM identity_mfa WHERE identity_id=?').run(ACTOR)
    else fixture.sqlite.prepare('DELETE FROM identity_roles WHERE identity_id=?').run(ACTOR)
    const response = await read()
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({
      error: { code: kind === 'enrollment' ? 'mfa_required' : 'forbidden' }
    })
  })
})
