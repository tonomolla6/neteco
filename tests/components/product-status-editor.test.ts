import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h, nextTick, proxyRefs, reactive, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import StatusEditor from '../../app/components/ProductStatusEditor.vue'
import ProductPage from '../../app/pages/admin/productos/[id].vue'
import '#app/nuxt-vitest-app-entry'

const { requestMock, fetchMock, runtimeMock, routeMock, readinessRefreshMock } = vi.hoisted(() => ({
  requestMock: vi.fn(),
  fetchMock: vi.fn(),
  readinessRefreshMock: vi.fn(),
  runtimeMock: vi.fn(() => ({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'cloudflare' }
  })),
  routeMock: vi.fn(() => ({
    params: { id: '1' },
    query: {},
    path: '/admin/productos/1',
    fullPath: '/admin/productos/1'
  }))
}))
mockNuxtImport('$fetch', () => requestMock)
mockNuxtImport('useFetch', () => fetchMock)
mockNuxtImport('useRuntimeConfig', () => runtimeMock)
mockNuxtImport('useRoute', () => routeMock)
mockNuxtImport('refreshNuxtData', () => readinessRefreshMock)
mockNuxtImport('navigateTo', () => async () => undefined)
mockNuxtImport('useToast', () => () => ({ add: () => undefined }))
mockNuxtImport('useUserSession', () => () => ({
  ready: ref(true),
  loggedIn: ref(true),
  user: ref({ id: 'synthetic-admin', role: 'admin', mfaVerified: true }),
  session: ref(null),
  clear: async () => undefined,
  fetch: async () => undefined,
  openInPopup: () => undefined
}))
const UUID = 'a1000000-0000-4000-8000-000000000001'
const product = () => ({
  id: 1,
  uuid: UUID,
  catalogVersion: 1,
  source: 'cloudflare',
  status: 'draft',
  capabilities: {
    productDetailRead: true,
    productStatusTransition: true,
    productReadinessRead: true,
    productUpdate: false,
    productStatusUpdate: false
  },
  name: 'Producto sintético',
  brand: 'NETECO',
  slug: 'producto-sintetico',
  categoryId: 7,
  shortDesc: 'Descripción sintética',
  description: 'Descripción completa sintética',
  usage: null,
  series: null,
  visual: { type: 'caja', color: '#123456' },
  badges: [],
  attrs: [],
  variants: [],
  featured: false,
  active: false
})
const receipt = (status = 'hidden', catalogVersion: unknown = 2) => ({
  source: 'cloudflare',
  productId: 1,
  productUuid: UUID,
  catalogVersion,
  status,
  active: status === 'published',
  updated: true
})
const Button = defineComponent({
  inheritAttrs: false,
  props: { loading: Boolean, disabled: Boolean },
  setup:
    (props, { attrs, slots }) =>
    () =>
      h(
        'button',
        { ...attrs, type: attrs.type ?? 'button', disabled: props.loading || props.disabled },
        slots.default?.()
      )
})
const Slot = defineComponent({ template: '<div><slot /></div>' })
const stubs = {
  UButton: Button,
  UFormField: Slot,
  UBadge: Slot,
  UIcon: true,
  UInput: true,
  USelect: true,
  UTextarea: true,
  ProductVisual: true,
  DraftProductMetadataEditor: true,
  CatalogPublicationReadiness: true
}
type Wrapper = Awaited<ReturnType<typeof mountSuspended>>
type Props = InstanceType<typeof StatusEditor>['$props']
let wrapper: Wrapper | undefined
let currentProduct: ReturnType<typeof ref<Record<string, unknown>>>
let currentDetailStatus: ReturnType<typeof ref<string>>
let currentRuntime: {
  app: { baseURL: string; buildAssetsDir: string; cdnURL: string }
  public: { serverRuntime: string }
}
async function render(overrides: Partial<Props> = {}) {
  const reload = vi.fn<() => Promise<unknown>>(async () => undefined)
  const readiness = vi.fn<() => Promise<unknown>>(async () => undefined)
  wrapper = await mountSuspended(StatusEditor, {
    props: {
      product: product(),
      productId: '1',
      runtime: 'cloudflare',
      readStatus: 'success',
      authorize: () => true,
      refreshProduct: reload,
      readinessAvailable: true,
      refreshReadiness: readiness,
      ...overrides
    },
    global: { stubs }
  })
  return { page: wrapper, reload, readiness }
}
async function renderPage(runtime = 'cloudflare') {
  currentRuntime.public.serverRuntime = runtime
  currentProduct = ref({ ...product(), ...(runtime === 'node' ? { source: undefined } : {}) })
  currentDetailStatus = ref('success')
  fetchMock.mockImplementation((path: string) =>
    path.endsWith('categories')
      ? {
          data: ref({
            roots: [],
            flat: [],
            source: runtime === 'node' ? undefined : 'cloudflare',
            capabilities: { categoriesRead: true }
          }),
          status: ref('success'),
          error: ref(null),
          refresh: vi.fn()
        }
      : { data: currentProduct, status: currentDetailStatus, error: ref(null), refresh: vi.fn(async () => undefined) }
  )
  wrapper = await mountSuspended(ProductPage, { global: { stubs } })
  await flushPromises()
  return wrapper
}
function state(page: Wrapper) {
  return proxyRefs(page.setupState) as Record<string, unknown>
}
async function invoke(page: Wrapper, action: string) {
  await (state(page)[action] as () => Promise<void>)()
}
async function prepare(page: Wrapper, status = 'hidden', reason = 'Retirada temporal justificada') {
  await page.get('#product-target-status').setValue(status)
  await page.get('#product-status-reason').setValue(reason)
  await page.get('input[type="checkbox"]').setValue(true)
}
const calls = () => requestMock.mock.calls.map((call) => call.slice(0, 2))
beforeEach(() => {
  requestMock.mockReset().mockResolvedValue(receipt())
  fetchMock.mockReset()
  readinessRefreshMock.mockReset().mockResolvedValue(undefined)
  currentRuntime = reactive({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'cloudflare' }
  })
  runtimeMock.mockReturnValue(currentRuntime)
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
})

describe('narrow explicit D1 status commands', () => {
  it('renders a separate accessible editor, explanatory advisory warning and required reason/confirmation', async () => {
    const { page } = await render()
    expect(page.text()).toContain('Cambiar estado editorial')
    expect(page.text()).toContain('La consulta informativa no autoriza la publicación')
    expect(page.get('form').attributes('aria-busy')).toBe('false')
    expect(page.get('label[for="product-status-reason"]').text()).toBe('Motivo del cambio de estado')
    expect(page.get('#product-status-reason').attributes()).toMatchObject({
      minlength: '3',
      maxlength: '500',
      required: ''
    })
    expect(page.get('input[type="checkbox"]').attributes('required')).toBeDefined()
    expect(page.get('button[type="submit"]').attributes('disabled')).toBeDefined()
    expect(requestMock).not.toHaveBeenCalled()
  })

  it.each([
    ['draft', ['review', 'hidden', 'discontinued']],
    ['review', ['draft', 'published', 'hidden']],
    ['published', ['hidden', 'discontinued']],
    ['hidden', ['draft', 'review', 'published', 'discontinued']],
    ['discontinued', ['draft']]
  ] as const)('offers exactly the existing Node edges from %s, without a no-op option', async (status, edges) => {
    const { page } = await render({ product: { ...product(), status } })
    expect(
      page
        .findAll('option')
        .map((option) => option.attributes('value'))
        .filter(Boolean)
    ).toEqual([...edges])
  })

  it('sends only the flat status/version/reason command with stable origin/key, then refetches instead of mutating the DTO', async () => {
    const original = product()
    const { page, reload } = await render({ product: original })
    await prepare(page, 'hidden', '  Retirada temporal justificada  ')
    reload.mockImplementationOnce(async () => {
      await page.setProps({ product: { ...original, status: 'hidden', catalogVersion: 2 } })
    })
    await invoke(page, 'saveStatus')
    expect(calls()).toEqual([
      [
        '/api/admin/products/1/status',
        {
          method: 'PUT',
          body: { status: 'hidden', expectedVersion: 1, reason: 'Retirada temporal justificada' },
          headers: { Origin: window.location.origin, 'Idempotency-Key': expect.stringMatching(/^[0-9a-f-]{36}$/) }
        }
      ]
    ])
    expect(reload).toHaveBeenCalledOnce()
    expect(original.status).toBe('draft')
    expect(original.catalogVersion).toBe(1)
    expect(page.get('[role="status"]').text()).toContain('Cambio de estado registrado')
    expect(page.text()).toContain('Oculto · versión 2')
  })

  it.each(['hidden', 'discontinued', 'published'])('requires explicit impact confirmation for %s', async (target) => {
    const { page } = await render({ product: { ...product(), status: target === 'published' ? 'review' : 'draft' } })
    state(page).target = target
    state(page).reason = 'Motivo explícito'
    await nextTick()
    await invoke(page, 'saveStatus')
    expect(requestMock).not.toHaveBeenCalled()
    expect(page.get('[role="alert"]').text()).toMatch(/Confirma|transición/)
  })

  it.each(['', 'ab', '   ', 'x'.repeat(501), 'Motivo\nmultilínea', 'Motivo\u0000inválido', 'Motivo\u007finválido'])(
    'blocks invalid reasons even through a cached programmatic callback: %#',
    async (reason) => {
      const { page } = await render()
      await prepare(page)
      state(page).reason = reason
      await invoke(page, 'saveStatus')
      expect(requestMock).not.toHaveBeenCalled()
      expect(page.get('[role="alert"]').text()).toContain('motivo')
    }
  )

  it.each(['draft', 'published', 'bogus', '__proto__'])(
    'blocks a poisoned/no-op/non-edge target from draft: %s',
    async (target) => {
      const { page } = await render()
      await prepare(page)
      state(page).target = target
      await nextTick()
      state(page).confirmed = true
      await invoke(page, 'saveStatus')
      expect(requestMock).not.toHaveBeenCalled()
    }
  )

  it.each([
    { runtime: 'node' },
    { runtime: 'unknown' },
    { productId: '01' },
    { productId: '0' },
    { productId: '9007199254740992' },
    { readStatus: 'pending' },
    { readStatus: 'error' },
    { product: null },
    { product: { ...product(), source: 'node' } },
    { product: { ...product(), id: 2 } },
    { product: { ...product(), uuid: 'invalid' } },
    { product: { ...product(), catalogVersion: 0 } },
    { product: { ...product(), catalogVersion: '1' } },
    { product: { ...product(), catalogVersion: Number.MAX_SAFE_INTEGER } },
    { product: { ...product(), status: 'invalid' } },
    { product: { ...product(), capabilities: { productDetailRead: true } } },
    {
      product: {
        ...product(),
        capabilities: { productDetailRead: true, productStatusTransition: 'true', productStatusUpdate: true }
      }
    },
    {
      product: {
        ...product(),
        capabilities: Object.assign(Object.create({ productStatusTransition: true }), { productDetailRead: true })
      }
    },
    { product: Object.create(product()) },
    { product: Object.defineProperty(product(), 'source', { get: () => 'cloudflare', enumerable: true }) },
    { authorize: () => false }
  ])('blocks poisoned DTOs/capabilities/runtime/version and never falls back to broad writes: %#', async (props) => {
    const { page } = await render(props)
    Object.assign(state(page), { target: 'hidden', reason: 'Motivo explícito', confirmed: true })
    await invoke(page, 'saveStatus')
    await invoke(page, 'retry')
    expect(requestMock).not.toHaveBeenCalled()
    if (
      'product' in props &&
      props.product !== null &&
      typeof props.product === 'object' &&
      'catalogVersion' in props.product &&
      props.product.catalogVersion === Number.MAX_SAFE_INTEGER
    ) {
      expect(page.get('fieldset').attributes('disabled')).toBeDefined()
    } else {
      expect(page.find('form').exists()).toBe(false)
    }
  })

  it('blocks double submissions synchronously while the first command is in flight', async () => {
    let resolve!: (value: ReturnType<typeof receipt>) => void
    requestMock.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done
      })
    )
    const { page } = await render()
    await prepare(page)
    const callback = state(page).saveStatus as () => Promise<void>
    const first = callback()
    await callback()
    await nextTick()
    expect(requestMock).toHaveBeenCalledOnce()
    expect(page.get('form').attributes('aria-busy')).toBe('true')
    expect(page.get('[role="status"]').text()).toContain('Registrando')
    resolve(receipt())
    await first
  })

  it('retains exact ambiguous payload/key across refetch and replays historically even if the product later advanced', async () => {
    requestMock.mockRejectedValueOnce(new Error('synthetic-response-lost')).mockResolvedValueOnce(receipt())
    const { page, reload } = await render()
    await prepare(page)
    await invoke(page, 'saveStatus')
    const first = calls()[0]
    expect(page.text()).toContain('No podemos confirmar')
    expect(page.text()).not.toContain('synthetic-response-lost')
    reload.mockImplementationOnce(async () => {
      await page.setProps({ product: { ...product(), status: 'review', catalogVersion: 3 } })
    })
    await invoke(page, 'reload')
    expect(page.text()).toContain('conserva su misma clave')
    await invoke(page, 'saveStatus')
    expect(requestMock).toHaveBeenCalledOnce()
    await invoke(page, 'retry')
    expect(calls()[1]).toEqual(first)
    expect(page.props('product')).toMatchObject({ status: 'review', catalogVersion: 3 })
    expect(page.text()).toContain('Cambio de estado registrado')
  })

  it.each(['version_conflict', 'idempotency_conflict', 'invalid_transition', 'conflict', 'forbidden', 'mfa_required'])(
    'clears a deterministically rejected intent and requires explicit detail refetch: %s',
    async (code) => {
      requestMock.mockRejectedValueOnce({
        statusCode: 409,
        data: { error: { code, message: 'private-provider-detail' } }
      })
      const { page, reload } = await render()
      await prepare(page)
      await invoke(page, 'saveStatus')
      expect(page.findAll('button').some((button) => button.text() === 'Reintentar el mismo cambio')).toBe(false)
      expect(page.text()).not.toContain('private-provider-detail')
      await invoke(page, 'retry')
      await invoke(page, 'saveStatus')
      expect(requestMock).toHaveBeenCalledOnce()
      expect(reload).not.toHaveBeenCalled()
      await invoke(page, 'reload')
      expect(reload).toHaveBeenCalledOnce()
      expect(page.get('#product-target-status').element).toHaveProperty('value', '')
    }
  )

  it('treats a blocked publication as rejection, never approval, and permits an informational GET-only refresh', async () => {
    requestMock.mockRejectedValueOnce({
      statusCode: 409,
      data: { error: { code: 'publication_blocked', issues: [{ message: 'private-provider-detail' }] } }
    })
    const { page, readiness } = await render({ product: { ...product(), status: 'review' } })
    await prepare(page, 'published')
    await invoke(page, 'saveStatus')
    expect(page.get('[role="alert"]').text()).toContain('No se ha publicado')
    expect(page.text()).not.toContain('private-provider-detail')
    expect(page.text()).not.toContain('Cambio de estado registrado')
    await invoke(page, 'consultReadiness')
    expect(readiness).toHaveBeenCalledOnce()
    expect(requestMock).toHaveBeenCalledOnce()
  })

  it.each([
    null,
    { ...receipt(), source: 'node' },
    { ...receipt(), productId: 2 },
    { ...receipt(), productUuid: 'foreign' },
    receipt('hidden', 3),
    receipt('hidden', '2'),
    receipt('published'),
    { ...receipt(), active: true },
    { ...receipt(), updated: 'true' },
    Object.create(receipt())
  ])(
    'does not announce success for an invalid/mismatched receipt and preserves the command for exact retry: %#',
    async (result) => {
      requestMock.mockResolvedValueOnce(result)
      const { page, reload } = await render()
      await prepare(page)
      await invoke(page, 'saveStatus')
      expect(page.text()).toContain('No podemos confirmar')
      expect(page.text()).not.toContain('Cambio de estado registrado')
      expect(reload).not.toHaveBeenCalled()
    }
  )

  it('blocks cached callbacks after permission revocation and after unmount', async () => {
    let allowed = true
    const { page } = await render({ authorize: () => allowed })
    await prepare(page)
    const callback = state(page).saveStatus as () => Promise<void>
    const retryCallback = state(page).retry as () => Promise<void>
    allowed = false
    await callback()
    expect(requestMock).not.toHaveBeenCalled()
    page.unmount()
    wrapper = undefined
    allowed = true
    await callback()
    await retryCallback()
    expect(requestMock).not.toHaveBeenCalled()
  })

  it('ignores a late receipt if its child origin identity changed and never refetches the replacement product', async () => {
    let resolve!: (value: ReturnType<typeof receipt>) => void
    requestMock.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done
      })
    )
    const { page, reload } = await render()
    await prepare(page)
    const first = invoke(page, 'saveStatus')
    await page.setProps({ product: { ...product(), uuid: 'a1000000-0000-4000-8000-000000000002' } })
    resolve(receipt())
    await first
    await nextTick()
    expect(reload).not.toHaveBeenCalled()
    expect(page.text()).not.toContain('Cambio de estado registrado')
  })
})

describe('product page retains Node behavior and rechecks current private authority', () => {
  it.each(['node', 'unknown'])('does not mount a D1 mutation editor or write in %s', async (runtime) => {
    const page = await renderPage(runtime)
    expect(page.find('[data-product-status-editor]').exists()).toBe(false)
    expect(requestMock).not.toHaveBeenCalled()
  })

  it.each(['permission', 'runtime', 'version', 'status', 'source'])(
    'blocks a cached child submit before queued prop updates after %s changes',
    async (change) => {
      const page = await renderPage()
      const child = page.findComponent(StatusEditor)
      await child.get('#product-target-status').setValue('hidden')
      await child.get('#product-status-reason').setValue('Motivo explícito')
      await child.get('input[type="checkbox"]').setValue(true)
      const callback = child.vm.$.setupState.saveStatus as () => Promise<void>
      if (change === 'permission')
        (currentProduct.value.capabilities as Record<string, unknown>).productStatusTransition = false
      if (change === 'runtime') currentRuntime.public.serverRuntime = 'unknown'
      if (change === 'version') currentProduct.value.catalogVersion = 2
      if (change === 'status') currentProduct.value.status = 'review'
      if (change === 'source') currentProduct.value.source = 'node'
      await callback()
      expect(requestMock).not.toHaveBeenCalled()
    }
  )
})
