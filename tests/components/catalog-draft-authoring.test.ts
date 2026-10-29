import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h, proxyRefs, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import DraftProductCreate from '../../app/components/DraftProductCreate.vue'
import DraftProductVariantsEditor from '../../app/components/DraftProductVariantsEditor.vue'
import {
  createDraftInputSchema,
  type CreateDraftInput,
  type DraftVariantInput
} from '../../shared/catalog-draft-authoring'
import {
  CATALOG_DRAFT_AUTHORING_CAPABILITIES,
  catalogDraftAuthoringOptionsSchema,
  catalogDraftAuthoringSnapshotSchema
} from '../../shared/catalog-draft-authoring-options'
import '#app/nuxt-vitest-app-entry'

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }))
mockNuxtImport('$fetch', () => requestMock)
const PRODUCT = 'a1000000-0000-4000-8000-000000000001'
const VARIANT = 'b1000000-0000-4000-8000-000000000001'
const SECOND = 'b1000000-0000-4000-8000-000000000002'
const BRAND = 'c1000000-0000-4000-8000-000000000001'
const OTHER_BRAND = 'c1000000-0000-4000-8000-000000000002'
const TAX = 'd1000000-0000-4000-8000-000000000001'
const SHIPPING = 'e1000000-0000-4000-8000-000000000001'
const NEW_VARIANT = 'b1000000-0000-4000-8000-000000000099'
const capabilities = (): Record<keyof typeof CATALOG_DRAFT_AUTHORING_CAPABILITIES, boolean> => ({
  ...CATALOG_DRAFT_AUTHORING_CAPABILITIES
})
const fields = (): DraftVariantInput => ({
  sku: 'DRAFT-001',
  format: 'Caja de prueba',
  ean: null,
  gtin: null,
  mpn: 'REF-001',
  taxClassId: TAX,
  shippingProfileId: SHIPPING,
  unitBase: 'ud',
  unitLabel: 'unidad',
  contentQuantity: 1,
  unitsPerCase: 1,
  casesPerPallet: null,
  minimumQuantity: 1,
  quantityIncrement: 1,
  maximumQuantity: null,
  weightGrams: 0,
  widthMm: 0,
  heightMm: 0,
  depthMm: 0,
  backorderAllowed: false,
  leadTimeDays: 0,
  color: null
})
const options = () => ({
  source: 'cloudflare',
  capabilities: capabilities(),
  categories: [{ id: 7, name: 'Categoría oculta válida', parentId: null, status: 'hidden' }],
  brands: [
    { id: BRAND, name: 'Marca original', status: 'draft' },
    { id: OTHER_BRAND, name: 'Otra marca', status: 'review' }
  ],
  taxClasses: [
    {
      id: TAX,
      code: 'standard',
      name: 'Fiscalidad vigente',
      rateBasisPoints: 2100,
      validFrom: '2026-01-01T00:00:00Z',
      validUntil: null
    }
  ],
  shippingProfiles: [{ id: SHIPPING, code: 'parcel', name: 'Paquetería', kind: 'parcel' }]
})
const product = () => ({
  source: 'cloudflare',
  id: 1,
  uuid: PRODUCT,
  catalogVersion: 1,
  status: 'draft',
  capabilities: { productDetailRead: true, ...capabilities(), productUpdate: false },
  slug: 'fixed-slug',
  attrs: [{ k: 'Material', v: 'Original' }],
  badges: ['eco'],
  visual: { type: 'caja', color: '#123456', protected: 'preserve' },
  authoring: {
    productId: 1,
    productUuid: PRODUCT,
    catalogVersion: 1,
    status: 'draft',
    brandId: BRAND,
    variants: [
      { id: 11, uuid: VARIANT, status: 'draft', ...fields() },
      { id: 12, uuid: SECOND, status: 'published', ...fields(), sku: 'DRAFT-002' }
    ]
  }
})
const createBody = (): CreateDraftInput => ({
  expectedVersion: 0,
  reason: 'Alta editorial motivada',
  name: 'Producto borrador nuevo',
  categoryId: 7,
  brandId: BRAND,
  shortDesc: 'Descripción breve válida',
  description: 'Descripción completa\nSegunda línea',
  usage: null,
  series: null,
  featured: false,
  badges: ['concentrado', 'eco'],
  visual: { type: 'caja', color: '#123456' },
  attrs: [
    { k: 'Segundo', v: 'Dos' },
    { k: 'Primero', v: 'Uno' }
  ],
  initialVariant: fields()
})
const receipt = (action = 'update_variant', overrides: Record<string, unknown> = {}) => ({
  source: 'cloudflare',
  action,
  productId: 1,
  productUuid: PRODUCT,
  catalogVersion: action === 'create_draft' ? 1 : 2,
  variantId: action === 'assign_brand' ? null : action === 'create_variant' ? 99 : 11,
  variantUuid: action === 'assign_brand' ? null : action === 'create_variant' ? NEW_VARIANT : VARIANT,
  updated: true,
  ...overrides
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
const mounted: Array<{ unmount: () => void }> = []
async function renderCreate(overrides: Record<string, unknown> = {}) {
  const authority = ref(true),
    reload = vi.fn<() => Promise<unknown>>(async () => undefined),
    created = vi.fn<({ id, uuid }: { id: number; uuid: string }) => Promise<unknown>>(async () => undefined)
  const wrapper = await mountSuspended(DraftProductCreate, {
    props: {
      options: options(),
      optionsStatus: 'success',
      runtime: 'cloudflare',
      authorize: () => authority.value,
      refreshOptions: reload,
      onCreated: created,
      ...overrides
    },
    global: { stubs: { UButton: Button } }
  })
  mounted.push(wrapper)
  return { wrapper, authority, reload, created }
}
async function renderVariants(overrides: Record<string, unknown> = {}) {
  const authority = ref(true),
    data = ref(product()),
    optionsReload = vi.fn<() => Promise<unknown>>(async () => undefined)
  let update: (value: ReturnType<typeof product>) => Promise<void> = async () => undefined
  const reload = vi.fn<() => Promise<unknown>>(async () => {
    data.value = {
      ...data.value,
      catalogVersion: 2,
      authoring: {
        ...data.value.authoring,
        catalogVersion: 2,
        variants: data.value.authoring.variants.map((entry) => ({ ...entry, format: 'Valor actual del servidor' }))
      }
    }
    await update(data.value)
  })
  const authorize = vi.fn(
    (identity: { id: number; uuid: string; version: number }) =>
      authority.value && identity.id === 1 && identity.uuid === PRODUCT && identity.version >= 1
  )
  const wrapper = await mountSuspended(DraftProductVariantsEditor, {
    props: {
      product: data.value,
      productId: '1',
      readStatus: 'success',
      options: options(),
      optionsStatus: 'success',
      runtime: 'cloudflare',
      authorize,
      refreshProduct: reload,
      refreshOptions: optionsReload,
      ...overrides
    },
    global: { stubs: { UButton: Button } }
  })
  update = async (value) => {
    await wrapper.setProps({ product: value })
  }
  mounted.push(wrapper)
  return { wrapper, authority, data, reload, optionsReload, authorize }
}
type Wrapper =
  Awaited<ReturnType<typeof renderCreate>>['wrapper'] | Awaited<ReturnType<typeof renderVariants>>['wrapper']
function state(wrapper: Wrapper) {
  return proxyRefs(wrapper.setupState) as Record<string, unknown>
}
async function invoke(wrapper: Wrapper, method: string, ...args: unknown[]) {
  const handler = state(wrapper)[method]
  if (typeof handler !== 'function') throw new Error(`Missing method ${method}`)
  await handler(...args)
}
async function prepareCreate(wrapper: Wrapper) {
  Object.assign(state(wrapper).form as object, createBody())
  await flushPromises()
}
async function prepareCreateDom(wrapper: Wrapper) {
  for (const [key, value] of Object.entries({
    name: 'Nombre nuevo válido',
    shortDesc: 'Descripción breve válida',
    description: 'Descripción completa válida',
    reason: 'Alta editorial motivada',
    categoryId: '7',
    brandId: BRAND,
    sku: 'DRAFT-DOM',
    format: 'Caja de prueba',
    unitBase: 'ud',
    unitLabel: 'unidad',
    taxClassId: TAX,
    shippingProfileId: SHIPPING
  }))
    await wrapper.get(`[data-field="${key}"]`).setValue(value)
}
async function prepareUpdate(wrapper: Wrapper) {
  await wrapper.get('[data-field="format"]').setValue('Formato actualizado')
  await wrapper.get('[data-field="variantReason"]').setValue('Corrección de formato motivada')
}
function lastCall() {
  return requestMock.mock.calls.at(-1)!
}
function deferred() {
  let resolve!: (value: unknown) => void, reject!: (cause: unknown) => void
  const promise = new Promise<unknown>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
beforeEach(() => {
  requestMock.mockReset().mockResolvedValue(receipt())
})
afterEach(() => mounted.splice(0).forEach((wrapper) => wrapper.unmount()))

describe('draft authoring contracts and accessible forms', () => {
  it('uses real shared schemas for fixtures, references and private authoring without finance fields', () => {
    expect(createDraftInputSchema.safeParse(createBody()).success).toBe(true)
    expect(catalogDraftAuthoringOptionsSchema.safeParse(options()).success).toBe(true)
    expect(catalogDraftAuthoringSnapshotSchema.safeParse(product().authoring).success).toBe(true)
  })
  it('groups creation identity, units and logistics and exposes no financial, stock, slug or publication inputs', async () => {
    const { wrapper } = await renderCreate()
    expect(wrapper.text()).toContain('precio pendiente de aprobación (0) y stock 0')
    expect(wrapper.text()).toContain('No publica')
    expect(wrapper.findAll('legend').map((entry) => entry.text())).toEqual(
      expect.arrayContaining([
        'Identidad y metadatos',
        'Identidad de la variante',
        'Unidades y cantidades',
        'Fiscalidad y logística'
      ])
    )
    expect(
      wrapper.find('input[name="price"], input[name="stock"], input[name="slug"], input[type="file"]').exists()
    ).toBe(false)
    for (const label of wrapper.findAll('label[for]'))
      expect(wrapper.find(`[id="${label.attributes('for')}"]`).exists()).toBe(true)
    expect(wrapper.get('[data-action="create"]').attributes('disabled')).toBeDefined()
  })
  it('submits exactly the explicit metadata/initial variant contract, preserving ordered attrs and nullable zero values', async () => {
    requestMock.mockResolvedValue(receipt('create_draft'))
    const { wrapper, created } = await renderCreate()
    await prepareCreate(wrapper)
    await invoke(wrapper, 'submit')
    expect(requestMock).toHaveBeenCalledOnce()
    expect(lastCall()[0]).toBe('/api/admin/products')
    expect(lastCall()[1]).toMatchObject({
      method: 'POST',
      body: createBody(),
      retry: 0,
      headers: { Origin: window.location.origin }
    })
    expect(lastCall()[1].headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/)
    expect(created).toHaveBeenCalledWith({ id: 1, uuid: PRODUCT })
    expect(wrapper.text()).toContain('Borrador creado')
    await invoke(wrapper, 'submit')
    expect(requestMock).toHaveBeenCalledOnce()
  })
  it('enables and submits a creation form through real DOM events without selecting references implicitly', async () => {
    requestMock.mockResolvedValue(receipt('create_draft'))
    const { wrapper } = await renderCreate()
    await prepareCreateDom(wrapper)
    expect(wrapper.get('[data-action="create"]').attributes('disabled')).toBeUndefined()
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(requestMock).toHaveBeenCalledOnce()
    expect(createDraftInputSchema.safeParse(lastCall()[1].body).success).toBe(true)
    expect(lastCall()[1].body.initialVariant).toMatchObject({
      sku: 'DRAFT-DOM',
      taxClassId: TAX,
      shippingProfileId: SHIPPING,
      weightGrams: 0,
      casesPerPallet: null,
      maximumQuantity: null
    })
  })
  it('sends a partial variant diff only and refetches current state rather than installing the receipt version', async () => {
    const { wrapper, reload } = await renderVariants()
    await prepareUpdate(wrapper)
    Object.assign(state(wrapper).variantForm as object, {
      price: 999,
      stock: 88,
      slug: 'forged',
      attrs: [{ k: 'forged', v: 'forged' }]
    })
    await invoke(wrapper, 'saveVariant')
    expect(lastCall()[0]).toBe('/api/admin/products/1/variants/11')
    expect(lastCall()[1]).toMatchObject({
      method: 'PUT',
      retry: 0,
      body: { format: 'Formato actualizado', expectedVersion: 1, reason: 'Corrección de formato motivada' }
    })
    expect(Object.keys(lastCall()[1].body).sort()).toEqual(['expectedVersion', 'format', 'reason'])
    expect(reload).toHaveBeenCalledOnce()
    expect(wrapper.get('[data-field="format"]').element).toHaveProperty('value', 'Valor actual del servidor')
    expect(wrapper.get('[data-field="sku"]').attributes('readonly')).toBeDefined()
  })
  it('distinguishes omitted nullable fields from an explicit null clear and preserves zero logistics', async () => {
    const { wrapper } = await renderVariants()
    await wrapper.get('[data-field="mpn"]').setValue('')
    await wrapper.get('[data-field="variantReason"]').setValue('Retirada de referencia obsoleta')
    await invoke(wrapper, 'saveVariant')
    expect(lastCall()[1].body).toEqual({ mpn: null, expectedVersion: 1, reason: 'Retirada de referencia obsoleta' })
    expect(lastCall()[1].body).not.toHaveProperty('leadTimeDays')
    expect(lastCall()[1].body).not.toHaveProperty('weightGrams')
  })
  it('assigns a brand separately without any metadata or variant fields', async () => {
    requestMock.mockResolvedValue(receipt('assign_brand'))
    const { wrapper } = await renderVariants()
    await wrapper.get('[data-field="brandId"]').setValue(OTHER_BRAND)
    await wrapper.get('[data-field="brandReason"]').setValue('Cambio de marca motivado')
    await invoke(wrapper, 'saveBrand')
    expect(lastCall()[0]).toBe('/api/admin/products/1/brand')
    expect(lastCall()[1]).toMatchObject({
      method: 'PUT',
      body: { expectedVersion: 1, brandId: OTHER_BRAND, reason: 'Cambio de marca motivado' }
    })
  })
  it('creates a variant with explicit nullables, exact references, zero logistics and no price/stock defaults in the payload', async () => {
    requestMock.mockResolvedValue(receipt('create_variant'))
    const { wrapper } = await renderVariants()
    await invoke(wrapper, 'startCreate')
    Object.assign(state(wrapper).variantForm as object, fields(), { sku: 'DRAFT-NEW' })
    await wrapper.get('[data-field="variantReason"]').setValue('Alta de variante motivada')
    await invoke(wrapper, 'saveVariant')
    expect(lastCall()[0]).toBe('/api/admin/products/1/variants')
    expect(lastCall()[1]).toMatchObject({
      method: 'POST',
      body: { ...fields(), sku: 'DRAFT-NEW', expectedVersion: 1, reason: 'Alta de variante motivada' }
    })
    expect(lastCall()[1].body).not.toHaveProperty('price')
    expect(lastCall()[1].body).not.toHaveProperty('stock')
  })
  it('requires a reason and explicit impact confirmation before discontinuing an owned variant', async () => {
    requestMock.mockResolvedValue(receipt('discontinue_variant'))
    const { wrapper } = await renderVariants()
    await wrapper.get('[data-field="discontinueReason"]').setValue('Retirada editorial motivada')
    await invoke(wrapper, 'discontinue')
    expect(requestMock).not.toHaveBeenCalled()
    await wrapper.get('[data-field="removalConfirmed"]').setValue(true)
    await invoke(wrapper, 'discontinue')
    expect(lastCall()[0]).toBe('/api/admin/products/1/variants/11/discontinue')
    expect(lastCall()[1]).toMatchObject({
      method: 'POST',
      body: { expectedVersion: 1, reason: 'Retirada editorial motivada' }
    })
  })
  it('never retires the last non-discontinued variant', async () => {
    const value = product()
    value.authoring.variants[1]!.status = 'discontinued'
    const { wrapper } = await renderVariants({ product: value })
    await wrapper.get('[data-field="discontinueReason"]').setValue('Retirada editorial motivada')
    await wrapper.get('[data-field="removalConfirmed"]').setValue(true)
    await invoke(wrapper, 'discontinue')
    expect(requestMock).not.toHaveBeenCalled()
  })
  it('allows editing an owned non-retired variant whose own status is not draft while its product is draft', async () => {
    const { wrapper } = await renderVariants()
    await wrapper.get('[data-field="selectedVariant"]').setValue('12')
    await prepareUpdate(wrapper)
    requestMock.mockResolvedValue(receipt('update_variant', { variantId: 12, variantUuid: SECOND }))
    await invoke(wrapper, 'saveVariant')
    expect(lastCall()[0]).toBe('/api/admin/products/1/variants/12')
  })
})

describe('confirmed reads and hostile own-data boundaries', () => {
  it.each(['pending', 'error', 'idle'])(
    'hides cached creation forms for options status %s and refreshes only explicitly',
    async (optionsStatus) => {
      const { wrapper, reload } = await renderCreate({ optionsStatus })
      expect(wrapper.find('form').exists()).toBe(false)
      await prepareCreate(wrapper)
      await invoke(wrapper, 'submit')
      expect(requestMock).not.toHaveBeenCalled()
      expect(reload).not.toHaveBeenCalled()
      await invoke(wrapper, 'reloadOptions')
      expect(reload).toHaveBeenCalledOnce()
      expect(requestMock).not.toHaveBeenCalled()
    }
  )
  it.each(['pending', 'error', 'idle'])(
    'does not offer cached product actions for read status %s',
    async (readStatus) => {
      const { wrapper } = await renderVariants({ readStatus })
      expect(wrapper.find('[data-field="sku"]').exists()).toBe(false)
      await invoke(wrapper, 'saveVariant')
      await invoke(wrapper, 'saveBrand')
      await invoke(wrapper, 'discontinue')
      expect(requestMock).not.toHaveBeenCalled()
    }
  )
  it.each(['node', 'unknown', null])(
    'fails closed for runtime %s, even with forged legacy capabilities',
    async (runtime) => {
      const value = product()
      Object.assign(value.capabilities, { canWrite: true, productCreate: true })
      const { wrapper } = await renderVariants({ runtime, product: value })
      expect(wrapper.find('form').exists()).toBe(false)
      await invoke(wrapper, 'saveVariant')
      expect(requestMock).not.toHaveBeenCalled()
      const created = await renderCreate({ runtime })
      await prepareCreate(created.wrapper)
      await invoke(created.wrapper, 'submit')
      expect(requestMock).not.toHaveBeenCalled()
    }
  )
  it.each([
    ['wrong source', (value: ReturnType<typeof options>) => Object.assign(value, { source: 'node' })],
    ['duplicate references', (value: ReturnType<typeof options>) => value.taxClasses.push({ ...value.taxClasses[0]! })],
    [
      'unsafe category',
      (value: ReturnType<typeof options>) => {
        value.categories[0]!.id = Number.MAX_SAFE_INTEGER + 1
      }
    ],
    ['unknown field', (value: ReturnType<typeof options>) => Object.assign(value, { privateKey: 'never-render' })],
    [
      'invalid tree',
      (value: ReturnType<typeof options>) => {
        value.categories[0]!.parentId = 7
      }
    ]
  ])('rejects malformed options: %s', async (_label, corrupt) => {
    const value = options()
    corrupt(value)
    const { wrapper } = await renderCreate({ options: value })
    await prepareCreate(wrapper)
    await invoke(wrapper, 'submit')
    expect(wrapper.find('form').exists()).toBe(false)
    expect(requestMock).not.toHaveBeenCalled()
  })
  it('rejects options getters and custom prototypes without executing accessors', async () => {
    const getter = vi.fn(() => {
        throw new Error('options accessor executed')
      }),
      value = options()
    Object.defineProperty(value, 'brands', { get: getter, enumerable: true })
    // Vue Test Utils eagerly traverses initial props in deeplyCheckForRef.
    // Inject hostile DTOs after mount to exercise the component, not that helper.
    const { wrapper } = await renderCreate()
    await wrapper.setProps({ options: value })
    expect(wrapper.find('form').exists()).toBe(false)
    expect(getter).not.toHaveBeenCalled()
    const inherited = Object.create(options())
    const second = await renderCreate({ options: inherited })
    expect(second.wrapper.find('form').exists()).toBe(false)
  })
  it.each([
    ['canonical id alias', '01', product()],
    ['wrong route id', '2', product()],
    ['different top uuid', '1', { ...product(), uuid: SECOND }],
    ['different version', '1', { ...product(), catalogVersion: 2 }],
    ['different status', '1', { ...product(), status: 'published' }],
    ['missing read capability', '1', { ...product(), capabilities: { ...CATALOG_DRAFT_AUTHORING_CAPABILITIES } }]
  ])('rejects unbound product identity: %s', async (_label, productId, value) => {
    const { wrapper } = await renderVariants({ productId, product: value })
    expect(wrapper.find('[data-field="sku"]').exists()).toBe(false)
    await invoke(wrapper, 'saveVariant')
    expect(requestMock).not.toHaveBeenCalled()
  })
  it('rejects getters and custom prototype products without calling their code', async () => {
    const getter = vi.fn(() => {
        throw new Error('product accessor executed')
      }),
      value = product()
    Object.defineProperty(value, 'authoring', { get: getter, enumerable: true })
    const { wrapper } = await renderVariants()
    await wrapper.setProps({ product: value })
    expect(wrapper.find('form').exists()).toBe(false)
    expect(getter).not.toHaveBeenCalled()
    const other = await renderVariants({ product: Object.create(product()) })
    expect(other.wrapper.find('form').exists()).toBe(false)
  })
  it.each(['review', 'published', 'hidden', 'discontinued'])(
    'never prepares a new command for a %s product',
    async (status) => {
      const value = product()
      value.status = status
      value.authoring.status = status
      const { wrapper } = await renderVariants({ product: value })
      expect(wrapper.find('form').exists()).toBe(false)
      await invoke(wrapper, 'startCreate')
      await invoke(wrapper, 'saveBrand')
      expect(requestMock).not.toHaveBeenCalled()
    }
  )
  it('checks narrow action capabilities in both current reads, not legacy write flags', async () => {
    const value = product(),
      refs = options()
    value.capabilities.variantDraftUpdate = false
    refs.capabilities.productDraftBrandUpdate = false
    Object.assign(value.capabilities, { canWrite: true, productUpdate: true })
    const { wrapper } = await renderVariants({ product: value, options: refs })
    expect(wrapper.find('[data-action="variant"]').exists()).toBe(false)
    expect(wrapper.find('[data-action="brand"]').exists()).toBe(false)
    await invoke(wrapper, 'saveVariant')
    await invoke(wrapper, 'saveBrand')
    expect(requestMock).not.toHaveBeenCalled()
  })
  it('validates references before new commands and never falls back to the first option', async () => {
    const { wrapper } = await renderCreate()
    await prepareCreate(wrapper)
    const form = state(wrapper).form as Record<string, unknown>
    form.categoryId = 99
    await invoke(wrapper, 'submit')
    expect(requestMock).not.toHaveBeenCalled()
    form.categoryId = 7
    ;(form.initialVariant as Record<string, unknown>).taxClassId = SECOND
    await invoke(wrapper, 'submit')
    expect(requestMock).not.toHaveBeenCalled()
  })
  it('rejects form accessors and own undefined without running getters or coercion hooks', async () => {
    const { wrapper } = await renderCreate()
    await prepareCreate(wrapper)
    const form = state(wrapper).form as Record<string, unknown>,
      getter = vi.fn(() => 'malicious')
    Object.defineProperty(form, 'name', { get: getter, configurable: true, enumerable: true })
    await invoke(wrapper, 'submit')
    expect(getter).not.toHaveBeenCalled()
    expect(requestMock).not.toHaveBeenCalled()
    Object.defineProperty(form, 'name', {
      value: 'Nombre válido',
      configurable: true,
      enumerable: true,
      writable: true
    })
    form.usage = undefined
    await invoke(wrapper, 'submit')
    expect(requestMock).not.toHaveBeenCalled()
  })
  it('rejects SKU changes, invalid merged quantity bounds and fractional logistics rather than coercing them', async () => {
    const { wrapper } = await renderVariants()
    await prepareUpdate(wrapper)
    const form = state(wrapper).variantForm as Record<string, unknown>
    form.sku = 'FORGED'
    await invoke(wrapper, 'saveVariant')
    expect(requestMock).not.toHaveBeenCalled()
    form.sku = 'DRAFT-001'
    form.minimumQuantity = 5
    form.maximumQuantity = 4
    await invoke(wrapper, 'saveVariant')
    expect(requestMock).not.toHaveBeenCalled()
    form.maximumQuantity = null
    form.weightGrams = 1.5
    await invoke(wrapper, 'saveVariant')
    expect(requestMock).not.toHaveBeenCalled()
  })
  it('revalidates deep option capability changes immediately before writing instead of trusting a previously enabled computed', async () => {
    const refs = options(),
      { wrapper } = await renderCreate({ options: refs })
    await prepareCreateDom(wrapper)
    expect(wrapper.get('[data-action="create"]').attributes('disabled')).toBeUndefined()
    refs.capabilities.productDraftCreate = false
    await invoke(wrapper, 'submit')
    expect(requestMock).not.toHaveBeenCalled()
  })
  it('revalidates cached product status and hostile form descriptors at execution without invoking new getters', async () => {
    const value = product(),
      { wrapper } = await renderVariants({ product: value })
    await prepareUpdate(wrapper)
    expect(wrapper.get('[data-action="variant"]').attributes('disabled')).toBeUndefined()
    value.status = 'published'
    value.authoring.status = 'published'
    await invoke(wrapper, 'saveVariant')
    expect(requestMock).not.toHaveBeenCalled()
    value.status = 'draft'
    value.authoring.status = 'draft'
    const getter = vi.fn(() => {
      throw new Error('form accessor executed')
    })
    Object.defineProperty(state(wrapper).variantForm as object, 'format', { get: getter, enumerable: true })
    await invoke(wrapper, 'saveVariant')
    expect(getter).not.toHaveBeenCalled()
    expect(requestMock).not.toHaveBeenCalled()
  })
})

describe('manual immutable retry, fresh authorization and stale responses', () => {
  it('freezes creation payload/key after an ambiguous response and never automatically retries', async () => {
    requestMock
      .mockRejectedValueOnce(new Error('SQL private provider details'))
      .mockResolvedValue(receipt('create_draft'))
    const { wrapper, created } = await renderCreate()
    await invoke(wrapper, 'retry')
    await prepareCreate(wrapper)
    await invoke(wrapper, 'submit')
    expect(requestMock).toHaveBeenCalledOnce()
    expect(wrapper.text()).not.toContain('SQL private')
    const original = structuredClone(lastCall()[1].body),
      key = lastCall()[1].headers['Idempotency-Key']
    Object.assign(state(wrapper).form as object, { name: 'New intent must not leak' })
    await invoke(wrapper, 'submit')
    expect(requestMock).toHaveBeenCalledOnce()
    await invoke(wrapper, 'reloadOptions')
    expect(requestMock).toHaveBeenCalledOnce()
    await invoke(wrapper, 'retry')
    expect(requestMock).toHaveBeenCalledTimes(2)
    expect(lastCall()[1].body).toEqual(original)
    expect(lastCall()[1].headers['Idempotency-Key']).toBe(key)
    expect(created).toHaveBeenCalledOnce()
  })
  it('preserves the creation intent when onCreated fails after a valid receipt', async () => {
    requestMock.mockResolvedValue(receipt('create_draft'))
    const created = vi
      .fn<({ id, uuid }: { id: number; uuid: string }) => Promise<unknown>>()
      .mockRejectedValueOnce(new Error('private callback'))
      .mockResolvedValue(undefined)
    const { wrapper } = await renderCreate({ onCreated: created })
    await prepareCreate(wrapper)
    await invoke(wrapper, 'submit')
    const key = lastCall()[1].headers['Idempotency-Key']
    expect(wrapper.text()).toContain('misma solicitud')
    await invoke(wrapper, 'retry')
    expect(lastCall()[1].headers['Idempotency-Key']).toBe(key)
    expect(created).toHaveBeenCalledTimes(2)
  })
  it('coalesces creation double clicks and ignores an unmounted response', async () => {
    const waiting = deferred()
    requestMock.mockReturnValue(waiting.promise)
    const { wrapper, created } = await renderCreate()
    await prepareCreate(wrapper)
    const first = invoke(wrapper, 'submit'),
      second = invoke(wrapper, 'submit')
    await flushPromises()
    expect(requestMock).toHaveBeenCalledOnce()
    wrapper.unmount()
    waiting.resolve(receipt('create_draft'))
    await Promise.all([first, second])
    expect(created).not.toHaveBeenCalled()
  })
  it('rechecks non-reactive authority at execution and after a creation response', async () => {
    let allowed = true
    const { wrapper, created } = await renderCreate({ authorize: () => allowed })
    await prepareCreate(wrapper)
    allowed = false
    await invoke(wrapper, 'submit')
    expect(requestMock).not.toHaveBeenCalled()
    allowed = true
    const waiting = deferred()
    requestMock.mockReturnValue(waiting.promise)
    const first = invoke(wrapper, 'submit')
    allowed = false
    waiting.resolve(receipt('create_draft'))
    await first
    expect(created).not.toHaveBeenCalled()
  })
  it.each([
    { action: 'create_variant' },
    { catalogVersion: 2 },
    { variantId: null, variantUuid: null },
    { source: 'node' },
    { productId: '1' },
    { updated: false },
    { extra: 'never-render' }
  ])('does not navigate on a malformed or wrong creation receipt %j', async (overrides) => {
    requestMock.mockResolvedValue(receipt('create_draft', overrides))
    const { wrapper, created } = await renderCreate()
    await prepareCreate(wrapper)
    await invoke(wrapper, 'submit')
    expect(created).not.toHaveBeenCalled()
    expect(wrapper.find('[data-action="retry"]').exists()).toBe(true)
  })
  it('rejects a receipt accessor without invoking it', async () => {
    const value = receipt('create_draft'),
      getter = vi.fn(() => PRODUCT)
    Object.defineProperty(value, 'productUuid', { get: getter, enumerable: true })
    requestMock.mockResolvedValue(value)
    const { wrapper, created } = await renderCreate()
    await prepareCreate(wrapper)
    await invoke(wrapper, 'submit')
    expect(getter).not.toHaveBeenCalled()
    expect(created).not.toHaveBeenCalled()
  })
  it('blocks a new variant intent after deterministic failure until explicit GET refresh', async () => {
    requestMock
      .mockRejectedValueOnce({ data: { error: { code: 'quantity_conflict', message: 'private SQL' } } })
      .mockResolvedValue(receipt())
    const { wrapper, reload, optionsReload } = await renderVariants()
    await prepareUpdate(wrapper)
    await invoke(wrapper, 'saveVariant')
    expect(wrapper.find('[data-action="retry"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('private SQL')
    await invoke(wrapper, 'saveVariant')
    expect(requestMock).toHaveBeenCalledOnce()
    expect(reload).not.toHaveBeenCalled()
    await invoke(wrapper, 'reload')
    expect(reload).toHaveBeenCalledOnce()
    expect(optionsReload).toHaveBeenCalledOnce()
    expect(requestMock).toHaveBeenCalledOnce()
    await prepareUpdate(wrapper)
    requestMock.mockResolvedValue(receipt('update_variant', { catalogVersion: 3 }))
    await invoke(wrapper, 'saveVariant')
    expect(requestMock).toHaveBeenCalledTimes(2)
    expect(lastCall()[1].body.expectedVersion).toBe(2)
  })
  it('classifies real ofetch response hooks without invoking an Error.data accessor', async () => {
    const getter = vi.fn(() => ({ error: { code: 'invalid_input' } })),
      cause = new Error('private failure')
    Object.defineProperty(cause, 'data', { get: getter })
    requestMock.mockImplementationOnce(async (_path, config) => {
      config.onResponseError({ response: { status: 422, _data: { error: { code: 'invalid_input' } } } })
      throw cause
    })
    const { wrapper } = await renderCreate()
    await prepareCreate(wrapper)
    await invoke(wrapper, 'submit')
    expect(getter).not.toHaveBeenCalled()
    expect(wrapper.find('[data-action="retry"]').exists()).toBe(false)
    await invoke(wrapper, 'submit')
    expect(requestMock).toHaveBeenCalledOnce()
  })
  it('replays the exact original variant command after later status/version and withdrawn references without applying the historical receipt', async () => {
    requestMock.mockRejectedValueOnce(new Error('network')).mockResolvedValue(receipt())
    const { wrapper, authorize } = await renderVariants()
    await prepareUpdate(wrapper)
    await invoke(wrapper, 'saveVariant')
    const original = structuredClone(lastCall()[1].body),
      key = lastCall()[1].headers['Idempotency-Key'],
      value = product()
    value.status = 'published'
    value.catalogVersion = 9
    value.authoring.status = 'published'
    value.authoring.catalogVersion = 9
    value.authoring.variants[0]!.status = 'discontinued'
    const refs = options()
    refs.taxClasses = []
    refs.shippingProfiles = []
    await wrapper.setProps({ product: value, options: refs, refreshProduct: async () => undefined })
    await invoke(wrapper, 'retry')
    expect(requestMock).toHaveBeenCalledTimes(2)
    expect(lastCall()[1].body).toEqual(original)
    expect(lastCall()[1].headers['Idempotency-Key']).toBe(key)
    expect(authorize).toHaveBeenCalledWith({ id: 1, uuid: PRODUCT, version: 9 })
    expect(state(wrapper).baseline).toMatchObject({ version: 9 })
    expect(wrapper.find('form').exists()).toBe(false)
  })
  it('retains the same intent after refresh failure or an unconfirmed refresh, with no automatic extra write', async () => {
    const refresh = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(new Error('SQL private'))
      .mockResolvedValue(undefined)
    const { wrapper } = await renderVariants({ refreshProduct: refresh })
    await prepareUpdate(wrapper)
    await invoke(wrapper, 'saveVariant')
    const key = lastCall()[1].headers['Idempotency-Key']
    expect(requestMock).toHaveBeenCalledOnce()
    expect(wrapper.text()).not.toContain('SQL private')
    await invoke(wrapper, 'retry')
    expect(requestMock).toHaveBeenCalledTimes(2)
    expect(lastCall()[1].headers['Idempotency-Key']).toBe(key)
    expect(state(wrapper).baseline).toMatchObject({ version: 1 })
    expect(wrapper.find('[data-action="retry"]').exists()).toBe(true)
  })
  it('blocks manual retries while authorization is revoked and rechecks the current identity version when restored', async () => {
    requestMock.mockRejectedValueOnce(new Error('network')).mockResolvedValue(receipt())
    const { wrapper, authority, authorize } = await renderVariants()
    await prepareUpdate(wrapper)
    await invoke(wrapper, 'saveVariant')
    authority.value = false
    await flushPromises()
    await invoke(wrapper, 'retry')
    expect(requestMock).toHaveBeenCalledOnce()
    authority.value = true
    await flushPromises()
    await invoke(wrapper, 'retry')
    expect(requestMock).toHaveBeenCalledTimes(2)
    expect(authorize).toHaveBeenCalledWith({ id: 1, uuid: PRODUCT, version: 1 })
  })
  it('ignores a response bound to a replaced product identity and never refetches or replays against the new product', async () => {
    const waiting = deferred()
    requestMock.mockReturnValue(waiting.promise)
    const { wrapper, reload } = await renderVariants()
    await prepareUpdate(wrapper)
    const first = invoke(wrapper, 'saveVariant')
    const value = product()
    value.id = 2
    value.uuid = SECOND
    value.authoring.productId = 2
    value.authoring.productUuid = SECOND
    await wrapper.setProps({ product: value, productId: '2' })
    waiting.resolve(receipt())
    await first
    expect(reload).not.toHaveBeenCalled()
    await invoke(wrapper, 'retry')
    expect(requestMock).toHaveBeenCalledOnce()
  })
  it('does not process late receipts while the current read is pending or after unmount', async () => {
    const waiting = deferred()
    requestMock.mockReturnValue(waiting.promise)
    const { wrapper, reload } = await renderVariants()
    await prepareUpdate(wrapper)
    const first = invoke(wrapper, 'saveVariant')
    await wrapper.setProps({ readStatus: 'pending' })
    waiting.resolve(receipt())
    await first
    expect(reload).not.toHaveBeenCalled()
    const other = await renderVariants()
    await prepareUpdate(other.wrapper)
    const secondWait = deferred()
    requestMock.mockReturnValue(secondWait.promise)
    const second = invoke(other.wrapper, 'saveVariant')
    other.wrapper.unmount()
    secondWait.resolve(receipt())
    await second
    expect(other.reload).not.toHaveBeenCalled()
  })
  it('coalesces double variant submission and explicit GET refresh, never retrying a mutation from reload', async () => {
    const waiting = deferred()
    requestMock.mockReturnValue(waiting.promise)
    const { wrapper, reload } = await renderVariants()
    await prepareUpdate(wrapper)
    const first = invoke(wrapper, 'saveVariant'),
      second = invoke(wrapper, 'saveVariant')
    await invoke(wrapper, 'reload')
    expect(requestMock).toHaveBeenCalledOnce()
    expect(reload).not.toHaveBeenCalled()
    waiting.resolve(receipt())
    await Promise.all([first, second])
    const reading = deferred()
    await wrapper.setProps({ refreshProduct: () => reading.promise })
    const third = invoke(wrapper, 'reload'),
      fourth = invoke(wrapper, 'reload')
    reading.resolve(undefined)
    await Promise.all([third, fourth])
    expect(requestMock).toHaveBeenCalledOnce()
  })
  it.each([
    { action: 'assign_brand', variantId: null, variantUuid: null },
    { variantId: 12, variantUuid: SECOND },
    { productUuid: SECOND },
    { catalogVersion: 3 },
    { catalogVersion: '2' },
    { source: 'node' }
  ])('never accepts a wrong original target/version receipt %j', async (overrides) => {
    requestMock.mockResolvedValue(receipt('update_variant', overrides))
    const { wrapper, reload } = await renderVariants()
    await prepareUpdate(wrapper)
    await invoke(wrapper, 'saveVariant')
    expect(reload).not.toHaveBeenCalled()
    expect(wrapper.find('[data-action="retry"]').exists()).toBe(true)
  })
})
