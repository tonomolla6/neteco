import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openAccountSecurityDatabase, d1OverSqlite } from '../support/d1-sqlite'
import { deterministicUuid } from '../fixtures/deterministic'
import type { PromotionRule } from '../../shared/promotions'
import { promotionRuleHash } from '../../workers/catalog/promotions'
import { readPromotion } from '../../workers/catalog/promotion-lookup'
import { readFile } from 'node:fs/promises'
import { splitDemoSql } from '../../scripts/lib/d1-demo-sql'
import { fulfillmentFixture, CLAIMS, ACTOR as ORDER_ACTOR, utc } from './d1-fulfillment-fixture'
import { createPackingOrder } from './d1-order-packing-fixture'

const NOW = '2030-01-02T12:00:00Z'
const ACTOR = deterministicUuid('promotion-lookup-actor')
const RULE = deterministicUuid('promotion-lookup-rule')
const CUSTOMER = deterministicUuid('promotion-lookup-customer')
const rule: PromotionRule = {
  id: RULE,
  version: 1,
  code: 'SAVE',
  status: 'active',
  channel: 'online',
  startsAt: NOW,
  endsAt: null,
  benefit: { kind: 'fixed', grossCents: 101 },
  scope: { kind: 'all' },
  segment: 'all',
  totalLimit: null,
  perCustomerLimit: null,
  volumeMode: 'stack_volume'
}
let sqlite: DatabaseSync
let database: D1Database
beforeEach(async () => {
  sqlite = await openAccountSecurityDatabase()
  database = d1OverSqlite(sqlite)
  sqlite
    .prepare('INSERT INTO identities(id,email,password_hash,status,created_at,updated_at) VALUES(?,?,?,?,?,?)')
    .run(ACTOR, 'promotion-operator@example.invalid', 'synthetic', 'active', NOW, NOW)
})
afterEach(() => {
  if (sqlite?.isOpen) sqlite.close()
})
async function seed(value: PromotionRule = rule, options: { hash?: string; json?: string; headOnly?: boolean } = {}) {
  sqlite
    .prepare('INSERT INTO promotion_rules(id,code,current_version,created_at,updated_at) VALUES(?,?,?,?,?)')
    .run(RULE, 'SAVE', 1, NOW, NOW)
  if (!options.headOnly)
    sqlite
      .prepare(
        'INSERT INTO promotion_rule_versions(rule_id,version,rule_json,rule_hash,created_by,created_at) VALUES(?,?,?,?,?,?)'
      )
      .run(RULE, 1, options.json ?? JSON.stringify(value), options.hash ?? (await promotionRuleHash(value)), ACTOR, NOW)
}

describe('D1 promotion lookup on actual complete migrations', () => {
  it('reads the normalized current governed rule, fingerprint and recorded-use counts', async () => {
    await seed()
    expect(await readPromotion(database, ' save ', CUSTOMER, NOW)).toEqual({
      rule,
      ruleHash: await promotionRuleHash(rule),
      redemptions: { total: 0, customer: 0 }
    })
  })
  it('returns null only when the normalized code has no real head', async () => {
    expect(await readPromotion(database, 'UNKNOWN', null, NOW)).toBeNull()
  })
  it('does not hide a dangling head as a missing campaign', async () => {
    await seed(rule, { headOnly: true })
    await expect(readPromotion(database, 'SAVE', null, NOW)).rejects.toMatchObject({ code: 'history_unconfirmed' })
  })
  it('rejects stored hash corruption rather than applying a forged benefit', async () => {
    await seed(rule, { hash: '0'.repeat(64) })
    await expect(readPromotion(database, 'SAVE', null, NOW)).rejects.toMatchObject({ code: 'history_unconfirmed' })
  })
  it('rejects a rule whose normalized code is not the immutable head code', async () => {
    await seed({ ...rule, code: 'OTHER' })
    await expect(readPromotion(database, 'SAVE', null, NOW)).rejects.toMatchObject({ code: 'history_unconfirmed' })
  })
  it('rejects unexpected stored JSON fields with a hash that otherwise matches the supported rule', async () => {
    await seed(rule, { json: JSON.stringify({ ...rule, arbitrary: 'not_supported' }) })
    await expect(readPromotion(database, 'SAVE', null, NOW)).rejects.toMatchObject({ code: 'history_unconfirmed' })
  })
  it('reads one coherent SQL statement and never mutates state or usage', async () => {
    await seed()
    const changes = sqlite.prepare('SELECT total_changes() AS n').get()
    let queries = 0
    const observed = Object.create(database) as D1Database
    observed.prepare = (sql) => {
      queries += 1
      expect(sql.trimStart()).toMatch(/^SELECT\s/i)
      return database.prepare(sql)
    }
    expect(await readPromotion(observed, 'SAVE', CUSTOMER, NOW)).not.toBeNull()
    expect(queries).toBe(1)
    expect(sqlite.prepare('SELECT total_changes() AS n').get()).toEqual(changes)
  })
  it('counts uses across versions and separates authoritative customer uses from guest orders', async () => {
    sqlite.close()
    const fixture = await fulfillmentFixture()
    sqlite = fixture.sqlite
    database = fixture.database
    await database.batch(
      splitDemoSql(await readFile('db/d1/migrations/0072_promotions.sql', 'utf8')).map((sql) => database.prepare(sql))
    )
    sqlite
      .prepare('INSERT INTO identities(id,email,password_hash,status,created_at,updated_at) VALUES(?,?,?,?,?,?)')
      .run(ACTOR, 'promotion-operator@example.invalid', 'synthetic', 'active', NOW, NOW)
    sqlite
      .prepare('INSERT INTO customers(id,created_at,updated_at) VALUES(?,?,?)')
      .run(CUSTOMER, '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')
    sqlite.prepare('UPDATE identities SET customer_id=? WHERE id=?').run(CUSTOMER, ORDER_ACTOR)
    const owned = await createPackingOrder(database, {
      method: 'pickup',
      paid: false,
      stage: 'pending',
      ownerSession: CLAIMS,
      now: utc()
    })
    const guest = await fixture.order('pickup', false)
    await seed()
    sqlite
      .prepare(
        'INSERT INTO promotion_redemptions(rule_id,order_id,customer_id,rule_version,discount_gross_cents,created_at) VALUES(?,?,?,?,?,?)'
      )
      .run(RULE, owned, CUSTOMER, 1, 101, NOW)
    const version2 = { ...rule, version: 2, benefit: { kind: 'fixed' as const, grossCents: 102 } }
    sqlite
      .prepare(
        'INSERT INTO promotion_rule_versions(rule_id,version,rule_json,rule_hash,created_by,created_at) VALUES(?,?,?,?,?,?)'
      )
      .run(RULE, 2, JSON.stringify(version2), await promotionRuleHash(version2), ACTOR, NOW)
    sqlite.prepare('UPDATE promotion_rules SET current_version=2 WHERE id=?').run(RULE)
    sqlite
      .prepare(
        'INSERT INTO promotion_redemptions(rule_id,order_id,customer_id,rule_version,discount_gross_cents,created_at) VALUES(?,?,?,?,?,?)'
      )
      .run(RULE, guest, null, 2, 102, NOW)
    expect(await readPromotion(database, 'SAVE', CUSTOMER, NOW)).toMatchObject({
      rule: version2,
      redemptions: { total: 2, customer: 1 }
    })
    expect(await readPromotion(database, 'SAVE', null, NOW)).toMatchObject({ redemptions: { total: 2, customer: 0 } })
  })
  it('surfaces D1 outages unchanged, never as coupon unavailable', async () => {
    const outage = new Error('synthetic_d1_outage')
    const failed = Object.create(database) as D1Database
    failed.prepare = () => {
      throw outage
    }
    await expect(readPromotion(failed, 'SAVE', null, NOW)).rejects.toBe(outage)
  })
  it('rejects client-invalid IDs, impossible instants and Unicode code aliases before any SQL', async () => {
    const failed = Object.create(database) as D1Database
    failed.prepare = () => {
      throw new Error('unexpected_sql')
    }
    for (const [code, customer, instant] of [
      ['SÁVE', null, NOW],
      ['SAVE', 'not-uuid', NOW],
      ['SAVE', null, '2030-02-30T12:00:00Z']
    ] as const)
      await expect(readPromotion(failed, code, customer, instant)).rejects.toMatchObject({ code: 'invalid_input' })
  })
})
