import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { defineComponent, h, nextTick, proxyRefs, reactive, ref, shallowRef, type PropType } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ProductsPage from '../../app/pages/admin/productos/index.vue'
import ProductPage from '../../app/pages/admin/productos/[id].vue'
import DraftProductCreate from '../../app/components/DraftProductCreate.vue'
import DraftProductVariantsEditor from '../../app/components/DraftProductVariantsEditor.vue'
import productPageSource from '../../app/pages/admin/productos/[id].vue?raw'
import { createDraftInputSchema } from '../../shared/catalog-draft-authoring'
import type {
  CatalogDraftAuthoringOptions,
  CatalogDraftAuthoringSnapshot
} from '../../shared/catalog-draft-authoring-options'
import '#app/nuxt-vitest-app-entry'

const { fetchMock, requestMock, navigateMock, runtimeMock, routeMock, refreshDataMock, sessionMock } = vi.hoisted(
  () => ({
    fetchMock: vi.fn(),
    requestMock: vi.fn(),
    navigateMock: vi.fn(),
    refreshDataMock: vi.fn(),
    sessionMock: vi.fn(),
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
  })
)
mockNuxtImport('useFetch', () => fetchMock)
mockNuxtImport('$fetch', () => requestMock)
mockNuxtImport('navigateTo', () => navigateMock)
mockNuxtImport('refreshNuxtData', () => refreshDataMock)
mockNuxtImport('useRuntimeConfig', () => runtimeMock)
mockNuxtImport('useRoute', () => routeMock)
mockNuxtImport('useToast', () => () => ({ add: () => undefined }))
mockNuxtImport('useUserSession', () => sessionMock)

const PRODUCT = 'a1000000-0000-4000-8000-000000000038'
const VARIANT = 'a2000000-0000-4000-8000-000000000038'
const BRAND = 'a3000000-0000-4000-8000-000000000038'
const TAX = 'a4000000-0000-4000-8000-000000000038'
const SHIPPING = 'a5000000-0000-4000-8000-000000000038'
const VERSION = 7
const NARROW = {
  productDraftCreate: true,
  productDraftBrandUpdate: true,
  variantDraftCreate: true,
  variantDraftUpdate: true,
  variantDraftDiscontinue: true
}
const CAPABILITIES = {
  ...NARROW,
  productsRead: true,
  productDetailRead: true,
  categoriesRead: true,
  productCreate: false,
  productUpdate: false,
  productDelete: false,
  productStatusUpdate: false,
  variantWrite: false
}
const identity = () => ({ id: 1, uuid: PRODUCT, version: VERSION })
const references = (): CatalogDraftAuthoringOptions => ({
  source: 'cloudflare',
  capabilities: { ...NARROW },
  categories: [{ id: 7, name: 'Familia privada', parentId: null, status: 'draft' }],
  brands: [{ id: BRAND, name: 'Marca privada', status: 'draft' }],
  taxClasses: [
    {
      id: TAX,
      code: 'ZERO',
      name: 'Impuesto explícito',
      rateBasisPoints: 0,
      validFrom: '2020-01-01T00:00:00Z',
      validUntil: null
    }
  ],
  shippingProfiles: [{ id: SHIPPING, code: 'PARCEL', name: 'Perfil privado', kind: 'parcel' }]
})
const snapshot = (): CatalogDraftAuthoringSnapshot => ({
  productId: 1,
  productUuid: PRODUCT,
  catalogVersion: VERSION,
  status: 'draft',
  brandId: BRAND,
  variants: [
    {
      id: 11,
      uuid: VARIANT,
      status: 'draft',
      sku: 'SYNTHETIC-11',
      format: 'Botella 1 L',
      ean: '4006381333931',
      gtin: null,
      mpn: null,
      taxClassId: TAX,
      shippingProfileId: SHIPPING,
      unitBase: 'L',
      unitLabel: 'litro',
      contentQuantity: 1,
      unitsPerCase: 6,
      casesPerPallet: null,
      minimumQuantity: 1,
      quantityIncrement: 1,
      maximumQuantity: null,
      weightGrams: 0,
      widthMm: 0,
      heightMm: 0,
      depthMm: 0,
      backorderAllowed: false,
      leadTimeDays: null,
      color: null
    }
  ]
})
const product = (): Record<string, unknown> => ({
  id: 1,
  uuid: PRODUCT,
  catalogVersion: VERSION,
  source: 'cloudflare',
  capabilities: { ...CAPABILITIES },
  authoring: snapshot(),
  name: 'Producto sintético',
  slug: 'producto-sintetico',
  brand: 'Marca privada',
  categoryId: 7,
  shortDesc: 'Descripción sintética',
  description: 'Descripción sintética completa',
  usage: null,
  series: null,
  badges: [],
  visual: { type: 'botella', color: '#123456' },
  attrs: [],
  featured: false,
  active: false,
  status: 'draft',
  image: null,
  imageAlt: null,
  imageRightsOwner: null,
  imageRightsLicense: null,
  imageAuthorizedAt: null,
  variants: [
    {
      id: 11,
      sku: 'SYNTHETIC-11',
      format: 'Botella 1 L',
      ean: '4006381333931',
      gtin: null,
      mpn: null,
      identifierExceptionReason: null,
      price: 0,
      stock: 0,
      units: 1,
      unitBase: 'L',
      unitLabel: 'litro',
      unitsPerCase: 6,
      casesPerPallet: null,
      minimumQuantity: 1,
      quantityIncrement: 1,
      maximumQuantity: null,
      weightGrams: 0,
      widthMm: 0,
      heightMm: 0,
      depthMm: 0,
      safetyStock: 0,
      backorderAllowed: false,
      leadTimeDays: null,
      color: null,
      image: null
    }
  ]
})
const category = () => ({
  id: 7,
  name: 'Familia privada',
  slug: 'familia-privada',
  parentId: null,
  sort: 1,
  count: 1,
  children: []
})
const listing = (): Record<string, unknown> => ({
  source: 'cloudflare',
  capabilities: { ...CAPABILITIES },
  items: [
    {
      id: 1,
      name: 'Producto sintético',
      slug: 'producto-sintetico',
      brand: 'Marca privada',
      categoryId: 7,
      categoryName: 'Familia privada',
      visual: { type: 'botella', color: '#123456' },
      featured: false,
      active: false,
      status: 'draft',
      series: null,
      minPrice: null,
      formats: 1
    }
  ]
})

type Identity = ReturnType<typeof identity>
const sessionFailures = ['not_ready', 'logged_out', 'role_lost', 'mfa_lost'] as const
function freshSession() {
  return {
    ready: ref(true),
    loggedIn: ref(true),
    user: ref<{ id: string; role: string; mfaVerified: boolean } | null>({
      id: 'synthetic-admin',
      role: 'admin',
      mfaVerified: true
    }),
    session: ref(null),
    clear: async () => undefined,
    fetch: async () => undefined,
    openInPopup: () => undefined
  }
}
let localSession: ReturnType<typeof freshSession>
function revokeSession(cause: (typeof sessionFailures)[number]) {
  if (cause === 'not_ready') localSession.ready.value = false
  if (cause === 'logged_out') {
    localSession.loggedIn.value = false
    localSession.user.value = null
  }
  if (cause === 'role_lost') localSession.user.value = { id: 'synthetic-admin', role: 'customer', mfaVerified: true }
  if (cause === 'mfa_lost') localSession.user.value = { id: 'synthetic-admin', role: 'admin', mfaVerified: false }
}
function restoreSession() {
  localSession.ready.value = true
  localSession.loggedIn.value = true
  localSession.user.value = { id: 'synthetic-admin', role: 'admin', mfaVerified: true }
}
function deferredResponse() {
  let resolve: (value: unknown) => void = () => {
    throw new Error('Response resolver not initialized')
  }
  const promise = new Promise<unknown>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}
function draftBody() {
  const variant = snapshot().variants[0]!
  const { id: _id, uuid: _uuid, status: _status, ...initialVariant } = variant
  return createDraftInputSchema.parse({
    expectedVersion: 0,
    reason: 'Alta sintética para comprobar sesión',
    name: 'Borrador sintético',
    categoryId: 7,
    brandId: BRAND,
    shortDesc: 'Descripción sintética breve',
    description: 'Descripción sintética completa',
    usage: null,
    series: null,
    featured: false,
    badges: [],
    visual: { type: 'botella', color: '#123456' },
    attrs: [],
    initialVariant
  })
}
const CreateProbe = defineComponent({
  name: 'DraftProductCreateProbe',
  props: {
    options: { type: null },
    optionsStatus: String,
    runtime: { type: null },
    refreshOptions: Function as PropType<() => Promise<unknown>>,
    authorize: Function as PropType<() => boolean>,
    onCreated: Function as PropType<(value: { id: number; uuid: string }) => Promise<unknown>>
  },
  setup: () => () => h('section', { 'data-draft-create': '' })
})
const VariantsProbe = defineComponent({
  name: 'DraftProductVariantsEditorProbe',
  props: {
    product: { type: null },
    productId: String,
    readStatus: String,
    options: { type: null },
    optionsStatus: String,
    runtime: { type: null },
    refreshOptions: Function as PropType<() => Promise<unknown>>,
    refreshProduct: Function as PropType<() => Promise<unknown>>,
    authorize: Function as PropType<(value: Identity) => boolean>
  },
  setup: () => () => h('section', { 'data-draft-variants': '' })
})
const Slot = defineComponent({
  setup:
    (_, { slots }) =>
    () =>
      h('section', [slots.default?.(), slots.actions?.()])
})
const Button = defineComponent({
  inheritAttrs: false,
  props: { to: String, loading: Boolean, disabled: Boolean },
  setup:
    (props, { attrs, slots }) =>
    () =>
      h(
        props.to ? 'a' : 'button',
        {
          ...attrs,
          type: attrs.type ?? 'button',
          href: props.to,
          disabled: props.disabled || props.loading
        },
        slots.default?.()
      )
})
const Table = defineComponent({
  props: { selectable: Boolean },
  setup:
    (props, { slots }) =>
    () =>
      h('section', { 'data-table': '', 'data-selectable': String(props.selectable) }, [
        slots.filters?.(),
        slots['empty-action']?.()
      ])
})
const stubs = {
  DraftProductCreate: CreateProbe,
  DraftProductVariantsEditor: VariantsProbe,
  DraftVariantFields: true,
  DraftProductMetadataEditor: true,
  CatalogPublicationReadiness: true,
  ProductStatusEditor: true,
  ProductPublicationPolicyEditor: true,
  UiPageHeader: Slot,
  UiDataTable: Table,
  UButton: Button,
  UBadge: Slot,
  UIcon: true,
  ProductVisual: true,
  UInput: true,
  UTextarea: true,
  USelect: true,
  UFormField: Slot,
  UDropdownMenu: true,
  UModal: true
}
type Wrapper = Awaited<ReturnType<typeof mountSuspended>>
type PageActions = {
  save(): Promise<void>
  removeProduct(): Promise<void>
  addVariant(): void
  removeVariant(index: number): void
  form: { variants: unknown[] }
}
let wrapper: Wrapper | undefined
let currentOptions: ReturnType<typeof shallowRef<unknown>>
let optionsStatus: ReturnType<typeof ref<string>>
let currentProduct: ReturnType<typeof shallowRef<Record<string, unknown>>>
let productStatus: ReturnType<typeof ref<string>>
let currentList: ReturnType<typeof shallowRef<Record<string, unknown>>>
let listStatus: ReturnType<typeof ref<string>>
let runtime: { app: { baseURL: string; buildAssetsDir: string; cdnURL: string }; public: { serverRuntime: string } }
const refreshOptions = vi.fn<() => Promise<unknown>>()
const refreshProduct = vi.fn<() => Promise<unknown>>()
function pageActions(page: Wrapper) {
  return proxyRefs(page.vm.$.setupState) as PageActions
}
async function render(
  page: 'new' | 'detail' | 'list',
  options: {
    runtime?: string
    id?: string
    options?: unknown
    optionsStatus?: string
    product?: Record<string, unknown>
    productStatus?: string
    list?: Record<string, unknown>
    listStatus?: string
    realAuthoring?: boolean
  } = {}
) {
  runtime = reactive({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: options.runtime ?? 'cloudflare' }
  })
  runtimeMock.mockReturnValue(runtime)
  const id = options.id ?? (page === 'new' ? 'nuevo' : '1')
  routeMock.mockReturnValue({
    params: { id },
    query: {},
    path: `/admin/productos/${id}`,
    fullPath: `/admin/productos/${id}`
  })
  currentOptions = shallowRef(Object.hasOwn(options, 'options') ? options.options : references())
  optionsStatus = ref(options.optionsStatus ?? 'success')
  const detail = options.product ?? product()
  const list = options.list ?? listing()
  if (runtime.public.serverRuntime === 'node' && !options.product) delete detail.source
  if (runtime.public.serverRuntime === 'node' && !options.list) delete list.source
  currentProduct = shallowRef(detail)
  productStatus = ref(options.productStatus ?? 'success')
  currentList = shallowRef(list)
  listStatus = ref(options.listStatus ?? 'success')
  fetchMock.mockImplementation((url: string) => {
    if (url === '/api/admin/products/authoring-options')
      return { data: currentOptions, status: optionsStatus, error: ref(null), refresh: refreshOptions }
    if (url.endsWith('categories'))
      return {
        data: shallowRef({
          roots: [category()],
          flat: [category()],
          capabilities: { categoriesRead: true, productCreate: false },
          ...(runtime.public.serverRuntime === 'node' ? {} : { source: 'cloudflare' })
        }),
        status: ref('success'),
        error: ref(null),
        refresh: vi.fn()
      }
    if (url === '/api/admin/products')
      return { data: currentList, status: listStatus, error: ref(null), refresh: vi.fn() }
    if (url === `/api/admin/products/${id}`)
      return { data: currentProduct, status: productStatus, error: ref(null), refresh: refreshProduct }
    throw new Error(`Unexpected scoped fetch: ${url}`)
  })
  wrapper = await mountSuspended(page === 'list' ? ProductsPage : ProductPage, {
    global: {
      stubs: options.realAuthoring
        ? { ...stubs, DraftProductCreate: false, DraftProductVariantsEditor: false, DraftVariantFields: false }
        : stubs
    }
  })
  return wrapper
}
function authoringCalls() {
  return fetchMock.mock.calls
    .filter(([url]) => url === '/api/admin/products/authoring-options')
    .map((call) => call.slice(0, 2))
}
function noWrites() {
  expect(requestMock).not.toHaveBeenCalled()
  expect(navigateMock).not.toHaveBeenCalled()
  expect(refreshDataMock).not.toHaveBeenCalled()
}
beforeEach(() => {
  localSession = freshSession()
  sessionMock.mockReset().mockReturnValue(localSession)
  fetchMock.mockReset()
  requestMock.mockReset()
  navigateMock.mockReset().mockResolvedValue(undefined)
  refreshDataMock.mockReset().mockResolvedValue(undefined)
  refreshOptions.mockReset().mockResolvedValue(undefined)
  refreshProduct.mockReset().mockResolvedValue(undefined)
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
})

describe('draft authoring page integration stays separate from legacy product CRUD', () => {
  it.each(['cloudflare', 'node', 'unknown'])(
    'declares authoring reference GET only active in explicit Cloudflare: %s',
    async (value) => {
      const page = await render('new', { runtime: value })
      expect(authoringCalls()).toEqual([
        [
          '/api/admin/products/authoring-options',
          {
            key: 'admin-catalog-draft-authoring-options',
            immediate: value === 'cloudflare',
            server: value === 'cloudflare'
          }
        ]
      ])
      expect(page.findComponent(CreateProbe).exists()).toBe(value === 'cloudflare')
      expect(page.findComponent(VariantsProbe).exists()).toBe(false)
      expect(fetchMock.mock.calls.some(([url]) => url === '/api/admin/products/nuevo')).toBe(false)
      if (value === 'unknown') expect(page.find('form').exists()).toBe(false)
      noWrites()
    }
  )
  it('passes the authoritative private reference DTO and guarded callbacks to the new draft component', async () => {
    const page = await render('new')
    const child = page.getComponent(CreateProbe)
    expect(child.props()).toEqual({
      options: references(),
      optionsStatus: 'success',
      runtime: 'cloudflare',
      authorize: expect.any(Function),
      refreshOptions: expect.any(Function),
      onCreated: expect.any(Function)
    })
    expect(child.props('authorize')!()).toBe(true)
    expect(page.find('#product-form').exists()).toBe(false)
    await pageActions(page).save()
    expect(requestMock).not.toHaveBeenCalled()
    await child.props('onCreated')!({ id: 23, uuid: PRODUCT })
    expect(navigateMock).toHaveBeenCalledExactlyOnceWith('/admin/productos/23')
  })
  it.each(['idle', 'pending', 'error'])(
    'new draft callback does not confirm cached references during %s',
    async (value) => {
      const page = await render('new', { optionsStatus: value })
      const child = page.getComponent(CreateProbe)
      expect(child.props('authorize')!()).toBe(false)
      await expect(child.props('onCreated')!({ id: 23, uuid: PRODUCT })).rejects.toThrow(
        'draft_creation_authority_unavailable'
      )
      if (value === 'pending') {
        await child.props('refreshOptions')!()
        expect(refreshOptions).not.toHaveBeenCalled()
      }
      noWrites()
    }
  )
  it.each([
    'missing',
    'wrong_source',
    'numeric_capability',
    'inherited_capability',
    'getter_capability',
    'missing_reference',
    'cycle'
  ])('rejects %s private reference DTO before enabling new-draft authority', async (poison) => {
    const getter = vi.fn(() => true)
    let value: unknown = references()
    if (poison === 'missing') value = undefined
    if (poison === 'wrong_source') value = { ...references(), source: 'node' }
    if (poison === 'numeric_capability') value = { ...references(), capabilities: { ...NARROW, productDraftCreate: 1 } }
    if (poison === 'inherited_capability')
      value = { ...references(), capabilities: Object.assign(Object.create({ productDraftCreate: true }), NARROW) }
    if (poison === 'getter_capability')
      value = {
        ...references(),
        capabilities: Object.defineProperty({ ...NARROW }, 'productDraftCreate', { enumerable: true, get: getter })
      }
    if (poison === 'missing_reference') value = { ...references(), shippingProfiles: undefined }
    if (poison === 'cycle')
      value = { ...references(), categories: [{ id: 7, name: 'Ciclo', parentId: 7, status: 'draft' }] }
    const page = await render('new', { options: value })
    expect(page.getComponent(CreateProbe).props('authorize')!()).toBe(false)
    expect(getter).not.toHaveBeenCalled()
    noWrites()
  })
  it('cached creation/navigation/reference callbacks recheck current capabilities and runtime', async () => {
    const page = await render('new')
    const child = page.getComponent(CreateProbe)
    const authority = child.props('authorize')!
    const created = child.props('onCreated')!
    const reload = child.props('refreshOptions')!
    currentOptions.value = { ...references(), capabilities: { ...NARROW, productDraftCreate: false } }
    expect(authority()).toBe(false)
    await expect(created({ id: 23, uuid: PRODUCT })).rejects.toThrow()
    currentOptions.value = references()
    expect(authority()).toBe(true)
    runtime.public.serverRuntime = 'unknown'
    expect(authority()).toBe(false)
    await expect(created({ id: 23, uuid: PRODUCT })).rejects.toThrow()
    await reload()
    expect(refreshOptions).not.toHaveBeenCalled()
    noWrites()
  })
  it.each(sessionFailures)('cached draft creation callbacks fail closed after local session %s', async (cause) => {
    const page = await render('new')
    const child = page.getComponent(CreateProbe)
    const authorize = child.props('authorize')!
    const created = child.props('onCreated')!
    const refresh = child.props('refreshOptions')!
    expect(authorize()).toBe(true)
    revokeSession(cause)
    expect(optionsStatus.value).toBe('success')
    expect(currentOptions.value).toEqual(references())
    expect(authorize()).toBe(false)
    await expect(created({ id: 23, uuid: PRODUCT })).rejects.toThrow('draft_creation_authority_unavailable')
    await refresh()
    expect(refreshOptions).not.toHaveBeenCalled()
    restoreSession()
    expect(authorize()).toBe(true)
    expect(refreshOptions).not.toHaveBeenCalled()
    noWrites()
  })
  it('a real creation receipt arriving after local logout cannot navigate or re-submit while authority is lost', async () => {
    const response = deferredResponse()
    requestMock.mockReturnValue(response.promise)
    const page = await render('new', { realAuthoring: true })
    const child = page.getComponent(DraftProductCreate)
    const state = proxyRefs(child.vm.$.setupState) as {
      form: Record<string, unknown>
      submit(): Promise<void>
      retry(): Promise<void>
    }
    state.form = draftBody()
    const pending = state.submit()
    expect(requestMock).toHaveBeenCalledOnce()
    revokeSession('logged_out')
    await nextTick()
    response.resolve({
      source: 'cloudflare',
      action: 'create_draft',
      productId: 23,
      productUuid: PRODUCT,
      variantId: 11,
      variantUuid: VARIANT,
      catalogVersion: 1,
      updated: true
    })
    await pending
    await state.retry()
    expect(navigateMock).not.toHaveBeenCalled()
    expect(refreshOptions).not.toHaveBeenCalled()
    expect(refreshProduct).not.toHaveBeenCalled()
    expect(requestMock).toHaveBeenCalledOnce()
  })
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('refuses noncanonical created legacy identity %s', async (id) => {
    const page = await render('new')
    await expect(page.getComponent(CreateProbe).props('onCreated')!({ id, uuid: PRODUCT })).rejects.toThrow()
    noWrites()
  })
  it('passes detail identity/version, private snapshot and references to the separate variants editor', async () => {
    const page = await render('detail')
    const child = page.getComponent(VariantsProbe)
    expect(child.props()).toEqual({
      product: product(),
      productId: '1',
      readStatus: 'success',
      options: references(),
      optionsStatus: 'success',
      runtime: 'cloudflare',
      authorize: expect.any(Function),
      refreshProduct: expect.any(Function),
      refreshOptions: expect.any(Function)
    })
    expect(child.props('authorize')!(identity())).toBe(true)
    expect(page.findComponent(CreateProbe).exists()).toBe(false)
    expect(page.get('#product-form > fieldset').attributes('disabled')).toBeDefined()
    const state = pageActions(page)
    await state.save()
    await state.removeProduct()
    state.addVariant()
    state.removeVariant(0)
    expect(state.form.variants).toHaveLength(1)
    noWrites()
  })
  it.each(['node', 'unknown'])('never mounts the private variants editor in %s', async (value) => {
    const page = await render('detail', { runtime: value })
    expect(page.findComponent(VariantsProbe).exists()).toBe(false)
    expect(page.findComponent(CreateProbe).exists()).toBe(false)
    expect(authoringCalls()[0]?.[1]).toEqual(expect.objectContaining({ immediate: false, server: false }))
    await pageActions(page).save()
    await pageActions(page).removeProduct()
    noWrites()
  })
  it.each(['01', '0', '-1', '1.0', '9007199254740992'])(
    'does not mount/fetch a private detail editor for noncanonical route %s',
    async (id) => {
      const page = await render('detail', { id })
      expect(page.findComponent(VariantsProbe).exists()).toBe(false)
      const call = fetchMock.mock.calls.find(([url]) => url === `/api/admin/products/${id}`)
      expect(call?.[1]).toEqual(expect.objectContaining({ immediate: false, server: false }))
      noWrites()
    }
  )
  it.each(['draft', 'review', 'published', 'hidden', 'discontinued'])(
    'retains current identity authority for historical replay in valid %s without enabling legacy CRUD',
    async (value) => {
      const page = await render('detail', {
        product: { ...product(), status: value, authoring: { ...snapshot(), status: value } }
      })
      expect(page.getComponent(VariantsProbe).props('authorize')!(identity())).toBe(true)
      await pageActions(page).save()
      expect(page.get('#product-form > fieldset').attributes('disabled')).toBeDefined()
      noWrites()
    }
  )
  it.each([
    'pending',
    'error',
    'id',
    'uuid',
    'version',
    'source',
    'capability',
    'inherited_capability',
    'getter_capability',
    'own_authoring',
    'runtime'
  ])('cached parent variants callback rechecks %s authority synchronously', async (change) => {
    const getter = vi.fn(() => true)
    const page = await render('detail')
    const authority = page.getComponent(VariantsProbe).props('authorize')!
    expect(authority(identity())).toBe(true)
    if (change === 'pending' || change === 'error') productStatus.value = change
    if (change === 'id') currentProduct.value = { ...product(), id: 2 }
    if (change === 'uuid') currentProduct.value = { ...product(), uuid: BRAND }
    if (change === 'version') currentProduct.value = { ...product(), catalogVersion: VERSION + 1 }
    if (change === 'source') currentProduct.value = { ...product(), source: 'node' }
    if (change === 'capability')
      currentProduct.value = { ...product(), capabilities: { ...CAPABILITIES, productDetailRead: false } }
    if (change === 'inherited_capability')
      currentProduct.value = { ...product(), capabilities: Object.create({ ...CAPABILITIES }) }
    if (change === 'getter_capability')
      currentProduct.value = {
        ...product(),
        capabilities: Object.defineProperty({ ...CAPABILITIES }, 'productDetailRead', { enumerable: true, get: getter })
      }
    if (change === 'own_authoring') {
      const value = product(),
        authoring = value.authoring
      delete value.authoring
      currentProduct.value = Object.assign(Object.create({ authoring }), value)
    }
    if (change === 'runtime') runtime.public.serverRuntime = 'unknown'
    expect(authority(identity())).toBe(false)
    expect(getter).not.toHaveBeenCalled()
    noWrites()
  })
  it.each([
    { uuid: 'not-a-private-uuid', version: VERSION },
    { uuid: PRODUCT, version: 0 },
    { uuid: PRODUCT, version: 1.5 },
    { uuid: PRODUCT, version: Number.MAX_SAFE_INTEGER + 1 }
  ])('parent callback rejects malformed matching private identity/version %#', async (value) => {
    const page = await render('detail', { product: { ...product(), uuid: value.uuid, catalogVersion: value.version } })
    expect(
      page.getComponent(VariantsProbe).props('authorize')!({ id: 1, uuid: value.uuid, version: value.version })
    ).toBe(false)
    noWrites()
  })
  it('rejects foreign child identity without changing the confirmed detail and guards GET refresh concurrency', async () => {
    const page = await render('detail')
    const child = page.getComponent(VariantsProbe)
    const authority = child.props('authorize')!
    for (const value of [
      { ...identity(), id: 2 },
      { ...identity(), uuid: BRAND },
      { ...identity(), version: VERSION + 1 }
    ])
      expect(authority(value)).toBe(false)
    await child.props('refreshProduct')!()
    await child.props('refreshOptions')!()
    expect(refreshProduct).toHaveBeenCalledExactlyOnceWith()
    expect(refreshOptions).toHaveBeenCalledExactlyOnceWith()
    productStatus.value = 'pending'
    optionsStatus.value = 'pending'
    await child.props('refreshProduct')!()
    await child.props('refreshOptions')!()
    expect(refreshProduct).toHaveBeenCalledOnce()
    expect(refreshOptions).toHaveBeenCalledOnce()
    expect(currentProduct.value).toEqual(product())
    noWrites()
  })
  it.each(sessionFailures)(
    'cached draft variant authority and read callbacks reject local session %s',
    async (cause) => {
      const page = await render('detail')
      const child = page.getComponent(VariantsProbe)
      const authorize = child.props('authorize')!
      const reload = child.props('refreshProduct')!
      const optionsReload = child.props('refreshOptions')!
      expect(authorize(identity())).toBe(true)
      revokeSession(cause)
      expect(productStatus.value).toBe('success')
      expect(currentProduct.value).toEqual(product())
      expect(authorize(identity())).toBe(false)
      await reload()
      await optionsReload()
      expect(refreshProduct).not.toHaveBeenCalled()
      expect(refreshOptions).not.toHaveBeenCalled()
      restoreSession()
      expect(authorize(identity())).toBe(true)
      expect(refreshProduct).not.toHaveBeenCalled()
      noWrites()
    }
  )
  it('a real late variant receipt cannot refetch after MFA loss; manual replay retains the original command after recovery', async () => {
    const response = deferredResponse()
    requestMock.mockReturnValue(response.promise)
    const page = await render('detail', { realAuthoring: true })
    const child = page.getComponent(DraftProductVariantsEditor)
    const state = proxyRefs(child.vm.$.setupState) as {
      variantForm: Record<string, unknown>
      variantReason: string
      saveVariant(): Promise<void>
      retry(): Promise<void>
    }
    state.variantForm = { ...state.variantForm, format: 'Formato sintético actualizado' }
    state.variantReason = 'Cambio sintético para comprobar sesión'
    const pending = state.saveVariant()
    expect(requestMock).toHaveBeenCalledOnce()
    const original = requestMock.mock.calls[0]
    const receipt = {
      source: 'cloudflare',
      action: 'update_variant',
      productId: 1,
      productUuid: PRODUCT,
      variantId: 11,
      variantUuid: VARIANT,
      catalogVersion: VERSION + 1,
      updated: true
    }
    revokeSession('mfa_lost')
    await nextTick()
    response.resolve(receipt)
    await pending
    await state.retry()
    expect(refreshProduct).not.toHaveBeenCalled()
    expect(refreshOptions).not.toHaveBeenCalled()
    expect(requestMock).toHaveBeenCalledOnce()
    expect(navigateMock).not.toHaveBeenCalled()
    currentProduct.value = {
      ...product(),
      status: 'published',
      catalogVersion: VERSION + 2,
      authoring: {
        ...snapshot(),
        status: 'published',
        catalogVersion: VERSION + 2,
        variants: snapshot().variants.map((variant) => ({ ...variant, status: 'discontinued' }))
      }
    }
    restoreSession()
    await nextTick()
    expect(requestMock).toHaveBeenCalledOnce()
    requestMock.mockResolvedValue(receipt)
    await state.retry()
    expect(requestMock).toHaveBeenCalledTimes(2)
    expect(requestMock.mock.calls[1]?.[0]).toBe(original?.[0])
    expect(requestMock.mock.calls[1]?.[1]).toMatchObject({
      method: original?.[1]?.method,
      body: original?.[1]?.body,
      headers: original?.[1]?.headers,
      retry: 0
    })
    expect(refreshProduct).toHaveBeenCalledExactlyOnceWith()
    expect(currentProduct.value.catalogVersion).toBe(VERSION + 2)
    expect(currentProduct.value.status).toBe('published')
  })
  it('keeps the Node full editor available only through existing explicit legacy capability', async () => {
    const nodeProduct = product()
    delete nodeProduct.source
    nodeProduct.capabilities = { productUpdate: true, productDelete: false }
    const page = await render('detail', { runtime: 'node', product: nodeProduct })
    expect(page.get('#product-form > fieldset').attributes('disabled')).toBeUndefined()
    expect(page.findComponent(VariantsProbe).exists()).toBe(false)
    const state = pageActions(page)
    state.addVariant()
    expect(state.form.variants).toHaveLength(2)
    noWrites()
  })
  it('keys the product page by route legacy identity so navigation remounts pending command ownership', () => {
    expect(productPageSource).toMatch(/definePageMeta\(\{[^}]*key:\s*\(route\)\s*=>\s*String\(route\.params\.id\)/)
  })
})

describe('catalog list offers narrow draft creation only from a fresh confirmed read', () => {
  it('offers a draft route from Cloudflare own productsRead/productDraftCreate without enabling legacy status/delete', async () => {
    const page = await render('list')
    expect(page.find('[href="/admin/productos/nuevo"]').exists()).toBe(true)
    expect(page.get('[data-table]').attributes('data-selectable')).toBe('false')
    expect(authoringCalls()).toEqual([])
    noWrites()
  })
  it.each(sessionFailures)(
    'Cloudflare Nuevo disappears after session %s despite a cached successful list',
    async (cause) => {
      const page = await render('list')
      expect(page.find('[href="/admin/productos/nuevo"]').exists()).toBe(true)
      revokeSession(cause)
      await nextTick()
      expect(listStatus.value).toBe('success')
      expect(currentList.value).toEqual(listing())
      expect(page.find('[href="/admin/productos/nuevo"]').exists()).toBe(false)
      restoreSession()
      await nextTick()
      expect(page.find('[href="/admin/productos/nuevo"]').exists()).toBe(true)
      noWrites()
    }
  )
  it('preserves the existing explicit Node creation capability without applying the new D1 session gate', async () => {
    revokeSession('logged_out')
    const page = await render('list', {
      runtime: 'node',
      list: { items: [], capabilities: { productCreate: true, productStatusUpdate: false, productDelete: false } }
    })
    expect(page.find('[href="/admin/productos/nuevo"]').exists()).toBe(true)
    noWrites()
  })
  it.each(['idle', 'pending', 'error'])('never offers draft creation from cached %s list state', async (value) => {
    const page = await render('list', { listStatus: value })
    expect(page.find('[href="/admin/productos/nuevo"]').exists()).toBe(false)
    noWrites()
  })
  it.each([
    'missing_source',
    'wrong_source',
    'missing_items',
    'missing_capabilities',
    'missing_read',
    'missing_create',
    'string_create',
    'inherited_capabilities',
    'getter_create'
  ])('does not offer draft creation from %s list DTO', async (poison) => {
    const value = listing(),
      getter = vi.fn(() => true)
    if (poison === 'missing_source') delete value.source
    if (poison === 'wrong_source') value.source = 'node'
    if (poison === 'missing_items') delete value.items
    if (poison === 'missing_capabilities') delete value.capabilities
    if (poison === 'missing_read') value.capabilities = { ...CAPABILITIES, productsRead: false }
    if (poison === 'missing_create') value.capabilities = { ...CAPABILITIES, productDraftCreate: false }
    if (poison === 'string_create') value.capabilities = { ...CAPABILITIES, productDraftCreate: 'true' }
    if (poison === 'inherited_capabilities') value.capabilities = Object.create({ ...CAPABILITIES })
    if (poison === 'getter_create')
      value.capabilities = Object.defineProperty({ ...CAPABILITIES }, 'productDraftCreate', {
        enumerable: true,
        get: getter
      })
    const page = await render('list', { list: value })
    expect(page.find('[href="/admin/productos/nuevo"]').exists()).toBe(false)
    expect(getter).not.toHaveBeenCalled()
    noWrites()
  })
  it('revokes and recovers the creation link with the current GET status/capability, never a write', async () => {
    const page = await render('list')
    expect(page.find('[href="/admin/productos/nuevo"]').exists()).toBe(true)
    listStatus.value = 'pending'
    await nextTick()
    expect(page.find('[href="/admin/productos/nuevo"]').exists()).toBe(false)
    listStatus.value = 'success'
    currentList.value = { ...listing(), capabilities: { ...CAPABILITIES, productDraftCreate: false } }
    await nextTick()
    expect(page.find('[href="/admin/productos/nuevo"]').exists()).toBe(false)
    currentList.value = listing()
    await nextTick()
    expect(page.find('[href="/admin/productos/nuevo"]').exists()).toBe(true)
    noWrites()
  })
  it.each(['node', 'unknown'])(
    'five authoring capabilities do not enable legacy product creation in %s',
    async (value) => {
      const page = await render('list', {
        runtime: value,
        list: { items: [], capabilities: { ...NARROW, productsRead: true } }
      })
      expect(page.find('[href="/admin/productos/nuevo"]').exists()).toBe(false)
      expect(page.get('[data-table]').attributes('data-selectable')).toBe('false')
      noWrites()
    }
  )
  it('never treats an unknown runtime and a legacy capability-less payload as Node creation authority', async () => {
    const page = await render('list', { runtime: 'unknown', list: { items: [] } })
    expect(page.find('[href="/admin/productos/nuevo"]').exists()).toBe(false)
    noWrites()
  })
})
