import { readFile, readdir } from 'node:fs/promises'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getPlatformProxy } from 'wrangler'
import { splitDemoSql } from './lib/d1-demo-sql'
import { demoCredentialsPath, readDemoCredentials } from './lib/demo-credentials'
import {
  DEMO_ACCOUNT,
  DEMO_DATABASE,
  DEMO_BUCKET,
  DEMO_WORKER,
  demoProviderContractHolds,
  prepareDemoRedsysSandboxSecret
} from './generate-demo-config'
import { DEMO_ORIGIN } from '../shared/demo-access'
import {
  CATALOG_PDF_GROUPS,
  CATALOG_PDF_PARENT_CATEGORY_ID,
  CATALOG_PDF_SOURCE_VERSION,
  catalogPdfSourceSchema,
  categoryIdFor,
  planCatalogPdf,
  withLoaderSession
} from './lib/demo-catalog-pdf'
import { stableUuid } from './lib/d1-category-seed'
import { slugify } from '../server/utils/slug'
import { authorizeD1Session, type VerifiedSessionClaims } from '../workers/catalog/authorization'

const MAIN_FAMILIES = [
  { name: 'Cocina profesional', children: ['Cocción y cacerolas', 'Corte y preparación'] },
  { name: 'Mesa y buffet', children: ['Mesa y servicio', 'Termos, botellas y sifones'] },
  { name: 'Repostería y pastelería', children: ['Repostería y moldes', 'Preparación de repostería'] },
  { name: 'Equipamiento y exterior', children: ['Pequeños aparatos', 'Utensilios de barbacoa'] }
] as const
const MAIN_NEW_CHILDREN = new Set(['Preparación de repostería', 'Pequeños aparatos', 'Utensilios de barbacoa'])
const mainId = (name: string) => stableUuid(`catalog-main:category:${slugify(name)}`)
const mainPermissions = ['catalog.write', 'catalog.publish', 'administration.manage'] as const

/** Same stable product IDs as the additive PDF loader. All existing URLs are preserved. */
export function planDemoMainCatalog(input: unknown) {
  const source = catalogPdfSourceSchema.parse(input)
  const base = planCatalogPdf(source)
  const allReferences = source.productos.flatMap((product) => product.variantes.map((variant) => variant.referencia))
  if (
    new Set(allReferences).size !== allReferences.length ||
    new Set(base.products.map((p) => p.id)).size !== base.products.length
  )
    throw new Error('catalog_main_duplicate_reference')
  const roots = MAIN_FAMILIES.map((root) => ({
    id: mainId(root.name),
    name: root.name,
    slug: slugify(root.name),
    count: 0,
    children: root.children.map((name) => ({
      id: MAIN_NEW_CHILDREN.has(name) ? mainId(name) : categoryIdFor(name),
      name,
      count: 0
    }))
  }))
  const children = new Map<string, { root: (typeof roots)[number]; child: (typeof roots)[number]['children'][number] }>(
    roots.flatMap((root) => root.children.map((child) => [child.name, { root, child }] as const))
  )
  const products = base.products.map((product, index) => {
    const family = source.productos[index]!.familia
    const original = Object.entries(CATALOG_PDF_GROUPS).find(([, families]) => families.includes(family))![0]
    const target = ['Picadoras de hielo', 'Exprimidores', 'Básculas'].includes(family)
      ? 'Pequeños aparatos'
      : family === 'Utensilios de barbacoa'
        ? 'Utensilios de barbacoa'
        : ['Repostería', 'Batidores'].includes(family)
          ? 'Preparación de repostería'
          : original
    const entry = children.get(target)
    if (entry) {
      entry.root.count++
      entry.child.count++
    }
    return {
      id: product.id,
      legacyId: product.legacyId,
      slug: product.slug,
      sourceCategoryId: product.categoryId,
      categoryId: entry?.child.id ?? product.categoryId
    }
  })
  if (roots.some((root) => root.count < 15 || root.children.some((child) => child.count === 0)))
    throw new Error('catalog_main_insufficient_products')
  const creates = roots.flatMap((root) => [
    { id: root.id, name: root.name, slug: root.slug, parentId: null as string | null },
    ...root.children
      .filter((child) => MAIN_NEW_CHILDREN.has(child.name))
      .map((child) => ({ id: child.id, name: child.name, slug: slugify(child.name), parentId: root.id }))
  ])
  const reparents = roots.flatMap((root) =>
    root.children
      .filter((child) => !MAIN_NEW_CHILDREN.has(child.name))
      .map((child) => ({
        id: child.id,
        name: child.name,
        slug: slugify(child.name),
        sourceParentId: CATALOG_PDF_PARENT_CATEGORY_ID,
        parentId: root.id
      }))
  )
  return {
    roots,
    creates,
    reparents,
    products,
    moves: products.filter((product) => product.categoryId !== product.sourceCategoryId)
  }
}

export class DemoCatalogMainError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

// Operator bootstrap only, under the CLI's fixed demo account/database contract. No public route.
// This changes taxonomy only: existing publication, media, price and inventory authorities remain intact.
const mainSchema = `
CREATE TABLE IF NOT EXISTS demo_catalog_main_runs (
 command_id TEXT PRIMARY KEY CHECK(length(command_id)=36),
 actor_id TEXT NOT NULL REFERENCES identities(id),
 idempotency_key TEXT NOT NULL UNIQUE CHECK(length(idempotency_key) BETWEEN 1 AND 200),
 payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
 summary TEXT NOT NULL CHECK(json_valid(summary) AND json_type(summary)='object'),
 created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),''))
) STRICT;
CREATE TABLE IF NOT EXISTS demo_catalog_main_changes (
 command_id TEXT NOT NULL REFERENCES demo_catalog_main_runs(command_id),
 entity_type TEXT NOT NULL CHECK(entity_type IN ('category','product')),entity_id TEXT NOT NULL,
 expected_version INTEGER NOT NULL CHECK(expected_version>=0),
 result_version INTEGER NOT NULL CHECK(result_version=expected_version+1),
 before_state TEXT NOT NULL CHECK(json_valid(before_state)),
 after_state TEXT NOT NULL CHECK(json_valid(after_state) AND json_type(after_state)='object'),
 PRIMARY KEY(command_id,entity_type,entity_id)
) STRICT;
CREATE TRIGGER IF NOT EXISTS demo_catalog_main_runs_immutable_update BEFORE UPDATE ON demo_catalog_main_runs BEGIN SELECT RAISE(ABORT,'catalog_main_immutable'); END;
CREATE TRIGGER IF NOT EXISTS demo_catalog_main_runs_immutable_delete BEFORE DELETE ON demo_catalog_main_runs BEGIN SELECT RAISE(ABORT,'catalog_main_immutable'); END;
CREATE TRIGGER IF NOT EXISTS demo_catalog_main_changes_immutable_update BEFORE UPDATE ON demo_catalog_main_changes BEGIN SELECT RAISE(ABORT,'catalog_main_immutable'); END;
CREATE TRIGGER IF NOT EXISTS demo_catalog_main_changes_immutable_delete BEFORE DELETE ON demo_catalog_main_changes BEGIN SELECT RAISE(ABORT,'catalog_main_immutable'); END;
`

type MainCategoryState = {
  id: string
  legacyId: number
  parentId: string | null
  name: string
  slug: string
  status: string
  version: number
}
type MainProductState = {
  id: string
  legacyId: number
  categoryId: string
  slug: string
  status: string
  version: number
  sourceVersion: string
}
type MainSummary = {
  categoriesCreated: number
  categoriesMoved: number
  productsMoved: number
  roots: ReturnType<typeof planDemoMainCatalog>['roots']
}

/** Atomic, audited migration of the isolated demo's published taxonomy, including published products.
 * It never enters the draft/review workflow or republishes variants. Snapshot CAS and live authorization
 * are checked in the same D1 batch as every change; one receipt makes retries safe after uncertain delivery. */
export async function applyDemoMainCatalog(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  input: unknown,
  options: { now: string }
): Promise<MainSummary> {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(options.now) || !Number.isFinite(Date.parse(options.now)))
    throw new DemoCatalogMainError('invalid_input')
  if (!claims) throw new DemoCatalogMainError('unauthenticated')
  const authorize = async () => {
    for (const permission of mainPermissions) {
      const access = await authorizeD1Session(database, claims, permission, { requireMfa: true, now: options.now })
      if (!access.allowed) throw new DemoCatalogMainError(access.code)
    }
  }
  await authorize()
  const plan = planDemoMainCatalog(input)
  const hash = createHash('sha256')
    .update(JSON.stringify(catalogPdfSourceSchema.parse(input)))
    .digest('hex')
  const key = 'catalog-main-2026-v1'
  await database.batch(splitDemoSql(mainSchema).map((sql) => database.prepare(sql)))
  const replay = async () => {
    const row = await database
      .prepare('SELECT payload_hash,summary FROM demo_catalog_main_runs WHERE idempotency_key=?')
      .bind(key)
      .first<{ payload_hash: string; summary: string }>()
    if (!row) return null
    if (row.payload_hash !== hash) throw new DemoCatalogMainError('idempotency_conflict')
    return JSON.parse(row.summary) as MainSummary
  }
  const old = await replay()
  if (old) return old
  const categories = (
    await database
      .prepare(
        'SELECT id,legacy_id AS legacyId,parent_id AS parentId,name,slug,status,category_version AS version FROM categories'
      )
      .all<MainCategoryState>()
  ).results
  const aliases = (await database.prepare('SELECT slug FROM catalog_category_aliases').all<{ slug: string }>()).results
  const beforeProducts = (
    await database
      .prepare(
        `SELECT id,legacy_id AS legacyId,category_id AS categoryId,slug,status,catalog_version AS version,source_version AS sourceVersion FROM products WHERE id IN (SELECT value FROM json_each(?))`
      )
      .bind(JSON.stringify(plan.products.map((product) => product.id)))
      .all<MainProductState>()
  ).results
  const productById = new Map(beforeProducts.map((product) => [product.id, product]))
  const categoryById = new Map(categories.map((category) => [category.id, category]))
  const sourceParent = categoryById.get(CATALOG_PDF_PARENT_CATEGORY_ID)
  if (!sourceParent || sourceParent.status !== 'published' || sourceParent.parentId !== null)
    throw new DemoCatalogMainError('parent_unavailable')
  if (
    plan.creates.some(
      (category) =>
        categories.some((existing) => existing.id === category.id || existing.slug === category.slug) ||
        aliases.some((alias) => alias.slug === category.slug)
    )
  )
    throw new DemoCatalogMainError('category_identity_conflict')
  const beforeCategories = plan.reparents.map((change) => {
    const category = categoryById.get(change.id)
    if (
      !category ||
      category.name !== change.name ||
      category.slug !== change.slug ||
      category.parentId !== change.sourceParentId ||
      category.status !== 'published'
    )
      throw new DemoCatalogMainError('category_identity_conflict')
    return category
  })
  for (const product of plan.products) {
    const current = productById.get(product.id)
    if (
      !current ||
      current.legacyId !== product.legacyId ||
      current.slug !== product.slug ||
      current.categoryId !== product.sourceCategoryId ||
      current.status !== 'published' ||
      current.sourceVersion !== CATALOG_PDF_SOURCE_VERSION
    )
      throw new DemoCatalogMainError('product_identity_conflict')
  }
  const maxLegacy = Math.max(999, ...categories.map((category) => category.legacyId ?? 0))
  if (!Number.isSafeInteger(maxLegacy + plan.creates.length)) throw new DemoCatalogMainError('legacy_id_exhausted')
  const newCategories: MainCategoryState[] = plan.creates.map((category, index) => ({
    ...category,
    legacyId: maxLegacy + index + 1,
    status: 'published',
    version: 1
  }))
  const afterCategories = beforeCategories.map((category) => ({
    ...category,
    parentId: plan.reparents.find((change) => change.id === category.id)!.parentId,
    version: category.version + 1
  }))
  const afterProducts = beforeProducts.map((product) => ({
    ...product,
    categoryId: plan.products.find((change) => change.id === product.id)!.categoryId,
    version: product.version + (plan.moves.some((change) => change.id === product.id) ? 1 : 0)
  }))
  const commandId = randomUUID()
  const changes = [
    ...newCategories.map((category) => ({
      type: 'category',
      id: category.id,
      expected: 0,
      result: 1,
      before: null,
      after: category
    })),
    ...afterCategories.map((category) => ({
      type: 'category',
      id: category.id,
      expected: category.version - 1,
      result: category.version,
      before: categoryById.get(category.id)!,
      after: category
    })),
    ...afterProducts
      .filter((product) => plan.moves.some((change) => change.id === product.id))
      .map((product) => ({
        type: 'product',
        id: product.id,
        expected: product.version - 1,
        result: product.version,
        before: productById.get(product.id)!,
        after: product
      }))
  ]
  const summary: MainSummary = {
    categoriesCreated: newCategories.length,
    categoriesMoved: afterCategories.length,
    productsMoved: plan.moves.length,
    roots: plan.roots
  }
  const guard = (condition: string, values: unknown[] = []) =>
    database
      .prepare(
        `INSERT INTO catalog_category_guards(id,satisfied) SELECT lower(hex(randomblob(16))),0 WHERE NOT (${condition})`
      )
      .bind(...values)
  const authCondition = `EXISTS(SELECT 1 FROM auth_sessions s JOIN identities i ON i.id=s.identity_id AND i.session_version=s.session_version
    WHERE s.id=?1 AND s.identity_id=?2 AND s.session_version=?3 AND s.revoked_at IS NULL AND s.mfa_verified=1
    AND s.created_at<=?4 AND s.expires_at>?4 AND i.status IN ('active','pending') AND i.email_verified_at<=?4
    AND (SELECT count(DISTINCT p.permission_code) FROM identity_roles r JOIN role_permissions p ON p.role_code=r.role_code
      WHERE r.identity_id=i.id AND r.granted_at<=?4 AND (r.expires_at IS NULL OR r.expires_at>?4)
      AND p.permission_code IN ('catalog.write','catalog.publish','administration.manage'))=3)`
  const authValues = [claims.sessionId, claims.identityId, claims.sessionVersion, options.now]
  const categoriesMatch = `NOT EXISTS(SELECT 1 FROM json_each(?) j LEFT JOIN categories c ON c.id=json_extract(j.value,'$.id')
    WHERE c.id IS NULL OR c.category_version<>json_extract(j.value,'$.version') OR c.slug<>json_extract(j.value,'$.slug')
    OR c.name<>json_extract(j.value,'$.name') OR c.status<>json_extract(j.value,'$.status') OR c.legacy_id<>json_extract(j.value,'$.legacyId')
    OR c.parent_id IS NOT json_extract(j.value,'$.parentId'))`
  const productsMatch = `NOT EXISTS(SELECT 1 FROM json_each(?) j LEFT JOIN products p ON p.id=json_extract(j.value,'$.id')
    WHERE p.id IS NULL OR p.catalog_version<>json_extract(j.value,'$.version') OR p.slug<>json_extract(j.value,'$.slug')
    OR p.category_id<>json_extract(j.value,'$.categoryId') OR p.status<>json_extract(j.value,'$.status') OR p.source_version<>json_extract(j.value,'$.sourceVersion'))`
  const statements = [
    guard(authCondition, authValues),
    guard('max(999,(SELECT coalesce(max(legacy_id),0) FROM categories))=?', [maxLegacy]),
    guard(categoriesMatch, [JSON.stringify([...beforeCategories, sourceParent])]),
    guard(
      `NOT EXISTS(SELECT 1 FROM catalog_category_aliases a JOIN json_each(?) j ON a.slug=json_extract(j.value,'$.slug'))`,
      [JSON.stringify(newCategories)]
    ),
    guard(productsMatch, [JSON.stringify(beforeProducts)]),
    database
      .prepare(
        'INSERT INTO demo_catalog_main_runs(command_id,actor_id,idempotency_key,payload_hash,summary,created_at) VALUES(?,?,?,?,?,?)'
      )
      .bind(commandId, claims.identityId, key, hash, JSON.stringify(summary), options.now),
    database
      .prepare(
        `INSERT INTO categories(id,legacy_id,parent_id,name,slug,status,sort_order,source_version,created_at,updated_at)
      SELECT json_extract(value,'$.id'),json_extract(value,'$.legacyId'),json_extract(value,'$.parentId'),json_extract(value,'$.name'),json_extract(value,'$.slug'),'published',CAST(key AS INTEGER)+10,?,?,? FROM json_each(?) ORDER BY CAST(key AS INTEGER)`
      )
      .bind(CATALOG_PDF_SOURCE_VERSION, options.now, options.now, JSON.stringify(newCategories)),
    database
      .prepare(
        `UPDATE categories SET parent_id=(SELECT json_extract(j.value,'$.parentId') FROM json_each(?1) j WHERE json_extract(j.value,'$.id')=categories.id),category_version=category_version+1,updated_at=?2 WHERE id IN (SELECT json_extract(value,'$.id') FROM json_each(?1))`
      )
      .bind(JSON.stringify(afterCategories), options.now),
    database
      .prepare(
        `UPDATE products SET category_id=(SELECT json_extract(j.value,'$.categoryId') FROM json_each(?1) j WHERE json_extract(j.value,'$.id')=products.id),catalog_version=catalog_version+1,updated_at=?2 WHERE id IN (SELECT json_extract(value,'$.id') FROM json_each(?1))`
      )
      .bind(
        JSON.stringify(afterProducts.filter((product) => plan.moves.some((change) => change.id === product.id))),
        options.now
      ),
    database
      .prepare(
        `INSERT INTO demo_catalog_main_changes(command_id,entity_type,entity_id,expected_version,result_version,before_state,after_state)
      SELECT ?,json_extract(value,'$.type'),json_extract(value,'$.id'),json_extract(value,'$.expected'),json_extract(value,'$.result'),coalesce(json_extract(value,'$.before'),'null'),json_extract(value,'$.after') FROM json_each(?)`
      )
      .bind(commandId, JSON.stringify(changes)),
    guard(categoriesMatch, [JSON.stringify([...newCategories, ...afterCategories])]),
    guard(productsMatch, [JSON.stringify(afterProducts)]),
    guard(authCondition, authValues)
  ]
  try {
    const result = await database.batch(statements)
    if (result.length !== statements.length || result.some((row) => !row.success))
      throw new Error('catalog_main_batch_incomplete')
    return summary
  } catch (error) {
    await authorize()
    const replayed = await replay()
    if (replayed) return replayed
    if (error instanceof Error && /constraint|guard|conflict/i.test(error.message))
      throw new DemoCatalogMainError('catalog_main_conflict')
    throw error
  }
}

export function prepareDemoSecrets(names: ReadonlySet<string>) {
  const secrets: Record<string, { name: string; type: 'secret_text'; text: string }> = {}
  for (const name of [
    'NUXT_SESSION_PASSWORD',
    'AUTH_RATE_LIMIT_PEPPER',
    'AUTH_TOKEN_PEPPER',
    'AUTH_ENCRYPTION_KEY',
    'NEWSLETTER_HMAC_KEY',
    'MEDIA_SCAN_SECRET',
    'CMS_PREVIEW_SECRET',
    'ANALYTICS_SESSION_PEPPER'
  ]) {
    if (names.has(name)) continue
    secrets[name] = {
      name,
      type: 'secret_text',
      text:
        name === 'AUTH_ENCRYPTION_KEY'
          ? randomBytes(32).toString('base64')
          : name === 'NEWSLETTER_HMAC_KEY' || name === 'ANALYTICS_SESSION_PEPPER'
            ? randomBytes(32).toString('base64url')
            : randomBytes(48).toString('hex')
    }
  }
  return secrets
}

// Explicit operators only; credentials stay in process memory and Cloudflare's store.
export async function runDemoOperation() {
  const operation = process.argv[2]
  if (
    !['migrate', 'seed', 'catalog', 'catalog-prices', 'catalog-main', 'secrets', 'deploy', 'attach'].includes(
      operation ?? ''
    )
  )
    throw new Error('explicit_demo_operation_required')
  // Validate the selected ignored configuration before acquiring credentials.
  const configurationPath =
    operation === 'migrate' ||
    operation === 'seed' ||
    operation === 'catalog' ||
    operation === 'catalog-prices' ||
    operation === 'catalog-main'
      ? '.wrangler/demo/bootstrap.json'
      : '.wrangler/demo/wrangler.json'
  const selected = JSON.parse(await readFile(configurationPath, 'utf8'))
  if (
    selected.account_id !== DEMO_ACCOUNT ||
    selected.d1_databases?.length !== 1 ||
    selected.d1_databases[0].database_id !== DEMO_DATABASE ||
    selected.d1_databases[0].binding !== 'DB' ||
    selected.r2_buckets?.length !== 1 ||
    selected.r2_buckets[0].bucket_name !== DEMO_BUCKET ||
    selected.r2_buckets[0].jurisdiction !== 'eu' ||
    selected.send_email ||
    selected.queues ||
    selected.services ||
    selected.env ||
    selected.routes?.length ||
    selected.workers_dev !== false
  )
    throw new Error('demo_isolation_contract_mismatch')
  if (
    operation !== 'migrate' &&
    operation !== 'seed' &&
    operation !== 'catalog' &&
    operation !== 'catalog-prices' &&
    operation !== 'catalog-main' &&
    (selected.name !== DEMO_WORKER ||
      selected.vars?.APP_ENV !== 'preview' ||
      selected.vars?.AUTH_ORIGIN !== DEMO_ORIGIN ||
      !demoProviderContractHolds(selected.vars))
  )
    throw new Error('demo_provider_contract_mismatch')
  const token = await readDemoCredentials(demoCredentialsPath(process.env), DEMO_ACCOUNT)
  process.env.CLOUDFLARE_ACCOUNT_ID = DEMO_ACCOUNT
  process.env.CLOUDFLARE_API_TOKEN = token
  process.env.WRANGLER_SEND_METRICS = 'false'
  const base = `/accounts/${DEMO_ACCOUNT}`
  async function api(
    path: string,
    method: string,
    body?: unknown,
    headers: Record<string, string> = {},
    binary?: Uint8Array
  ) {
    const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'content-type': binary ? 'application/octet-stream' : 'application/json',
        ...headers
      },
      body: binary ? new Blob([Uint8Array.from(binary)]) : body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000)
    })
    const payload = (await response.json()) as {
      success: boolean
      result: unknown
      errors?: Array<{ code: number; message: string }>
    }
    if (!response.ok || !payload.success) {
      // SQL/API diagnostics only: never echo bodies, headers or credentials.
      throw new Error(`demo_api_failure:${response.status}:${payload.errors?.map((error) => error.code).join('|')}`)
    }
    return payload.result
  }
  const split = splitDemoSql
  if (operation === 'migrate') {
    const proxy = await getPlatformProxy<{ DB: D1Database }>({
      configPath: '.wrangler/demo/bootstrap.json',
      persist: false,
      envFiles: [],
      remoteBindings: true
    })
    try {
      await proxy.env.DB.prepare(
        `CREATE TABLE IF NOT EXISTS d1_migrations(
      id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
    )`
      ).run()
      const applied = (await proxy.env.DB.prepare('SELECT name FROM d1_migrations').all<{ name: string }>()).results
      const names = new Set(applied.map((row) => row.name))
      for (const name of (await readdir('db/d1/migrations')).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort()) {
        if (names.has(name)) continue
        const statements: Array<{ sql: string; params?: unknown[] }> = split(
          await readFile(`db/d1/migrations/${name}`, 'utf8')
        ).map((sql) => ({ sql: sql + ';' }))
        statements.push({ sql: 'INSERT INTO d1_migrations(name) VALUES (?)', params: [name] })
        await proxy.env.DB.batch(
          statements.map((statement) =>
            proxy.env.DB.prepare(statement.sql).bind(...(('params' in statement ? statement.params : []) as unknown[]))
          )
        )
        console.log(JSON.stringify({ demoMigration: name, applied: true }))
      }
    } finally {
      await proxy.dispose()
    }
  } else if (operation === 'seed') {
    const proxy = await getPlatformProxy<{ DB: D1Database; MEDIA: R2Bucket }>({
      configPath: '.wrangler/demo/bootstrap.json',
      persist: false,
      envFiles: [],
      remoteBindings: true
    })
    try {
      const { provisionDemoDataset } = await import('./lib/demo-dataset')
      const native = proxy.env.DB
      const database = {
        prepare: (sql: string) => native.prepare(sql),
        batch: (statements: D1PreparedStatement[]) => native.batch(statements),
        exec: async (sql: string) => {
          const statements = split(sql)
          for (let i = 0; i < statements.length; i += 75)
            await native.batch(statements.slice(i, i + 75).map((sql) => native.prepare(sql)))
          return { count: statements.length, duration: 0 }
        }
      } as unknown as D1Database
      console.log(
        JSON.stringify(
          await provisionDemoDataset(database, proxy.env.MEDIA, new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'))
        )
      )
    } finally {
      await proxy.dispose()
    }
  } else if (operation === 'catalog') {
    // Additive: renews the demo seed's publication authority, then loads the PDF catalogue (no deletes/overwrites).
    const sourcePath = process.argv[3] ?? '/root/workspace/scripts/catalog-pdf/out/products.json'
    const imagesDirectory = process.argv[4] ?? '/root/workspace/scripts/catalog-pdf/import/package/clean'
    const proxy = await getPlatformProxy<{ DB: D1Database; MEDIA: R2Bucket }>({
      configPath: '.wrangler/demo/bootstrap.json',
      persist: false,
      envFiles: [],
      remoteBindings: true
    })
    try {
      const { loadCatalogPdf, renewDemoSeedAuthority } = await import('./lib/demo-catalog-pdf')
      const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
      console.log(JSON.stringify({ demoSeed: await renewDemoSeedAuthority(proxy.env.DB, { now }) }))
      const summary = await loadCatalogPdf(proxy.env.DB, proxy.env.MEDIA, {
        source: JSON.parse(await readFile(sourcePath, 'utf8')),
        readImage: async (reference) => new Uint8Array(await readFile(`${imagesDirectory}/${reference}.jpg`)),
        now
      })
      console.log(JSON.stringify({ catalogPdf: summary }))
    } finally {
      await proxy.dispose()
    }
  } else if (operation === 'catalog-main') {
    // Explicit complete source + image directory; no implicit selection or destructive reconciliation.
    const sourcePath = process.argv[3]
    const imagesDirectory = process.argv[4]
    if (!sourcePath || !imagesDirectory) throw new Error('catalog_main_source_and_images_required')
    const source = JSON.parse(await readFile(sourcePath, 'utf8'))
    planDemoMainCatalog(source)
    const proxy = await getPlatformProxy<{ DB: D1Database; MEDIA: R2Bucket }>({
      configPath: '.wrangler/demo/bootstrap.json',
      persist: false,
      envFiles: [],
      remoteBindings: true
    })
    try {
      const { loadCatalogPdf, renewDemoSeedAuthority } = await import('./lib/demo-catalog-pdf')
      const { applyCatalogPrices } = await import('./lib/demo-catalog-prices')
      const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
      await renewDemoSeedAuthority(proxy.env.DB, { now })
      const catalog = await loadCatalogPdf(proxy.env.DB, proxy.env.MEDIA, {
        source,
        now,
        readImage: async (reference) => new Uint8Array(await readFile(`${imagesDirectory}/${reference}.jpg`))
      })
      console.log(JSON.stringify({ catalogMainProgress: 'catalog_loaded' }))
      const prices = await applyCatalogPrices(proxy.env.DB, { source, now })
      console.log(JSON.stringify({ catalogMainProgress: 'prices_loaded' }))
      const taxonomy = await withLoaderSession(proxy.env.DB, now, (actor) =>
        applyDemoMainCatalog(proxy.env.DB, actor, source, { now })
      )
      console.log(JSON.stringify({ catalogMain: { catalog, prices, taxonomy } }))
    } finally {
      await proxy.dispose()
    }
  } else if (operation === 'catalog-prices') {
    // Invented DEMO prices (VAT included) and stock through the governed price/inventory commands; re-runs skip done variants.
    const sourcePath = process.argv[3] ?? '/root/workspace/scripts/catalog-pdf/out/products.json'
    const proxy = await getPlatformProxy<{ DB: D1Database }>({
      configPath: '.wrangler/demo/bootstrap.json',
      persist: false,
      envFiles: [],
      remoteBindings: true
    })
    try {
      const { applyCatalogPrices } = await import('./lib/demo-catalog-prices')
      const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
      console.log(
        JSON.stringify({
          catalogPrices: await applyCatalogPrices(proxy.env.DB, {
            source: JSON.parse(await readFile(sourcePath, 'utf8')),
            now
          })
        })
      )
    } finally {
      await proxy.dispose()
    }
  } else if (operation === 'secrets') {
    const existing = (await api(`${base}/workers/scripts/${DEMO_WORKER}/secrets`, 'GET')) as Array<{ name: string }>
    const names = new Set(existing.map((secret) => secret.name))
    const secrets = { ...prepareDemoSecrets(names), ...prepareDemoRedsysSandboxSecret(names) }
    if (Object.keys(secrets).length)
      await api(`${base}/workers/scripts/${DEMO_WORKER}/secrets-bulk`, 'PATCH', { secrets })
    console.log(JSON.stringify({ demoSecretsProvisioned: Object.keys(secrets), valuesDisclosed: false }))
  } else if (operation === 'attach') {
    const domain = (await api(`${base}/workers/domains`, 'PUT', {
      hostname: new URL(DEMO_ORIGIN).hostname,
      service: DEMO_WORKER,
      zone_id: '8b1fa2427bc55666e32199ed0ed55d03'
    })) as { hostname: string; service: string }
    console.log(JSON.stringify({ hostname: domain.hostname, worker: domain.service }))
  } else {
    const child = spawn('./node_modules/.bin/wrangler', ['deploy', '--config', '.wrangler/demo/wrangler.json'], {
      stdio: 'inherit',
      env: {
        ...process.env,
        CLOUDFLARE_ACCOUNT_ID: DEMO_ACCOUNT,
        CLOUDFLARE_API_TOKEN: token,
        CI: 'true',
        WRANGLER_SEND_METRICS: 'false'
      }
    })
    child.on('exit', (code) => process.exit(code ?? 1))
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runDemoOperation()
