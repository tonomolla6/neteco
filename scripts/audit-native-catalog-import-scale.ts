import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { access, mkdtemp, readdir, readFile, rm, statfs } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { convertV4MiniflareOptions, Miniflare, NoOpLog } from 'miniflare'
import { catalogRecord } from '../tests/support/catalog-tabular-fixture'
import { catalogImportJobSchema, planCatalogImportJob } from '../shared/catalog-import-job'
import { catalogImportJobReceiptSchema } from '../shared/catalog-import-job-commands'
import { issueD1SessionCookie } from '../workers/auth/session-cookie'
import {
  nativeImportProductColumns,
  nativeImportVariantColumns,
  nativeImportAssetColumns,
  nativeImportMediaColumns,
  nativeImportPriceColumns,
  nativeImportBalanceColumns,
  nativeImportMovementColumns,
  nativeImportRowObject
} from '../workers/catalog/native-import'
import { splitDemoSql } from './lib/d1-demo-sql'
import { catalogImportScaleTypedValues } from './lib/catalog-import-scale-typed-fixture'
import { executeD1CatalogTypedAttributeDefinitionCommand } from '../workers/catalog/typed-attribute-definitions'
import type { CatalogTypedAttributeDefinition } from '../shared/catalog-typed-attributes'
import { provisionPublicationValidityFixture } from '../tests/support/publication-validity-fixture'

// Explicit, local-only scale proof. Uses the existing bundle, never builds,
// deploys, loads credentials or shares Wrangler persistence. Run serially:
// ./node_modules/.bin/tsx scripts/audit-native-catalog-import-scale.ts
assert.equal(process.argv.slice(2).length, 0, 'This audit accepts no flags or remote targets')
const count = 25_000,
  origin = 'https://shop-audit.neteco.test'
const bundle = resolve('.wrangler/shop-bundle/shop.js')
await access(bundle)
const bundleSha256 = createHash('sha256')
  .update(await readFile(bundle))
  .digest('hex')
const sourceMap = JSON.parse(await readFile(`${bundle}.map`, 'utf8')) as { sources: string[]; sourcesContent: string[] }
for (const path of [
  'workers/catalog/authorization.ts',
  'workers/catalog/native-import.ts',
  'workers/catalog/import-job.ts',
  'workers/catalog/import-job-commands.ts',
  'workers/catalog/import-job-http.ts',
  'workers/catalog/typed-attribute-integrity.ts',
  'workers/catalog/typed-attribute-sql.ts',
  'workers/catalog/typed-attribute-definitions.ts',
  'workers/catalog/publication-validity.ts',
  'shared/catalog-typed-attributes.ts',
  'shared/catalog-tabular-core.ts'
]) {
  const index = sourceMap.sources.findIndex((source) => source.endsWith(`/${path}`))
  assert(
    index >= 0 && sourceMap.sourcesContent[index] === (await readFile(resolve(path), 'utf8')),
    `Existing bundle is stale: ${path}; rebuild owned by root required`
  )
}
const started = performance.now(),
  timings: Record<string, number> = {}
let phase = 'start',
  runtime: Miniflare | undefined,
  directory: string | undefined,
  outbound = 0
const nativeLimitEnforcement: Record<string, boolean> = {}
const httpTimings: Array<{ path: string; method: string; status: number; elapsedMs: number }> = []
const free = async () => {
  const value = await statfs(tmpdir())
  return value.bavail * value.bsize
}
const freeBefore = await free()
assert(freeBefore > 2_000_000_000, 'At least 2 GB free required for disposable scale evidence')
async function timed<T>(name: string, operation: () => Promise<T>) {
  phase = name
  const start = performance.now()
  console.log(JSON.stringify({ phase: name, status: 'started' }))
  try {
    return await operation()
  } finally {
    timings[name] = Math.round(performance.now() - start)
    console.log(JSON.stringify({ phase: name, elapsedMs: timings[name] }))
  }
}
try {
  directory = await mkdtemp(join(tmpdir(), 'neteco-import-scale-owned-'))
  const password = randomBytes(48).toString('hex')
  runtime = new Miniflare(
    convertV4MiniflareOptions({
      name: 'neteco-native-import-scale',
      scriptPath: bundle,
      modules: true,
      compatibilityDate: '2026-08-15',
      compatibilityFlags: ['nodejs_compat'],
      log: new NoOpLog(),
      cf: false,
      telemetry: { enabled: false },
      resourcePersistencePath: directory,
      resourceTmpPath: join(directory, 'runtime-tmp'),
      d1Databases: { DB: '00000000-0000-0000-0000-000000000057' },
      bindings: {
        APP_ENV: 'local',
        AUTH_ENABLED: 'true',
        AUTH_ORIGIN: origin,
        NUXT_PUBLIC_BASE_URL: origin,
        NUXT_SESSION_PASSWORD: password,
        AUTH_RATE_LIMIT_PEPPER: randomBytes(48).toString('hex'),
        AUTH_EMAIL_ENABLED: 'false',
        ANALYTICS_ENABLED: 'false'
      },
      ratelimits: { ADMIN_EDGE_LIMIT: { namespace_id: '990057', simple: { limit: 10000, period: 60 } } },
      outboundService: () => {
        outbound++
        return new Response('Outbound forbidden', { status: 503 })
      }
    })
  )
  await runtime.ready
  const database = await runtime.getD1Database('DB')
  const query = async (sql: string, binds: unknown[] = []): Promise<Array<Record<string, unknown>>> =>
    (
      await database
        .prepare(sql)
        .bind(...binds)
        .all<Record<string, unknown>>()
    ).results
  const scalar = async (sql: string, binds: unknown[] = []) => Number((await query(sql, binds))[0]!.n)
  await timed('migrations', async () => {
    const files = (await readdir(resolve('db/d1/migrations'))).filter((name) => /^\d+.*\.sql$/.test(name)).sort()
    assert.equal(files.length, 59, 'Frozen typed import proof requires exactly migrations 0001–0059')
    assert.equal(files.at(-1), '0059_catalog_typed_attribute_values.sql')
    for (const file of files) {
      const statements = splitDemoSql(await readFile(resolve('db/d1/migrations', file), 'utf8'))
      for (let index = 0; index < statements.length; index += 75)
        await database.batch(statements.slice(index, index + 75).map((sql) => database.prepare(sql)))
    }
  })
  // Report capabilities honestly: Miniflare's D1 implementation is not the
  // hosted D1 service and may not enforce all published service limits.
  await timed('native_limits', async () => {
    const probe = async (name: string, operation: () => Promise<unknown>) => {
      try {
        await operation()
        nativeLimitEnforcement[name] = false
      } catch {
        nativeLimitEnforcement[name] = true
      }
    }
    // A single indexed placeholder isolates SQLITE_LIMIT_VARIABLE_NUMBER:
    // adding 101 terms could instead hit the independent expression-depth cap.
    await probe('boundParameters100', () =>
      database
        .prepare('SELECT ?101')
        .bind(...Array(101).fill(1))
        .first()
    )
    await probe('likePattern50', () => database.prepare('SELECT ? LIKE ?').bind('x', 'x'.repeat(51)).first())
    await probe('rowTwoMegabytes', () =>
      database.prepare('SELECT ? AS oversized_column').bind('x'.repeat(2_100_000)).first()
    )
    console.log(JSON.stringify({ nativeLimitEnforcement }))
  })
  const id = {
    source: randomUUID(),
    category: randomUUID(),
    brand: randomUUID(),
    tax: randomUUID(),
    shipping: randomUUID(),
    warehouse: randomUUID(),
    actor: randomUUID(),
    session: randomUUID(),
    reference: randomUUID(),
    referenceVariant: randomUUID()
  }
  const now = new Date(Date.now() - 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const expires = new Date(Date.now() + 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  await timed('synthetic_private_fixtures', async () => {
    await database.batch([
      database
        .prepare(
          "INSERT INTO catalog_sources(id,code,name,owner,kind,is_master) VALUES (?,'SCALE','Scale','Synthetic','supplier',1)"
        )
        .bind(id.source),
      database
        .prepare("INSERT INTO categories(id,legacy_id,name,slug,status) VALUES (?,1,'Scale','scale','published')")
        .bind(id.category),
      database.prepare("INSERT INTO brands(id,name,slug,status) VALUES (?,'Scale','scale','published')").bind(id.brand),
      database
        .prepare(
          "INSERT INTO tax_classes(id,code,name,rate_basis_points,valid_from) VALUES (?,'SCALE','VAT',2100,'2020-01-01T00:00:00Z')"
        )
        .bind(id.tax),
      database
        .prepare("INSERT INTO shipping_profiles(id,code,name,kind) VALUES (?,'SCALE','Scale','parcel')")
        .bind(id.shipping),
      database
        .prepare(
          "INSERT INTO inventory_locations(id,code,name,kind,active,created_at) VALUES (?,'SCALE','Scale','warehouse',1,?)"
        )
        .bind(id.warehouse, now),
      database
        .prepare(
          "INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at) VALUES (?,'scale@example.invalid','unusable',?,'active',?,?)"
        )
        .bind(id.actor, now, now, now),
      database.prepare("INSERT INTO roles VALUES ('scale','Synthetic scale','Disposable only')"),
      ...['catalog.write', 'administration.manage', 'inventory.write'].flatMap((permission) => [
        database
          .prepare('INSERT INTO permissions VALUES (?,?,?,?)')
          .bind(permission, ...permission.split('.'), 'Disposable only'),
        database.prepare("INSERT INTO role_permissions VALUES ('scale',?)").bind(permission)
      ]),
      database
        .prepare("INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES (?,'scale',?)")
        .bind(id.actor, now),
      database
        .prepare(
          'INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES (?,?,1,1,?,?)'
        )
        .bind(id.session, id.actor, now, expires)
    ])
  })
  const definitions: CatalogTypedAttributeDefinition[] = []
  await timed('synthetic_typed_definitions_and_public_reference', async () => {
    await database.batch([
      database
        .prepare(
          "INSERT INTO products(id,legacy_id,category_id,brand_id,name,slug,status) VALUES(?,99,?,?,'Synthetic reference only','scale-reference','published')"
        )
        .bind(id.reference, id.category, id.brand),
      database
        .prepare(
          "INSERT INTO variants(id,legacy_id,product_id,tax_class_id,shipping_profile_id,sku,format,mpn,status,price_gross_cents) VALUES(?,99,?,?,?,'SCALE-REFERENCE','Unit','SCALE-REFERENCE','published',100)"
        )
        .bind(id.referenceVariant, id.reference, id.tax, id.shipping)
    ])
    // Existing synthetic test-only evidence is seeded before the immutable
    // authority baseline. No imported product receives any such authority.
    await provisionPublicationValidityFixture(database, { productIds: [id.reference], now })
    const specs = [
      { kind: 'text', config: { maxLength: 500 } },
      { kind: 'number', config: { precision: 2 } },
      { kind: 'unit', config: { precision: 2, units: ['l'] } },
      { kind: 'boolean', config: {} },
      { kind: 'list', config: { options: [{ code: 'blue', label: 'Azul', status: 'active' }] } },
      { kind: 'reference', config: {} }
    ]
    for (const spec of specs)
      definitions.push(
        (
          await executeD1CatalogTypedAttributeDefinitionCommand(
            database,
            { identityId: id.actor, sessionId: id.session, sessionVersion: 1 },
            'create',
            {},
            {
              ...spec,
              categoryId: 1,
              code: `scale_${spec.kind}`,
              label: `Synthetic ${spec.kind}`,
              expectedVersion: 0,
              reason: 'Disposable synthetic scale definition, not production authority'
            },
            { idempotencyKey: randomUUID() }
          )
        ).definition
      )
  })
  const protectedTables = [
    'permissions',
    'role_permissions',
    'identity_roles',
    'media_uploads',
    'media_scan_receipts',
    'media_rights_decisions',
    'product_media_publications',
    'orders',
    'inventory_reservations',
    'payment_intents',
    'fiscal_invoice_intents',
    'catalog_typed_attribute_definitions',
    'catalog_typed_attribute_revisions',
    'catalog_typed_attribute_commands',
    'catalog_typed_attribute_audit',
    'catalog_typed_attribute_guards',
    'catalog_publication_policies',
    'catalog_product_publication_policies'
  ]
  const protectedState = async () => {
    const snapshots: Array<Array<Record<string, unknown>>> = []
    for (const table of protectedTables) snapshots.push(await query(`SELECT * FROM ${table} ORDER BY rowid`))
    snapshots.push(await query('SELECT * FROM products WHERE id=?', [id.reference]))
    snapshots.push(await query('SELECT * FROM variants WHERE id=?', [id.referenceVariant]))
    return JSON.stringify(snapshots)
  }
  const protectedBefore = await protectedState()
  const cookie = (await issueD1SessionCookie(
    database,
    { identityId: id.actor, sessionId: id.session, sessionVersion: 1 },
    { password, maxAgeSeconds: 3600 }
  ))!.split(';')[0]!
  let httpRequests = 0
  async function http(path: string, method = 'GET', body?: unknown, key?: string, status = 200) {
    httpRequests++
    const requestStart = performance.now()
    const response = await runtime!.dispatchFetch(`${origin}/api/admin/catalog/import-jobs${path}`, {
      method,
      headers: {
        Origin: origin,
        Cookie: cookie,
        'Sec-Fetch-Site': 'same-origin',
        'CF-Connecting-IP': '192.0.2.157',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(key ? { 'Idempotency-Key': key } : {})
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
    const text = await response.text()
    const elapsedMs = Math.ceil(performance.now() - requestStart)
    httpTimings.push({ path, method, status: response.status, elapsedMs })
    console.log(JSON.stringify({ http: { path, method, status: response.status, elapsedMs } }))
    assert.equal(response.status, status, `${phase}: HTTP ${response.status}: ${text.slice(0, 300)}`)
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
    // HTTP wall time includes the entire D1 batch and all preflight reads,
    // so <=30s is a conservative upper bound for D1's whole-batch limit.
    if (/\/(apply|revert)$/.test(path)) {
      assert(
        elapsedMs <= 30_000,
        `${phase}: HTTP ${elapsedMs}ms exceeds the conservative D1 whole-batch 30s acceptance budget`
      )
    } else if (elapsedMs > 30_000) {
      console.log(
        JSON.stringify({ warning: 'Non-command HTTP exceeds 30s; no internal batch timing available', path, elapsedMs })
      )
    }
    return { text, json: JSON.parse(text) as unknown }
  }
  const plan = await timed('generate_25000_records', async () => {
    const base = catalogRecord()
    return planCatalogImportJob(
      Array.from({ length: count }, (_, index) => {
        const product = randomUUID(),
          variant = randomUUID(),
          asset = randomUUID()
        return {
          ...base,
          product_id: product,
          variant_id: variant,
          asset_id: asset,
          product_legacy_id: String(1_000_001 + index),
          variant_legacy_id: String(2_000_001 + index),
          product_name: `Scale ${index}`,
          product_slug: `scale-${index}`,
          short_description: 'Synthetic scale proof',
          description: 'Synthetic scale evidence, never real production catalog.',
          product_usage: '',
          product_series: '',
          category_id: id.category,
          brand_id: id.brand,
          source_id: id.source,
          tax_class_id: id.tax,
          shipping_profile_id: id.shipping,
          sku: `SCALE-${index}`,
          ean: '',
          gtin: '',
          mpn: `SCALE-${index}`,
          identifier_exception_reason: 'Synthetic MPN only',
          inventory_json: JSON.stringify([
            { locationId: id.warehouse, physicalQuantity: 40, blockedQuantity: 2, version: 1 }
          ]),
          asset_storage_key: `clean/${asset}.png`,
          asset_source_url: `/media/${asset}`,
          asset_checksum_sha256: createHash('sha256').update(asset).digest('hex'),
          product_attributes_json: JSON.stringify({
            ...JSON.parse(base.product_attributes_json),
            image: `/media/${asset}`,
            typed: catalogImportScaleTypedValues(definitions, id.reference, index)
          })
        }
      })
    )
  })
  console.log(
    JSON.stringify({ records: count, pages: plan.pages.length, expandedBytes: plan.totalBytes, bundleSha256 })
  )
  const job = catalogImportJobSchema.parse(
    (await http('', 'POST', { totalPages: plan.pages.length, recordCount: count }, randomUUID())).json
  )
  await timed('upload_all_pages', async () => {
    for (const page of plan.pages) {
      const uploaded = catalogImportJobSchema.parse(
        (await http(`/${job.id}/pages/${page.index}`, 'PUT', { index: page.index, records: page.records })).json
      )
      assert.equal(uploaded.receivedPages, page.index + 1)
      if ((page.index + 1) % 10 === 0)
        console.log(JSON.stringify({ uploadedPages: page.index + 1, pages: plan.pages.length }))
    }
  })
  const sealed = await timed('seal', async () =>
    catalogImportJobSchema.parse(
      (await http(`/${job.id}/seal`, 'POST', { reason: 'Disposable maximum scale proof' })).json
    )
  )
  assert.equal(sealed.status, 'ready')
  assert.deepEqual(sealed.counts, { products: count, variants: count, assets: count, mappings: count })
  const stagingDigest = async () => {
    const hash = createHash('sha256')
    for (const table of [
      'catalog_import_jobs',
      'catalog_import_job_pages',
      'catalog_import_job_rows',
      'catalog_import_job_entries',
      'catalog_import_job_identifiers',
      'catalog_import_job_seals'
    ]) {
      hash.update(table)
      // Bounded reads never create an aggregate >2 MB D1 row/result.
      const size = table === 'catalog_import_job_pages' ? 1 : table === 'catalog_import_job_entries' ? 100 : 500
      for (let offset = 0; ; offset += size) {
        const page = await query(`SELECT * FROM ${table} ORDER BY rowid LIMIT ? OFFSET ?`, [size, offset])
        for (const row of page) hash.update(JSON.stringify(row))
        if (page.length < size) break
      }
    }
    return hash.digest('hex')
  }
  const sourceDigest = await timed('hash_immutable_source', stagingDigest)
  const specs = [
    ['products', 'products', nativeImportProductColumns, 'r.id'],
    ['variants', 'variants', nativeImportVariantColumns, 'r.id'],
    ['assets', 'media_assets', nativeImportAssetColumns, 'r.id'],
    [
      'media',
      'product_media',
      nativeImportMediaColumns,
      'json_array(r.product_id,r.variant_id,r.asset_id,r.role,r.version)'
    ],
    ['prices', 'variant_price_versions', nativeImportPriceColumns, 'r.id'],
    ['balances', 'inventory_balances', nativeImportBalanceColumns, 'json_array(r.variant_id,r.location_id)'],
    ['movements', 'inventory_movements', nativeImportMovementColumns, 'r.id']
  ] as const
  const intakeScope = (kind: string, alias = 'r') => {
    const parent =
      kind === 'media' ? 'products' : ['prices', 'balances', 'movements'].includes(kind) ? 'variants' : kind
    const column =
      kind === 'media' ? 'product_id' : ['prices', 'balances', 'movements'].includes(kind) ? 'variant_id' : 'id'
    // job.id is a runtime-generated UUID, never request SQL. Outer rows probe
    // the immutable complete staging PK; no giant/correlated identity list.
    return `EXISTS(SELECT 1 FROM catalog_import_job_entries scope WHERE scope.job_id='${job.id}'
      AND scope.kind='${parent}' AND scope.item_id=${alias}.${column})`
  }
  const countersBefore = await query('SELECT * FROM catalog_draft_legacy_counters ORDER BY entity')
  const emptyDomain = async () => {
    for (const [kind, table] of specs) {
      assert.equal(await scalar(`SELECT count(*) AS n FROM ${table} r WHERE ${intakeScope(kind)}`), 0, table)
      assert.equal(
        await scalar(`SELECT count(*) AS n FROM ${table}`),
        kind === 'products' || kind === 'variants' ? 1 : 0,
        `${table} unrelated baseline`
      )
    }
    assert.equal(await scalar('SELECT count(*) AS n FROM catalog_import_job_commands'), 0)
    assert.equal(await scalar('SELECT count(*) AS n FROM catalog_import_job_command_audit'), 0)
    assert.deepEqual(await query('SELECT * FROM catalog_draft_legacy_counters ORDER BY entity'), countersBefore)
    assert.equal(await protectedState(), protectedBefore)
  }
  const body = { previewHash: sealed.hash, reason: 'Disposable maximum scale atomic command' },
    applyKey = randomUUID()
  await timed('late_failure_atomic_rollback_25000', async () => {
    await database
      .prepare(
        "CREATE TRIGGER scale_owned_late_abort BEFORE INSERT ON catalog_import_job_command_audit WHEN NEW.kind='movements' BEGIN SELECT RAISE(ABORT,'scale_owned_late_abort'); END"
      )
      .run()
    await http(`/${job.id}/apply`, 'POST', body, applyKey, 500)
    await emptyDomain()
    await database.prepare('DROP TRIGGER scale_owned_late_abort').run()
  })
  async function command(action: 'apply' | 'revert', key: string) {
    const response = await http(`/${job.id}/${action}`, 'POST', body, key)
    const receipt = catalogImportJobReceiptSchema.parse(response.json)
    assert.equal(receipt.action, action)
    assert.equal(receipt.jobId, job.id)
    assert.equal(receipt.jobHash, sealed.hash)
    assert.deepEqual(receipt.counts, sealed.counts)
    return { ...response, receipt }
  }
  const applied = await timed('apply_all_25000_one_transaction', () => command('apply', applyKey))
  const maximumObservedRowBytes: Record<string, number> = {}
  async function verify(action: 'apply' | 'revert', commandId: string) {
    for (const [kind, table, columns, key] of specs) {
      const expected = kind === 'movements' && action === 'revert' ? 2 * count : count
      assert.equal(await scalar(`SELECT count(*) AS n FROM ${table} r WHERE ${intakeScope(kind)}`), expected, table)
      assert.equal(
        await scalar(`SELECT count(*) AS n FROM ${table}`),
        expected + (kind === 'products' || kind === 'variants' ? 1 : 0),
        `${table} exact domain size`
      )
      assert.equal(
        await scalar('SELECT count(*) AS n FROM catalog_import_job_command_audit WHERE command_id=? AND kind=?', [
          commandId,
          kind
        ]),
        expected,
        `${kind} audit`
      )
      assert.equal(
        await scalar(
          `SELECT count(*) AS n FROM ${table} r LEFT JOIN catalog_import_job_command_audit a ON a.command_id=? AND a.kind=? AND a.item_id=${key} WHERE ${intakeScope(kind)} AND (a.command_id IS NULL OR a.after_state IS NOT ${nativeImportRowObject([...columns], 'r')})`,
          [commandId, kind]
        ),
        0,
        `${kind} exact snapshot`
      )
      const bytes = await scalar(
        `SELECT COALESCE(max(${columns.map((column) => `COALESCE(length(CAST(${column} AS BLOB)),0)`).join('+')}),0) AS n FROM ${table}`
      )
      maximumObservedRowBytes[table] = Math.max(maximumObservedRowBytes[table] ?? 0, bytes)
      assert(bytes <= 2_000_000, `${table}: observed row exceeds D1 2 MB budget`)
    }
    const reverted = action === 'revert'
    assert.equal(
      await scalar(
        `SELECT count(*) AS n FROM catalog_import_job_entries entry
      CROSS JOIN products r ON r.id=entry.item_id WHERE entry.job_id=? AND entry.kind='products'
      AND (r.attributes IS NOT json_extract(entry.payload,'$.attributes')
        OR json_array_length(r.attributes,'$.typed.values')<>6)`,
        [job.id]
      ),
      0,
      'exact six-kind attributes and preserved unknown legacy JSON'
    )
    assert.equal(
      await scalar(
        `SELECT count(*) AS n FROM products r WHERE ${intakeScope('products')} AND (status<>? OR published_at IS NOT NULL)`,
        [reverted ? 'discontinued' : 'draft']
      ),
      0
    )
    assert.equal(
      await scalar(
        `SELECT count(*) AS n FROM variants r WHERE ${intakeScope('variants')} AND (status<>? OR price_gross_cents<>?)`,
        [reverted ? 'discontinued' : 'draft', reverted ? 0 : 1599]
      ),
      0
    )
    assert.equal(
      await scalar(
        "SELECT count(*) AS n FROM media_assets WHERE rights_status<>'pending' OR quarantine_status<>'pending'"
      ),
      0
    )
    assert.equal(
      await scalar(
        'SELECT count(*) AS n FROM inventory_balances WHERE physical_quantity<>? OR blocked_quantity<>? OR version<>?',
        [reverted ? 0 : 40, reverted ? 0 : 2, reverted ? 2 : 1]
      ),
      0
    )
    assert.equal(
      await scalar('SELECT count(*) AS n FROM variant_price_versions WHERE gross_cents<>1599 OR status<>?', [
        reverted ? 'cancelled' : 'approved'
      ]),
      0
    )
    assert.equal(
      await scalar(
        "SELECT count(*) AS n FROM inventory_movements WHERE movement_type='initial' AND physical_delta=40 AND reference_id=?",
        [applied.receipt.commandId]
      ),
      count
    )
    assert.equal(await scalar('SELECT count(*) AS n FROM catalog_import_job_guards'), 0)
    const auditBytes = await scalar(
      'SELECT COALESCE(max(length(CAST(command_id AS BLOB))+length(CAST(kind AS BLOB))+length(CAST(item_id AS BLOB))+COALESCE(length(CAST(before_state AS BLOB)),0)+length(CAST(after_state AS BLOB))),0) AS n FROM catalog_import_job_command_audit'
    )
    maximumObservedRowBytes.catalog_import_job_command_audit = auditBytes
    assert(auditBytes <= 2_000_000)
    assert.equal(await protectedState(), protectedBefore)
    assert.equal(
      catalogImportJobSchema.parse((await http(`/${job.id}`)).json).status,
      reverted ? 'reverted' : 'applied'
    )
    assert.equal(await scalar('SELECT count(*) AS n FROM catalog_import_job_commands'), reverted ? 2 : 1)
  }
  await timed('verify_apply', () => verify('apply', applied.receipt.commandId))
  assert.equal(
    await scalar('SELECT count(*) AS n FROM catalog_import_job_command_audit WHERE before_state IS NOT NULL'),
    0
  )
  const countersApplied = await query('SELECT * FROM catalog_draft_legacy_counters ORDER BY entity')
  assert.equal(Number(countersApplied.find((row) => row.entity === 'product')!.last_id), 1_000_000 + count)
  assert.equal(Number(countersApplied.find((row) => row.entity === 'variant')!.last_id), 2_000_000 + count)
  await timed('apply_byte_exact_replay', async () => {
    assert.equal((await command('apply', applyKey)).text, applied.text)
    await verify('apply', applied.receipt.commandId)
  })
  const revertKey = randomUUID(),
    reverted = await timed('revert_all_25000_one_transaction', () => command('revert', revertKey))
  await timed('verify_revert', async () => {
    await verify('revert', reverted.receipt.commandId)
    assert.equal(
      await scalar(
        "SELECT count(*) AS n FROM inventory_movements WHERE movement_type='adjustment' AND physical_delta=-40 AND reference_id=?",
        [reverted.receipt.commandId]
      ),
      count
    )
    assert.equal(
      await scalar(
        'SELECT count(*) AS n FROM catalog_import_job_command_audit a LEFT JOIN catalog_import_job_command_audit prior ON prior.command_id=? AND prior.kind=a.kind AND prior.item_id=a.item_id WHERE a.command_id=? AND a.before_state IS NOT prior.after_state',
        [applied.receipt.commandId, reverted.receipt.commandId]
      ),
      0
    )
    assert.deepEqual(await query('SELECT * FROM catalog_draft_legacy_counters ORDER BY entity'), countersApplied)
  })
  await timed('revert_byte_exact_replay', async () => {
    assert.equal((await command('revert', revertKey)).text, reverted.text)
    await verify('revert', reverted.receipt.commandId)
  })
  assert.equal(await timed('verify_immutable_source', stagingDigest), sourceDigest)
  assert.equal(outbound, 0)
  console.log(
    JSON.stringify({
      status: 'local_cycle_passed',
      runtime: 'local Miniflare/workerd D1',
      records: count,
      pages: plan.pages.length,
      expandedBytes: plan.totalBytes,
      auditRows: count * 15,
      migrationCount: 59,
      typedDefinitionCount: definitions.length,
      typedValuesPerProduct: 6,
      typedReferenceFixtureProducts: 1,
      durableReceipts: 2,
      rollbackVerified: true,
      immutableSource: true,
      outbound,
      httpRequests,
      httpTimings,
      nativeLimitEnforcement,
      maximumObservedRowBytes,
      generatedStatementsMonitored: false,
      cloudLimitsAccepted: false,
      bundleSha256,
      timings,
      deployedAcceptance: false
    })
  )
} catch (failure) {
  console.error(
    JSON.stringify({
      status: 'failed',
      phase,
      error: failure instanceof Error ? failure.message : String(failure),
      timings,
      httpTimings,
      nativeLimitEnforcement,
      bundleSha256,
      outbound
    })
  )
  process.exitCode = 1
} finally {
  await runtime?.dispose()
  if (directory) {
    assert(directory.startsWith(join(tmpdir(), 'neteco-import-scale-owned-')))
    await rm(directory, { recursive: true })
  }
  console.log(
    JSON.stringify({
      cleanup: 'disposed task-owned runtime and ephemeral D1 directory',
      freeBytesBefore: freeBefore,
      freeBytesAfter: await free(),
      elapsedMs: Math.round(performance.now() - started)
    })
  )
}
