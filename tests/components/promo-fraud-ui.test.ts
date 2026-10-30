import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AdminPromoFraudCases from '../../app/components/AdminPromoFraudCases.vue'
import AccountPromoFraudAppeals from '../../app/components/AccountPromoFraudAppeals.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  session: vi.fn(),
  runtime: vi.fn(() => ({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'cloudflare' }
  }))
}))
mockNuxtImport('useRequestFetch', () => () => mocks.request)
mockNuxtImport('useRuntimeConfig', () => mocks.runtime)
mockNuxtImport('useUserSession', () => mocks.session)

const CASE_ID = 'c0600000-0000-4000-8000-000000000001'
const holdCase = {
  id: CASE_ID,
  context: 'referral',
  refId: 'attr-77',
  customerId: 'cust-4',
  decision: 'hold',
  score: 50,
  exceededKinds: ['device', 'payment'],
  status: 'open',
  version: 1,
  decidedBy: null,
  decidedAt: null,
  decisionNote: null,
  createdAt: '2026-10-29T10:00:00Z',
  updatedAt: '2026-10-29T10:00:00Z',
  appealStatus: null
}
const detail = (extra = {}) => ({
  case: { ...holdCase, ...extra },
  events: [{ action: 'assessed', actorIdentityId: null, detail: {}, createdAt: '2026-10-29T10:00:00Z' }],
  appeal: null
})
let auth: {
  ready: ReturnType<typeof ref<boolean>>
  loggedIn: ReturnType<typeof ref<boolean>>
  user: ReturnType<typeof ref<{ id: string; emailVerified: boolean } | null>>
  session: ReturnType<typeof ref<{ sessionId: string; sessionVersion: number } | null>>
}
type Wrapper = Awaited<ReturnType<typeof mountSuspended>>
const wrappers: Wrapper[] = []
async function mount(component: typeof AdminPromoFraudCases | typeof AccountPromoFraudAppeals) {
  const wrapper = await mountSuspended(component)
  wrappers.push(wrapper)
  await flushPromises()
  return wrapper
}
beforeEach(() => {
  mocks.request.mockReset()
  auth = {
    ready: ref(true),
    loggedIn: ref(true),
    user: ref({ id: '71000000-0000-4000-8000-000000000001', emailVerified: true }),
    session: ref({ sessionId: '72000000-0000-4000-8000-000000000001', sessionVersion: 1 })
  }
  mocks.session.mockReturnValue(auth)
})
afterEach(() => wrappers.splice(0).forEach((w) => w.unmount()))

describe('SEC-036 admin review queue UI', () => {
  it('shows loading, then the queue with decision, score and the exceeded signal kinds', async () => {
    let release!: (v: unknown) => void
    mocks.request.mockReturnValueOnce(new Promise((resolve) => (release = resolve)))
    const w = await mount(AdminPromoFraudCases)
    expect(w.find('[data-pf-loading]').exists()).toBe(true)
    release({ items: [holdCase] })
    await flushPromises()
    expect(mocks.request).toHaveBeenCalledWith(
      '/api/admin/promo-fraud/cases',
      expect.objectContaining({ query: { filter: 'pending' } })
    )
    const row = w.get(`[data-pf-case="${CASE_ID}"]`).text()
    expect(row).toContain('Retenida')
    expect(row).toContain('50')
    expect(row).toContain('dispositivo')
    expect(row).toContain('pago')
  })
  it('explains the empty queue', async () => {
    mocks.request.mockResolvedValueOnce({ items: [] })
    const w = await mount(AdminPromoFraudCases)
    expect(w.get('[data-pf-empty]').text()).toContain('No hay casos')
  })
  it('shows a readable error and a retry when loading fails', async () => {
    mocks.request.mockRejectedValueOnce({ statusCode: 403, data: { error: { code: 'forbidden' } } })
    const w = await mount(AdminPromoFraudCases)
    expect(w.get('[data-pf-error]').text()).toContain('permiso')
    mocks.request.mockResolvedValueOnce({ items: [holdCase] })
    await w.get('[data-pf-retry]').trigger('click')
    await flushPromises()
    expect(w.find(`[data-pf-case="${CASE_ID}"]`).exists()).toBe(true)
  })
  it('does nothing for anonymous sessions', async () => {
    auth.loggedIn.value = false
    const w = await mount(AdminPromoFraudCases)
    expect(mocks.request).not.toHaveBeenCalled()
    expect(w.find('[data-pf-list]').exists()).toBe(false)
  })
  it('opens a case and releases it with the displayed version and a mandatory note', async () => {
    mocks.request.mockResolvedValueOnce({ items: [holdCase] }).mockResolvedValueOnce(detail())
    const w = await mount(AdminPromoFraudCases)
    await w.get(`[data-pf-open="${CASE_ID}"]`).trigger('click')
    await flushPromises()
    expect(mocks.request).toHaveBeenLastCalledWith(`/api/admin/promo-fraud/cases/${CASE_ID}`, expect.anything())
    expect(w.get('[data-pf-detail]').text()).toContain('assessed')
    expect(w.get('[data-pf-release]').attributes('disabled')).toBeDefined()
    await w.get('[data-pf-note]').setValue('Verificado: misma familia')
    mocks.request
      .mockResolvedValueOnce({ case: { ...holdCase, status: 'released', version: 2 } })
      .mockResolvedValueOnce({ items: [] })
    await w.get('[data-pf-release]').trigger('click')
    await flushPromises()
    const call = mocks.request.mock.calls.find(([path]) => String(path).endsWith('/decision'))!
    expect(call[0]).toBe(`/api/admin/promo-fraud/cases/${CASE_ID}/decision`)
    expect(call[1]).toMatchObject({
      method: 'POST',
      body: { expectedVersion: 1, outcome: 'release', note: 'Verificado: misma familia' }
    })
    expect(w.get('[data-pf-notice]').text()).toContain('liberada')
  })
  it('stays usable after a decision: the next case can be decided without reloading the page', async () => {
    const second = { ...holdCase, id: 'c0600000-0000-4000-8000-000000000002', refId: 'attr-78' }
    mocks.request.mockResolvedValueOnce({ items: [holdCase, second] }).mockResolvedValueOnce(detail())
    const w = await mount(AdminPromoFraudCases)
    await w.get(`[data-pf-open="${CASE_ID}"]`).trigger('click')
    await flushPromises()
    await w.get('[data-pf-note]').setValue('Verificado: misma familia')
    mocks.request
      .mockResolvedValueOnce({ case: { ...holdCase, status: 'released', version: 2 } })
      .mockResolvedValueOnce({ items: [second] })
    await w.get('[data-pf-release]').trigger('click')
    await flushPromises()
    mocks.request.mockResolvedValueOnce({ ...detail(), case: { ...holdCase, id: second.id, refId: 'attr-78' } })
    await w.get(`[data-pf-open="${second.id}"]`).trigger('click')
    await flushPromises()
    await w.get('[data-pf-note]').setValue('Verificado de nuevo')
    expect(w.get('[data-pf-release]').attributes('disabled')).toBeUndefined()
  })
  it('upholds a case and reports a version conflict by reloading', async () => {
    mocks.request.mockResolvedValueOnce({ items: [holdCase] }).mockResolvedValueOnce(detail())
    const w = await mount(AdminPromoFraudCases)
    await w.get(`[data-pf-open="${CASE_ID}"]`).trigger('click')
    await flushPromises()
    await w.get('[data-pf-note]').setValue('Abuso confirmado por revisión')
    mocks.request
      .mockRejectedValueOnce({ statusCode: 409, data: { error: { code: 'version_conflict' } } })
      .mockResolvedValueOnce({ items: [holdCase] })
      .mockResolvedValueOnce(detail({ version: 3 }))
    await w.get('[data-pf-uphold]').trigger('click')
    await flushPromises()
    expect(w.get('[data-pf-error]').text()).toContain('cambió')
  })
  it('resolves an appeal and shows the customer statement', async () => {
    const appealed = {
      ...detail({ status: 'appealed', version: 2, appealStatus: 'pending' }),
      appeal: {
        id: 'a1',
        status: 'pending',
        statement: 'Somos hermanos y compartimos tarjeta.',
        createdAt: '2026-10-29T11:00:00Z'
      }
    }
    mocks.request
      .mockResolvedValueOnce({ items: [{ ...holdCase, status: 'appealed', version: 2, appealStatus: 'pending' }] })
      .mockResolvedValueOnce(appealed)
    const w = await mount(AdminPromoFraudCases)
    await w.get(`[data-pf-open="${CASE_ID}"]`).trigger('click')
    await flushPromises()
    expect(w.get('[data-pf-appeal]').text()).toContain('Somos hermanos')
    expect(w.find('[data-pf-release]').exists()).toBe(false)
    await w.get('[data-pf-note]').setValue('Documentación suficiente')
    mocks.request
      .mockResolvedValueOnce({ case: { ...holdCase, status: 'appeal_accepted', version: 3 } })
      .mockResolvedValueOnce({ items: [] })
    await w.get('[data-pf-accept]').trigger('click')
    await flushPromises()
    const call = mocks.request.mock.calls.find(([path]) => String(path).endsWith('/appeal-resolution'))!
    expect(call[1]).toMatchObject({
      method: 'POST',
      body: { expectedVersion: 2, outcome: 'accept', note: 'Documentación suficiente' }
    })
  })
  it('purges the queue when the session changes', async () => {
    mocks.request.mockResolvedValueOnce({ items: [holdCase] })
    const w = await mount(AdminPromoFraudCases)
    expect(w.find(`[data-pf-case="${CASE_ID}"]`).exists()).toBe(true)
    auth.session.value = { sessionId: '72000000-0000-4000-8000-000000000001', sessionVersion: 2 }
    mocks.request.mockResolvedValueOnce({ items: [] })
    await flushPromises()
    expect(w.find(`[data-pf-case="${CASE_ID}"]`).exists()).toBe(false)
  })
})

describe('SEC-036 customer appeal UI', () => {
  const mine = (extra = {}) => ({
    id: CASE_ID,
    context: 'referral',
    refId: 'attr-77',
    status: 'open',
    version: 1,
    benefitBlocked: true,
    canAppeal: true,
    appealStatus: null,
    createdAt: '2026-10-29T10:00:00Z',
    decidedAt: null,
    ...extra
  })
  it('lists the cases without internal signal details and explains the review', async () => {
    mocks.request.mockResolvedValueOnce({ items: [mine()] })
    const w = await mount(AccountPromoFraudAppeals)
    expect(mocks.request).toHaveBeenCalledWith('/api/account/promo-fraud/cases', expect.anything())
    const text = w.get('[data-ap-list]').text()
    expect(text).toContain('en revisión')
    expect(text).not.toMatch(/dispositivo|pago|puntuación/i)
    expect(w.text()).toContain('una única señal')
  })
  it('shows an empty state', async () => {
    mocks.request.mockResolvedValueOnce({ items: [] })
    const w = await mount(AccountPromoFraudAppeals)
    expect(w.get('[data-ap-empty]').text()).toContain('No tienes')
  })
  it('requires a statement of at least 10 characters and sends only version and statement', async () => {
    mocks.request.mockResolvedValueOnce({ items: [mine()] })
    const w = await mount(AccountPromoFraudAppeals)
    await w.get(`[data-ap-open="${CASE_ID}"]`).trigger('click')
    expect(w.get('[data-ap-submit]').attributes('disabled')).toBeDefined()
    await w.get('[data-ap-statement]').setValue('Somos hermanos y compartimos todo.')
    mocks.request.mockResolvedValueOnce({ case: { id: CASE_ID, status: 'appealed' } }).mockResolvedValueOnce({
      items: [mine({ status: 'appealed', version: 2, canAppeal: false, appealStatus: 'pending' })]
    })
    await w.get('[data-ap-form]').trigger('submit')
    await flushPromises()
    const call = mocks.request.mock.calls.find(([path]) => String(path).endsWith('/appeal'))!
    expect(call[0]).toBe(`/api/account/promo-fraud/cases/${CASE_ID}/appeal`)
    expect(call[1]).toMatchObject({
      method: 'POST',
      body: { caseVersion: 1, statement: 'Somos hermanos y compartimos todo.' }
    })
    expect(Object.keys((call[1] as { body: object }).body)).toEqual(['caseVersion', 'statement'])
    expect(w.get('[data-ap-notice]').text()).toContain('apelación')
    expect(w.text()).toContain('pendiente')
  })
  it('does not offer an appeal when it is not allowed', async () => {
    mocks.request.mockResolvedValueOnce({ items: [mine({ canAppeal: false, status: 'open' })] })
    const w = await mount(AccountPromoFraudAppeals)
    expect(w.find(`[data-ap-open="${CASE_ID}"]`).exists()).toBe(false)
  })
  it('reports a failed submission without losing the text', async () => {
    mocks.request.mockResolvedValueOnce({ items: [mine()] })
    const w = await mount(AccountPromoFraudAppeals)
    await w.get(`[data-ap-open="${CASE_ID}"]`).trigger('click')
    await w.get('[data-ap-statement]').setValue('Somos hermanos y compartimos todo.')
    mocks.request
      .mockRejectedValueOnce({ statusCode: 409, data: { error: { code: 'version_conflict' } } })
      .mockResolvedValueOnce({ items: [mine({ version: 2 })] })
    await w.get('[data-ap-form]').trigger('submit')
    await flushPromises()
    expect(w.get('[data-ap-error]').text()).toContain('cambió')
    expect((w.get('[data-ap-statement]').element as HTMLTextAreaElement).value).toBe(
      'Somos hermanos y compartimos todo.'
    )
  })
  it('does nothing for anonymous sessions', async () => {
    auth.loggedIn.value = false
    const w = await mount(AccountPromoFraudAppeals)
    expect(mocks.request).not.toHaveBeenCalled()
    expect(w.find('[data-ap-list]').exists()).toBe(false)
  })
})
