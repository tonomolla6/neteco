import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chromium, expect } from '@playwright/test'
import {
  companyReviewInputSchema,
  companyReviewItemSchema,
  companyReviewListSchema,
  companyReviewReceiptSchema,
  companyReviewCommandSchema,
  type CompanyReviewInput,
  type CompanyReviewReceipt
} from '../../shared/company-review'
import { canonicalPayloadHash } from '../../workers/catalog/cart'
import { canonicalJson } from '../../workers/catalog/inventory'
import { connectRemoteTestBrowser, REMOTE_BROWSER_NOT_RUN_REASON } from './remote-test-browser'

function isolatedOrigin(origin: string) {
  assert.equal(origin, 'https://shop-audit.neteco.test', 'Disposable native origin required')
}
function sessionCookie(cookie: string) {
  const values = cookie
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith('neteco-session='))
  assert.equal(values.length, 1)
  const value = values[0]!.slice('neteco-session='.length)
  assert(value.length > 0 && value.length <= 16384 && !/[\s;\r\n]/.test(value))
  return value
}

export interface CompanyReviewBrowserProof {
  key: string
  body: CompanyReviewInput
  receipt: CompanyReviewReceipt
}
export function createCompanyReviewBrowserBridge(input: {
  origin: string
  companyId: string
  expectedChangeId: string | null
  dispatch: (request: Request) => Promise<Response>
  readCommitted: (proof: CompanyReviewBrowserProof) => Promise<void>
}) {
  isolatedOrigin(input.origin)
  companyReviewItemSchema.shape.id.parse(input.companyId)
  const proof = { puts: 0, lostResponses: 0, recoveredGets: 0, blockedExternal: 0, blockedWrites: 0 }
  let committed: CompanyReviewReceipt | null = null
  return {
    proof,
    async forward(request: Request) {
      const url = new URL(request.url)
      if (url.origin !== input.origin) {
        proof.blockedExternal++
        return { action: 'abort' as const, reason: 'external' }
      }
      const command =
        request.method === 'PUT' && url.pathname === `/api/admin/companies/${input.companyId}` && !url.search
      // Only privacy cleanup of this synthetic context is permitted besides the one review.
      const consentDeletion = request.method === 'DELETE' && url.pathname === '/api/analytics/session' && !url.search
      if (!['GET', 'HEAD'].includes(request.method) && !command && !consentDeletion) {
        proof.blockedWrites++
        return { action: 'abort' as const, reason: 'forbidden_write' }
      }
      let body: CompanyReviewInput | null = null
      const key = request.headers.get('idempotency-key')
      if (command) {
        assert.equal(proof.puts, 0, 'Recovery must use GET, never another PUT')
        companyReviewItemSchema.shape.id.parse(key)
        const text = await request.clone().text()
        assert(text.length <= 8192)
        body = companyReviewInputSchema.parse(JSON.parse(text))
        assert.equal(body.expectedStatus, 'pending')
        assert.equal(body.status, 'approved')
        assert.equal(body.expectedChangeId, input.expectedChangeId, 'Original CAS token required')
        proof.puts++
      }
      const response = await input.dispatch(request)
      if (command && response.status === 200) {
        const receipt = companyReviewReceiptSchema.parse(await response.clone().json())
        assert.equal(receipt.companyId, input.companyId)
        assert.equal(receipt.commandId, key)
        assert.equal(receipt.status, body!.status)
        await input.readCommitted({ key: key!, body: body!, receipt })
        committed = receipt
        proof.lostResponses++
        return { action: 'abort' as const, reason: 'lost_company_review_response' }
      }
      if (
        committed &&
        request.method === 'GET' &&
        url.pathname === `/api/admin/companies/${input.companyId}/commands/${committed.commandId}` &&
        !url.search
      ) {
        assert.equal(response.status, 200)
        const lookup = companyReviewCommandSchema.parse(await response.clone().json())
        assert.equal(lookup.companyId, input.companyId)
        assert.equal(lookup.commandId, committed.commandId)
        assert.equal(lookup.outcome, 'applied')
        assert.deepEqual(lookup.receipt, committed)
        proof.recoveredGets++
      }
      return { action: 'fulfill' as const, response }
    }
  }
}
export const COMPANY_REVIEW_BROWSER_SCENARIOS = [
  'native_company_review_compiled_exact_receipt_desktop',
  'native_company_review_compiled_exact_receipt_mobile'
] as const
export interface NativeCompanyReviewBrowserInput {
  origin: string
  adminCookie: string
  dispatch: (request: Request) => Promise<Response>
  database: D1Database
  prepareCompany: (viewport: 'desktop' | 'mobile') => Promise<{ companyId: string; legalName: string; taxId: string }>
  browserMode?: 'required' | 'not-run'
  scenario?: (id: string) => void
}
export async function auditNativeCompanyReviewBrowser(input: NativeCompanyReviewBrowserInput) {
  isolatedOrigin(input.origin)
  sessionCookie(input.adminCookie)
  assert(input.browserMode === undefined || ['required', 'not-run'].includes(input.browserMode))
  const base = {
    productionBrowserAcceptance: false,
    providerSubmission: false,
    syntheticSessionOnly: true,
    legacyNodeAcceptance: false,
    customerPrivacyAcceptance: false
  }
  if (input.browserMode === 'not-run')
    return {
      ...base,
      scenarios: 0,
      browserStatus: 'not_run' as const,
      reason: REMOTE_BROWSER_NOT_RUN_REASON,
      viewports: []
    }
  const browser = await connectRemoteTestBrowser(chromium)
  let requests = 0,
    pageErrors = 0,
    lostResponses = 0
  const viewports: string[] = [],
    domainDigests: Array<{ viewport: string; before: string; after: string }> = []
  try {
    for (const [index, viewport] of (
      [
        { name: 'desktop', width: 1440, height: 1000 },
        { name: 'mobile', width: 390, height: 844 }
      ] as const
    ).entries()) {
      const prepared = await input.prepareCompany(viewport.name)
      companyReviewItemSchema.shape.id.parse(prepared.companyId)
      companyReviewItemSchema.shape.legalName.parse(prepared.legalName)
      assert(typeof prepared.taxId === 'string' && prepared.taxId.length >= 3 && prepared.taxId.length <= 32)
      const read = async (path: string) => {
        requests++
        const response = await input.dispatch(
          new Request(input.origin + path, {
            headers: { cookie: input.adminCookie, 'cf-connecting-ip': '192.0.2.167' }
          })
        )
        assert.equal(response.status, 200)
        assert.match(response.headers.get('cache-control') ?? '', /private.*no-store/)
        assert.equal(response.headers.get('set-cookie'), null)
        return response.json() as Promise<unknown>
      }
      const listPath = `/api/admin/companies?q=${encodeURIComponent(prepared.taxId)}&page=1&perPage=20`
      const baseline = companyReviewListSchema.parse(await read(listPath))
      const target = baseline.items.find((item) => item.id === prepared.companyId)
      assert(target)
      assert.equal(target.legalName, prepared.legalName)
      assert.equal(target.taxId, prepared.taxId)
      assert.equal(target.status, 'pending')
      const beforeCompany = await input.database
        .prepare('SELECT * FROM companies WHERE id=?1')
        .bind(prepared.companyId)
        .first<Record<string, unknown>>()
      assert(beforeCompany)
      assert.equal(beforeCompany.last_change_id, target.currentChangeId)
      const count = async () =>
        (
          await input.database
            .prepare('SELECT count(*) n FROM company_admin_review_commands WHERE company_id=?1')
            .bind(prepared.companyId)
            .first<{ n: number }>()
        )?.n
      assert.equal(await count(), 0, 'A fresh company without prior administrative reviews is required')
      const before = await readCompanyReviewDomainDigest(input.database, prepared.companyId)
      let transportFailure: unknown = null,
        filteredReads = 0
      const bridge = createCompanyReviewBrowserBridge({
        origin: input.origin,
        companyId: prepared.companyId,
        expectedChangeId: target.currentChangeId,
        dispatch: input.dispatch,
        async readCommitted(proof) {
          const row = await input.database
            .prepare('SELECT * FROM company_admin_review_commands WHERE company_id=?1 AND command_id=?2')
            .bind(prepared.companyId, proof.key)
            .first<{
              actor_id: string
              payload_hash: string
              from_status: string
              to_status: string
              expected_change_id: string | null
              reason: string
              created_at: string
            }>()
          assert(row)
          assert.equal(row.from_status, 'pending')
          assert.equal(row.to_status, 'approved')
          assert.equal(row.expected_change_id, proof.body.expectedChangeId)
          assert.equal(row.reason, proof.body.reason)
          assert.equal(row.created_at, proof.receipt.createdAt)
          assert.equal(
            row.payload_hash,
            await canonicalPayloadHash({ companyId: prepared.companyId, actorId: row.actor_id, ...proof.body })
          )
          assert.equal(await count(), 1, 'Exactly one immutable command/audit and CAS review required')
          const lookup = companyReviewCommandSchema.parse(
            await read(`/api/admin/companies/${prepared.companyId}/commands/${proof.key}`)
          )
          assert.equal(lookup.companyId, prepared.companyId)
          assert.equal(lookup.commandId, proof.key)
          assert.equal(lookup.outcome, 'applied')
          assert.deepEqual(lookup.receipt, proof.receipt)
          const afterCompany = await input.database
            .prepare('SELECT * FROM companies WHERE id=?1')
            .bind(prepared.companyId)
            .first<Record<string, unknown>>()
          assert(afterCompany)
          assert.equal(afterCompany.status, 'approved')
          assert.equal(afterCompany.last_change_id, proof.key)
          assert.equal(afterCompany.updated_at, proof.receipt.createdAt)
          assert.deepEqual(
            {
              ...afterCompany,
              status: beforeCompany.status,
              last_change_id: beforeCompany.last_change_id,
              updated_at: beforeCompany.updated_at
            },
            beforeCompany,
            'Review must preserve all submitted billing/profile fields'
          )
          const current = companyReviewListSchema
            .parse(await read(listPath))
            .items.find((item) => item.id === prepared.companyId)
          assert(current)
          assert.equal(current.currentChangeId, proof.key)
          assert.equal(current.status, 'approved')
          assert.equal(current.reviewedAt, proof.receipt.createdAt)
        }
      })
      const context = await browser.newContext({
        locale: 'es-ES',
        timezoneId: 'Europe/Madrid',
        viewport: { width: viewport.width, height: viewport.height },
        serviceWorkers: 'block'
      })
      try {
        await context.addCookies([
          {
            name: 'neteco-session',
            value: sessionCookie(input.adminCookie),
            url: input.origin,
            httpOnly: true,
            secure: true,
            sameSite: 'Lax'
          }
        ])
        await context.route('**/*', async (route) => {
          try {
            const incoming = route.request(),
              headers = await incoming.allHeaders(),
              payload = incoming.postDataBuffer()
            headers['cf-connecting-ip'] = '192.0.2.167'
            headers['accept-encoding'] = 'identity'
            requests++
            const result = await bridge.forward(
              new Request(incoming.url(), {
                method: incoming.method(),
                headers,
                ...(payload ? { body: Uint8Array.from(payload).buffer } : {}),
                redirect: 'manual'
              })
            )
            if (result.action === 'abort') {
              await route.abort('failed')
              return
            }
            const target = new URL(incoming.url())
            if (
              incoming.method() === 'GET' &&
              target.pathname === '/api/admin/companies' &&
              target.searchParams.get('q') === prepared.taxId
            ) {
              assert.equal(result.response.status, 200)
              const searched = companyReviewListSchema.parse(await result.response.clone().json())
              assert(searched.items.some((item) => item.id === prepared.companyId && item.taxId === prepared.taxId))
              filteredReads++
            }
            const forwarded = Object.fromEntries(result.response.headers)
            delete forwarded['content-encoding']
            delete forwarded['content-length']
            await route.fulfill({
              status: result.response.status,
              headers: forwarded,
              body: Buffer.from(await result.response.arrayBuffer())
            })
          } catch (error) {
            transportFailure = error
            await route.abort('failed')
          }
        })
        const page = await context.newPage()
        page.on('pageerror', () => pageErrors++)
        await page.goto(input.origin + '/admin/clientes', { waitUntil: 'networkidle', timeout: 30000 })
        await expect(page.locator('[data-company-query]')).toBeVisible({ timeout: 15000 })
        await page.locator('[data-company-query]').fill(prepared.taxId)
        await page.locator('[data-company-filter]').getByRole('button', { name: 'Aplicar filtros' }).click()
        const card = page
          .locator('article')
          .filter({ has: page.getByRole('heading', { name: prepared.legalName, exact: true }) })
        await expect(card).toContainText(prepared.taxId, { timeout: 15000 })
        await card.locator('[data-company-review]').click()
        assert(filteredReads >= 1, 'The compiled filter must perform the actual literal NIF GET')
        await page.locator('[data-company-target-status]').selectOption('approved')
        await page.locator('[data-company-reason]').fill(`Revisión administrativa sintética ${viewport.name}`)
        await page
          .locator('[data-company-command]')
          .getByRole('button', { name: 'Confirmar revisión administrativa' })
          .click()
        await expect(page.locator('[data-company-unknown]')).toBeVisible({ timeout: 15000 })
        assert.equal(bridge.proof.puts, 1)
        assert.equal(bridge.proof.lostResponses, 1)
        await page.locator('[data-company-check]').click()
        await expect(page.locator('[data-company-confirmed]')).toContainText('Aprobada', { timeout: 15000 })
        await expect(page.locator('[data-company-unknown]')).toHaveCount(0)
        await expect(card).toContainText('Aprobada', { timeout: 15000 })
        assert.equal(bridge.proof.recoveredGets, 1)
        assert.equal(bridge.proof.puts, 1)
        assert.equal(await count(), 1)
        const width = await page.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth }))
        assert(width.width <= width.viewport + 1, 'Company review must not overflow viewport')
        const after = await readCompanyReviewDomainDigest(input.database, prepared.companyId)
        assert.equal(after, before, 'Company review must not change roles/profiles/credit/stock/payment contracts')
        if (transportFailure) throw transportFailure
        assert.equal(pageErrors, 0)
        assert.equal(bridge.proof.blockedExternal, 0)
        assert.equal(bridge.proof.blockedWrites, 0)
        domainDigests.push({ viewport: viewport.name, before, after })
        lostResponses += bridge.proof.lostResponses
        viewports.push(viewport.name)
        input.scenario?.(COMPANY_REVIEW_BROWSER_SCENARIOS[index]!)
      } finally {
        await context.close()
      }
    }
    return {
      ...base,
      scenarios: COMPANY_REVIEW_BROWSER_SCENARIOS.length,
      browserStatus: 'passed' as const,
      requests,
      pageErrors,
      lostResponses,
      viewports,
      domainDigests,
      economicEffects: false
    }
  } finally {
    await browser.close()
  }
}

/** Fixed, bounded disposable-domain snapshots. No schema scan or production DB. */
export async function readCompanyReviewDomainDigest(database: D1Database, companyId: string) {
  const queries = [
    'SELECT * FROM customers WHERE id=(SELECT customer_id FROM companies WHERE id=?1)',
    'SELECT * FROM identities WHERE customer_id=(SELECT customer_id FROM companies WHERE id=?1) ORDER BY id',
    'SELECT * FROM company_review_events WHERE company_id=?1 ORDER BY id',
    ...[
      'identity_roles',
      'role_permissions',
      'orders',
      'payment_intents',
      'payment_events',
      'inventory_balances',
      'inventory_movements',
      'fiscal_credit_contracts',
      'refund_contracts'
    ].map((table) => `SELECT * FROM ${table} ORDER BY rowid LIMIT 10001`)
  ]
  const rows = await database.batch(
    queries.map((sql, index) => (index < 3 ? database.prepare(sql).bind(companyId) : database.prepare(sql)))
  )
  assert.equal(rows.length, queries.length)
  for (const row of rows) {
    assert.equal(row.success, true)
    assert(Array.isArray(row.results) && row.results.length <= 10000)
    assert.equal(row.meta.rows_written, 0)
  }
  return createHash('sha256')
    .update(canonicalJson(rows.map((row) => row.results)))
    .digest('hex')
}
