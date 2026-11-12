import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { readFile } from 'node:fs/promises'
import { splitDemoSql } from '../../scripts/lib/d1-demo-sql'
import { d1OverSqlite, openMigratedDatabase, seedInventoryFixture, applyGeneratedSeed } from '../support/d1-sqlite'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import { renderD1ShippingSeed } from '../../scripts/lib/d1-shipping-seed'
import { createCart, setCartLine } from '../../workers/catalog/cart'
import { resolveShippingOptions, withOptionHashes } from '../../workers/catalog/shipping'
import {
  shippingCalendarConfigurationHash,
  shippingCalendarIntentHash,
  type ShippingCalendarConfiguration
} from '../../shared/shipping-calendar'
import {
  calculateShippingCalendarEta,
  readD1ShippingCalendars,
  updateD1ShippingCalendars,
  readD1ShippingCalendarCommand,
  shippingCalendarRevalidationDeadline,
  shippingCalendarCurrentPredicate
} from '../../workers/catalog/shipping-calendar'
import { testUuid, testNow } from '../support/deterministic'

const actor = '10000000-0000-4000-8000-000000000078'
const session = '20000000-0000-4000-8000-000000000078'
const key = '30000000-0000-4000-8000-000000000078'
const claims = { identityId: actor, sessionId: session, sessionVersion: 1 }
const configuration = (): ShippingCalendarConfiguration => ({
  timeZone: 'Europe/Madrid',
  preparationBusinessDays: 1,
  cutoffLocalTime: '14:00',
  calendars: [
    {
      code: 'synthetic-national',
      name: 'Synthetic operating calendar',
      scope: 'national',
      stage: 'both',
      operatingWeekdays: [1, 2, 3, 4, 5],
      closedDates: ['2026-10-12'],
      postalPrefixes: [],
      methodCodes: [],
      serviceProfiles: [],
      zoneCodes: []
    }
  ]
})
const input = (expectedVersion = 0) => ({
  expectedVersion,
  configuration: configuration(),
  reason: 'Synthetic explicitly reviewed operating schedule',
  reviewReference: 'SCHEDULE-78'
})
async function snapshot(config = configuration()) {
  return {
    source: 'cloudflare' as const,
    version: 1,
    configuration: config,
    configurationHash: await shippingCalendarConfigurationHash(config),
    updatedAt: '2026-10-01T10:00:00Z'
  }
}
const route = {
  now: '2026-10-09T11:00:00Z',
  postalCode: '46870',
  methodCode: 'parcel' as const,
  serviceProfile: 'parcel' as const,
  zoneCode: 'peninsula',
  transitMinDays: 1,
  transitMaxDays: 2,
  stockLeadTimeDays: 0
}

describe('Configured shipping calendars: real D1 authority and stable operational ETA', () => {
  let sqlite: DatabaseSync
  let database: D1Database
  beforeEach(async () => {
    sqlite = await openMigratedDatabase()
    database = d1OverSqlite(sqlite)
    const migration = await readFile(
      new URL('../../db/d1/migrations/0078_shipping_calendars.sql', import.meta.url),
      'utf8'
    )
    await database.batch(splitDemoSql(migration).map((sql) => database.prepare(sql)))
    const past = '2026-01-01T00:00:00Z',
      future = '2099-01-01T00:00:00Z'
    sqlite
      .prepare(
        `INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at) VALUES (?,'calendar-admin@example.invalid','not-login',?,'active',?,?)`
      )
      .run(actor, past, past, past)
    sqlite.exec(`INSERT OR IGNORE INTO roles VALUES ('calendar_admin','Calendar admin','Synthetic');
      INSERT OR IGNORE INTO permissions VALUES ('administration.manage','administration','manage','Synthetic');
      INSERT INTO role_permissions VALUES ('calendar_admin','administration.manage');`)
    sqlite
      .prepare(`INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES (?,'calendar_admin',?)`)
      .run(actor, past)
    sqlite
      .prepare(
        `INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES (?,?,1,1,?,?)`
      )
      .run(session, actor, past, future)
  })
  afterEach(() => sqlite.close())

  it('reports an unconfigured calendar honestly without fabricating ETA', async () => {
    const current = await readD1ShippingCalendars(database, claims)
    expect(current).toEqual({
      source: 'cloudflare',
      version: 0,
      configuration: null,
      configurationHash: null,
      updatedAt: null
    })
    expect(calculateShippingCalendarEta(current, route)).toMatchObject({
      status: 'unknown',
      reason: 'calendar_not_configured',
      from: null,
      to: null
    })
  })
  it('does not consume weekends or configured holidays', async () => {
    expect(calculateShippingCalendarEta(await snapshot(), route)).toMatchObject({
      status: 'estimated',
      from: '2026-10-14',
      to: '2026-10-15'
    })
  })
  it('changes dates exactly at the configured local cutoff, not on each second', async () => {
    const current = await snapshot()
    expect(calculateShippingCalendarEta(current, { ...route, now: '2026-10-09T11:59:59Z' })).toEqual(
      calculateShippingCalendarEta(current, { ...route, now: '2026-10-09T11:00:01Z' })
    )
    expect(calculateShippingCalendarEta(current, { ...route, now: '2026-10-09T12:00:00Z' })).toMatchObject({
      from: '2026-10-15',
      to: '2026-10-16'
    })
  })
  it('applies destination and configured carrier closures only to matching routes/stages', async () => {
    const config = configuration()
    config.calendars.push({
      ...config.calendars[0]!,
      code: 'local',
      scope: 'local',
      stage: 'transit',
      postalPrefixes: ['46'],
      closedDates: ['2026-10-14']
    })
    config.calendars.push({
      ...config.calendars[0]!,
      code: 'carrier',
      scope: 'carrier',
      stage: 'transit',
      methodCodes: ['parcel'],
      closedDates: ['2026-10-15']
    })
    expect(calculateShippingCalendarEta(await snapshot(config), route)).toMatchObject({
      from: '2026-10-16',
      to: '2026-10-19'
    })
    expect(
      calculateShippingCalendarEta(await snapshot(config), { ...route, methodCode: 'pickup', postalCode: '28001' })
    ).toMatchObject({ from: '2026-10-14', to: '2026-10-15' })
  })
  it('uses Madrid business dates through DST and explicitly unknown supplier preparation', async () => {
    const config = configuration()
    config.calendars[0]!.closedDates = []
    expect(
      calculateShippingCalendarEta(await snapshot(config), { ...route, now: '2026-10-23T11:00:00Z' })
    ).toMatchObject({ from: '2026-10-27', to: '2026-10-28' })
    expect(calculateShippingCalendarEta(await snapshot(), { ...route, stockLeadTimeDays: null })).toMatchObject({
      status: 'unknown',
      reason: 'lead_time_unknown'
    })
  })
  it('records one governed revision, recovers the exact receipt and replays without another write', async () => {
    const receipt = await updateD1ShippingCalendars(database, claims, input(), { idempotencyKey: key })
    expect(receipt).toMatchObject({
      commandId: key,
      expectedVersion: 0,
      version: 1,
      payloadHash: await shippingCalendarIntentHash(input())
    })
    expect(await readD1ShippingCalendars(database, claims)).toMatchObject({
      version: 1,
      configuration: configuration()
    })
    expect(await readD1ShippingCalendarCommand(database, claims, key, receipt.payloadHash)).toEqual({
      source: 'cloudflare',
      outcome: 'applied',
      receipt
    })
    expect(await updateD1ShippingCalendars(database, claims, input(), { idempotencyKey: key })).toEqual(receipt)
  })
  it('rejects changed intent and stale CAS rather than overwriting calendars', async () => {
    await updateD1ShippingCalendars(database, claims, input(), { idempotencyKey: key })
    await expect(
      updateD1ShippingCalendars(
        database,
        claims,
        { ...input(), reason: 'Another legitimate review reason' },
        { idempotencyKey: key }
      )
    ).rejects.toMatchObject({ code: 'idempotency_conflict' })
    await expect(
      updateD1ShippingCalendars(database, claims, input(), { idempotencyKey: testUuid() })
    ).rejects.toMatchObject({ code: 'version_conflict' })
  })
  it('denies revoked sessions and missing MFA before private recovery or mutation', async () => {
    sqlite.prepare('UPDATE auth_sessions SET mfa_verified=0 WHERE id=?').run(session)
    await expect(readD1ShippingCalendars(database, claims)).rejects.toMatchObject({ code: 'mfa_required' })
    sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run('2026-10-01T00:00:00Z', session)
    await expect(updateD1ShippingCalendars(database, claims, input(), { idempotencyKey: key })).rejects.toMatchObject({
      code: 'unauthenticated'
    })
  })
  it('rolls back the entire revision if live authority disappears during the final batch await', async () => {
    const raced = new Proxy(database, {
      get(target, field) {
        if (field === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            sqlite
              .prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?')
              .run(new Date(testNow()).toISOString().replace(/\.\d{3}Z$/, 'Z'), session)
            return target.batch(statements)
          }
        const value: unknown = Reflect.get(target, field)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
    await expect(updateD1ShippingCalendars(raced, claims, input(), { idempotencyKey: key })).rejects.toMatchObject({
      code: 'unauthenticated'
    })
    expect(sqlite.prepare('SELECT count(*) AS n FROM shipping_calendar_commands').get()).toEqual({ n: 0 })
    expect(sqlite.prepare('SELECT count(*) AS n FROM shipping_calendar_heads').get()).toEqual({ n: 0 })
  })
  it('rolls back command and projection when any statement fails, without classifying outages as conflict', async () => {
    sqlite.exec(
      `CREATE TRIGGER synthetic_calendar_failure AFTER INSERT ON shipping_calendar_commands BEGIN SELECT RAISE(ABORT,'synthetic_failure'); END;`
    )
    await expect(updateD1ShippingCalendars(database, claims, input(), { idempotencyKey: key })).rejects.toMatchObject({
      code: 'service_unavailable'
    })
    expect(sqlite.prepare('SELECT count(*) AS n FROM shipping_calendar_commands').get()).toEqual({ n: 0 })
    expect(sqlite.prepare('SELECT count(*) AS n FROM shipping_calendar_heads').get()).toEqual({ n: 0 })
  })
  it('rejects corrupted stored policy hashes instead of exposing an invented configuration', async () => {
    await updateD1ShippingCalendars(database, claims, input(), { idempotencyKey: key })
    sqlite.exec('DROP TRIGGER shipping_calendar_command_no_update')
    sqlite
      .prepare(
        `UPDATE shipping_calendar_commands SET input_json=json_set(input_json,'$.configuration.preparationBusinessDays',2) WHERE command_id=?`
      )
      .run(key)
    await expect(readD1ShippingCalendars(database, claims)).rejects.toMatchObject({ code: 'history_unconfirmed' })
    await expect(
      readD1ShippingCalendarCommand(database, claims, key, await shippingCalendarIntentHash(input()))
    ).rejects.toMatchObject({ code: 'history_unconfirmed' })
  })
  it('binds actual shipping quote hashes to operational dates and policy revision, not evaluation seconds', async () => {
    seedInventoryFixture(sqlite)
    applyGeneratedSeed(sqlite, renderD1ShippingSeed())
    await provisionPublicationValidityFixture(database, {
      productIds: ['p-1', 'p-2', 'p-3'],
      now: '2026-01-01T00:00:00Z'
    })
    await updateD1ShippingCalendars(database, claims, input(), { idempotencyKey: key })
    const cart = await createCart(database, { now: route.now, correlationId: 'calendar-quote' })
    await setCartLine(database, {
      ...cart,
      token: cart.token,
      expectedVersion: 1,
      variantId: 'v-1-1',
      quantity: 2,
      idempotencyKey: 'add-calendar',
      correlationId: 'calendar-quote',
      now: route.now
    })
    const options = async (now: string) =>
      withOptionHashes(
        (
          await resolveShippingOptions(database, {
            cartId: cart.cartId,
            destination: { postalCode: route.postalCode, city: 'Synthetic' },
            now
          })
        ).options
      )
    const first = await options(route.now),
      same = await options('2026-10-09T11:00:01Z'),
      late = await options('2026-10-09T12:00:00Z')
    expect(same.map((row) => row.optionHash)).toEqual(first.map((row) => row.optionHash))
    expect(late.map((row) => row.optionHash)).not.toEqual(first.map((row) => row.optionHash))
    const predicate = await shippingCalendarCurrentPredicate(database, first[0]!.eta, null)
    expect(await database.prepare(`SELECT ${predicate} AS valid`).first()).toEqual({ valid: 1 })
    await updateD1ShippingCalendars(
      database,
      claims,
      { ...input(1), configuration: { ...configuration(), preparationBusinessDays: 2 } },
      { idempotencyKey: testUuid() }
    )
    expect(await database.prepare(`SELECT ${predicate} AS valid`).first()).toEqual({ valid: 0 })
  })
  it('closes at the first real cutoff through spring gaps and repeated autumn hours', async () => {
    const config = configuration()
    config.cutoffLocalTime = '02:30'
    const current = await snapshot(config)
    expect(shippingCalendarRevalidationDeadline(current, '2026-03-29T00:59:59Z')).toBe('2026-03-29T01:00:00Z')
    expect(shippingCalendarRevalidationDeadline(current, '2026-10-25T00:29:59Z')).toBe('2026-10-25T00:30:00Z')
    expect(shippingCalendarRevalidationDeadline(current, '2026-10-25T01:00:00Z')).toBe('2026-10-25T23:00:00Z')
  })
})
