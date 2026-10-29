import assert from 'node:assert/strict'
import { chromium } from '@playwright/test'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import {
  CATALOG_EXPORT_SHEET_NAMES,
  exportCatalogSnapshotCsv,
  verifyCatalogExportSnapshot
} from '../../shared/catalog-export'
import { parseCatalogCsvCells } from '../../shared/catalog-tabular-core'
import { exportCatalogCsv, exportCatalogXlsx } from '../../server/services/catalog-tabular'
import { catalogRecord } from '../../tests/support/catalog-tabular-fixture'
import { connectRemoteTestBrowser, REMOTE_BROWSER_NOT_RUN_REASON } from './remote-test-browser'

/** Actual read-only HTTP/D1 plus compiled browser XLSX; no provider, grant,
 * permission/approval fixture, cloud binding or catalogue mutation is added. */
export async function auditNativeCatalogExport(input: {
  dispatch: (request: Request) => Promise<Response>
  database: D1Database
  origin: string
  adminCookie: string
  unprivilegedCookie: string
  scenario: (name: string) => void
  browserMode?: 'required' | 'not-run'
}) {
  const { dispatch, database, origin, adminCookie, unprivilegedCookie, scenario } = input
  assert(input.browserMode === undefined || ['required', 'not-run'].includes(input.browserMode))
  assert.equal(origin, 'https://shop-audit.neteco.test')
  const endpoint = '/api/admin/catalog/export/snapshot'
  const before = (await database.prepare('SELECT * FROM products ORDER BY id').all()).results
  const protectedState = async () => {
    const tables = [
      'products',
      'variants',
      'variant_price_versions',
      'inventory_balances',
      'inventory_movements',
      'inventory_reservations',
      'product_media_publications',
      'catalog_editorial_previews',
      'catalog_editorial_commands',
      'catalog_editorial_audit',
      'orders',
      'payment_intents'
    ]
    const results = await database.batch(
      tables.map((table) => database.prepare('SELECT * FROM ' + table + ' ORDER BY rowid'))
    )
    return JSON.stringify(results.map((result) => result.results))
  }
  const unchanged = await protectedState()
  async function http(path = endpoint, options: { cookie?: string; method?: string; requestOrigin?: string } = {}) {
    const response = await dispatch(
      new Request(new URL(path, origin), {
        method: options.method ?? 'GET',
        headers: {
          Cookie: options.cookie ?? adminCookie,
          Origin: options.requestOrigin ?? origin,
          'Sec-Fetch-Site': 'same-origin',
          'CF-Connecting-IP': '192.0.2.154'
        }
      })
    )
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
    assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive')
    return response
  }
  scenario('native_catalog_export_full_consistent_all_states_original_ids')
  const full = await http()
  assert.equal(full.status, 200)
  const snapshot = await verifyCatalogExportSnapshot(await full.json())
  assert.equal(snapshot.counts.products, before.length)
  const originals = snapshot.sheets[0]!.rows.map((row) => JSON.parse(row.at(-1)!))
  assert.deepEqual(originals, before)
  assert(snapshot.counts.variants > 0 && snapshot.counts.inventory > 0 && snapshot.counts.media > 0)
  const first = originals[0]!
  scenario('native_catalog_export_filters_preserve_original_records_not_visible_page')
  assert(typeof first.name === 'string')
  const filteredResponse = await http(endpoint + '?q=' + encodeURIComponent(first.name))
  assert.equal(filteredResponse.status, 200)
  const filtered = await verifyCatalogExportSnapshot(await filteredResponse.json())
  assert(filtered.sheets[0]!.rows.some((row) => JSON.parse(row.at(-1)!).id === first.id))
  const missing = await http(endpoint + '?q=definitely-no-catalog-product-export-154')
  assert.equal(missing.status, 200)
  assert.equal((await verifyCatalogExportSnapshot(await missing.json())).counts.products, 0)
  scenario('native_catalog_export_complete_csv_verified_hash_original_types')
  const cells = parseCatalogCsvCells(new TextDecoder().decode(await exportCatalogSnapshotCsv(snapshot)))
  assert.equal(cells.length, 2 + Object.values(snapshot.counts).reduce((sum, n) => sum + n, 0))
  assert.deepEqual(JSON.parse(cells[1]![2]!).counts, snapshot.counts)
  assert.deepEqual(
    cells.filter((row) => row[0] === 'Products').map((row) => JSON.parse(row[2]!)),
    before
  )
  scenario('native_catalog_export_permission_mfa_cookie_origin_and_alias_fail_closed')
  const denied = await http(endpoint, { cookie: unprivilegedCookie })
  assert.equal(denied.status, 403)
  assert.deepEqual(await denied.json(), { error: { code: 'mfa_required' } })
  const anonymous = await http(endpoint, { cookie: '' })
  assert.equal(anonymous.status, 401)
  assert.equal((await http(endpoint, { requestOrigin: 'https://outside.neteco.test' })).status, 403)
  assert.equal((await http('/api/admin/catalog/%65xport/snapshot')).status, 400)
  scenario('native_catalog_export_rejects_clock_pagination_duplicate_filter_and_write')
  for (const query of ['?instant=2026-10-03T00:00:00Z', '?page=1', '?q=a&q=b', '?category=07'])
    assert.equal((await http(endpoint + query)).status, 400)
  assert.equal((await http(endpoint, { method: 'POST' })).status, 405)
  const cookie = /^neteco-session=([^;\r\n]+)$/.exec(adminCookie)
  assert(cookie)
  if (input.browserMode === 'not-run') {
    scenario('native_catalog_export_zero_catalog_financial_inventory_audit_writes')
    assert.equal(await protectedState(), unchanged)
    return {
      scenarios: 6,
      profile: 'native_catalog_snapshot_v1',
      browser: {
        status: 'not_run' as const,
        reason: REMOTE_BROWSER_NOT_RUN_REASON,
        engine: null,
        csv: null,
        xlsx: null,
        localFileInspectionCsv: null,
        localFileInspectionXlsx: null,
        requests: null,
        pageErrors: null,
        blockedExternal: null
      },
      productionAcceptance: false
    }
  }
  const browser = await connectRemoteTestBrowser(chromium)
  let requests = 0,
    apiRequests = 0,
    pageErrors = 0,
    blockedExternal = 0
  try {
    const context = await browser.newContext({
      locale: 'es-ES',
      timezoneId: 'UTC',
      viewport: { width: 1440, height: 1000 },
      acceptDownloads: true
    })
    try {
      await context.addCookies([
        { name: 'neteco-session', value: cookie[1]!, url: origin, httpOnly: true, secure: true, sameSite: 'Lax' }
      ])
      await context.route('**/*', async (route) => {
        const incoming = route.request(),
          target = new URL(incoming.url())
        if (target.origin !== origin) {
          blockedExternal++
          await route.abort('blockedbyclient')
          return
        }
        requests++
        if (target.pathname.startsWith('/api/')) apiRequests++
        const headers = await incoming.allHeaders()
        headers['cf-connecting-ip'] = '192.0.2.155'
        headers['accept-encoding'] = 'identity'
        const body = incoming.postDataBuffer(),
          response = await dispatch(
            new Request(target, { method: incoming.method(), headers, ...(body ? { body: new Uint8Array(body) } : {}) })
          )
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
      scenario('native_catalog_export_browser_compiled_csv_download_desktop')
      await page.goto(origin + '/admin/productos', { waitUntil: 'networkidle', timeout: 30000 })
      await page
        .getByRole('heading', { name: 'Exportar snapshot del catálogo', exact: true })
        .waitFor({ timeout: 15000 })
      const button = page.locator('[data-snapshot-export-download]')
      await button.waitFor({ timeout: 15000 })
      async function download(format: 'csv' | 'xlsx') {
        await page.locator('[data-snapshot-export-format]').selectOption(format)
        const response = page.waitForResponse(
          (response) => new URL(response.url()).pathname === endpoint && response.status() === 200
        )
        const downloading = page.waitForEvent('download', { timeout: 30000 })
        await button.click()
        const [download, read] = await Promise.all([downloading, response])
        assert.equal(download.suggestedFilename(), 'neteco-catalogo-snapshot-v1.' + format)
        assert.equal(await download.failure(), null)
        const stream = await download.createReadStream()
        assert(stream)
        const chunks: Buffer[] = []
        for await (const chunk of stream) chunks.push(Buffer.from(chunk))
        const bytes = Buffer.concat(chunks)
        assert(bytes.length > 0 && bytes.length <= 8000000)
        return { bytes, snapshot: await verifyCatalogExportSnapshot(await read.json()) }
      }
      const csv = await download('csv')
      assert.equal(
        parseCatalogCsvCells(csv.bytes.toString('utf8')).length,
        2 + Object.values(csv.snapshot.counts).reduce((sum, n) => sum + n, 0)
      )
      assert.equal(await page.locator('html').evaluate((element) => element.scrollWidth > window.innerWidth + 1), false)
      scenario('native_catalog_export_browser_actual_exceljs_client_download_mobile')
      await page.setViewportSize({ width: 390, height: 844 })
      const xlsx = await download('xlsx'),
        workbook = new ExcelJS.Workbook()
      await workbook.xlsx.load(Uint8Array.from(xlsx.bytes).buffer)
      assert.deepEqual(
        workbook.worksheets.map((sheet) => sheet.name),
        [...CATALOG_EXPORT_SHEET_NAMES, 'Manifest']
      )
      for (const sheet of xlsx.snapshot.sheets) {
        const actual = workbook.getWorksheet(sheet.name)
        assert(actual)
        assert.equal(actual.rowCount, sheet.rows.length + 1)
        assert.deepEqual((actual.getRow(1).values as string[]).slice(1), sheet.columns)
        for (let index = 0; index < sheet.rows.length; index++)
          assert.deepEqual((actual.getRow(index + 2).values as string[]).slice(1), sheet.rows[index])
      }
      const manifest = workbook.getWorksheet('Manifest')
      assert(manifest)
      assert.equal(manifest.getCell('B8').value, xlsx.snapshot.hash)
      const zip = await JSZip.loadAsync(xlsx.bytes)
      for (const [name, file] of Object.entries(zip.files))
        if (/^xl\/worksheets\/sheet\d+\.xml$/.test(name)) assert(!/<f(?:\s|>)/.test(await file.async('string')))
      assert.equal(await page.locator('html').evaluate((element) => element.scrollWidth > window.innerWidth + 1), false)
      scenario('native_catalog_import_file_compiled_csv_real_file_input_local_only')
      const apiBeforeFile = apiRequests
      const fileInput = page.locator('#catalog-file-preflight')
      await fileInput.waitFor({ timeout: 15000 })
      await fileInput.setInputFiles({
        name: 'catalogo-local.csv',
        mimeType: 'text/csv',
        buffer: Buffer.from(exportCatalogCsv([catalogRecord()]))
      })
      await page
        .locator('[data-catalog-file-format="csv"]')
        .getByText('Estructura local válida', { exact: true })
        .waitFor({ timeout: 15000 })
      assert.equal(await fileInput.inputValue(), '')
      assert.equal(apiRequests, apiBeforeFile)
      scenario('native_catalog_import_file_compiled_xlsx_real_codec_local_only')
      await fileInput.setInputFiles({
        name: 'catalogo-local.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        buffer: Buffer.from(await exportCatalogXlsx([catalogRecord()]))
      })
      await page
        .locator('[data-catalog-file-format="xlsx"]')
        .getByText('Estructura local válida', { exact: true })
        .waitFor({ timeout: 15000 })
      assert.equal(await fileInput.inputValue(), '')
      assert.equal(apiRequests, apiBeforeFile)
      assert.equal(await page.locator('html').evaluate((element) => element.scrollWidth > window.innerWidth + 1), false)
      assert.equal(pageErrors, 0)
      assert.equal(blockedExternal, 0)
    } finally {
      await context.close()
    }
  } finally {
    await browser.close()
  }
  scenario('native_catalog_export_zero_catalog_financial_inventory_audit_writes')
  assert.equal(await protectedState(), unchanged)
  return {
    scenarios: 10,
    profile: 'native_catalog_snapshot_v1',
    browser: {
      status: 'passed' as const,
      reason: null,
      engine: 'remote_playwright_chromium',
      csv: true,
      xlsx: true,
      localFileInspectionCsv: true,
      localFileInspectionXlsx: true,
      requests,
      pageErrors,
      blockedExternal
    },
    productionAcceptance: false
  }
}
