import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { ref, type Ref } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Panel from '../../app/components/ProductRelationsEditor.vue'
import {
  adminCatalogRelationsSchema,
  catalogRelationsIntentHash,
  catalogRelationsReceiptSchema
} from '../../shared/catalog-relations'
import { catalogPriceListSchema } from '../../shared/catalog-price-commands'
import type { AdminCapabilities } from '../../shared/admin-navigation'
import '#app/nuxt-vitest-app-entry'

// Admin matrix: directed snapshot with four explicit kinds, real product picker
// (dedup variants, no self relation), mandatory manual review reference;
// preview/frozen intent before any POST, CAS+UUID/hash receipt and fresh read;
// unknown manual lookup/exact explicit replay, no silent duplicate/activation;
// DTO/source mismatch, GET error != empty, session/email/grants/late purge; Node.
const mocks = vi.hoisted(() => ({ request: vi.fn(), owner: null as unknown, nav: null as unknown }))
mockNuxtImport('useRequestFetch', () => () => mocks.request)
mockNuxtImport('$fetch', () => mocks.request)
mockNuxtImport('useUserSession', () => () => mocks.owner)
vi.mock('../../app/composables/useAdminNavigation', () => ({ useAdminNavigation: () => mocks.nav }))
const ACTOR = '10000000-0000-4000-8000-000000000010',
  SESSION = '20000000-0000-4000-8000-000000000010'
const ROOT = '/api/admin/products/1/relations'
const snapshot = (version = 0, items: Array<{ targetProductId: number; kind: 'accessory' }> = []) =>
  adminCatalogRelationsSchema.parse({
    source: 'cloudflare',
    productId: 1,
    version,
    items,
    updatedAt: version ? '2026-10-09T18:00:00Z' : null
  })
function prices() {
  return catalogPriceListSchema.parse({
    source: 'cloudflare',
    capabilities: { pricesRead: true },
    items: [1, 2, 2].map((productId, index) => ({
      variantId: `30000000-0000-4000-8000-00000000001${index}`,
      id: index + 1,
      sku: `SKU-${index}`,
      format: 'Caja',
      product: productId === 1 ? 'Origen' : 'Destino real',
      productId,
      productUuid: `40000000-0000-4000-8000-00000000001${productId}`,
      catalogVersion: 1,
      currency: 'EUR',
      grossCents: 1210,
      compareAtGrossCents: null,
      referenceGrossCents30d: null,
      volumeTiers: [],
      pricingVersion: `legacy:${index + 1}`,
      currentPrice: { kind: 'legacy', versionId: null },
      quantityRules: { minimumQuantity: 1, maximumQuantity: null, quantityIncrement: 1 },
      validFrom: null,
      history: [],
      historyPagination: { page: 1, perPage: 1, total: 0, pages: 0 },
      scheduled: null,
      latestApproved: null,
      cancellable: false
    })),
    pagination: { page: 1, perPage: 25, total: 3, pages: 1 },
    pricingInstant: '2026-10-09T18:00:00Z',
    referenceEvidence: 'available_approved_windows_only',
    limits: { itemsPerPageMax: 500, historyPerPageMax: 100, returnedVersionRecordsMax: 5000 }
  })
}
let owner: {
    ready: Ref<boolean>
    loggedIn: Ref<boolean>
    user: Ref<{ id: string; emailVerified: boolean; mfaVerified: boolean }>
    session: Ref<{ sessionId: string; sessionVersion: number }>
  },
  caps: Ref<AdminCapabilities>
const mounted: Awaited<ReturnType<typeof mountSuspended>>[] = []
async function render(runtime = 'cloudflare') {
  const wrapper = await mountSuspended(Panel, { props: { productId: 1, runtime } })
  mounted.push(wrapper)
  await flushPromises()
  return wrapper
}
async function pick(wrapper: Awaited<ReturnType<typeof mountSuspended>>) {
  await wrapper.get('[data-relation-query]').setValue('Destino')
  await wrapper.get('[data-relation-search]').trigger('submit')
  await flushPromises()
  await wrapper.get('[data-relation-pick="2"]').trigger('click')
}
async function review(wrapper: Awaited<ReturnType<typeof mountSuspended>>) {
  await pick(wrapper)
  await wrapper.get('[data-relation-kind]').setValue('accessory')
  await wrapper.get('[data-relation-add]').trigger('click')
  await wrapper.get('[data-relation-reason]').setValue('Revisión documental sintética de la relación')
  await wrapper.get('[data-relation-reference]').setValue('REVIEW-SYNTHETIC-10')
  await wrapper.get('[data-relation-review]').trigger('submit')
  await vi.waitFor(() => expect(wrapper.find('[data-relation-confirm]').exists()).toBe(true))
}
const posts = () => mocks.request.mock.calls.filter(([, options]) => options?.method === 'POST')
function deferred() {
  let resolve!: (value: unknown) => void
  const promise = new Promise<unknown>((yes) => {
    resolve = yes
  })
  return { resolve, promise }
}
beforeEach(() => {
  owner = {
    ready: ref(true),
    loggedIn: ref(true),
    user: ref({ id: ACTOR, emailVerified: true, mfaVerified: true }),
    session: ref({ sessionId: SESSION, sessionVersion: 1 })
  }
  caps = ref({
    source: 'cloudflare',
    identityId: ACTOR,
    sessionId: SESSION,
    sessionVersion: 1,
    state: 'ready',
    permissions: ['catalog.write']
  })
  mocks.owner = owner
  mocks.nav = { capabilities: caps, status: ref('ready') }
  mocks.request.mockReset().mockImplementation(async (path) => (path === '/api/admin/prices' ? prices() : snapshot()))
})
afterEach(() => {
  mounted.splice(0).forEach((wrapper) => wrapper.unmount())
  vi.restoreAllMocks()
})

it('loads the authorized source snapshot version zero without creating a command', async () => {
  const wrapper = await render()
  expect(mocks.request).toHaveBeenCalledWith(ROOT, expect.objectContaining({ retry: 0 }))
  expect(wrapper.text()).toContain('Sin relaciones configuradas')
  expect(wrapper.text()).toContain('no confirma compatibilidad química')
  expect(posts()).toHaveLength(0)
})
it('uses the real product picker, deduplicates variants by product and omits the origin', async () => {
  const wrapper = await render()
  await pick(wrapper)
  expect(wrapper.findAll('[data-relation-pick="2"]')).toHaveLength(1)
  expect(wrapper.find('[data-relation-pick="1"]').exists()).toBe(false)
  expect(
    wrapper
      .get('[data-relation-kind]')
      .findAll('option')
      .map((option) => option.attributes('value'))
  ).toEqual(['substitute', 'compatible', 'accessory', 'equivalent'])
  expect(posts()).toHaveLength(0)
})
it('freezes the reviewed directed snapshot and sends only after explicit confirmation with UUID/key', async () => {
  const wrapper = await render()
  await review(wrapper)
  expect(posts()).toHaveLength(0)
  mocks.request.mockRejectedValue(new Error('response lost'))
  await wrapper.get('[data-relation-confirm]').trigger('click')
  await vi.waitFor(() => expect(posts()).toHaveLength(1))
  const [path, options] = posts()[0]!
  expect(path).toBe(`${ROOT}/commands`)
  expect(options.body).toEqual({
    expectedVersion: 0,
    relations: [{ targetProductId: 2, kind: 'accessory' }],
    reason: 'Revisión documental sintética de la relación',
    reviewReference: 'REVIEW-SYNTHETIC-10'
  })
  expect(options.headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/)
  expect(options.retry).toBe(0)
  expect(wrapper.text()).toContain('incierto')
})
it('does not allow an empty manual review reference to produce a confirmation or POST', async () => {
  const wrapper = await render()
  await pick(wrapper)
  await wrapper.get('[data-relation-add]').trigger('click')
  await wrapper.get('[data-relation-reason]').setValue('Revisión documental sintética')
  await wrapper.get('[data-relation-review]').trigger('submit')
  await flushPromises()
  expect(wrapper.find('[data-relation-confirm]').exists()).toBe(false)
  expect(wrapper.text()).toContain('referencia de revisión')
  expect(posts()).toHaveLength(0)
})
it('confirms only a correlated command receipt plus the fresh persisted snapshot', async () => {
  const wrapper = await render()
  await review(wrapper)
  mocks.request.mockImplementation(async (path, options) => {
    if (options?.method === 'POST')
      return catalogRelationsReceiptSchema.parse({
        source: 'cloudflare',
        commandId: options.headers['Idempotency-Key'],
        productId: 1,
        expectedVersion: 0,
        version: 1,
        payloadHash: await catalogRelationsIntentHash(1, options.body),
        recordedAt: '2026-10-09T18:00:00Z'
      })
    return snapshot(1, [{ targetProductId: 2, kind: 'accessory' }])
  })
  await wrapper.get('[data-relation-confirm]').trigger('click')
  await vi.waitFor(() => expect(wrapper.text()).toContain('Relaciones confirmadas'))
  expect(posts()).toHaveLength(1)
  expect(wrapper.find('[data-relation-check]').exists()).toBe(false)
})
it('keeps an unknown command frozen for manual lookup and never auto-reposts', async () => {
  const wrapper = await render()
  await review(wrapper)
  mocks.request.mockRejectedValueOnce(new Error('response lost'))
  await wrapper.get('[data-relation-confirm]').trigger('click')
  await vi.waitFor(() => expect(wrapper.text()).toContain('incierto'))
  const original = posts()[0]![1]
  mocks.request.mockResolvedValue({ source: 'cloudflare', outcome: 'unknown', receipt: null })
  await wrapper.get('[data-relation-check]').trigger('click')
  await flushPromises()
  expect(mocks.request).toHaveBeenCalledWith(
    `${ROOT}/commands/${original.headers['Idempotency-Key']}`,
    expect.objectContaining({
      headers: { 'X-Neteco-Command-Payload-Hash': await catalogRelationsIntentHash(1, original.body) },
      retry: 0
    })
  )
  expect(wrapper.text()).toContain('incierto')
  expect(posts()).toHaveLength(1)
})
it.each(['malformed', 'foreign-receipt', 'fresh-outage'])(
  'never confirms %s and retains the original intent',
  async (mode) => {
    const wrapper = await render()
    await review(wrapper)
    mocks.request.mockImplementation(async (_path, options) => {
      if (options?.method !== 'POST') throw new Error('private fresh read error')
      if (mode === 'malformed') return { source: 'cloudflare' }
      return {
        source: 'cloudflare',
        commandId: options.headers['Idempotency-Key'],
        productId: mode === 'foreign-receipt' ? 9 : 1,
        expectedVersion: 0,
        version: 1,
        payloadHash: await catalogRelationsIntentHash(1, options.body),
        recordedAt: '2026-10-09T18:00:00Z'
      }
    })
    await wrapper.get('[data-relation-confirm]').trigger('click')
    await vi.waitFor(() => expect(wrapper.text()).toContain('incierto'))
    expect(wrapper.text()).not.toContain('Relaciones confirmadas')
    expect(wrapper.text()).not.toContain('private fresh')
    expect(wrapper.find('[data-relation-check]').exists()).toBe(true)
    expect(posts()).toHaveLength(1)
  }
)
it.each(['email', 'session', 'grant'])('purges drafts and rejects late reads after %s revocation', async (mode) => {
  const pending = deferred()
  mocks.request.mockReturnValue(pending.promise)
  const wrapper = await render()
  if (mode === 'email') owner.user.value.emailVerified = false
  else if (mode === 'session') owner.session.value.sessionVersion++
  else caps.value.permissions = []
  pending.resolve(snapshot(1, [{ targetProductId: 2, kind: 'accessory' }]))
  await flushPromises()
  expect(wrapper.find('[data-relation-review]').exists()).toBe(false)
  expect(wrapper.text()).not.toContain('Destino real')
  expect(posts()).toHaveLength(0)
})
it('does not treat failed source reads as an empty editable snapshot', async () => {
  mocks.request.mockRejectedValue(new Error('private SQL error'))
  const wrapper = await render()
  expect(wrapper.find('[role="alert"]').exists()).toBe(true)
  expect(wrapper.text()).not.toContain('Sin relaciones configuradas')
  expect(wrapper.find('[data-relation-review]').exists()).toBe(false)
  expect(posts()).toHaveLength(0)
})
it('does not call D1 or expose the editor in the Node branch', async () => {
  const wrapper = await render('node')
  expect(mocks.request).not.toHaveBeenCalled()
  expect(wrapper.find('[data-relation-review]').exists()).toBe(false)
})
