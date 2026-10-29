import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  upsertD1B2BPriceList,
  assignD1CompanyB2BPriceList,
  resolveD1EffectiveB2BVariantPrice,
  unassignD1CompanyB2BPriceList
} from '../../workers/catalog/b2b-pricing'
import { returnsFixture, CLAIMS, BUYER_CLAIMS, CUSTOMER, utc } from './d1-returns-fixture'

async function world() {
  const f = await returnsFixture()
  try {
    f.sqlite.exec(await readFile('db/d1/migrations/0101_b2b_price_lists_credit.sql', 'utf8'))
    const now = utc(),
      before = utc(-60000)
    f.sqlite.exec(
      `INSERT INTO companies(id,customer_id,legal_name,status,created_at,updated_at) VALUES('company','${CUSTOMER}','Empresa','approved','${before}','${before}')`
    )
    return { ...f, now, options: () => ({ idempotencyKey: crypto.randomUUID(), now: () => now }) }
  } catch (error) {
    f.sqlite.close()
    throw error
  }
}
const list = {
  code: 'LIST',
  name: 'Tarifa',
  status: 'active' as const,
  validFrom: '2026-01-01T00:00:00Z',
  validUntil: null,
  variantRules: [{ variantId: 'v-1-1', unitGrossCents: 333 }],
  categoryRules: [],
  reason: 'Tarifa acordada'
}
describe('audited contractual pricing commands', () => {
  it('accepts a 95 percent category discount, rejects higher discounts and zero fixed prices', async () => {
    const f = await world()
    try {
      await upsertD1B2BPriceList(
        f.database,
        CLAIMS,
        {
          ...list,
          variantRules: [],
          categoryRules: [{ categoryId: 'c1', discountBps: 9500 }]
        },
        f.options()
      )
      await expect(
        upsertD1B2BPriceList(
          f.database,
          CLAIMS,
          {
            ...list,
            code: 'TOO-HIGH',
            variantRules: [],
            categoryRules: [{ categoryId: 'c1', discountBps: 9501 }]
          },
          f.options()
        )
      ).rejects.toMatchObject({ code: 'invalid_input' })
      await expect(
        upsertD1B2BPriceList(
          f.database,
          CLAIMS,
          {
            ...list,
            code: 'ZERO',
            variantRules: [{ variantId: 'v-1-1', unitGrossCents: 0 }]
          },
          f.options()
        )
      ).rejects.toMatchObject({ code: 'invalid_input' })
      expect(f.sqlite.prepare('SELECT count(*) n FROM b2b_pricing_commands').get()).toMatchObject({ n: 1 })
    } finally {
      f.sqlite.close()
    }
  })
  it('creates, replays and rejects command-key reuse with a different payload', async () => {
    const f = await world()
    try {
      const options = f.options()
      const first = await upsertD1B2BPriceList(f.database, CLAIMS, list, options)
      expect(first.version).toBe(1)
      expect(await upsertD1B2BPriceList(f.database, CLAIMS, list, options)).toEqual(first)
      await expect(upsertD1B2BPriceList(f.database, CLAIMS, { ...list, name: 'Otra' }, options)).rejects.toMatchObject({
        code: 'conflict'
      })
      expect(f.sqlite.prepare('SELECT count(*) n FROM b2b_pricing_commands').get()).toMatchObject({ n: 1 })
    } finally {
      f.sqlite.close()
    }
  })
  it('rejects stale CAS and writes nothing on conflict', async () => {
    const f = await world()
    try {
      const created = await upsertD1B2BPriceList(f.database, CLAIMS, list, f.options())
      await expect(
        upsertD1B2BPriceList(
          f.database,
          CLAIMS,
          { ...list, priceListId: created.priceListId, expectedVersion: 99 },
          f.options()
        )
      ).rejects.toMatchObject({ code: 'conflict' })
      expect(f.sqlite.prepare('SELECT count(*) n FROM b2b_pricing_commands').get()).toMatchObject({ n: 1 })
      const updated = await upsertD1B2BPriceList(
        f.database,
        CLAIMS,
        { ...list, priceListId: created.priceListId, expectedVersion: 1, name: 'Nueva' },
        f.options()
      )
      expect(updated.version).toBeGreaterThan(1)
    } finally {
      f.sqlite.close()
    }
  })
  it('rejects a buyer without commercial permission', async () => {
    const f = await world()
    try {
      await expect(upsertD1B2BPriceList(f.database, BUYER_CLAIMS, list, f.options())).rejects.toMatchObject({
        code: 'mfa_required'
      })
      expect(f.sqlite.prepare('SELECT count(*) n FROM b2b_pricing_commands').get()).toMatchObject({ n: 0 })
    } finally {
      f.sqlite.close()
    }
  })
  it('assigns only an approved company and uses assignment CAS', async () => {
    const f = await world()
    try {
      const created = await upsertD1B2BPriceList(f.database, CLAIMS, list, f.options())
      const assignment = {
        expectedVersion: 0,
        priceListId: created.priceListId,
        validFrom: '2026-01-01T00:00:00Z',
        validUntil: null,
        reason: 'Acuerdo comercial'
      }
      expect((await assignD1CompanyB2BPriceList(f.database, CLAIMS, 'company', assignment, f.options())).version).toBe(
        1
      )
      await expect(
        assignD1CompanyB2BPriceList(f.database, CLAIMS, 'company', assignment, f.options())
      ).rejects.toMatchObject({ code: 'conflict' })
      f.sqlite.exec("UPDATE companies SET status='suspended' WHERE id='company'")
      await expect(
        assignD1CompanyB2BPriceList(f.database, CLAIMS, 'company', { ...assignment, expectedVersion: 1 }, f.options())
      ).rejects.toMatchObject({ code: 'conflict' })
      expect(f.sqlite.prepare('SELECT count(*) n FROM b2b_pricing_commands').get()).toMatchObject({ n: 2 })
    } finally {
      f.sqlite.close()
    }
  })
  it('serializes two updates competing for the same version', async () => {
    const f = await world()
    try {
      const created = await upsertD1B2BPriceList(f.database, CLAIMS, list, f.options())
      const base = { ...list, priceListId: created.priceListId, expectedVersion: 1 }
      const results = await Promise.allSettled([
        upsertD1B2BPriceList(f.database, CLAIMS, { ...base, name: 'Primera' }, f.options()),
        upsertD1B2BPriceList(f.database, CLAIMS, { ...base, name: 'Segunda' }, f.options())
      ])
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1)
      expect(f.sqlite.prepare('SELECT count(*) n FROM b2b_pricing_commands').get()).toMatchObject({ n: 2 })
    } finally {
      f.sqlite.close()
    }
  })
  it('rolls back the command when a referenced variant is missing', async () => {
    const f = await world()
    try {
      await expect(
        upsertD1B2BPriceList(
          f.database,
          CLAIMS,
          { ...list, variantRules: [{ variantId: 'missing', unitGrossCents: 10 }] },
          f.options()
        )
      ).rejects.toThrow()
      expect(f.sqlite.prepare('SELECT count(*) n FROM b2b_pricing_commands').get()).toMatchObject({ n: 0 })
      expect(f.sqlite.prepare('SELECT count(*) n FROM b2b_price_lists').get()).toMatchObject({ n: 0 })
    } finally {
      f.sqlite.close()
    }
  })
  it('keeps command evidence immutable', async () => {
    const f = await world()
    try {
      await upsertD1B2BPriceList(f.database, CLAIMS, list, f.options())
      expect(() => f.sqlite.exec("UPDATE b2b_pricing_commands SET action='changed'")).toThrow()
      expect(() => f.sqlite.exec('DELETE FROM b2b_pricing_commands')).toThrow()
      expect(() =>
        f.sqlite.exec('INSERT OR REPLACE INTO b2b_pricing_commands SELECT * FROM b2b_pricing_commands')
      ).toThrow()
    } finally {
      f.sqlite.close()
    }
  })
  it('rechecks administrative authority inside the mutation batch', async () => {
    const f = await world()
    try {
      let fired = false
      const db = new Proxy(f.database, {
        get(target, key) {
          if (key === 'batch')
            return async (statements: D1PreparedStatement[]) => {
              if (!fired) {
                fired = true
                f.sqlite.prepare('UPDATE auth_sessions SET mfa_verified=0 WHERE id=?').run(CLAIMS.sessionId)
              }
              return target.batch(statements)
            }
          const value: unknown = Reflect.get(target, key)
          return typeof value === 'function' ? value.bind(target) : value
        }
      })
      await expect(upsertD1B2BPriceList(db, CLAIMS, list, f.options())).rejects.toMatchObject({ code: 'mfa_required' })
      expect(f.sqlite.prepare('SELECT count(*) n FROM b2b_pricing_commands').get()).toMatchObject({ n: 0 })
    } finally {
      f.sqlite.close()
    }
  })
  it('prevents changes to a managed tariff that bypass its audited command', async () => {
    const f = await world()
    try {
      const created = await upsertD1B2BPriceList(f.database, CLAIMS, list, f.options())
      expect(() =>
        f.sqlite
          .prepare('UPDATE b2b_price_lists SET version=version+1,name=? WHERE id=?')
          .run('Sin auditoría', created.priceListId)
      ).toThrow()
      expect(() =>
        f.sqlite
          .prepare('UPDATE b2b_variant_rules SET unit_gross_cents=999 WHERE price_list_id=?')
          .run(created.priceListId)
      ).toThrow()
      expect(f.sqlite.prepare('SELECT count(*) n FROM b2b_pricing_commands').get()).toMatchObject({ n: 1 })
    } finally {
      f.sqlite.close()
    }
  })
  it('rejects replacing or changing a managed assignment outside an audited command', async () => {
    const f = await world()
    try {
      const created = await upsertD1B2BPriceList(f.database, CLAIMS, list, f.options())
      const assignment = {
        expectedVersion: 0,
        priceListId: created.priceListId,
        validFrom: '2026-01-01T00:00:00Z',
        validUntil: null,
        reason: 'Acuerdo comercial'
      }
      await assignD1CompanyB2BPriceList(f.database, CLAIMS, 'company', assignment, f.options())
      expect(() =>
        f.sqlite.exec("UPDATE b2b_company_assignments SET version=version+1 WHERE company_id='company'")
      ).toThrow()
      expect(() =>
        f.sqlite.exec(
          "INSERT OR REPLACE INTO b2b_company_assignments SELECT * FROM b2b_company_assignments WHERE company_id='company'"
        )
      ).toThrow()
    } finally {
      f.sqlite.close()
    }
  })
  it('rejects creating an unaudited tariff before any command exists', async () => {
    const f = await world()
    try {
      expect(() =>
        f.sqlite
          .prepare(
            "INSERT INTO b2b_price_lists(id,code,name,version,valid_from,created_at,updated_at) VALUES('raw','RAW','Raw',1,?,?,?)"
          )
          .run(f.now, f.now, f.now)
      ).toThrow()
      expect(f.sqlite.prepare('SELECT count(*) n FROM b2b_price_lists').get()).toMatchObject({ n: 0 })
    } finally {
      f.sqlite.close()
    }
  })
  it('unassigns with CAS and preserves an audited, versioned tombstone', async () => {
    const f = await world()
    try {
      const created = await upsertD1B2BPriceList(f.database, CLAIMS, list, f.options())
      await assignD1CompanyB2BPriceList(
        f.database,
        CLAIMS,
        'company',
        {
          expectedVersion: 0,
          priceListId: created.priceListId,
          validFrom: '2026-01-01T00:00:00Z',
          validUntil: null,
          reason: 'Acuerdo comercial'
        },
        f.options()
      )
      const options = f.options()
      const removed = await unassignD1CompanyB2BPriceList(
        f.database,
        CLAIMS,
        'company',
        { expectedVersion: 1, reason: 'Fin del acuerdo' },
        options
      )
      expect(removed.version).toBe(2)
      expect(
        await unassignD1CompanyB2BPriceList(
          f.database,
          CLAIMS,
          'company',
          { expectedVersion: 1, reason: 'Fin del acuerdo' },
          options
        )
      ).toEqual(removed)
      expect(
        f.sqlite.prepare("SELECT active,version FROM b2b_company_assignments WHERE company_id='company'").get()
      ).toMatchObject({ active: 0, version: 2 })
      const publicPrice = await resolveD1EffectiveB2BVariantPrice(f.database, {
        variantId: 'v-1-1',
        customerId: CUSTOMER,
        instant: f.now
      })
      expect(publicPrice).toMatchObject({ unitGrossCents: 500, source: 'public' })
      const reinstated = await assignD1CompanyB2BPriceList(
        f.database,
        CLAIMS,
        'company',
        {
          expectedVersion: 2,
          priceListId: created.priceListId,
          validFrom: '2026-01-01T00:00:00Z',
          validUntil: null,
          reason: 'Nuevo acuerdo'
        },
        f.options()
      )
      expect(reinstated.version).toBe(3)
      const contractual = await resolveD1EffectiveB2BVariantPrice(f.database, {
        variantId: 'v-1-1',
        customerId: CUSTOMER,
        instant: f.now
      })
      expect(contractual).toMatchObject({ unitGrossCents: 333, source: 'b2b_variant' })
      await expect(
        unassignD1CompanyB2BPriceList(
          f.database,
          CLAIMS,
          'company',
          { expectedVersion: 1, reason: 'Fin del acuerdo' },
          f.options()
        )
      ).rejects.toMatchObject({ code: 'conflict' })
    } finally {
      f.sqlite.close()
    }
  })
  it('cannot retarget an authorized command context to another tariff', async () => {
    const f = await world()
    try {
      const first = await upsertD1B2BPriceList(f.database, CLAIMS, list, f.options())
      const second = await upsertD1B2BPriceList(f.database, CLAIMS, { ...list, code: 'OTHER' }, f.options())
      const key = crypto.randomUUID()
      f.sqlite
        .prepare(
          'INSERT INTO b2b_pricing_commands(actor_id,command_id,session_id,session_version,action,payload_hash,input_json,receipt_json,created_at) VALUES(?,?,?,1,?,?,?,?,?)'
        )
        .run(
          CLAIMS.identityId,
          key,
          CLAIMS.sessionId,
          'upsert_price_list',
          '0'.repeat(64),
          '{}',
          JSON.stringify({ priceListId: first.priceListId }),
          f.now
        )
      f.sqlite
        .prepare(
          'INSERT INTO b2b_pricing_write_context(actor_id,command_id,price_list_id,company_id) VALUES(?,?,?,NULL)'
        )
        .run(CLAIMS.identityId, key, first.priceListId)
      expect(() =>
        f.sqlite
          .prepare('UPDATE b2b_pricing_write_context SET price_list_id=? WHERE actor_id=? AND command_id=?')
          .run(second.priceListId, CLAIMS.identityId, key)
      ).toThrow()
    } finally {
      f.sqlite.close()
    }
  })
  it('reports storage failures as unavailable rather than version conflicts', async () => {
    const f = await world()
    try {
      const db = new Proxy(f.database, {
        get(target, key) {
          if (key === 'batch')
            return async () => {
              throw new Error('storage offline')
            }
          const value: unknown = Reflect.get(target, key)
          return typeof value === 'function' ? value.bind(target) : value
        }
      })
      await expect(upsertD1B2BPriceList(db, CLAIMS, list, f.options())).rejects.toMatchObject({ code: 'unavailable' })
      expect(f.sqlite.prepare('SELECT count(*) n FROM b2b_pricing_commands').get()).toMatchObject({ n: 0 })
    } finally {
      f.sqlite.close()
    }
  })
})
