import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  listD1AdminCompanies,
  executeD1CompanyReview,
  readD1CompanyReviewCommand
} from '../../workers/auth/admin-companies'
import { companyFixture, CLAIMS, COMPANY, KEY, INPUT, OPTIONS, NOW, ACTOR, SESSION } from './d1-admin-companies-fixture'
import { deterministicUuid } from '../fixtures/deterministic'
let f: Awaited<ReturnType<typeof companyFixture>>
beforeEach(async () => {
  f = await companyFixture()
})
afterEach(() => f.sqlite.close())
it('lists actual companies by literal fiscal/name filters with bounded pagination and no writes', async () => {
  const before = f.sqlite.prepare('SELECT total_changes() n').get()
  expect(await listD1AdminCompanies(f.database, CLAIMS, { q: 'acido', perPage: 1 }, OPTIONS)).toMatchObject({
    source: 'cloudflare',
    total: 1,
    page: 1,
    perPage: 1,
    items: [{ id: COMPANY, status: 'pending', currentChangeId: null, reviewedAt: null }]
  })
  expect(await listD1AdminCompanies(f.database, CLAIMS, { q: '%_\\' }, OPTIONS)).toMatchObject({ total: 1 })
  expect(await listD1AdminCompanies(f.database, CLAIMS, { q: 'B12345674' }, OPTIONS)).toMatchObject({ total: 1 })
  expect(await listD1AdminCompanies(f.database, CLAIMS, { status: 'approved' }, OPTIONS)).toMatchObject({
    total: 0,
    items: []
  })
  expect(await listD1AdminCompanies(f.database, CLAIMS, { page: 2, perPage: 1 }, OPTIONS)).toMatchObject({
    total: 1,
    items: []
  })
  expect(f.sqlite.prepare('SELECT total_changes() n').get()).toEqual(before)
})
it('reviews with an immutable audited durable receipt, exact replay and current CAS token', async () => {
  const receipt = await executeD1CompanyReview(f.database, CLAIMS, COMPANY, KEY, INPUT, OPTIONS)
  expect(receipt).toMatchObject({ companyId: COMPANY, commandId: KEY, status: 'approved', changeId: KEY })
  expect(await executeD1CompanyReview(f.database, CLAIMS, COMPANY, KEY, INPUT, OPTIONS)).toEqual(receipt)
  expect(await readD1CompanyReviewCommand(f.database, CLAIMS, COMPANY, KEY, OPTIONS)).toMatchObject({
    outcome: 'applied',
    receipt
  })
  expect(await listD1AdminCompanies(f.database, CLAIMS, {}, OPTIONS)).toMatchObject({
    items: [{ status: 'approved', currentChangeId: KEY }]
  })
})
it.each([
  ['pending', 'approved'],
  ['pending', 'rejected'],
  ['approved', 'suspended'],
  ['rejected', 'pending'],
  ['suspended', 'pending'],
  ['suspended', 'approved'],
  ['approved', 'approved']
] as const)('preserves existing transition %s to %s', async (from, to) => {
  f.sqlite.prepare('UPDATE companies SET status=? WHERE id=?').run(from, COMPANY)
  await expect(
    executeD1CompanyReview(f.database, CLAIMS, COMPANY, KEY, { ...INPUT, expectedStatus: from, status: to }, OPTIONS)
  ).resolves.toMatchObject({ status: to })
  expect(f.sqlite.prepare('SELECT count(*) n FROM company_admin_review_commands').get()).toEqual({ n: 1 })
  expect(() => f.sqlite.prepare('UPDATE company_admin_review_commands SET reason=?').run('tampered')).toThrow(
    /immutable/
  )
  expect(() => f.sqlite.prepare('DELETE FROM company_admin_review_commands').run()).toThrow(/immutable/)
})
it('retains private rejection reason only for the current reviewed version', async () => {
  await executeD1CompanyReview(f.database, CLAIMS, COMPANY, KEY, { ...INPUT, status: 'rejected' }, OPTIONS)
  expect(await listD1AdminCompanies(f.database, CLAIMS, {}, OPTIONS)).toMatchObject({
    items: [{ rejectionReason: INPUT.reason, reviewedAt: NOW }]
  })
  f.sqlite
    .prepare('UPDATE companies SET last_change_id=?,status=? WHERE id=?')
    .run(deterministicUuid('resubmission'), 'pending', COMPANY)
  expect(await listD1AdminCompanies(f.database, CLAIMS, {}, OPTIONS)).toMatchObject({
    items: [{ rejectionReason: null, reviewedAt: null }]
  })
})
it('does not interpret an unknown receipt as absence or mutate reads', async () => {
  const before = f.sqlite.prepare('SELECT total_changes() n').get()
  expect(await readD1CompanyReviewCommand(f.database, CLAIMS, COMPANY, KEY, OPTIONS)).toMatchObject({
    outcome: 'unknown',
    receipt: null
  })
  expect(f.sqlite.prepare('SELECT total_changes() n').get()).toEqual(before)
})
it.each([{}, { ...INPUT, extra: true }, { ...INPUT, reason: 'x' }, { ...INPUT, expectedChangeId: 'bad' }])(
  'rejects malformed command %j',
  async (input) => {
    await expect(executeD1CompanyReview(f.database, CLAIMS, COMPANY, KEY, input, OPTIONS)).rejects.toMatchObject({
      code: 'invalid_input'
    })
  }
)
it.each([{ q: 'x'.repeat(101) }, { page: 0 }, { perPage: 51 }, { status: 'other' }, { extra: true }])(
  'rejects malformed listing %j',
  async (query) => {
    await expect(listD1AdminCompanies(f.database, CLAIMS, query, OPTIONS)).rejects.toMatchObject({
      code: 'invalid_input'
    })
  }
)
it('rejects stale CAS, payload/key changes and invalid transitions without effects', async () => {
  await executeD1CompanyReview(f.database, CLAIMS, COMPANY, KEY, INPUT, OPTIONS)
  await expect(
    executeD1CompanyReview(f.database, CLAIMS, COMPANY, KEY, { ...INPUT, reason: 'Different exact intent' }, OPTIONS)
  ).rejects.toMatchObject({ code: 'conflict' })
  await expect(
    executeD1CompanyReview(f.database, CLAIMS, COMPANY, deterministicUuid('other-review'), INPUT, OPTIONS)
  ).rejects.toMatchObject({ code: 'conflict' })
  await expect(
    executeD1CompanyReview(
      f.database,
      CLAIMS,
      COMPANY,
      deterministicUuid('invalid-transition'),
      { ...INPUT, expectedChangeId: KEY, expectedStatus: 'approved', status: 'rejected' },
      OPTIONS
    )
  ).rejects.toMatchObject({ code: 'conflict' })
  expect(f.sqlite.prepare('SELECT count(*) n FROM company_admin_review_commands').get()).toEqual({ n: 1 })
})
it.each([null, 'INVALID', '---', 'A58818502'])('cannot approve missing or malformed fiscal ID %j', async (taxId) => {
  f.sqlite.prepare('UPDATE companies SET tax_id=? WHERE id=?').run(taxId, COMPANY)
  await expect(executeD1CompanyReview(f.database, CLAIMS, COMPANY, KEY, INPUT, OPTIONS)).rejects.toMatchObject({
    code: 'invalid_tax_id'
  })
})
it.each([
  ['UPDATE auth_sessions SET revoked_at=? WHERE id=?', NOW, SESSION, 'unauthenticated'],
  ['UPDATE identities SET email_verified_at=NULL WHERE id=?', ACTOR, null, 'email_unverified'],
  ['UPDATE auth_sessions SET mfa_verified=0 WHERE id=?', SESSION, null, 'mfa_required'],
  ['DELETE FROM identity_roles WHERE identity_id=?', ACTOR, null, 'forbidden']
])('rechecks live authority and returns no listing after %s', async (sql, a, b, code) => {
  const prepare = f.database.prepare.bind(f.database)
  let dataRead = false
  f.database.prepare = (sqlText: string) => {
    const st = prepare(sqlText)
    if (sqlText.includes('company_page')) {
      const first = st.first.bind(st)
      st.first = async (...args: Parameters<typeof first>) => {
        const value = await first(...args)
        if (!dataRead) {
          dataRead = true
          const s = f.sqlite.prepare(String(sql))
          if (b === null) s.run(a!)
          else s.run(a!, b!)
        }
        return value
      }
    }
    return st
  }
  await expect(listD1AdminCompanies(f.database, CLAIMS, {}, OPTIONS)).rejects.toMatchObject({ code })
})
it.each(['submission', 'revocation', 'rollback'])('atomic review refuses %s during the batch window', async (kind) => {
  const batch = f.database.batch.bind(f.database)
  if (kind === 'rollback')
    f.sqlite.exec(
      "CREATE TRIGGER company_test_abort BEFORE UPDATE ON companies BEGIN SELECT RAISE(ABORT,'injected_failure'); END"
    )
  f.database.batch = async (statements) => {
    if (kind === 'submission')
      f.sqlite
        .prepare('UPDATE companies SET last_change_id=? WHERE id=?')
        .run(deterministicUuid('raced-submit'), COMPANY)
    if (kind === 'revocation') f.sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(NOW, SESSION)
    return batch(statements)
  }
  await expect(executeD1CompanyReview(f.database, CLAIMS, COMPANY, KEY, INPUT, OPTIONS)).rejects.toMatchObject({
    code: kind === 'submission' ? 'conflict' : kind === 'revocation' ? 'unauthenticated' : 'unavailable'
  })
  expect(f.sqlite.prepare('SELECT status FROM companies WHERE id=?').get(COMPANY)).toEqual({ status: 'pending' })
  expect(f.sqlite.prepare('SELECT count(*) n FROM company_admin_review_commands').get()).toEqual({ n: 0 })
})
it('recovers after commit followed by transport failure without another review', async () => {
  const batch = f.database.batch.bind(f.database)
  f.database.batch = async (statements) => {
    await batch(statements)
    throw new Error('lost response')
  }
  await expect(executeD1CompanyReview(f.database, CLAIMS, COMPANY, KEY, INPUT, OPTIONS)).resolves.toMatchObject({
    commandId: KEY,
    status: 'approved'
  })
  expect(await readD1CompanyReviewCommand(f.database, CLAIMS, COMPANY, KEY, OPTIONS)).toMatchObject({
    outcome: 'applied'
  })
  expect(f.sqlite.prepare('SELECT count(*) n FROM company_admin_review_commands').get()).toEqual({ n: 1 })
})
