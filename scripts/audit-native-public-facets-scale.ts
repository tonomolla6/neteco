import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, mkdtemp, readFile, readdir, rm, statfs } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { convertV4MiniflareOptions, Miniflare, NoOpLog } from 'miniflare'
import type { ProductListResponse } from '../shared/types/catalog'
import { provisionPublicationValidityFixture } from '../tests/support/publication-validity-fixture'
import { splitDemoSql } from './lib/d1-demo-sql'

// Local-only verification of aggregate SQL in the actual bundled Worker. No
// credentials, deployed bindings, build, browser, provider or shared D1 state.
assert.equal(process.argv.slice(2).length, 0, 'No flags or remote targets are accepted')
const bundle = resolve('.wrangler/shop-bundle/shop.js'),
  origin = 'https://public-facets-scale.neteco.test',
  count = 1500,
  productId = (index: number) => `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`
await access(bundle)
const bundleSha256 = createHash('sha256')
  .update(await readFile(bundle))
  .digest('hex')
const map = JSON.parse(await readFile(bundle + '.map', 'utf8')) as {
  sources: string[]
  sourcesContent: string[]
}
for (const path of [
  'workers/catalog/products.ts',
  'workers/catalog/product-facets.ts',
  'workers/catalog/typed-attribute-facets.ts',
  'workers/catalog/publication-validity.ts',
  'workers/media/public-catalog.ts'
]) {
  const index = map.sources.findIndex((source) => source.endsWith('/' + path))
  assert(index >= 0 && map.sourcesContent[index] === (await readFile(path, 'utf8')), `Stale bundle: ${path}`)
}
const started = performance.now(),
  requests: Array<{ query: string; elapsedMs: number; responseBytes: number }> = []
let runtime: Miniflare | undefined,
  directory: string | undefined,
  outbound = 0,
  phase = 'storage_preflight'
const free = async () => {
  const space = await statfs(tmpdir())
  return space.bavail * space.bsize
}
const freeBefore = await free()
assert(freeBefore >= 1_000_000_000, 'Disposable audit requires at least 1 GB free')
try {
  directory = await mkdtemp(join(tmpdir(), 'neteco-public-facets-scale-owned-'))
  phase = 'workerd_start'
  runtime = new Miniflare(
    convertV4MiniflareOptions({
      name: 'neteco-public-facets-scale',
      scriptPath: bundle,
      modules: true,
      compatibilityDate: '2026-08-15',
      compatibilityFlags: ['nodejs_compat'],
      log: new NoOpLog(),
      cf: false,
      telemetry: { enabled: false },
      resourcePersistencePath: directory,
      resourceTmpPath: join(directory, 'runtime-tmp'),
      d1Databases: { DB: '00000000-0000-0000-0000-000000000060' },
      bindings: { APP_ENV: 'local', AUTH_ENABLED: 'false', ANALYTICS_ENABLED: 'false' },
      outboundService: () => {
        outbound++
        return new Response('Outbound forbidden', { status: 503 })
      }
    })
  )
  await runtime.ready
  const database = await runtime.getD1Database('DB')
  phase = 'migrations'
  const migrations = (await readdir('db/d1/migrations')).filter((name) => /^\d+.*\.sql$/.test(name)).sort()
  assert.equal(migrations.length, 59)
  assert.equal(migrations.at(-1), '0059_catalog_typed_attribute_values.sql')
  for (const name of migrations) {
    const sql = splitDemoSql(await readFile(join('db/d1/migrations', name), 'utf8'))
    for (let index = 0; index < sql.length; index += 50)
      await database.batch(sql.slice(index, index + 50).map((statement) => database.prepare(statement)))
  }
  phase = 'explicit_synthetic_publication_fixture'
  await database.batch(
    [
      "INSERT INTO categories(id,legacy_id,name,slug,status) VALUES ('category',1,'Synthetic scale','synthetic-scale','published')",
      "INSERT INTO brands(id,name,slug,status) VALUES ('brand-a','Synthetic A','synthetic-a','published'),('brand-b','Synthetic B','synthetic-b','published')",
      "INSERT INTO tax_classes(id,code,name,rate_basis_points,valid_from) VALUES ('tax','SCALE','Synthetic VAT',2100,'2020-01-01T00:00:00Z')",
      "INSERT INTO shipping_profiles(id,code,name,kind) VALUES ('shipping','SCALE','Synthetic shipping','parcel')",
      `INSERT INTO products(id,legacy_id,category_id,brand_id,name,slug,status,attributes)
        VALUES ('${productId(0)}',1,'category','brand-a','Synthetic scale 0000','synthetic-scale-0','published',
          '{"badges":["Synthetic","Synthetic"],"visual":{"type":"botella","color":"#123456"}}')`,
      `INSERT INTO variants(id,legacy_id,product_id,tax_class_id,shipping_profile_id,sku,mpn,format,status,
        price_gross_cents,content_quantity,unit_label,color)
        VALUES ('20000000-0000-4000-8000-000000000001',1,'${productId(0)}','tax','shipping',
          'SYNTHETIC-SCALE-0-A','SYNTHETIC','10 mm · Mate · Color Azul','published',500,1,'L','#123456'),
          ('20000000-0000-4000-8000-000000000002',2,'${productId(0)}','tax','shipping',
          'SYNTHETIC-SCALE-0-B','SYNTHETIC','10 mm · Mate · Color Azul','published',500,1,'L','#123456')`
    ].map((sql) => database.prepare(sql))
  )
  // Test-only D1 evidence, explicitly NOT a legal/antivirus approval or stored
  // R2 original. Clones share this synthetic image but own their assignments.
  await provisionPublicationValidityFixture(database, { productIds: [productId(0)] })
  phase = '1500_products_3000_variants'
  const sequence = `WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM seq WHERE i<${count - 1})`
  await database.batch(
    [
      `${sequence} INSERT INTO products(id,legacy_id,category_id,brand_id,name,slug,status,attributes,regulatory)
        SELECT printf('10000000-0000-4000-8000-%012d',i),i+1,'category',
          CASE WHEN i%2=0 THEN 'brand-a' ELSE 'brand-b' END,printf('Synthetic scale %04d',i),
          'synthetic-scale-'||i,'published',p.attributes,p.regulatory
        FROM seq CROSS JOIN products p WHERE p.id='${productId(0)}'`,
      `${sequence} INSERT INTO variants(id,legacy_id,product_id,tax_class_id,shipping_profile_id,sku,mpn,format,status,
        price_gross_cents,content_quantity,unit_label,color)
        SELECT printf('20000000-0000-4000-8000-%012d',i*2+j),i*2+j,
          printf('10000000-0000-4000-8000-%012d',i),'tax','shipping',
          'SYNTHETIC-SCALE-'||i||CASE WHEN j=1 THEN '-A' ELSE '-B' END,'SYNTHETIC',
          '10 mm · Mate · Color Azul','published',CASE WHEN i%2=0 THEN 500 ELSE 900 END,
          CASE WHEN i%2=0 THEN 1 ELSE 2 END,CASE WHEN i%2=0 THEN 'L' ELSE 'kg' END,'#123456'
        FROM seq CROSS JOIN (SELECT 1 AS j UNION ALL SELECT 2)`,
      `${sequence} INSERT INTO catalog_product_publication_policies(id,product_id,policy_id,actor_id,reason,created_at)
        SELECT printf('30000000-0000-4000-8000-%012d',i),printf('10000000-0000-4000-8000-%012d',i),
          p.policy_id,p.actor_id,'Synthetic local scale assignment only',p.created_at
        FROM seq CROSS JOIN catalog_product_publication_policies p WHERE p.product_id='${productId(0)}'`,
      `${sequence} INSERT INTO product_media_publications(id,product_id,upload_id,role,title,alt,language,version,
        valid_from,valid_until,scan_receipt_id,rights_decision_id,actor_id,created_at,idempotency_key,payload_hash)
        SELECT printf('40000000-0000-4000-8000-%012d',i),printf('10000000-0000-4000-8000-%012d',i),
          m.upload_id,m.role,m.title,m.alt,m.language,m.version,m.valid_from,m.valid_until,
          m.scan_receipt_id,m.rights_decision_id,m.actor_id,m.created_at,'synthetic-scale-'||i,m.payload_hash
        FROM seq CROSS JOIN product_media_publications m WHERE m.product_id='${productId(0)}' AND m.role='main'`
    ].map((sql) => database.prepare(sql))
  )
  async function catalog(query = '') {
    phase = 'public_query:' + query
    const start = performance.now()
    const response = await runtime!.dispatchFetch(`${origin}/api/products?facets=1&limit=20&sort=name${query}`)
    const text = await response.text(),
      elapsedMs = Math.ceil(performance.now() - start),
      responseBytes = new TextEncoder().encode(text).byteLength
    requests.push({ query, elapsedMs, responseBytes })
    assert.equal(response.status, 200)
    assert(responseBytes < 65536, 'Aggregate response exceeds the local 64 KiB evidence budget')
    assert(elapsedMs <= 30_000, 'Local public query exceeds the conservative 30s whole-request budget')
    const result = JSON.parse(text) as ProductListResponse
    assert(result.items.length <= 20)
    assert(result.facets)
    console.log(JSON.stringify({ phase, total: result.total, elapsedMs, responseBytes }))
    return result
  }
  const baseline = await catalog()
  assert.equal(baseline.total, count)
  assert.deepEqual(baseline.facets!.brands, [
    { value: 'Synthetic A', n: 750 },
    { value: 'Synthetic B', n: 750 }
  ])
  assert.deepEqual(baseline.facets!.badges, [{ value: 'Synthetic', n: count * 2 }])
  assert.deepEqual(baseline.facets!.capacidades, [
    { value: '1-L', units: 1, label: 'L', n: 750 },
    { value: '2-kg', units: 2, label: 'kg', n: 750 }
  ])
  assert.deepEqual(baseline.facets!.colores, [{ value: 'Azul', hex: '#123456', n: count }])
  assert.deepEqual(baseline.facets!.medidas, [{ value: '10 mm', n: count }])
  assert.deepEqual(baseline.facets!.acabados, [{ value: 'Mate', n: count }])
  const brand = await catalog('&brand=Synthetic%20A')
  assert.equal(brand.total, 750)
  assert.deepEqual(brand.facets!.brands, baseline.facets!.brands)
  assert.deepEqual(brand.facets!.capacidades, [{ value: '1-L', units: 1, label: 'L', n: 750 }])
  const crossed = await catalog('&brand=Synthetic%20A&capacidad=2-kg')
  assert.equal(crossed.total, 0)
  assert.deepEqual(crossed.facets!.brands, [{ value: 'Synthetic B', n: 750 }])
  assert.deepEqual(crossed.facets!.capacidades, [{ value: '1-L', units: 1, label: 'L', n: 750 }])
  const sku = await catalog('&q=SYNTHETIC-SCALE-1499-A')
  assert.equal(sku.total, 1)
  assert.equal(sku.items[0]!.uuid, productId(1499))
  phase = 'withdraw_off_page_product'
  await database.prepare("UPDATE products SET status='hidden' WHERE id=?").bind(productId(1499)).run()
  const withdrawn = await catalog()
  assert.equal(withdrawn.total, count - 1)
  assert.deepEqual(withdrawn.facets!.brands, [
    { value: 'Synthetic A', n: 750 },
    { value: 'Synthetic B', n: 749 }
  ])
  assert.equal(withdrawn.facets!.colores[0]!.n, count - 1)
  // One product now has distinct (1,L) and (2,kg) variants: the crossed pairs
  // (1,kg) and (2,L) must never match by combining two different variants.
  phase = 'mixed_variant_capacity_fixture'
  await database
    .prepare("UPDATE variants SET content_quantity=2,unit_label='kg' WHERE id='20000000-0000-4000-8000-000000000002'")
    .run()
  for (const [capacity, expected] of [
    ['1-L', 1],
    ['2-kg', 1],
    ['1-kg', 0],
    ['2-L', 0]
  ] as const)
    assert.equal((await catalog('&q=SYNTHETIC-SCALE-0-A&capacidad=' + capacity)).total, expected)

  // Race actual public HTTP against a separate D1 writer. Both legal states
  // differ in total, first-page ordering, price range and facet counts. A
  // response may observe either whole snapshot, never a mixture. These are
  // local emulator contenders, not hosted-load/production concurrency proof.
  const mutateSnapshot = (changed: boolean) =>
    database.batch([
      database
        .prepare('UPDATE products SET name=? WHERE id=?')
        .bind(changed ? 'ZZZ changed in concurrent audit' : 'Synthetic scale 0000', productId(0)),
      database
        .prepare('UPDATE variants SET price_gross_cents=? WHERE product_id=?')
        .bind(changed ? 123456 : 500, productId(0)),
      database
        .prepare('UPDATE products SET status=? WHERE id=?')
        .bind(changed ? 'hidden' : 'published', productId(count - 2))
    ])
  const snapshotBefore = await catalog()
  await mutateSnapshot(true)
  const snapshotAfter = await catalog()
  assert.notEqual(snapshotBefore.total, snapshotAfter.total)
  assert.notDeepEqual(snapshotBefore.items, snapshotAfter.items)
  assert.notDeepEqual(snapshotBefore.facets, snapshotAfter.facets)
  const concurrentSnapshots: string[] = []
  for (const changed of [true, false, true, false]) {
    await mutateSnapshot(!changed)
    const [response] = await Promise.all([catalog(), mutateSnapshot(changed)])
    const observed = isDeepStrictEqual(response, snapshotBefore)
      ? 'before'
      : isDeepStrictEqual(response, snapshotAfter)
        ? 'after'
        : 'mixed'
    assert.notEqual(observed, 'mixed', 'Concurrent public response mixes committed snapshots')
    concurrentSnapshots.push(observed)
    assert.deepEqual(await catalog(), changed ? snapshotAfter : snapshotBefore)
  }
  await mutateSnapshot(false)
  assert.deepEqual(await catalog(), snapshotBefore)
  assert.equal(outbound, 0)
  console.log(
    JSON.stringify({
      status: 'local_public_scale_passed',
      runtime: 'actual bundled Worker with local Miniflare/workerd D1',
      products: count,
      variants: count * 2,
      migrations: migrations.length,
      duplicateVariantCountsDeduplicated: true,
      duplicateBadgeOccurrencesPreserved: true,
      selfExclusionAxesVerified: ['brand', 'capacidad'],
      capacityPairsVerified: true,
      offPageWithdrawalVerified: true,
      localConcurrentResponseSnapshotsVerified: true,
      concurrentSnapshots,
      requests,
      outbound,
      bundleSha256,
      syntheticPublicationEvidenceOnly: true,
      r2BytesOrProviderAcceptance: false,
      concurrentWholeResponseSnapshotAccepted: false,
      cloudLimitsAccepted: false,
      deployedAcceptance: false
    })
  )
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', phase, error: error instanceof Error ? error.message : 'unknown' }))
  process.exitCode = 1
} finally {
  let disposed = false
  try {
    await runtime?.dispose()
    disposed = true
  } catch {
    process.exitCode = 1
    console.error(JSON.stringify({ cleanup: 'runtime disposal failed; owned directory retained' }))
  }
  if (disposed) {
    if (directory) {
      assert(directory.startsWith(join(tmpdir(), 'neteco-public-facets-scale-owned-')))
      await rm(directory, { recursive: true })
    }
    console.log(
      JSON.stringify({
        cleanup: 'disposed owned runtime and ephemeral D1 directory',
        freeBytesBefore: freeBefore,
        freeBytesAfter: await free(),
        elapsedMs: Math.ceil(performance.now() - started)
      })
    )
  }
}
