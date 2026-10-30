import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { returnsFixture, CLAIMS, BUYER_CLAIMS, CUSTOMER, utc } from './d1-returns-fixture'
import { upsertD1B2BPriceList, assignD1CompanyB2BPriceList } from '../../workers/catalog/b2b-pricing'
import { QuickOrderCompanyError, resolveCompanyQuickOrder } from '../../workers/catalog/quick-order-company'

const companyId = '30000000-0000-4000-8000-000000000099'
async function world(status: 'approved' | 'pending' | 'suspended' | 'none' = 'approved') {
  const f = await returnsFixture(),
    now = utc(),
    before = utc(-60000)
  f.sqlite.exec(await readFile('db/d1/migrations/0101_b2b_price_lists_credit.sql', 'utf8'))
  if (status !== 'none')
    f.sqlite
      .prepare(
        "INSERT INTO companies(id,customer_id,legal_name,status,created_at,updated_at) VALUES(?,?,'Empresa',?,?,?)"
      )
      .run(companyId, CUSTOMER, status, before, before)
  const options = { now: () => now }
  return { ...f, now, options }
}
const line = (reference: string, quantity = 1) => ({ reference, quantity })
async function withContract(f: Awaited<ReturnType<typeof world>>) {
  const o = { now: () => f.now, idempotencyKey: crypto.randomUUID() }
  await upsertD1B2BPriceList(
    f.database,
    CLAIMS,
    {
      priceListId: 'list',
      expectedVersion: 0,
      code: 'LIST',
      name: 'Profesionales',
      status: 'active',
      validFrom: utc(-60000),
      validUntil: null,
      variantRules: [{ variantId: 'v-1-1', unitGrossCents: 321 }],
      categoryRules: [],
      reason: 'Acuerdo comercial'
    },
    o
  )
  await assignD1CompanyB2BPriceList(
    f.database,
    CLAIMS,
    companyId,
    { priceListId: 'list', expectedVersion: 0, validFrom: utc(-60000), validUntil: null, reason: 'Acuerdo comercial' },
    { ...o, idempotencyKey: crypto.randomUUID() }
  )
}

describe('SEA-018 company-scoped quick order resolution', () => {
  it('resolves SKU lines for an approved company with public prices and live stock', async () => {
    const f = await world()
    try {
      const result = await resolveCompanyQuickOrder(
        f.database,
        BUYER_CLAIMS,
        { lines: [line('SKU-2-1', 3)] },
        f.options
      )
      expect(result.companyId).toBe(companyId)
      expect(result.lines).toHaveLength(1)
      expect(result.lines[0]).toMatchObject({
        index: 0,
        status: 'ready',
        reference: 'SKU-2-1',
        quantity: 3,
        variantId: 'v-2-1',
        legacyVariantId: 21,
        sku: 'SKU-2-1',
        unitGrossCents: 500,
        grossCents: 1500,
        source: 'public'
      })
    } finally {
      f.sqlite.close()
    }
  })
  it('applies the contract price of the authenticated company, never a client supplied one', async () => {
    const f = await world()
    try {
      await withContract(f)
      const result = await resolveCompanyQuickOrder(
        f.database,
        BUYER_CLAIMS,
        { lines: [line('SKU-1-1', 2)] },
        f.options
      )
      expect(result.lines[0]).toMatchObject({
        status: 'ready',
        unitGrossCents: 321,
        grossCents: 642,
        source: 'b2b_variant'
      })
    } finally {
      f.sqlite.close()
    }
  })
  it('matches exact EAN, GTIN and MPN identifiers', async () => {
    const f = await world()
    try {
      f.sqlite.exec(
        "UPDATE variants SET ean='8412345678905' WHERE id='v-2-1'; UPDATE variants SET gtin='10012345678902' WHERE id='v-3-1'; UPDATE variants SET mpn='MPN-4' WHERE id='v-4-1'"
      )
      const result = await resolveCompanyQuickOrder(
        f.database,
        BUYER_CLAIMS,
        { lines: [line('8412345678905'), line('10012345678902'), line('MPN-4')] },
        f.options
      )
      expect(result.lines.map((l) => (l.status === 'ready' ? l.variantId : l.code))).toEqual([
        'v-2-1',
        'v-3-1',
        'v-4-1'
      ])
    } finally {
      f.sqlite.close()
    }
  })
  it('reports not_found, ambiguous and unpublished references per line without failing the batch', async () => {
    const f = await world()
    try {
      f.sqlite.exec(
        "UPDATE variants SET mpn='DUP' WHERE id IN ('v-2-1','v-3-1'); UPDATE variants SET status='hidden' WHERE id='v-5-1'"
      )
      const result = await resolveCompanyQuickOrder(
        f.database,
        BUYER_CLAIMS,
        { lines: [line('NOPE'), line('DUP'), line('SKU-5-1'), line('SKU-6-1')] },
        f.options
      )
      expect(result.lines.map((l) => (l.status === 'ready' ? 'ready' : l.code))).toEqual([
        'not_found',
        'ambiguous',
        'not_found',
        'ready'
      ])
    } finally {
      f.sqlite.close()
    }
  })
  it('does not resolve variants of a product that is not published', async () => {
    const f = await world()
    try {
      f.sqlite.exec("UPDATE products SET status='draft' WHERE id='p-2'")
      const result = await resolveCompanyQuickOrder(f.database, BUYER_CLAIMS, { lines: [line('SKU-2-1')] }, f.options)
      expect(result.lines[0]).toMatchObject({ status: 'error', code: 'not_found' })
    } finally {
      f.sqlite.close()
    }
  })
  it('flags insufficient stock unless backorder is allowed', async () => {
    const f = await world()
    try {
      const result = await resolveCompanyQuickOrder(
        f.database,
        BUYER_CLAIMS,
        { lines: [line('SKU-4-1', 500), line('SKU-5-1', 500)] },
        f.options
      )
      expect(result.lines[0]).toMatchObject({ status: 'error', code: 'insufficient_stock' })
      expect(result.lines[1]).toMatchObject({ status: 'ready', backorderAllowed: true })
    } finally {
      f.sqlite.close()
    }
  })
  it('enforces minimum, increment and maximum quantity rules', async () => {
    const f = await world()
    try {
      f.sqlite.exec("UPDATE variants SET minimum_quantity=2, quantity_increment=2, maximum_quantity=6 WHERE id='v-1-1'")
      const result = await resolveCompanyQuickOrder(
        f.database,
        BUYER_CLAIMS,
        { lines: [line('SKU-1-1', 1), line('SKU-1-1', 3), line('SKU-1-1', 4)] },
        f.options
      )
      expect(result.lines.map((l) => (l.status === 'ready' ? 'ready' : l.code))).toEqual([
        'quantity_not_allowed',
        'duplicate_reference',
        'duplicate_reference'
      ])
      const ok = await resolveCompanyQuickOrder(f.database, BUYER_CLAIMS, { lines: [line('SKU-1-1', 4)] }, f.options)
      expect(ok.lines[0]).toMatchObject({ status: 'ready', quantity: 4 })
      const over = await resolveCompanyQuickOrder(f.database, BUYER_CLAIMS, { lines: [line('SKU-1-1', 8)] }, f.options)
      expect(over.lines[0]).toMatchObject({ status: 'error', code: 'quantity_not_allowed' })
    } finally {
      f.sqlite.close()
    }
  })
  it('rejects the same variant referenced through different identifiers', async () => {
    const f = await world()
    try {
      f.sqlite.exec("UPDATE variants SET ean='8412345678905' WHERE id='v-2-1'")
      const result = await resolveCompanyQuickOrder(
        f.database,
        BUYER_CLAIMS,
        { lines: [line('SKU-2-1', 1), line('8412345678905', 1)] },
        f.options
      )
      expect(result.lines.map((l) => (l.status === 'ready' ? 'ready' : l.code))).toEqual(['ready', 'duplicate_variant'])
    } finally {
      f.sqlite.close()
    }
  })
  it('requires an authenticated customer', async () => {
    const f = await world()
    try {
      await expect(
        resolveCompanyQuickOrder(f.database, null, { lines: [line('SKU-1-1')] }, f.options)
      ).rejects.toMatchObject({
        code: 'unauthenticated'
      })
      await expect(
        resolveCompanyQuickOrder(
          f.database,
          { ...BUYER_CLAIMS, sessionVersion: 2 },
          { lines: [line('SKU-1-1')] },
          f.options
        )
      ).rejects.toMatchObject({ code: 'unauthenticated' })
    } finally {
      f.sqlite.close()
    }
  })
  it('refuses customers without a company and companies that are not approved', async () => {
    for (const [status, code] of [
      ['none', 'not_company'],
      ['pending', 'company_not_approved'],
      ['suspended', 'company_not_approved']
    ] as const) {
      const f = await world(status)
      try {
        await expect(
          resolveCompanyQuickOrder(f.database, BUYER_CLAIMS, { lines: [line('SKU-1-1')] }, f.options)
        ).rejects.toMatchObject({ code })
      } finally {
        f.sqlite.close()
      }
    }
  })
  it('refuses a blocked customer and a revoked session', async () => {
    const f = await world()
    try {
      f.sqlite.exec("UPDATE customers SET status='blocked'")
      await expect(
        resolveCompanyQuickOrder(f.database, BUYER_CLAIMS, { lines: [line('SKU-1-1')] }, f.options)
      ).rejects.toMatchObject({ code: 'unauthenticated' })
    } finally {
      f.sqlite.close()
    }
    const g = await world()
    try {
      g.sqlite
        .prepare('UPDATE auth_sessions SET revoked_at=? WHERE identity_id=?')
        .run(utc(-1000), BUYER_CLAIMS.identityId)
      await expect(
        resolveCompanyQuickOrder(g.database, BUYER_CLAIMS, { lines: [line('SKU-1-1')] }, g.options)
      ).rejects.toMatchObject({ code: 'unauthenticated' })
    } finally {
      g.sqlite.close()
    }
  })
  it('never accepts identity, company or time chosen by the client', async () => {
    const f = await world()
    try {
      for (const extra of [{ companyId }, { customerId: CUSTOMER }, { now: '2020-01-01T00:00:00Z' }]) {
        await expect(
          resolveCompanyQuickOrder(f.database, BUYER_CLAIMS, { lines: [line('SKU-1-1')], ...extra }, f.options)
        ).rejects.toMatchObject({ code: 'invalid_input' })
      }
      await expect(
        resolveCompanyQuickOrder(f.database, BUYER_CLAIMS, { lines: [{ ...line('SKU-1-1'), price: 1 }] }, f.options)
      ).rejects.toMatchObject({ code: 'invalid_input' })
    } finally {
      f.sqlite.close()
    }
  })
  it('validates the input envelope', async () => {
    const f = await world()
    try {
      const bad: unknown[] = [
        null,
        {},
        { lines: [] },
        { lines: Array.from({ length: 101 }, (_, i) => line(`SKU-${i}`)) },
        { lines: [line('', 1)] },
        { lines: [line('SKU-1-1', 0)] },
        { lines: [line('SKU-1-1', 1000)] },
        { lines: [line('SKU-1-1', 1.5)] },
        { lines: [{ reference: 'SKU-1-1', quantity: '2' }] },
        { lines: [line('A'.repeat(161))] }
      ]
      for (const input of bad)
        await expect(resolveCompanyQuickOrder(f.database, BUYER_CLAIMS, input, f.options)).rejects.toBeInstanceOf(
          QuickOrderCompanyError
        )
    } finally {
      f.sqlite.close()
    }
  })
  it('resolves 100 lines with a bounded number of queries (no N+1)', async () => {
    const f = await world()
    try {
      let statements = 0
      const counting = new Proxy(f.database, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver)
          if (property === 'prepare')
            return (sql: string) => {
              statements++
              return (value as (sql: string) => unknown).call(target, sql)
            }
          return typeof value === 'function' ? value.bind(target) : value
        }
      })
      const lines = Array.from({ length: 100 }, (_, i) => line(i < 6 ? `SKU-${i + 1}-1` : `MISSING-${i}`))
      const result = await resolveCompanyQuickOrder(counting, BUYER_CLAIMS, { lines }, f.options)
      expect(result.lines).toHaveLength(100)
      expect(statements).toBeLessThanOrEqual(8)
    } finally {
      f.sqlite.close()
    }
  })
  it('fails when the company loses approval while the read is in flight', async () => {
    const f = await world()
    try {
      let reads = 0
      const racing = new Proxy(f.database, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver)
          if (property === 'prepare')
            return (sql: string) => {
              if (/FROM variants/.test(sql) && reads++ === 0) f.sqlite.exec("UPDATE companies SET status='suspended'")
              return (value as (sql: string) => unknown).call(target, sql)
            }
          return typeof value === 'function' ? value.bind(target) : value
        }
      })
      await expect(
        resolveCompanyQuickOrder(racing, BUYER_CLAIMS, { lines: [line('SKU-1-1')] }, f.options)
      ).rejects.toMatchObject({ code: 'company_not_approved' })
    } finally {
      f.sqlite.close()
    }
  })
  it('does not leak cost or internal columns', async () => {
    const f = await world()
    try {
      f.sqlite.exec("UPDATE variants SET cost_net_cents=100 WHERE id='v-1-1'")
      const result = await resolveCompanyQuickOrder(f.database, BUYER_CLAIMS, { lines: [line('SKU-1-1')] }, f.options)
      expect(JSON.stringify(result)).not.toMatch(/cost/i)
    } finally {
      f.sqlite.close()
    }
  })
})
