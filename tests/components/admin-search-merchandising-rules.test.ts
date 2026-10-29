import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { ref, type Ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AdminSearchMerchandisingRules from '../../app/components/AdminSearchMerchandisingRules.vue'
import AdminBusquedaPage from '../../app/pages/admin/busqueda.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  session: { value: null as unknown },
  navigation: { value: null as unknown },
  runtime: { value: 'cloudflare' as unknown }
}))
vi.mock('../../app/composables/useAdminNavigation', () => ({ useAdminNavigation: () => mocks.navigation.value }))
mockNuxtImport('useRequestFetch', () => () => mocks.request)
mockNuxtImport('useUserSession', () => () => mocks.session.value)
mockNuxtImport('useRuntimeConfig', () => () => ({
  app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
  public: { serverRuntime: mocks.runtime.value }
}))
mockNuxtImport('useFetch', () => async () => ({
  data: ref({ items: [] }),
  refresh: vi.fn(),
  status: ref('success')
}))

const ACTOR_ID = 'a0500000-0000-4000-8000-000000000001'
const SESSION_ID = 'a0500000-0000-4000-8000-000000000002'
const RULE_LIVE_ID = 'b0500000-0000-4000-8000-000000000001'
const RULE_SCHEDULED_ID = 'b0500000-0000-4000-8000-000000000002'
const RULE_EXPIRED_ID = 'b0500000-0000-4000-8000-000000000003'
const RULE_RETIRED_ID = 'b0500000-0000-4000-8000-000000000004'
const PRODUCT_A = 'c0500000-0000-4000-8000-000000000001'
const PRODUCT_B = 'c0500000-0000-4000-8000-000000000002'
const COMMAND_ID = 'd0500000-0000-4000-8000-000000000001'

const liveRule = {
  id: RULE_LIVE_ID,
  term: 'lejía neutra',
  termNormalized: 'lejia neutra',
  kind: 'boost' as const,
  productId: PRODUCT_A,
  weight: 6,
  redirectPath: null,
  reason: 'Campaña de desinfección Q4',
  validFrom: '2026-10-01T00:00:00Z',
  validUntil: '2026-12-01T00:00:00Z',
  status: 'active' as const,
  state: 'live' as const,
  authorId: ACTOR_ID,
  version: 1,
  updatedAt: '2026-10-01T00:00:00Z'
}

const scheduledRule = {
  id: RULE_SCHEDULED_ID,
  term: 'desengrasante industrial',
  termNormalized: 'desengrasante industrial',
  kind: 'bury' as const,
  productId: PRODUCT_B,
  weight: 3,
  redirectPath: null,
  reason: 'Fin de lote antiguo programado',
  validFrom: '2026-11-15T00:00:00Z',
  validUntil: '2027-01-15T00:00:00Z',
  status: 'active' as const,
  state: 'scheduled' as const,
  authorId: ACTOR_ID,
  version: 2,
  updatedAt: '2026-10-15T10:00:00Z'
}

const expiredRule = {
  id: RULE_EXPIRED_ID,
  term: 'gel hidroalcohólico',
  termNormalized: 'gel hidroalcoholico',
  kind: 'boost' as const,
  productId: PRODUCT_A,
  weight: 4,
  redirectPath: null,
  reason: 'Promoción de verano finalizada',
  validFrom: '2026-06-01T00:00:00Z',
  validUntil: '2026-09-01T00:00:00Z',
  status: 'active' as const,
  state: 'expired' as const,
  authorId: ACTOR_ID,
  version: 1,
  updatedAt: '2026-06-01T00:00:00Z'
}

const retiredRule = {
  id: RULE_RETIRED_ID,
  term: 'catálogo hostelería',
  termNormalized: 'catalogo hosteleria',
  kind: 'redirect' as const,
  productId: null,
  weight: null,
  redirectPath: '/catalogo?sector=hosteleria',
  reason: 'Redirección retirada tras cambio de campaña',
  validFrom: '2026-08-01T00:00:00Z',
  validUntil: '2026-11-01T00:00:00Z',
  status: 'retired' as const,
  state: 'retired' as const,
  authorId: ACTOR_ID,
  version: 3,
  updatedAt: '2026-09-10T12:00:00Z'
}

const listPayload = (items = [liveRule, scheduledRule, expiredRule, retiredRule], extra = {}) => ({
  source: 'cloudflare' as const,
  items,
  total: items.length,
  page: 1,
  perPage: 25,
  ...extra
})

function buildReceipt(body: Record<string, unknown>, baseItem = liveRule, extra = {}) {
  const isRetire = body.action === 'retire'
  const version = Number(body.expectedVersion ?? 0) + 1
  const snapshot = isRetire
    ? {
        id: String(body.id ?? baseItem.id),
        term: baseItem.term,
        termNormalized: baseItem.termNormalized,
        kind: baseItem.kind,
        productId: baseItem.productId,
        weight: baseItem.weight,
        redirectPath: baseItem.redirectPath,
        reason: String(body.reason),
        validFrom: baseItem.validFrom,
        validUntil: baseItem.validUntil,
        status: 'retired' as const,
        authorId: ACTOR_ID,
        version,
        updatedAt: '2026-10-29T10:00:00Z'
      }
    : {
        id: String(body.id ?? RULE_LIVE_ID),
        term: String(body.term).trim().replace(/\s+/gu, ' '),
        termNormalized: String(body.term)
          .normalize('NFD')
          .replace(/\p{M}/gu, '')
          .toLowerCase()
          .trim()
          .replace(/\s+/gu, ' '),
        kind: body.kind as 'boost' | 'bury' | 'redirect',
        productId: (body.productId as string | null) ?? null,
        weight: (body.weight as number | null) ?? null,
        redirectPath: (body.redirectPath as string | null) ?? null,
        reason: String(body.reason).trim(),
        validFrom: String(body.validFrom),
        validUntil: String(body.validUntil),
        status: 'active' as const,
        authorId: ACTOR_ID,
        version,
        updatedAt: '2026-10-29T10:00:00Z'
      }
  return {
    source: 'cloudflare' as const,
    commandId: COMMAND_ID,
    action: body.action as 'save' | 'retire',
    item: snapshot,
    ...extra
  }
}

const mounted: Array<{ unmount: () => void }> = []
let session: {
  ready: Ref<boolean>
  loggedIn: Ref<boolean>
  user: Ref<Record<string, unknown>>
  session: Ref<Record<string, unknown>>
}
let capabilities: Ref<Record<string, unknown>>

beforeEach(() => {
  mocks.runtime.value = 'cloudflare'
  session = {
    ready: ref(true),
    loggedIn: ref(true),
    user: ref({ id: ACTOR_ID, role: 'admin', emailVerified: true, mfaVerified: true }),
    session: ref({ sessionId: SESSION_ID, sessionVersion: 1 })
  }
  capabilities = ref({
    source: 'cloudflare',
    identityId: ACTOR_ID,
    sessionId: SESSION_ID,
    sessionVersion: 1,
    state: 'ready',
    permissions: ['catalog.write']
  })
  mocks.navigation.value = { capabilities, status: ref('ready') }
  mocks.session.value = session
  mocks.request.mockReset().mockImplementation(async (path: string) => {
    if (path === '/api/admin/search-synonyms') {
      return { source: 'cloudflare', items: [], total: 0, page: 1, perPage: 25 }
    }
    return listPayload()
  })
})

const hosts: HTMLElement[] = []

afterEach(() => {
  mounted.splice(0).forEach((wrapper) => wrapper.unmount())
  hosts.splice(0).forEach((host) => host.remove())
  vi.restoreAllMocks()
})

async function render(runtime: unknown = 'cloudflare', attached = false) {
  mocks.runtime.value = runtime
  const attachTo = attached ? document.createElement('div') : undefined
  if (attachTo) {
    document.body.append(attachTo)
    hosts.push(attachTo)
  }
  const wrapper = await mountSuspended(AdminSearchMerchandisingRules, { props: { runtime }, attachTo })
  mounted.push(wrapper)
  await flushPromises()
  return wrapper
}

/** UTC instant in the server's `YYYY-MM-DDTHH:MM:SSZ` shape, relative to the real clock. */
function isoFromNow(days: number) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

describe('governed search merchandising rules UI (SEA-013)', () => {
  it('authorizes via live catalog.write + verified email + MFA, never via role labels or non-cloudflare runtimes', async () => {
    session.user.value = { ...session.user.value, role: 'catalog_editor' }
    const wrapper = await render()
    expect(wrapper.find('[data-merchandising-create]').exists()).toBe(true)
    expect(mocks.request).toHaveBeenCalledWith(
      '/api/admin/search-merchandising',
      expect.objectContaining({ method: 'GET', cache: 'no-store' })
    )

    mocks.request.mockClear()
    capabilities.value = { ...capabilities.value, permissions: ['support.manage'] }
    await flushPromises()
    expect(wrapper.find('[data-merchandising-create]').exists()).toBe(false)
    expect(wrapper.get('[role="alert"]').text()).toContain('MFA')
    expect(mocks.request).not.toHaveBeenCalled()

    for (const runtime of ['node', 'unknown']) {
      mocks.request.mockClear()
      await render(runtime)
      expect(mocks.request).not.toHaveBeenCalled()
    }
  })

  it('lists active, scheduled, expired and retired rules with distinct badges and keeps error/empty states separate', async () => {
    const wrapper = await render()
    const listText = wrapper.get('[data-merchandising-list]').text()
    expect(listText).toContain('lejía neutra')
    expect(listText).toContain('Activa')
    expect(listText).toContain('desengrasante industrial')
    expect(listText).toContain('Programada')
    expect(listText).toContain('gel hidroalcohólico')
    expect(listText).toContain('Caducada')
    expect(listText).toContain('catálogo hostelería')
    expect(listText).toContain('Retirada')
    expect(listText).toContain('/catalogo?sector=hosteleria')

    // Retired rule has no edit or retire buttons, only history
    const retiredRow = wrapper.get(`[data-merchandising-row="${RULE_RETIRED_ID}"]`)
    expect(retiredRow.find('[data-merchandising-edit]').exists()).toBe(false)
    expect(retiredRow.find('[data-merchandising-retire]').exists()).toBe(false)
    expect(retiredRow.find('[data-merchandising-history-open]').exists()).toBe(true)

    // Failed read is distinct from empty list and supports retry
    mocks.request.mockRejectedValueOnce(new Error('network_down'))
    await wrapper.get('[data-merchandising-search-form]').trigger('submit')
    await flushPromises()
    expect(wrapper.text()).toContain('No se ha podido confirmar la lista')
    expect(wrapper.text()).not.toContain('No hay reglas')
    mocks.request.mockResolvedValueOnce(listPayload([]))
    await wrapper.get('[data-merchandising-read-retry]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('No hay reglas')
  })

  it('filters by query and status, paginates, rejects malformed DTOs and keeps the latest read on out-of-order responses', async () => {
    const wrapper = await render()
    const slow = deferred<unknown>()
    mocks.request.mockReturnValueOnce(slow.promise)
    await wrapper.get('[data-merchandising-search]').setValue('viejo')
    await wrapper.get('[data-merchandising-search-form]').trigger('submit')

    mocks.request.mockResolvedValueOnce(listPayload([liveRule], { total: 30, page: 1 }))
    await wrapper.get('[data-merchandising-search]').setValue('lejía')
    await wrapper.get('[data-merchandising-status-filter]').setValue('open')
    await wrapper.get('[data-merchandising-search-form]').trigger('submit')
    await flushPromises()
    expect(mocks.request.mock.calls.at(-1)![1].query).toEqual({
      page: 1,
      perPage: 25,
      q: 'lejía',
      status: 'open'
    })

    // Resolve earlier slow request with different data; must be ignored
    slow.resolve(listPayload([scheduledRule]))
    await flushPromises()
    expect(wrapper.text()).toContain('lejía neutra')
    expect(wrapper.text()).not.toContain('desengrasante industrial')

    // Pagination next page
    mocks.request.mockResolvedValueOnce(listPayload([scheduledRule], { total: 30, page: 2 }))
    await wrapper.get('[data-merchandising-next]').trigger('click')
    await flushPromises()
    expect(mocks.request.mock.calls.at(-1)![1].query.page).toBe(2)

    // Malformed DTO is rejected
    mocks.request.mockResolvedValueOnce({ ...listPayload(), injected: true })
    await wrapper.get('[data-merchandising-prev]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('No se ha podido confirmar la lista')
  })

  it('creates boost/bury and redirect rules, explains mandatory reason and max 180-day expiry, and mirrors server validation', async () => {
    const wrapper = await render()
    await wrapper.get('[data-merchandising-create]').trigger('click')
    expect(wrapper.text()).toContain('180 días')
    expect(wrapper.text()).toContain('motivo')

    // Client validation blocks invalid expiry (> 180 days) and invalid redirect paths before any network call
    const beforeCalls = mocks.request.mock.calls.length
    await wrapper.get('[data-merchandising-term]').setValue('cloro choque')
    await wrapper.get('[data-merchandising-kind]').setValue('boost')
    await wrapper.get('[data-merchandising-product-id]').setValue(PRODUCT_A)
    await wrapper.get('[data-merchandising-weight]').setValue('5')
    await wrapper.get('[data-merchandising-valid-from]').setValue('2026-10-01T00:00:00Z')
    await wrapper.get('[data-merchandising-valid-until]').setValue('2027-06-01T00:00:00Z') // > 180 days
    await wrapper.get('[data-merchandising-reason]').setValue('Campaña demasiado larga')
    await wrapper.get('[data-merchandising-form]').trigger('submit')
    await flushPromises()
    expect(mocks.request).toHaveBeenCalledTimes(beforeCalls)
    expect(wrapper.text()).toContain('180 días')

    // Client validation blocks external or disallowed redirect paths
    await wrapper.get('[data-merchandising-kind]').setValue('redirect')
    await wrapper.get('[data-merchandising-valid-until]').setValue('2026-12-01T00:00:00Z')
    await wrapper.get('[data-merchandising-redirect-path]').setValue('https://evil.example/phish')
    await wrapper.get('[data-merchandising-form]').trigger('submit')
    await flushPromises()
    expect(mocks.request).toHaveBeenCalledTimes(beforeCalls)
    expect(wrapper.text()).toContain('ruta interna permitida')

    // Valid redirect creation sends POST with null productId/weight and Idempotency-Key
    const validRedirectBody = {
      action: 'save',
      id: null,
      expectedVersion: 0,
      term: 'cloro choque',
      kind: 'redirect',
      productId: null,
      weight: null,
      redirectPath: '/catalogo?familia=cloro',
      reason: 'Redirección aprobada para campaña de piscina',
      validFrom: '2026-10-01T00:00:00Z',
      validUntil: '2026-12-01T00:00:00Z'
    }
    mocks.request.mockImplementationOnce(async (_path: string, options: { body: Record<string, unknown> }) =>
      buildReceipt(options.body)
    )
    mocks.request.mockResolvedValueOnce(listPayload())
    await wrapper.get('[data-merchandising-redirect-path]').setValue('/catalogo?familia=cloro')
    await wrapper.get('[data-merchandising-reason]').setValue('Redirección aprobada para campaña de piscina')
    await wrapper.get('[data-merchandising-form]').trigger('submit')
    await flushPromises()

    const postCall = mocks.request.mock.calls.find(([, opts]) => opts?.method === 'POST')!
    expect(postCall[0]).toBe('/api/admin/search-merchandising')
    expect(postCall[1].body).toEqual(validRedirectBody)
    expect(postCall[1].headers['Idempotency-Key']).toMatch(/^[A-Za-z0-9._:-]{1,200}$/)
    expect(wrapper.text()).toContain('Recibo confirmado')
  })

  it('edits with CAS, displays a visible 409 version conflict alert, and reloads the fresh version on demand', async () => {
    const wrapper = await render()
    const liveRow = wrapper.get(`[data-merchandising-row="${RULE_LIVE_ID}"]`)
    await liveRow.get('[data-merchandising-edit]').trigger('click')

    await wrapper.get('[data-merchandising-weight]').setValue('9')
    await wrapper.get('[data-merchandising-reason]').setValue('Ajuste de peso comercial')

    // First attempt returns 409 version_conflict
    mocks.request.mockRejectedValueOnce({
      statusCode: 409,
      data: { error: { code: 'version_conflict' } }
    })
    await wrapper.get('[data-merchandising-form]').trigger('submit')
    await flushPromises()

    const conflictAlert = wrapper.get('[data-merchandising-conflict]')
    expect(conflictAlert.text()).toContain('conflicto de versión')

    // Clicking reload fetches the fresh rule (now version 4, weight 8) and refreshes the list
    const fresherRule = { ...liveRule, version: 4, weight: 8, reason: 'Cambio de otro operador' }
    mocks.request.mockImplementationOnce(async (path: string) => {
      expect(path).toBe(`/api/admin/search-merchandising/${RULE_LIVE_ID}`)
      return { item: fresherRule }
    })
    mocks.request.mockResolvedValueOnce(listPayload([fresherRule, scheduledRule, expiredRule, retiredRule]))

    await wrapper.get('[data-merchandising-conflict-reload]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-merchandising-conflict]').exists()).toBe(false)
    expect((wrapper.get('[data-merchandising-weight]').element as HTMLInputElement).value).toBe('8')

    // Submitting again now uses expectedVersion: 4
    await wrapper.get('[data-merchandising-weight]').setValue('10')
    await wrapper.get('[data-merchandising-reason]').setValue('Ajuste sobre versión 4 recargada')
    mocks.request.mockImplementationOnce(async (_path: string, options: { body: Record<string, unknown> }) =>
      buildReceipt(options.body, fresherRule)
    )
    mocks.request.mockResolvedValueOnce(listPayload([{ ...fresherRule, version: 5, weight: 10 }]))

    await wrapper.get('[data-merchandising-form]').trigger('submit')
    await flushPromises()

    const putCalls = mocks.request.mock.calls.filter(([, opts]) => opts?.method === 'PUT')
    expect(putCalls).toHaveLength(2)
    expect(putCalls[0]![1].body.expectedVersion).toBe(1)
    expect(putCalls[1]![1].body.expectedVersion).toBe(4)
    expect(putCalls[1]![1].body.weight).toBe(10)
    expect(wrapper.text()).toContain('Recibo confirmado')
  })

  it('retires an active rule with explicit confirmation and reason via DELETE', async () => {
    const wrapper = await render()
    const row = wrapper.get(`[data-merchandising-row="${RULE_LIVE_ID}"]`)
    await row.get('[data-merchandising-retire]').trigger('click')

    expect(wrapper.find('[data-merchandising-form]').exists()).toBe(true)
    expect(wrapper.text()).toContain('Retirar regla')

    await wrapper.get('[data-merchandising-reason]').setValue('Fin anticipado de campaña')
    mocks.request.mockImplementationOnce(async (_path: string, options: { body: Record<string, unknown> }) =>
      buildReceipt(options.body, liveRule)
    )
    mocks.request.mockResolvedValueOnce(listPayload([{ ...liveRule, status: 'retired', state: 'retired', version: 2 }]))

    await wrapper.get('[data-merchandising-form]').trigger('submit')
    await flushPromises()

    const deleteCall = mocks.request.mock.calls.find(([, opts]) => opts?.method === 'DELETE')!
    expect(deleteCall[0]).toBe(`/api/admin/search-merchandising/${RULE_LIVE_ID}`)
    expect(deleteCall[1].body).toEqual({
      action: 'retire',
      id: RULE_LIVE_ID,
      expectedVersion: 1,
      reason: 'Fin anticipado de campaña'
    })
    expect(wrapper.text()).toContain('Recibo confirmado')
  })

  it('loads and displays rule revision history with retry on failure', async () => {
    const wrapper = await render()
    const row = wrapper.get(`[data-merchandising-row="${RULE_RETIRED_ID}"]`)

    mocks.request.mockRejectedValueOnce(new Error('history_offline'))
    await row.get('[data-merchandising-history-open]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-merchandising-history]').text()).toContain('No se ha podido cargar el historial')

    mocks.request.mockResolvedValueOnce({
      source: 'cloudflare',
      items: [
        { ...retiredRule, version: 1, status: 'active', state: 'live', reason: 'Alta inicial de redirección' },
        { ...retiredRule, version: 2, status: 'active', state: 'live', reason: 'Ampliación de vigencia' },
        retiredRule
      ]
    })
    await wrapper.get('[data-merchandising-history-retry]').trigger('click')
    await flushPromises()

    const historyText = wrapper.get('[data-merchandising-history]').text()
    expect(historyText).toContain('Versión 1')
    expect(historyText).toContain('Alta inicial de redirección')
    expect(historyText).toContain('Versión 2')
    expect(historyText).toContain('Ampliación de vigencia')
    expect(historyText).toContain('Versión 3')
    expect(historyText).toContain('Redirección retirada tras cambio de campaña')

    await wrapper.get('[data-merchandising-history-close]').trigger('click')
    expect(wrapper.find('[data-merchandising-history]').exists()).toBe(false)
  })

  it('prevents double submit and recovers uncertain commands via receipt lookup before allowing exact same-key retry', async () => {
    const wrapper = await render()
    await wrapper.get(`[data-merchandising-row="${RULE_LIVE_ID}"] [data-merchandising-edit]`).trigger('click')
    await wrapper.get('[data-merchandising-weight]').setValue('7')
    await wrapper.get('[data-merchandising-reason]').setValue('Ajuste con red inestable')

    const inFlight = deferred<unknown>()
    mocks.request.mockReturnValueOnce(inFlight.promise)
    await wrapper.get('[data-merchandising-form]').trigger('submit')
    await wrapper.get('[data-merchandising-form]').trigger('submit')

    const writeCalls = mocks.request.mock.calls.filter(([, opts]) => opts?.method === 'PUT')
    expect(writeCalls).toHaveLength(1)
    const originalCall = writeCalls[0]!

    // Fail with network error -> uncertain state, retry not yet enabled
    inFlight.reject(new Error('socket hang up'))
    await flushPromises()
    expect(wrapper.find('[data-merchandising-lookup]').exists()).toBe(true)
    expect(wrapper.find('[data-merchandising-command-retry]').exists()).toBe(false)

    // Lookup returns 404 not_found -> enables exact retry
    mocks.request.mockRejectedValueOnce({ statusCode: 404, data: { error: { code: 'not_found' } } })
    await wrapper.get('[data-merchandising-lookup]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-merchandising-command-retry]').exists()).toBe(true)

    // Retry sends the exact same URL, method, Idempotency-Key and body
    mocks.request.mockImplementationOnce(async (_path: string, options: { body: Record<string, unknown> }) =>
      buildReceipt(options.body, liveRule)
    )
    mocks.request.mockResolvedValueOnce(listPayload([{ ...liveRule, version: 2, weight: 7 }]))
    await wrapper.get('[data-merchandising-command-retry]').trigger('click')
    await flushPromises()

    const retriedCall = mocks.request.mock.calls.filter(([, opts]) => opts?.method === 'PUT')[1]!
    expect(retriedCall).toEqual(originalCall)
    expect(wrapper.text()).toContain('Recibo confirmado')
  })

  it('treats server domain rejections as authoritative, rejects mismatched receipts, and recovers via 200 lookup', async () => {
    const wrapper = await render()
    await wrapper.get('[data-merchandising-create]').trigger('click')
    await wrapper.get('[data-merchandising-term]').setValue('hipoclorito')
    await wrapper.get('[data-merchandising-kind]').setValue('boost')
    await wrapper.get('[data-merchandising-product-id]').setValue(PRODUCT_B)
    await wrapper.get('[data-merchandising-weight]').setValue('4')
    await wrapper.get('[data-merchandising-valid-from]').setValue('2026-10-01T00:00:00Z')
    await wrapper.get('[data-merchandising-valid-until]').setValue('2026-11-01T00:00:00Z')
    await wrapper.get('[data-merchandising-reason]').setValue('Producto en borrador')

    // Server rejects with 409 product_unavailable even though client UUID/fields are syntactically valid
    mocks.request.mockRejectedValueOnce({
      statusCode: 409,
      data: { error: { code: 'product_unavailable' } }
    })
    mocks.request.mockResolvedValueOnce(listPayload())
    await wrapper.get('[data-merchandising-form]').trigger('submit')
    await flushPromises()
    expect(wrapper.text()).toContain('El producto indicado no existe o no está publicado')
    expect(wrapper.text()).not.toContain('Recibo confirmado')

    // Submit again: server returns a mismatched receipt (wrong term) -> enters unknown state
    mocks.request.mockResolvedValueOnce({
      source: 'cloudflare',
      commandId: COMMAND_ID,
      action: 'save',
      item: { ...liveRule, version: 1, term: 'otro termino distinto' }
    })
    await wrapper.get('[data-merchandising-form]').trigger('submit')
    await flushPromises()
    expect(wrapper.text()).not.toContain('Recibo confirmado')
    expect(wrapper.find('[data-merchandising-lookup]').exists()).toBe(true)

    // Lookup fails with network outage -> retry still disabled
    mocks.request.mockRejectedValueOnce(new Error('lookup timeout'))
    await wrapper.get('[data-merchandising-lookup]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-merchandising-command-retry]').exists()).toBe(false)
    expect(wrapper.text()).toContain('sigue desconocido')

    // Lookup succeeds with the valid receipt -> confirms without resending POST
    const sentPost = mocks.request.mock.calls.filter(([, opts]) => opts?.method === 'POST').at(-1)!
    mocks.request.mockResolvedValueOnce(buildReceipt(sentPost[1].body))
    mocks.request.mockResolvedValueOnce(listPayload())
    await wrapper.get('[data-merchandising-lookup]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('Recibo confirmado')
    expect(wrapper.find('[data-merchandising-lookup]').exists()).toBe(false)
  })

  it('closes the form on conflict reload when the rule was retired by another operator and suppresses stale actor/unmount effects', async () => {
    const wrapper = await render()
    await wrapper.get(`[data-merchandising-row="${RULE_LIVE_ID}"] [data-merchandising-edit]`).trigger('click')
    await wrapper.get('[data-merchandising-reason]').setValue('Intento sobre regla ya retirada')
    mocks.request.mockRejectedValueOnce({
      statusCode: 409,
      data: { error: { code: 'version_conflict' } }
    })
    await wrapper.get('[data-merchandising-form]').trigger('submit')
    await flushPromises()
    expect(wrapper.find('[data-merchandising-conflict]').exists()).toBe(true)

    // Reload returns the rule in retired status -> closes form and informs user
    mocks.request.mockResolvedValueOnce({
      item: { ...liveRule, status: 'retired', state: 'retired', version: 3 }
    })
    mocks.request.mockResolvedValueOnce(listPayload([{ ...liveRule, status: 'retired', state: 'retired', version: 3 }]))
    await wrapper.get('[data-merchandising-conflict-reload]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-merchandising-form]').exists()).toBe(false)
    expect(wrapper.text()).toContain('ya fue retirada')

    // Start a new creation and revoke MFA while command is in flight
    await wrapper.get('[data-merchandising-create]').trigger('click')
    await wrapper.get('[data-merchandising-term]').setValue('amoníaco')
    await wrapper.get('[data-merchandising-product-id]').setValue(PRODUCT_A)
    await wrapper.get('[data-merchandising-reason]').setValue('Alta antes de revocación')
    const pending = deferred<unknown>()
    mocks.request.mockReturnValueOnce(pending.promise)
    await wrapper.get('[data-merchandising-form]').trigger('submit')
    const callsBeforeRevoke = mocks.request.mock.calls.length
    const sentBody = mocks.request.mock.calls.at(-1)![1].body

    session.user.value = { ...session.user.value, mfaVerified: false }
    await flushPromises()
    pending.resolve(buildReceipt(sentBody))
    await flushPromises()
    expect(mocks.request).toHaveBeenCalledTimes(callsBeforeRevoke)
    expect(wrapper.text()).not.toContain('Recibo confirmado')
  })

  it('classifies pre-write rejections as known no-effect failures but a forbidden write as uncertain (no automatic resend)', async () => {
    const wrapper = await render()
    await wrapper.get(`[data-merchandising-row="${RULE_LIVE_ID}"] [data-merchandising-edit]`).trigger('click')
    await wrapper.get('[data-merchandising-reason]').setValue('Ajuste de prueba de límites')

    // Rate limiting and abuse-control outages run before the command executes: nothing was applied.
    mocks.request.mockRejectedValueOnce({ statusCode: 429, data: { error: { code: 'rate_limited' } } })
    mocks.request.mockResolvedValueOnce(listPayload())
    await wrapper.get('[data-merchandising-form]').trigger('submit')
    await flushPromises()
    expect(wrapper.text()).toContain('Has superado el límite')
    expect(wrapper.find('[data-merchandising-lookup]').exists()).toBe(false)
    expect(wrapper.find('[data-merchandising-form]').exists()).toBe(true)

    mocks.request.mockRejectedValueOnce({ statusCode: 503, data: { error: { code: 'abuse_control_unavailable' } } })
    mocks.request.mockResolvedValueOnce(listPayload())
    await wrapper.get('[data-merchandising-form]').trigger('submit')
    await flushPromises()
    expect(wrapper.text()).toContain('no se ha aplicado')
    expect(wrapper.find('[data-merchandising-lookup]').exists()).toBe(false)

    // A 403 can be raised after the write was committed (post-insert authority check): uncertain.
    mocks.request.mockRejectedValueOnce({ statusCode: 403, data: { error: { code: 'forbidden' } } })
    await wrapper.get('[data-merchandising-form]').trigger('submit')
    await flushPromises()
    expect(wrapper.find('[data-merchandising-lookup]').exists()).toBe(true)
    expect(wrapper.find('[data-merchandising-command-retry]').exists()).toBe(false)
    expect(wrapper.text()).toContain('Resultado desconocido')

    const puts = mocks.request.mock.calls.filter(([, opts]) => opts?.method === 'PUT')
    expect(puts).toHaveLength(3)
    expect(new Set(puts.map(([, opts]) => opts.headers['Idempotency-Key'])).size).toBe(3)
  })

  it('mirrors the server expiry window against the current instant before any network call', async () => {
    const wrapper = await render()
    await wrapper.get('[data-merchandising-create]').trigger('click')
    await wrapper.get('[data-merchandising-term]').setValue('amoniaco industrial')
    await wrapper.get('[data-merchandising-kind]').setValue('boost')
    await wrapper.get('[data-merchandising-product-id]').setValue(PRODUCT_A)
    await wrapper.get('[data-merchandising-weight]').setValue('3')
    await wrapper.get('[data-merchandising-reason]').setValue('Ventana de vigencia de prueba')
    const before = mocks.request.mock.calls.length

    // Both instants are in the past: the server would reject with expiry_invalid.
    await wrapper.get('[data-merchandising-valid-from]').setValue(isoFromNow(-10))
    await wrapper.get('[data-merchandising-valid-until]').setValue(isoFromNow(-1))
    await wrapper.get('[data-merchandising-form]').trigger('submit')
    await flushPromises()
    expect(wrapper.text()).toContain('posterior a este momento')
    expect(mocks.request.mock.calls.length).toBe(before)

    // Span is valid (179.5 days) but the end is beyond the server's now + 180 days limit.
    await wrapper.get('[data-merchandising-valid-from]').setValue(isoFromNow(1))
    await wrapper.get('[data-merchandising-valid-until]').setValue(isoFromNow(180.5))
    await wrapper.get('[data-merchandising-form]').trigger('submit')
    await flushPromises()
    expect(wrapper.text()).toContain('180 días desde ahora')
    expect(mocks.request.mock.calls.length).toBe(before)
  })

  it('moves keyboard focus into the rule form when it opens for create, edit and retire', async () => {
    const wrapper = await render('cloudflare', true)
    await wrapper.get('[data-merchandising-create]').trigger('click')
    await flushPromises()
    expect(document.activeElement).toBe(wrapper.get('[data-merchandising-term]').element)

    await wrapper.get(`[data-merchandising-row="${RULE_LIVE_ID}"] [data-merchandising-edit]`).trigger('click')
    await flushPromises()
    expect(document.activeElement).toBe(wrapper.get('[data-merchandising-term]').element)

    await wrapper.get(`[data-merchandising-row="${RULE_LIVE_ID}"] [data-merchandising-retire]`).trigger('click')
    await flushPromises()
    expect(document.activeElement).toBe(wrapper.get('[data-merchandising-reason]').element)
  })

  it('mounts inside app/pages/admin/busqueda.vue alongside synonyms under Reglas de resultados', async () => {
    const pageWrapper = await mountSuspended(AdminBusquedaPage)
    mounted.push(pageWrapper)
    await flushPromises()
    expect(pageWrapper.find('section[aria-label="Sinónimos de búsqueda"]').exists()).toBe(true)
    expect(pageWrapper.find('section[aria-label="Reglas de resultados"]').exists()).toBe(true)
    expect(pageWrapper.text()).toContain('Reglas de resultados')
    expect(pageWrapper.find('[data-merchandising-create]').exists()).toBe(true)
  })
})
