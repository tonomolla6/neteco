import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { chromium, type Browser } from '@playwright/test'
import { convertV4MiniflareOptions, Miniflare, NoOpLog } from 'miniflare'
import { DEMO_IDENTITIES, DEMO_ORIGIN } from '../shared/demo-access'
import { issueD1SessionCookie } from '../workers/auth/session-cookie'
import { splitDemoSql as splitSqlQuery } from './lib/d1-demo-sql'
import { provisionDemoDataset } from './lib/demo-dataset'

/** Existing compiled Worker/Nuxt only. The demo hostname is a virtual browser
 * origin: EVERY request is forwarded to disposable workerd, never DNS/HTTPS.
 * No build, deployment, provider or remote binding. Output contains only the
 * public operational clock node, timezone and local byte counters.
 */
let runtime: Miniflare | undefined, browser: Browser | undefined, temporary: string | undefined
let outbound = 0,
  browserExternal = 0,
  temporaryBytes = 0
let stage = 'temporary_fixture'
const proof: Array<{ timezone: string; selector: string; server: string; client: string; hydrationErrors: number }> = []
const diagnostics: Array<{ timezone: string; category: string; path: string }> = []
const expectClean = process.argv.includes('--expect-clean')
async function bytes(path: string): Promise<number> {
  const information = await stat(path)
  if (!information.isDirectory()) return information.size
  const values = await Promise.all((await readdir(path)).map((name) => bytes(join(path, name))))
  return values.reduce((total, value) => total + value, 0)
}
function deadline<T>(promise: Promise<T>, milliseconds = 15000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(Error('local_hydration_timeout')), milliseconds)
    })
  ]).finally(() => clearTimeout(timer))
}
try {
  temporary = await mkdtemp(join(tmpdir(), 'neteco-hydration-local-'))
  const options: Parameters<typeof convertV4MiniflareOptions>[0] = {
    name: 'neteco-hydration-local',
    rootPath: process.cwd(),
    scriptPath: resolve('.wrangler/shop-bundle/shop.js'),
    modules: true,
    compatibilityDate: '2026-08-15',
    compatibilityFlags: ['nodejs_compat'],
    log: new NoOpLog(),
    resourcePersistencePath: temporary,
    resourceTmpPath: join(temporary, 'runtime-tmp'),
    cf: false,
    telemetry: { enabled: false },
    bindings: {
      APP_ENV: 'preview',
      DEMO_ENABLED: 'true',
      AUTH_ENABLED: 'true',
      AUTH_ORIGIN: DEMO_ORIGIN,
      NUXT_PUBLIC_BASE_URL: DEMO_ORIGIN,
      NUXT_PUBLIC_DEMO_ENABLED: 'true',
      NUXT_PUBLIC_APP_ENV: 'preview',
      NUXT_SESSION_PASSWORD: randomBytes(48).toString('base64url'),
      AUTH_RATE_LIMIT_PEPPER: randomBytes(48).toString('hex'),
      AUTH_TOKEN_PEPPER: randomBytes(48).toString('hex'),
      AUTH_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      MEDIA_PUBLIC_ENABLED: 'true',
      MEDIA_ADMIN_ENABLED: 'true',
      MEDIA_ADMIN_ORIGIN: DEMO_ORIGIN,
      CMS_PUBLICATION_ENABLED: 'true',
      CMS_PREVIEW_ENABLED: 'true',
      CMS_PREVIEW_SECRET: randomBytes(48).toString('hex'),
      SUPPORT_ENABLED: 'false',
      AUTH_EMAIL_ENABLED: 'false',
      NEWSLETTER_EDITORIAL_ENABLED: 'false',
      ANALYTICS_ENABLED: 'false',
      ANALYTICS_PROJECTION_ENABLED: 'false',
      ANALYTICS_RETENTION_ENABLED: 'false',
      ANALYTICS_POLICY: 'null',
      FISCAL_ISSUANCE_ENABLED: 'false',
      REFUNDS_ENABLED: 'false',
      CREDIT_DISPATCH_ENABLED: 'false',
      PAYMENT_ENABLED: 'false',
      BEPLY_ENABLED: 'false'
    },
    d1Databases: { DB: '00000000-0000-0000-0000-000000000053' },
    kvNamespaces: { CACHE: 'local-hydration-cache' },
    r2Buckets: { MEDIA: 'local-hydration-media' },
    images: { binding: 'IMAGES' },
    durableObjects: {
      COORDINATOR: { className: 'CanaryCoordinator', useSQLite: true },
      INVENTORY: { className: 'InventoryCoordinator', useSQLite: true },
      CARTS: { className: 'CartCoordinator', useSQLite: true }
    },
    ratelimits: {
      AUTH_EDGE_LIMIT: { namespace_id: '990053', simple: { limit: 10000, period: 60 } },
      ADMIN_EDGE_LIMIT: { namespace_id: '990054', simple: { limit: 10000, period: 60 } },
      CART_EDGE_LIMIT: { namespace_id: '990055', simple: { limit: 10000, period: 60 } }
    },
    assets: {
      directory: resolve('.output-cloudflare/public'),
      binding: 'ASSETS',
      run_worker_first: true,
      routerConfig: { has_user_worker: true },
      assetConfig: { html_handling: 'none', not_found_handling: 'none' }
    },
    outboundService: () => {
      outbound++
      return new Response(null, { status: 503 })
    }
  }
  runtime = new Miniflare(convertV4MiniflareOptions(options))
  stage = 'workerd_ready'
  await deadline(runtime.ready)
  const { DB, MEDIA } = await runtime.getBindings<{ DB: D1Database; MEDIA: R2Bucket }>()
  stage = 'all_existing_migrations'
  for (const name of (await readdir('db/d1/migrations')).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort()) {
    const statements = splitSqlQuery(await readFile(join('db/d1/migrations', name), 'utf8')).filter(
      (query) => !/^\s*(?:BEGIN(?:\s+TRANSACTION)?|COMMIT)\s*;?\s*$/i.test(query)
    )
    for (let start = 0; start < statements.length; start += 75) {
      const result = await DB.batch(statements.slice(start, start + 75).map((query) => DB.prepare(query)))
      assert(result.every((value) => value.success))
    }
  }
  stage = 'existing_demo_dataset'
  // Native D1 exec is line-oriented; the existing offline renderers contain
  // multiline statements. Preserve SQL exactly using Wrangler's maintained
  // compatibility splitter and actual atomic D1 batches, as the fixture adapter does.
  const seedDatabase = new Proxy(DB, {
    get(target, property) {
      if (property === 'exec')
        return async (sql: string) => {
          const queries = splitSqlQuery(sql),
            results: D1Result[] = []
          for (let offset = 0; offset < queries.length; offset += 75)
            results.push(
              ...(await target.batch(queries.slice(offset, offset + 75).map((query) => target.prepare(query))))
            )
          assert(results.every((result) => result.success))
          return { count: results.length, duration: results.reduce((total, result) => total + result.meta.duration, 0) }
        }
      const value: unknown = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
  await provisionDemoDataset(seedDatabase, MEDIA, new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'))
  stage = 'sealed_local_admin_fixture'
  // This is a disposable authenticated rendering fixture, NOT a login test.
  // Use the existing native issuer against real D1 session/role authority,
  // never cached claims. This fixture isolates the authenticated SSR page.
  const sessionId = crypto.randomUUID()
  await DB.prepare(
    `INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at,last_seen_at)
    SELECT ?1,id,session_version,1,strftime('%Y-%m-%dT%H:%M:%SZ','now'),
      strftime('%Y-%m-%dT%H:%M:%SZ','now','+15 minutes'),strftime('%Y-%m-%dT%H:%M:%SZ','now')
    FROM identities WHERE id=?2 AND status='active'`
  )
    .bind(sessionId, DEMO_IDENTITIES.admin.identityId)
    .run()
  const sealed = await issueD1SessionCookie(
    DB,
    { sessionId, identityId: DEMO_IDENTITIES.admin.identityId, sessionVersion: 1 },
    { password: String(options.bindings!.NUXT_SESSION_PASSWORD), maxAgeSeconds: 900 }
  )
  assert(sealed)
  const cookie = /^neteco-session=([^;\r\n]+)/.exec(sealed)
  assert(cookie)
  stage = 'local_chrome_start'
  browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome',
    headless: true,
    args: ['--no-sandbox', '--no-proxy-server', '--disable-background-networking'],
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }
  })
  for (const timezone of ['UTC', 'Europe/Madrid']) {
    stage = 'ssr_snapshot_' + timezone
    const context = await browser.newContext({ timezoneId: timezone, locale: 'es-ES', serviceWorkers: 'block' })
    let release!: () => void
    const scripts = new Promise<void>((resolve) => {
      release = resolve
    })
    let hydrationErrors = 0
    try {
      await context.addCookies([
        { name: 'neteco-session', value: cookie[1]!, url: DEMO_ORIGIN, httpOnly: true, secure: true, sameSite: 'Lax' }
      ])
      await context.route('**/*', async (route) => {
        const request = route.request(),
          target = new URL(request.url())
        if (target.origin !== DEMO_ORIGIN) {
          browserExternal++
          await route.abort()
          return
        }
        if (target.pathname.endsWith('.js')) await scripts
        const headers = await request.allHeaders()
        headers['cf-connecting-ip'] = '192.0.2.53'
        headers['accept-encoding'] = 'identity'
        const raw = request.postDataBuffer()
        const response = await runtime!.dispatchFetch(target.href, {
          method: request.method(),
          headers,
          ...(raw ? { body: new Uint8Array(raw) } : {})
        })
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
      page.setDefaultTimeout(15000)
      page.on('console', (message) => {
        if (message.type() === 'error' && /hydration|mismatch/i.test(message.text())) hydrationErrors++
        if (message.type() === 'error') {
          const location = message.location().url
          diagnostics.push({
            timezone,
            category: /hydration|mismatch/i.test(message.text())
              ? 'hydration'
              : /content security|violates.*policy|refused to/i.test(message.text())
                ? 'csp'
                : 'console_error',
            path: location ? new URL(location, DEMO_ORIGIN).pathname : '/'
          })
        }
      })
      page.on('pageerror', () => diagnostics.push({ timezone, category: 'page_error', path: '/admin' }))
      page.on('response', (response) => {
        if (response.status() >= 400)
          diagnostics.push({ timezone, category: 'http_' + response.status(), path: new URL(response.url()).pathname })
      })
      await page.goto(DEMO_ORIGIN + '/admin', { waitUntil: 'commit' })
      await page.waitForFunction(() => document.readyState !== 'loading')
      const clock = page.locator('p').filter({ hasText: 'Comprobado a las' })
      assert.equal(await clock.count(), 1)
      const server = (await clock.textContent())!.replace(/\s+/g, ' ').trim()
      release()
      stage = 'client_hydration_' + timezone
      await page.waitForLoadState('networkidle')
      assert.equal(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone), timezone)
      await page.waitForFunction(() => {
        const use: unknown = Reflect.get(window, 'useNuxtApp')
        if (typeof use !== 'function') return false
        try {
          const app: unknown = use()
          return app !== null && typeof app === 'object' && Reflect.get(app, 'isHydrating') === false
        } catch {
          return false
        }
      })
      const publicFlags = await page.evaluate(() => {
        const use: unknown = Reflect.get(window, 'useNuxtApp')
        if (typeof use !== 'function') return false
        const app: unknown = use()
        if (app === null || typeof app !== 'object') return false
        const config: unknown = Reflect.get(app, '$config')
        if (config === null || typeof config !== 'object') return false
        const publicConfig: unknown = Reflect.get(config, 'public')
        return (
          publicConfig !== null &&
          typeof publicConfig === 'object' &&
          Reflect.get(publicConfig, 'serverRuntime') === 'cloudflare' &&
          Reflect.get(publicConfig, 'demoEnabled') === true
        )
      })
      assert.equal(publicFlags, true)
      const client = (await clock.textContent())!.replace(/\s+/g, ' ').trim()
      proof.push({ timezone, selector: 'section[Excepciones] > div > p', server, client, hydrationErrors })
    } finally {
      release()
      await deadline(context.close(), 3000)
    }
  }
  assert.equal(outbound, 0)
  assert.equal(browserExternal, 0)
  assert.equal(proof.length, 2)
  if (expectClean) {
    assert(proof.every((result) => result.server === result.client && result.hydrationErrors === 0))
    assert.equal(diagnostics.length, 0)
  }
  console.log(
    JSON.stringify({
      audit: 'demo_hydration_local',
      status: expectClean ? 'verified' : 'diagnosed',
      proof,
      diagnostics,
      clientHydrated: true,
      publicRuntimeVerified: true,
      outbound,
      browserExternal,
      compiledBuildReused: true,
      remoteNetwork: false
    })
  )
} catch (failure) {
  console.error(
    JSON.stringify({
      audit: 'demo_hydration_local',
      status: 'failed',
      stage,
      errorClass: failure instanceof Error ? failure.name : 'unknown_local_error',
      sourceLine:
        failure instanceof Error
          ? Number(/audit-demo-hydration-local\.ts:(\d+):/.exec(failure.stack ?? '')?.[1] ?? 0)
          : 0,
      proof,
      diagnostics,
      outbound,
      browserExternal,
      remoteNetwork: false
    })
  )
  process.exitCode = 1
} finally {
  if (browser)
    await deadline(browser.close(), 3000).catch(() => {
      process.exitCode = 1
    })
  if (runtime)
    await deadline(runtime.dispose(), 3000).catch(() => {
      process.exitCode = 1
    })
  if (temporary) {
    temporaryBytes = await bytes(temporary)
    assert.equal(dirname(temporary), tmpdir())
    assert(basename(temporary).startsWith('neteco-hydration-local-'))
    await rm(temporary, { recursive: true })
  }
  console.log(
    JSON.stringify({
      audit: 'demo_hydration_local_cleanup',
      temporaryBytesRemoved: temporaryBytes,
      temporaryBytesRemaining: 0,
      originalArtifactsPreserved: true
    })
  )
}
