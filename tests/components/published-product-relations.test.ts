import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Panel from '../../app/components/PublishedProductRelations.vue'
import { publicCatalogRelationsSchema } from '../../shared/catalog-relations'
import '#app/nuxt-vitest-app-entry'

// Current-public contract: four directed types, never an inverse/chemical claim;
// one deduplicated sequential batch per <=20 origins, no per-line reads or ADD;
// strict source correlation, real empty distinct from failure/malformed,
// changing origins invalidates late responses; Node and unmount boundaries.
const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  add: vi.fn(),
  runtime: vi.fn(() => ({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'cloudflare' }
  }))
}))
mockNuxtImport('useRequestFetch', () => () => mocks.request)
mockNuxtImport('useRuntimeConfig', () => mocks.runtime)
vi.mock('../../app/stores/cart', () => ({ useCartStore: () => ({ add: mocks.add }) }))
const kinds = ['substitute', 'compatible', 'accessory', 'equivalent'] as const
const labels = ['Sustitución', 'Compatibilidad', 'Accesorios', 'Equivalencia']
function result(slugs: string[], empty = false) {
  return publicCatalogRelationsSchema.parse({
    source: 'cloudflare',
    groups: slugs.map((slug, index) => ({
      productId: index + 1,
      productSlug: slug,
      items: empty
        ? []
        : kinds.map((kind, offset) => ({
            kind,
            productId: 100 + offset,
            slug: `destino-${kind}`,
            name: `Destino ${kind}`,
            brand: 'NETECO',
            minPrice: 1210,
            minNetPrice: 1000,
            formats: 1
          }))
    }))
  })
}
function deferred() {
  let resolve!: (value: unknown) => void
  const promise = new Promise<unknown>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
const mounted: Awaited<ReturnType<typeof mountSuspended>>[] = []
async function render(slugs = ['origen']) {
  const wrapper = await mountSuspended(Panel, { props: { productSlugs: slugs } })
  mounted.push(wrapper)
  await flushPromises()
  return wrapper
}
beforeEach(() => {
  mocks.add.mockReset()
  mocks.runtime.mockReturnValue({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'cloudflare' }
  })
  mocks.request.mockReset().mockImplementation(async (_path, options) => result(options.query.slugs.split(',')))
})
afterEach(() => {
  mounted.splice(0).forEach((wrapper) => wrapper.unmount())
  vi.restoreAllMocks()
})

it('renders four explicit directed groups with public PDP links/prices and no cart action or chemical claim', async () => {
  const wrapper = await render()
  expect(mocks.request).toHaveBeenCalledWith(
    '/api/product-relations',
    expect.objectContaining({ query: { slugs: 'origen' }, retry: 0 })
  )
  for (const label of labels) expect(wrapper.text()).toContain(label)
  for (const kind of kinds) expect(wrapper.find(`a[href="/producto/destino-${kind}"]`).exists()).toBe(true)
  expect(wrapper.text()).toMatch(/12,10\s*€/)
  expect(wrapper.text()).toContain('no confirma compatibilidad química')
  expect(mocks.add).not.toHaveBeenCalled()
  expect(mocks.request.mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true)
})
it('deduplicates cart product slugs and chunks 21 origins into two sequential batches, never per-line fetches', async () => {
  const first = deferred(),
    slugs = Array.from({ length: 21 }, (_, index) => `origen-${index}`)
  mocks.request
    .mockImplementationOnce(() => first.promise)
    .mockImplementation(async (_path, options) => result(options.query.slugs.split(',')))
  const wrapper = await render([...slugs, ...slugs])
  expect(mocks.request).toHaveBeenCalledTimes(1)
  expect(mocks.request.mock.calls[0]![1].query.slugs.split(',')).toEqual(slugs.slice(0, 20))
  first.resolve(result(slugs.slice(0, 20)))
  await flushPromises()
  expect(mocks.request).toHaveBeenCalledTimes(2)
  expect(mocks.request.mock.calls[1]![1].query.slugs).toBe(slugs[20])
  expect(wrapper.text()).toContain('Destino accessory')
  expect(mocks.add).not.toHaveBeenCalled()
})
it('separates a confirmed empty relation list from a failed read', async () => {
  mocks.request.mockResolvedValue(result(['origen'], true))
  const wrapper = await render()
  expect(wrapper.text()).toContain('No hay relaciones publicadas')
  expect(wrapper.find('[role="alert"]').exists()).toBe(false)
})
it('accepts omitted unpublished origins without fabricating groups or reporting an outage', async () => {
  mocks.request.mockResolvedValue({ source: 'cloudflare', groups: [] })
  const wrapper = await render(['retirado'])
  expect(wrapper.text()).toContain('No hay relaciones publicadas')
  expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  expect(mocks.add).not.toHaveBeenCalled()
})
it.each(['failure', 'malformed', 'foreign-origin'])(
  'fails closed for %s without showing stale destinations or false empty',
  async (mode) => {
    if (mode === 'failure') mocks.request.mockRejectedValue(new Error('private SQL error'))
    else
      mocks.request.mockResolvedValue(
        mode === 'malformed' ? { source: 'cloudflare', groups: [{}] } : result(['otra-fuente'])
      )
    const wrapper = await render()
    expect(wrapper.find('[role="alert"]').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('No hay relaciones publicadas')
    expect(wrapper.text()).not.toContain('Destino accessory')
    expect(wrapper.text()).not.toContain('private SQL')
    expect(mocks.add).not.toHaveBeenCalled()
  }
)
it('offers explicit singleflight GET recovery after a read error', async () => {
  mocks.request.mockRejectedValueOnce(new Error('outage'))
  const wrapper = await render()
  await wrapper.get('[data-relations-refresh]').trigger('click')
  await flushPromises()
  expect(mocks.request).toHaveBeenCalledTimes(2)
  expect(wrapper.text()).toContain('Destino accessory')
})
it('origin changes purge the old result and reject its late response', async () => {
  const late = deferred()
  mocks.request.mockImplementationOnce(() => late.promise)
  const wrapper = await render(['origen-antiguo'])
  await wrapper.setProps({ productSlugs: ['origen-nuevo'] })
  await flushPromises()
  late.resolve(result(['origen-antiguo']))
  await flushPromises()
  expect(wrapper.text()).not.toContain('origen-antiguo')
  expect(mocks.request.mock.calls.at(-1)![1].query.slugs).toBe('origen-nuevo')
  expect(wrapper.text()).toContain('Destino accessory')
})
it('does not infer a reverse relation when only the destination is requested', async () => {
  mocks.request.mockResolvedValue(result(['destino'], true))
  const wrapper = await render(['destino'])
  expect(wrapper.text()).toContain('No hay relaciones publicadas')
  expect(wrapper.text()).not.toContain('Destino substitute')
})
it('keeps Node unchanged and does not call the D1-only endpoint', async () => {
  mocks.runtime.mockReturnValue({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'node' }
  })
  await render()
  expect(mocks.request).not.toHaveBeenCalled()
})
it('an empty origin set neither fetches nor exposes old groups', async () => {
  const wrapper = await render()
  await wrapper.setProps({ productSlugs: [] })
  expect(wrapper.text()).not.toContain('Destino accessory')
  expect(mocks.request).toHaveBeenCalledTimes(1)
})
