import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { DOMWrapper, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Page from '../../app/pages/admin/promociones.vue'
import BasketSimulator from '../../app/components/PromotionBasketSimulator.vue'
import { adminPromotionIntentHash } from '../../shared/admin-promotions'
import '#app/nuxt-vitest-app-entry'
import { testUuid } from '../support/deterministic'

// Acceptance matrix: live permission/session/email/MFA; CF-only; explicit query
// and paging; private strict DTO/loading/error/empty; governed create/edit/pause
// with reviewed frozen CAS intent; explicit simulation not a margin/quote;
// single flight; unknown receipt/manual GET/exact replay; revocation/late purge.
const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  runtime: 'cloudflare',
  owner: null as unknown,
  nav: null as unknown
}))
mockNuxtImport('useRequestFetch', () => () => mocks.request)
mockNuxtImport('useUserSession', () => () => mocks.owner)
mockNuxtImport('useRuntimeConfig', () => () => ({
  app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
  public: { serverRuntime: mocks.runtime }
}))
vi.mock('../../app/composables/useAdminNavigation', () => ({ useAdminNavigation: () => mocks.nav }))
const actor = '10000000-0000-4000-8000-000000000073',
  sessionId = '20000000-0000-4000-8000-000000000073',
  id = '30000000-0000-4000-8000-000000000073'
const rule = {
  id,
  version: 1,
  code: 'PRIVATE-SYNTHETIC',
  status: 'paused',
  channel: 'online',
  startsAt: '2030-01-01T00:00:00Z',
  endsAt: null,
  benefit: { kind: 'percent', basisPoints: 1000 },
  scope: { kind: 'all' },
  segment: 'all',
  totalLimit: 10,
  perCustomerLimit: 1,
  volumeMode: 'exclude_volume'
}
const item = { rule, redemptions: 0, createdAt: '2030-01-01T00:00:00Z', updatedAt: '2030-01-01T00:00:00Z' }
const list = () => ({ source: 'cloudflare', items: [item], total: 1, page: 1, perPage: 25 })
const detail = () => ({
  source: 'cloudflare',
  ...item,
  history: [{ rule, reason: 'Synthetic governed promotion', createdAt: item.createdAt }],
  historyTotal: 1,
  historyPage: 1
})
type Options = {
  method?: string
  body?: Record<string, unknown>
  headers?: Record<string, string>
  query?: Record<string, unknown>
  retry?: number
}
let owner: {
    ready: ReturnType<typeof ref<boolean>>
    loggedIn: ReturnType<typeof ref<boolean>>
    user: ReturnType<typeof ref<Record<string, unknown>>>
    session: ReturnType<typeof ref<Record<string, unknown>>>
  },
  caps: ReturnType<typeof ref<Record<string, unknown>>>
const mounted: Array<{ unmount: () => void }> = []
beforeEach(() => {
  mocks.runtime = 'cloudflare'
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
    permissions: ['administration.manage']
  })
  mocks.owner = owner
  mocks.nav = { capabilities: caps, status: ref('ready') }
  mocks.request
    .mockReset()
    .mockImplementation(async (path: string) => (path === `/api/admin/promotions/${id}` ? detail() : list()))
})
afterEach(() => mounted.splice(0).forEach((w) => w.unmount()))
async function mount() {
  const w = await mountSuspended(Page)
  mounted.push(w)
  await flushPromises()
  return w
}
async function draft(w: Awaited<ReturnType<typeof mount>>) {
  await w.get('[data-testid="promotion-create"]').trigger('click')
  await w.get('[data-testid="promotion-code"]').setValue('SYNTHETIC-NEW')
  await w.get('[data-testid="promotion-start"]').setValue('2030-01-01T00:00:00')
  await w.get('[data-testid="promotion-reason"]').setValue('Synthetic governed administrative decision')
}
const writes = () =>
  mocks.request.mock.calls.filter(
    ([, o]) => ['POST', 'PUT'].includes(o?.method) && !String(o?.url).includes('/preview')
  )
async function review(w: Awaited<ReturnType<typeof mount>>) {
  // trigger('click') dispatches a synthetic event without native form submission.
  // Exercise the actual form handler, including keyboard submission semantics.
  const form = w.get('[data-testid="promotion-review"]').element.closest('form')
  expect(form).not.toBeNull()
  await new DOMWrapper(form!).trigger('submit')
  // SHA-256 uses native async I/O; flushPromises alone does not await it.
  await vi.waitFor(() => expect(w.find('[data-testid="promotion-confirm"]').exists()).toBe(true))
}
it('reads current private list and starts a usable paused-rule editor', async () => {
  const w = await mount()
  expect(w.text()).toContain(rule.code)
  await draft(w)
  expect(w.get('[data-testid="promotion-status"]').element).toHaveProperty('value', 'paused')
})
it('binds the current proposed rule to the separate basket simulator without activating it', async () => {
  const w = await mount()
  await draft(w)
  const simulator = w.findComponent(BasketSimulator)
  expect(simulator.exists()).toBe(true)
  expect(simulator.props('rule')).toMatchObject({ code: 'SYNTHETIC-NEW', status: 'paused' })
  expect(simulator.props('pending')).toBe(false)
  await w.get('[data-testid="promotion-code"]').setValue('SYNTHETIC-EDITED')
  expect(simulator.props('rule')).toMatchObject({ code: 'SYNTHETIC-EDITED', status: 'paused' })
  expect(writes()).toHaveLength(0)
})
it('separates error from confirmed empty and retries GET explicitly', async () => {
  mocks.request.mockRejectedValueOnce(Error('offline'))
  const w = await mount()
  expect(w.text()).toContain('No se pudieron cargar')
  expect(w.text()).not.toContain('No hay promociones')
  await w.get('[data-testid="promotion-refresh"]').trigger('click')
  await flushPromises()
  expect(w.text()).toContain(rule.code)
})
it('rejects malformed private DTO instead of displaying data', async () => {
  mocks.request.mockResolvedValue({ ...list(), items: [{ ...item, rule: { ...rule, version: '1' } }] })
  const w = await mount()
  expect(w.text()).not.toContain(rule.code)
  expect(w.text()).toContain('No se pudieron cargar')
})
it('does not GET per keystroke and applies an explicit query', async () => {
  const w = await mount()
  mocks.request.mockClear()
  await w.get('[data-testid="promotion-query"]').setValue('SYNTHETIC')
  expect(mocks.request).not.toHaveBeenCalled()
  await w.get('[data-testid="promotion-search"]').trigger('submit')
  await flushPromises()
  expect(mocks.request.mock.calls[0]?.[1]?.query).toMatchObject({ q: 'SYNTHETIC', page: 1 })
})
it('requires review before confirmation and sends one exact command despite double click', async () => {
  const w = await mount()
  await draft(w)
  expect(w.find('[data-testid="promotion-confirm"]').exists()).toBe(false)
  await review(w)
  await flushPromises()
  const confirm = w.get('[data-testid="promotion-confirm"]')
  await confirm.trigger('click')
  await confirm.trigger('click')
  await flushPromises()
  const sent = mocks.request.mock.calls.filter(([, o]) => o?.method === 'POST')
  expect(sent).toHaveLength(1)
  expect(sent[0]![1]).toMatchObject({
    retry: 0,
    body: {
      expectedVersion: 0,
      rule: { version: 1, code: 'SYNTHETIC-NEW', status: 'paused', volumeMode: 'exclude_volume' }
    }
  })
  expect(sent[0]![1].headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/)
})
it('keeps an ambiguous intent and recovers only via explicit matching receipt GET plus fresh detail', async () => {
  let saved: Options | undefined
  mocks.request.mockImplementation(async (path: string, options: Options = {}) => {
    if (options.method === 'POST') {
      saved = structuredClone(options)
      throw Error('lost')
    }
    if (path.includes('/commands/')) return { source: 'cloudflare', outcome: 'unknown' }
    return path === `/api/admin/promotions/${id}` ? detail() : list()
  })
  const w = await mount()
  await draft(w)
  await review(w)
  await flushPromises()
  await w.get('[data-testid="promotion-confirm"]').trigger('click')
  await flushPromises()
  expect(w.text()).toContain('Resultado incierto')
  expect(saved).toBeDefined()
  const initial = structuredClone(saved)
  await w.get('[data-testid="promotion-check"]').trigger('click')
  await flushPromises()
  expect(w.text()).toContain('Resultado incierto')
  expect(mocks.request.mock.calls.filter(([, o]) => o?.method === 'POST')).toHaveLength(1)
  await w.get('[data-testid="promotion-retry"]').trigger('click')
  await flushPromises()
  expect(saved).toEqual(initial)
})
it('invalidates reviewed intent when the form changes, before any POST', async () => {
  const w = await mount()
  await draft(w)
  await review(w)
  await flushPromises()
  await w.get('[data-testid="promotion-reason"]').setValue('Changed governed decision')
  expect(w.find('[data-testid="promotion-confirm"]').exists()).toBe(false)
  expect(writes()).toHaveLength(0)
})
it('announces a saved rule only after correlated receipt and a successful fresh detail read', async () => {
  let saved: Options | undefined
  mocks.request.mockImplementation(async (path: string, options: Options = {}) => {
    if (options.method === 'POST') {
      saved = structuredClone(options)
      return {
        source: 'cloudflare',
        commandId: options.headers!['Idempotency-Key'],
        ruleId: (options.body!.rule as { id: string }).id,
        version: 1,
        ruleHash: 'a'.repeat(64),
        payloadHash: await adminPromotionIntentHash(options.body),
        createdAt: item.createdAt
      }
    }
    if (saved && path === `/api/admin/promotions/${(saved.body!.rule as { id: string }).id}`)
      return { ...detail(), rule: saved.body!.rule }
    return list()
  })
  const w = await mount()
  await draft(w)
  await review(w)
  await flushPromises()
  await w.get('[data-testid="promotion-confirm"]').trigger('click')
  await flushPromises()
  await vi.waitFor(() => expect(w.text()).toContain('Cambio registrado y regla vigente comprobada'))
  expect(w.find('[data-testid="promotion-check"]').exists()).toBe(false)
  expect(mocks.request.mock.calls.filter(([, o]) => o?.method === 'POST')).toHaveLength(1)
})
it('keeps uncertainty when a POST receipt belongs to another command, never reading it as success', async () => {
  mocks.request.mockImplementation(async (_path: string, options: Options = {}) =>
    options.method === 'POST'
      ? {
          source: 'cloudflare',
          commandId: testUuid(),
          ruleId: (options.body!.rule as { id: string }).id,
          version: 1,
          ruleHash: 'a'.repeat(64),
          payloadHash: await adminPromotionIntentHash(options.body),
          createdAt: item.createdAt
        }
      : list()
  )
  const w = await mount()
  await draft(w)
  await review(w)
  await flushPromises()
  await w.get('[data-testid="promotion-confirm"]').trigger('click')
  await flushPromises()
  await vi.waitFor(() => expect(w.text()).toContain('Resultado incierto'))
  expect(w.text()).not.toContain('Cambio registrado y regla vigente comprobada')
})
it('does not restore a late private list after identity/session authority is lost', async () => {
  let resolve!: (value: unknown) => void
  mocks.request.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done
      })
  )
  const w = await mount()
  owner.user.value = { ...owner.user.value, emailVerified: false }
  await flushPromises()
  resolve(list())
  await flushPromises()
  expect(w.text()).not.toContain(rule.code)
  expect(w.find('[data-testid="promotion-create"]').exists()).toBe(false)
})
it.each(['identity', 'session', 'version', 'email', 'mfa', 'grant'])(
  'purges private list/drafts and forbids commands on %s change',
  async (boundary) => {
    const w = await mount()
    await draft(w)
    if (boundary === 'identity') owner.user.value = { ...owner.user.value, id: testUuid() }
    if (boundary === 'session') owner.session.value = { ...owner.session.value, sessionId: testUuid() }
    if (boundary === 'version') owner.session.value = { ...owner.session.value, sessionVersion: 2 }
    if (boundary === 'email') owner.user.value = { ...owner.user.value, emailVerified: false }
    if (boundary === 'mfa') owner.user.value = { ...owner.user.value, mfaVerified: false }
    if (boundary === 'grant') caps.value = { ...caps.value, permissions: [] }
    await flushPromises()
    expect(w.text()).not.toContain(rule.code)
    expect(w.find('[data-testid="promotion-code"]').exists()).toBe(false)
    expect(writes()).toHaveLength(0)
  }
)
it('never calls invented Node promotion endpoints', async () => {
  mocks.runtime = 'node'
  const w = await mount()
  expect(mocks.request).not.toHaveBeenCalled()
  expect(w.text()).toContain('Cloudflare')
})
it('shows the complete history from confirmed detail', async () => {
  const w = await mount()
  await w.get('[data-testid="promotion-edit"]').trigger('click')
  await flushPromises()
  expect(w.text()).toContain('Synthetic governed promotion')
  expect(w.get('[data-testid="promotion-code"]').attributes('readonly')).toBeDefined()
})
it('shares canonical normalized intent hashing with the command contract', async () => {
  expect(
    await adminPromotionIntentHash({
      expectedVersion: 0,
      rule: { ...rule, code: ' synthetic ' },
      reason: 'Synthetic governed promotion'
    })
  ).toBe(
    await adminPromotionIntentHash({
      expectedVersion: 0,
      rule: { ...rule, code: 'SYNTHETIC' },
      reason: 'Synthetic governed promotion'
    })
  )
})

async function casRecovery(second: 'unknown' | 'applied' | 'outage') {
  let sent: Options | undefined,
    checks = 0
  mocks.request.mockImplementation(async (path: string, options: Options = {}) => {
    if (options.method === 'PUT') {
      sent = structuredClone(options)
      throw { statusCode: 409 }
    }
    if (path.includes('/commands/')) {
      checks++
      if (checks === 1) return { source: 'cloudflare', outcome: 'unknown' }
      if (second === 'outage') throw Error('offline')
      if (second === 'applied')
        return {
          source: 'cloudflare',
          outcome: 'applied',
          receipt: {
            source: 'cloudflare',
            commandId: sent!.headers!['Idempotency-Key'],
            ruleId: id,
            version: 2,
            ruleHash: 'a'.repeat(64),
            payloadHash: await adminPromotionIntentHash(sent!.body),
            createdAt: item.createdAt
          }
        }
      return { source: 'cloudflare', outcome: 'unknown' }
    }
    if (path === `/api/admin/promotions/${id}`)
      return sent
        ? { ...detail(), rule: second === 'applied' ? sent.body!.rule : { ...rule, version: 2 }, historyTotal: 2 }
        : detail()
    return list()
  })
  const w = await mount()
  await w.get('[data-testid="promotion-edit"]').trigger('click')
  await flushPromises()
  await w.get('[data-testid="promotion-reason"]').setValue('Synthetic conflict decision')
  await review(w)
  await flushPromises()
  await w.get('[data-testid="promotion-confirm"]').trigger('click')
  await flushPromises()
  await w.get('[data-testid="promotion-check"]').trigger('click')
  await flushPromises()
  if (second === 'applied')
    await vi.waitFor(() => expect(w.text()).toContain('Cambio registrado y regla vigente comprobada'))
  return { w, checks: () => checks }
}
it('releases impossible stale CAS only after unknown → fresh higher version → second unknown, requiring new explicit review', async () => {
  const { w, checks } = await casRecovery('unknown')
  expect(checks()).toBe(2)
  expect(w.text()).toContain('Otro cambio')
  expect(w.find('[data-testid="promotion-review"]').exists()).toBe(true)
  expect(w.find('[data-testid="promotion-confirm"]').exists()).toBe(false)
  expect(mocks.request.mock.calls.filter(([, o]) => o?.method === 'PUT')).toHaveLength(1)
})
it('checks the ledger again after fresh state and confirms a raced applied receipt instead of discarding it', async () => {
  const { w, checks } = await casRecovery('applied')
  expect(checks()).toBe(2)
  expect(w.text()).toContain('Cambio registrado y regla vigente comprobada')
  expect(mocks.request.mock.calls.filter(([, o]) => o?.method === 'PUT')).toHaveLength(1)
})
it('retains unknown intent when the second ledger check fails, never silently releasing or retrying', async () => {
  const { w, checks } = await casRecovery('outage')
  expect(checks()).toBe(2)
  expect(w.text()).toContain('Resultado incierto')
  expect(w.find('[data-testid="promotion-review"]').exists()).toBe(false)
  expect(mocks.request.mock.calls.filter(([, o]) => o?.method === 'PUT')).toHaveLength(1)
})
