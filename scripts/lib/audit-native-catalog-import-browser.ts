import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium, expect, type Response as BrowserResponse } from '@playwright/test'
import { z } from 'zod'
import { exportCatalogCsv, validateCatalogRecords, type CatalogTabularRecord } from '../../shared/catalog-tabular-core'
import {
  nativeImportInputSchema,
  nativeImportPreviewSchema,
  nativeImportReceiptSchema,
  type NativeImportReceipt
} from '../../shared/catalog-native-import'
import { catalogImportJobSchema, planCatalogImportJob } from '../../shared/catalog-import-job'
import { catalogImportJobReceiptSchema, type CatalogImportJobReceipt } from '../../shared/catalog-import-job-commands'
import {
  catalogImportJobReviewEntrySchema,
  type CatalogImportJobReviewEntry
} from '../../shared/catalog-import-job-review'
import { connectRemoteTestBrowser, REMOTE_BROWSER_NOT_RUN_REASON } from './remote-test-browser'

const reviewSchema = z
  .object({
    source: z.literal('cloudflare'),
    outcome: z.literal('review'),
    jobId: z.string().uuid(),
    jobHash: z.string().regex(/^[0-9a-f]{64}$/),
    offset: z.number().int().nonnegative(),
    nextOffset: z.number().int().positive().nullable(),
    totalEntries: z.number().int().positive(),
    entries: z.array(catalogImportJobReviewEntrySchema).min(1).max(25),
    policy: z
      .object({
        publication: z.literal('draft_only'),
        media: z.literal('pending_verification'),
        priceStock: z.literal('authorized_initialization')
      })
      .strict()
  })
  .strict()

/** DOM JSON cannot carry the null prototypes deliberately used by the own-JSON
 * boundary. Compare the exact wire values, not in-process object prototypes;
 * missing fields, nulls, scalar types and nested changes still differ. */
export function assertCatalogImportRenderedReview(
  rendered: { claimed: unknown; after: unknown },
  entry: CatalogImportJobReviewEntry
) {
  assert.deepEqual(rendered.claimed, JSON.parse(JSON.stringify(entry.claimed)))
  assert.deepEqual(rendered.after, JSON.parse(JSON.stringify(entry.after)))
}

/** Compiled Nuxt UI, remote Chromium, and real disposable Worker responses.
 * Fixtures are supplied by the auditor: this helper neither seeds references
 * nor grants permissions. Whole jobs and bounded previews are applied/reverted
 * only after explicit reason/confirmation;
 * a lost successful apply response tests real idempotent receipt recovery.
 * This requires the caller's migrated disposable database, never production. */
export async function auditNativeCatalogImportBrowser(input: {
  dispatch: (request: Request) => Promise<Response>
  origin: string
  adminCookie: string
  records: CatalogTabularRecord[]
  jobRecords: CatalogTabularRecord[]
  scenario: (name: string) => void
  browserMode?: 'required' | 'not-run'
}) {
  const origin = new URL(input.origin)
  assert(origin.protocol === 'https:' && origin.origin === input.origin && origin.hostname.endsWith('.test'))
  const cookie = /^neteco-session=([^;\r\n]+)$/.exec(input.adminCookie)
  assert(cookie, 'Browser journey requires the existing sealed synthetic session')
  assert(input.browserMode === undefined || ['required', 'not-run'].includes(input.browserMode))
  if (input.browserMode === 'not-run')
    return {
      scenarios: 0,
      browserStatus: 'not_run' as const,
      reason: REMOTE_BROWSER_NOT_RUN_REASON,
      engine: null,
      transport: null,
      requests: null,
      pageErrors: null,
      blockedExternal: null,
      uploadedPages: null,
      reviewPages: null,
      reviewEntries: null,
      screenshots: [],
      applies: 0,
      reverts: 0,
      jobCommands: null,
      syntheticSessionOnly: true,
      productionBrowserAcceptance: false
    }

  const nativeRecords = nativeImportInputSchema.parse({ records: input.records }).records
  const nativeValidation = validateCatalogRecords(nativeRecords)
  assert(nativeValidation.valid, 'Native browser fixture must be locally valid')
  assert.equal(input.jobRecords.length, 601, 'Whole-file journey must exceed the native 500-row bound')
  const jobValidation = validateCatalogRecords(input.jobRecords)
  assert(jobValidation.valid, 'Job browser fixture must be locally valid')
  const plan = planCatalogImportJob(input.jobRecords)
  const nativeCsv = exportCatalogCsv(nativeRecords),
    jobCsv = exportCatalogCsv(input.jobRecords)
  assert(nativeCsv.byteLength <= 20_000_000 && jobCsv.byteLength <= 20_000_000)
  assert(Buffer.byteLength(JSON.stringify({ records: nativeRecords })) <= 900_000)
  const browser = await connectRemoteTestBrowser(chromium)
  try {
    const context = await browser.newContext({
      locale: 'es-ES',
      timezoneId: 'Europe/Madrid',
      viewport: { width: 1440, height: 1000 }
    })
    let requests = 0,
      pageErrors = 0,
      blockedExternal = 0,
      forbiddenWrites = 0,
      reviewRequests = 0,
      dropApplyResponse = false,
      dropJobApplyResponse = false
    // Callback assignment does not participate in TypeScript control-flow
    // narrowing. A holder also makes an absent injected receipt explicit.
    const lostReceipts: { native?: NativeImportReceipt; job?: CatalogImportJobReceipt } = {}
    const writes: { path: string; method: string; body: string | null; key: string | undefined }[] = []
    try {
      await context.addCookies([
        { name: 'neteco-session', value: cookie[1]!, url: input.origin, httpOnly: true, secure: true, sameSite: 'Lax' }
      ])
      await context.route('**/*', async (route) => {
        const incoming = route.request(),
          target = new URL(incoming.url())
        if (target.origin !== input.origin) {
          blockedExternal++
          await route.abort('blockedbyclient')
          return
        }
        requests++
        const method = incoming.method(),
          headers = await incoming.allHeaders()
        if (method === 'GET' && /^\/api\/admin\/catalog\/import-jobs\/[^/]+\/review$/.test(target.pathname))
          reviewRequests++
        if (target.pathname.startsWith('/api/') && !['GET', 'HEAD'].includes(method)) {
          const allowed =
            (method === 'POST' &&
              (target.pathname === '/api/admin/catalog/native-import/preview' ||
                target.pathname === '/api/admin/catalog/import-jobs' ||
                /^\/api\/admin\/catalog\/import-jobs\/[0-9a-f-]+\/seal$/.test(target.pathname) ||
                /^\/api\/admin\/catalog\/import-jobs\/[0-9a-f-]+\/(apply|revert)$/.test(target.pathname) ||
                /^\/api\/admin\/catalog\/native-import\/previews\/[0-9a-f-]+\/(apply|revert)$/.test(
                  target.pathname
                ))) ||
            (method === 'PUT' &&
              /^\/api\/admin\/catalog\/import-jobs\/[0-9a-f-]+\/pages\/[0-9]+$/.test(target.pathname))
          if (!allowed) {
            forbiddenWrites++
            await route.abort('blockedbyclient')
            return
          }
          writes.push({ path: target.pathname, method, body: incoming.postData(), key: headers['idempotency-key'] })
        }
        headers['cf-connecting-ip'] = '192.0.2.53' // Synthetic harness ingress, not production edge provenance.
        headers['accept-encoding'] = 'identity'
        const bytes = incoming.postDataBuffer()
        const response = await input.dispatch(
          new Request(target, {
            method,
            headers,
            ...(bytes ? { body: new Uint8Array(bytes) } : {})
          })
        )
        if (
          dropJobApplyResponse &&
          target.pathname.startsWith('/api/admin/catalog/import-jobs/') &&
          target.pathname.endsWith('/apply')
        ) {
          assert(response.ok, 'Lost job response must follow a successful atomic Worker command')
          lostReceipts.job = catalogImportJobReceiptSchema.parse(await response.json())
          dropJobApplyResponse = false
          await route.abort('failed')
          return
        }
        if (dropApplyResponse && target.pathname.endsWith('/apply')) {
          assert(response.ok, 'Lost-response injection must follow a real successful Worker command')
          lostReceipts.native = nativeImportReceiptSchema.parse(await response.json())
          dropApplyResponse = false
          await route.abort('failed')
          return
        }
        const forwarded = Object.fromEntries(response.headers)
        delete forwarded['content-encoding']
        delete forwarded['content-length']
        await route.fulfill({
          status: response.status,
          headers: forwarded,
          body: Buffer.from(await response.arrayBuffer())
        })
      })
      const page = await context.newPage()
      page.on('pageerror', () => {
        pageErrors++
      })
      function responseFor(path: string, method: string) {
        return page.waitForResponse(
          (response) =>
            new URL(response.url()).origin === input.origin &&
            new URL(response.url()).pathname === path &&
            response.request().method() === method,
          { timeout: 30_000 }
        )
      }
      async function responseJson(response: BrowserResponse) {
        assert(response.ok(), 'Compiled UI request must succeed against the real Worker')
        return response.json() as Promise<unknown>
      }
      input.scenario('native_catalog_import_compiled_csv_local_preflight_explicit_server_preview')
      await page.goto(input.origin + '/admin/productos', { waitUntil: 'networkidle', timeout: 30_000 })
      const native = page.locator('section').filter({
        has: page.getByRole('heading', {
          name: 'Importación nativa completa',
          exact: true
        })
      })
      await expect(native.locator('[data-native-preview]')).toBeVisible({ timeout: 15_000 })
      const beforeNativeFile = writes.length
      await native
        .locator('input[type=file]')
        .setInputFiles({ name: 'native-preview.csv', mimeType: 'text/csv', buffer: Buffer.from(nativeCsv) })
      await expect(native.locator('[data-native-preview]')).toBeEnabled({ timeout: 15_000 })
      assert.equal(await native.locator('input[type=file]').inputValue(), '')
      assert.equal(writes.length, beforeNativeFile, 'File selection must not automatically send catalog data')
      const previewResponse = responseFor('/api/admin/catalog/native-import/preview', 'POST')
      await native.locator('[data-native-preview]').click()
      const preview = nativeImportPreviewSchema.parse(await responseJson(await previewResponse))
      assert.equal(preview.status, 'pending')
      assert.deepEqual(preview.counts, {
        products: nativeValidation.dataset.products.length,
        variants: nativeValidation.dataset.variants.length,
        assets: nativeValidation.dataset.assets.length,
        mappings: nativeValidation.dataset.media.length
      })
      await expect(native.locator('[data-native-summary]')).toContainText('Estado: pending')
      assert.deepEqual(JSON.parse(writes.at(-1)!.body!), { records: nativeRecords })
      input.scenario('native_catalog_import_compiled_601_row_explicit_sequential_staging')
      const jobSection = page.locator('section').filter({
        has: page.getByRole('heading', {
          name: 'Preparar catálogo completo por páginas',
          exact: true
        })
      })
      const beforeJobFile = writes.length
      await jobSection
        .locator('input[type=file]')
        .setInputFiles({ name: 'catalog-601.csv', mimeType: 'text/csv', buffer: Buffer.from(jobCsv) })
      await expect(jobSection.locator('[data-job-plan]')).toContainText(
        `601 registros · ${plan.pages.length} páginas`,
        { timeout: 15_000 }
      )
      await expect(jobSection.locator('[data-job-create]')).toBeEnabled()
      assert.equal(await jobSection.locator('input[type=file]').inputValue(), '')
      assert.equal(writes.length, beforeJobFile, 'Whole-file planning must remain local until explicit creation')
      const createResponse = responseFor('/api/admin/catalog/import-jobs', 'POST')
      await jobSection.locator('[data-job-create]').click()
      const created = catalogImportJobSchema.parse(await responseJson(await createResponse))
      assert.equal(created.status, 'uploading')
      assert.equal(created.recordCount, 601)
      assert.equal(created.totalPages, plan.pages.length)
      assert.equal(created.receivedPages, 0)
      assert(writes.at(-1)!.key, 'Explicit job creation requires an idempotency key')
      const base = '/api/admin/catalog/import-jobs/' + created.id
      const uploads: Promise<unknown>[] = plan.pages.map((part) =>
        responseFor(base + '/pages/' + part.index, 'PUT')
          .then(responseJson)
          .then((value) => {
            const staged = catalogImportJobSchema.parse(value)
            assert.equal(staged.id, created.id)
            assert.equal(staged.status, 'uploading')
            assert.equal(staged.hash, null)
            assert.equal(staged.receivedPages, part.index + 1)
            assert.equal(staged.recordCount, 601)
            return staged
          })
      )
      await jobSection.locator('[data-job-upload]').click()
      await Promise.all(uploads)
      await expect(jobSection.locator('[data-job-summary]')).toContainText(
        `Confirmadas en esta sesión: ${plan.pages.length} páginas.`
      )
      const pageWrites = writes.filter((write) => write.method === 'PUT')
      assert.equal(pageWrites.length, plan.pages.length)
      for (const [index, write] of pageWrites.entries()) {
        assert.equal(write.path, base + '/pages/' + index)
        assert.equal(write.body, JSON.stringify({ index, records: plan.pages[index]!.records }))
      }
      input.scenario('native_catalog_import_compiled_explicit_seal_and_complete_real_diff_pagination')
      const reason = 'Auditoría sintética del diff; sólo preparación, sin aplicar ni publicar'
      await jobSection.locator('[data-job-reason]').fill(reason)
      await jobSection.locator('[data-job-confirm]').check()
      await expect(jobSection.locator('[data-job-seal]')).toBeEnabled()
      const sealResponse = responseFor(base + '/seal', 'POST')
      await jobSection.locator('[data-job-seal]').click()
      const ready = catalogImportJobSchema.parse(await responseJson(await sealResponse))
      assert.equal(ready.id, created.id)
      assert.equal(ready.status, 'ready')
      assert.equal(ready.recordCount, 601)
      assert.equal(ready.receivedPages, ready.totalPages)
      assert.deepEqual(ready.counts, {
        products: jobValidation.dataset.products.length,
        variants: jobValidation.dataset.variants.length,
        assets: jobValidation.dataset.assets.length,
        mappings: jobValidation.dataset.media.length
      })
      assert.deepEqual(JSON.parse(writes.at(-1)!.body!), { reason })
      const review = jobSection.locator('section').filter({
        has: page.getByRole('heading', {
          name: 'Revisar el diff real del trabajo preparado',
          exact: true
        })
      })
      await expect(review.locator('[data-review-start]')).toBeVisible({ timeout: 15_000 })
      assert.equal(reviewRequests, 0, 'Sealing must not automatically fetch the private diff')
      const totalEntries = Object.values(ready.counts).reduce((sum, count) => sum + count, 0)
      const seen = new Set<string>()
      const counts = { products: 0, variants: 0, assets: 0, mappings: 0 }
      const expandedKinds = new Set<string>()
      let offset = 0,
        reviewPages = 0
      while (offset < totalEntries) {
        const currentOffset = offset
        const reviewResponse = page.waitForResponse(
          (response) => {
            const url = new URL(response.url())
            return (
              url.origin === input.origin &&
              url.pathname === base + '/review' &&
              url.search === `?offset=${currentOffset}&limit=25` &&
              response.request().method() === 'GET'
            )
          },
          { timeout: 30_000 }
        )
        await review.locator(offset === 0 ? '[data-review-start]' : '[data-review-next]').click()
        const result = reviewSchema.parse(await responseJson(await reviewResponse))
        assert.equal(result.jobId, ready.id)
        assert.equal(result.jobHash, ready.hash)
        assert.equal(result.totalEntries, totalEntries)
        assert.equal(result.offset, offset)
        assert.deepEqual(result.policy, ready.policy)
        const end = offset + result.entries.length
        assert.equal(result.nextOffset, end < totalEntries ? end : null)
        await expect(review.locator('[data-review-range]')).toHaveText(
          `Entradas ${offset + 1}–${end} de ${totalEntries}.`
        )
        const rows = review.locator('[data-review-entry]')
        await expect(rows).toHaveCount(result.entries.length)
        // One browser round trip per page, not thousands of remote DOM reads.
        const rendered = await rows.evaluateAll((elements) =>
          elements.map((element) => ({
            claimed: JSON.parse(element.querySelector('[data-review-claimed]')!.textContent!),
            after: JSON.parse(element.querySelector('[data-review-after]')!.textContent!)
          }))
        )
        for (const [index, entry] of result.entries.entries()) {
          const identity = entry.kind + ':' + entry.id
          assert(!seen.has(identity), 'Review pagination must not silently repeat an entry')
          seen.add(identity)
          counts[entry.kind === 'media' ? 'mappings' : entry.kind]++
          assert.equal(entry.before, null)
          assertCatalogImportRenderedReview(rendered[index]!, entry)
          if (!expandedKinds.has(entry.kind)) {
            const row = rows.nth(index)
            await row.locator('summary').click()
            await expect(row.locator('[data-review-claimed]')).toBeVisible()
            await expect(row.locator('[data-review-after]')).toBeVisible()
            await row.locator('summary').click()
            expandedKinds.add(entry.kind)
          }
        }
        offset = end
        reviewPages++
      }
      assert.deepEqual(counts, ready.counts)
      assert.equal(reviewRequests, reviewPages, 'Every diff page must follow one explicit user request')
      await expect(review.locator('[data-review-next]')).toBeDisabled()
      input.scenario('native_catalog_import_compiled_whole_601_apply_lost_response_exact_receipt_recovery')
      const commands = jobSection.locator('section').filter({
        has: page.getByRole('heading', { name: 'Aplicar o revertir el trabajo revisado', exact: true })
      })
      await expect(commands.locator('[data-command-apply]')).toBeDisabled()
      await commands.locator('[data-command-reason]').fill('Aplicación sintética de las 601 filas, sin publicación')
      await expect(commands.locator('[data-command-apply]')).toBeDisabled()
      await commands.locator('[data-command-confirm]').check()
      const beforeJobApply = writes.length
      dropJobApplyResponse = true
      await commands.locator('[data-command-apply]').click()
      await expect(commands).toContainText('Resultado no confirmado.', { timeout: 30_000 })
      await expect(commands.locator('[data-command-retry]')).toBeEnabled()
      assert.equal(writes.length, beforeJobApply + 1, 'Unknown whole-job response must not automatically retry')
      const originalJobApply = writes.at(-1)!
      assert(originalJobApply.key)
      const jobRecoveryResponse = responseFor(base, 'GET')
      await commands.locator('[data-command-refresh]').click()
      const recoveredJob = catalogImportJobSchema.parse(await responseJson(await jobRecoveryResponse))
      assert.equal(recoveredJob.status, 'applied')
      assert.equal(recoveredJob.hash, ready.hash)
      assert.deepEqual(recoveredJob.counts, ready.counts)
      assert.equal(writes.length, beforeJobApply + 1, 'Whole-job recovery must remain read-only')
      const jobReplayResponse = responseFor(base + '/apply', 'POST')
      await commands.locator('[data-command-retry]').click()
      const jobApplied = catalogImportJobReceiptSchema.parse(await responseJson(await jobReplayResponse))
      assert(lostReceipts.job, 'The injected whole-job response must have committed a receipt')
      assert.deepEqual(jobApplied, lostReceipts.job)
      assert.deepEqual(writes.at(-1), originalJobApply)
      assert.equal(jobApplied.jobId, ready.id)
      assert.equal(jobApplied.jobHash, ready.hash)
      assert.deepEqual(jobApplied.counts, ready.counts)
      await expect(commands.locator('[data-command-retry]')).toHaveCount(0)
      input.scenario('native_catalog_import_compiled_whole_601_exact_compensation_retains_audit')
      const appliedJobResponse = responseFor(base, 'GET')
      await commands.locator('[data-command-refresh]').click()
      assert.equal(catalogImportJobSchema.parse(await responseJson(await appliedJobResponse)).status, 'applied')
      await expect(commands.locator('[data-command-summary]')).toContainText('Estado confirmado: applied')
      await commands.locator('[data-command-reason]').fill('Compensación sintética exacta de todo el lote de 601 filas')
      await commands.locator('[data-command-confirm]').check()
      const jobRevertResponse = responseFor(base + '/revert', 'POST')
      await commands.locator('[data-command-revert]').click()
      const jobReverted = catalogImportJobReceiptSchema.parse(await responseJson(await jobRevertResponse))
      assert.equal(jobReverted.action, 'revert')
      assert.equal(jobReverted.jobId, ready.id)
      assert.equal(jobReverted.jobHash, ready.hash)
      assert.deepEqual(jobReverted.counts, ready.counts)
      assert.notEqual(writes.at(-1)!.key, originalJobApply.key)
      const revertedJobResponse = responseFor(base, 'GET')
      await commands.locator('[data-command-refresh]').click()
      assert.equal(catalogImportJobSchema.parse(await responseJson(await revertedJobResponse)).status, 'reverted')
      await expect(commands.locator('[data-command-summary]')).toContainText('Estado confirmado: reverted')
      await expect(jobSection).not.toContainText('Vista previa sellada y preparada. No se ha aplicado ningún producto')
      await expect(commands.locator('[data-command-apply]')).toBeDisabled()
      await expect(commands.locator('[data-command-revert]')).toBeDisabled()
      input.scenario('native_catalog_import_compiled_explicit_reason_confirmation_lost_response_receipt_recovery')
      const commandBase = '/api/admin/catalog/native-import/previews/' + preview.id
      await expect(native.locator('[data-native-apply]')).toBeDisabled()
      await native.locator('[data-native-reason]').fill('Auditoría sintética bounded native, sin publicación')
      await expect(native.locator('[data-native-apply]')).toBeDisabled()
      await native.locator('[data-native-confirm]').check()
      await expect(native.locator('[data-native-apply]')).toBeEnabled()
      const beforeApply = writes.length
      dropApplyResponse = true
      await native.locator('[data-native-apply]').click()
      await expect(native).toContainText('Resultado no confirmado.', { timeout: 30_000 })
      await expect(native.locator('[data-native-retry]')).toBeEnabled()
      await expect(native.locator('[data-native-reason]')).toBeDisabled()
      await expect(native.locator('[data-native-confirm]')).toBeDisabled()
      assert.equal(writes.length, beforeApply + 1, 'Unknown response must not trigger an automatic write retry')
      const originalApply = writes.at(-1)!
      assert(originalApply.key, 'Bounded native apply requires an idempotency key')
      const recoveredResponse = responseFor(commandBase, 'GET')
      await native.locator('[data-native-refresh]').click()
      const recovered = nativeImportPreviewSchema.parse(await responseJson(await recoveredResponse))
      assert.equal(recovered.id, preview.id)
      assert.equal(recovered.hash, preview.hash)
      assert.equal(recovered.status, 'applied')
      await expect(native.locator('[data-native-summary]')).toContainText('Estado: applied')
      assert.equal(writes.length, beforeApply + 1, 'State recovery is read-only and must not invent a receipt')
      const retryResponse = responseFor(commandBase + '/apply', 'POST')
      await native.locator('[data-native-retry]').click()
      const applied = nativeImportReceiptSchema.parse(await responseJson(await retryResponse))
      assert(lostReceipts.native, 'The injected native response must have committed a receipt')
      assert.deepEqual(applied, lostReceipts.native, 'Explicit retry must recover the original committed receipt')
      assert.deepEqual(writes.at(-1), originalApply, 'Retry must preserve the exact action/body/idempotency key')
      assert.equal(applied.action, 'apply')
      assert.equal(applied.previewId, preview.id)
      assert.equal(applied.previewHash, preview.hash)
      assert.deepEqual(applied.counts, preview.counts)
      await expect(native).toContainText('Recibo validado: lote aplicado como borradores, sin publicación.')
      input.scenario('native_catalog_import_compiled_explicit_compensating_revert_audit_retained')
      const appliedStateResponse = responseFor(commandBase, 'GET')
      await native.locator('[data-native-refresh]').click()
      assert.equal(nativeImportPreviewSchema.parse(await responseJson(await appliedStateResponse)).status, 'applied')
      await expect(native.locator('[data-native-summary]')).toContainText('Estado: applied')
      await expect(native.locator('[data-native-revert]')).toBeDisabled()
      await native.locator('[data-native-reason]').fill('Reversión sintética del lote sin cambios ni uso posterior')
      await native.locator('[data-native-confirm]').check()
      const revertResponse = responseFor(commandBase + '/revert', 'POST')
      await native.locator('[data-native-revert]').click()
      const reverted = nativeImportReceiptSchema.parse(await responseJson(await revertResponse))
      assert.equal(reverted.action, 'revert')
      assert.equal(reverted.previewId, preview.id)
      assert.equal(reverted.previewHash, preview.hash)
      assert.deepEqual(reverted.counts, preview.counts)
      assert.notEqual(writes.at(-1)!.key, originalApply.key, 'Revert must use its own explicit command intent')
      await expect(native).toContainText('Recibo validado: reversión compensatoria aplicada.')
      const directory = resolve('test-results/native-catalog-import-browser')
      await mkdir(directory, { recursive: true })
      await page.screenshot({ path: resolve(directory, 'desktop.png'), fullPage: true })
      await page.setViewportSize({ width: 390, height: 844 })
      const mobileSummary = jobSection.locator('[data-job-summary]')
      await expect(mobileSummary.locator('[data-job-hash]')).toHaveText(ready.hash!)
      assert.equal(
        await mobileSummary.evaluate((element) => element.scrollWidth > element.clientWidth + 1),
        false,
        'The mobile job summary must wrap its complete hash, not hide overflow behind the main panel clip'
      )
      assert.equal(
        await page.locator('html').evaluate((element) => element.scrollWidth > window.innerWidth + 1),
        false,
        'Compiled import/review mobile layout must not overflow'
      )
      await page.screenshot({ path: resolve(directory, 'mobile.png'), fullPage: true })
      assert.equal(pageErrors, 0, 'New compiled import/review UI must hydrate without browser exceptions')
      assert.equal(blockedExternal, 0, 'Synthetic compiled journey must not request external resources')
      assert.equal(forbiddenWrites, 0, 'Journey must never invent publication or provider writes')
      assert.equal(
        writes.length,
        9 + plan.pages.length,
        'Only explicit preparation and bounded command writes are allowed'
      )
      return {
        scenarios: 7,
        browserStatus: 'passed' as const,
        reason: null,
        engine: 'remote_playwright_chromium',
        transport: 'playwright_same_origin_forwarding_to_real_workerd',
        requests,
        pageErrors,
        blockedExternal,
        uploadedPages: plan.pages.length,
        reviewPages,
        reviewEntries: seen.size,
        screenshots: [
          'test-results/native-catalog-import-browser/desktop.png',
          'test-results/native-catalog-import-browser/mobile.png'
        ],
        applies: 1,
        reverts: 1,
        jobCommands: {
          jobId: ready.id,
          recordCount: 601,
          applies: 1,
          replays: 1,
          reverts: 1,
          finalStatus: 'reverted' as const
        },
        syntheticSessionOnly: true,
        productionBrowserAcceptance: false
      }
    } finally {
      await context.close()
    }
  } finally {
    await browser.close()
  }
}
