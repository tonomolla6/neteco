import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { returnsFixture, CLAIMS, BUYER_CLAIMS, CUSTOMER, utc } from './d1-returns-fixture'
import { readD1B2BCustomerTerms, upsertD1B2BCreditTerms } from '../../workers/catalog/b2b-credit'
import { upsertD1B2BPriceList, assignD1CompanyB2BPriceList } from '../../workers/catalog/b2b-pricing'
import { testUuid } from '../support/deterministic'

const companyId = '30000000-0000-4000-8000-000000000099'
async function world() {
  const f = await returnsFixture(),
    now = utc(),
    before = utc(-60000)
  f.sqlite.exec(await readFile('db/d1/migrations/0101_b2b_price_lists_credit.sql', 'utf8'))
  f.sqlite.exec(await readFile('db/d1/migrations/0105_b2b_credit_terms.sql', 'utf8'))
  f.sqlite
    .prepare(
      "INSERT INTO companies(id,customer_id,legal_name,status,created_at,updated_at) VALUES(?,?,'Empresa','approved',?,?)"
    )
    .run(companyId, CUSTOMER, before, before)
  return { ...f, now, options: { idempotencyKey: testUuid(), now: () => now } }
}
const input = {
  expectedVersion: 0,
  paymentDays: 30,
  creditLimitCents: 100,
  blocked: false,
  blockReason: null,
  reason: 'Contrato comercial'
}
describe('credit administration', () => {
  it('updates conditions and returns available credit to the owner', async () => {
    const f = await world()
    try {
      const result = await upsertD1B2BCreditTerms(f.database, CLAIMS, companyId, input, f.options)
      expect(result).toMatchObject({ companyId, version: 1 })
      expect(await readD1B2BCustomerTerms(f.database, BUYER_CLAIMS, { now: () => f.now })).toMatchObject({
        paymentDays: 30,
        creditLimitCents: 100,
        availableCents: 100
      })
    } finally {
      f.sqlite.close()
    }
  })
  it('replays the same command and rejects a different payload', async () => {
    const f = await world()
    try {
      const result = await upsertD1B2BCreditTerms(f.database, CLAIMS, companyId, input, f.options)
      expect(await upsertD1B2BCreditTerms(f.database, CLAIMS, companyId, input, f.options)).toEqual(result)
      await expect(
        upsertD1B2BCreditTerms(f.database, CLAIMS, companyId, { ...input, creditLimitCents: 101 }, f.options)
      ).rejects.toMatchObject({ code: 'conflict' })
    } finally {
      f.sqlite.close()
    }
  })
  it('rejects stale versions', async () => {
    const f = await world()
    try {
      await upsertD1B2BCreditTerms(f.database, CLAIMS, companyId, input, f.options)
      await expect(
        upsertD1B2BCreditTerms(f.database, CLAIMS, companyId, input, {
          ...f.options,
          idempotencyKey: testUuid()
        })
      ).rejects.toMatchObject({ code: 'conflict' })
    } finally {
      f.sqlite.close()
    }
  })
  it.each([
    { paymentDays: 45 },
    { creditLimitCents: -1 },
    { blocked: true, blockReason: null },
    { blocked: false, blockReason: 'Bad' },
    { expectedVersion: -1 }
  ])('rejects invalid inputs %o', async (patch) => {
    const f = await world()
    try {
      await expect(
        upsertD1B2BCreditTerms(f.database, CLAIMS, companyId, { ...input, ...patch }, f.options)
      ).rejects.toMatchObject({ code: 'invalid_input' })
    } finally {
      f.sqlite.close()
    }
  })
  it('denies an unprivileged customer and revoked session', async () => {
    const f = await world()
    try {
      await expect(upsertD1B2BCreditTerms(f.database, BUYER_CLAIMS, companyId, input, f.options)).rejects.toMatchObject(
        { code: 'mfa_required' }
      )
      f.sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(f.now, CLAIMS.sessionId)
      await expect(upsertD1B2BCreditTerms(f.database, CLAIMS, companyId, input, f.options)).rejects.toMatchObject({
        code: 'unauthenticated'
      })
    } finally {
      f.sqlite.close()
    }
  })
  it('reports no available credit for a blocked or suspended company', async () => {
    const f = await world()
    try {
      await upsertD1B2BCreditTerms(
        f.database,
        CLAIMS,
        companyId,
        { ...input, blocked: true, blockReason: 'Riesgo' },
        f.options
      )
      expect(await readD1B2BCustomerTerms(f.database, BUYER_CLAIMS, { now: () => f.now })).toMatchObject({
        availableCents: 0
      })
      f.sqlite.prepare("UPDATE companies SET status='suspended' WHERE id=?").run(companyId)
      expect(await readD1B2BCustomerTerms(f.database, BUYER_CLAIMS, { now: () => f.now })).toMatchObject({
        availableCents: 0
      })
    } finally {
      f.sqlite.close()
    }
  })
  it('shows public pricing after a company is suspended', async () => {
    const f = await world()
    try {
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
          variantRules: [],
          categoryRules: [],
          reason: 'Acuerdo comercial'
        },
        { ...f.options, idempotencyKey: testUuid() }
      )
      await assignD1CompanyB2BPriceList(
        f.database,
        CLAIMS,
        companyId,
        {
          priceListId: 'list',
          expectedVersion: 0,
          validFrom: utc(-60000),
          validUntil: null,
          reason: 'Acuerdo comercial'
        },
        { ...f.options, idempotencyKey: testUuid() }
      )
      expect(await readD1B2BCustomerTerms(f.database, BUYER_CLAIMS, { now: () => f.now })).toMatchObject({
        priceListName: 'Profesionales'
      })
      f.sqlite.prepare("UPDATE companies SET status='suspended' WHERE id=?").run(companyId)
      expect(await readD1B2BCustomerTerms(f.database, BUYER_CLAIMS, { now: () => f.now })).toMatchObject({
        priceListName: null
      })
    } finally {
      f.sqlite.close()
    }
  })
})
