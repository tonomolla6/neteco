import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Page from '../../app/pages/newsletter/preferencias.vue'
import '#app/nuxt-vitest-app-entry'
const { fetchMock, seoMock, headMock } = vi.hoisted(() => ({ fetchMock: vi.fn(), seoMock: vi.fn(), headMock: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => fetchMock)
mockNuxtImport('useSeoMeta', () => seoMock)
mockNuxtImport('useHead', () => headMock)
const SUB = '10000000-0000-4000-8000-000000000050',
  PROOF = `n1.${SUB}.${'a'.repeat(64)}`,
  TOKEN = `np1.${SUB}.1799999999.${'b'.repeat(64)}`
let wrapper: Awaited<ReturnType<typeof mountSuspended>> | undefined, previousUrl: string
beforeEach(() => {
  previousUrl = window.location.pathname + window.location.search + window.location.hash
  fetchMock.mockReset()
  seoMock.mockClear()
  headMock.mockClear()
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  window.history.replaceState({}, '', previousUrl)
})
async function render(query = `confirm=${PROOF}`) {
  window.history.replaceState({}, '', `/newsletter/preferencias?${query}`)
  wrapper = await mountSuspended(Page, { route: false })
  await flushPromises()
  return wrapper
}
describe('anonymous preference access explicit DOI-proof UI', () => {
  it('removes proof from URL and waits for an explicit user action', async () => {
    const w = await render()
    expect(window.location.search).toBe('')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(w.text()).toContain('Obtener acceso a mis preferencias')
    expect(seoMock).toHaveBeenCalledWith(expect.objectContaining({ robots: 'noindex, nofollow, noarchive' }))
    expect(headMock).toHaveBeenCalledWith(
      expect.objectContaining({ meta: [{ name: 'referrer', content: 'no-referrer' }] })
    )
  })
  it('exchanges proof only after click, then reads preferences without saving defaults', async () => {
    fetchMock.mockImplementation(async (path) =>
      path.endsWith('/access')
        ? { source: 'cloudflare', token: TOKEN, expiresInSeconds: 1800 }
        : {
            source: 'cloudflare',
            subscriptionId: SUB,
            status: 'confirmed',
            revision: 0,
            preference: null,
            topics: [],
            canSave: true,
            canUnsubscribe: true,
            externalDelivery: false
          }
    )
    const w = await render()
    await w.find('button').trigger('click')
    await flushPromises()
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/newsletter/preferences/access')
    expect(fetchMock.mock.calls[0]![1].body).toEqual({ confirmationToken: PROOF })
    expect(fetchMock.mock.calls[1]![1].headers.Authorization).toBe(`Bearer ${TOKEN}`)
    expect(fetchMock.mock.calls.filter((c) => c[1]?.method === 'PUT')).toHaveLength(0)
    expect(w.find<HTMLSelectElement>('select[aria-label="Frecuencia newsletter"]').element.value).toBe('')
    expect(w.text()).not.toContain(PROOF)
    expect(w.text()).not.toContain(TOKEN)
  })
  it('does not manufacture capability or automatically retry a rejected proof', async () => {
    fetchMock.mockRejectedValue(new Error('expired or suppressed'))
    const w = await render()
    await w.find('button').trigger('click')
    await flushPromises()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(w.text()).toContain('No hay acceso confirmado')
    expect(w.find('form').exists()).toBe(false)
  })
  it('rejects duplicate proof parameters and removes them all', async () => {
    const w = await render(`confirm=${PROOF}&confirm=${PROOF}`)
    expect(window.location.search).toBe('')
    expect(w.find('button').exists()).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
