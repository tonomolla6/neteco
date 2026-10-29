import { describe, expect, it } from 'vitest'
import {
  assertSyntheticTarget,
  runSyntheticPurchase,
  runSyntheticPurchaseCli,
  SYNTHETIC_DEMO_SKU,
  type SyntheticFetch
} from '../../scripts/lib/synthetic-purchase'

const locations = [
  { id: 'madrid', region: 'eu-south' },
  { id: 'canarias', region: 'atlantic' }
]

function fakeShop(
  over: { fail?: (path: string, method: string, location: string) => number | 'throw' | undefined } = {}
) {
  const calls: Array<{ url: string; method: string; location: string; synthetic: string }> = []
  const fetcher: SyntheticFetch = async (url, init) => {
    const u = new URL(url)
    const method = init?.method ?? 'GET'
    const headers = (init?.headers ?? {}) as Record<string, string>
    const location = headers['x-synthetic-location'] ?? ''
    calls.push({ url, method, location, synthetic: headers['x-neteco-synthetic'] ?? '' })
    const forced = over.fail?.(u.pathname, method, location)
    if (forced === 'throw') throw new Error('network down')
    if (forced) return new Response('err', { status: forced })
    if (u.pathname === '/api/cart/items' && method === 'POST') return Response.json({ id: 7 }, { status: 201 })
    return new Response('ok', { status: 200 })
  }
  return { fetcher, calls }
}
const base = 'http://127.0.0.1:3100'

describe('assertSyntheticTarget', () => {
  it.each([
    'https://neteco.beply.es',
    'https://NETECO.BEPLY.ES/x',
    'https://shop.beply.es',
    'https://beply.es',
    'http://neteco.beply.es.evil.test'
  ])('refuses production-like host %s', (url) => {
    expect(() => assertSyntheticTarget(url, [])).toThrow(/production|allowlist/i)
  })
  it('refuses even when a production host is allow-listed', () => {
    expect(() => assertSyntheticTarget('https://neteco.beply.es', ['neteco.beply.es'])).toThrow(/production/i)
  })
  it('allows loopback and explicitly allow-listed hosts, rejects the rest', () => {
    expect(assertSyntheticTarget(base, []).hostname).toBe('127.0.0.1')
    expect(assertSyntheticTarget('http://localhost:8787', []).hostname).toBe('localhost')
    expect(assertSyntheticTarget('https://staging.example.test', ['staging.example.test']).hostname).toBe(
      'staging.example.test'
    )
    expect(() => assertSyntheticTarget('https://other.example.test', [])).toThrow(/allowlist/i)
  })
  it('rejects non-http schemes and credentials in the URL', () => {
    expect(() => assertSyntheticTarget('ftp://127.0.0.1', [])).toThrow()
    expect(() => assertSyntheticTarget('http://user:pw@127.0.0.1', [])).toThrow()
  })
})

describe('runSyntheticPurchase', () => {
  it('walks navigation and cart API for each location with demo data only', async () => {
    const shop = fakeShop()
    const result = await runSyntheticPurchase({ baseUrl: base, allowHosts: [], locations, fetch: shop.fetcher })
    expect(result.ok).toBe(true)
    expect(result.locations.map((l) => l.id)).toEqual(['madrid', 'canarias'])
    expect(result.locations[0]!.steps.map((s) => s.name)).toEqual([
      'home',
      'catalog',
      'search',
      'cart_add_demo',
      'cart_read',
      'cart_cleanup'
    ])
    expect(shop.calls.every((c) => c.synthetic === '1')).toBe(true)
    expect(shop.calls.filter((c) => c.location === 'canarias').length).toBeGreaterThan(0)
  })
  it('never calls checkout, payment or order endpoints', async () => {
    const shop = fakeShop()
    await runSyntheticPurchase({ baseUrl: base, allowHosts: [], locations, fetch: shop.fetcher })
    for (const call of shop.calls) expect(new URL(call.url).pathname).not.toMatch(/checkout|pay|order|redsys|invoice/i)
    expect(shop.calls.map((c) => c.method).every((m) => ['GET', 'POST', 'DELETE'].includes(m))).toBe(true)
  })
  it('adds only the demo SKU', async () => {
    const bodies: string[] = []
    const fetcher: SyntheticFetch = async (url, init) => {
      if (init?.body) bodies.push(String(init.body))
      return new Response('{}', { status: 200 })
    }
    await runSyntheticPurchase({ baseUrl: base, allowHosts: [], locations: locations.slice(0, 1), fetch: fetcher })
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toContain(SYNTHETIC_DEMO_SKU)
  })
  it('refuses to call a production target before any request', async () => {
    const shop = fakeShop()
    await expect(
      runSyntheticPurchase({
        baseUrl: 'https://neteco.beply.es',
        allowHosts: ['neteco.beply.es'],
        locations,
        fetch: shop.fetcher
      })
    ).rejects.toThrow(/production/i)
    expect(shop.calls).toHaveLength(0)
  })
  it('reports a failing location without hiding the healthy ones', async () => {
    const shop = fakeShop({ fail: (path, _m, loc) => (loc === 'canarias' && path === '/catalogo' ? 503 : undefined) })
    const result = await runSyntheticPurchase({ baseUrl: base, allowHosts: [], locations, fetch: shop.fetcher })
    expect(result.ok).toBe(false)
    expect(result.locations.find((l) => l.id === 'madrid')!.ok).toBe(true)
    const bad = result.locations.find((l) => l.id === 'canarias')!
    expect(bad.ok).toBe(false)
    expect(bad.steps.find((s) => s.name === 'catalog')).toMatchObject({ ok: false, status: 503 })
  })
  it('stops a location after the first failed step but still attempts cart cleanup', async () => {
    const shop = fakeShop({
      fail: (path, method) => (path === '/api/cart/items' && method === 'POST' ? 500 : undefined)
    })
    const result = await runSyntheticPurchase({
      baseUrl: base,
      allowHosts: [],
      locations: locations.slice(0, 1),
      fetch: shop.fetcher
    })
    const names = result.locations[0]!.steps.map((s) => s.name)
    expect(names).not.toContain('cart_read')
    expect(names).toContain('cart_cleanup')
  })
  it('records network errors as failures', async () => {
    const shop = fakeShop({ fail: () => 'throw' })
    const result = await runSyntheticPurchase({
      baseUrl: base,
      allowHosts: [],
      locations: locations.slice(0, 1),
      fetch: shop.fetcher
    })
    expect(result.ok).toBe(false)
    expect(result.locations[0]!.steps[0]).toMatchObject({ ok: false, error: 'network down' })
  })
  it('fails a step slower than its latency budget', async () => {
    let t = 0
    const fetcher: SyntheticFetch = async () => new Response('ok')
    const result = await runSyntheticPurchase({
      baseUrl: base,
      allowHosts: [],
      locations: locations.slice(0, 1),
      fetch: fetcher,
      maxStepMs: 100,
      clock: () => (t += 500)
    })
    expect(result.ok).toBe(false)
    expect(result.locations[0]!.steps[0]!.error).toBe('latency_budget_exceeded')
  })
  it('rejects empty, duplicate or malformed locations', async () => {
    const shop = fakeShop()
    await expect(
      runSyntheticPurchase({ baseUrl: base, allowHosts: [], locations: [], fetch: shop.fetcher })
    ).rejects.toThrow()
    await expect(
      runSyntheticPurchase({
        baseUrl: base,
        allowHosts: [],
        locations: [locations[0]!, locations[0]!],
        fetch: shop.fetcher
      })
    ).rejects.toThrow(/duplicate/i)
    await expect(
      runSyntheticPurchase({
        baseUrl: base,
        allowHosts: [],
        locations: [{ id: 'bad id!', region: 'x' }],
        fetch: shop.fetcher
      })
    ).rejects.toThrow()
  })
})

describe('runSyntheticPurchaseCli', () => {
  it('returns 0 on success against a fake, 1 on failure, 2 on refused target', async () => {
    expect(
      await runSyntheticPurchaseCli(['--base-url', base, '--locations', 'madrid:eu-south'], {
        fetch: fakeShop().fetcher
      })
    ).toBe(0)
    const failing = fakeShop({ fail: (p) => (p === '/' ? 500 : undefined) })
    expect(
      await runSyntheticPurchaseCli(['--base-url', base, '--locations', 'madrid:eu-south'], { fetch: failing.fetcher })
    ).toBe(1)
    const shop = fakeShop()
    expect(await runSyntheticPurchaseCli(['--base-url', 'https://neteco.beply.es'], { fetch: shop.fetcher })).toBe(2)
    expect(shop.calls).toHaveLength(0)
  })
})
