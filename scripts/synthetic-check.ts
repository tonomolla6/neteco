const baseUrl = process.env.SYNTHETIC_BASE_URL?.trim()
if (!baseUrl) throw new Error('SYNTHETIC_BASE_URL is required')
const origin = new URL(baseUrl)
if (process.env.APP_ENV === 'production' && origin.protocol !== 'https:') {
  throw new Error('Production synthetic checks require HTTPS')
}

interface Result {
  path: string
  status: number
  durationMs: number
  ok: boolean
}

async function check(path: string, predicate?: (response: Response, body: string) => boolean) {
  const started = performance.now()
  const response = await fetch(new URL(path, origin), { redirect: 'error', signal: AbortSignal.timeout(10_000) })
  const body = await response.text()
  const result: Result = {
    path,
    status: response.status,
    durationMs: Math.round((performance.now() - started) * 100) / 100,
    ok: response.ok && (!predicate || predicate(response, body))
  }
  if (!result.ok) process.exitCode = 2
  return { result, body }
}

const results: Result[] = []
const live = await check('/api/health/live', (_response, body) => body.includes('"status":"ok"'))
results.push(live.result)
const ready = await check('/api/health/ready', (_response, body) => body.includes('"status":"ready"'))
results.push(ready.result)
const home = await check(
  '/',
  (response, body) => response.headers.get('content-type')?.includes('text/html') === true && body.includes('NETECO')
)
results.push(home.result)
const catalog = await check('/api/products?limit=1', (_response, body) => body.includes('"items"'))
results.push(catalog.result)
const robots = await check('/robots.txt', (_response, body) => body.includes('Disallow: /checkout'))
results.push(robots.result)
const sitemap = await check('/sitemap.xml', (_response, body) => body.includes('<urlset'))
results.push(sitemap.result)

process.stdout.write(
  `${JSON.stringify({
    event: results.every((result) => result.ok) ? 'synthetic.check.passed' : 'synthetic.check.failed',
    baseUrl: origin.origin,
    occurredAt: new Date().toISOString(),
    results
  })}\n`
)
