import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Miniflare, convertV4MiniflareOptions, NoOpLog } from 'miniflare'
import { splitDemoSql } from '../../scripts/lib/d1-demo-sql'
import { deterministicTestData } from '../fixtures/deterministic'

/** Current immutable compiled Worker + actual Nitro/assets, never a source
 * bundle or renderer double. Each caller owns one disposable all-90 database.
 * No Queue consumer is installed: this fixture exercises HTTP and its real DOs.
 */
export async function createCompiledShopFixture(overrides: Record<string, string> = {}) {
  const data = deterministicTestData('compiled-shop-fixture')
  const origin = 'https://shop-audit.neteco.test'
  const scriptPath = resolve('.wrangler/shop-bundle/shop.js')
  const assetsDirectory = resolve('.output-cloudflare/public')
  await Promise.all([access(scriptPath), access(assetsDirectory)])
  const migrations = (await readdir('db/d1/migrations')).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort()
  if (migrations.length !== 155 || migrations.some((file, index) => Number(file.slice(0, 4)) !== index + 1))
    throw new Error('Compiled-shop fixture requires exactly migrations 0001 through 0155')

  const bindings = Object.freeze({
    APP_ENV: 'local',
    AUTH_ENABLED: 'true',
    AUTH_EMAIL_ENABLED: 'false',
    AUTH_TOKEN_PEPPER: data.token('token-pepper'),
    AUTH_RATE_LIMIT_PEPPER: data.token('rate-limit-pepper'),
    AUTH_ENCRYPTION_KEY: Buffer.from(data.token('encryption-key'), 'hex').toString('base64'),
    NUXT_SESSION_PASSWORD: data.token('session-password'),
    CMS_PUBLICATION_ENABLED: 'true',
    CMS_PREVIEW_ENABLED: 'false',
    MEDIA_PUBLIC_ENABLED: 'true',
    MEDIA_ADMIN_ENABLED: 'false',
    ANALYTICS_ENABLED: 'false',
    ANALYTICS_PROJECTION_ENABLED: 'false',
    ANALYTICS_RETENTION_ENABLED: 'false',
    NEWSLETTER_ENABLED: 'false',
    NEWSLETTER_EDITORIAL_ENABLED: 'false',
    NEWSLETTER_CAMPAIGN_DELIVERY_ENABLED: 'false',
    PRODUCT_WATCH_ENABLED: 'false',
    CART_RECOVERY_ENABLED: 'false',
    TRANSACTIONAL_EMAIL_ENABLED: 'false',
    INVOICE_EMAIL_ENABLED: 'false',
    FISCAL_ISSUANCE_ENABLED: 'false',
    REFUND_DISPATCH_ENABLED: 'false',
    CREDIT_DISPATCH_ENABLED: 'false',
    BEPLY_ENABLED: 'false',
    REDSYS_ENABLED: 'false',
    FREE_SHIPPING_THRESHOLD_CENTS: '15000',
    ...overrides,
    // Every request and all generated public URLs stay on this private origin.
    AUTH_ORIGIN: origin,
    PUBLIC_SITE_ORIGIN: origin,
    NUXT_PUBLIC_BASE_URL: origin
  })
  const directory = await mkdtemp(join(tmpdir(), 'neteco-compiled-shop-test-'))
  const outbound = { requests: 0 }
  let runtime: Miniflare | undefined
  let disposed = false
  async function dispose() {
    if (disposed) return
    disposed = true
    try {
      await runtime?.dispose()
    } finally {
      // Only this exact mkdtemp-owned persistence directory is removed.
      await rm(directory, { recursive: true, force: true })
    }
  }
  try {
    runtime = new Miniflare(
      convertV4MiniflareOptions({
        name: 'neteco-compiled-shop-test',
        rootPath: process.cwd(),
        scriptPath,
        modules: true,
        compatibilityDate: '2026-08-15',
        compatibilityFlags: ['nodejs_compat'],
        resourcePersistencePath: directory,
        resourceTmpPath: join(directory, 'runtime-tmp'),
        cf: false,
        telemetry: { enabled: false },
        log: new NoOpLog(),
        bindings,
        d1Databases: { DB: data.uuid('database') },
        kvNamespaces: { CACHE: 'compiled-shop-cache' },
        r2Buckets: { MEDIA: 'compiled-shop-media' },
        images: { binding: 'IMAGES' },
        queueProducers: { ASYNC_JOBS: 'compiled-shop-jobs' },
        durableObjects: {
          COORDINATOR: { className: 'CanaryCoordinator', useSQLite: true },
          INVENTORY: { className: 'InventoryCoordinator', useSQLite: true },
          CARTS: { className: 'CartCoordinator', useSQLite: true }
        },
        workflows: { CATALOG_WORKFLOW: { className: 'CanaryWorkflow', name: 'compiled-shop-catalog' } },
        ratelimits: {
          AUTH_EDGE_LIMIT: { namespace_id: '991001', simple: { limit: 100, period: 60 } },
          ADMIN_EDGE_LIMIT: { namespace_id: '991002', simple: { limit: 100, period: 60 } },
          CART_EDGE_LIMIT: { namespace_id: '991003', simple: { limit: 100, period: 60 } },
          ANALYTICS_EDGE_LIMIT: { namespace_id: '991004', simple: { limit: 100, period: 60 } }
        },
        assets: {
          directory: assetsDirectory,
          binding: 'ASSETS',
          run_worker_first: true,
          routerConfig: { has_user_worker: true },
          assetConfig: { html_handling: 'none', not_found_handling: 'none' }
        },
        outboundService: () => {
          outbound.requests++
          return new Response('External network is disabled in compiled-shop tests', { status: 503 })
        }
      })
    )
    await runtime.ready
    const database = (await runtime.getD1Database('DB')) as unknown as D1Database
    for (const file of migrations) {
      const statements = splitDemoSql(await readFile(join('db/d1/migrations', file), 'utf8'))
      await database.batch(statements.map((sql) => database.prepare(sql)))
    }
    const readyRuntime = runtime
    const fixture = {
      runtime: readyRuntime,
      database,
      origin,
      bindings,
      sessionCookieConfiguration: { password: bindings.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 },
      tokenPepper: bindings.AUTH_TOKEN_PEPPER,
      outbound,
      async dispatch(input: string | Request, init?: RequestInit): Promise<Response> {
        const url = new URL(typeof input === 'string' ? input : input.url, origin)
        if (url.origin !== origin) throw new Error('Compiled-shop dispatch is private-origin only')
        const request = new Request(typeof input === 'string' ? url.href : input, init)
        const headers = new Headers(request.headers)
        // Same ingress shim as the actual auditor: Undici rewrites Fetch-Mode.
        // A supplied MF override never becomes authority for browser metadata.
        headers.delete('MF-Sec-Fetch-Mode')
        const fetchMode = headers.get('sec-fetch-mode')
        if (fetchMode !== null) headers.set('MF-Sec-Fetch-Mode', fetchMode)
        if (!headers.has('cf-connecting-ip')) headers.set('cf-connecting-ip', '192.0.2.123')
        return (await readyRuntime.dispatchFetch(request.url, {
          method: request.method,
          headers: Object.fromEntries(headers),
          body: request.body ? new Uint8Array(await request.arrayBuffer()) : undefined,
          redirect: 'manual'
        })) as unknown as Response
      },
      dispose
    }
    return {
      ...fixture,
      readServerClock(): Promise<(offsetMs?: number) => string> {
        // Each explicit call creates one empty synthetic cart to obtain a
        // fresh compiled-Worker clock anchor. That anchor never advances
        // implicitly; no lines, reservations, order or economic effects arise.
        return (async () => {
          const response = await fixture.dispatch('/api/cart')
          if (response.status !== 200) throw new Error('Compiled Worker clock cart read failed')
          const cart = (await response.json()) as { id?: unknown }
          if (typeof cart.id !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(cart.id))
            throw new Error('Compiled Worker clock cart identity is invalid')
          const row = await database
            .prepare('SELECT created_at FROM carts WHERE id=?')
            .bind(cart.id)
            .first<{ created_at: string }>()
          if (
            !row ||
            typeof row.created_at !== 'string' ||
            !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(row.created_at)
          )
            throw new Error('Compiled Worker clock source is invalid')
          const instant = Date.parse(row.created_at)
          if (!Number.isFinite(instant)) throw new Error('Compiled Worker clock source is invalid')
          return (offsetMs = 0) => {
            if (!Number.isSafeInteger(offsetMs)) throw new Error('Compiled Worker clock offset is invalid')
            return new Date(instant + offsetMs).toISOString().replace(/\.\d{3}Z$/, 'Z')
          }
        })()
      }
    }
  } catch (error) {
    await dispose()
    throw error
  }
}
