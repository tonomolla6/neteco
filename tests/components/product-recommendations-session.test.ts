import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useProductRecommendations } from '../../app/composables/useProductRecommendations'
import type { ProductRecommendationsResponse } from '../../shared/product-recommendations'

const { request } = vi.hoisted(() => ({ request: vi.fn() }))
const actor = {
  ready: ref(true),
  loggedIn: ref(true),
  user: ref<{ id: string } | null>({ id: 'alice' }),
  session: ref<{ sessionId: string; sessionVersion: number } | null>({ sessionId: 'session-a', sessionVersion: 1 })
}
mockNuxtImport('$fetch', () => request)
mockNuxtImport('useUserSession', () => () => actor)
mockNuxtImport('useRuntimeConfig', (original) => () => {
  const config = original()
  return { ...config, public: { ...config.public, serverRuntime: 'cloudflare' } }
})
const roots: Awaited<ReturnType<typeof mountSuspended>>[] = []
let model: ReturnType<typeof useProductRecommendations>
const response = (price: number): ProductRecommendationsResponse => ({
  source: 'cloudflare',
  strips: [
    {
      kind: 'for_you',
      basis: 'featured',
      items: [1, 2].map((id) => ({
        id,
        slug: `producto-${id}`,
        name: `Producto ${id}`,
        brand: 'NETECO',
        image: null,
        imageAlt: null,
        visual: { type: 'garrafa', color: '#fff' },
        minPrice: price,
        minNetPrice: price,
        compareAtPrice: null,
        formats: 1,
        badges: []
      }))
    }
  ]
})
const Harness = defineComponent({
  setup() {
    model = useProductRecommendations({ product: 'producto-3', strips: ['for_you'] })
    return () => h('pre', JSON.stringify(model.strips.value))
  }
})
async function mount() {
  const root = await mountSuspended(Harness)
  roots.push(root)
  await flushPromises()
  return root
}
beforeEach(() => {
  request.mockReset()
  actor.ready.value = true
  actor.loggedIn.value = true
  actor.user.value = { id: 'alice' }
  actor.session.value = { sessionId: 'session-a', sessionVersion: 1 }
})
afterEach(() => roots.splice(0).forEach((root) => root.unmount()))

describe('recommendation price ownership in the browser', () => {
  it('waits for the confirmed session before asking for potentially contractual prices', async () => {
    actor.ready.value = false
    request.mockResolvedValue(response(333))
    await mount()
    expect(request).not.toHaveBeenCalled()
    actor.ready.value = true
    await flushPromises()
    expect(request).toHaveBeenCalledOnce()
    expect(model.strips.value[0]!.items[0]!.minPrice).toBe(333)
  })
  it('purges prior contractual prices immediately on logout and reloads guest prices', async () => {
    let resolve!: (value: ProductRecommendationsResponse) => void
    request.mockResolvedValueOnce(response(333)).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    const root = await mount()
    expect(root.text()).toContain('333')
    actor.loggedIn.value = false
    actor.user.value = null
    actor.session.value = null
    await flushPromises()
    expect(model.strips.value).toEqual([])
    expect(request).toHaveBeenCalledTimes(2)
    resolve(response(500))
    await flushPromises()
    expect(root.text()).toContain('500')
    expect(root.text()).not.toContain('333')
  })
  it('ignores an old identity response that completes after the new identity response', async () => {
    let resolveAlice!: (value: ProductRecommendationsResponse) => void
    request
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolveAlice = done
          })
      )
      .mockResolvedValueOnce(response(500))
    const root = await mount()
    actor.user.value = { id: 'bob' }
    actor.session.value = { sessionId: 'session-b', sessionVersion: 2 }
    await flushPromises()
    expect(request).toHaveBeenCalledTimes(2)
    resolveAlice(response(333))
    await flushPromises()
    expect(root.text()).toContain('500')
    expect(root.text()).not.toContain('333')
  })
  it('does not restore prices from a pending request after its consumer unmounts', async () => {
    let resolve!: (value: ProductRecommendationsResponse) => void
    request.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    const root = await mount()
    root.unmount()
    roots.splice(roots.indexOf(root), 1)
    resolve(response(333))
    await flushPromises()
    expect(model.strips.value).toEqual([])
  })
})
