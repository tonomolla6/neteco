/* eslint-disable @typescript-eslint/no-explicit-any -- loosely typed JSON/fetch doubles in this test file */
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

function load() {
  const listeners: Record<string, (event: any) => void> = {}
  const store = new Map<string, Response>()
  const cache = {
    addAll: async () => undefined,
    match: async (request: string | Request) =>
      store.get(
        typeof request === 'string' ? new URL(request, 'https://t.example').pathname : new URL(request.url).pathname
      ),
    put: async (request: Request, response: Response) => void store.set(new URL(request.url).pathname, response)
  }
  const context: any = {
    URL,
    Response,
    Request,
    Promise,
    self: {
      location: { origin: 'https://t.example' },
      addEventListener: (n: string, h: any) => (listeners[n] = h),
      skipWaiting: async () => undefined,
      clients: { claim: async () => undefined }
    },
    caches: {
      open: async () => cache,
      keys: async () => ['old', 'neteco-reparto-shell-v1'],
      delete: async (k: string) => void deleted.push(k)
    },
    fetch: async (r: Request) => fetchBehaviour(r) as Response
  }
  const deleted: string[] = []
  let fetchBehaviour: (r: Request) => Response | never = () => new Response('net', { status: 200 })
  vm.runInNewContext(readFileSync('public/reparto-sw.js', 'utf8'), context)
  return {
    listeners,
    store,
    deleted,
    strategyFor: context.self.__strategyFor as (r: any, o: string) => string,
    setFetch: (f: typeof fetchBehaviour) => (fetchBehaviour = f)
  }
}
const req = (path: string, init: { method?: string; mode?: string } = {}) => ({
  url: `https://t.example${path}`,
  method: init.method ?? 'GET',
  mode: init.mode ?? 'cors'
})

describe('SHP-027 delivery service worker', () => {
  it('never intercepts API traffic, writes, cross-origin or unrelated pages', () => {
    const { strategyFor } = load()
    expect(strategyFor(req('/api/delivery/manifest'), 'https://t.example')).toBe('bypass')
    expect(strategyFor(req('/api/delivery/sync', { method: 'POST' }), 'https://t.example')).toBe('bypass')
    expect(strategyFor(req('/admin/pedidos', { mode: 'navigate' }), 'https://t.example')).toBe('bypass')
    expect(
      strategyFor({ url: 'https://evil.example/_nuxt/a.js', method: 'GET', mode: 'cors' }, 'https://t.example')
    ).toBe('bypass')
  })

  it('caches the shell network-first and hashed assets cache-first', () => {
    const { strategyFor } = load()
    expect(strategyFor(req('/reparto', { mode: 'navigate' }), 'https://t.example')).toBe('network-first')
    expect(strategyFor(req('/_nuxt/entry.abc.js'), 'https://t.example')).toBe('cache-first')
    expect(strategyFor(req('/reparto.webmanifest'), 'https://t.example')).toBe('cache-first')
  })

  it('serves the cached shell when the network fails and never stores API responses', async () => {
    const sw = load()
    const respond = async (request: any) => {
      let promise: Promise<Response> | undefined
      sw.listeners.fetch!({ request, respondWith: (p: Promise<Response>) => (promise = p) })
      return promise
    }
    await respond(req('/reparto', { mode: 'navigate' }))
    expect(sw.store.has('/reparto')).toBe(true)
    sw.setFetch(() => {
      throw new TypeError('offline')
    })
    const offline = await respond(req('/reparto', { mode: 'navigate' }))
    expect(await offline!.text()).toBe('net')
    expect(await respond(req('/api/delivery/manifest'))).toBeUndefined()
    expect([...sw.store.keys()].some((k) => k.startsWith('/api/'))).toBe(false)
  })

  it('drops older caches on activate', async () => {
    const sw = load()
    let done: Promise<unknown> | undefined
    sw.listeners.activate!({ waitUntil: (p: Promise<unknown>) => (done = p) })
    await done
    expect(sw.deleted).toEqual(['old'])
  })
})
