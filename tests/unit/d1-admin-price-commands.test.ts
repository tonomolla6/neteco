import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { scheduleD1VariantPrice, cancelD1ScheduledPrice } from '../../workers/catalog/admin-price-commands'
import {
  catalogPriceScheduleInputSchema,
  catalogPriceCancelInputSchema,
  type CatalogPriceScheduleInput
} from '../../shared/catalog-price-commands'
import { d1OverSqlite, openMigratedDatabase, seedInventoryFixture } from '../support/d1-sqlite'
import { effectiveGrossCentsExpression, parameterizeEffectivePricingSql } from '../../workers/catalog/pricing'

const NOW = '2030-10-01T09:00:00.000Z'
const IDENTITY = '10000000-0000-4000-8000-000000000039'
const SESSION = '20000000-0000-4000-8000-000000000039'
const PRODUCT = '30000000-0000-4000-8000-000000000039'
const VARIANT = '40000000-0000-4000-8000-000000000039'
const CLAIMS = { identityId: IDENTITY, sessionId: SESSION, sessionVersion: 1 }
const schedule = (overrides: Partial<CatalogPriceScheduleInput> = {}): CatalogPriceScheduleInput => ({
  variantId: VARIANT,
  expectedCatalogVersion: 1,
  expectedLatestApprovedId: null,
  grossCents: 800,
  compareAtGrossCents: null,
  volumeTiers: [],
  validFrom: '2030-10-01T10:00:00.000Z',
  reason: 'Synthetic local price decision',
  ...overrides
})
describe('governed D1 price schedule/cancellation atomic engine', () => {
  let sqlite: DatabaseSync
  let database: D1Database
  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(NOW))
    sqlite = await openMigratedDatabase()
    if (!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name='catalog_price_commands'").get())
      sqlite.exec(
        await readFile(new URL('../../db/d1/migrations/0039_catalog_price_commands.sql', import.meta.url), 'utf8')
      )
    sqlite.limits.exprDepth = 100
    sqlite.limits.variableNumber = 100
    sqlite.limits.functionArg = 32
    seedInventoryFixture(sqlite)
    sqlite
      .prepare(
        "INSERT INTO products(id,legacy_id,category_id,name,slug,status) VALUES (?,900001,'c1','Price draft','price-draft','draft')"
      )
      .run(PRODUCT)
    sqlite
      .prepare(
        `INSERT INTO variants(id,legacy_id,product_id,tax_class_id,shipping_profile_id,sku,format,status,
      price_gross_cents,minimum_quantity,quantity_increment,maximum_quantity) VALUES (?,900002,?,'t21','sp1','PRICE-DRAFT','Botella','draft',0,2,2,20)`
      )
      .run(VARIANT, PRODUCT)
    sqlite
      .prepare(
        "INSERT INTO inventory_balances(variant_id,location_id,physical_quantity,blocked_quantity,created_at,updated_at) VALUES (?,'loc-main',0,0,?,?)"
      )
      .run(VARIANT, NOW.replace('.000Z', 'Z'), NOW.replace('.000Z', 'Z'))
    sqlite
      .prepare(
        "INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at) VALUES (?,'pricing@example.invalid','synthetic-only','2020-01-01T00:00:00Z','active','2020-01-01T00:00:00Z','2020-01-01T00:00:00Z')"
      )
      .run(IDENTITY)
    sqlite.exec(
      "INSERT INTO roles VALUES ('price_admin','Price administrator','fixture'),('price_reader','Price reader','fixture'); INSERT INTO permissions VALUES ('administration.manage','administration','manage','fixture'),('catalog.write','catalog','write','fixture'); INSERT INTO role_permissions VALUES ('price_admin','administration.manage'),('price_admin','catalog.write'),('price_reader','catalog.write');"
    )
    sqlite
      .prepare(
        "INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES (?,'price_admin','2020-01-01T00:00:00Z')"
      )
      .run(IDENTITY)
    sqlite
      .prepare(
        "INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES (?,?,1,1,'2020-01-01T00:00:00Z','2099-01-01T00:00:00Z')"
      )
      .run(SESSION, IDENTITY)
    database = d1OverSqlite(sqlite)
  })
  afterEach(() => {
    sqlite.close()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })
  const opts = (key = 'price-key') => ({ idempotencyKey: key, now: NOW })
  function rows(table = 'variant_price_versions') {
    return sqlite
      .prepare(
        `SELECT * FROM ${table} ${table === 'variant_price_versions' ? 'WHERE variant_id=? ORDER BY id' : 'ORDER BY id'}`
      )
      .all(...(table === 'variant_price_versions' ? [VARIANT] : []))
  }
  function add(id: string, from: string, until: string | null, gross = 900, created = '2030-09-01T00:00:00.000Z') {
    sqlite
      .prepare(
        'INSERT INTO variant_price_versions(id,variant_id,gross_cents,valid_from,valid_until,reason,created_at) VALUES (?,?,?,?,?,?,?)'
      )
      .run(id, VARIANT, gross, from, until, 'Synthetic imported evidence', created)
  }
  function effective(instant: string) {
    const query = parameterizeEffectivePricingSql(
      `SELECT ${effectiveGrossCentsExpression('v')} AS gross FROM variants v WHERE id=?`,
      instant
    )
    return sqlite.prepare(query.sql).get(...query.instantParameters, VARIANT)
  }
  it('schedules the first approved price without changing raw draft zero, editorial version, stock or publication', async () => {
    const before = sqlite.prepare('SELECT * FROM variants WHERE id=?').get(VARIANT)
    const balance = sqlite.prepare('SELECT * FROM inventory_balances WHERE variant_id=?').get(VARIANT)
    const receipt = await scheduleD1VariantPrice(database, CLAIMS, schedule(), opts())
    expect(receipt).toEqual({
      source: 'cloudflare',
      action: 'price_schedule',
      commandId: expect.any(String),
      priceId: expect.any(String),
      variantId: VARIANT,
      variantLegacyId: 900002,
      updated: true
    })
    expect(rows()).toHaveLength(1)
    expect(rows('catalog_price_commands')).toHaveLength(1)
    expect(rows('catalog_price_audit')).toHaveLength(1)
    expect(sqlite.prepare('SELECT * FROM variants WHERE id=?').get(VARIANT)).toEqual(before)
    expect(sqlite.prepare('SELECT * FROM inventory_balances WHERE variant_id=?').get(VARIANT)).toEqual(balance)
    expect(sqlite.prepare('SELECT status,catalog_version FROM products WHERE id=?').get(PRODUCT)).toEqual({
      status: 'draft',
      catalog_version: 1
    })
    expect(rows()[0]).toMatchObject({ reference_gross_cents_30d: null, created_by: IDENTITY, created_at: NOW })
    expect(effective('2030-10-01T09:59:59.999Z')).toEqual({ gross: 0 })
    expect(effective('2030-10-01T10:00:00.000Z')).toEqual({ gross: 800 })
  })
  it('closes the approved head and exact cancellation reopens its predecessor without deleting history', async () => {
    add('imported head', '2030-09-01T00:00:00Z', null)
    const result = await scheduleD1VariantPrice(
      database,
      CLAIMS,
      schedule({ expectedLatestApprovedId: 'imported head' }),
      opts()
    )
    expect(rows().find((row) => row.id === 'imported head')).toMatchObject({ valid_until: '2030-10-01T10:00:00.000Z' })
    expect(rows().find((row) => row.id === result.priceId)).toMatchObject({ reference_gross_cents_30d: 900 })
    const cancelled = await cancelD1ScheduledPrice(
      database,
      CLAIMS,
      result.priceId,
      {
        expectedCatalogVersion: 1,
        expectedLatestApprovedId: result.priceId,
        reason: 'Synthetic cancellation decision'
      },
      opts('cancel-key')
    )
    expect(cancelled).toMatchObject({ action: 'price_cancel', priceId: result.priceId, variantId: VARIANT })
    expect(rows()).toHaveLength(2)
    expect(rows().find((row) => row.id === 'imported head')).toMatchObject({ valid_until: null, status: 'approved' })
    expect(rows().find((row) => row.id === result.priceId)).toMatchObject({
      status: 'cancelled',
      cancelled_by: IDENTITY,
      cancelled_at: NOW
    })
    expect(effective('2030-10-01T10:00:00.000Z')).toEqual({ gross: 900 })
  })
  it('returns the original receipt for replay even after the price is current or a different head exists', async () => {
    const first = await scheduleD1VariantPrice(database, CLAIMS, schedule(), opts())
    await scheduleD1VariantPrice(
      database,
      CLAIMS,
      schedule({ expectedLatestApprovedId: first.priceId, validFrom: '2030-10-01T11:00:00Z' }),
      opts('second')
    )
    expect(
      await scheduleD1VariantPrice(database, CLAIMS, schedule(), {
        idempotencyKey: 'price-key',
        now: '2030-10-01T12:00:00Z'
      })
    ).toEqual(first)
    expect(rows()).toHaveLength(2)
    expect(rows('catalog_price_audit')).toHaveLength(2)
    await expect(scheduleD1VariantPrice(database, CLAIMS, schedule({ grossCents: 801 }), opts())).rejects.toMatchObject(
      { code: 'idempotency_conflict' }
    )
  })
  it.each([
    { body: schedule({ grossCents: 0 }) },
    { body: schedule({ grossCents: Number.MAX_SAFE_INTEGER + 1 }) },
    { body: schedule({ compareAtGrossCents: 800 }) },
    { body: schedule({ volumeTiers: [{ minimumQuantity: 4, unitGrossCents: 0 }] }) },
    {
      body: schedule({
        volumeTiers: [
          { minimumQuantity: 8, unitGrossCents: 700 },
          { minimumQuantity: 4, unitGrossCents: 600 }
        ]
      })
    },
    { body: schedule({ validFrom: '2030-02-30T10:00:00Z' }) },
    { body: { ...schedule(), now: NOW } },
    { body: { ...schedule(), reason: 'bad\nreason' } },
    { body: { ...schedule(), price: 900 } },
    { body: { ...schedule(), compareAtGrossCents: undefined } }
  ])('strictly rejects invalid monetary/temporal/unknown own inputs %#', async ({ body }) => {
    await expect(scheduleD1VariantPrice(database, CLAIMS, body, opts())).rejects.toMatchObject({
      code: 'invalid_input'
    })
    expect(rows()).toHaveLength(0)
    expect(rows('catalog_price_commands')).toHaveLength(0)
  })
  it.each([3, 2, 22])('enforces current MOQ/increment/max for tier %s', async (minimumQuantity) => {
    await expect(
      scheduleD1VariantPrice(
        database,
        CLAIMS,
        schedule({ volumeTiers: [{ minimumQuantity, unitGrossCents: 700 }] }),
        opts()
      )
    ).rejects.toMatchObject({ code: 'quantity_conflict' })
    expect(rows()).toHaveLength(0)
  })
  it('accepts bounded ordered positive tiers using existing quantity/money rules', async () => {
    await scheduleD1VariantPrice(
      database,
      CLAIMS,
      schedule({
        volumeTiers: [
          { minimumQuantity: 4, unitGrossCents: 700 },
          { minimumQuantity: 8, unitGrossCents: 700 }
        ]
      }),
      opts()
    )
    expect(JSON.parse(String(rows()[0]!.volume_tiers))).toEqual([
      { minimumQuantity: 4, unitGrossCents: 700 },
      { minimumQuantity: 8, unitGrossCents: 700 }
    ])
  })
  it.each(['permission', 'mfa', 'email', 'logout', 'version'])('revalidates %s before replay', async (change) => {
    await scheduleD1VariantPrice(database, CLAIMS, schedule(), opts())
    if (change === 'permission')
      sqlite.exec("DELETE FROM role_permissions WHERE permission_code='administration.manage'")
    if (change === 'mfa') sqlite.exec('UPDATE auth_sessions SET mfa_verified=0')
    if (change === 'email') sqlite.exec('UPDATE identities SET email_verified_at=NULL')
    if (change === 'logout') sqlite.exec("UPDATE auth_sessions SET revoked_at='2030-10-01T09:00:00Z'")
    if (change === 'version') sqlite.exec('UPDATE identities SET session_version=2')
    await expect(scheduleD1VariantPrice(database, CLAIMS, schedule(), opts())).rejects.toMatchObject({
      code:
        change === 'permission'
          ? 'forbidden'
          : change === 'mfa'
            ? 'mfa_required'
            : change === 'email'
              ? 'email_unverified'
              : 'unauthenticated'
    })
    expect(rows()).toHaveLength(1)
  })
  it('denies late permission revocation atomically before the batch', async () => {
    const batch = database.batch.bind(database)
    vi.spyOn(database, 'batch').mockImplementationOnce(async (statements) => {
      sqlite.exec("DELETE FROM role_permissions WHERE permission_code='administration.manage'")
      return batch(statements)
    })
    await expect(scheduleD1VariantPrice(database, CLAIMS, schedule(), opts())).rejects.toMatchObject({
      code: 'forbidden'
    })
    expect(rows()).toHaveLength(0)
    expect(rows('catalog_price_commands')).toHaveLength(0)
    expect(rows('catalog_price_audit')).toHaveLength(0)
  })
  it.each(['audit', 'insert'])('rolls back claim/window/domain when %s is omitted by a trigger', async (stage) => {
    add('before', '2030-09-01T00:00:00Z', null)
    const before = rows()
    sqlite.exec(
      stage === 'audit'
        ? 'CREATE TRIGGER fixture_skip BEFORE INSERT ON catalog_price_audit BEGIN SELECT RAISE(IGNORE); END'
        : 'CREATE TRIGGER fixture_skip BEFORE INSERT ON variant_price_versions BEGIN SELECT RAISE(IGNORE); END'
    )
    await expect(
      scheduleD1VariantPrice(database, CLAIMS, schedule({ expectedLatestApprovedId: 'before' }), opts())
    ).rejects.toMatchObject({ code: 'conflict' })
    expect(rows()).toEqual(before)
    expect(rows('catalog_price_commands')).toHaveLength(0)
    expect(rows('catalog_price_audit')).toHaveLength(0)
  })
  it('rejects stale editorial or head CAS without mutation', async () => {
    await expect(
      scheduleD1VariantPrice(database, CLAIMS, schedule({ expectedCatalogVersion: 2 }), opts())
    ).rejects.toMatchObject({ code: 'version_conflict' })
    await expect(
      scheduleD1VariantPrice(database, CLAIMS, schedule({ expectedLatestApprovedId: 'nonexistent' }), opts())
    ).rejects.toMatchObject({ code: 'head_conflict' })
    expect(rows()).toHaveLength(0)
  })
  it('uses normalized millisecond windows, excluding cancelled and exact left-boundary expiry', async () => {
    add('expired-boundary', '2030-08-01T00:00:00Z', '2030-09-01T10:00:00.000Z', 200)
    add('in-window', '2030-09-01T10:00:00.001Z', '2030-09-20T00:00:00Z', 500)
    add('head', '2030-09-20T00:00:00Z', null, 900)
    await scheduleD1VariantPrice(database, CLAIMS, schedule({ expectedLatestApprovedId: 'head' }), opts())
    expect(rows().find((row) => row.reason === 'Synthetic local price decision')).toMatchObject({
      reference_gross_cents_30d: 500
    })
  })
  it('never invents a 30-day reference from an expired price or draft base', async () => {
    add('expired', '2029-01-01T00:00:00Z', '2029-02-01T00:00:00Z', 100)
    await scheduleD1VariantPrice(database, CLAIMS, schedule({ expectedLatestApprovedId: 'expired' }), opts())
    // Scheduling closes the approved head at the new time, so this legacy
    // imported finite window must not be retroactively treated as coverage.
    expect(rows().find((row) => row.reason === 'Synthetic local price decision')).toMatchObject({
      reference_gross_cents_30d: null
    })
  })
  it('strict schema rejects getters/prototypes without reading hostile accessors', () => {
    const getter = vi.fn(() => 800)
    const poisoned = Object.defineProperty({ ...schedule() }, 'grossCents', { enumerable: true, get: getter })
    expect(catalogPriceScheduleInputSchema.safeParse(poisoned).success).toBe(false)
    expect(catalogPriceScheduleInputSchema.safeParse(Object.assign(Object.create({}), schedule())).success).toBe(false)
    expect(
      catalogPriceCancelInputSchema.safeParse({
        expectedCatalogVersion: 1,
        expectedLatestApprovedId: 'id',
        reason: 'valid reason',
        extra: true
      }).success
    ).toBe(false)
    expect(getter).not.toHaveBeenCalled()
  })
  it('restores an original finite predecessor window and refuses external predecessor drift', async () => {
    add('finite', '2030-09-01T00:00:00Z', '2030-12-01T00:00:00Z')
    const created = await scheduleD1VariantPrice(
      database,
      CLAIMS,
      schedule({ expectedLatestApprovedId: 'finite' }),
      opts()
    )
    const cancelInput = {
      expectedCatalogVersion: 1,
      expectedLatestApprovedId: created.priceId,
      reason: 'Synthetic cancellation decision'
    }
    sqlite.exec("UPDATE variant_price_versions SET valid_until='2030-10-01T09:30:00Z' WHERE id='finite'")
    const drifted = rows()
    await expect(
      cancelD1ScheduledPrice(database, CLAIMS, created.priceId, cancelInput, opts('cancel'))
    ).rejects.toMatchObject({ code: 'conflict' })
    expect(rows()).toEqual(drifted)
    sqlite.exec("UPDATE variant_price_versions SET valid_until='2030-10-01T10:00:00.000Z' WHERE id='finite'")
    await cancelD1ScheduledPrice(database, CLAIMS, created.priceId, cancelInput, opts('cancel'))
    expect(rows().find((row) => row.id === 'finite')).toMatchObject({ valid_until: '2030-12-01T00:00:00Z' })
  })
  it('cancels imported heads without filling unrelated historic gaps', async () => {
    add('expired', '2029-01-01T00:00:00Z', '2029-02-01T00:00:00Z', 100)
    add('future import', '2030-10-01T10:00:00Z', null, 1000)
    await cancelD1ScheduledPrice(
      database,
      CLAIMS,
      'future import',
      { expectedCatalogVersion: 1, expectedLatestApprovedId: 'future import', reason: 'Synthetic cancellation' },
      opts()
    )
    expect(rows().find((row) => row.id === 'expired')).toMatchObject({ valid_until: '2029-02-01T00:00:00Z' })
    expect(effective('2030-10-01T11:00:00Z')).toEqual({ gross: 0 })
  })
  it('reopens the exact imported Node-compatible predecessor closure', async () => {
    add('prior', '2030-09-01T00:00:00Z', '2030-10-01T10:00:00.000Z', 900)
    add('future import', '2030-10-01T10:00:00Z', null, 1000)
    await cancelD1ScheduledPrice(
      database,
      CLAIMS,
      'future import',
      { expectedCatalogVersion: 1, expectedLatestApprovedId: 'future import', reason: 'Synthetic cancellation' },
      opts()
    )
    expect(rows().find((row) => row.id === 'prior')).toMatchObject({ valid_until: null })
    expect(effective('2030-10-01T11:00:00Z')).toEqual({ gross: 900 })
  })
  it.each(['current', 'older', 'cancelled'])('cannot cancel a %s version', async (kind) => {
    add('target', kind === 'current' ? '2030-10-01T09:00:00Z' : '2030-10-01T10:00:00Z', null)
    if (kind === 'older') add('later', '2030-10-01T11:00:00Z', null)
    if (kind === 'cancelled')
      sqlite
        .prepare(
          "UPDATE variant_price_versions SET status='cancelled',cancelled_by=?,cancelled_at=?,cancellation_reason='Synthetic' WHERE id='target'"
        )
        .run(IDENTITY, NOW)
    const before = rows()
    await expect(
      cancelD1ScheduledPrice(
        database,
        CLAIMS,
        'target',
        {
          expectedCatalogVersion: 1,
          expectedLatestApprovedId: kind === 'older' ? 'later' : 'target',
          reason: 'Synthetic cancel'
        },
        opts()
      )
    ).rejects.toBeInstanceOf(Error)
    expect(rows()).toEqual(before)
    expect(rows('catalog_price_commands')).toHaveLength(0)
  })
  it.each(['version', 'head', 'quantity', 'clock'])(
    'rejects late %s drift before the atomic mutation',
    async (change) => {
      const batch = database.batch.bind(database)
      vi.spyOn(database, 'batch').mockImplementationOnce(async (statements) => {
        if (change === 'version') sqlite.prepare('UPDATE products SET catalog_version=2 WHERE id=?').run(PRODUCT)
        if (change === 'head') add('external', '2030-10-01T09:30:00Z', null)
        if (change === 'quantity') sqlite.prepare('UPDATE variants SET quantity_increment=3 WHERE id=?').run(VARIANT)
        if (change === 'clock') sqlite.exec("UPDATE auth_sessions SET expires_at='2030-10-01T09:00:00Z'")
        return batch(statements)
      })
      await expect(
        scheduleD1VariantPrice(
          database,
          CLAIMS,
          schedule({ volumeTiers: [{ minimumQuantity: 4, unitGrossCents: 700 }] }),
          opts()
        )
      ).rejects.toBeInstanceOf(Error)
      expect(rows('catalog_price_commands')).toHaveLength(0)
      expect(rows('catalog_price_audit')).toHaveLength(0)
      expect(rows()).toHaveLength(change === 'head' ? 1 : 0)
    }
  )
  it.each(['inherited', 'getter', 'missing', 'rows_getter'])(
    'never reports success from %s provider results after a committed batch',
    async (mode) => {
      const batch = database.batch.bind(database),
        getter = vi.fn(() => true)
      vi.spyOn(database, 'batch').mockImplementationOnce(async (statements) => {
        const results = await batch(statements)
        if (mode === 'inherited') results[0] = Object.assign(Object.create({ success: true }), { results: [] })
        if (mode === 'getter') Object.defineProperty(results[0], 'success', { enumerable: true, get: getter })
        if (mode === 'missing') Reflect.deleteProperty(results[0]!, 'success')
        if (mode === 'rows_getter') Object.defineProperty(results[0], 'results', { enumerable: true, get: getter })
        return results
      })
      await expect(scheduleD1VariantPrice(database, CLAIMS, schedule(), opts())).rejects.toThrow(
        'price_write_unavailable'
      )
      expect(getter).not.toHaveBeenCalled()
      expect(rows()).toHaveLength(1)
      expect(rows('catalog_price_commands')).toHaveLength(1)
      const replay = await scheduleD1VariantPrice(database, CLAIMS, schedule(), opts())
      expect(replay).toMatchObject({ action: 'price_schedule', updated: true })
      expect(rows()).toHaveLength(1)
    }
  )
  it('does not reveal the committed receipt after permission is revoked during the provider await', async () => {
    const batch = database.batch.bind(database)
    vi.spyOn(database, 'batch').mockImplementationOnce(async (statements) => {
      const result = await batch(statements)
      sqlite.exec("DELETE FROM role_permissions WHERE permission_code='administration.manage'")
      return result
    })
    await expect(scheduleD1VariantPrice(database, CLAIMS, schedule(), opts())).rejects.toMatchObject({
      code: 'forbidden'
    })
    expect(rows()).toHaveLength(1)
    expect(rows('catalog_price_audit')).toHaveLength(1)
  })
  it.each(
    ['context', 'replay', 'lookup'].flatMap((stage) => ['getter', 'inherited', 'missing'].map((mode) => [stage, mode]))
  )(
    'rejects %s first row with %s fields without evaluating getters or classifying outage as missing',
    async (stage, mode) => {
      const committed = stage === 'context' ? null : await scheduleD1VariantPrice(database, CLAIMS, schedule(), opts())
      const marker =
        stage === 'context'
          ? ' AS snapshot'
          : stage === 'replay'
            ? 'SELECT c.payload_hash,c.response'
            : 'SELECT variant_id FROM variant_price_versions'
      const field = stage === 'context' ? 'currency' : stage === 'replay' ? 'response' : 'variant_id'
      const getter = vi.fn(() => {
        throw new Error('must not evaluate provider getter')
      })
      const prepare = database.prepare.bind(database)
      vi.spyOn(database, 'prepare').mockImplementation((sql) => {
        const statement = prepare(sql)
        if (!sql.includes(marker)) return statement
        return new Proxy(statement, {
          get(target, property, receiver) {
            if (property === 'bind')
              return (...parameters: Array<string | number | null>) =>
                new Proxy(target.bind(...parameters), {
                  get(bound, method, boundReceiver) {
                    if (method === 'first')
                      return async () => {
                        const row = await bound.first()
                        if (row === null || typeof row !== 'object') return row
                        if (mode === 'inherited') return Object.create(row)
                        const poisoned = Object.assign(Object.create(null), row)
                        if (mode === 'getter') Object.defineProperty(poisoned, field, { enumerable: true, get: getter })
                        else Reflect.deleteProperty(poisoned, field)
                        return poisoned
                      }
                    const value = Reflect.get(bound, method, boundReceiver)
                    return typeof value === 'function' ? value.bind(bound) : value
                  }
                })
            const value = Reflect.get(target, property, receiver)
            return typeof value === 'function' ? value.bind(target) : value
          }
        })
      })
      const action =
        stage === 'lookup'
          ? cancelD1ScheduledPrice(
              database,
              CLAIMS,
              committed!.priceId,
              {
                expectedCatalogVersion: 1,
                expectedLatestApprovedId: committed!.priceId,
                reason: 'Synthetic cancellation'
              },
              opts('cancel-key')
            )
          : scheduleD1VariantPrice(database, CLAIMS, schedule(), opts())
      await expect(action).rejects.toThrow('price_provider_invalid')
      expect(getter).not.toHaveBeenCalled()
      expect(rows()).toHaveLength(committed ? 1 : 0)
      expect(rows('catalog_price_commands')).toHaveLength(committed ? 1 : 0)
    }
  )
  it('allows exactly one new command for concurrent identical key/body calls', async () => {
    const results = await Promise.all([
      scheduleD1VariantPrice(database, CLAIMS, schedule(), opts()),
      scheduleD1VariantPrice(database, CLAIMS, schedule(), opts())
    ])
    expect(results[0]).toEqual(results[1])
    expect(rows()).toHaveLength(1)
    expect(rows('catalog_price_commands')).toHaveLength(1)
  })
  it('all SQL statements stay bounded within D1 byte and binding limits', async () => {
    const prepare = vi.spyOn(database, 'prepare')
    await scheduleD1VariantPrice(database, CLAIMS, schedule(), opts())
    for (const [sql] of prepare.mock.calls) {
      expect(new TextEncoder().encode(sql).length).toBeLessThanOrEqual(100000)
      expect(Math.max(0, ...[...sql.matchAll(/\?(\d+)/g)].map((match) => Number(match[1])))).toBeLessThanOrEqual(100)
    }
  })
})
