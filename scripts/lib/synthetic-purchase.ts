import { z } from 'zod'

/** PER-021: synthetic shopper from key locations. Navigation + cart API with a
 * demo SKU only. It stops before checkout, so it can never create a real
 * order, charge or sale. Production (beply.es) is refused unconditionally. */

export const SYNTHETIC_DEMO_SKU = 'DEMO-SYNTHETIC-001'
export const SYNTHETIC_MAX_STEP_MS = 3000
const FORBIDDEN_PATH = /checkout|pay|order|redsys|invoice|refund/i
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

export type SyntheticFetch = (url: string, init?: RequestInit) => Promise<Response>

const locationSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
  region: z.string().regex(/^[a-z0-9-]{1,40}$/)
})
export type SyntheticLocation = z.infer<typeof locationSchema>

export interface SyntheticStep {
  name: string
  ok: boolean
  status?: number
  ms: number
  error?: string
  skipped?: boolean
}
export interface SyntheticLocationResult {
  id: string
  region: string
  ok: boolean
  steps: SyntheticStep[]
}
export interface SyntheticResult {
  ok: boolean
  baseUrl: string
  locations: SyntheticLocationResult[]
}

export function assertSyntheticTarget(baseUrl: string, allowHosts: string[]): URL {
  const url = new URL(baseUrl)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Synthetic target must be http(s)')
  if (url.username || url.password) throw new Error('Synthetic target must not embed credentials')
  const host = url.hostname.toLowerCase()
  if (host === 'beply.es' || host.endsWith('.beply.es'))
    throw new Error('Refusing to run synthetic checks against production')
  if (!LOOPBACK.has(host) && !allowHosts.map((entry) => entry.toLowerCase()).includes(host)) {
    throw new Error(`Host ${host} is not loopback nor in the allowlist`)
  }
  return url
}

export async function runSyntheticPurchase(input: {
  baseUrl: string
  allowHosts: string[]
  locations: SyntheticLocation[]
  fetch: SyntheticFetch
  maxStepMs?: number
  clock?: () => number
}): Promise<SyntheticResult> {
  const target = assertSyntheticTarget(input.baseUrl, input.allowHosts)
  const locations = z.array(locationSchema).min(1).max(20).parse(input.locations)
  if (new Set(locations.map((entry) => entry.id)).size !== locations.length) throw new Error('Duplicate location id')
  const clock = input.clock ?? (() => performance.now())
  const maxStepMs = input.maxStepMs ?? SYNTHETIC_MAX_STEP_MS
  const results: SyntheticLocationResult[] = []

  for (const location of locations) {
    const steps: SyntheticStep[] = []
    let itemId: number | undefined
    const headers = (extra: Record<string, string> = {}) => ({
      'x-neteco-synthetic': '1',
      'x-synthetic-location': location.id,
      ...extra
    })
    const call = async (name: string, method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown) => {
      const url = new URL(path, target)
      if (url.origin !== target.origin || FORBIDDEN_PATH.test(url.pathname))
        throw new Error(`Forbidden synthetic path ${path}`)
      const started = clock()
      const step: SyntheticStep = { name, ok: false, ms: 0 }
      try {
        const response = await input.fetch(url.toString(), {
          method,
          headers: headers(body ? { 'content-type': 'application/json' } : {}),
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(10_000)
        })
        step.status = response.status
        step.ms = clock() - started
        if (!response.ok) step.error = `http_${response.status}`
        else if (step.ms > maxStepMs) step.error = 'latency_budget_exceeded'
        else step.ok = true
        if (name === 'cart_add_demo' && step.ok) {
          const parsed = (await response.json().catch(() => null)) as { id?: unknown } | null
          if (typeof parsed?.id === 'number') itemId = parsed.id
        }
      } catch (error) {
        step.ms = clock() - started
        step.error = error instanceof Error ? error.message : String(error)
      }
      steps.push(step)
      return step.ok
    }

    const proceed =
      (await call('home', 'GET', '/')) &&
      (await call('catalog', 'GET', '/catalogo')) &&
      (await call('search', 'GET', '/buscar?q=limpieza')) &&
      (await call('cart_add_demo', 'POST', '/api/cart/items', { sku: SYNTHETIC_DEMO_SKU, quantity: 1 }))
    if (proceed) await call('cart_read', 'GET', '/api/cart')
    if (itemId === undefined) steps.push({ name: 'cart_cleanup', ok: true, ms: 0, skipped: true })
    else await call('cart_cleanup', 'DELETE', `/api/cart/items/${itemId}`)
    results.push({ id: location.id, region: location.region, ok: steps.every((step) => step.ok), steps })
  }
  return { ok: results.every((entry) => entry.ok), baseUrl: target.origin, locations: results }
}

function option(argv: string[], name: string) {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}

/** Exit codes: 0 healthy, 1 a location failed, 2 refused or invalid arguments. */
export async function runSyntheticPurchaseCli(
  argv: string[],
  deps: { fetch?: SyntheticFetch; log?: (line: string) => void } = {}
) {
  const log = deps.log ?? (() => undefined)
  try {
    const baseUrl = option(argv, '--base-url')
    if (!baseUrl) throw new Error('--base-url is required')
    const locations = (option(argv, '--locations') ?? 'madrid:eu-south,barcelona:eu-south,canarias:atlantic')
      .split(',')
      .map((entry) => {
        const [id, region] = entry.split(':')
        return { id: id ?? '', region: region ?? '' }
      })
    const allowHosts = (option(argv, '--allow-host') ?? '').split(',').filter(Boolean)
    const result = await runSyntheticPurchase({
      baseUrl,
      allowHosts,
      locations,
      fetch: deps.fetch ?? ((url, init) => fetch(url, init))
    })
    log(JSON.stringify(result, null, 2))
    return result.ok ? 0 : 1
  } catch (error) {
    log(`synthetic purchase refused: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
}
