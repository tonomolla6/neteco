import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SupportKnowledgePanel from '../../app/components/SupportKnowledgePanel.vue'
import HelpPage from '../../app/pages/ayuda.vue'
import '#app/nuxt-vitest-app-entry'

// SUP-007 UI acceptance matrix: confirmed published-CMS links and real categories;
// explicit query/category submit, bounded pagination, loading/error/empty separation;
// stale responses, runtime changes and unmount cannot replace current results;
// invalid/private/external DTOs never render; keyboard labels/mobile wrapping;
// optional feedback is visible only when the server enables its real endpoint;
// original useful links and contact remain available in both runtimes.
const mocks = vi.hoisted(() => ({ request: vi.fn(), runtime: { value: 'cloudflare' } }))
mockNuxtImport('useRequestFetch', () => () => mocks.request)
mockNuxtImport('useRuntimeConfig', () => () => ({
  app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
  public: { serverRuntime: mocks.runtime.value }
}))
const article = {
  id: '10000000-0000-4000-8000-000000000001',
  versionId: '20000000-0000-4000-8000-000000000001',
  slug: 'seguir-envio',
  title: 'Cómo consultar tu envío',
  excerpt: 'Consulta el estado desde tu pedido.',
  category: 'envios',
  reviewedAt: '2026-10-01T00:00:00Z',
  reviewDueAt: '2026-12-01T00:00:00Z'
}
function list(items = [article], extra = {}) {
  return {
    source: 'cloudflare',
    items,
    categories: [{ id: 'envios', label: 'Envíos' }],
    total: items.length,
    page: 1,
    perPage: 10,
    feedbackEnabled: false,
    ...extra
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const mounted: Array<{ unmount: () => void }> = []
const Link = defineComponent({
  props: { to: String },
  setup:
    (props, { slots }) =>
    () =>
      h('a', { href: props.to }, slots.default?.())
})
async function render(runtime: unknown = 'cloudflare') {
  const wrapper = await mountSuspended(SupportKnowledgePanel, {
    props: { runtime },
    global: { stubs: { NuxtLink: Link } }
  })
  mounted.push(wrapper)
  await flushPromises()
  return wrapper
}
beforeEach(() => {
  mocks.request.mockReset().mockResolvedValue(list())
  mocks.runtime.value = 'cloudflare'
})
afterEach(() => {
  mounted.splice(0).forEach((wrapper) => wrapper.unmount())
  vi.restoreAllMocks()
})

describe('searchable published help centre', () => {
  it('shows confirmed CMS articles with canonical local links, review dates and real categories', async () => {
    const wrapper = await render()
    expect(wrapper.text()).toContain(article.title)
    expect(wrapper.get('[data-help-article]').attributes('href')).toBe('/contenido/seguir-envio')
    expect(wrapper.get('[data-help-category]').text()).toContain('Envíos')
    expect(wrapper.text()).toContain('2026-10-01')
    expect(wrapper.text()).not.toContain('Cada semana')
  })
  it('uses native labelled search/category controls and mobile-safe result wrapping', async () => {
    const wrapper = await render()
    const input = wrapper.get('[data-help-query]')
    expect(wrapper.find(`label[for="${input.attributes('id')}"]`).exists()).toBe(true)
    expect(wrapper.get('[data-help-form]').element.tagName).toBe('FORM')
    expect(wrapper.get('[data-help-results]').attributes('class')).toContain('break-words')
  })
  it('does not query while typing; submitting explicitly applies both query and category', async () => {
    const wrapper = await render()
    const count = mocks.request.mock.calls.length
    await wrapper.get('[data-help-query]').setValue('  mi envío  ')
    await wrapper.get('[data-help-category]').setValue('envios')
    expect(mocks.request).toHaveBeenCalledTimes(count)
    await wrapper.get('[data-help-form]').trigger('submit')
    await flushPromises()
    expect(mocks.request.mock.calls.at(-1)![1].query).toEqual({
      q: 'mi envío',
      category: 'envios',
      page: 1,
      perPage: 10
    })
  })
  it('reports pending loading rather than empty results', async () => {
    const pending = deferred<unknown>()
    mocks.request.mockReturnValueOnce(pending.promise)
    const wrapper = await render()
    expect(wrapper.find('[data-help-loading]').exists()).toBe(true)
    expect(wrapper.find('[data-help-empty]').exists()).toBe(false)
    pending.resolve(list())
    await flushPromises()
    expect(wrapper.text()).toContain(article.title)
  })
  it('keeps error distinct from empty results and supports an explicit read retry', async () => {
    mocks.request.mockRejectedValueOnce(new Error('offline'))
    const wrapper = await render()
    expect(wrapper.find('[data-help-error]').exists()).toBe(true)
    expect(wrapper.find('[data-help-empty]').exists()).toBe(false)
    await wrapper.get('[data-help-retry]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain(article.title)
  })
  it('reports a confirmed empty result with contact and useful next steps, not invented FAQs', async () => {
    mocks.request.mockResolvedValueOnce(list([], { categories: [] }))
    const wrapper = await render()
    expect(wrapper.find('[data-help-empty]').exists()).toBe(true)
    expect(wrapper.get('[data-help-contact]').attributes('href')).toBe('/contacto')
    expect(wrapper.text()).not.toContain(article.title)
  })
  it('paginates the submitted query, not later unsent input changes', async () => {
    const pageItems = Array.from({ length: 10 }, (_, index) => ({
      ...article,
      id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
    }))
    mocks.request.mockResolvedValueOnce(list(pageItems, { total: 12 }))
    const wrapper = await render()
    await wrapper.get('[data-help-query]').setValue('sin enviar')
    mocks.request.mockResolvedValueOnce(list(pageItems.slice(0, 2), { total: 12, page: 2 }))
    await wrapper.get('[data-help-next]').trigger('click')
    await flushPromises()
    expect(mocks.request.mock.calls.at(-1)![1].query).toMatchObject({ q: '', page: 2 })
    expect(wrapper.get('[data-help-next]').attributes('disabled')).toBeDefined()
  })
  it('never lets an older successful response replace a newer submitted search', async () => {
    const wrapper = await render(),
      pending = deferred<unknown>()
    mocks.request.mockReturnValueOnce(pending.promise)
    await wrapper.get('[data-help-query]').setValue('anterior')
    await wrapper.get('[data-help-form]').trigger('submit')
    mocks.request.mockResolvedValueOnce(list([{ ...article, title: 'Resultado nuevo' }]))
    await wrapper.get('[data-help-query]').setValue('nueva')
    await wrapper.get('[data-help-form]').trigger('submit')
    await flushPromises()
    pending.resolve(list())
    await flushPromises()
    expect(wrapper.text()).toContain('Resultado nuevo')
    expect(wrapper.text()).not.toContain(article.title)
  })
  it('does not allow an old failure to overwrite newer results', async () => {
    const wrapper = await render()
    let reject!: (error: unknown) => void
    mocks.request.mockReturnValueOnce(
      new Promise((_resolve, fail) => {
        reject = fail
      })
    )
    await wrapper.get('[data-help-form]').trigger('submit')
    mocks.request.mockResolvedValueOnce(list([{ ...article, title: 'Última búsqueda' }]))
    await wrapper.get('[data-help-form]').trigger('submit')
    await flushPromises()
    reject(new Error('old failure'))
    await flushPromises()
    expect(wrapper.text()).toContain('Última búsqueda')
    expect(wrapper.find('[data-help-error]').exists()).toBe(false)
  })
  it.each([
    { extra: true },
    { items: [{ ...article, slug: 'https://externo.example/evil' }] },
    { source: 'node' },
    { page: 2 }
  ])('rejects malformed, mismatched or unsafe result DTO %j', async (extra) => {
    mocks.request.mockResolvedValueOnce(list([article], extra))
    const wrapper = await render()
    expect(wrapper.find('[data-help-error]').exists()).toBe(true)
    expect(wrapper.find('[data-help-article]').exists()).toBe(false)
  })
  it.each(['node', 'unknown'])('does not invent a knowledge endpoint for runtime %s', async (runtime) => {
    await render(runtime)
    expect(mocks.request).not.toHaveBeenCalled()
  })
  it('invalidates a pending request if the runtime changes', async () => {
    const pending = deferred<unknown>()
    mocks.request.mockReturnValueOnce(pending.promise)
    const wrapper = await render()
    await wrapper.setProps({ runtime: 'node' })
    pending.resolve(list())
    await flushPromises()
    expect(wrapper.find('[data-help-article]').exists()).toBe(false)
  })
  it('does not schedule follow-up reads after unmount', async () => {
    const pending = deferred<unknown>()
    mocks.request.mockReturnValueOnce(pending.promise)
    const wrapper = await render(),
      count = mocks.request.mock.calls.length
    wrapper.unmount()
    pending.resolve(list())
    await flushPromises()
    expect(mocks.request).toHaveBeenCalledTimes(count)
  })
  it('does not offer a feedback mutation when the server has not enabled it', async () => {
    const wrapper = await render()
    expect(wrapper.find('[data-help-feedback]').exists()).toBe(false)
    expect(mocks.request.mock.calls.every(([, options]) => options.method === 'GET')).toBe(true)
  })
  it('records optional anonymous helpful feedback only on an explicit click and confirmed receipt', async () => {
    mocks.request.mockResolvedValueOnce(list([article], { feedbackEnabled: true }))
    const wrapper = await render()
    expect(mocks.request).toHaveBeenCalledTimes(1)
    mocks.request.mockResolvedValueOnce({
      source: 'cloudflare',
      feedbackId: article.id,
      pageId: article.id,
      versionId: article.versionId,
      helpful: true,
      recorded: true
    })
    await wrapper.get('[data-help-yes]').trigger('click')
    await flushPromises()
    const command = mocks.request.mock.calls.at(-1)!
    expect(command[0]).toBe('/api/support/knowledge/feedback')
    expect(command[1]).toMatchObject({
      method: 'POST',
      retry: 0,
      body: { pageId: article.id, versionId: article.versionId, helpful: true }
    })
    expect(command[1].headers['Idempotency-Key']).toMatch(/^[a-f0-9-]{36}$/)
    expect(wrapper.text()).toContain('Gracias. Tu valoración se ha registrado')
  })
  it('blocks double feedback clicks and never treats a lost response as success', async () => {
    mocks.request.mockResolvedValueOnce(list([article], { feedbackEnabled: true }))
    const wrapper = await render(),
      pending = deferred<unknown>()
    mocks.request.mockReturnValueOnce(pending.promise)
    await wrapper.get('[data-help-no]').trigger('click')
    await wrapper.get('[data-help-no]').trigger('click')
    expect(mocks.request.mock.calls.filter(([, options]) => options.method === 'POST')).toHaveLength(1)
    pending.resolve({ unexpected: true })
    await flushPromises()
    expect(wrapper.text()).not.toContain('Tu valoración se ha registrado')
    expect(wrapper.find('[data-help-feedback-lookup]').exists()).toBe(true)
  })
  it('recovers unknown feedback by manual receipt lookup without re-posting', async () => {
    mocks.request.mockResolvedValueOnce(list([article], { feedbackEnabled: true }))
    const wrapper = await render()
    mocks.request.mockRejectedValueOnce(new Error('lost response'))
    await wrapper.get('[data-help-no]').trigger('click')
    await flushPromises()
    const command = mocks.request.mock.calls.at(-1)!
    mocks.request.mockResolvedValueOnce({
      source: 'cloudflare',
      feedbackId: article.id,
      pageId: article.id,
      versionId: article.versionId,
      helpful: false,
      recorded: true
    })
    await wrapper.get('[data-help-feedback-lookup]').trigger('click')
    await flushPromises()
    expect(mocks.request.mock.calls.at(-1)![0]).toBe(
      '/api/support/knowledge/feedback/' + command[1].headers['Idempotency-Key']
    )
    expect(mocks.request.mock.calls.filter(([, options]) => options.method === 'POST')).toHaveLength(1)
    expect(wrapper.text()).toContain('Gracias. Tu valoración se ha registrado')
  })
  it('does not claim feedback success for a withdrawn article or a mismatched receipt', async () => {
    mocks.request.mockResolvedValueOnce(list([article], { feedbackEnabled: true }))
    const wrapper = await render()
    mocks.request.mockRejectedValueOnce({ statusCode: 409, data: { error: { code: 'article_unavailable' } } })
    await wrapper.get('[data-help-yes]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).not.toContain('Tu valoración se ha registrado')
    expect(wrapper.text()).toContain('No se ha registrado la valoración')
    expect(mocks.request.mock.calls.filter(([, options]) => options.method === 'POST')).toHaveLength(1)
  })
  it.each(['node', 'cloudflare'])(
    'preserves existing useful links and contact in the %s help page',
    async (runtime) => {
      mocks.runtime.value = runtime
      const wrapper = await mountSuspended(HelpPage, {
        global: { stubs: { NuxtLink: Link, UIcon: true, SupportKnowledgePanel: true } }
      })
      mounted.push(wrapper)
      for (const path of ['/envios', '/formas-de-pago', '/devoluciones', '/cuenta', '/cuenta/pedidos', '/contacto'])
        expect(wrapper.find(`a[href="${path}"]`).exists()).toBe(true)
      expect(wrapper.find('a[href="mailto:tienda@neteco.es"]').exists()).toBe(true)
      expect(wrapper.find('support-knowledge-panel-stub').exists()).toBe(runtime === 'cloudflare')
    }
  )
})
