import { beforeEach, expect, it, vi } from 'vitest'
import {
  auditNativeCompanyReviewBrowser,
  createCompanyReviewBrowserBridge,
  readCompanyReviewDomainDigest
} from '../../scripts/lib/audit-native-company-review-browser'
import { companyFixture, CLAIMS, COMPANY, KEY, INPUT, OPTIONS } from './d1-admin-companies-fixture'
import { executeD1CompanyReview, readD1CompanyReviewCommand } from '../../workers/auth/admin-companies'
import { companyReviewCommandSchema } from '../../shared/company-review'
const connect = vi.hoisted(() => vi.fn())
vi.mock('../../scripts/lib/remote-test-browser', () => ({
  connectRemoteTestBrowser: connect,
  REMOTE_BROWSER_NOT_RUN_REASON: 'explicitly_not_run'
}))
const origin = 'https://shop-audit.neteco.test'
const receipt = {
  source: 'cloudflare' as const,
  companyId: COMPANY,
  commandId: KEY,
  changeId: KEY,
  status: 'approved' as const,
  createdAt: '2030-01-02T12:00:00Z'
}
function request() {
  return new Request(`${origin}/api/admin/companies/${COMPANY}`, {
    method: 'PUT',
    headers: { 'Idempotency-Key': KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(INPUT)
  })
}
function fixture() {
  const dispatch = vi.fn(async () => Response.json(receipt)),
    readCommitted = vi.fn(async () => undefined)
  return {
    dispatch,
    readCommitted,
    bridge: createCompanyReviewBrowserBridge({
      origin,
      companyId: COMPANY,
      expectedChangeId: null,
      dispatch,
      readCommitted
    })
  }
}
beforeEach(() => connect.mockReset())
it('NOTRUN touches no connection, preparation, dispatch, scenario or database', async () => {
  const dispatch = vi.fn(),
    prepareCompany = vi.fn(),
    scenario = vi.fn(),
    batch = vi.fn(),
    prepare = vi.fn()
  expect(
    await auditNativeCompanyReviewBrowser({
      origin,
      adminCookie: 'neteco-session=synthetic',
      dispatch,
      prepareCompany,
      scenario,
      database: { batch, prepare } as unknown as D1Database,
      browserMode: 'not-run'
    })
  ).toMatchObject({ scenarios: 0, browserStatus: 'not_run', productionBrowserAcceptance: false })
  for (const fn of [connect, dispatch, prepareCompany, scenario, batch, prepare]) expect(fn).not.toHaveBeenCalled()
})
it.each(['companyId', 'commandId', 'status'] as const)(
  'rejects wrong receipt %s before claiming loss',
  async (field) => {
    const f = fixture()
    f.dispatch.mockResolvedValue(
      Response.json({ ...receipt, [field]: field === 'status' ? 'rejected' : '11111111-1111-4111-8111-111111111111' })
    )
    await expect(f.bridge.forward(request())).rejects.toThrow()
    expect(f.bridge.proof.lostResponses).toBe(0)
    expect(f.readCommitted).not.toHaveBeenCalled()
  }
)
it('does not lose response before independent commit evidence', async () => {
  const f = fixture()
  f.readCommitted.mockRejectedValue(new Error('ledger missing'))
  await expect(f.bridge.forward(request())).rejects.toThrow('ledger missing')
  expect(f.bridge.proof.lostResponses).toBe(0)
})
it.each([201, 401, 409, 429, 503])('forwards HTTP%s without claiming commit or loss', async (status) => {
  const f = fixture()
  f.dispatch.mockResolvedValue(Response.json({ error: { code: 'unavailable' } }, { status }))
  expect((await f.bridge.forward(request())).action).toBe('fulfill')
  expect(f.bridge.proof.lostResponses).toBe(0)
  expect(f.readCommitted).not.toHaveBeenCalled()
})
it('loses confirmed200 once, forbids another PUT and validates manual command GET', async () => {
  const f = fixture()
  expect((await f.bridge.forward(request())).action).toBe('abort')
  expect(f.readCommitted).toHaveBeenCalledWith({ key: KEY, body: INPUT, receipt })
  await expect(f.bridge.forward(request())).rejects.toThrow()
  expect(f.dispatch).toHaveBeenCalledTimes(1)
  f.dispatch.mockResolvedValue(
    Response.json({ source: 'cloudflare', companyId: COMPANY, commandId: KEY, outcome: 'applied', receipt })
  )
  expect((await f.bridge.forward(new Request(`${origin}/api/admin/companies/${COMPANY}/commands/${KEY}`))).action).toBe(
    'fulfill'
  )
  expect(f.bridge.proof).toMatchObject({ puts: 1, lostResponses: 1, recoveredGets: 1 })
})
it.each(['external', 'extra-write', 'wrong-company', 'wrong-CAS'])('blocks %s before dispatch', async (mode) => {
  const f = fixture()
  const incoming =
    mode === 'external'
      ? new Request('https://external.invalid/')
      : mode === 'extra-write'
        ? new Request(origin + '/api/orders', { method: 'POST' })
        : new Request(`${origin}/api/admin/companies/${mode === 'wrong-company' ? KEY : COMPANY}`, {
            method: 'PUT',
            headers: { 'Idempotency-Key': KEY },
            body: JSON.stringify(mode === 'wrong-CAS' ? { ...INPUT, expectedStatus: 'approved' } : INPUT)
          })
  try {
    await f.bridge.forward(incoming)
  } catch {
    /* Invalid owned command is an assertion failure. */
  }
  expect(f.dispatch).not.toHaveBeenCalled()
})
it('bridge correlates actual D1 service command, CAS snapshot and command reader', async () => {
  const f = await companyFixture()
  try {
    let committedReads = 0
    // This minimal SQLite adapter lacks platform metadata. Derive writes from
    // SQLite itself rather than relaxing the native helper's rows_written guard.
    const digestDatabase = {
      ...f.database,
      batch: async (statements: D1PreparedStatement[]) => {
        const before = f.sqlite.prepare('SELECT total_changes() n').get()!.n as number
        const results = await f.database.batch(statements)
        const after = f.sqlite.prepare('SELECT total_changes() n').get()!.n as number
        return results.map((row) => ({ ...row, meta: { ...row.meta, rows_written: after - before } }))
      }
    } as D1Database
    const before = await readCompanyReviewDomainDigest(digestDatabase, COMPANY)
    const bridge = createCompanyReviewBrowserBridge({
      origin,
      companyId: COMPANY,
      expectedChangeId: null,
      dispatch: async (r) =>
        Response.json(await executeD1CompanyReview(f.database, CLAIMS, COMPANY, KEY, await r.json(), OPTIONS)),
      readCommitted: async (proof) => {
        committedReads++
        const stored = companyReviewCommandSchema.parse(
          await readD1CompanyReviewCommand(f.database, CLAIMS, COMPANY, KEY, OPTIONS)
        )
        expect(stored.receipt).toEqual(proof.receipt)
        expect(f.sqlite.prepare('SELECT status,last_change_id FROM companies WHERE id=?').get(COMPANY)).toEqual({
          status: 'approved',
          last_change_id: KEY
        })
        expect(f.sqlite.prepare('SELECT count(*) n FROM company_admin_review_commands').get()).toEqual({ n: 1 })
      }
    })
    expect((await bridge.forward(request())).action).toBe('abort')
    expect(bridge.proof.lostResponses).toBe(1)
    expect(committedReads).toBe(1)
    expect(await readCompanyReviewDomainDigest(digestDatabase, COMPANY)).toBe(before)
  } finally {
    f.sqlite.close()
  }
})
