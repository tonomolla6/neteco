import { readFile, realpath, stat, lstat, mkdtemp, rm } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'

// Capability only: not application/UI acceptance, runner admission or CI proof.
// This fixed disposable dependency checkout is provisioned by the operator.
// No CLI/env repository, browser endpoint or identity override is supported.
const ROOT = '/var/lib/neteco-ci/runner/_work/neteco-capability'
const INSTALLED = '/usr/local/libexec/neteco-ci/capability-probe.mjs'
const BROWSER_CACHE = '/var/lib/neteco-ci/cache/ms-playwright'
const report = {
  status: 'failed',
  dependenciesLoaded: false,
  networkAttempted: false,
  browserAttempted: false,
  productionAcceptance: false,
  checks: {},
  engines: {},
  code: 'untrusted_probe'
}
const checks = report.checks
checks.arguments = process.argv.length === 2
checks.noOverrides =
  ['MINIFLARE_WORKERD_PATH', 'NETECO_CAPABILITY_ROOT', 'PLAYWRIGHT_WS_ENDPOINT', 'PW_TEST_CONNECT_WS_ENDPOINT'].every(
    (key) => process.env[key] === undefined
  ) &&
  (process.env.PLAYWRIGHT_BROWSERS_PATH === undefined || process.env.PLAYWRIGHT_BROWSERS_PATH === BROWSER_CACHE)
async function trustedInstalledProbe() {
  if (import.meta.url !== pathToFileURL(INSTALLED).href || process.argv[1] !== INSTALLED) return false
  try {
    const paths = ['/', '/usr', '/usr/local', '/usr/local/libexec', '/usr/local/libexec/neteco-ci', INSTALLED]
    for (const path of paths) {
      const metadata = await lstat(path)
      if (metadata.isSymbolicLink() || metadata.uid !== 0 || (metadata.mode & 0o022) !== 0) return false
      if (path === INSTALLED ? !metadata.isFile() : !metadata.isDirectory()) return false
    }
    return (await realpath(INSTALLED)) === INSTALLED
  } catch {
    return false
  }
}
checks.trustedProbe = await trustedInstalledProbe()
if (checks.trustedProbe) {
  report.code = 'identity_denied'
  checks.uid = process.getuid?.() === 980
  try {
    checks.username = userInfo().username === 'neteco-actions'
  } catch {
    checks.username = false
  }
  checks.node = process.versions.node === '24.18.1'
  checks.linuxArm64 = process.platform === 'linux' && process.arch === 'arm64'
  try {
    const os = await readFile('/etc/os-release', 'utf8')
    const fields = new Map(
      os.split('\n').map((line) => {
        const match = /^([A-Z_]+)=(?:"([^"]*)"|([^"\s]*))$/.exec(line)
        return match ? [match[1], match[2] ?? match[3]] : ['', '']
      })
    )
    checks.ubuntuNoble = fields.get('ID') === 'ubuntu' && fields.get('VERSION_ID') === '24.04'
  } catch {
    checks.ubuntuNoble = false
  }
}

let runtime, server, directory, browser
let outbound = 0
const sockets = new Set()
async function closeBrowser() {
  if (!browser) return
  const current = browser
  await current.close()
  browser = undefined
}
try {
  if (Object.values(checks).every((value) => value === true)) {
    report.code = 'dependency_checkout_invalid'
    checks.fixedCheckout = (await realpath(ROOT)) === ROOT && (await stat(ROOT)).isDirectory()
    assert(checks.fixedCheckout)
    const require = createRequire(join(ROOT, 'package.json'))
    process.env.PLAYWRIGHT_BROWSERS_PATH = BROWSER_CACHE
    const modules = ['miniflare', '@playwright/test']
    for (const name of modules) assert((await realpath(require.resolve(name))).startsWith(ROOT + '/node_modules/'))
    const { Miniflare, NoOpLog, convertV4MiniflareOptions } = require('miniflare')
    const { chromium, firefox, webkit } = require('@playwright/test')
    report.dependenciesLoaded = true
    directory = await mkdtemp(join(ROOT, 'probe-owned-'))
    report.code = 'native_workerd_failed'
    report.networkAttempted = true
    runtime = new Miniflare(
      convertV4MiniflareOptions({
        name: 'neteco-isolated-capability',
        modules: true,
        compatibilityDate: '2026-08-15',
        log: new NoOpLog(),
        cf: false,
        telemetry: { enabled: false },
        resourcePersistencePath: directory,
        resourceTmpPath: join(directory, 'runtime-tmp'),
        d1Databases: { DB: '00000000-0000-4000-8000-000000000098' },
        script: `export default { async fetch(request, env) {
        if (request.method === 'POST') {
          const { value } = await request.json();
          await env.DB.prepare('INSERT INTO capability(value) VALUES (?)').bind(value).run();
        }
        const result = await env.DB.prepare('SELECT value FROM capability ORDER BY id').all();
        return Response.json({ values: result.results.map(row => row.value) });
      }};`,
        outboundService: () => {
          outbound++
          return new Response('Denied', { status: 503 })
        }
      })
    )
    await runtime.ready
    const database = await runtime.getD1Database('DB')
    await database.prepare('CREATE TABLE capability(id INTEGER PRIMARY KEY, value TEXT NOT NULL)').run()
    const value = 'Synthetic Ñ 😀 <not-markup>'
    const written = await runtime.dispatchFetch('http://capability.local/synthetic', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value })
    })
    assert.equal(written.status, 200)
    assert.deepEqual(await written.json(), { values: [value] })
    const read = await runtime.dispatchFetch('http://capability.local/synthetic')
    assert.equal(read.status, 200)
    assert.deepEqual(await read.json(), { values: [value] })
    assert.equal((await database.prepare('SELECT count(*) AS n FROM capability').first()).n, 1)
    checks.nativeD1FetchRoundtrip = true
    checks.workerZeroOutbound = outbound === 0
    assert(checks.workerZeroOutbound)
    await runtime.dispose()
    runtime = undefined

    report.code = 'loopback_http_failed'
    server = createServer((request, response) => {
      response.setHeader('cache-control', 'no-store')
      if (request.method !== 'GET' || request.url !== '/') {
        response.writeHead(404)
        response.end()
        return
      }
      response.setHeader('content-type', 'text/html; charset=utf-8')
      response.end(`<!doctype html><html><head><title>Neteco isolated capability</title><link rel="icon" href="data:,"></head><body>
        <label>Dato sintético<input id="value"></label><button id="apply">Aplicar</button><output id="result"></output>
        <script>document.querySelector('#apply').addEventListener('click',()=>{document.querySelector('#result').textContent=document.querySelector('#value').value;});</script>
      </body></html>`)
    })
    server.on('connection', (socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
    })
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const origin = `http://127.0.0.1:${server.address().port}`
    checks.loopbackHttp = true
    for (const [name, engine] of Object.entries({ chromium, firefox, webkit })) {
      report.code = 'browser_' + name + '_failed'
      report.browserAttempted = true
      // One engine at a time. Use installed pinned browsers, never a remote
      // endpoint, executable override or fallback on another user's cache.
      browser = await engine.launch({ headless: true, timeout: 15000 })
      const context = await browser.newContext({ serviceWorkers: 'block' })
      let blocked = 0
      await context.route('**/*', (route) => {
        const url = new URL(route.request().url())
        if (url.origin === origin && url.protocol === 'http:' && !url.username && !url.password) return route.continue()
        blocked++
        return route.abort('blockedbyclient')
      })
      const page = await context.newPage()
      page.setDefaultTimeout(5000)
      await page.goto(origin, { waitUntil: 'load', timeout: 10000 })
      assert.equal(await page.title(), 'Neteco isolated capability')
      await page.locator('#value').fill(value)
      await page.locator('#apply').click()
      assert.equal(await page.locator('#result').textContent(), value)
      assert.equal(await page.locator('#result').locator('*').count(), 0)
      assert.equal(
        await page.evaluate(async () => {
          try {
            await fetch('http://capability-egress-denied.invalid/')
            return false
          } catch {
            return true
          }
        }),
        true
      )
      assert.equal(blocked, 1)
      report.engines[name] = {
        version: browser.version(),
        title: true,
        clickDomRoundtrip: true,
        foreignRequestBlocked: true
      }
      checks[name] = true
      await context.close()
      await closeBrowser()
    }
    report.code = 'capability_only_completed'
  }
} catch {
  checks.probeCompleted = false
} finally {
  try {
    await closeBrowser()
  } catch {
    checks.cleanup = false
  }
  try {
    await runtime?.dispose()
  } catch {
    checks.cleanup = false
  }
  try {
    for (const socket of sockets) socket.destroy()
    if (server?.listening) await new Promise((resolve) => server.close(resolve))
  } catch {
    checks.cleanup = false
  }
  try {
    if (directory) await rm(directory, { recursive: true, force: true })
  } catch {
    checks.cleanup = false
  }
}
report.status = Object.values(checks).every((value) => value === true) && checks.webkit === true ? 'passed' : 'failed'
process.stdout.write(JSON.stringify(report) + '\n')
process.exitCode = report.status === 'passed' ? 0 : 1
