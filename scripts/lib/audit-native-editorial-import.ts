import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { EDITORIAL_CSV_COLUMNS, exportEditorialCsv, type EditorialCsvRow } from '../../shared/catalog-editorial-csv'
import { parseCatalogCsvCells } from '../../shared/catalog-tabular-core'
import {
  editorialInvalidSchema,
  editorialPreviewSchema,
  editorialReceiptSchema
} from '../../shared/catalog-editorial-import'

export interface NativeEditorialImportAuditInput {
  /** The existing disposable workerd dispatcher, never an external fetch. */
  dispatch: (request: Request) => Promise<Response>
  database: D1Database
  origin: string
  adminCookie: string
  unprivilegedCookie: string
  scenario: (name: string) => void
}

/** Six actual HTTP/D1 scenarios. Only two dedicated synthetic drafts are seeded;
 * no identities, grants, variants, approvals, providers or prices are created. */
export async function auditNativeEditorialImport(
  input: NativeEditorialImportAuditInput
): Promise<{ scenarios: number }> {
  const { dispatch, database, origin, adminCookie, unprivilegedCookie, scenario } = input
  assert.equal(origin, 'https://shop-audit.neteco.test')
  assert(adminCookie && unprivilegedCookie && adminCookie !== unprivilegedCookie)
  const root = '/api/admin/catalog/editorial-import'
  const ids = ['00530000-0000-4000-8000-000900005301', '00530000-0000-4000-8000-000900005302']
  const legacyIds = [900005301, 900005302]
  const category = await database
    .prepare('SELECT id FROM categories WHERE legacy_id>0 ORDER BY legacy_id LIMIT 1')
    .first<{ id: string }>()
  assert(category)
  const exists = await database
    .prepare('SELECT count(*) AS n FROM products WHERE id IN (?1,?2) OR legacy_id IN (?3,?4)')
    .bind(...ids, ...legacyIds)
    .first<{ n: number }>()
  assert.equal(exists?.n, 0, 'Editorial audit requires fresh dedicated fixture slots')
  for (let index = 0; index < ids.length; index++) {
    const inserted: D1Result = await database
      .prepare(
        `INSERT INTO products
      (id,legacy_id,category_id,name,slug,status,short_description,description,usage,series)
      VALUES (?1,?2,?3,?4,?5,'draft',?6,?6,?6,?6)`
      )
      .bind(
        ids[index]!,
        legacyIds[index]!,
        category.id,
        'Borrador sintético ' + index,
        'native-editorial-' + legacyIds[index],
        index === 0 ? null : ''
      )
      .run()
    assert.equal(inserted.success, true)
  }
  const protectedState = () =>
    database
      .prepare(
        `SELECT
    (SELECT count(*) FROM variants) AS variants,
    (SELECT count(*) FROM variant_price_versions) AS prices,
    (SELECT COALESCE(sum(gross_cents),0) FROM variant_price_versions) AS price_cents,
    (SELECT count(*) FROM inventory_movements) AS movements,
    (SELECT COALESCE(sum(physical_delta),0) FROM inventory_movements) AS physical,
    (SELECT COALESCE(sum(reserved_delta),0) FROM inventory_movements) AS reserved,
    (SELECT count(*) FROM media_uploads) AS media,
    (SELECT count(*) FROM orders) AS orders,
    (SELECT count(*) FROM payment_intents) AS payments,
    (SELECT count(*) FROM refund_work) AS refunds,
    (SELECT count(*) FROM fiscal_invoice_intents) AS invoices,
    (SELECT count(*) FROM fiscal_credit_work) AS credits`
      )
      .first()
  const products = async () =>
    (
      await database
        .prepare('SELECT * FROM products WHERE id IN (?1,?2) ORDER BY legacy_id')
        .bind(...ids)
        .all<Record<string, unknown>>()
    ).results
  const ledger = () =>
    database
      .prepare(
        `SELECT
    (SELECT count(*) FROM catalog_editorial_previews) AS previews,
    (SELECT count(*) FROM catalog_editorial_commands) AS commands,
    (SELECT count(*) FROM catalog_editorial_audit) AS audits,
    (SELECT count(*) FROM catalog_editorial_guards) AS guards`
      )
      .first<{ previews: number; commands: number; audits: number; guards: number }>()
  async function http(
    path: string,
    method = 'GET',
    body?: unknown,
    key?: string,
    cookie = adminCookie,
    requestOrigin = origin
  ) {
    assert(path.startsWith('/api/admin/'))
    const target = new URL(path, origin)
    assert.equal(target.origin, origin)
    const response = await dispatch(
      new Request(target, {
        method,
        redirect: 'manual',
        headers: {
          Origin: requestOrigin,
          Cookie: cookie,
          'Sec-Fetch-Site': 'same-origin',
          'CF-Connecting-IP': '192.0.2.153',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(key === undefined ? {} : { 'Idempotency-Key': key })
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      })
    )
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
    assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive')
    return response
  }
  async function denied(response: Response, status: number, code: string) {
    assert.equal(response.status, status)
    assert.deepEqual(await response.json(), { error: { code } })
  }
  function rows(version: number): EditorialCsvRow[] {
    return ids.map((productId, index) => ({
      productId,
      legacyId: legacyIds[index]!,
      expectedVersion: version,
      metadata: {
        name: 'Editorial sintético ' + index,
        shortDesc: 'Descripción breve revisada',
        description: 'Descripción, sintética\ncon segunda línea.',
        usage: 'Uso editorial revisado',
        series: null,
        featured: true
      }
    }))
  }
  async function preview(version: number) {
    const csv = new TextDecoder().decode(exportEditorialCsv(rows(version)))
    const response = await http(`${root}/preview`, 'POST', { csv })
    assert.equal(response.status, 200)
    const value = editorialPreviewSchema.parse(await response.json())
    assert.equal(value.status, 'pending')
    assert.equal(value.products.length, 2)
    return value
  }
  async function command(
    id: string,
    hash: string,
    action: 'apply' | 'revert',
    key: string,
    reason = 'Revisión sintética nativa'
  ) {
    const response = await http(`${root}/previews/${id}/${action}`, 'POST', { previewHash: hash, reason }, key)
    assert.equal(response.status, 200)
    const text = await response.text(),
      receipt = editorialReceiptSchema.parse(JSON.parse(text))
    assert.equal(receipt.action, action)
    assert.equal(receipt.previewId, id)
    assert.equal(receipt.previewHash, hash)
    assert.equal(receipt.productCount, 2)
    return { text, receipt }
  }
  const protectedBefore = await protectedState(),
    initial = await products(),
    initialLedger = await ledger()
  assert(protectedBefore && initialLedger)
  assert.equal(initial.length, 2)
  let scenarios = 0
  scenario('native_editorial_live_auth_and_csrf_no_product_effects')
  await denied(await http(`${root}/preview`, 'POST', { csv: 'invalid' }, undefined, ''), 401, 'unauthenticated')
  await denied(
    await http(`${root}/preview`, 'POST', { csv: 'invalid' }, undefined, unprivilegedCookie),
    403,
    // The existing ordinary-customer fixture has no MFA verification. Preserve
    // the real authorization order; do not grant it MFA just for this test.
    'mfa_required'
  )
  await denied(
    await http(`${root}/preview`, 'POST', { csv: 'invalid' }, undefined, adminCookie, 'https://cross-site.invalid'),
    403,
    'csrf_rejected'
  )
  assert.deepEqual(await products(), initial)
  assert.deepEqual(await ledger(), initialLedger)
  scenarios++
  scenario('native_editorial_two_row_preview_is_inert_and_private')
  const template = await http(`${root}/template`)
  assert.equal(template.status, 200)
  assert.equal(template.headers.get('content-type'), 'text/csv; charset=utf-8')
  assert.match(template.headers.get('content-disposition') ?? '', /^attachment;/)
  const templateBytes = new Uint8Array(await template.arrayBuffer())
  assert(templateBytes.byteLength > 0 && templateBytes.byteLength <= 1_000_000)
  const templateText = new TextDecoder('utf-8', { fatal: true }).decode(templateBytes)
  const templateCells = parseCatalogCsvCells(templateText, { maxRows: 101, maxColumns: 9, maxCellCharacters: 10_000 })
  assert.deepEqual(templateCells[0], [...EDITORIAL_CSV_COLUMNS])
  for (let index = 0; index < ids.length; index++)
    assert.deepEqual(
      templateCells.find((row) => row[0] === ids[index]),
      [ids[index], String(legacyIds[index]), '1', initial[index]!.name, '', '', '', '', 'false']
    )
  const invalidRows = rows(1)
  invalidRows[1]!.metadata.name = 'PRIVATE_NATIVE_FORMULA_MARKER'
  const invalidCsv = new TextDecoder()
    .decode(exportEditorialCsv(invalidRows))
    .replace('PRIVATE_NATIVE_FORMULA_MARKER', '=PRIVATE_NATIVE_FORMULA_MARKER')
  const invalidResponse = await http(`${root}/preview`, 'POST', { csv: invalidCsv })
  assert.equal(invalidResponse.status, 200)
  const invalidResult = editorialInvalidSchema.parse(await invalidResponse.json())
  assert.equal(invalidResult.issues.length, 1)
  assert.equal(invalidResult.issues[0]!.code, 'metadata_field_invalid')
  assert.equal(invalidResult.issues[0]!.row, 3)
  assert.equal(invalidResult.issues[0]!.field, 'product_name')
  assert(!JSON.stringify(invalidResult).includes('PRIVATE_NATIVE_FORMULA_MARKER'))
  assert.deepEqual(await products(), initial)
  assert.deepEqual(await ledger(), initialLedger)
  const first = await preview(1)
  assert.equal(first.products[0]!.before.shortDesc, null)
  assert.equal(first.products[1]!.before.shortDesc, '')
  assert.deepEqual(await products(), initial)
  assert.deepEqual(await ledger(), { ...initialLedger, previews: initialLedger.previews + 1 })
  assert.deepEqual(await protectedState(), protectedBefore)
  scenarios++
  scenario('native_editorial_atomic_apply_and_byte_exact_replay')
  const key = randomUUID(),
    applied = await command(first.id, first.hash, 'apply', key)
  const afterApply = await products(),
    afterLedger = await ledger()
  for (let index = 0; index < 2; index++) {
    assert.equal(afterApply[index]!.catalog_version, 2)
    assert.equal(afterApply[index]!.name, rows(1)[index]!.metadata.name)
    assert.equal(afterApply[index]!.status, 'draft')
    assert.equal(afterApply[index]!.regulatory, '{}')
    assert.equal(afterApply[index]!.attributes, '{}')
  }
  assert.deepEqual(afterLedger, {
    ...initialLedger,
    previews: initialLedger.previews + 1,
    commands: initialLedger.commands + 1,
    audits: initialLedger.audits + 2
  })
  assert.equal((await command(first.id, first.hash, 'apply', key)).text, applied.text)
  assert.deepEqual(await products(), afterApply)
  assert.deepEqual(await ledger(), afterLedger)
  scenarios++
  scenario('native_editorial_mutated_idempotency_payload_is_409_without_effects')
  await denied(
    await http(
      `${root}/previews/${first.id}/apply`,
      'POST',
      { previewHash: first.hash, reason: 'Motivo diferente' },
      key
    ),
    409,
    'idempotency_conflict'
  )
  assert.deepEqual(await products(), afterApply)
  assert.deepEqual(await ledger(), afterLedger)
  scenarios++
  scenario('native_editorial_revert_restores_nulls_and_blanks_without_rewinding_version')
  await command(first.id, first.hash, 'revert', randomUUID())
  const restored = await products()
  for (let index = 0; index < 2; index++) {
    assert.equal(restored[index]!.catalog_version, 3)
    assert.deepEqual({ ...restored[index], catalog_version: 1, updated_at: initial[index]!.updated_at }, initial[index])
  }
  const read = await http(`${root}/previews/${first.id}`)
  assert.equal(read.status, 200)
  assert.equal(editorialPreviewSchema.parse(await read.json()).status, 'reverted')
  scenarios++
  scenario('native_editorial_later_http_edit_blocks_revert_without_partial_restore')
  const second = await preview(3)
  await command(second.id, second.hash, 'apply', randomUUID())
  const later = await http(
    `/api/admin/products/${legacyIds[1]}`,
    'PUT',
    { expectedVersion: 4, series: 'Edición posterior nativa', reason: 'Conservar el trabajo editorial posterior' },
    randomUUID()
  )
  assert.equal(later.status, 200)
  await later.text()
  const beforeConflict = await products(),
    beforeConflictLedger = await ledger()
  assert.equal(beforeConflict[1]!.catalog_version, 5)
  await denied(
    await http(
      `${root}/previews/${second.id}/revert`,
      'POST',
      { previewHash: second.hash, reason: 'No debe perder cambios posteriores' },
      randomUUID()
    ),
    409,
    'version_conflict'
  )
  assert.deepEqual(await products(), beforeConflict)
  assert.deepEqual(await ledger(), beforeConflictLedger)
  assert.deepEqual(await protectedState(), protectedBefore)
  scenarios++
  return { scenarios }
}
