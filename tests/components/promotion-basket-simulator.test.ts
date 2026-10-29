import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { ref, type Ref } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Panel from '../../app/components/PromotionBasketSimulator.vue'
import type { AdminCapabilities } from '../../shared/admin-navigation'
import { promotionBasketPreviewResponseSchema } from '../../shared/promotion-basket-preview'
import '#app/nuxt-vitest-app-entry'

// Real-contract UI matrix: explicit authorized variant picker and quantities;
// no client prices/costs/counters; unknown cost != zero, negative goods margin;
// shipping revenue != operational cost/profit; proposed rule never activated;
// bounded single-flight, editing/late-response invalidation, auth/scope purge.
const mocks = vi.hoisted(() => ({ request: vi.fn(), owner: null as unknown, nav: null as unknown }))
mockNuxtImport('useRequestFetch', () => () => mocks.request)
mockNuxtImport('useUserSession', () => () => mocks.owner)
mockNuxtImport('useRuntimeConfig', () => () => ({
  app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
  public: { serverRuntime: 'cloudflare' }
}))
vi.mock('../../app/composables/useAdminNavigation', () => ({ useAdminNavigation: () => mocks.nav }))
const actor = '10000000-0000-4000-8000-000000000012',
  sessionId = '20000000-0000-4000-8000-000000000012',
  variantId = '30000000-0000-4000-8000-000000000012'
const rule = {
  id: '40000000-0000-4000-8000-000000000012',
  version: 1,
  code: 'SIMULATED',
  status: 'paused' as const,
  channel: 'online' as const,
  startsAt: '2030-01-01T00:00:00Z',
  endsAt: null,
  benefit: { kind: 'percent' as const, basisPoints: 1000 },
  scope: { kind: 'all' as const },
  segment: 'all' as const,
  totalLimit: null,
  perCustomerLimit: null,
  volumeMode: 'exclude_volume' as const
}
const prices = () => ({
  source: 'cloudflare',
  capabilities: { pricesRead: true },
  items: [
    {
      variantId,
      id: 12,
      sku: 'SYNTHETIC-SKU',
      format: 'Caja',
      product: 'Synthetic product',
      productId: 1,
      productUuid: '50000000-0000-4000-8000-000000000012',
      catalogVersion: 1,
      currency: 'EUR',
      grossCents: 1210,
      compareAtGrossCents: null,
      referenceGrossCents30d: null,
      volumeTiers: [],
      pricingVersion: 'legacy:12',
      currentPrice: { kind: 'legacy', versionId: null },
      quantityRules: { minimumQuantity: 2, maximumQuantity: 10, quantityIncrement: 2 },
      validFrom: null,
      history: [],
      historyPagination: { page: 1, perPage: 1, total: 0, pages: 0 },
      scheduled: null,
      latestApproved: null,
      cancellable: false
    }
  ],
  pagination: { page: 1, perPage: 25, total: 1, pages: 1 },
  pricingInstant: '2030-01-01T00:00:00Z',
  referenceEvidence: 'available_approved_windows_only',
  limits: { itemsPerPageMax: 500, historyPerPageMax: 100, returnedVersionRecordsMax: 5000 }
})
let owner: {
    ready: Ref<boolean>
    loggedIn: Ref<boolean>
    user: Ref<{ id: string; emailVerified: boolean; mfaVerified: boolean }>
    session: Ref<{ sessionId: string; sessionVersion: number }>
  },
  caps: Ref<AdminCapabilities>
const mounted: Awaited<ReturnType<typeof mountSuspended>>[] = []
beforeEach(() => {
  owner = {
    ready: ref(true),
    loggedIn: ref(true),
    user: ref({ id: actor, emailVerified: true, mfaVerified: true }),
    session: ref({ sessionId, sessionVersion: 1 })
  }
  caps = ref({
    source: 'cloudflare',
    identityId: actor,
    sessionId,
    sessionVersion: 1,
    state: 'ready',
    permissions: ['administration.manage', 'catalog.write']
  })
  mocks.owner = owner
  mocks.nav = { capabilities: caps, status: ref('ready') }
  mocks.request.mockReset().mockImplementation(async (path: string) => {
    if (path === '/api/admin/prices') return prices()
    throw Error('unconfigured_request')
  })
})
afterEach(() => mounted.splice(0).forEach((w) => w.unmount()))
async function mount() {
  const w = await mountSuspended(Panel, { props: { rule, scopeKey: 'current-session', enabled: true, pending: false } })
  mounted.push(w)
  await flushPromises()
  return w
}
async function basket(w: Awaited<ReturnType<typeof mount>>) {
  await w.get('[data-testid="basket-query"]').setValue('SYNTHETIC')
  await w.get('[data-testid="basket-search"]').trigger('submit')
  await flushPromises()
  await w.get(`[data-testid="basket-add-${variantId}"]`).trigger('click')
  await w.get('[data-testid="basket-city"]').setValue('Ontinyent')
  await w.get('[data-testid="basket-postal"]').setValue('46870')
}
it('does not read on mount or each keystroke, searches the existing authorized picker explicitly', async () => {
  const w = await mount()
  expect(mocks.request).not.toHaveBeenCalled()
  await w.get('[data-testid="basket-query"]').setValue('SYNTHETIC')
  expect(mocks.request).not.toHaveBeenCalled()
  await w.get('[data-testid="basket-search"]').trigger('submit')
  await flushPromises()
  expect(mocks.request).toHaveBeenCalledWith(
    '/api/admin/prices',
    expect.objectContaining({ query: { q: 'SYNTHETIC', page: 1, perPage: 25, historyPerPage: 1 }, retry: 0 })
  )
  expect(w.text()).toContain('SYNTHETIC-SKU')
})
it('distinguishes failed and malformed picker reads from confirmed empty', async () => {
  const w = await mount()
  mocks.request.mockRejectedValueOnce(Error('offline'))
  await w.get('[data-testid="basket-search"]').trigger('submit')
  await flushPromises()
  expect(w.text()).toContain('No se pudo consultar')
  expect(w.text()).not.toContain('Sin coincidencias')
  mocks.request.mockResolvedValueOnce({ ...prices(), items: [{ variantId }] })
  await w.get('[data-testid="basket-search"]').trigger('submit')
  await flushPromises()
  expect(w.text()).toContain('No se pudo consultar')
  mocks.request.mockResolvedValueOnce({
    ...prices(),
    items: [],
    pagination: { page: 1, perPage: 25, total: 0, pages: 0 }
  })
  await w.get('[data-testid="basket-search"]').trigger('submit')
  await flushPromises()
  expect(w.text()).toContain('Sin coincidencias')
})
it('deduplicates selected variants and validates MOQ/increment before any preview POST', async () => {
  const w = await mount()
  await basket(w)
  await w.get(`[data-testid="basket-add-${variantId}"]`).trigger('click')
  expect(w.findAll('[data-testid^="basket-quantity-"]')).toHaveLength(1)
  await w.get(`[data-testid="basket-quantity-${variantId}"]`).setValue('3')
  await w.get('[data-testid="basket-run"]').trigger('click')
  await flushPromises()
  expect(mocks.request.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0)
  expect(w.text()).toContain('Revise cantidades')
})
it('sends only server-resolved IDs/quantities, destination and proposed rule, never a command or activation', async () => {
  const w = await mount()
  await basket(w)
  await w.get('[data-testid="basket-run"]').trigger('click')
  await flushPromises()
  const posts = mocks.request.mock.calls.filter(([, options]) => options?.method === 'POST')
  expect(posts).toHaveLength(1)
  expect(posts[0]).toEqual([
    '/api/admin/promotions/basket-preview',
    expect.objectContaining({
      retry: 0,
      body: {
        lines: [{ variantId, quantity: 2 }],
        destination: { city: 'Ontinyent', postalCode: '46870' },
        customerId: null,
        rule
      }
    })
  ])
  expect(w.text()).toContain('No activa')
})
it('validates advanced optional customer UUID without substituting a company ID or inventing a customer', async () => {
  const w = await mount()
  await basket(w)
  await w.get('[data-testid="basket-customer"]').setValue('not-a-customer')
  await w.get('[data-testid="basket-run"]').trigger('click')
  await flushPromises()
  expect(mocks.request.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0)
})
it.each(['identity', 'session', 'version', 'email', 'mfa', 'grant'] as const)(
  'purges the private picker/basket after %s boundary',
  async (change) => {
    const w = await mount()
    await basket(w)
    if (change === 'identity') owner.user.value.id = '60000000-0000-4000-8000-000000000012'
    if (change === 'session') owner.session.value.sessionId = '70000000-0000-4000-8000-000000000012'
    if (change === 'version') owner.session.value.sessionVersion++
    if (change === 'email') owner.user.value.emailVerified = false
    if (change === 'mfa') owner.user.value.mfaVerified = false
    if (change === 'grant') caps.value.permissions = ['administration.manage']
    await flushPromises()
    expect(w.text()).not.toContain('SYNTHETIC-SKU')
    expect(w.find('[data-testid="basket-run"]').exists()).toBe(false)
  }
)
it('hides and purges on external pending, without automatically reading or posting when released', async () => {
  const w = await mount()
  await basket(w)
  mocks.request.mockClear()
  await w.setProps({ pending: true })
  expect(w.text()).not.toContain('SYNTHETIC-SKU')
  await w.setProps({ pending: false })
  expect(mocks.request).not.toHaveBeenCalled()
  expect(w.text()).not.toContain('SYNTHETIC-SKU')
})
function result(cost: number | null = 1000) {
  const costNetCents = cost === null ? null : cost * 2
  const scenario = (netCents: number, taxCents: number) => ({
    netCents,
    taxCents,
    grossCents: netCents + taxCents,
    costNetCents,
    marginNetCents: costNetCents === null ? null : netCents - costNetCents,
    loss: costNetCents === null ? null : netCents < costNetCents
  })
  return promotionBasketPreviewResponseSchema.parse({
    source: 'cloudflare',
    simulation: true,
    ruleEvaluation: 'proposed_active',
    evaluatedAt: '2030-01-01T00:00:00Z',
    ruleHash: 'a'.repeat(64),
    snapshotHash: 'b'.repeat(64),
    eligible: true,
    reason: null,
    lines: [
      {
        lineIndex: 0,
        variantId,
        sku: 'SYNTHETIC-SKU',
        name: 'Synthetic product',
        quantity: 2,
        priceVersionId: 'legacy:12',
        costUnitNetCents: cost,
        costNetCents,
        base: { netCents: 2000, taxCents: 420, grossCents: 2420 },
        volume: { netCents: 1800, taxCents: 378, grossCents: 2178 },
        proposed: { netCents: 1600, taxCents: 336, grossCents: 1936 },
        discountGrossCents: 242
      }
    ],
    totals: { base: scenario(2000, 420), volume: scenario(1800, 378), proposed: scenario(1600, 336) },
    shipping: {
      options: [
        {
          methodCode: 'pickup',
          serviceProfile: 'parcel',
          zoneCode: 'synthetic',
          netCents: 0,
          taxCents: 0,
          grossCents: 0,
          taxRateBasisPoints: 2100,
          etaMinDays: 0,
          etaMaxDays: 0,
          rateVersion: 1
        }
      ],
      operationalCostNetCents: null
    },
    totalMarginNetCents: null
  })
}
async function simulate(cost: number | null) {
  const w = await mount()
  await basket(w)
  mocks.request.mockResolvedValueOnce(result(cost))
  await w.get('[data-testid="basket-run"]').trigger('click')
  await flushPromises()
  return w
}
it('renders unknown costs and margins as unknown, never zero or a total profit claim', async () => {
  const w = await simulate(null)
  expect(w.get('[data-testid="basket-cost"]').text()).toContain('Desconocido')
  expect(w.get('[data-testid="basket-margin"]').text()).toContain('Desconocido')
  expect(w.text()).toContain('Coste logístico desconocido')
  expect(w.text()).toContain('Beneficio total no acreditado')
})
it('distinguishes an explicitly known zero cost from a missing cost', async () => {
  const w = await simulate(0)
  expect(w.get('[data-testid="basket-cost"]').text()).toContain('0 céntimos')
  expect(w.get('[data-testid="basket-cost"]').text()).not.toContain('Desconocido')
  expect(w.get('[data-testid="basket-margin"]').text()).toContain('1600 céntimos')
})
it('compares base, volume and proposed totals and warns about a real negative goods margin', async () => {
  const w = await simulate(1000)
  expect(w.get('[data-testid="basket-margin"]').text()).toContain('-400 céntimos')
  expect(w.text()).toContain('Pérdida de mercancía')
  expect(w.text()).toContain('Base')
  expect(w.text()).toContain('Volumen')
  expect(w.text()).toContain('Regla propuesta')
  expect(w.text()).toContain('Cargo al cliente')
  expect(w.text()).toContain('No activa')
})
it('never publishes a foreign or malformed result as the current basket', async () => {
  const w = await mount()
  await basket(w)
  mocks.request.mockResolvedValueOnce({ ...result(), lines: [{ ...result().lines[0], quantity: 4 }] })
  await w.get('[data-testid="basket-run"]').trigger('click')
  await flushPromises()
  expect(w.find('[data-testid="basket-result"]').exists()).toBe(false)
  expect(w.text()).toContain('No se pudo simular')
})
it('accepts canonical server line order when two variants were selected in reverse order', async () => {
  const secondId = '30000000-0000-4000-8000-000000000013'
  const picker = prices()
  picker.items.push({ ...picker.items[0]!, variantId: secondId, id: 13, sku: 'SYNTHETIC-B' })
  picker.pagination.total = 2
  const canonical = result()
  canonical.lines.push({ ...canonical.lines[0]!, lineIndex: 1, variantId: secondId, sku: 'SYNTHETIC-B' })
  for (const scenario of ['base', 'volume', 'proposed'] as const) {
    const totals = canonical.totals[scenario]
    totals.netCents *= 2
    totals.taxCents *= 2
    totals.grossCents *= 2
    totals.costNetCents! *= 2
    totals.marginNetCents! *= 2
  }
  promotionBasketPreviewResponseSchema.parse(canonical)
  mocks.request.mockResolvedValueOnce(picker)
  const w = await mount()
  await w.get('[data-testid="basket-search"]').trigger('submit')
  await flushPromises()
  await w.get(`[data-testid="basket-add-${secondId}"]`).trigger('click')
  await w.get(`[data-testid="basket-add-${variantId}"]`).trigger('click')
  await w.get('[data-testid="basket-city"]').setValue('Ontinyent')
  await w.get('[data-testid="basket-postal"]').setValue('46870')
  mocks.request.mockResolvedValueOnce(canonical)
  await w.get('[data-testid="basket-run"]').trigger('click')
  await flushPromises()
  expect(w.find('[data-testid="basket-result"]').exists()).toBe(true)
  expect(w.text()).toContain('SYNTHETIC-B')
  const sent = mocks.request.mock.calls.find(([, options]) => options?.method === 'POST')![1]
  expect(sent.body.lines).toEqual([
    { variantId: secondId, quantity: 2 },
    { variantId, quantity: 2 }
  ])
})
it('keeps failed/lost preview as error without success, zero totals, commands or automatic retries', async () => {
  const w = await mount()
  await basket(w)
  mocks.request.mockRejectedValueOnce(Error('lost'))
  await w.get('[data-testid="basket-run"]').trigger('click')
  await flushPromises()
  expect(w.text()).toContain('No se pudo simular')
  expect(w.find('[data-testid="basket-result"]').exists()).toBe(false)
  expect(mocks.request.mock.calls.filter(([, o]) => o?.method === 'POST')).toHaveLength(1)
})
it('single-flights explicit preview and rejects a late result after editing the basket', async () => {
  const w = await mount()
  await basket(w)
  let resolve!: (value: unknown) => void
  mocks.request.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done
      })
  )
  await w.get('[data-testid="basket-run"]').trigger('click')
  await w.get('[data-testid="basket-run"]').trigger('click')
  await w.get(`[data-testid="basket-quantity-${variantId}"]`).setValue('4')
  resolve(result())
  await flushPromises()
  expect(w.find('[data-testid="basket-result"]').exists()).toBe(false)
  expect(mocks.request.mock.calls.filter(([, o]) => o?.method === 'POST')).toHaveLength(1)
})
it('invalidates results when rule, destination or optional customer context changes', async () => {
  const w = await simulate(0)
  await w.get('[data-testid="basket-city"]').setValue('Albaida')
  expect(w.find('[data-testid="basket-result"]').exists()).toBe(false)
  mocks.request.mockResolvedValueOnce(result(0))
  await w.get('[data-testid="basket-run"]').trigger('click')
  await flushPromises()
  await w.setProps({ rule: { ...rule, code: 'CHANGED' } })
  expect(w.find('[data-testid="basket-result"]').exists()).toBe(false)
})
it('purges all private inputs and response on server403, without retaining a stale grant', async () => {
  const w = await mount()
  await basket(w)
  mocks.request.mockRejectedValueOnce({ statusCode: 403 })
  await w.get('[data-testid="basket-run"]').trigger('click')
  await flushPromises()
  expect(w.text()).not.toContain('SYNTHETIC-SKU')
  expect(w.find('[data-testid="basket-run"]').exists()).toBe(false)
  expect(w.find('[data-testid="basket-result"]').exists()).toBe(false)
})
it('rejects a late private response after scope change and never restores the old basket', async () => {
  const w = await mount()
  await basket(w)
  let resolve!: (value: unknown) => void
  mocks.request.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done
      })
  )
  await w.get('[data-testid="basket-run"]').trigger('click')
  await w.setProps({ scopeKey: 'another-session' })
  resolve(result())
  await flushPromises()
  expect(w.text()).not.toContain('SYNTHETIC-SKU')
  expect(w.find('[data-testid="basket-result"]').exists()).toBe(false)
})
