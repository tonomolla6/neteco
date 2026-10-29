import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { chromium, expect, type BrowserContext, type Page } from '@playwright/test'
import {
  catalogTypedAttributeReceiptSchema,
  type CatalogTypedAttributeDefinition,
  type CatalogTypedAttributeValue,
  type CatalogTypedAttributeValues
} from '../../shared/catalog-typed-attributes'
import {
  catalogTypedAttributeDefinitionsViewSchema,
  catalogTypedAttributeProductViewSchema,
  catalogTypedAttributeValuesReceiptSchema,
  type CatalogTypedAttributeValuesReceipt
} from '../../shared/catalog-typed-attribute-views'
import { serializeCatalogTypedFilters } from '../../shared/catalog-typed-attribute-filters'
import { catalogPolicyUuidSchema } from '../../shared/catalog-publication-policy'
import type { ProductListResponse, TypedAttributeFilter } from '../../shared/types/catalog'
import { connectRemoteTestBrowser, REMOTE_BROWSER_NOT_RUN_REASON } from './remote-test-browser'
import { auditNativeTypedIntake } from './audit-native-typed-intake'

export interface NativeTypedAttributesAuditInput {
  database: D1Database
  /** The existing disposable workerd dispatcher, never an outbound fetch. */
  dispatch: (request: Request) => Promise<Response>
  origin: string
  adminCookie: string
  unprivilegedCookie: string
  scenario: (name: string) => void
  browserMode?: 'required' | 'not-run'
  /** Caller-owned real local media/policy/status commands. No direct published
   * assignment, fabricated approvals, production rights or antivirus claim. */
  publishSyntheticProducts: (products: { id: string; legacyId: number; slug: string }[]) => Promise<void>
}

/** Six bounded scenarios against real APIs and the compiled Nuxt application.
 * Three public candidates and one private category-isolation draft are seeded.
 * Definitions and values use the
 * actual command APIs; the caller owns governed synthetic publication. This
 * helper neither adds permissions nor changes existing catalogue products. */
export async function auditNativeTypedAttributes(input: NativeTypedAttributesAuditInput) {
  const { database, dispatch, origin, adminCookie, unprivilegedCookie } = input
  const url = new URL(origin)
  assert(url.protocol === 'https:' && url.origin === origin && url.hostname.endsWith('.test'))
  assert(adminCookie && unprivilegedCookie && adminCookie !== unprivilegedCookie)
  assert(input.browserMode === undefined || ['required', 'not-run'].includes(input.browserMode))
  const cookie = /^neteco-session=([^;\r\n]+)$/.exec(adminCookie)
  assert(cookie, 'Requires the existing sealed synthetic administrator session')
  const namespace = '/api/admin/catalog-attributes'
  let scenarios = 0,
    httpRequests = 0,
    browserScenarios = 0,
    browserRequests = 0,
    pageErrors = 0,
    blockedExternal = 0,
    forbiddenWrites = 0
  function mark(name: string) {
    input.scenario(name)
    scenarios++
  }
  async function http(
    path: string,
    options: { method?: string; body?: string; key?: string; cookie?: string; requestOrigin?: string } = {}
  ) {
    const target = new URL(path, origin)
    assert.equal(target.origin, origin)
    httpRequests++
    return dispatch(
      new Request(target, {
        method: options.method ?? 'GET',
        headers: {
          Cookie: options.cookie ?? adminCookie,
          Origin: options.requestOrigin ?? origin,
          'Sec-Fetch-Site': 'same-origin',
          'CF-Connecting-IP': '192.0.2.155',
          ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(options.key ? { 'Idempotency-Key': options.key } : {})
        },
        ...(options.body === undefined ? {} : { body: options.body }),
        redirect: 'manual'
      })
    )
  }
  async function json(path: string, options: Parameters<typeof http>[1] = {}) {
    const response = await http(path, options)
    assert(
      response.ok,
      `Typed audit request failed: ${options.method ?? 'GET'} ${new URL(path, origin).pathname} (${response.status})`
    )
    if (path.startsWith(namespace)) {
      assert.equal(response.headers.get('cache-control'), 'private, no-store')
      assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
    }
    return response.json() as Promise<unknown>
  }
  // One bounded public list, not a database-wide ID list or per-product lookup:
  // public API eligibility is the authority for the existing reference target.
  const existing = (await json('/api/products?limit=50', { cookie: '' })) as ProductListResponse
  const reference = existing.items.find((item) => catalogPolicyUuidSchema.safeParse(item.uuid).success)
  assert(reference, 'Requires one existing public UUID product in the disposable audit fixtures')
  const dependencies = await database
    .prepare(
      `SELECT p.category_id AS categoryId,p.brand_id AS brandId,v.tax_class_id AS taxId,
      v.shipping_profile_id AS shippingId,v.price_gross_cents AS priceCents
      FROM products p JOIN categories c ON c.id=p.category_id AND c.status='published'
      JOIN brands b ON b.id=p.brand_id AND b.status='published'
      JOIN variants v ON v.product_id=p.id AND v.status='published'
      JOIN tax_classes t ON t.id=v.tax_class_id
      WHERE p.id=?1 AND p.status='published' AND v.price_gross_cents>0
      AND t.valid_from<=strftime('%Y-%m-%dT%H:%M:%SZ','now')
      AND (t.valid_until IS NULL OR t.valid_until>strftime('%Y-%m-%dT%H:%M:%SZ','now'))
      ORDER BY v.legacy_id LIMIT 1`
    )
    .bind(reference.uuid)
    .first<{ categoryId: string; brandId: string; taxId: string; shippingId: string; priceCents: number }>()
  assert(dependencies, 'Existing public reference must supply eligible local catalogue dependencies')
  const counters = await database
    .prepare(
      `SELECT (SELECT COALESCE(MAX(legacy_id),0)+1 FROM products) AS product,
      (SELECT COALESCE(MAX(legacy_id),0)+1 FROM variants) AS variant`
    )
    .first<{ product: number; variant: number }>()
  assert(counters && Number.isSafeInteger(counters.product + 2) && Number.isSafeInteger(counters.variant + 2))
  const suffix = randomUUID().slice(0, 8),
    prefix = `TypedProof${suffix}`,
    htmlText = '<strong>Ñ 🧼 texto literal</strong>',
    legacy = { attrs: [{ k: 'Legacy', v: 'Conservar Ñ' }], privateAudit: { localOnly: true, sentinel: suffix } },
    fixtures = ['a', 'b', 'c'].map((code, index) => ({
      id: randomUUID(),
      variant: randomUUID(),
      legacyId: counters.product + index,
      variantLegacyId: counters.variant + index,
      slug: `typed-proof-${suffix}-${code}`,
      name: `${prefix} ${code.toUpperCase()}`
    }))
  const protectedTables = ['identity_roles', 'role_permissions', 'permissions', 'orders', 'payment_intents']
  const protectedState = async () =>
    JSON.stringify(
      (
        await database.batch(protectedTables.map((table) => database.prepare(`SELECT * FROM ${table} ORDER BY rowid`)))
      ).map((result) => result.results)
    )
  const protectedBefore = await protectedState()
  await database.batch(
    fixtures.flatMap((fixture) => [
      database
        .prepare(
          `INSERT INTO products(id,legacy_id,category_id,brand_id,name,slug,status,short_description,description,
          attributes,regulatory) VALUES (?,?,?,?,?,?,'draft',?,?,?,?)`
        )
        .bind(
          fixture.id,
          fixture.legacyId,
          dependencies.categoryId,
          dependencies.brandId,
          fixture.name,
          fixture.slug,
          'Producto sintético local de atributos tipados',
          'Fixture desechable local, sin aceptación comercial, legal ni antivirus de producción.',
          JSON.stringify(legacy),
          JSON.stringify({ requiresSds: false, localAuditOnly: true })
        ),
      database
        .prepare(
          `INSERT INTO variants(id,legacy_id,product_id,tax_class_id,shipping_profile_id,sku,mpn,format,status,
          price_gross_cents,weight_grams,width_mm,height_mm,depth_mm,backorder_allowed,lead_time_days)
          VALUES (?,?,?,?,?,?,?,'Unidad sintética','draft',?,800,300,200,100,1,5)`
        )
        .bind(
          fixture.variant,
          fixture.variantLegacyId,
          fixture.id,
          dependencies.taxId,
          dependencies.shippingId,
          `TYPED-${fixture.id}`,
          `TYPED-MPN-${fixture.id}`,
          dependencies.priceCents
        )
    ])
  )
  const a = fixtures[0]!,
    b = fixtures[1]!,
    c = fixtures[2]!
  const productPath = (fixture: (typeof fixtures)[number]) => `${namespace}/products/${fixture.legacyId}`
  const definitionPath = `${namespace}/definitions`
  mark('native_typed_six_definition_commands_revision_history_and_durable_replay')
  const configs = [
    ['text', { maxLength: 500 }],
    ['number', { precision: 2, min: -10, max: 10 }],
    ['unit', { precision: 2, units: ['ml', 'l'] }],
    ['boolean', {}],
    [
      'list',
      {
        options: [
          { code: 'blue', label: 'Azul', status: 'active' },
          { code: 'green', label: 'Verde', status: 'active' }
        ]
      }
    ],
    ['reference', {}]
  ] as const
  const definitions: CatalogTypedAttributeDefinition[] = []
  for (const [kind, config] of configs) {
    const body = JSON.stringify({
      categoryId: reference.categoryId,
      code: `typed_${suffix}_${kind}`,
      kind,
      label: `${prefix} ${kind}`,
      config,
      expectedVersion: 0,
      reason: 'Definición sintética local explícita'
    })
    const key = randomUUID()
    const created = catalogTypedAttributeReceiptSchema.parse(await json(definitionPath, { method: 'POST', body, key }))
    assert.equal(created.action, 'create')
    definitions.push(created.definition)
    if (kind === 'text') {
      const changed = catalogTypedAttributeReceiptSchema.parse(
        await json(`${definitionPath}/${created.definition.id}`, {
          method: 'PUT',
          key: randomUUID(),
          body: JSON.stringify({
            action: 'update',
            label: `${prefix} texto revisado`,
            config,
            expectedVersion: 1,
            reason: 'Revisión sintética sin reinterpretar históricos'
          })
        })
      )
      assert.equal(changed.definition.revision, 2)
      definitions[0] = changed.definition
      const replay = catalogTypedAttributeReceiptSchema.parse(await json(definitionPath, { method: 'POST', body, key }))
      assert.deepEqual(replay, created, 'Original receipt survives a later current revision')
    }
  }
  const defs = catalogTypedAttributeDefinitionsViewSchema.parse(
    await json(`${definitionPath}?categoryId=${reference.categoryId}`)
  )
  for (const definition of definitions)
    assert(defs.definitions.some((item) => item.id === definition.id && item.revision === definition.revision))
  const id = (kind: string) => definitions.find((definition) => definition.kind === kind)!.id
  const typed = (values: CatalogTypedAttributeValue[]): CatalogTypedAttributeValues => ({
    version: 1,
    values: definitions.map((definition, index) => ({
      definitionId: definition.id,
      revision: definition.revision,
      value: values[index]!
    }))
  })
  const expected = [
    typed([htmlText, 0, { quantity: 0, unit: 'ml' }, false, ['blue'], reference.uuid]),
    typed(['B Ñ', 0, { quantity: 1, unit: 'l' }, true, ['blue'], reference.uuid]),
    typed(['C Ñ', 1, { quantity: 0, unit: 'ml' }, false, ['green'], reference.uuid])
  ]
  async function values(fixture: (typeof fixtures)[number], value: CatalogTypedAttributeValues) {
    const snapshot = catalogTypedAttributeProductViewSchema.parse(await json(productPath(fixture)))
    const body = JSON.stringify({
        expectedVersion: snapshot.product.catalogVersion,
        reason: 'Valores sintéticos localmente revisados',
        typed: value
      }),
      key = randomUUID()
    const receipt = catalogTypedAttributeValuesReceiptSchema.parse(
      await json(productPath(fixture), { method: 'PUT', body, key })
    )
    assert.deepEqual(receipt.typed, value)
    return { receipt, body, key }
  }
  mark('native_typed_full_replace_six_values_legacy_preserved_and_exact_receipt_replay')
  for (const [index, fixture] of fixtures.entries()) await values(fixture, expected[index]!)
  const onlyBoolean = {
    version: 1 as const,
    values: expected[0]!.values.filter((entry) => entry.definitionId === id('boolean'))
  }
  await values(a, onlyBoolean)
  const replaced = catalogTypedAttributeProductViewSchema.parse(await json(productPath(a)))
  assert.deepEqual(replaced.typed, onlyBoolean, 'Full replacement must remove explicitly absent entries, not merge')
  const restored = await values(a, expected[0]!)
  const state = async () => {
    const rows = await database
      .prepare('SELECT id,attributes,catalog_version FROM products WHERE id IN (?1,?2,?3) ORDER BY id')
      .bind(a.id, b.id, c.id)
      .all()
    const ledger = await database
      .prepare('SELECT count(*) AS n FROM catalog_draft_commands WHERE product_id IN (?1,?2,?3)')
      .bind(a.id, b.id, c.id)
      .first()
    return JSON.stringify({ rows: rows.results, ledger })
  }
  const beforeReplay = await state()
  const replay = catalogTypedAttributeValuesReceiptSchema.parse(
    await json(productPath(a), { method: 'PUT', body: restored.body, key: restored.key })
  )
  assert.deepEqual(replay, restored.receipt)
  assert.equal(await state(), beforeReplay)
  for (const fixture of fixtures) {
    const row = await database
      .prepare('SELECT attributes FROM products WHERE id=?')
      .bind(fixture.id)
      .first<{ attributes: string }>()
    assert(row)
    const attrs = JSON.parse(row.attributes)
    const { typed: namespaceValue, ...unchanged } = attrs
    assert(namespaceValue)
    assert.deepEqual(unchanged, legacy, 'Typed full replacement must preserve every legacy/unknown field')
  }
  mark('native_typed_real_anonymous_unprivileged_and_csrf_denials_without_mutation')
  const beforeDenied = await state()
  for (const options of [
    { cookie: '' },
    { cookie: unprivilegedCookie },
    { requestOrigin: 'https://outside.neteco.test' }
  ]) {
    const denied = await http(productPath(a), { method: 'PUT', body: restored.body, key: restored.key, ...options })
    assert.equal(denied.status, options.cookie === '' ? 401 : 403)
  }
  assert.equal(await state(), beforeDenied)

  // Separate private draft proves explicit category ownership without adding a
  // fourth published fixture or changing the caller's three-product callback.
  const otherCategory = existing.items.find((item) => item.categoryId !== reference.categoryId)
  assert(otherCategory, 'Category-isolation proof requires another existing public category')
  const otherCategoryRow = await database
    .prepare("SELECT id FROM categories WHERE legacy_id=? AND status='published'")
    .bind(otherCategory.categoryId)
    .first<{ id: string }>()
  assert(otherCategoryRow)
  const separateDraft = {
    id: randomUUID(),
    variant: randomUUID(),
    legacyId: counters.product + 3,
    variantLegacyId: counters.variant + 3,
    slug: `typed-private-${suffix}`,
    name: `PrivateTyped${suffix}`
  }
  await database.batch([
    database
      .prepare(
        `INSERT INTO products(id,legacy_id,category_id,brand_id,name,slug,status,attributes,regulatory)
      VALUES (?,?,?,?,?,?,'draft',?,?)`
      )
      .bind(
        separateDraft.id,
        separateDraft.legacyId,
        otherCategoryRow.id,
        dependencies.brandId,
        separateDraft.name,
        separateDraft.slug,
        JSON.stringify(legacy),
        JSON.stringify({ localAuditOnly: true })
      ),
    database
      .prepare(
        `INSERT INTO variants(id,legacy_id,product_id,tax_class_id,shipping_profile_id,sku,mpn,format,status,price_gross_cents)
      VALUES (?,?,?,?,?,?,?,'Unidad privada sintética','draft',?)`
      )
      .bind(
        separateDraft.variant,
        separateDraft.variantLegacyId,
        separateDraft.id,
        dependencies.taxId,
        dependencies.shippingId,
        `TYPED-${separateDraft.id}`,
        `TYPED-MPN-${separateDraft.id}`,
        dependencies.priceCents
      )
  ])
  const separateDefinition = catalogTypedAttributeReceiptSchema.parse(
    await json(definitionPath, {
      method: 'POST',
      key: randomUUID(),
      body: JSON.stringify({
        categoryId: otherCategory.categoryId,
        code: `typed_${suffix}_separate`,
        kind: 'boolean',
        label: 'Categoría distinta, borrador privado',
        config: {},
        expectedVersion: 0,
        reason: 'Isolation synthétique explicite, sans héritage'
      })
    })
  ).definition
  const separateTyped: CatalogTypedAttributeValues = {
    version: 1,
    values: [{ definitionId: separateDefinition.id, revision: 1, value: false }]
  }
  await values(separateDraft, separateTyped)
  const separateView = catalogTypedAttributeProductViewSchema.parse(await json(productPath(separateDraft)))
  assert.equal(separateView.product.categoryId, otherCategory.categoryId)
  assert.deepEqual(separateView.typed, separateTyped)
  const crossing = await http(productPath(separateDraft), {
    method: 'PUT',
    key: randomUUID(),
    body: JSON.stringify({
      expectedVersion: separateView.product.catalogVersion,
      reason: 'Rejet réel de valeurs de catégorie étrangère',
      typed: expected[0]
    })
  })
  assert.equal(crossing.status, 422)
  assert.equal(((await crossing.json()) as { error: { code: string } }).error.code, 'invalid_typed_values')
  assert.deepEqual(catalogTypedAttributeProductViewSchema.parse(await json(productPath(separateDraft))), separateView)
  assert.equal((await http(`/api/products/${separateDraft.slug}`, { cookie: '' })).status, 404)

  const browser = input.browserMode === 'not-run' ? null : await connectRemoteTestBrowser(chromium)
  let context: BrowserContext | null = null
  let page: Page | null = null
  const browserWrites: Array<{ path: string; body: string; key: string; status: number }> = []
  const browserLookups: Array<{ path: string; query: string }> = []
  const editableDefinitionIds = new Set<string>()
  const transport: {
    loseNextValues: boolean
    cookieOverride?: string
    lostReceipt?: CatalogTypedAttributeValuesReceipt
  } = {
    loseNextValues: false
  }
  const browserCoverage: string[] = []
  // UI full replacements follow the reader's definition-code order, not the
  // fixture creation order. Only these independent semantic expectations sort
  // entries; frozen bodies, replay receipts and pinned history remain exact.
  const uiValuesByDefinition = (namespaceValue: CatalogTypedAttributeValues) => ({
    version: namespaceValue.version,
    values: [...namespaceValue.values].sort((left, right) => left.definitionId.localeCompare(right.definitionId))
  })
  try {
    if (browser) {
      context = await browser.newContext({
        locale: 'es-ES',
        timezoneId: 'Europe/Madrid',
        viewport: { width: 1440, height: 1000 }
      })
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
        const headers = await incoming.allHeaders(),
          method = incoming.method()
        let ownedCreate = false
        if (method === 'POST' && target.pathname === definitionPath) {
          try {
            const body = JSON.parse(incoming.postData() ?? '')
            ownedCreate =
              body.code === `typed_${suffix}_history` &&
              body.categoryId === reference.categoryId &&
              body.kind === 'text'
          } catch {
            /* A malformed/unowned write is blocked, not forwarded. */
          }
        }
        if (
          target.pathname.startsWith('/api/') &&
          !['GET', 'HEAD'].includes(method) &&
          !(
            (method === 'PUT' && target.pathname === productPath(a)) ||
            ownedCreate ||
            (method === 'PUT' &&
              target.pathname.startsWith(`${definitionPath}/`) &&
              editableDefinitionIds.has(target.pathname.slice(definitionPath.length + 1)))
          )
        ) {
          forbiddenWrites++
          await route.abort('blockedbyclient')
          return
        }
        browserRequests++
        if (
          method === 'GET' &&
          ['/api/admin/products', '/api/products'].includes(target.pathname) &&
          target.searchParams.has('q')
        )
          browserLookups.push({ path: target.pathname, query: target.search })
        headers['cf-connecting-ip'] = '192.0.2.155'
        headers['accept-encoding'] = 'identity'
        const bytes = incoming.postDataBuffer()
        if (method === 'PUT' && target.pathname === productPath(a) && transport.cookieOverride !== undefined) {
          // A real authentication failure with the frontend's session still
          // cached: only the forwarded request cookie is omitted/replaced.
          headers.cookie = transport.cookieOverride
          Reflect.deleteProperty(transport, 'cookieOverride')
        }
        const response = await dispatch(
          new Request(target, { method, headers, ...(bytes ? { body: new Uint8Array(bytes) } : {}) })
        )
        if (!['GET', 'HEAD'].includes(method))
          browserWrites.push({
            path: target.pathname,
            body: incoming.postData() ?? '',
            key: headers['idempotency-key'] ?? '',
            status: response.status
          })
        if (method === 'PUT' && target.pathname === productPath(a) && transport.loseNextValues) {
          assert.equal(response.status, 200, 'Only a successful genuine Worker receipt may be lost')
          transport.lostReceipt = catalogTypedAttributeValuesReceiptSchema.parse(await response.json())
          const committed = await database
            .prepare('SELECT catalog_version,attributes FROM products WHERE id=?')
            .bind(a.id)
            .first<{ catalog_version: number; attributes: string }>()
          assert(committed)
          assert.equal(committed.catalog_version, transport.lostReceipt.catalogVersion)
          assert.deepEqual(
            JSON.parse(committed.attributes).typed,
            transport.lostReceipt.typed,
            'Lost response follows an independently verified durable product write'
          )
          transport.loseNextValues = false
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
      page = await context.newPage()
      page.on('pageerror', () => {
        pageErrors++
      })
      mark('native_typed_compiled_admin_boolean_explicit_get_command_and_receipt')
      browserScenarios++
      await page.goto(`${origin}/admin/productos/${a.legacyId}`, { waitUntil: 'networkidle', timeout: 30_000 })
      const editor = page
        .locator('section')
        .filter({ has: page.getByRole('heading', { name: 'Atributos tipados del producto', exact: true }) })
      await editor.locator('[data-typed-load]').click()
      for (const definition of definitions)
        await expect(editor.locator(`[data-typed-presence="${definition.id}"]`)).toBeChecked()
      await editor.locator(`[data-typed-input="${id('text')}"]`).fill(htmlText)
      await editor.locator(`[data-typed-input="${id('number')}"]`).fill('0')
      await editor.locator(`[data-typed-input="${id('unit')}"]`).fill('0')
      await editor.locator(`[data-typed-unit="${id('unit')}"]`).selectOption('ml')
      await editor.locator(`[data-typed-input="${id('boolean')}"]`).selectOption('true')
      await editor.locator(`[data-typed-option="${id('list')}:blue"]`).check()
      await editor.locator(`[data-typed-option="${id('list')}:green"]`).uncheck()
      const referenceInput = editor.locator(`[data-typed-input="${id('reference')}"]`)
      await referenceInput.fill(reference.uuid)
      // Use the already bounded public fixture list to choose a real shared
      // name token. A public candidate beyond the single private-list result
      // proves that the picker is not the intersection of two first pages.
      const nameTokens = new Map<string, number>()
      for (const item of existing.items)
        for (const token of new Set(item.name.toLocaleLowerCase('es-ES').match(/[\p{L}\p{N}]{2,100}/gu) ?? []))
          nameTokens.set(token, (nameTokens.get(token) ?? 0) + 1)
      const nameQuery = [...nameTokens].sort((left, right) => right[1] - left[1]).find(([, count]) => count >= 2)?.[0]
      assert(nameQuery, 'Public audit fixtures must contain a shared searchable name token')
      async function searchReferences(query: string) {
        const before = browserLookups.length
        await editor.locator('[data-reference-query]').fill(query)
        await page!.waitForLoadState('networkidle')
        assert.equal(browserLookups.length, before, 'Typing alone must not issue reference search GETs')
        const matches = (path: string) => (result: import('@playwright/test').Response) => {
          const target = new URL(result.url())
          return (
            target.pathname === path && target.searchParams.get('q') === query && result.request().method() === 'GET'
          )
        }
        const administrator = page!.waitForResponse(matches('/api/admin/products'))
        const publicProducts = page!.waitForResponse(matches('/api/products'))
        await editor.locator('[data-reference-search]').click()
        const [adminResponse, publicResponse] = await Promise.all([administrator, publicProducts])
        assert.equal(adminResponse.status(), 200)
        assert.equal(publicResponse.status(), 200)
        assert.equal(adminResponse.headers()['cache-control'], 'private, no-store')
        const admin = (await adminResponse.json()) as {
          source: string
          capabilities: { productsRead: boolean }
          items: Array<{ uuid: string }>
        }
        const published = (await publicResponse.json()) as ProductListResponse
        assert.equal(admin.source, 'cloudflare')
        assert.equal(admin.capabilities.productsRead, true)
        assert(Array.isArray(admin.items) && admin.items.length === 1)
        assert(Array.isArray(published.items) && published.items.length > 0 && published.items.length <= 20)
        const requests = browserLookups.slice(before)
        assert.deepEqual(
          requests.map((request) => request.path).sort(),
          ['/api/admin/products', '/api/products'],
          'Each deliberate search issues exactly one authority GET and one public candidate GET'
        )
        for (const request of requests) {
          const parameters = new URLSearchParams(request.query)
          assert.equal(parameters.get('q'), query)
          assert.equal(parameters.get('page'), '1')
          if (request.path === '/api/admin/products') {
            assert.equal(parameters.get('status'), 'published')
            assert.equal(parameters.get('perPage'), '1')
          } else assert.equal(parameters.get('limit'), '20')
        }
        const publicIds = published.items.filter((item) => item.uuid !== a.id).map((item) => item.uuid)
        for (const uuid of publicIds) assert(catalogPolicyUuidSchema.safeParse(uuid).success)
        await expect(editor.locator('[data-reference-option]')).toHaveCount(publicIds.length)
        assert.deepEqual(
          (
            await editor
              .locator('[data-reference-option]')
              .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-reference-option')))
          ).sort(),
          [...publicIds].sort(),
          'Rendered candidates are exactly the authoritative public response, not private-list intersections'
        )
        return { admin, published }
      }
      const named = await searchReferences(nameQuery)
      const privateFirstPage = new Set(named.admin.items.map((item) => item.uuid))
      const selectedReference = named.published.items.find(
        (item) => item.uuid !== a.id && !privateFirstPage.has(item.uuid)
      )
      assert(selectedReference, 'Require a genuine public candidate absent from the private first page')
      await expect(referenceInput).toHaveValue(reference.uuid)
      await editor.locator(`[data-reference-option="${selectedReference.uuid}"]`).click()
      await expect(referenceInput).toHaveValue(selectedReference.uuid)
      browserCoverage.push(
        'reference_name_explicit_search_zero_typing_gets_exact_two_gets_public_not_page_intersection'
      )

      const referenceVariant = await database
        .prepare("SELECT sku FROM variants WHERE product_id=? AND status='published' ORDER BY legacy_id LIMIT 1")
        .bind(selectedReference.uuid)
        .first<{ sku: string }>()
      assert(referenceVariant && referenceVariant.sku.length >= 2 && referenceVariant.sku.length <= 100)
      const bySku = await searchReferences(referenceVariant.sku)
      assert(bySku.published.items.some((item) => item.uuid === selectedReference.uuid))
      await expect(referenceInput).toHaveValue(selectedReference.uuid)
      await editor.locator(`[data-reference-option="${selectedReference.uuid}"]`).click()
      await expect(referenceInput).toHaveValue(selectedReference.uuid)
      browserCoverage.push('reference_sku_real_public_candidate_and_manual_uuid_preserved_until_selection')

      const lookupPath = `/api/admin/products?${new URLSearchParams({
        q: referenceVariant.sku,
        status: 'published',
        page: '1',
        perPage: '1'
      })}`
      for (const [failedCookie, status] of [
        ['', 401],
        [unprivilegedCookie, 403]
      ] as const) {
        const denied = await http(lookupPath, { cookie: failedCookie })
        assert.equal(denied.status, status)
        assert.equal(denied.headers.get('cache-control'), 'private, no-store')
        assert(
          !(await denied.text()).includes(selectedReference.uuid),
          'Denied authority lookups disclose no candidate UUID'
        )
      }
      browserCoverage.push('reference_authority_get_real_401_403_failclosed_no_candidate_disclosure')
      await editor.locator('[data-typed-reason]').fill('Comando booleano explícito del navegador sintético')
      await editor.locator('[data-typed-confirm]').check()
      const updated = page.waitForResponse(
        (response) => new URL(response.url()).pathname === productPath(a) && response.request().method() === 'PUT'
      )
      await editor.locator('[data-typed-save]').click()
      const response = await updated
      assert.equal(response.status(), 200)
      const browserReceipt = catalogTypedAttributeValuesReceiptSchema.parse(await response.json())
      assert.equal(browserReceipt.typed.values.find((entry) => entry.definitionId === id('boolean'))?.value, true)
      assert.equal(
        browserReceipt.typed.values.find((entry) => entry.definitionId === id('reference'))?.value,
        selectedReference.uuid
      )
      assert.deepEqual(
        uiValuesByDefinition(browserReceipt.typed),
        uiValuesByDefinition(typed([htmlText, 0, { quantity: 0, unit: 'ml' }, true, ['blue'], selectedReference.uuid]))
      )
      browserCoverage.push('six_controls_exact_json_types_zero_false_unit_list_reference')
      await expect(editor.getByText('Comando confirmado.', { exact: false })).toBeVisible()
      await editor.locator('[data-typed-load]').click()
      await expect(editor.locator(`[data-typed-input="${id('boolean')}"]`)).toHaveValue('true')
      async function confirmValues(reason: string) {
        await editor.locator('[data-typed-reason]').fill(reason)
        await editor.locator('[data-typed-confirm]').check()
      }
      async function submitValues() {
        const pending = page!.waitForResponse(
          (result) => new URL(result.url()).pathname === productPath(a) && result.request().method() === 'PUT'
        )
        await editor.locator('[data-typed-save]').click()
        return pending
      }
      // Lose delivery only after real workerd committed and returned a parsed
      // receipt. The explicit GET does not manufacture an acknowledgement.
      await confirmValues('Réponse perdue, récupération explicite synthétique')
      transport.loseNextValues = true
      const writesBeforeLoss = browserWrites.length
      await editor.locator('[data-typed-save]').click()
      await expect(editor.locator('[data-typed-retry]')).toBeVisible()
      assert.equal(browserWrites.length, writesBeforeLoss + 1, 'No automatic mutation retry after transport loss')
      const lostRequest = browserWrites.at(-1)!
      await editor.locator('[data-typed-load]').click()
      await expect(editor.locator('[data-typed-retry]')).toBeEnabled()
      assert.equal(browserWrites.length, writesBeforeLoss + 1, 'Recovery GET is read-only')
      const recovered = page.waitForResponse(
        (result) => new URL(result.url()).pathname === productPath(a) && result.request().method() === 'PUT'
      )
      await editor.locator('[data-typed-retry]').click()
      const recoveredResponse = await recovered
      assert.equal(recoveredResponse.status(), 200)
      assert.deepEqual(
        catalogTypedAttributeValuesReceiptSchema.parse(await recoveredResponse.json()),
        transport.lostReceipt
      )
      const replayRequest = browserWrites.at(-1)!
      assert.equal(replayRequest.body, lostRequest.body)
      assert.equal(replayRequest.key, lostRequest.key)
      browserCoverage.push('lost_success_real_get_exact_body_key_and_receipt_replay')
      await editor.locator('[data-typed-load]').click()
      await expect(editor.locator('[data-typed-reason]')).toBeEnabled()
      await editor.locator(`[data-typed-input="${id('text')}"]`).fill('Borrador recuperable Ñ')
      await confirmValues('Conflicto real, conservar borrador explícito')
      // Real independent concurrent command advances the durable version after
      // the browser GET; the stale browser PUT must receive an actual 409.
      await values(a, expected[0]!)
      const conflictResponse = await submitValues()
      assert.equal(conflictResponse.status(), 409)
      assert.equal(((await conflictResponse.json()) as { error: { code: string } }).error.code, 'version_conflict')
      const conflictRequest = browserWrites.at(-1)!
      await expect(editor.locator('[data-typed-discard]')).toHaveCount(0)
      await editor.locator('[data-typed-load]').click()
      await editor.locator('[data-typed-discard]').click()
      await expect(editor.locator(`[data-typed-input="${id('text')}"]`)).toHaveValue('Borrador recuperable Ñ')
      await expect(editor.locator('[data-typed-confirm]')).not.toBeChecked()
      await editor.locator('[data-typed-confirm]').check()
      const newResponse = await submitValues()
      assert.equal(newResponse.status(), 200)
      const newRequest = browserWrites.at(-1)!
      assert.notEqual(newRequest.key, conflictRequest.key)
      assert.equal(JSON.parse(newRequest.body).expectedVersion, JSON.parse(conflictRequest.body).expectedVersion + 1)
      assert.deepEqual(JSON.parse(newRequest.body).typed, JSON.parse(conflictRequest.body).typed)
      browserCoverage.push('real_409_fresh_get_explicit_discard_preserved_draft_new_key')
      for (const [failedCookie, status] of [
        ['', 401],
        [unprivilegedCookie, 403]
      ] as const) {
        await editor.locator('[data-typed-load]').click()
        await expect(editor.locator('[data-typed-reason]')).toBeEnabled()
        await confirmValues(`Échec autorité HTTP ${status}, aucune répétition`)
        transport.cookieOverride = failedCookie
        const before = await state(),
          writeCount = browserWrites.length
        assert.equal((await submitValues()).status(), status)
        await expect(editor.locator('[data-typed-form]')).toHaveCount(0)
        await expect(editor.locator('[data-typed-retry]')).toHaveCount(0)
        await expect(editor.locator('[data-typed-load]')).toBeVisible()
        assert.equal(await state(), before)
        assert.equal(browserWrites.length, writeCount + 1)
        await editor.locator('[data-typed-load]').click()
        await expect(editor.locator('[data-typed-reason]')).toBeEnabled()
        await expect(editor.locator('[data-typed-retry]')).toHaveCount(0)
      }
      browserCoverage.push('real_401_403_cached_frontend_fail_closed_fresh_get_only')
      // Restore only by a further genuine values command while still draft.
      await values(a, expected[0]!)
      // Auxiliary definition leaves the six public fixtures active while
      // exercising actual category administration and historical retention.
      await page.goto(`${origin}/admin/categorias`, { waitUntil: 'networkidle', timeout: 30_000 })
      const categoryEditor = page
        .locator('section')
        .filter({ has: page.getByRole('heading', { name: 'Definiciones de atributos por categoría', exact: true }) })
      await categoryEditor.locator('[data-definition-category]').selectOption(String(reference.categoryId))
      await categoryEditor.locator('[data-definitions-load]').click()
      await categoryEditor.locator('[data-definition-create]').click()
      await categoryEditor.locator('[data-definition-code]').fill(`typed_${suffix}_history`)
      await categoryEditor.locator('[data-definition-label]').fill(`${prefix} histórico auxiliar`)
      await categoryEditor.locator('[data-definition-kind]').selectOption('text')
      async function definitionCommand(path: string, method: string, reason: string) {
        await categoryEditor.locator('[data-definition-reason]').fill(reason)
        await categoryEditor.locator('[data-definition-confirm]').check()
        const pending = page!.waitForResponse(
          (result) => new URL(result.url()).pathname === path && result.request().method() === method
        )
        await categoryEditor.locator('[data-definition-form] button[type="submit"]').click()
        const result = await pending
        assert(result.ok())
        return catalogTypedAttributeReceiptSchema.parse(await result.json())
      }
      const auxiliary = await definitionCommand(definitionPath, 'POST', 'Création explicite UI locale synthétique')
      editableDefinitionIds.add(auxiliary.definition.id)
      await categoryEditor.locator('[data-definitions-load]').click()
      await categoryEditor.locator(`[data-definition-edit="${auxiliary.definition.id}"]`).click()
      await expect(categoryEditor.locator('[data-definition-code]')).toBeDisabled()
      await expect(categoryEditor.locator('[data-definition-kind]')).toBeDisabled()
      await categoryEditor.locator('[data-definition-label]').fill(`${prefix} histórico revisado`)
      const revision = await definitionCommand(
        `${definitionPath}/${auxiliary.definition.id}`,
        'PUT',
        'Révision explicite UI locale synthétique'
      )
      assert.equal(revision.definition.revision, 2)
      const pinned = { definitionId: revision.definition.id, revision: 2, value: 'Histórico Ñ preservado' }
      await values(a, { version: 1, values: [...expected[0]!.values, pinned] })
      await categoryEditor.locator('[data-definitions-load]').click()
      await categoryEditor.locator(`[data-definition-retire="${auxiliary.definition.id}"]`).click()
      const retired = await definitionCommand(
        `${definitionPath}/${auxiliary.definition.id}`,
        'PUT',
        'Retrait explicite sans effacer historique'
      )
      assert.equal(retired.definition.status, 'retired')
      await page.goto(`${origin}/admin/productos/${a.legacyId}`, { waitUntil: 'networkidle', timeout: 30_000 })
      await editor.locator('[data-typed-load]').click()
      await expect(editor.locator(`[data-typed-historical="${auxiliary.definition.id}"]`)).toContainText(pinned.value)
      await expect(editor.locator(`[data-typed-input="${auxiliary.definition.id}"]`)).toHaveCount(0)
      await confirmValues('Conserver le précédent historique sans réinterpréter')
      const historicalResponse = await submitValues()
      assert.equal(historicalResponse.status(), 200)
      const retained = catalogTypedAttributeValuesReceiptSchema.parse(await historicalResponse.json())
      assert.deepEqual(
        retained.typed.values.find((entry) => entry.definitionId === pinned.definitionId),
        pinned
      )
      await editor.locator('[data-typed-load]').click()
      await editor.locator(`[data-typed-remove="${auxiliary.definition.id}"]`).click()
      await confirmValues('Suppression explicite de la seule entrée historique')
      const removed = await submitValues()
      assert.equal(removed.status(), 200)
      assert.deepEqual(
        uiValuesByDefinition(catalogTypedAttributeValuesReceiptSchema.parse(await removed.json()).typed),
        uiValuesByDefinition(expected[0]!)
      )
      browserCoverage.push('definition_ui_create_revision_retire_historical_keep_and_explicit_remove')
    }
    const intake = await auditNativeTypedIntake({
      database,
      dispatch,
      origin,
      adminCookie,
      definitions,
      categoryUuid: dependencies.categoryId,
      referenceProductUuid: reference.uuid
    })
    await input.publishSyntheticProducts(fixtures.map(({ id, legacyId, slug }) => ({ id, legacyId, slug })))
    mark('native_typed_public_false_zero_units_or_and_autoexcluded_exact_counts')
    async function list(filters: TypedAttributeFilter[] = []) {
      const query = new URLSearchParams({ q: prefix, facets: '1', limit: '50' })
      const serialized = serializeCatalogTypedFilters(filters)
      if (serialized) query.set('typed', serialized)
      const result = (await json(`/api/products?${query}`, { cookie: '' })) as ProductListResponse
      assert.equal(result.total, result.items.length, 'All three isolated fixtures fit one page; totals must be exact')
      for (const facet of result.facets?.typed ?? [])
        for (const option of facet.values) assert(option.n > 0, 'Typed facets may only advertise values with results')
      return result
    }
    function slugs(result: ProductListResponse) {
      return result.items.map((item) => item.slug).sort()
    }
    const all = await list()
    assert.deepEqual(slugs(all), fixtures.map((fixture) => fixture.slug).sort())
    const bool = (values: boolean[]): TypedAttributeFilter => ({ definitionId: id('boolean'), values })
    const number = (values: number[]): TypedAttributeFilter => ({ definitionId: id('number'), values })
    assert.deepEqual(slugs(await list([bool([false, true])])), slugs(all))
    const intersection = await list([bool([false]), number([0])])
    assert.deepEqual(slugs(intersection), [a.slug])
    assert.deepEqual(
      slugs(await list([{ definitionId: id('unit'), values: [{ quantity: 0, unit: 'ml' }] }])),
      [a.slug, c.slug].sort()
    )
    assert.deepEqual(slugs(await list([{ definitionId: id('unit'), values: [{ quantity: 0, unit: 'l' }] }])), [])
    assert.deepEqual(slugs(await list([{ definitionId: id('list'), values: ['blue', 'green'] }])), slugs(all))
    for (const [kind, pairs] of [
      [
        'boolean',
        [
          [false, 1],
          [true, 1]
        ]
      ],
      [
        'number',
        [
          [0, 1],
          [1, 1]
        ]
      ]
    ] as const) {
      const facet = intersection.facets?.typed?.find((item) => item.definitionId === id(kind))
      assert(facet)
      for (const [value, count] of pairs) assert.equal(facet.values.find((option) => option.value === value)?.n, count)
    }
    const detail = (await json(`/api/products/${a.slug}`, { cookie: '' })) as {
      typedAttrs?: Array<{ definitionId: string; value: unknown; displayValue: string }>
    }
    assert.equal(detail.typedAttrs?.find((entry) => entry.definitionId === id('text'))?.displayValue, htmlText)
    assert.equal(detail.typedAttrs?.find((entry) => entry.definitionId === id('boolean'))?.value, false)
    assert.equal(detail.typedAttrs?.find((entry) => entry.definitionId === id('number'))?.value, 0)
    assert.equal((await http(`/api/products?q=${prefix}&typed=not-json`, { cookie: '' })).status, 400)
    if (page) {
      mark('native_typed_compiled_public_url_back_clear_and_safe_mobile_detail')
      browserScenarios++
      await page.goto(`${origin}/buscar?q=${prefix}`, { waitUntil: 'networkidle', timeout: 30_000 })
      const group = page
        .locator(`[data-typed-group="${id('boolean')}"]`)
        .filter({ visible: true })
        .first()
      const falseLabel = all.facets?.typed
        ?.find((item) => item.definitionId === id('boolean'))
        ?.values.find((option) => option.value === false)?.label
      assert(falseLabel)
      const choice = group.locator('label').filter({ hasText: falseLabel }).getByRole('checkbox')
      await choice.check()
      await expect
        .poll(() => new URL(page!.url()).searchParams.get('typed'))
        .toBe(serializeCatalogTypedFilters([bool([false])]))
      const selectedUrl = page.url()
      await expect(page.locator('[data-typed-pill]')).toHaveCount(1)
      // Filters use router.replace: a real route visit creates the history
      // entry rather than inventing push semantics for a checkbox toggle.
      await page.goto(`${origin}/catalogo`, { waitUntil: 'networkidle', timeout: 30_000 })
      await page.goBack({ waitUntil: 'networkidle' })
      await expect.poll(() => page!.url()).toBe(selectedUrl)
      await expect(group.locator('label').filter({ hasText: falseLabel }).getByRole('checkbox')).toBeChecked()
      await page.getByRole('button', { name: 'Quitar todo', exact: true }).click()
      await expect.poll(() => new URL(page!.url()).searchParams.has('typed')).toBe(false)
      await expect(page.locator('[data-typed-pill]')).toHaveCount(0)
      await page.setViewportSize({ width: 390, height: 844 })
      await page.goto(`${origin}/producto/${a.slug}`, { waitUntil: 'networkidle', timeout: 30_000 })
      const text = page.locator(`[data-typed-detail="${id('text')}"]`)
      await expect(text).toContainText(htmlText)
      assert.equal(await text.locator('strong').count(), 0, 'HTML-looking typed strings must remain escaped text')
      await expect(page.locator(`[data-typed-detail="${id('number')}"]`)).toContainText('0')
      const booleanDisplay = detail.typedAttrs!.find((entry) => entry.definitionId === id('boolean'))!.displayValue
      await expect(page.locator(`[data-typed-detail="${id('boolean')}"]`)).toContainText(booleanDisplay)
      assert.equal(await page.locator('html').evaluate((element) => element.scrollWidth > window.innerWidth + 1), false)
      await page.keyboard.press('Tab')
      assert(
        await page.evaluate(() => document.activeElement !== document.body),
        'Mobile page supports real keyboard traversal'
      )
    }
    assert.equal(await protectedState(), protectedBefore, 'No grants, roles, commerce or payment mutations')
    assert.equal(pageErrors, 0)
    assert.equal(blockedExternal, 0)
    assert.equal(forbiddenWrites, 0)
    assert.equal(
      (
        await database
          .prepare('SELECT status FROM products WHERE id=?')
          .bind(separateDraft.id)
          .first<{ status: string }>()
      )?.status,
      'draft'
    )
    return {
      scenarios,
      apiScenarios: 4,
      browserScenarios,
      httpRequests,
      fixtureProducts: fixtures.map(({ id, legacyId, slug }) => ({ id, legacyId, slug })),
      privateCategoryFixture: {
        id: separateDraft.id,
        legacyId: separateDraft.legacyId,
        slug: separateDraft.slug,
        categoryId: otherCategory.categoryId,
        remainsDraft: true
      },
      sixKinds: definitions.map((definition) => definition.kind),
      browserCoverage,
      intake,
      browser: {
        status: browser ? ('passed' as const) : ('not_run' as const),
        reason: browser ? null : REMOTE_BROWSER_NOT_RUN_REASON,
        engine: browser ? 'remote_playwright_chromium' : null,
        transport: browser ? 'playwright_same_origin_forwarding_to_real_workerd' : null,
        requests: browser ? browserRequests : null,
        pageErrors: browser ? pageErrors : null,
        blockedExternal: browser ? blockedExternal : null,
        viewports: browser ? ['1440x1000', '390x844'] : []
      },
      localOnly: true,
      syntheticSessionOnly: true,
      productionBrowserAcceptance: false
    }
  } finally {
    try {
      await context?.close()
    } finally {
      await browser?.close()
    }
  }
}
