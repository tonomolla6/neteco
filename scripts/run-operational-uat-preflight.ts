import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { operationalUatStagingOrigin } from './lib/operational-uat'

const args = process.argv.slice(2)
const argument = (name: string) => args.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3)
const baseUrl = argument('base-url') ?? process.env.UAT_STAGING_URL?.trim()
const expectedCommit = argument('expected-commit') ?? process.env.UAT_EXPECTED_COMMIT?.trim()
const productionUrl = argument('production-url') ?? process.env.UAT_PRODUCTION_URL?.trim()
const output = resolve(
  argument('output') ?? process.env.UAT_PREFLIGHT_OUTPUT ?? 'test-results/operational-uat-preflight.json'
)

if (!baseUrl || !expectedCommit || !productionUrl) {
  throw new Error(
    'Usage: npm run uat:preflight -- --base-url=<staging HTTPS URL> --production-url=<production HTTPS URL> --expected-commit=<40-character SHA> [--output=<path>]'
  )
}
if (!/^[0-9a-f]{40}$/i.test(expectedCommit)) throw new Error('Expected commit must be a 40-character SHA')
const normalizedCommit = expectedCommit.toLowerCase()
const origin = new URL(operationalUatStagingOrigin(baseUrl, productionUrl))

interface Probe {
  id: string
  path: string
  status: number
  durationMs: number
  pass: boolean
  detail: string
}

async function probe(id: string, path: string, validate: (response: Response, body: string) => string | null) {
  const started = performance.now()
  try {
    const response = await fetch(new URL(path, origin), {
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
      headers: { accept: path.startsWith('/api/') ? 'application/json' : 'text/html,text/plain' }
    })
    const body = await response.text()
    const validation = validate(response, body)
    return {
      id,
      path,
      status: response.status,
      durationMs: Math.round((performance.now() - started) * 100) / 100,
      pass: response.ok && validation === null,
      detail: response.ok ? (validation ?? 'ok') : `HTTP ${response.status}`
    } satisfies Probe
  } catch (error) {
    return {
      id,
      path,
      status: 0,
      durationMs: Math.round((performance.now() - started) * 100) / 100,
      pass: false,
      detail: error instanceof Error ? error.name : 'request failed'
    } satisfies Probe
  }
}

const json = (body: string) => JSON.parse(body) as Record<string, unknown>
const probes = await Promise.all([
  probe('live-version', '/api/health/live', (_response, body) => {
    const value = json(body)
    if (value.status !== 'ok' || value.service !== 'neteco') return 'live health contract mismatch'
    return typeof value.version === 'string' && value.version.toLowerCase() === normalizedCommit
      ? null
      : 'deployed version does not match expected commit'
  }),
  probe('ready-dependencies', '/api/health/ready', (_response, body) => {
    const value = json(body)
    const dependencies = value.dependencies as Record<string, unknown> | undefined
    return value.status === 'ready' && dependencies?.database === 'ready' && dependencies.redis === 'ready'
      ? null
      : 'readiness dependencies are not ready'
  }),
  probe('storefront-noindex', '/', (response, body) =>
    response.headers.get('content-type')?.includes('text/html') &&
    response.headers.get('x-robots-tag')?.includes('noindex') &&
    body.includes('NETECO')
      ? null
      : 'staging storefront or noindex contract mismatch'
  ),
  probe('catalog', '/api/products?limit=1', (_response, body) => {
    const value = json(body)
    return Array.isArray(value.items) && value.items.length > 0 ? null : 'staging catalog is empty'
  }),
  probe('robots', '/robots.txt', (_response, body) =>
    body.includes('Disallow: /checkout') ? null : 'robots policy does not protect checkout'
  )
])

const artifact = {
  schemaVersion: 1,
  requirementId: 'TST-040',
  kind: 'staging-preflight',
  generatedAt: new Date().toISOString(),
  environmentUrl: origin.origin,
  expectedCommit: normalizedCommit,
  status: probes.every((item) => item.pass) ? 'pass' : 'fail',
  probes
}
await mkdir(dirname(output), { recursive: true })
await writeFile(output, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8')
process.stdout.write(
  `operational-uat-preflight=${artifact.status.toUpperCase()} probes=${probes.filter((item) => item.pass).length}/${probes.length} output=${output}\n`
)
if (artifact.status !== 'pass') process.exitCode = 2
