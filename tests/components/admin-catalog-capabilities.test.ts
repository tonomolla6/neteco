import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h, proxyRefs, reactive, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ProductsPage from '../../app/pages/admin/productos/index.vue'
import ProductDetailPage from '../../app/pages/admin/productos/[id].vue'
import { catalogActionAvailable } from '../../app/utils/catalogCapabilities'
import type { AdminProductDetail, AdminProductSummary } from '../../shared/types/admin'
import '#app/nuxt-vitest-app-entry'

const {
  fetchMock,
  mutationMock,
  navigateMock,
  toastMock,
  runtimeMock,
  routeMock,
  refreshDataMock,
  privateRefreshMock
} = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  mutationMock: vi.fn(),
  navigateMock: vi.fn(),
  toastMock: vi.fn(),
  refreshDataMock: vi.fn(),
  privateRefreshMock: vi.fn(),
  runtimeMock: vi.fn(() => ({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'cloudflare', baseUrl: 'https://neteco.invalid' }
  })),
  routeMock: vi.fn(() => ({
    params: { id: '1' },
    query: {},
    path: '/admin/productos/1',
    fullPath: '/admin/productos/1'
  }))
}))
mockNuxtImport('useFetch', () => fetchMock)
mockNuxtImport('$fetch', () => mutationMock)
mockNuxtImport('navigateTo', () => navigateMock)
mockNuxtImport('useToast', () => () => ({ add: toastMock }))
mockNuxtImport('useRuntimeConfig', () => runtimeMock)
mockNuxtImport('useRoute', () => routeMock)
mockNuxtImport('refreshNuxtData', () => refreshDataMock)
mockNuxtImport('useUserSession', () => () => ({
  ready: ref(true),
  loggedIn: ref(true),
  user: ref({ id: 'synthetic-admin', role: 'admin', mfaVerified: true }),
  session: ref(null),
  clear: async () => undefined,
  openInPopup: () => undefined,
  fetch: async () => undefined
}))

const READ_ONLY = {
  productsRead: true,
  productDetailRead: true,
  categoriesRead: true,
  pricesRead: true,
  inventoryRead: true,
  productCreate: false,
  productUpdate: false,
  productDelete: false,
  productStatusUpdate: false
}
const PRODUCT_UUID = 'a1000000-0000-4000-8000-000000000001'
const CATEGORY = {
  id: 7,
  name: 'Familia privada',
  slug: 'familia-privada',
  parentId: null,
  sort: 1,
  count: 1,
  children: []
}
const summary = (): AdminProductSummary => ({
  id: 1,
  name: 'Producto de prueba',
  slug: 'producto-de-prueba',
  brand: 'NETECO',
  featured: false,
  active: false,
  status: 'draft',
  series: null,
  visual: { type: 'caja', color: '#123456' },
  categoryId: 7,
  categoryName: 'Familia privada',
  minPrice: 1210,
  formats: 1
})
const detail = (): AdminProductDetail => ({
  id: 1,
  name: 'Producto de prueba',
  slug: 'producto-de-prueba',
  brand: 'NETECO',
  categoryId: 7,
  shortDesc: 'Texto de consulta',
  description: 'Descripción de consulta',
  usage: 'Uso profesional',
  badges: ['eco'],
  visual: { type: 'caja', color: '#123456' },
  featured: false,
  active: false,
  status: 'draft',
  series: null,
  image: null,
  imageAlt: null,
  imageRightsOwner: null,
  imageRightsLicense: null,
  imageAuthorizedAt: null,
  attrs: [{ k: 'Material', v: 'Acero' }],
  variants: [
    {
      id: 11,
      format: 'Caja 6 unidades',
      sku: 'SKU-TEST-11',
      ean: '1234567890123',
      gtin: null,
      mpn: 'MPN-TEST',
      identifierExceptionReason: null,
      price: 1210,
      stock: 25,
      units: 6,
      unitLabel: 'ud',
      unitBase: 'unit',
      unitsPerCase: 6,
      casesPerPallet: 40,
      minimumQuantity: 2,
      quantityIncrement: 2,
      maximumQuantity: 100,
      weightGrams: 1200,
      widthMm: 150,
      heightMm: 200,
      depthMm: 250,
      safetyStock: 1,
      backorderAllowed: true,
      leadTimeDays: 3,
      color: '#654321',
      image: null
    }
  ]
})

const Slot = defineComponent({ template: '<section><slot /><slot name="actions" /></section>' })
const Button = defineComponent({
  inheritAttrs: false,
  props: { to: String, icon: String },
  setup(props, { attrs, slots }) {
    return () =>
      h(
        props.to ? 'a' : 'button',
        { ...attrs, type: attrs.type ?? 'button', href: props.to, 'data-icon': props.icon },
        slots.default?.()
      )
  }
})
const Input = defineComponent({
  inheritAttrs: false,
  props: { modelValue: [String, Number] },
  emits: ['update:modelValue'],
  setup(props, { attrs, emit }) {
    return () =>
      h('input', {
        ...attrs,
        value: props.modelValue ?? '',
        onInput: (event: Event) => emit('update:modelValue', (event.target as HTMLInputElement).value)
      })
  }
})
const Select = defineComponent({
  props: { modelValue: [String, Number], items: Array },
  emits: ['update:modelValue'],
  setup(props) {
    return () =>
      h(
        'select',
        { value: props.modelValue },
        ((props.items as Array<{ label: string; value: string | number }>) ?? []).map((item) =>
          h('option', { value: item.value }, item.label)
        )
      )
  }
})
const FormField = defineComponent({
  props: { label: String },
  setup(props, { slots }) {
    return () => h('label', [h('span', props.label), slots.default?.()])
  }
})
const Dropdown = defineComponent({
  props: { items: Array },
  setup(props, { slots }) {
    return () =>
      h('div', { 'data-dropdown': '' }, [
        slots.default?.(),
        ...((props.items as Array<Array<{ label: string; onSelect: () => void }>>) ?? [])
          .flat()
          .map((item) => h('button', { onClick: item.onSelect }, item.label))
      ])
  }
})
const Modal = defineComponent({
  props: { open: Boolean, title: String },
  setup(props, { slots }) {
    return () => (props.open ? h('dialog', { open: true }, [props.title, slots.body?.(), slots.footer?.()]) : null)
  }
})
const Table = defineComponent({
  props: { rows: Array, selectable: Boolean, status: String },
  setup(props, { slots }) {
    return () =>
      h('div', { 'data-table': '', 'data-selectable': String(props.selectable) }, [
        slots.filters?.(),
        ...((props.rows as AdminProductSummary[]) ?? []).map((row) =>
          h('div', { 'data-row': row.id }, [
            slots['cell-name']?.({ row }),
            slots['cell-categoryName']?.({ row }),
            slots['cell-minPrice']?.({ row }),
            slots['cell-status']?.({ row }),
            slots['row-actions']?.({ row })
          ])
        ),
        !props.rows?.length ? slots['empty-action']?.() : null
      ])
  }
})

let wrapper: Awaited<ReturnType<typeof mountSuspended>> | undefined
let currentProduct: ReturnType<typeof ref<Record<string, unknown>>>
let currentCategory: ReturnType<typeof ref<Record<string, unknown>>>
let currentStatus: ReturnType<typeof ref<string>>
let currentRuntime: ReturnType<typeof runtimeMock>
async function render(
  page: 'list' | 'detail',
  options: {
    runtime?: string
    capabilities?: Record<string, unknown> | null
    empty?: boolean
    id?: string
    source?: unknown
    catalogVersion?: unknown
    productStatus?: AdminProductDetail['status']
    categorySource?: unknown
    categoryCapabilities?: unknown
  } = {}
) {
  const runtime = options.runtime ?? 'cloudflare'
  const capabilities = options.capabilities === null ? {} : { capabilities: options.capabilities ?? READ_ONLY }
  const product = detail()
  if (options.productStatus) product.status = options.productStatus
  if (options.empty) product.variants = []
  currentRuntime = reactive({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: runtime, baseUrl: 'https://neteco.invalid' }
  })
  runtimeMock.mockReturnValue(currentRuntime)
  routeMock.mockReturnValue({
    params: { id: options.id ?? '1' },
    query: {},
    path: '/admin/productos/1',
    fullPath: '/admin/productos/1'
  })
  const source = Object.hasOwn(options, 'source') ? options.source : runtime === 'cloudflare' ? 'cloudflare' : undefined
  const sourceMetadata = runtime === 'cloudflare' || Object.hasOwn(options, 'source') ? { source } : {}
  fetchMock.mockImplementation((path: string) => {
    const response = ref<Record<string, unknown>>(
      path.endsWith('categories')
        ? {
            roots: [structuredClone(CATEGORY)],
            flat: [structuredClone(CATEGORY)],
            ...capabilities,
            ...sourceMetadata,
            ...(Object.hasOwn(options, 'categorySource') ? { source: options.categorySource } : {}),
            ...(Object.hasOwn(options, 'categoryCapabilities') ? { capabilities: options.categoryCapabilities } : {})
          }
        : path === '/api/admin/products'
          ? { items: options.empty ? [] : [summary()], ...capabilities, ...sourceMetadata }
          : {
              ...product,
              ...capabilities,
              ...sourceMetadata,
              uuid: PRODUCT_UUID,
              catalogVersion: Object.hasOwn(options, 'catalogVersion') ? options.catalogVersion : 1
            }
    )
    const status = ref('success')
    if (path.endsWith('categories')) currentCategory = response
    else if (path !== '/api/admin/products') {
      currentProduct = response
      currentStatus = status
    }
    return { data: response, status, error: ref(null), refresh: path.endsWith('/1') ? privateRefreshMock : vi.fn() }
  })
  wrapper = await mountSuspended(page === 'list' ? ProductsPage : ProductDetailPage, {
    global: {
      stubs: {
        UiPageHeader: Slot,
        UiDataTable: Table,
        UButton: Button,
        UIcon: true,
        UBadge: Slot,
        USelect: Select,
        UDropdownMenu: Dropdown,
        UModal: Modal,
        ProductVisual: true,
        UInput: Input,
        UTextarea: Input,
        UFormField: FormField
      }
    }
  })
  return wrapper
}

describe('administrative catalog frontend capability boundaries', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    mutationMock.mockReset().mockResolvedValue({ ok: true })
    navigateMock.mockReset()
    toastMock.mockReset()
    refreshDataMock.mockReset().mockResolvedValue(undefined)
    privateRefreshMock.mockReset().mockResolvedValue(undefined)
  })
  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
  })

  it('renders Cloudflare list as read-only without create, status, delete or bulk selection actions', async () => {
    const page = await render('list')
    expect(page.text()).toContain('Producto de prueba')
    expect(page.text()).toContain('Borrador')
    expect(page.text()).toContain('Las ediciones de contenido afectan sólo a borradores')
    expect(page.find('[data-editorial-unavailable]').exists()).toBe(true)
    expect(page.find('[data-editorial-file]').exists()).toBe(false)
    expect(page.text()).not.toContain('Nuevo producto')
    expect(page.find('[data-dropdown]').exists()).toBe(false)
    expect(page.find('[aria-label="Eliminar Producto de prueba"]').exists()).toBe(false)
    expect(page.get('[data-table]').attributes('data-selectable')).toBe('false')
    expect(page.find('[aria-label="Consultar Producto de prueba"]').exists()).toBe(true)
    expect(fetchMock.mock.calls.map(([path]) => path)).toContain('/api/admin/categories')
    expect(fetchMock.mock.calls.map(([path]) => path)).not.toContain('/api/categories')
    expect(mutationMock).not.toHaveBeenCalled()
  })

  it('does not offer create from the Cloudflare empty-list state', async () => {
    const page = await render('list', { empty: true })
    expect(page.find('[href="/admin/productos/nuevo"]').exists()).toBe(false)
    expect(page.text()).not.toContain('Nuevo producto')
  })

  it('fails closed if Cloudflare catalog metadata lacks capabilities', async () => {
    const page = await render('list', { capabilities: null })
    expect(page.text()).not.toContain('Nuevo producto')
    expect(page.find('[data-dropdown]').exists()).toBe(false)
    expect(page.find('[aria-label="Eliminar Producto de prueba"]').exists()).toBe(false)
    expect(page.get('[data-table]').attributes('data-selectable')).toBe('false')
  })

  it('keeps Cloudflare detail fields and variants legible while preventing save/delete/submission', async () => {
    const page = await render('detail')
    expect(page.text()).toContain('Catálogo D1')
    expect(page.text()).toContain('Los precios y el stock siguen siendo de consulta aquí')
    expect(page.text()).toContain('Caja 6 unidades')
    expect(page.text()).toContain('SKU-TEST-11')
    expect(page.text()).toContain('25 en stock')
    expect(page.get('fieldset').attributes('disabled')).toBeDefined()
    expect(page.find('[type="submit"]').exists()).toBe(false)
    expect(page.text()).not.toContain('Guardar')
    expect(page.text()).not.toContain('Eliminar producto')
    const values = page.findAll('input').map((input) => (input.element as HTMLInputElement).value)
    expect(values).toContain('SKU-TEST-11')
    expect(values).toContain('1234567890123')
    expect(values).toContain('1200')
    expect(values).toContain('150')
    expect(values).toContain('200')
    expect(values).toContain('250')
    expect(page.findAll('[aria-expanded="true"]')).toHaveLength(1)
    await page.get('form').trigger('submit')
    await flushPromises()
    expect(mutationMock).not.toHaveBeenCalled()
    expect(fetchMock.mock.calls.map(([path]) => path)).toContain('/api/admin/categories')
  })

  it('does not fabricate a variant or physical stock for a Cloudflare product with no variants', async () => {
    const page = await render('detail', { empty: true })
    expect(page.text()).not.toContain('Variante 1')
    expect(page.text()).not.toContain('100 en stock')
    expect(page.findAll('[aria-expanded]')).toHaveLength(0)
  })

  it('does not allow the direct Cloudflare nuevo URL to create without confirmed authoring references', async () => {
    const page = await render('detail', { id: 'nuevo' })
    expect(page.find('[type="submit"]').exists()).toBe(false)
    expect(page.find('[data-action="create"]').exists()).toBe(false)
    expect(page.text()).toContain('No hay una lectura válida de referencias')
    expect(page.find('form').exists()).toBe(false)
    await (proxyRefs(page.setupState).save as () => Promise<void>)()
    await flushPromises()
    expect(mutationMock).not.toHaveBeenCalled()
    expect(fetchMock.mock.calls.map(([path]) => path)).not.toContain('/api/admin/products/nuevo')
  })

  it('preserves the Node list controls and public categories endpoint when metadata is absent', async () => {
    const page = await render('list', { runtime: 'node', capabilities: null })
    expect(page.text()).toContain('Nuevo producto')
    expect(page.text()).toContain('Estado')
    expect(page.find('[data-dropdown]').exists()).toBe(true)
    expect(page.find('[aria-label="Eliminar Producto de prueba"]').exists()).toBe(true)
    expect(page.get('[data-table]').attributes('data-selectable')).toBe('true')
    expect(fetchMock.mock.calls.map(([path]) => path)).toContain('/api/categories')
    expect(fetchMock.mock.calls.map(([path]) => path)).not.toContain('/api/admin/categories')
  })

  it('preserves the Node detail save contract and price-in-euros conversion without capability metadata', async () => {
    const page = await render('detail', { runtime: 'node', capabilities: null })
    expect(page.text()).toContain('Guardar')
    expect(page.text()).toContain('Eliminar producto')
    expect(page.get('fieldset').attributes('disabled')).toBeUndefined()
    await page.get('form').trigger('submit')
    await flushPromises()
    expect(mutationMock).toHaveBeenCalledWith(
      '/api/admin/products/1',
      expect.objectContaining({
        method: 'PUT',
        body: expect.objectContaining({
          name: 'Producto de prueba',
          categoryId: 7,
          variants: [
            expect.objectContaining({
              id: 11,
              price: 12.1,
              stock: 25,
              weightGrams: 1200,
              widthMm: 150,
              heightMm: 200,
              depthMm: 250
            })
          ]
        })
      })
    )
    expect(navigateMock).toHaveBeenCalledWith('/admin/productos')
  })

  it('does not let Node fallback override explicit false or incomplete capability metadata', async () => {
    const page = await render('list', { runtime: 'node' })
    expect(page.text()).not.toContain('Nuevo producto')
    expect(page.find('[data-dropdown]').exists()).toBe(false)
    expect(page.find('[aria-label="Eliminar Producto de prueba"]').exists()).toBe(false)
    expect(catalogActionAvailable({ capabilities: {} }, 'productUpdate', false)).toBe(false)
    expect(catalogActionAvailable({ capabilities: { productCreate: true } }, 'productUpdate', false)).toBe(false)
  })

  it('exposes only the separate draft metadata editor while hostile broad Cloudflare capabilities stay unusable', async () => {
    const page = await render('detail', {
      capabilities: {
        ...READ_ONLY,
        productMetadataUpdate: true,
        productCreate: true,
        productUpdate: true,
        productDelete: true,
        productStatusUpdate: true
      }
    })
    expect(page.text()).toContain('Editar metadatos del borrador')
    expect(page.find('#draft-metadata-form').exists()).toBe(true)
    expect(page.get('#product-form > fieldset').attributes('disabled')).toBeDefined()
    expect(page.text()).not.toContain('Eliminar producto')
    const state = proxyRefs(page.setupState)
    await (state.save as () => Promise<void>)()
    await (state.removeProduct as () => Promise<void>)()
    await (state.addVariant as () => void)()
    await (state.addAttr as () => void)()
    expect((state.form as { variants: unknown[] }).variants).toHaveLength(1)
    expect(mutationMock).not.toHaveBeenCalled()
    mutationMock.mockResolvedValueOnce({
      source: 'cloudflare',
      productId: 1,
      productUuid: PRODUCT_UUID,
      catalogVersion: 2,
      updated: true
    })
    await page.get('#draft-name').setValue('Nombre de borrador corregido')
    await page.get('#draft-reason').setValue('Corrección editorial motivada')
    await page.get('#draft-metadata-form').trigger('submit')
    await flushPromises()
    expect(mutationMock).toHaveBeenCalledExactlyOnceWith(
      '/api/admin/products/1',
      expect.objectContaining({
        method: 'PUT',
        body: { expectedVersion: 1, reason: 'Corrección editorial motivada', name: 'Nombre de borrador corregido' },
        headers: { Origin: window.location.origin, 'Idempotency-Key': expect.any(String) }
      })
    )
    expect(privateRefreshMock).toHaveBeenCalledOnce()
    expect(refreshDataMock).not.toHaveBeenCalled()
    expect(navigateMock).not.toHaveBeenCalled()
    expect(page.text()).toContain('Caja 6 unidades')
    expect(page.findAll('[aria-expanded="true"]')).toHaveLength(1)
  })
  it.each(['unknown', '', 'Node', 'Cloudflare'])(
    'fails closed for runtime %s, including direct full-form callbacks',
    async (runtime) => {
      const page = await render('detail', { runtime, capabilities: null })
      expect(page.find('form').exists()).toBe(false)
      expect(page.text()).not.toContain('SKU-TEST-11')
      for (const action of ['save', 'removeProduct', 'addVariant', 'addAttr', 'removeVariant', 'toggleBadge']) {
        const callback = proxyRefs(page.setupState)[action] as (...args: unknown[]) => unknown
        await callback(0)
      }
      expect(mutationMock).not.toHaveBeenCalled()
      expect(fetchMock.mock.calls.every(([, options]) => options.immediate === false && options.server === false)).toBe(
        true
      )
    }
  )
  it.each(['published', 'review', 'hidden', 'discontinued'] as const)(
    'retains read-only detail but never edits non-draft %s metadata',
    async (productStatus) => {
      const page = await render('detail', {
        productStatus,
        capabilities: { ...READ_ONLY, productMetadataUpdate: true }
      })
      expect(page.find('#draft-metadata-form').exists()).toBe(false)
      expect(page.get('#product-form > fieldset').attributes('disabled')).toBeDefined()
      expect(page.text()).toContain('SKU-TEST-11')
      await (proxyRefs(page.setupState).save as () => Promise<void>)()
      expect(mutationMock).not.toHaveBeenCalled()
    }
  )
  it.each([0, '1', undefined, Number.MAX_SAFE_INTEGER + 1])(
    'does not activate the editor with invalid catalog version %j',
    async (catalogVersion) => {
      const page = await render('detail', {
        catalogVersion,
        capabilities: { ...READ_ONLY, productMetadataUpdate: true }
      })
      expect(page.find('#draft-metadata-form').exists()).toBe(false)
      await (proxyRefs(page.setupState).save as () => Promise<void>)()
      expect(mutationMock).not.toHaveBeenCalled()
    }
  )
  it.each(['source', 'capability', 'runtime', 'read', 'version'])(
    'revokes draft submit on %s change without enabling legacy callbacks',
    async (change) => {
      const page = await render('detail', { capabilities: { ...READ_ONLY, productMetadataUpdate: true } })
      await page.get('#draft-name').setValue('Cambio pendiente')
      await page.get('#draft-reason').setValue('Motivo pendiente')
      const editor = page.findComponent({ name: 'DraftProductMetadataEditor' })
      const submit = editor.vm.$.setupState.saveMetadata as () => Promise<void>
      if (change === 'source') currentProduct.value.source = 'node'
      if (change === 'capability')
        currentProduct.value.capabilities = { ...READ_ONLY, productMetadataUpdate: false, productUpdate: true }
      if (change === 'runtime') currentRuntime.public.serverRuntime = 'unknown'
      if (change === 'read') currentStatus.value = 'pending'
      if (change === 'version') currentProduct.value = { ...currentProduct.value, catalogVersion: 2 }
      await submit()
      await (proxyRefs(page.setupState).save as () => Promise<void>)()
      await flushPromises()
      expect(mutationMock).not.toHaveBeenCalled()
      if (change === 'version') expect(page.get('#draft-metadata-form fieldset').attributes('disabled')).toBeDefined()
      else expect(page.find('#draft-metadata-form').exists()).toBe(false)
    }
  )
  it.each(['source', 'capability', 'cycle'])(
    'does not offer untrusted private category selections on %s corruption',
    async (change) => {
      const page = await render('detail', { capabilities: { ...READ_ONLY, productMetadataUpdate: true } })
      if (change === 'source') currentCategory.value.source = 'node'
      if (change === 'capability') currentCategory.value.capabilities = { categoriesRead: 'true' }
      if (change === 'cycle') {
        const roots = currentCategory.value.roots as Array<{ children: unknown[] }>
        roots[0]!.children = [roots[0]!]
      }
      await flushPromises()
      expect(page.get('#draft-category').attributes('disabled')).toBeDefined()
      expect(page.get('#draft-category').text()).not.toContain('Familia privada')
      expect(mutationMock).not.toHaveBeenCalled()
    }
  )
  it('preserves the Node nuevo POST full payload rather than routing it into the narrow D1 editor', async () => {
    const page = await render('detail', { runtime: 'node', capabilities: null, id: 'nuevo' })
    expect(page.find('[data-draft-metadata-editor]').exists()).toBe(false)
    expect(page.get('#product-form > fieldset').attributes('disabled')).toBeUndefined()
    await page.get('#product-form').trigger('submit')
    await flushPromises()
    expect(mutationMock).toHaveBeenCalledWith(
      '/api/admin/products',
      expect.objectContaining({
        method: 'POST',
        body: expect.objectContaining({ brand: '', variants: expect.any(Array), active: false })
      })
    )
    expect(callMetadataBody()).not.toHaveProperty('expectedVersion')
  })
})

function callMetadataBody() {
  return mutationMock.mock.calls.at(-1)?.[1]?.body
}
