import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h, nextTick, proxyRefs, reactive, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Readiness from '../../app/components/CatalogPublicationReadiness.vue'
import ProductPage from '../../app/pages/admin/productos/[id].vue'
import '#app/nuxt-vitest-app-entry'

const { fetchMock, mutationMock, refreshMock, runtimeMock, routeMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  mutationMock: vi.fn(),
  refreshMock: vi.fn(),
  runtimeMock: vi.fn(() => ({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'cloudflare' }
  })),
  routeMock: vi.fn()
}))
mockNuxtImport('useFetch', () => fetchMock)
// ProductRelationsEditor reads /api/admin/capabilities through useAdminNavigation on mount. That GET is
// read-only navigation metadata (answered "unavailable" here); everything else still reaches mutationMock,
// whose "no writes" assertions stay intact.
mockNuxtImport(
  '$fetch',
  () =>
    (path: unknown, ...rest: unknown[]) =>
      path === '/api/admin/capabilities'
        ? Promise.resolve(undefined)
        : (mutationMock as (...args: unknown[]) => unknown)(path, ...rest)
)
mockNuxtImport('useRuntimeConfig', () => runtimeMock)
mockNuxtImport('useRoute', () => routeMock)
mockNuxtImport('useToast', () => () => ({ add: () => undefined }))
mockNuxtImport('navigateTo', () => () => undefined)
mockNuxtImport('refreshNuxtData', () => async () => undefined)
mockNuxtImport('useUserSession', () => () => ({
  ready: ref(true),
  loggedIn: ref(true),
  user: ref({ id: 'synthetic-admin', role: 'admin', mfaVerified: true }),
  session: ref(null),
  clear: async () => undefined,
  openInPopup: () => undefined,
  fetch: async () => undefined
}))

const UUID = 'a1000000-0000-4000-8000-000000000001'
const PATH = '/api/admin/products/1/publication-readiness'
const ISSUE = { code: 'media.primary', path: 'image', message: 'Falta una imagen principal gobernada' }
const LIMITATION = { code: 'policy.product_type', path: 'policy', message: 'La política por tipo no está modelada' }
const receipt = () => ({
  source: 'cloudflare',
  advisory: true,
  publicationEnabled: false,
  productId: 1,
  productUuid: UUID,
  catalogVersion: 1,
  evaluatedAt: '2026-10-01T12:34:00Z',
  issues: [ISSUE],
  limitations: [LIMITATION]
})
const product = () => ({
  id: 1,
  uuid: UUID,
  catalogVersion: 1,
  source: 'cloudflare',
  capabilities: { productDetailRead: true, productReadinessRead: true, categoriesRead: true },
  name: 'Producto sintético',
  slug: 'producto-sintetico',
  brand: 'NETECO',
  categoryId: 7,
  shortDesc: 'Descripción sintética',
  description: 'Descripción sintética completa',
  usage: null,
  series: null,
  badges: [],
  visual: { type: 'caja', color: '#123456' },
  featured: false,
  active: false,
  status: 'draft',
  attrs: [],
  variants: []
})
const Button = defineComponent({
  inheritAttrs: false,
  props: { loading: Boolean, disabled: Boolean },
  setup:
    (props, { attrs, slots }) =>
    () =>
      h(
        'button',
        {
          ...attrs,
          type: attrs.type ?? 'button',
          disabled: props.disabled || props.loading
        },
        slots.default?.()
      )
})
const Slot = defineComponent({ template: '<div><slot /></div>' })
const stubs = {
  UButton: Button,
  UIcon: true,
  UBadge: Slot,
  UFormField: Slot,
  UInput: true,
  UTextarea: true,
  USelect: true,
  ProductVisual: true,
  DraftProductMetadataEditor: true
}
type Wrapper = Awaited<ReturnType<typeof mountSuspended>>
type Props = {
  productId: string
  productUuid: string
  catalogVersion: number
  runtime: unknown
  authorize: (identity: { id: number; uuid: string; version: number }) => boolean
}
let wrapper: Wrapper | undefined
let currentData: ReturnType<typeof ref<unknown>>
let currentStatus: ReturnType<typeof ref<string>>
let currentProduct: ReturnType<typeof ref<Record<string, unknown>>>
let detailStatus: ReturnType<typeof ref<string>>
let currentRuntime: {
  app: { baseURL: string; buildAssetsDir: string; cdnURL: string }
  public: { serverRuntime: string }
}

function setupFetch(data: unknown = receipt(), status = 'success') {
  currentData = ref(data)
  currentStatus = ref(status)
  fetchMock.mockImplementation((path: string) => {
    if (path.endsWith('/publication-readiness'))
      return { data: currentData, status: currentStatus, error: ref(null), refresh: refreshMock }
    if (path.endsWith('categories'))
      return {
        data: ref({
          roots: [],
          flat: [],
          source: currentRuntime.public.serverRuntime === 'node' ? undefined : 'cloudflare',
          capabilities: { categoriesRead: true }
        }),
        status: ref('success'),
        error: ref(null),
        refresh: vi.fn()
      }
    return { data: currentProduct, status: detailStatus, error: ref(null), refresh: vi.fn() }
  })
}
async function render(options: { data?: unknown; status?: string; props?: Partial<Props> } = {}) {
  setupFetch(Object.hasOwn(options, 'data') ? options.data : receipt(), options.status)
  wrapper = await mountSuspended(Readiness, {
    props: {
      productId: '1',
      productUuid: UUID,
      catalogVersion: 1,
      runtime: 'cloudflare',
      authorize: () => true,
      ...options.props
    },
    global: { stubs }
  })
  return wrapper
}
async function renderPage(
  options: { runtime?: string; id?: string; product?: Record<string, unknown>; status?: string } = {}
) {
  currentRuntime.public.serverRuntime = options.runtime ?? 'cloudflare'
  routeMock.mockReturnValue({
    params: { id: options.id ?? '1' },
    query: {},
    path: '/admin/productos/1',
    fullPath: '/admin/productos/1'
  })
  currentProduct = ref(options.product ?? product())
  detailStatus = ref(options.status ?? 'success')
  setupFetch()
  wrapper = await mountSuspended(ProductPage, { global: { stubs } })
  await flushPromises()
  return wrapper
}
function retry(page: Wrapper) {
  return proxyRefs(page.setupState).retry as () => Promise<void>
}

beforeEach(() => {
  fetchMock.mockReset()
  mutationMock.mockReset()
  refreshMock.mockReset().mockResolvedValue(undefined)
  currentRuntime = reactive({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'cloudflare' }
  })
  runtimeMock.mockReturnValue(currentRuntime)
  routeMock.mockReturnValue({
    params: { id: '1' },
    query: {},
    path: '/admin/productos/1',
    fullPath: '/admin/productos/1'
  })
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
})

describe('private advisory publication observations', () => {
  it('reads via SSR-compatible useFetch GET with a private identity/version cache key and no command', async () => {
    const page = await render()
    expect(fetchMock).toHaveBeenCalledOnce()
    // Nuxt appends its generated composable key; the caller's request contract
    // is the first two arguments and still must match exactly.
    expect(fetchMock.mock.calls[0]?.slice(0, 2)).toEqual([
      PATH,
      {
        key: `admin-product-publication-readiness-1-${UUID}-1`,
        method: 'GET',
        immediate: true,
        server: true,
        watch: false
      }
    ])
    expect(page.text()).toContain('no permite publicar')
    expect(page.text()).toContain(ISSUE.message)
    expect(page.text()).toContain(ISSUE.code)
    expect(page.text()).toContain(ISSUE.path)
    expect(page.text()).toContain(LIMITATION.message)
    expect(page.get('time').attributes('datetime')).toBe('2026-10-01T12:34:00Z')
    expect(page.get('time').text()).toContain('UTC')
    expect(page.get('[role="status"]').text()).toContain('Versión 1')
    expect(page.get('section').attributes('aria-busy')).toBe('false')
    expect(page.find('form, input, button[type="submit"]').exists()).toBe(false)
    expect(mutationMock).not.toHaveBeenCalled()
  })

  it.each([{ issues: [] }, { issues: [], limitations: [] }])(
    'does not equate empty observations to readiness or publication authority: %#',
    async (changes) => {
      const page = await render({ data: { ...receipt(), ...changes } })
      expect(page.text()).toContain('Esto no confirma completitud ni habilita publicación')
      expect(page.text()).toContain('Limitaciones de esta consulta')
      expect(page.html()).not.toMatch(/green-|color="success"/)
      expect(page.find('button').exists()).toBe(false)
      expect(mutationMock).not.toHaveBeenCalled()
    }
  )

  it.each(['idle', 'pending'])(
    'announces %s as loading without displaying cached observations and blocks retry',
    async (status) => {
      const page = await render({ status })
      expect(page.get('[role="status"]').text()).toContain('Consultando incidencias y limitaciones')
      expect(page.get('section').attributes('aria-busy')).toBe('true')
      expect(page.text()).not.toContain(ISSUE.message)
      expect(page.find('button').exists()).toBe(false)
      await retry(page)()
      expect(refreshMock).not.toHaveBeenCalled()
      expect(mutationMock).not.toHaveBeenCalled()
    }
  )

  it('does not treat a failed read with cached data as a successful snapshot', async () => {
    const page = await render({ status: 'error' })
    expect(page.get('[role="alert"]').text()).toContain('consulta válida para la versión actual')
    expect(page.text()).not.toContain(ISSUE.message)
    expect(page.get('button').text()).toBe('Reintentar consulta')
    expect(refreshMock).not.toHaveBeenCalled()
  })

  it.each(['2026-10-01T12:34:00.000Z', '2026-10-01T12:34:00.123Z'])(
    'accepts canonical UTC milliseconds: %s',
    async (evaluatedAt) => {
      const page = await render({ data: { ...receipt(), evaluatedAt } })
      expect(page.get('time').attributes('datetime')).toBe(evaluatedAt)
    }
  )

  it.each([
    '2026-02-30T12:34:00Z',
    '2026-10-01',
    '2026-10-01T12:34:00+00:00',
    '2026-10-01T24:00:00Z',
    '2026-10-01T12:34:00.1Z'
  ])('rejects parseable but noncanonical or impossible UTC dates: %s', async (evaluatedAt) => {
    const page = await render({ data: { ...receipt(), evaluatedAt } })
    expect(page.get('[role="alert"]').text()).toContain('consulta válida')
    expect(page.find('time').exists()).toBe(false)
  })

  it.each([
    null,
    {},
    { ...receipt(), source: 'node' },
    { ...receipt(), advisory: false },
    { ...receipt(), publicationEnabled: true },
    { ...receipt(), productId: 2 },
    { ...receipt(), productUuid: 'a1000000-0000-4000-8000-000000000002' },
    { ...receipt(), catalogVersion: 2 },
    { ...receipt(), catalogVersion: '1' },
    { ...receipt(), evaluatedAt: 'invalid' },
    { ...receipt(), issues: null },
    { ...receipt(), limitations: undefined },
    { ...receipt(), issues: [{ ...ISSUE, message: '' }] },
    { ...receipt(), limitations: [{ ...LIMITATION, path: 1 }] },
    Object.create(receipt()),
    Object.defineProperty({ ...receipt() }, 'source', { get: () => 'cloudflare', enumerable: true }),
    {
      ...receipt(),
      issues: [Object.defineProperty({ ...ISSUE }, 'message', { get: () => ISSUE.message, enumerable: true })]
    }
  ])('rejects malformed, unauthorized-source or stale identity/version responses: %#', async (data) => {
    const page = await render({ data })
    expect(page.get('[role="alert"]').text()).toContain('consulta válida')
    expect(page.find('time').exists()).toBe(false)
    expect(page.text()).not.toContain(ISSUE.message)
    expect(page.get('button').attributes('type')).toBe('button')
    expect(mutationMock).not.toHaveBeenCalled()
  })

  it('retries only a deliberate GET refresh, blocks concurrent callbacks and recovers', async () => {
    let resolve!: () => void
    refreshMock.mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          resolve = done
        })
    )
    const page = await render({ status: 'error' })
    const callback = retry(page)
    const first = callback()
    await callback()
    await nextTick()
    expect(refreshMock).toHaveBeenCalledExactlyOnceWith()
    expect(page.get('[role="status"]').text()).toContain('Consultando incidencias y limitaciones')
    expect(page.find('button').exists()).toBe(false)
    currentStatus.value = 'success'
    currentData.value = receipt()
    resolve()
    await first
    await nextTick()
    expect(page.text()).toContain(ISSUE.message)
    expect(page.find('[role="alert"]').exists()).toBe(false)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(mutationMock).not.toHaveBeenCalled()
  })

  it('keeps retry failures generic and allows a further manual retry', async () => {
    const page = await render({ status: 'error' })
    refreshMock.mockRejectedValueOnce(new Error('synthetic-private-provider-detail'))
    await retry(page)()
    await nextTick()
    expect(page.get('[role="alert"]').text()).toContain('consulta válida')
    expect(page.html()).not.toContain('synthetic-private-provider-detail')
    expect(refreshMock).toHaveBeenCalledOnce()
    await retry(page)()
    expect(refreshMock).toHaveBeenCalledTimes(2)
    expect(mutationMock).not.toHaveBeenCalled()
  })

  it.each([
    { runtime: 'node' },
    { runtime: 'unknown' },
    { productId: '01' },
    { productId: '0' },
    { productId: '9007199254740992' },
    { productUuid: 'invalid' },
    { catalogVersion: 0 },
    { authorize: () => false }
  ])('does not initiate SSR/client reads or retry without a valid explicit Cloudflare authority: %#', async (props) => {
    const page = await render({ props })
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ immediate: false, server: false })
    await retry(page)()
    expect(refreshMock).not.toHaveBeenCalled()
    expect(page.text()).not.toContain(ISSUE.message)
    expect(mutationMock).not.toHaveBeenCalled()
  })

  it('rechecks callback authority synchronously rather than relying on cached primitive props', async () => {
    let permitted = true
    const page = await render({ status: 'error', props: { authorize: () => permitted } })
    const callback = retry(page)
    permitted = false
    await callback()
    expect(refreshMock).not.toHaveBeenCalled()
  })

  it('blocks a cached callback after identity changes or unmount', async () => {
    const page = await render({ status: 'error' })
    const callback = retry(page)
    await page.setProps({ catalogVersion: 2 })
    await callback()
    expect(refreshMock).not.toHaveBeenCalled()
    page.unmount()
    wrapper = undefined
    await callback()
    expect(refreshMock).not.toHaveBeenCalled()
  })
})

describe('product page independently gates the private advisory component', () => {
  it('mounts the separate advisory for a successful authorized identity without enabling broad D1 writes', async () => {
    const page = await renderPage()
    expect(fetchMock.mock.calls.filter(([path]) => path === PATH)).toHaveLength(1)
    expect(page.text()).toContain('Comprobación informativa de publicación')
    expect(page.get('#product-form fieldset').attributes('disabled')).toBeDefined()
    expect(mutationMock).not.toHaveBeenCalled()
  })

  it.each([
    { runtime: 'node', product: { ...product(), source: undefined } },
    { runtime: 'unknown' },
    { id: 'nuevo' },
    { id: '01' },
    { status: 'pending' },
    { status: 'error' },
    { product: { ...product(), source: 'node' } },
    { product: { ...product(), capabilities: { productDetailRead: true } } },
    { product: { ...product(), capabilities: { productDetailRead: true, productReadinessRead: 'true' } } },
    {
      product: {
        ...product(),
        capabilities: Object.assign(Object.create({ productReadinessRead: true }), { productDetailRead: true })
      }
    },
    { product: { ...product(), uuid: 'invalid' } },
    { product: { ...product(), catalogVersion: 0 } }
  ])('never mounts or creates a readiness fetch for Node/unknown/invalid/revoked detail: %#', async (options) => {
    const page = await renderPage(options)
    expect(fetchMock.mock.calls.filter(([path]) => path.endsWith('/publication-readiness'))).toHaveLength(0)
    expect(page.text()).not.toContain('Comprobación informativa de publicación')
    expect(mutationMock).not.toHaveBeenCalled()
  })

  it('rechecks the actual parent capability before a cached retry can observe queued child prop updates', async () => {
    const page = await renderPage()
    currentStatus.value = 'error'
    await nextTick()
    const child = page.findComponent(Readiness)
    const callback = child.vm.$.setupState.retry as () => Promise<void>
    ;(currentProduct.value.capabilities as Record<string, unknown>).productReadinessRead = false
    await callback()
    expect(refreshMock).not.toHaveBeenCalled()
    expect(mutationMock).not.toHaveBeenCalled()
  })
})
