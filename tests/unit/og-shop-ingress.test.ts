import { describe, expect, it, vi } from 'vitest'
import { createShopIngress } from '../../workers/runtime/shop-ingress'

const context = () => ({ waitUntil: vi.fn(), passThroughOnException: vi.fn() }) as unknown as ExecutionContext
const env = { APP_ENV: 'preprod' } as unknown as CloudflareEnv

describe('shop ingress routing of dynamic Open Graph cards', () => {
  it.each(['producto', 'categoria', 'plantilla', 'contenido'])(
    'sends /og/%s/<slug>.png to the API router, never to the renderer',
    async (kind) => {
      const api = { fetch: vi.fn(async () => new Response('png', { headers: { 'content-type': 'image/png' } })) }
      const renderer = { fetch: vi.fn() }
      const response = await createShopIngress(api, renderer).fetch(
        new Request(`https://neteco.example/og/${kind}/algo-1.png`),
        env,
        context()
      )
      expect(response.headers.get('content-type')).toBe('image/png')
      expect(api.fetch).toHaveBeenCalledTimes(1)
      expect(renderer.fetch).not.toHaveBeenCalled()
    }
  )

  it('keeps static cards on the renderer/assets path and rejects encoded aliases', async () => {
    const api = { fetch: vi.fn() }
    const renderer = { fetch: vi.fn(async () => new Response('jpg', { headers: { 'content-type': 'image/jpeg' } })) }
    const ingress = createShopIngress(api, renderer)
    await ingress.fetch(new Request('https://neteco.example/og/og-producto.jpg'), env, context())
    expect(renderer.fetch).toHaveBeenCalledTimes(1)
    expect(api.fetch).not.toHaveBeenCalled()
    await ingress.fetch(new Request('https://neteco.example/%6fg/producto/a%2e.png'), env, context())
    expect(api.fetch).not.toHaveBeenCalled()
  })
})
