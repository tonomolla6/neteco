import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import Redis from 'ioredis'
import postgres from 'postgres'
import { chromium } from 'playwright'
import { closeDatabase } from '../server/db/client'
import { encodeMerchantParameters, signMerchantParameters } from '../server/integrations/redsys'
import { createOrder, type CheckoutAddress } from '../server/services/orders'
import integrationGlobalSetup from '../tests/support/integration-global-setup'
import { isolatedPostgresDatabase } from '../tests/fixtures/postgres'
import { REDSYS_OFFICIAL_CONTRACT } from '../tests/fixtures/redsys-official'
import { connectRemoteTestBrowser } from './lib/remote-test-browser'
import {
  assertLoadBudget,
  compressedAssetBytes,
  initialAssetUrls,
  percentile,
  performanceObserverDatabaseOptions,
  readPerformanceBudgets,
  runBoundedLoad,
  type LoadProfile
} from './lib/performance'

const reportPath = resolve('test-results/performance.json')
const allowedDatabaseNames = /^(neteco|neteco_test|neteco_it_[a-z0-9_]+)$/

declare global {
  interface Window {
    __netecoPerformance?: {
      lcpMs: number
      lcpUrl: string
      cls: number
      inpMs: number
      interactions: number
    }
  }
}

interface CheckResult {
  name: string
  status: 'passed' | 'failed'
  metrics?: unknown
  error?: string
}

function assertSafeTestTarget(connection: string) {
  if (process.env.APP_ENV !== 'test') throw new Error('Performance tests require APP_ENV=test')
  const url = new URL(connection)
  if (!['127.0.0.1', '::1', 'localhost'].includes(url.hostname)) {
    throw new Error('Performance tests are restricted to loopback PostgreSQL')
  }
  if (!allowedDatabaseNames.test(url.pathname.slice(1)))
    throw new Error('Performance tests require an approved test DB')
}

async function availablePort() {
  const server = createServer()
  await new Promise<void>((resolveReady, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveReady)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not allocate a loopback port')
  await new Promise<void>((resolveClose, reject) => server.close((error) => (error ? reject(error) : resolveClose())))
  return address.port
}

function child(
  command: string,
  arguments_: string[],
  environment: NodeJS.ProcessEnv,
  stdio: 'ignore' | 'inherit' = 'ignore'
) {
  return spawn(command, arguments_, { cwd: process.cwd(), env: environment, stdio })
}

function waitForExit(process: ChildProcess, timeoutMs: number) {
  return new Promise<number>((resolveExit, reject) => {
    const timer = setTimeout(() => reject(new Error(`Child process exceeded ${timeoutMs} ms`)), timeoutMs)
    process.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    process.once('exit', (code, signal) => {
      clearTimeout(timer)
      if (signal) reject(new Error(`Child process terminated by ${signal}`))
      else resolveExit(code ?? 1)
    })
  })
}

async function stopChild(process: ChildProcess | undefined) {
  if (!process || process.exitCode !== null) return
  process.kill('SIGTERM')
  await Promise.race([
    new Promise<void>((resolveExit) => process.once('exit', () => resolveExit())),
    delay(2_000).then(() => {
      if (process.exitCode === null) process.kill('SIGKILL')
    })
  ])
}

function fetchWithTimeout(input: string | URL, init: RequestInit = {}) {
  return fetch(input, { ...init, signal: init.signal ?? AbortSignal.timeout(5_000) })
}

async function waitForReady(baseUrl: string, process: ChildProcess) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (process.exitCode !== null) throw new Error(`Preview server exited with ${process.exitCode}`)
    try {
      if ((await fetchWithTimeout(`${baseUrl}/api/health/live`)).ok) return
    } catch {
      // The listener is not ready yet.
    }
    await delay(100)
  }
  throw new Error('Preview server did not become ready')
}

function signedCallback(order: string, amountCents: number) {
  const contract = REDSYS_OFFICIAL_CONTRACT.sandbox
  const merchantParameters = encodeMerchantParameters({
    Ds_Order: order,
    Ds_Amount: String(amountCents),
    Ds_Currency: contract.currency,
    Ds_MerchantCode: contract.merchantCode,
    Ds_Terminal: contract.terminal,
    Ds_TransactionType: '0',
    Ds_Response: '0000',
    Ds_AuthorisationCode: 'PERF01',
    Ds_Date: '13/08/2026',
    Ds_Hour: '12:00'
  })
  return {
    payload: {
      Ds_SignatureVersion: 'HMAC_SHA512_V2',
      Ds_MerchantParameters: merchantParameters,
      Ds_Signature: signMerchantParameters(merchantParameters, contract.secretKey, order)
    },
    order
  }
}

async function cleanupRedisPrefix(redis: Redis, prefix: string) {
  let cursor = '0'
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 200)
    cursor = next
    if (keys.length) await redis.del(...keys)
  } while (cursor !== '0')
}

async function createCallbackOrder(sql: postgres.Sql) {
  const [stock] = await sql<
    { variantId: string; locationId: string; grossCents: number; sourceVersion: string; physical: number }[]
  >`
    SELECT variant.id AS "variantId", balance.location_id AS "locationId",
           price.gross_cents::int AS "grossCents", price.pricing_version AS "sourceVersion",
           balance.physical_quantity::int AS physical
    FROM variants variant
    JOIN effective_variant_prices price ON price.variant_id = variant.id
    JOIN inventory_balances balance ON balance.variant_id = variant.id
    WHERE variant.status = 'published' AND balance.physical_quantity > 1
    ORDER BY variant.sku, balance.location_id
    LIMIT 1
  `
  if (!stock) throw new Error('Seeded stock is required for callback load')
  const marker = randomUUID()
  const [cart] = await sql<{ id: string; version: number }[]>`
    INSERT INTO carts (public_token_hash, expires_at)
    VALUES (${`performance:${marker}`}, now() + interval '1 day')
    RETURNING id, version
  `
  await sql`INSERT INTO cart_items (cart_id, variant_id, quantity) VALUES (${cart!.id}, ${stock.variantId}, 1)`
  const address: CheckoutAddress = {
    recipientName: 'Performance callback',
    companyName: '',
    taxId: '',
    line1: 'Calle de prueba 1',
    line2: '',
    postalCode: '46800',
    city: 'Xàtiva',
    region: 'Valencia',
    countryCode: 'ES',
    phone: '600000000',
    instructions: ''
  }
  const order = await createOrder({
    customer: {
      name: 'Performance callback',
      company: '',
      nif: '',
      email: `${marker}@performance.invalid`,
      phone: '600000000'
    },
    shippingAddress: address,
    billingAddress: { ...address, line1: 'Calle fiscal 1' },
    shippingMethod: 'recogida',
    shippingServiceCode: 'WAREHOUSE-PICKUP',
    expectedPricingVersion: `catalog:${stock.sourceVersion};shipping:neteco:WAREHOUSE-PICKUP`,
    expectedTotalGrossCents: stock.grossCents,
    paymentMethod: 'tarjeta',
    cartId: cart!.id,
    cartVersion: cart!.version,
    idempotencyKey: randomUUID(),
    guestToken: randomUUID(),
    termsAccepted: true,
    marketingConsent: false,
    newsletterSecrets: {
      tokenPepper: 'performance-newsletter-token-pepper',
      encryptionKey: Buffer.alloc(32, 7).toString('base64')
    },
    correlationId: randomUUID()
  })
  return { order, stock }
}

async function main() {
  process.env.APP_ENV = 'test'
  const sourceConnection = process.env.DATABASE_URL ?? 'postgres://neteco:neteco-local@localhost:56432/neteco'
  assertSafeTestTarget(sourceConnection)
  const budgets = await readPerformanceBudgets()
  if (!existsSync('.output/server/index.mjs')) {
    const build = child('npm', ['run', 'build'], process.env, 'inherit')
    if ((await waitForExit(build, 180_000)) !== 0) throw new Error('Production build failed')
  }

  const checks: CheckResult[] = []
  const check = async (name: string, execute: () => Promise<unknown>) => {
    try {
      const metrics = await execute()
      checks.push({ name, status: 'passed', metrics })
    } catch (error) {
      checks.push({ name, status: 'failed', error: error instanceof Error ? error.message : String(error) })
    }
  }

  const teardownTemplate = await integrationGlobalSetup()
  let preview: ChildProcess | undefined
  let redis: Redis | undefined
  let redisPrefix = ''
  let database: Awaited<ReturnType<typeof isolatedPostgresDatabase>> | undefined
  try {
    database = await isolatedPostgresDatabase('performance-suite')
    assertSafeTestTarget(database.connection)
    const redisUrl = new URL(process.env.REDIS_URL ?? 'redis://localhost:56379/0')
    if (!['127.0.0.1', '::1', 'localhost'].includes(redisUrl.hostname)) {
      throw new Error('Performance tests are restricted to loopback Redis')
    }
    if (!/^\/(?:[0-9]|1[0-5])$/.test(redisUrl.pathname || '/0')) {
      throw new Error('Performance tests require Redis database 0-15')
    }
    redisPrefix = `neteco:performance:${randomUUID()}:`
    redis = new Redis(redisUrl.toString(), { maxRetriesPerRequest: 1 })
    await cleanupRedisPrefix(redis, redisPrefix)
    process.env.DATABASE_URL = database.connection
    process.env.DATABASE_POOL_SIZE = String(budgets.database.poolSize)

    const port = await availablePort()
    const baseUrl = `http://127.0.0.1:${port}`
    const contract = REDSYS_OFFICIAL_CONTRACT.sandbox
    const runtimeEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      APP_ENV: 'test',
      APP_BASE_URL: baseUrl,
      NUXT_APP_ENV: 'test',
      NUXT_PUBLIC_APP_ENV: 'test',
      NUXT_PUBLIC_BASE_URL: baseUrl,
      DATABASE_URL: database.connection,
      DATABASE_POOL_SIZE: String(budgets.database.poolSize),
      REDIS_URL: redisUrl.toString(),
      REDIS_KEY_PREFIX: redisPrefix,
      PGAPPNAME: 'neteco-performance-api',
      NUXT_SESSION_PASSWORD: 'test-only-session-password-32-characters',
      AUTH_TOKEN_PEPPER: 'local-only-token-pepper-change-me',
      AUTH_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      PAYMENT_PROVIDER: 'redsys',
      NUXT_PAYMENT_PROVIDER: 'redsys',
      REDSYS_ENV: 'sandbox',
      NUXT_REDSYS_ENVIRONMENT: 'sandbox',
      REDSYS_MERCHANT_CODE: contract.merchantCode,
      NUXT_REDSYS_MERCHANT_CODE: JSON.stringify(contract.merchantCode),
      REDSYS_TERMINAL: contract.terminal,
      NUXT_REDSYS_TERMINAL: JSON.stringify(contract.terminal),
      REDSYS_SECRET_KEY: contract.secretKey,
      NUXT_REDSYS_SECRET_KEY: contract.secretKey,
      REDSYS_CURRENCY: contract.currency,
      NUXT_REDSYS_CURRENCY: JSON.stringify(contract.currency),
      REDSYS_MERCHANT_NAME: 'NETECO PERF',
      NUXT_REDSYS_MERCHANT_NAME: 'NETECO PERF',
      INVOICE_PROVIDER: 'mock',
      CARRIER_PROVIDER: 'mock',
      EMAIL_PROVIDER: 'log'
    }
    preview = child(
      'node',
      ['.output/server/index.mjs'],
      runtimeEnvironment,
      process.env.PERFORMANCE_DEBUG === '1' ? 'inherit' : 'ignore'
    )
    await waitForReady(baseUrl, preview)

    await check('frontend budgets by template', async () => {
      const [product] = await database!.sql<{ slug: string }[]>`
        SELECT slug FROM products WHERE status = 'published' ORDER BY slug LIMIT 1
      `
      if (!product) throw new Error('Seeded product is required')
      const routes = Object.fromEntries(
        Object.entries(budgets.templates).map(([template, route]) => [
          template,
          route.replace('{productSlug}', product.slug)
        ])
      )
      const transfers: Record<
        string,
        { route: string; javascriptGzipKb: number; cssGzipKb: number; serverResponseP95Ms: number }
      > = {}
      for (const [template, route] of Object.entries(routes)) {
        const durations: number[] = []
        let html = ''
        for (let sample = 0; sample < 5; sample += 1) {
          const started = performance.now()
          const response = await fetchWithTimeout(`${baseUrl}${route}`)
          durations.push(performance.now() - started)
          if (!response.ok) throw new Error(`${template} returned ${response.status}`)
          html = await response.text()
        }
        const assets = await compressedAssetBytes(initialAssetUrls(html))
        const javascriptGzipKb = Math.round((assets.javascript / 1024) * 100) / 100
        const cssGzipKb = Math.round((assets.css / 1024) * 100) / 100
        transfers[template] = {
          route,
          javascriptGzipKb,
          cssGzipKb,
          serverResponseP95Ms: Math.round(percentile(durations, 0.95) * 100) / 100
        }
      }

      const browser = await connectRemoteTestBrowser(chromium)
      const lab: Record<string, Record<string, unknown>> = {}
      try {
        for (const [device, deviceBudget] of [
          ['mobile', budgets.mobile],
          ['desktop', budgets.desktop]
        ] as const) {
          const context = await browser.newContext(
            device === 'mobile'
              ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
              : { viewport: { width: 1440, height: 900 } }
          )
          lab[device] = {}
          try {
            for (const [template, route] of Object.entries(routes)) {
              const transfer = transfers[template]!
              if (transfer.javascriptGzipKb > deviceBudget.initialJavaScriptGzipKb) {
                throw new Error(`${device}/${template} JS ${transfer.javascriptGzipKb} KB exceeds budget`)
              }
              if (transfer.cssGzipKb > deviceBudget.initialCssGzipKb) {
                throw new Error(`${device}/${template} CSS ${transfer.cssGzipKb} KB exceeds budget`)
              }
              const page = await context.newPage()
              const thirdPartyOrigins = new Set<string>()
              page.on('request', (request) => {
                const origin = new URL(request.url()).origin
                if (origin !== baseUrl) thirdPartyOrigins.add(origin)
              })
              await page.route('**/*', async (routeRequest) => {
                if (new URL(routeRequest.request().url()).origin !== baseUrl) {
                  await routeRequest.abort('blockedbyclient')
                } else {
                  await routeRequest.continue()
                }
              })
              await page.addInitScript(() => {
                const state = { lcpMs: 0, lcpUrl: '', cls: 0, inpMs: 0, interactions: 0 }
                Object.defineProperty(window, '__netecoPerformance', { value: state })
                new PerformanceObserver((list) => {
                  for (const entry of list.getEntries()) {
                    const lcp = entry as PerformanceEntry & { renderTime?: number; loadTime?: number; url?: string }
                    state.lcpMs = lcp.renderTime || lcp.loadTime || lcp.startTime
                    state.lcpUrl = lcp.url ?? ''
                  }
                }).observe({ type: 'largest-contentful-paint', buffered: true })
                new PerformanceObserver((list) => {
                  for (const entry of list.getEntries()) {
                    const shift = entry as PerformanceEntry & { value: number; hadRecentInput: boolean }
                    if (!shift.hadRecentInput) state.cls += shift.value
                  }
                }).observe({ type: 'layout-shift', buffered: true })
                // Event Timing supports this option; lib.dom's shared observer
                // dictionary does not yet declare the event-specific field.
                const eventOptions: PerformanceObserverInit & { durationThreshold: number } = {
                  type: 'event',
                  buffered: true,
                  durationThreshold: 16
                }
                new PerformanceObserver((list) => {
                  for (const entry of list.getEntries()) {
                    const event = entry as PerformanceEntry & { duration: number; interactionId: number }
                    if (event.interactionId > 0) {
                      state.interactions += 1
                      state.inpMs = Math.max(state.inpMs, event.duration)
                    }
                  }
                }).observe(eventOptions)
              })
              const response = await page.goto(`${baseUrl}${route}`, { waitUntil: 'load', timeout: 10_000 })
              if (!response?.ok()) throw new Error(`${device}/${template} browser navigation failed`)
              await page.waitForTimeout(500)
              const thirdPartiesBeforeConsent = thirdPartyOrigins.size
              await page.keyboard.press('Tab')
              await page.keyboard.press('Space')
              await page.waitForTimeout(100)
              const metrics = await page.evaluate(() => {
                const state = window.__netecoPerformance
                if (!state) throw new Error('Performance observer state was not initialized')
                const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming
                return { ...state, ttfbMs: navigation.responseStart - navigation.requestStart }
              })
              let lcpImageBytes = 0
              if (metrics.lcpUrl && new URL(metrics.lcpUrl).origin === baseUrl) {
                const imageResponse = await fetchWithTimeout(metrics.lcpUrl)
                lcpImageBytes = (await imageResponse.arrayBuffer()).byteLength
              }
              const rounded = {
                lcpMs: Math.round(metrics.lcpMs * 100) / 100,
                inpMs: Math.round(metrics.inpMs * 100) / 100,
                cls: Math.round(metrics.cls * 10_000) / 10_000,
                ttfbMs: Math.round(metrics.ttfbMs * 100) / 100,
                lcpImageKb: Math.round((lcpImageBytes / 1024) * 100) / 100,
                thirdPartiesBeforeConsent,
                interactions: metrics.interactions
              }
              await page.close()
              if (rounded.lcpMs <= 0 || rounded.lcpMs > deviceBudget.lcpMs) {
                throw new Error(`${device}/${template} LCP ${rounded.lcpMs} ms exceeds budget or was not observed`)
              }
              if (rounded.inpMs > deviceBudget.inpMs) throw new Error(`${device}/${template} INP exceeds budget`)
              if (rounded.cls > deviceBudget.cls) throw new Error(`${device}/${template} CLS exceeds budget`)
              if (rounded.ttfbMs > deviceBudget.ttfbMs) throw new Error(`${device}/${template} TTFB exceeds budget`)
              if (rounded.lcpImageKb > deviceBudget.lcpImageKb) {
                throw new Error(`${device}/${template} LCP image exceeds budget`)
              }
              if (rounded.thirdPartiesBeforeConsent > deviceBudget.thirdPartiesBeforeConsent) {
                throw new Error(`${device}/${template} loaded a third party before consent`)
              }
              lab[device]![template] = rounded
            }
          } finally {
            await context.close()
          }
        }
      } finally {
        await browser.close()
      }
      return { transfers, lab }
    })

    const searchLoad = async (
      label: string,
      profile: LoadProfile & { successesBeforeBackpressure?: number },
      expectBackpressure = false
    ) => {
      const statuses: Record<number, number> = {}
      const result = await runBoundedLoad(profile, async (index) => {
        const term = index % 2 ? 'guante' : 'nitrilo'
        const response = await fetchWithTimeout(`${baseUrl}/api/search?q=${term}`)
        statuses[response.status] = (statuses[response.status] ?? 0) + 1
        if (expectBackpressure && response.status === 429) return response.headers.has('retry-after')
        if (!response.ok) return false
        const body = (await response.json()) as { items?: Array<{ name?: string }> }
        return Boolean(
          body.items?.length && body.items.some((item) => item.name?.toLocaleLowerCase('es').includes(term))
        )
      })
      assertLoadBudget(label, result, profile)
      if (expectBackpressure) {
        const expectedAccepted = profile.successesBeforeBackpressure
        if (!expectedAccepted) throw new Error(`${label} has no explicit backpressure threshold`)
        if (statuses[200] !== expectedAccepted || statuses[429] !== profile.requests - expectedAccepted) {
          throw new Error(`${label} backpressure distribution is ${JSON.stringify(statuses)}`)
        }
      }
      return { ...result, concurrency: profile.concurrency, budgetP95Ms: profile.p95Ms, statuses }
    }
    await check('search sustained load', () => searchLoad('search sustained', budgets.api.search.sustained))
    await cleanupRedisPrefix(redis, redisPrefix)
    await check('search spike and backpressure', () => searchLoad('search spike', budgets.api.search.spike, true))

    await check('Redsys callback spike and idempotency', async () => {
      const fixture = await createCallbackOrder(database!.sql)
      const callback = signedCallback(fixture.order.id, fixture.order.total)
      const statuses: Record<number, number> = {}
      const profile = budgets.api.callback.spike
      const result = await runBoundedLoad(profile, async () => {
        const response = await fetchWithTimeout(`${baseUrl}/api/payments/redsys/notification`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: baseUrl },
          body: JSON.stringify(callback.payload)
        })
        statuses[response.status] = (statuses[response.status] ?? 0) + 1
        return response.status === 200 && (await response.text()) === 'OK'
      })
      assertLoadBudget('callback spike', result, profile)
      const [state] = await database!.sql<
        {
          inbox: number
          processed: number
          paymentEvents: number
          allocations: number
          reservations: number
          physical: number
          orderStatus: string
          paymentStatus: string
        }[]
      >`
        SELECT
          (SELECT count(*) FROM webhook_inbox
           WHERE sanitized_payload ->> 'orderReference' = ${callback.order})::int AS inbox,
          (SELECT count(*) FROM webhook_inbox
           WHERE sanitized_payload ->> 'orderReference' = ${callback.order} AND status = 'processed')::int AS processed,
          (SELECT count(*) FROM payment_events event
           JOIN payment_intents payment ON payment.id = event.payment_intent_id
           WHERE payment.order_id = orders.id)::int AS "paymentEvents",
          (SELECT count(*) FROM inventory_movements
           WHERE reference_id = orders.id AND movement_type = 'allocate')::int AS allocations,
          (SELECT count(*) FROM inventory_reservations
           WHERE order_id = orders.id AND status = 'allocated')::int AS reservations,
          (SELECT physical_quantity FROM inventory_balances
           WHERE variant_id = ${fixture.stock.variantId} AND location_id = ${fixture.stock.locationId})::int AS physical,
          orders.order_status AS "orderStatus", orders.payment_status AS "paymentStatus"
        FROM orders WHERE public_number = ${callback.order}
      `
      if (statuses[200] !== profile.requests || Object.keys(statuses).length !== 1) {
        throw new Error(`Unexpected callback status distribution: ${JSON.stringify(statuses)}`)
      }
      if (
        !state ||
        state.inbox !== 1 ||
        state.processed !== 1 ||
        state.paymentEvents !== 1 ||
        state.allocations !== 1 ||
        state.reservations !== 1 ||
        state.physical !== fixture.stock.physical - 1 ||
        state.orderStatus !== 'confirmed' ||
        state.paymentStatus !== 'captured'
      ) {
        throw new Error(`Callback side effects are not exactly-once: ${JSON.stringify(state)}`)
      }
      return { ...result, concurrency: profile.concurrency, statuses, ...state }
    })

    await check('database pool saturation', async () => {
      const budget = budgets.database
      const started = performance.now()
      const rows = await Promise.all(
        Array.from({ length: budget.requests }, async () => {
          const response = await fetchWithTimeout(`${baseUrl}/api/__test__/pool?holdMs=${budget.holdMs}`)
          if (!response.ok) throw new Error(`Application pool probe returned ${response.status}`)
          return (await response.json()) as { backendPid: number }
        })
      )
      const elapsedMs = Math.round((performance.now() - started) * 100) / 100
      const maximumConnections = new Set(rows.map((row) => row.backendPid)).size
      const minimumQueuedElapsed = Math.ceil(budget.requests / budget.poolSize) * budget.holdMs * 0.75
      if (maximumConnections !== budget.poolSize) {
        throw new Error(`Pool opened ${maximumConnections} connections; expected exactly ${budget.poolSize}`)
      }
      if (elapsedMs < minimumQueuedElapsed) throw new Error('Pool workload did not demonstrate queued backpressure')
      if (elapsedMs > budget.maxElapsedMs) throw new Error(`Pool workload ${elapsedMs} ms exceeds budget`)
      return { ...budget, maximumConnections, elapsedMs, source: 'server/db/client.ts' }
    })

    await check('worker bounded concurrency and queue drain', async () => {
      const budget = budgets.worker
      const prefix = `performance:${randomUUID()}`
      await database!.sql`
        INSERT INTO outbox_events (
          aggregate_type, aggregate_id, event_type, payload, correlation_id, idempotency_key
        )
        SELECT 'performance', gen_random_uuid(), 'identity.security.password_changed',
               jsonb_build_object('recipient', 'performance@example.invalid', 'name', 'Performance'),
               gen_random_uuid(), ${prefix} || ':' || series::text
        FROM generate_series(1, ${budget.events}) series
      `
      const workerEnvironment = {
        ...runtimeEnvironment,
        DATABASE_URL: database!.connection,
        APP_BASE_URL: baseUrl,
        EMAIL_PROVIDER: 'log',
        MARKETING_EMAIL_PROVIDER: 'log'
      }
      const workerApplicationPrefix = `neteco-performance-worker-${randomUUID().slice(0, 8)}-`
      const workers = Array.from({ length: budget.processes }, (_, index) =>
        child('node_modules/.bin/tsx', ['scripts/outbox-worker.ts'], {
          ...workerEnvironment,
          PGAPPNAME: `${workerApplicationPrefix}${index}`
        })
      )
      const observer = postgres(database!.connection, performanceObserverDatabaseOptions())
      const started = performance.now()
      let maximumConnections = 0
      const observedWorkers = new Set<string>()
      try {
        const exits = Promise.all(workers.map((worker) => waitForExit(worker, budget.maxDrainMs)))
        let settled = false
        void exits.then(
          () => {
            settled = true
          },
          () => {
            settled = true
          }
        )
        while (!settled) {
          const samples = await observer<{ applicationName: string; connections: number }[]>`
            SELECT application_name AS "applicationName", count(*)::int AS connections
            FROM pg_stat_activity
            WHERE datname = current_database() AND application_name LIKE ${`${workerApplicationPrefix}%`}
            GROUP BY application_name
          `
          maximumConnections = Math.max(
            maximumConnections,
            samples.reduce((total, sample) => total + sample.connections, 0)
          )
          samples.forEach((sample) => observedWorkers.add(sample.applicationName))
          await delay(10)
        }
        const exitCodes = await exits
        if (exitCodes.some((code) => code !== 0)) throw new Error(`Worker exit codes: ${exitCodes.join(', ')}`)
      } finally {
        await Promise.all(workers.map(stopChild))
        await observer.end({ timeout: 5 })
      }
      const drainMs = Math.round((performance.now() - started) * 100) / 100
      const [summary] = await database!.sql<{ completed: number; deliveries: number; duplicateDeliveries: number }[]>`
        SELECT count(*) FILTER (WHERE event.status = 'completed')::int AS completed,
               count(delivery.id)::int AS deliveries,
               (count(delivery.id) - count(DISTINCT delivery.outbox_event_id))::int AS "duplicateDeliveries"
        FROM outbox_events event
        LEFT JOIN communication_deliveries delivery ON delivery.outbox_event_id = event.id
        WHERE event.idempotency_key LIKE ${`${prefix}:%`}
      `
      const throughputPerSecond = Math.round((budget.events / (drainMs / 1000)) * 100) / 100
      if (summary?.completed !== budget.events || summary.deliveries !== budget.events) {
        throw new Error(`Worker completed ${summary?.completed ?? 0}/${budget.events} events`)
      }
      if (summary.duplicateDeliveries !== 0) throw new Error('Worker created duplicate deliveries')
      if (observedWorkers.size !== budget.processes)
        throw new Error('Every worker process was not observed in PostgreSQL')
      if (maximumConnections > budget.maxDatabaseConnections) throw new Error('Worker DB connection budget exceeded')
      if (drainMs > budget.maxDrainMs) throw new Error('Worker drain deadline exceeded')
      if (throughputPerSecond < budget.minThroughputPerSecond) throw new Error('Worker throughput budget missed')
      return {
        ...budget,
        observedWorkerProcesses: observedWorkers.size,
        maximumConnections,
        drainMs,
        throughputPerSecond,
        ...summary
      }
    })
  } finally {
    await stopChild(preview)
    if (redis) {
      if (redisPrefix) await cleanupRedisPrefix(redis, redisPrefix).catch(() => undefined)
      redis.disconnect()
    }
    await closeDatabase()
    if (database) await database.dispose()
    await teardownTemplate()
  }

  const failed = checks.filter((entry) => entry.status === 'failed')
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    profile: 'ci-loopback-isolated',
    budgetVersion: budgets.version,
    owner: budgets.owner,
    budgets,
    dataProfile: 'deterministic db-seed in an isolated PostgreSQL clone; Redis keys use a per-run prefix',
    status: failed.length ? 'failed' : 'passed',
    checks
  }
  await mkdir(resolve('test-results'), { recursive: true })
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (failed.length) throw new Error(`${failed.length} performance checks failed; see ${reportPath}`)
}

await main()
