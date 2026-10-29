import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h, nextTick, proxyRefs, reactive, ref, toValue } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import PolicyEditor from '../../app/components/ProductPublicationPolicyEditor.vue'
import ProductPage from '../../app/pages/admin/productos/[id].vue'
import '#app/nuxt-vitest-app-entry'

const { fetchMock, requestMock, runtimeMock, routeMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  requestMock: vi.fn(),
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
mockNuxtImport('useFetch', () => fetchMock)
mockNuxtImport('$fetch', () => requestMock)
mockNuxtImport('useRuntimeConfig', () => runtimeMock)
mockNuxtImport('useRoute', () => routeMock)
mockNuxtImport('useToast', () => () => ({ add: () => undefined }))
mockNuxtImport('navigateTo', () => async () => undefined)
mockNuxtImport('refreshNuxtData', () => async () => undefined)
mockNuxtImport('useUserSession', () => () => ({
  ready: ref(true),
  loggedIn: ref(true),
  user: ref({ id: 'synthetic-admin', role: 'admin', mfaVerified: true }),
  session: ref(null),
  clear: async () => undefined,
  fetch: async () => undefined,
  openInPopup: () => undefined
}))
const PRODUCT = 'a1000000-0000-4000-8000-000000000001'
const POLICY = 'a1000000-0000-4000-8000-000000000002'
const VARIANT = 'a1000000-0000-4000-8000-000000000003'
const EXCEPTION = 'a1000000-0000-4000-8000-000000000004'
const ENTITY = 'a1000000-0000-4000-8000-000000000005'
const policy = () => ({
  id: POLICY,
  code: 'equipment',
  version: 3,
  name: 'Política sintética',
  requiredFields: ['usage'],
  requiredMediaRoles: ['datasheet'],
  identifierExceptionsAllowed: true,
  validFrom: '2026-09-30T10:00:00Z',
  validUntil: null,
  current: true,
  withdrawn: false,
  assignedProductCount: 1,
  publishedProductCount: 0
})
const product = () => ({
  id: 1,
  uuid: PRODUCT,
  catalogVersion: 1,
  status: 'draft',
  source: 'cloudflare',
  capabilities: { productDetailRead: true, productPublicationPolicyRead: true },
  name: 'Producto sintético',
  brand: 'NETECO',
  slug: 'producto-sintetico',
  categoryId: 7,
  shortDesc: 'Descripción sintética',
  description: 'Descripción sintética completa',
  usage: null,
  series: null,
  badges: [],
  visual: { type: 'caja', color: '#123456' },
  attrs: [],
  variants: [],
  featured: false,
  active: false
})
const dto = () => ({
  source: 'cloudflare',
  capabilities: {
    productPublicationPolicyRead: true,
    productPublicationPolicyWrite: true,
    productIdentifierExceptionsWrite: true
  },
  productId: 1,
  productUuid: PRODUCT,
  catalogVersion: 1,
  status: 'draft',
  regulatory: {
    productType: null,
    requiresSds: null,
    safetyInstructions: null,
    hazardStatements: null,
    precautionaryStatements: null,
    manufacturer: null
  },
  policy: policy(),
  variants: [
    { id: VARIANT, legacyId: 10, status: 'draft', ean: null, gtin: null, mpn: null, identifierException: null }
  ],
  evaluatedAt: '2026-09-30T12:00:00Z'
})
const options = () => ({
  source: 'cloudflare',
  capabilities: { publicationPoliciesRead: true, publicationPoliciesWrite: true },
  items: [policy()],
  pagination: { page: 1, perPage: 20, total: 1, pages: 1 },
  evaluatedAt: '2026-09-30T12:00:00Z'
})
const receipt = (action = 'policy_assign', resourceId = POLICY, policyVersion: number | null = 3) => ({
  source: 'cloudflare',
  action,
  entityId: ENTITY,
  resourceId,
  policyVersion,
  productId: 1,
  productUuid: PRODUCT,
  catalogVersion: 2,
  updated: true
})
const exception = () => ({
  id: EXCEPTION,
  reason: 'Excepción documentada',
  evidenceReference: 'Expediente sintético',
  validFrom: '2026-09-30T10:00:00Z',
  validUntil: null
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
  UBadge: Slot,
  UFormField: Slot,
  UIcon: true,
  UInput: true,
  USelect: true,
  UTextarea: true,
  ProductVisual: true,
  DraftProductMetadataEditor: true,
  ProductStatusEditor: true,
  CatalogPublicationReadiness: true
}
type Wrapper = Awaited<ReturnType<typeof mountSuspended>>
type Props = InstanceType<typeof PolicyEditor>['$props']
let wrapper: Wrapper | undefined
let data: ReturnType<typeof ref<unknown>>
let status: ReturnType<typeof ref<string>>
let policies: ReturnType<typeof ref<unknown>>
let policiesStatus: ReturnType<typeof ref<string>>
let detail: ReturnType<typeof ref<Record<string, unknown>>>
let detailStatus: ReturnType<typeof ref<string>>
let runtime: { app: { baseURL: string; buildAssetsDir: string; cdnURL: string }; public: { serverRuntime: string } }
const refresh = vi.fn<() => Promise<unknown>>()
const refreshPolicies = vi.fn<() => Promise<unknown>>()
const refreshDetail = vi.fn<() => Promise<unknown>>()
function setupFetch() {
  fetchMock.mockImplementation((url: string | (() => string)) => {
    const path = String(toValue(url))
    if (path.endsWith('/publication-policy')) return { data, status, refresh }
    if (path.startsWith('/api/admin/catalog/policies'))
      return { data: policies, status: policiesStatus, refresh: refreshPolicies }
    if (path.endsWith('categories'))
      return {
        data: ref({
          roots: [],
          flat: [],
          source: runtime.public.serverRuntime === 'node' ? undefined : 'cloudflare',
          capabilities: { categoriesRead: true }
        }),
        status: ref('success'),
        error: ref(null),
        refresh: vi.fn()
      }
    return { data: detail, status: detailStatus, error: ref(null), refresh: refreshDetail }
  })
}
async function render(overrides: Partial<Props> = {}, read?: unknown) {
  if (read !== undefined) data.value = read
  wrapper = await mountSuspended(PolicyEditor, {
    props: {
      product: product(),
      productId: '1',
      runtime: 'cloudflare',
      readStatus: 'success',
      authorize: () => true,
      refreshProduct: refreshDetail,
      ...overrides
    },
    global: { stubs }
  })
  return wrapper
}
async function renderParent(
  value: Record<string, unknown> = product(),
  serverRuntime = 'cloudflare',
  readStatus = 'success'
) {
  detail.value = value
  detailStatus.value = readStatus
  runtime.public.serverRuntime = serverRuntime
  wrapper = await mountSuspended(ProductPage, { global: { stubs } })
  await flushPromises()
  return wrapper
}
const state = (page: Wrapper) => proxyRefs(page.vm.$.setupState) as Record<string, unknown>
const form = (page: Wrapper, key = 'form') => state(page)[key] as Record<string, unknown>
async function invoke(page: Wrapper, name: string) {
  await (state(page)[name] as () => Promise<void>)()
  await flushPromises()
}
async function prepare(page: Wrapper) {
  await page.get('#product-policy-choice').setValue(POLICY)
  await page.get('#product-policy-sds').setValue('false')
  Object.assign(form(page), { reason: '  Asignación revisada documentada  ', confirmed: true })
  await nextTick()
}
const calls = () => requestMock.mock.calls.map((call) => call.slice(0, 2))
beforeEach(() => {
  requestMock.mockReset().mockResolvedValue(receipt())
  fetchMock.mockReset()
  refresh.mockReset().mockResolvedValue(undefined)
  refreshPolicies.mockReset().mockResolvedValue(undefined)
  refreshDetail.mockReset().mockResolvedValue(undefined)
  runtime = reactive({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'cloudflare' }
  })
  runtimeMock.mockReturnValue(runtime)
  routeMock.mockReturnValue({
    params: { id: '1' },
    query: {},
    path: '/admin/productos/1',
    fullPath: '/admin/productos/1'
  })
  data = ref(dto())
  status = ref('success')
  policies = ref(options())
  policiesStatus = ref('success')
  detail = ref(product())
  detailStatus = ref('success')
  setupFetch()
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
})

describe('separate privileged product publication policy editor', () => {
  it('reads only private keyed GETs and defaults to no legal classification or implicit SDS false', async () => {
    const page = await render()
    expect(page.text()).toContain('Política de publicación y revisión regulatoria')
    expect(page.text()).toContain('no publica productos ni acredita aprobación legal')
    expect(page.get('#product-policy-choice').element).toHaveProperty('value', '')
    expect(page.get('#product-policy-sds').element).toHaveProperty('value', '')
    expect(requestMock).not.toHaveBeenCalled()
    expect(fetchMock.mock.calls[0]?.slice(0, 2)).toEqual([
      '/api/admin/products/1/publication-policy',
      expect.objectContaining({
        method: 'GET',
        key: `admin-product-publication-policy-1-${PRODUCT}`,
        immediate: true,
        server: true,
        watch: false
      })
    ])
  })
  it.each(['idle', 'pending', 'error'])('hides cached product controls during %s read', async (value) => {
    status.value = value
    const page = await render()
    expect(page.find('#product-policy-choice').exists()).toBe(false)
    expect(page.text()).not.toContain('Política sintética')
    expect(page.find(value === 'error' ? '[role="alert"]' : '[role="status"]').exists()).toBe(true)
    await invoke(page, 'assignPolicy')
    await invoke(page, 'createException')
    expect(requestMock).not.toHaveBeenCalled()
  })
  it.each([
    {},
    { ...dto(), source: 'node' },
    { ...dto(), productId: 2 },
    { ...dto(), productUuid: ENTITY },
    { ...dto(), catalogVersion: 2 },
    { ...dto(), status: 'hidden' },
    { ...dto(), capabilities: { productPublicationPolicyRead: 1, productPublicationPolicyWrite: true } },
    { ...dto(), capabilities: Object.create({ productPublicationPolicyRead: true }) },
    { ...dto(), evaluatedAt: '2026-02-30T10:00:00Z' },
    { ...dto(), evaluatedAt: '2026-09-30T12:00:00.000Z' },
    { ...dto(), policy: { ...policy(), requiredMediaRoles: ['bad'] } },
    { ...dto(), variants: [{ ...dto().variants[0], id: '10' }] },
    { ...dto(), regulatory: { ...dto().regulatory, requiresSds: 'false' } },
    { ...dto(), policy: { ...policy(), validFrom: '2027-09-30T10:00:00Z' } }
  ])('rejects poisoned/stale DTO %# without forms or requests', async (value) => {
    const page = await render({}, value)
    expect(page.find('form').exists()).toBe(false)
    expect(page.get('[role="alert"]').text()).toContain('consulta privada vigente')
    await invoke(page, 'assignPolicy')
    expect(requestMock).not.toHaveBeenCalled()
  })
  it('does not execute DTO getters or accept inherited values', async () => {
    const getter = vi.fn(() => PRODUCT)
    data.value = Object.defineProperty(dto(), 'productUuid', { get: getter, enumerable: true })
    const page = await render()
    expect(page.find('form').exists()).toBe(false)
    expect(getter).not.toHaveBeenCalled()
  })
  it.each([
    { runtime: 'node' },
    { runtime: 'unknown' },
    { productId: '01' },
    { productId: '9007199254740992' },
    { readStatus: 'error' },
    { product: { ...product(), uuid: 'bad' } },
    { product: { ...product(), catalogVersion: 0 } },
    { product: { ...product(), capabilities: { productDetailRead: true, productPublicationPolicyRead: 1 } } },
    { authorize: () => false }
  ])('denies invalid parent authority %# before fetch or programmatic mutations', async (bad) => {
    const page = await render(bad)
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ immediate: false, server: false })
    expect(page.find('form').exists()).toBe(false)
    await invoke(page, 'assignPolicy')
    await invoke(page, 'refreshAll')
    expect(refreshDetail).not.toHaveBeenCalled()
    expect(requestMock).not.toHaveBeenCalled()
  })
  it.each(['published', 'discontinued'])('keeps %s products read-only without hiding automatically', async (value) => {
    data.value = { ...dto(), status: value }
    const page = await render({ product: { ...product(), status: value } })
    expect(page.text()).toContain('Sólo lectura en productos publicados o descatalogados')
    expect(page.find('form').exists()).toBe(false)
    await invoke(page, 'assignPolicy')
    await invoke(page, 'createException')
    await invoke(page, 'withdrawException')
    expect(requestMock).not.toHaveBeenCalled()
  })
  it('sends explicit strict assignment and refreshes authoritative GET without mutating DTO', async () => {
    const page = await render()
    const original = data.value
    await prepare(page)
    await invoke(page, 'assignPolicy')
    expect(calls()).toEqual([
      [
        '/api/admin/products/1/publication-policy',
        {
          method: 'PUT',
          body: {
            expectedVersion: 1,
            policyId: POLICY,
            regulatory: { productType: 'equipment', requiresSds: false },
            reason: 'Asignación revisada documentada'
          },
          headers: { Origin: window.location.origin, 'Idempotency-Key': expect.stringMatching(/^[0-9a-f-]{36}$/) }
        }
      ]
    ])
    expect(refreshDetail).toHaveBeenCalledOnce()
    expect(refresh).toHaveBeenCalledOnce()
    expect(refreshPolicies).toHaveBeenCalledOnce()
    expect(data.value).toBe(original)
    expect(page.text()).toContain('Cambio registrado')
  })
  it.each([
    { requiresSds: '' },
    { confirmed: false },
    { reason: 'corto' },
    { reason: 'Motivo inválido\ncon control' },
    { policyId: ENTITY },
    { manufacturer: 'x'.repeat(161) },
    { safetyInstructions: 'x'.repeat(2001) }
  ])('blocks incomplete or unreviewed assignments %#', async (bad) => {
    const page = await render()
    await prepare(page)
    Object.assign(form(page), bad)
    await invoke(page, 'assignPolicy')
    expect(requestMock).not.toHaveBeenCalled()
  })
  it('never offers unavailable policy options or mistakes a failed options read for empty', async () => {
    policies.value = { ...options(), items: [{ ...policy(), current: false }] }
    const page = await render()
    expect(page.find(`option[value="${POLICY}"]`).exists()).toBe(false)
    policiesStatus.value = 'error'
    await nextTick()
    expect(page.text()).toContain('No hay una consulta válida de políticas disponibles')
    await invoke(page, 'assignPolicy')
    expect(requestMock).not.toHaveBeenCalled()
  })
  it('registers scoped missing-identifier exception only using private variant UUID and exact evidence/window', async () => {
    const page = await render()
    Object.assign(form(page, 'exceptionForm'), {
      variantId: VARIANT,
      reason: 'Excepción revisada documentada',
      evidenceReference: 'EXP-SINTETICO',
      validFrom: '2026-09-30T10:00:00Z',
      validUntil: '2027-09-30T10:00:00Z',
      confirmed: true
    })
    requestMock.mockResolvedValueOnce(receipt('exception_create', VARIANT, 3))
    await invoke(page, 'createException')
    expect(calls()[0]).toEqual([
      '/api/admin/products/1/identifier-exceptions',
      expect.objectContaining({
        method: 'POST',
        body: {
          expectedVersion: 1,
          variantId: VARIANT,
          reason: 'Excepción revisada documentada',
          evidenceReference: 'EXP-SINTETICO',
          validFrom: '2026-09-30T10:00:00Z',
          validUntil: '2027-09-30T10:00:00Z'
        }
      })
    ])
    expect(refresh).toHaveBeenCalledOnce()
  })
  it.each([
    'identifier',
    'discontinued',
    'policy_disallows',
    'policy_not_current',
    'foreign_uuid',
    'invalid_date',
    'no_confirmation'
  ])('blocks invalid exception: %s', async (bad) => {
    if (bad === 'identifier') data.value = { ...dto(), variants: [{ ...dto().variants[0], ean: '123' }] }
    if (bad === 'discontinued') data.value = { ...dto(), variants: [{ ...dto().variants[0], status: 'discontinued' }] }
    if (bad === 'policy_disallows')
      data.value = { ...dto(), policy: { ...policy(), identifierExceptionsAllowed: false } }
    if (bad === 'policy_not_current') data.value = { ...dto(), policy: { ...policy(), current: false } }
    const page = await render()
    Object.assign(form(page, 'exceptionForm'), {
      variantId: bad === 'foreign_uuid' ? ENTITY : VARIANT,
      reason: 'Excepción revisada documentada',
      evidenceReference: 'EXP-SINTETICO',
      validFrom: bad === 'invalid_date' ? '2026-02-30T10:00:00Z' : '2026-09-30T10:00:00Z',
      validUntil: '',
      confirmed: bad !== 'no_confirmation'
    })
    await invoke(page, 'createException')
    expect(requestMock).not.toHaveBeenCalled()
  })
  it('withdraws only the selected current exception with expected version/reason and no audit deletion', async () => {
    data.value = { ...dto(), variants: [{ ...dto().variants[0], identifierException: exception() }] }
    const page = await render()
    expect(page.text()).toContain('historial auditado se conserva')
    Object.assign(form(page, 'withdrawal'), {
      variantId: VARIANT,
      reason: 'Retirada revisada documentada',
      confirmed: true
    })
    requestMock.mockResolvedValueOnce(receipt('exception_withdraw', EXCEPTION, null))
    await invoke(page, 'withdrawException')
    expect(calls()[0]).toEqual([
      `/api/admin/products/1/identifier-exceptions/${EXCEPTION}/withdraw`,
      expect.objectContaining({ method: 'POST', body: { expectedVersion: 1, reason: 'Retirada revisada documentada' } })
    ])
  })
  it('does not accept an older GET after a committed receipt or enable another command until the current version is read', async () => {
    const page = await render()
    await prepare(page)
    await invoke(page, 'assignPolicy')
    expect(page.find('form').exists()).toBe(false)
    await invoke(page, 'refreshAll')
    expect(page.find('form').exists()).toBe(false)
    await invoke(page, 'assignPolicy')
    expect(requestMock).toHaveBeenCalledOnce()
    expect(data.value).toMatchObject({ catalogVersion: 1 })
  })
  it('permits a published variant of a hidden product and never treats its variant status as public product authority', async () => {
    data.value = { ...dto(), status: 'hidden', variants: [{ ...dto().variants[0], status: 'published' }] }
    const page = await render({ product: { ...product(), status: 'hidden' } })
    Object.assign(form(page, 'exceptionForm'), {
      variantId: VARIANT,
      reason: 'Excepción revisada documentada',
      evidenceReference: 'EXP-SINTETICO',
      validFrom: '2026-09-30T10:00:00Z',
      validUntil: '',
      confirmed: true
    })
    requestMock.mockResolvedValueOnce(receipt('exception_create', VARIANT, 3))
    await invoke(page, 'createException')
    expect(requestMock).toHaveBeenCalledOnce()
  })
  it('allows withdrawing current exception from a discontinued variant after policy withdrawal', async () => {
    data.value = {
      ...dto(),
      policy: { ...policy(), withdrawn: true, current: false },
      variants: [{ ...dto().variants[0], status: 'discontinued', identifierException: exception() }]
    }
    const page = await render()
    Object.assign(form(page, 'withdrawal'), {
      variantId: VARIANT,
      reason: 'Retirada revisada documentada',
      confirmed: true
    })
    requestMock.mockResolvedValueOnce(receipt('exception_withdraw', EXCEPTION, null))
    await invoke(page, 'withdrawException')
    expect(requestMock).toHaveBeenCalledOnce()
  })
  it.each(['variant_count', 'duplicate_exception'])(
    'rejects impossible private variant projection: %s',
    async (bad) => {
      data.value =
        bad === 'variant_count'
          ? {
              ...dto(),
              variants: Array.from({ length: 501 }, (_, index) => ({
                ...dto().variants[0],
                id: `a1000000-0000-4000-8000-${String(index).padStart(12, '0')}`
              }))
            }
          : {
              ...dto(),
              variants: [
                { ...dto().variants[0], identifierException: exception() },
                { ...dto().variants[0], id: ENTITY, identifierException: exception() }
              ]
            }
      const page = await render()
      expect(page.find('form').exists()).toBe(false)
      await invoke(page, 'createException')
      expect(requestMock).not.toHaveBeenCalled()
    }
  )
  it('retains exactly the original intent across pending GET and advanced catalog version, with no auto retry', async () => {
    const page = await render()
    await prepare(page)
    requestMock.mockRejectedValueOnce(new Error('lost response'))
    await invoke(page, 'assignPolicy')
    const original = calls()[0]
    refreshDetail.mockImplementationOnce(async () => {
      await page.setProps({ readStatus: 'pending' })
      await nextTick()
      expect(page.find('form').exists()).toBe(false)
      await page.setProps({ product: { ...product(), catalogVersion: 3 }, readStatus: 'success' })
    })
    refresh.mockImplementationOnce(async () => {
      data.value = { ...dto(), catalogVersion: 3 }
      status.value = 'success'
    })
    await invoke(page, 'refreshAll')
    expect(requestMock).toHaveBeenCalledOnce()
    Object.assign(form(page), { reason: 'Otro motivo', requiresSds: 'true' })
    await invoke(page, 'assignPolicy')
    expect(requestMock).toHaveBeenCalledOnce()
    await invoke(page, 'retry')
    expect(calls()[1]).toEqual(original)
    expect(data.value).toMatchObject({ catalogVersion: 3 })
    expect(page.text()).toContain('Cambio registrado')
  })
  it.each([
    'version_conflict',
    'idempotency_conflict',
    'invalid_state',
    'policy_unavailable',
    'forbidden',
    'mfa_required'
  ])('invalidates %s intent and requires explicit refetch', async (code) => {
    const page = await render()
    await prepare(page)
    requestMock.mockRejectedValueOnce({ data: { error: { code } } })
    await invoke(page, 'assignPolicy')
    await invoke(page, 'retry')
    await invoke(page, 'assignPolicy')
    expect(requestMock).toHaveBeenCalledOnce()
    expect(refresh).not.toHaveBeenCalled()
    await invoke(page, 'refreshAll')
    expect(refresh).toHaveBeenCalledOnce()
    expect(page.get('#product-policy-choice').element).toHaveProperty('value', '')
  })
  it.each([
    { catalogVersion: 3 },
    { productUuid: ENTITY },
    { action: 'exception_create' },
    { resourceId: ENTITY },
    { policyVersion: 4 },
    { updated: false },
    { entityId: 'not-uuid' },
    { unexpected: true }
  ])('treats malformed/foreign receipt %# as ambiguous, never state', async (bad) => {
    const page = await render()
    await prepare(page)
    requestMock.mockResolvedValueOnce({ ...receipt(), ...bad })
    await invoke(page, 'assignPolicy')
    expect(page.text()).not.toContain('Cambio registrado')
    expect(refresh).not.toHaveBeenCalled()
    expect(page.text()).toContain('Reintentar exactamente')
  })
  it('guards duplicate concurrent writes/GET and late unmounted responses', async () => {
    const page = await render()
    await prepare(page)
    let resolve: (value: unknown) => void = () => undefined
    requestMock.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    const run = (state(page).assignPolicy as () => Promise<void>)()
    await nextTick()
    await invoke(page, 'assignPolicy')
    await invoke(page, 'refreshAll')
    expect(requestMock).toHaveBeenCalledOnce()
    expect(refreshDetail).not.toHaveBeenCalled()
    page.unmount()
    resolve(receipt())
    await run
    expect(refreshDetail).not.toHaveBeenCalled()
    wrapper = undefined
  })
  it('invalidates pending command and ignores foreign callbacks on UUID change', async () => {
    const page = await render()
    await prepare(page)
    let resolve: (value: unknown) => void = () => undefined
    requestMock.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    const run = (state(page).assignPolicy as () => Promise<void>)()
    await nextTick()
    await page.setProps({ product: { ...product(), uuid: ENTITY } })
    resolve(receipt())
    await run
    await invoke(page, 'retry')
    expect(requestMock).toHaveBeenCalledOnce()
    expect(refreshDetail).not.toHaveBeenCalled()
    expect(page.find('form').exists()).toBe(false)
  })
  it('rechecks own capabilities and parent authority before cached callbacks/replay', async () => {
    let allowed = true
    const page = await render({ authorize: () => allowed })
    await prepare(page)
    const cached = state(page).assignPolicy as () => Promise<void>
    allowed = false
    await cached()
    allowed = true
    data.value = {
      ...dto(),
      capabilities: {
        productPublicationPolicyRead: true,
        productPublicationPolicyWrite: false,
        productIdentifierExceptionsWrite: false
      }
    }
    await cached()
    expect(requestMock).not.toHaveBeenCalled()
  })
  it.each(['policy_assign', 'exception_create'])(
    'disables %s replay after its own capability is revoked while preserving the historical command',
    async (action) => {
      const page = await render()
      if (action === 'policy_assign') await prepare(page)
      else
        Object.assign(form(page, 'exceptionForm'), {
          variantId: VARIANT,
          reason: 'Excepción revisada documentada',
          evidenceReference: 'EXP-SINTETICO',
          validFrom: '2026-09-30T10:00:00Z',
          validUntil: '',
          confirmed: true
        })
      requestMock.mockRejectedValueOnce(new Error('lost response'))
      await invoke(page, action === 'policy_assign' ? 'assignPolicy' : 'createException')
      const original = calls()[0]
      const cap = action === 'policy_assign' ? 'productPublicationPolicyWrite' : 'productIdentifierExceptionsWrite'
      data.value = { ...dto(), capabilities: { ...dto().capabilities, [cap]: false } }
      await nextTick()
      const retryButton = page
        .findAll('button')
        .find((button) => button.text() === 'Reintentar exactamente el mismo comando')!
      expect(retryButton.attributes('disabled')).toBeDefined()
      await invoke(page, 'retry')
      expect(requestMock).toHaveBeenCalledOnce()
      await page.setProps({ product: { ...product(), catalogVersion: 3 } })
      data.value = { ...dto(), catalogVersion: 3 }
      await nextTick()
      expect(retryButton.attributes('disabled')).toBeUndefined()
      requestMock.mockResolvedValueOnce(receipt(action, action === 'policy_assign' ? POLICY : VARIANT, 3))
      await invoke(page, 'retry')
      expect(calls()[1]).toEqual(original)
      expect(data.value).toMatchObject({ catalogVersion: 3 })
    }
  )
  it('recovers read failure via explicit guarded GET without sending any command', async () => {
    status.value = 'error'
    const page = await render()
    refreshDetail.mockImplementationOnce(async () => {
      await invoke(page, 'refreshAll')
    })
    refresh.mockImplementationOnce(async () => {
      status.value = 'success'
    })
    await invoke(page, 'refreshAll')
    expect(refreshDetail).toHaveBeenCalledOnce()
    expect(refresh).toHaveBeenCalledOnce()
    expect(page.find('#product-policy-choice').exists()).toBe(true)
    expect(requestMock).not.toHaveBeenCalled()
  })
})

describe('private parent policy integration', () => {
  it.each(['node', 'unknown'])('never mounts/fetches the D1 editor for %s', async (value) => {
    const page = await renderParent({ ...product(), source: value === 'node' ? undefined : 'cloudflare' }, value)
    expect(page.findComponent(PolicyEditor).exists()).toBe(false)
    expect(fetchMock.mock.calls.some((call) => String(toValue(call[0])).endsWith('/publication-policy'))).toBe(false)
    expect(requestMock).not.toHaveBeenCalled()
  })
  it('does not mount without own narrow read permission or valid initial detail', async () => {
    const page = await renderParent({
      ...product(),
      capabilities: { productDetailRead: true, productPublicationPolicyRead: false }
    })
    expect(page.findComponent(PolicyEditor).exists()).toBe(false)
  })
  it('retains mounted identity across pending GET but denies current authority before queued prop updates', async () => {
    const page = await renderParent()
    const child = page.getComponent(PolicyEditor)
    await prepare(child)
    requestMock.mockRejectedValueOnce(new Error('lost response'))
    await invoke(child, 'assignPolicy')
    const original = calls()[0]
    const mountedUid = child.vm.$.uid
    let pendingUid: number | undefined
    let pendingHasForm = true
    refreshDetail.mockImplementationOnce(async () => {
      detailStatus.value = 'pending'
      await flushPromises()
      pendingUid = page.getComponent(PolicyEditor).vm.$.uid
      pendingHasForm = child.find('form').exists()
      detail.value = { ...product(), catalogVersion: 3 }
      detailStatus.value = 'success'
    })
    refresh.mockImplementationOnce(async () => {
      data.value = { ...dto(), catalogVersion: 3 }
    })
    await invoke(child, 'refreshAll')
    expect(requestMock).toHaveBeenCalledOnce()
    expect(pendingUid).toBe(mountedUid)
    expect(pendingHasForm).toBe(false)
    expect(state(child).uncertain).toBe(true)
    expect(child.props('product')).toMatchObject({ catalogVersion: 3 })
    expect(child.props('readStatus')).toBe('success')
    expect((state(child).originAuthorized as () => boolean)()).toBe(true)
    expect(refresh).toHaveBeenCalledOnce()
    expect(state(child).snapshot).toMatchObject({ catalogVersion: 3 })
    expect(state(child).busy).toBe(false)
    await invoke(child, 'retry')
    expect(calls()[1]).toEqual(original)
    expect(data.value).toMatchObject({ catalogVersion: 3 })
    const callback = state(child).assignPolicy as () => Promise<void>
    detail.value = {
      ...product(),
      catalogVersion: 3,
      capabilities: { productDetailRead: true, productPublicationPolicyRead: false }
    }
    await callback()
    expect(requestMock).toHaveBeenCalledTimes(2)
  })
})
