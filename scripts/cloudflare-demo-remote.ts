import { readFile, readdir } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
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
const operation = process.argv[2]
if (!['migrate', 'seed', 'catalog', 'catalog-prices', 'secrets', 'deploy', 'attach'].includes(operation ?? ''))
  throw new Error('explicit_demo_operation_required')
// Validate the selected ignored configuration before acquiring credentials.
const configurationPath =
  operation === 'migrate' || operation === 'seed' || operation === 'catalog' || operation === 'catalog-prices'
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
