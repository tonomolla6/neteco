import { useNuxtApp } from '#app'
import { createSSRApp, defineComponent, h, nextTick } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ProductGrid from '../../app/components/ProductGrid.vue'
import ViewToggle from '../../app/components/ViewToggle.vue'
import '#app/nuxt-vitest-app-entry'

const Root = defineComponent({
  setup: () => () => h('div', [h(ViewToggle), h(ProductGrid, { items: [], pending: true })])
})

function setView(view: 'grid' | 'list') {
  document.cookie = `catalog_view=${view}; path=/`
}

afterEach(() => {
  document.cookie = 'catalog_view=; max-age=0; path=/'
  delete useNuxtApp().payload.state['$scatalog-view-hydration']
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('hydration of the catalog view preference', () => {
  it.each([
    { server: 'grid' as const, client: 'list' as const },
    { server: 'list' as const, client: 'grid' as const },
    { server: 'grid' as const, client: 'grid' as const },
    { server: 'list' as const, client: 'list' as const }
  ])('hydrates the saved $client view over cached $server markup', async ({ server, client }) => {
    setView(server)
    const html = await renderToString(createSSRApp(Root))
    const root = document.createElement('div')
    root.innerHTML = html
    document.body.append(root)
    const selected = (view: 'grid' | 'list') =>
      root.querySelector<HTMLButtonElement>(
        `[aria-label="${view === 'grid' ? 'Vista de cuadrícula' : 'Vista de lista'}"]`
      )!
    const skeletons = () => root.querySelector('div[aria-hidden="true"]')!
    expect(selected(server).getAttribute('aria-pressed')).toBe('true')
    expect(skeletons().children.length).toBe(server === 'grid' ? 10 : 8)

    setView(client)
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const clientApp = createSSRApp(Root)
    try {
      clientApp.mount(root)
      await nextTick()
      await nextTick()
      expect(selected(client).getAttribute('aria-pressed')).toBe('true')
      expect(skeletons().children.length).toBe(client === 'grid' ? 10 : 8)
      expect([...warnings.mock.calls, ...errors.mock.calls].flat().map(String).join(' ')).not.toMatch(
        /hydration.*mismatch/i
      )
      const next = client === 'grid' ? 'list' : 'grid'
      selected(next).click()
      await nextTick()
      await nextTick()
      expect(selected(next).getAttribute('aria-pressed')).toBe('true')
      expect(skeletons().children.length).toBe(next === 'grid' ? 10 : 8)
      expect(document.cookie).toContain(`catalog_view=${next}`)
    } finally {
      clientApp.unmount()
    }
  })
})
