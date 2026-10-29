import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ResourceHubPanel from '../../app/components/ResourceHubPanel.vue'
import '#app/nuxt-vitest-app-entry'
const { request } = vi.hoisted(() => ({ request: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => request)
const editorial = {
  kind: 'article',
  category: { slug: 'limpieza', label: 'Limpieza' },
  author: { name: 'Autora sintética', experience: 'Experiencia profesional sintética para pruebas.' },
  reviewedAt: '2026-10-09T00:00:00Z',
  reviewDueAt: '2027-10-09T00:00:00Z',
  pillarSlug: null,
  relatedProducts: [],
  relatedCategories: [],
  relatedResources: []
}
const summary = () => ({
  slug: 'guia-profesional',
  title: 'Guía profesional',
  description: 'Guía sintética de limpieza profesional.',
  editorial,
  publishedAt: '2026-10-09T01:00:00Z',
  canonicalPath: '/recursos/guia-profesional',
  noindex: false
})
const listing = () => ({
  source: 'cloudflare',
  items: [summary()],
  categories: [editorial.category],
  page: 1,
  perPage: 20,
  total: 1,
  pages: 1,
  noindex: false,
  canonicalPath: '/recursos'
})
const detail = () => ({
  ...summary(),
  source: 'cloudflare',
  version: 1,
  preview: false,
  blocks: [{ id: '10000000-0000-4000-8000-000000000001', type: 'paragraph', text: 'Contenido revisado sintético.' }],
  media: {},
  relatedProducts: [{ id: 1, slug: 'producto-publicado', name: 'Producto publicado' }],
  relatedCategories: [{ slug: 'limpieza', name: 'Limpieza' }],
  relatedResources: []
})
let wrapper: Awaited<ReturnType<typeof mountSuspended>> | undefined
beforeEach(() => {
  request.mockReset()
})
afterEach(() => wrapper?.unmount())
describe('resource hub compiled public UI contract', () => {
  it('reads page two and its filters from the URL and renders crawlable previous/next links', async () => {
    request.mockResolvedValue({
      ...listing(),
      items: [
        {
          ...summary(),
          slug: 'segunda-pagina',
          title: 'Sólo segunda página',
          canonicalPath: '/recursos/segunda-pagina'
        }
      ],
      page: 2,
      total: 41,
      pages: 3
    })
    wrapper = await mountSuspended(ResourceHubPanel, {
      props: { enabled: true },
      route: '/recursos?q=limpieza&category=limpieza&kind=article&page=2'
    })
    await flushPromises()
    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith(
      '/api/resources',
      expect.objectContaining({
        query: { q: 'limpieza', category: 'limpieza', kind: 'article', page: 2, perPage: 20 },
        retry: 0
      })
    )
    expect(wrapper.text()).toContain('Sólo segunda página')
    expect(wrapper.text()).not.toContain('Guía profesional')
    const links = wrapper.findAll('nav[aria-label="Páginas de recursos"] a[href]')
    const previous = links.find((link) => link.text().includes('Anteriores'))
    const next = links.find((link) => link.text().includes('Siguientes'))
    expect(previous, 'previous page must be discoverable without JavaScript').toBeDefined()
    expect(next, 'next page must be discoverable without JavaScript').toBeDefined()
    const previousUrl = new URL(previous!.attributes('href'), 'https://resources.neteco.test')
    const nextUrl = new URL(next!.attributes('href'), 'https://resources.neteco.test')
    expect(previousUrl.pathname).toBe('/recursos')
    expect(Object.fromEntries(previousUrl.searchParams)).toEqual({
      q: 'limpieza',
      category: 'limpieza',
      kind: 'article'
    })
    expect(Object.fromEntries(nextUrl.searchParams)).toEqual({
      q: 'limpieza',
      category: 'limpieza',
      kind: 'article',
      page: '3'
    })
  })
  it.each([1, 3])('only links to valid adjacent pages at page %i', async (page) => {
    request.mockResolvedValue({ ...listing(), page, total: 41, pages: 3 })
    wrapper = await mountSuspended(ResourceHubPanel, { props: { enabled: true }, route: `/recursos?page=${page}` })
    await flushPromises()
    const links = wrapper.findAll('nav[aria-label="Páginas de recursos"] a[href]')
    expect(links.some((link) => link.text().includes('Anteriores'))).toBe(page > 1)
    expect(links.some((link) => link.text().includes('Siguientes'))).toBe(page < 3)
    expect(links).toHaveLength(1)
    expect(new URL(links[0]!.attributes('href'), 'https://resources.neteco.test').searchParams.get('page')).toBe('2')
  })
  it('applies filters through the URL and resets page two to the first page', async () => {
    request.mockResolvedValue({ ...listing(), page: 2, total: 21, pages: 2 })
    wrapper = await mountSuspended(ResourceHubPanel, {
      props: { enabled: true },
      route: '/recursos?q=limpieza&category=limpieza&kind=article&page=2'
    })
    await flushPromises()
    await wrapper.get('[data-resource-query]').setValue('consulta profesional')
    expect(request).toHaveBeenCalledTimes(1)
    request.mockResolvedValue(listing())
    await wrapper.get('form[data-resource-search]').trigger('submit')
    await vi.waitFor(() =>
      expect(wrapper!.vm.$router.currentRoute.value.query).toEqual({
        q: 'consulta profesional',
        category: 'limpieza',
        kind: 'article'
      })
    )
    await flushPromises()
    expect(request).toHaveBeenLastCalledWith(
      '/api/resources',
      expect.objectContaining({
        query: { q: 'consulta profesional', category: 'limpieza', kind: 'article', page: 1, perPage: 20 }
      })
    )
  })
  it('removes stale page rows and pagination when the URL changes and the next read fails', async () => {
    request.mockResolvedValueOnce({ ...listing(), page: 2, total: 41, pages: 3 })
    wrapper = await mountSuspended(ResourceHubPanel, { props: { enabled: true }, route: '/recursos?page=2' })
    await flushPromises()
    expect(wrapper.text()).toContain('Guía profesional')
    request.mockRejectedValueOnce({ statusCode: 503 })
    await wrapper.vm.$router.push('/recursos?page=3')
    await flushPromises()
    expect(wrapper.find('[role="alert"]').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('Guía profesional')
    expect(wrapper.find('nav[aria-label="Páginas de recursos"]').exists()).toBe(false)
  })
  it('loads published resources and exposes category and bounded explicit search', async () => {
    request.mockResolvedValueOnce(listing())
    wrapper = await mountSuspended(ResourceHubPanel, { props: { enabled: true }, route: '/recursos' })
    await flushPromises()
    expect(wrapper.text()).toContain('Guía profesional')
    expect(wrapper.get('[data-resource-query]').attributes('maxlength')).toBe('80')
    expect(wrapper.get('a[href="/recursos/guia-profesional"]').text()).toContain('Guía profesional')
    expect(wrapper.get('[data-resource-category]').text()).toContain('Limpieza')
  })
  it('sends search only on explicit submit and never posts analytics or newsletters itself', async () => {
    request.mockResolvedValue(listing())
    wrapper = await mountSuspended(ResourceHubPanel, { props: { enabled: true }, route: '/recursos' })
    await flushPromises()
    await wrapper.get('[data-resource-query]').setValue('consulta profesional')
    expect(request).toHaveBeenCalledTimes(1)
    await wrapper.get('form[data-resource-search]').trigger('submit')
    await vi.waitFor(() => {
      expect(wrapper!.vm.$router.currentRoute.value.query).toEqual({ q: 'consulta profesional' })
      expect(request).toHaveBeenLastCalledWith(
        '/api/resources',
        expect.objectContaining({ query: expect.objectContaining({ q: 'consulta profesional', page: 1, perPage: 20 }) })
      )
    })
    expect(request).toHaveBeenCalledTimes(2)
    expect(request.mock.calls.every((call) => !call[1]?.method || call[1].method === 'GET')).toBe(true)
  })
  it('shows author experience, published and review dates with escaped content', async () => {
    const dto = detail()
    dto.blocks[0]!.text = '<script>private()</script>'
    request.mockResolvedValue(dto)
    wrapper = await mountSuspended(ResourceHubPanel, { props: { enabled: true, slug: 'guia-profesional' } })
    await flushPromises()
    expect(wrapper.text()).toContain('Autora sintética')
    expect(wrapper.text()).toContain(editorial.author.experience)
    expect(wrapper.findAll('time[datetime]').length).toBeGreaterThanOrEqual(3)
    expect(wrapper.find('script').exists()).toBe(false)
    expect(wrapper.text()).toContain('<script>private()</script>')
  })
  it('links only server-confirmed products and category filters and keeps newsletter double opt-in separate', async () => {
    request.mockResolvedValue(detail())
    wrapper = await mountSuspended(ResourceHubPanel, { props: { enabled: true, slug: 'guia-profesional' } })
    await flushPromises()
    expect(wrapper.get('a[href="/producto/producto-publicado"]').text()).toContain('Producto publicado')
    expect(wrapper.get('a[href="/catalogo?familia=limpieza"]').text()).toContain('Limpieza')
    expect(wrapper.text()).toContain('doble confirmación')
    expect(wrapper.find('input[type="email"]').exists()).toBe(false)
  })
  it('purges a previous resource when the next source fails instead of presenting it as current', async () => {
    request.mockResolvedValueOnce(detail())
    wrapper = await mountSuspended(ResourceHubPanel, { props: { enabled: true, slug: 'guia-profesional' } })
    await flushPromises()
    request.mockRejectedValueOnce({ statusCode: 503 })
    await wrapper.setProps({ slug: 'otro-recurso' })
    await flushPromises()
    expect(wrapper.text()).not.toContain('Autora sintética')
    expect(wrapper.text()).toContain('No se ha podido confirmar')
    expect(wrapper.text()).not.toContain('No hay recursos publicados')
  })
  it('does not expose resources on Node or retain late answers after scope disable', async () => {
    let resolve!: (value: unknown) => void
    request.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done
      })
    )
    wrapper = await mountSuspended(ResourceHubPanel, { props: { enabled: true } })
    await wrapper.setProps({ enabled: false })
    resolve(listing())
    await flushPromises()
    expect(wrapper.text()).not.toContain('Guía profesional')
    expect(wrapper.find('[data-resource-query]').exists()).toBe(false)
  })
})
