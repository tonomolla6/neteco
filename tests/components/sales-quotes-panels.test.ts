import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { ref, reactive } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Panel from '../../app/components/SalesQuotesPanel.vue'
import { salesQuoteIntentHash, salesQuoteConversionIntentHash, type SalesQuoteAction } from '../../shared/sales-quotes'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  auth: null as unknown,
  nav: null as unknown,
  cart: null as unknown,
  runtime: 'cloudflare'
}))
mockNuxtImport('useRequestFetch', () => () => mocks.request)
mockNuxtImport('useUserSession', () => () => mocks.auth)
mockNuxtImport('useRuntimeConfig', () => () => ({
  app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
  public: { serverRuntime: mocks.runtime }
}))
vi.mock('../../app/composables/useAdminNavigation', () => ({ useAdminNavigation: () => mocks.nav }))
vi.mock('../../app/stores/cart', () => ({ useCartStore: () => mocks.cart }))
const ACTOR = '89000000-0000-4000-8000-000000000010',
  SESSION = '89000000-0000-4000-8000-000000000011',
  QUOTE = '89000000-0000-4000-8000-000000000012',
  CUSTOMER = '89000000-0000-4000-8000-000000000013',
  VARIANT = '89000000-0000-4000-8000-000000000014',
  ORDER = '89000000-0000-4000-8000-000000000015',
  CART = '89000000-0000-4000-8000-000000000016',
  SHIPPING = '89000000-0000-4000-8000-000000000017',
  CARTQUOTE = '89000000-0000-4000-8000-000000000018',
  HASH = 'a'.repeat(64),
  INSTANT = '2030-01-01T10:00:00Z'
const definition = {
  customerId: CUSTOMER,
  lines: [{ variantId: VARIANT, quantity: 2 }],
  destination: { city: 'Ontinyent', postalCode: '46870' },
  shippingMethod: 'pickup',
  validUntil: '2030-01-02T12:00:00Z'
}
const amounts = { netCents: 826, taxCents: 174, grossCents: 1000 }
function snapshot(status: 'draft' | 'reviewed' | 'approved' | 'converted' = 'approved', version = 3) {
  return {
    source: 'cloudflare',
    id: QUOTE,
    version,
    status,
    definition,
    lines:
      status === 'draft'
        ? []
        : [
            {
              variantId: VARIANT,
              quantity: 2,
              unitGrossCents: 500,
              taxRateBasisPoints: 2100,
              priceVersionId: 'legacy:14',
              costUnitNetCents: null,
              amounts
            }
          ],
    goods: status === 'draft' ? null : amounts,
    shipping: status === 'draft' ? null : { netCents: 0, taxCents: 0, grossCents: 0 },
    total: status === 'draft' ? null : amounts,
    goodsCostNetCents: null,
    goodsMarginNetCents: null,
    shippingOperationalCostNetCents: null,
    totalMarginNetCents: null,
    reviewedHash: status === 'draft' ? null : HASH,
    approvedHash: ['approved', 'converted'].includes(status) ? HASH : null,
    orderId: status === 'converted' ? ORDER : null,
    createdAt: INSTANT,
    updatedAt: INSTANT
  }
}
function customerSnapshot(status: 'approved' | 'converted' = 'approved') {
  const s = snapshot(status, status === 'converted' ? 4 : 3)
  return {
    source: s.source,
    id: s.id,
    version: s.version,
    status: s.status,
    destination: s.definition.destination,
    shippingMethod: s.definition.shippingMethod,
    validUntil: s.definition.validUntil,
    lines: s.lines.map(({ variantId, quantity, unitGrossCents, taxRateBasisPoints, amounts }) => ({
      variantId,
      quantity,
      unitGrossCents,
      taxRateBasisPoints,
      amounts
    })),
    goods: s.goods,
    shipping: s.shipping,
    total: s.total,
    approvedHash: s.approvedHash,
    orderId: s.orderId,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt
  }
}
type Options = {
  method?: string
  body?: Record<string, unknown>
  headers?: Record<string, string>
  query?: Record<string, unknown>
}
let auth: {
    ready: ReturnType<typeof ref<boolean>>
    loggedIn: ReturnType<typeof ref<boolean>>
    user: ReturnType<typeof ref<Record<string, unknown>>>
    session: ReturnType<typeof ref<Record<string, unknown>>>
  },
  current: ReturnType<typeof snapshot>,
  lastReceipt: Record<string, unknown> | null,
  cart: {
    id: string
    version: number
    ready: boolean
    loading: boolean
    pendingMutation: boolean
    items: Array<{ variantId: number; sku: string; qty: number }>
    ensureLoaded: ReturnType<typeof vi.fn>
    resetLocal: ReturnType<typeof vi.fn>
  }
const mounted: Awaited<ReturnType<typeof mountSuspended>>[] = []
const posts = (suffix = '') =>
  mocks.request.mock.calls.filter(
    ([path, options]) =>
      String(path).includes('/sales-quotes') &&
      (options as Options)?.method === 'POST' &&
      (!suffix || String(path).endsWith(suffix))
  )
beforeEach(() => {
  mocks.runtime = 'cloudflare'
  lastReceipt = null
  current = snapshot()
  auth = {
    ready: ref(true),
    loggedIn: ref(true),
    user: ref({ id: ACTOR, email: 'owner@example.invalid', emailVerified: true, mfaVerified: true }),
    session: ref({ sessionId: SESSION, sessionVersion: 1 })
  }
  mocks.auth = auth
  mocks.nav = {
    status: ref('ready'),
    capabilities: ref({
      source: 'cloudflare',
      state: 'ready',
      identityId: ACTOR,
      sessionId: SESSION,
      sessionVersion: 1,
      permissions: ['administration.manage']
    })
  }
  cart = reactive({
    id: CART,
    version: 2,
    ready: true,
    loading: false,
    pendingMutation: false,
    items: [{ variantId: 14, sku: 'SYNTHETIC', qty: 2 }],
    ensureLoaded: vi.fn(async () => undefined),
    resetLocal: vi.fn()
  })
  mocks.cart = cart
  mocks.request.mockReset().mockImplementation(async (path: string, options: Options = {}) => {
    if (path === '/api/products')
      return { items: [{ id: 1, slug: 'synthetic', name: 'Synthetic public product' }], total: 1, page: 1, pages: 1 }
    if (path === '/api/products/synthetic')
      return {
        id: 1,
        slug: 'synthetic',
        name: 'Synthetic public product',
        variants: [
          {
            id: 14,
            uuid: VARIANT,
            sku: 'SYNTHETIC',
            format: 'Botella 1 L',
            minimumQuantity: 1,
            maximumQuantity: 999,
            quantityIncrement: 1
          }
        ]
      }
    if (path === '/api/shipping/rates' || String(path).endsWith('/shipping-options'))
      return {
        cartVersion: 2,
        rates: [
          {
            profile: 'pickup',
            serviceCode: 'pickup',
            quoteId: CARTQUOTE,
            shippingQuoteId: SHIPPING,
            optionIndex: 0,
            optionHash: HASH,
            expiresAt: '2030-01-02T12:00:00Z'
          }
        ]
      }
    if (String(path).includes('/commands/') && options.method !== 'POST')
      return { source: 'cloudflare', outcome: 'applied', receipt: lastReceipt }
    if (String(path).endsWith('/convert')) {
      lastReceipt = {
        source: 'cloudflare',
        commandId: options.headers!['Idempotency-Key'],
        action: 'convert',
        quoteId: QUOTE,
        version: 4,
        payloadHash: await salesQuoteConversionIntentHash(QUOTE, CART, options.body),
        orderId: ORDER,
        recordedAt: INSTANT
      }
      return lastReceipt
    }
    if (options.method === 'POST') {
      const { action: candidate, ...rest } = options.body!,
        action = candidate ? String(candidate) : 'create',
        body = candidate ? rest : options.body!
      const target = action === 'create' ? null : QUOTE
      const version = action === 'create' ? 1 : current.version + 1
      lastReceipt = {
        source: 'cloudflare',
        commandId: options.headers!['Idempotency-Key'],
        action,
        quoteId: QUOTE,
        version,
        payloadHash: await salesQuoteIntentHash(action as SalesQuoteAction, target, body),
        orderId: null,
        recordedAt: INSTANT
      }
      current = snapshot(action === 'create' ? 'draft' : action === 'review' ? 'reviewed' : 'approved', version)
      return lastReceipt
    }
    if (path === '/api/admin/sales-quotes')
      return { source: 'cloudflare', page: 1, perPage: 25, total: 1, items: [current] }
    if (path === '/api/account/sales-quotes')
      return { source: 'cloudflare', page: 1, perPage: 25, total: 1, items: [customerSnapshot()] }
    if (path === `/api/admin/sales-quotes/${QUOTE}`) return current
    if (path === `/api/account/sales-quotes/${QUOTE}`)
      return customerSnapshot(lastReceipt?.action === 'convert' ? 'converted' : 'approved')
    throw new Error('unconfigured_test_request')
  })
})
afterEach(() => mounted.splice(0).forEach((w) => w.unmount()))
async function mount(audience: 'admin' | 'customer' = 'admin') {
  const w = await mountSuspended(Panel, { props: { audience } })
  mounted.push(w)
  await flushPromises()
  return w
}
async function open(w: Awaited<ReturnType<typeof mount>>) {
  await w.get('[data-testid="sales-quotes-load"]').trigger('click')
  await flushPromises()
  await w.get(`[data-testid="sales-quote-open-${QUOTE}"]`).trigger('click')
  await flushPromises()
}
async function convertReview(w: Awaited<ReturnType<typeof mount>>) {
  await open(w)
  for (const [field, value] of Object.entries({
    name: 'Synthetic owner',
    line1: 'Synthetic street 1',
    region: 'Valencia',
    phone: '+34600111222'
  }))
    await w.get(`[data-testid="sales-quote-${field}"]`).setValue(value)
  await w.get('[data-testid="sales-quote-prepare"]').trigger('click')
  await flushPromises()
  await w.get('[data-testid="sales-quote-consent"]').setValue(true)
}

describe('private commercial quotes UI contract, not backend acceptance', () => {
  it('does not fetch or mutate on mount', async () => {
    await mount()
    expect(mocks.request).not.toHaveBeenCalled()
  })
  it('loads and opens explicit server-authorized quotes without demanding catalog.write', async () => {
    const w = await mount()
    await open(w)
    expect(w.text()).toContain('Precio aprobado bloqueado')
    expect(posts()).toHaveLength(0)
  })
  it('searches the real public catalog explicitly and chooses a named variant, never a client price', async () => {
    const w = await mount()
    await w.get('[data-testid="sales-quote-new"]').trigger('click')
    await w.get('[data-testid="sales-quote-search-text"]').setValue('Synthetic')
    expect(mocks.request).not.toHaveBeenCalled()
    await w.get('[data-testid="sales-quote-search"]').trigger('click')
    await flushPromises()
    await w.get('[data-testid="sales-quote-product-synthetic"]').trigger('click')
    await flushPromises()
    await w.get(`[data-testid="sales-quote-add-${VARIANT}"]`).trigger('click')
    expect(w.text()).toContain('Synthetic public product')
    expect(w.find('[data-testid="sales-quote-client-price"]').exists()).toBe(false)
    expect(posts()).toHaveLength(0)
  })
  it('creates a complete customer draft only after review, freezes the governed input and confirms a version-one fresh snapshot', async () => {
    const w = await mount()
    await w.get('[data-testid="sales-quote-new"]').trigger('click')
    await w.get('[data-testid="sales-quote-search-text"]').setValue('Synthetic')
    await w.get('[data-testid="sales-quote-search"]').trigger('click')
    await flushPromises()
    await w.get('[data-testid="sales-quote-product-synthetic"]').trigger('click')
    await flushPromises()
    await w.get(`[data-testid="sales-quote-add-${VARIANT}"]`).trigger('click')
    for (const [field, value] of Object.entries({
      customer: CUSTOMER,
      city: 'Ontinyent',
      postal: '46870',
      'valid-until': '2030-01-02T12:00',
      reason: 'Explicit synthetic commercial draft'
    }))
      await w.get(`[data-testid="sales-quote-${field}"]`).setValue(value)
    await w.get(`[data-testid="sales-quote-quantity-${VARIANT}"]`).setValue('2')
    await w.get('form').trigger('submit')
    await flushPromises()
    expect(posts()).toHaveLength(0)
    await w.get('[data-testid="sales-quote-confirm"]').trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('Operación confirmada'))
    expect(posts()).toHaveLength(1)
    expect(posts()[0]![1].body).toEqual({ ...definition, reason: 'Explicit synthetic commercial draft' })
    expect(w.get('[data-testid="sales-quote-detail"]').text()).toContain('draft · v1')
    expect(lastReceipt).toMatchObject({ action: 'create', version: 1, orderId: null })
  })
  it('reviews current server economics and explains unknown margin without inventing a minimum or total profit', async () => {
    current = snapshot('draft', 1)
    const w = await mount()
    await open(w)
    await w.get('[data-testid="sales-quote-reason"]').setValue('Explicit synthetic commercial review')
    await w.get('[data-testid="sales-quote-review"]').trigger('click')
    await flushPromises()
    await w.get('[data-testid="sales-quote-confirm"]').trigger('click')
    await vi.waitFor(() => expect(posts()).toHaveLength(1))
    await flushPromises()
    expect(posts()[0]![1].body).toEqual({
      action: 'review',
      expectedVersion: 1,
      reason: 'Explicit synthetic commercial review'
    })
    expect(w.text()).toContain('Margen desconocido')
    expect(w.text()).toContain('Coste logístico desconocido')
    expect(w.text()).not.toContain('Beneficio total confirmado')
  })
  it('approves only the reviewed server hash after explicit confirmation and fresh detail', async () => {
    current = snapshot('reviewed', 2)
    const w = await mount()
    await open(w)
    await w.get('[data-testid="sales-quote-reason"]').setValue('Explicit human approval of governed prices')
    await w.get('[data-testid="sales-quote-approve"]').trigger('click')
    expect(posts()).toHaveLength(0)
    await w.get('[data-testid="sales-quote-confirm"]').trigger('click')
    await vi.waitFor(() => expect(posts()).toHaveLength(1))
    await flushPromises()
    expect(posts()[0]![1].body).toMatchObject({ action: 'approve', expectedVersion: 2, reviewedHash: HASH })
    await vi.waitFor(() => expect(w.text()).toContain('Operación confirmada'))
  })
  it('retains a lost approval receipt for manual exact GET without another POST', async () => {
    current = snapshot('reviewed', 2)
    const original = mocks.request.getMockImplementation()!
    mocks.request.mockImplementation(async (...args: [string, Options?]) => {
      const result = await original(...args)
      if (args[1]?.method === 'POST') throw Error('synthetic_ack_loss')
      return result
    })
    const w = await mount()
    await open(w)
    await w.get('[data-testid="sales-quote-reason"]').setValue('Explicit human approval of governed prices')
    await w.get('[data-testid="sales-quote-approve"]').trigger('click')
    await w.get('[data-testid="sales-quote-confirm"]').trigger('click')
    await vi.waitFor(() => expect(posts()).toHaveLength(1))
    await flushPromises()
    await vi.waitFor(() => expect(w.get('[data-testid="sales-quote-recover"]').attributes('disabled')).toBeUndefined())
    await w.get('[data-testid="sales-quote-recover"]').trigger('click')
    await flushPromises()
    expect(posts()).toHaveLength(1)
    expect(
      mocks.request.mock.calls.some(
        ([path, options]) =>
          String(path).includes('/commands/') &&
          options.headers['X-Neteco-Command-Payload-Hash'] === lastReceipt!.payloadHash
      )
    ).toBe(true)
    await vi.waitFor(() => expect(w.text()).toContain('Operación confirmada'))
  })
  it('purges private facts and frozen intentions when session authority changes', async () => {
    const w = await mount()
    await open(w)
    auth.session.value = { sessionId: SESSION, sessionVersion: 2 }
    await flushPromises()
    expect(w.find('[data-testid="sales-quote-detail"]').exists()).toBe(false)
    expect(w.find('[data-testid="sales-quote-confirm"]').exists()).toBe(false)
  })
  it('purges private facts after 403 rather than rendering a zero or current approval', async () => {
    const w = await mount()
    await open(w)
    mocks.request.mockRejectedValue({ statusCode: 403 })
    await w.get('[data-testid="sales-quotes-load"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="sales-quote-detail"]').exists()).toBe(false)
    expect(w.text()).toContain('autorización')
  })
  it('keeps Node unchanged without a Cloudflare private feature', async () => {
    mocks.runtime = 'node'
    const w = await mount()
    expect(w.find('[data-testid="sales-quotes-load"]').exists()).toBe(false)
    expect(mocks.request).not.toHaveBeenCalled()
  })
  it('allows the verified customer without inventing a customer MFA requirement', async () => {
    auth.user.value.mfaVerified = false
    const w = await mount('customer')
    await open(w)
    expect(w.find('[data-testid="sales-quote-prepare"]').exists()).toBe(true)
    expect(w.text()).not.toContain('Margen')
  })
  it('prepares only an explicit current-cart shipping quote and never changes cart contents', async () => {
    const w = await mount('customer')
    await convertReview(w)
    expect(mocks.request.mock.calls.filter(([path]) => String(path).endsWith('/shipping-options'))).toHaveLength(1)
    expect(posts('/convert')).toHaveLength(0)
    expect(cart.items).toEqual([{ variantId: 14, sku: 'SYNTHETIC', qty: 2 }])
    expect(cart.resetLocal).not.toHaveBeenCalled()
  })
  it('binds explicit shipping preparation to the approved owner quote without submitting arbitrary shipping amounts', async () => {
    const w = await mount('customer')
    await convertReview(w)
    const calls = mocks.request.mock.calls.filter(([path]) => String(path).endsWith('/shipping-options'))
    expect(calls).toHaveLength(1)
    expect(calls[0]![0]).toBe(`/api/account/sales-quotes/${QUOTE}/shipping-options`)
    expect(calls[0]![1]).toMatchObject({ method: 'POST', body: { expectedVersion: 3, approvedHash: HASH } })
    expect(Object.keys(calls[0]![1]!.body as object).sort()).toEqual(['approvedHash', 'expectedVersion'])
    expect(mocks.request.mock.calls.filter(([path]) => path === '/api/shipping/rates')).toHaveLength(0)
    expect(posts('/convert')).toHaveLength(0)
  })
  it('converts once using the approved price and server reference, then links the owner order without starting payment', async () => {
    const w = await mount('customer')
    await convertReview(w)
    await w.get('[data-testid="sales-quote-convert"]').trigger('click')
    await vi.waitFor(() => expect(posts('/convert')).toHaveLength(1))
    await flushPromises()
    const sent = posts('/convert')[0]![1]
    expect(sent.body).toMatchObject({
      expectedVersion: 3,
      approvedHash: HASH,
      checkout: {
        expectedVersion: 2,
        quoteId: CARTQUOTE,
        shippingQuoteId: SHIPPING,
        selectedOptionIndex: 0,
        selectedOptionHash: HASH,
        expectedTotalGrossCents: 1000,
        consentTos: true,
        consentPrivacy: true
      }
    })
    expect(JSON.stringify(sent.body)).not.toMatch(/token|ownerSession|unitGrossCents|priceVersionId|salesQuote/)
    await vi.waitFor(() =>
      expect(w.get('[data-testid="sales-quote-order"]').attributes('href')).toBe(`/pedido/${ORDER}`)
    )
    expect(mocks.request.mock.calls.some(([path]) => String(path).includes('/pay'))).toBe(false)
  })
  it('recovers a lost conversion acknowledgement using the pre-send hash and exact manual GET without a second conversion POST', async () => {
    const original = mocks.request.getMockImplementation()!
    mocks.request.mockImplementation(async (...args: [string, Options?]) => {
      const result = await original(...args)
      if (args[0].endsWith('/convert')) throw Error('synthetic_conversion_ack_loss')
      return result
    })
    const w = await mount('customer')
    await convertReview(w)
    await w.get('[data-testid="sales-quote-convert"]').trigger('click')
    await vi.waitFor(() => expect(w.get('[data-testid="sales-quote-recover"]').attributes('disabled')).toBeUndefined())
    expect(w.find('[data-testid="sales-quote-order"]').exists()).toBe(false)
    const sent = posts('/convert')[0]![1],
      expectedHash = await salesQuoteConversionIntentHash(QUOTE, CART, sent.body)
    await w.get('[data-testid="sales-quote-recover"]').trigger('click')
    await vi.waitFor(() =>
      expect(w.get('[data-testid="sales-quote-order"]').attributes('href')).toBe(`/pedido/${ORDER}`)
    )
    expect(posts('/convert')).toHaveLength(1)
    expect(
      mocks.request.mock.calls.filter(
        ([path]) => path === `/api/account/sales-quotes/commands/${sent.headers['Idempotency-Key']}`
      )
    ).toEqual([
      [
        `/api/account/sales-quotes/commands/${sent.headers['Idempotency-Key']}`,
        expect.objectContaining({ headers: { 'X-Neteco-Command-Payload-Hash': expectedHash }, retry: 0 })
      ]
    ])
  })
  it('invalidates prepared conversion when the current cart changes before explicit consent', async () => {
    const w = await mount('customer')
    await convertReview(w)
    cart.version++
    await flushPromises()
    expect(w.find('[data-testid="sales-quote-convert"]').exists()).toBe(false)
    expect(posts('/convert')).toHaveLength(0)
  })
})
