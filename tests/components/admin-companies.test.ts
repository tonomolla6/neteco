import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { ref, type Ref } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import CompanyReviewPanel from '../../app/components/CompanyReviewPanel.vue'
import CompaniesPage from '../../app/pages/admin/clientes.vue'
import { deterministicUuid } from '../fixtures/deterministic'
import '#app/nuxt-vitest-app-entry'

// Acceptance: exact live capability/session binding; private DTO validation;
// literal explicit filter + server paging (no typing GET); truthful failures;
// reviewed CAS payload + immutable intent/key; double click prevention;
// lost/malformed success requires manual receipt GET, never automatic PUT;
// matching receipt confirms recorded review even if current list changed;
// unknown/conflict never prove absence; explicit exact replay only;
// fresh-list failure does not erase an applied receipt; revocation/session,
// stale read/unmount cannot restore PII or dispatch a follow-up effect.
const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  nodeFetch: vi.fn(),
  runtime: 'cloudflare',
  session: { value: null as unknown },
  navigation: { value: null as unknown }
}))
vi.mock('../../app/composables/useAdminNavigation', () => ({ useAdminNavigation: () => mocks.navigation.value }))
mockNuxtImport('useRequestFetch', () => () => mocks.request)
mockNuxtImport('useUserSession', () => () => mocks.session.value)
mockNuxtImport('useFetch', () => mocks.nodeFetch)
mockNuxtImport('useRuntimeConfig', () => () => ({
  app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
  public: { serverRuntime: mocks.runtime }
}))
const id = deterministicUuid('company-ui'),
  actorId = deterministicUuid('company-ui-actor'),
  sessionId = deterministicUuid('company-ui-session')
const item = {
  id,
  legalName: 'Empresa sintética',
  tradeName: null,
  taxId: 'B12345678',
  countryCode: 'ES',
  status: 'pending',
  createdAt: '2026-10-08T12:00:00Z',
  updatedAt: '2026-10-08T12:00:00Z',
  contactEmail: 'private@example.invalid',
  currentChangeId: null,
  reviewedAt: null,
  rejectionReason: null
}
const list = (items: unknown[] = [item], extra = {}) => ({
  source: 'cloudflare',
  items,
  total: items.length,
  page: 1,
  perPage: 20,
  ...extra
})
type RequestOptions = {
  method?: string
  body?: Record<string, unknown>
  headers?: Record<string, string>
  query?: Record<string, unknown>
  retry?: number
}
let session: {
    ready: Ref<boolean>
    loggedIn: Ref<boolean>
    user: Ref<Record<string, unknown>>
    session: Ref<Record<string, unknown>>
  },
  caps: Ref<Record<string, unknown>>
const mounted: Array<{ unmount: () => void }> = []
function saved(options: RequestOptions, extra = {}) {
  return {
    source: 'cloudflare',
    companyId: id,
    commandId: options.headers!['Idempotency-Key'],
    changeId: options.headers!['Idempotency-Key'],
    status: options.body!.status,
    createdAt: '2026-10-08T12:30:00Z',
    ...extra
  }
}
function commands() {
  return mocks.request.mock.calls.filter(([, o]) => o?.method === 'PUT')
}
beforeEach(() => {
  mocks.runtime = 'cloudflare'
  mocks.nodeFetch
    .mockReset()
    .mockResolvedValue({ data: ref({ companies: [] }), refresh: async () => {}, status: ref('success') })
  session = {
    ready: ref(true),
    loggedIn: ref(true),
    user: ref({ id: actorId, emailVerified: true, mfaVerified: true }),
    session: ref({ sessionId, sessionVersion: 1 })
  }
  caps = ref({
    source: 'cloudflare',
    identityId: actorId,
    sessionId,
    sessionVersion: 1,
    state: 'ready',
    permissions: ['administration.manage']
  })
  mocks.session.value = session
  mocks.navigation.value = { capabilities: caps, status: ref('ready') }
  mocks.request
    .mockReset()
    .mockImplementation(async (_path: string, options: RequestOptions = {}) =>
      options.method === 'PUT' ? saved(options) : list()
    )
})
afterEach(() => {
  mounted.splice(0).forEach((w) => w.unmount())
  vi.restoreAllMocks()
})
async function render(runtime = 'cloudflare') {
  const wrapper = await mountSuspended(CompanyReviewPanel, { props: { runtime } })
  mounted.push(wrapper)
  await flushPromises()
  return wrapper
}
async function review(wrapper: Awaited<ReturnType<typeof render>>, status = 'approved') {
  await wrapper.get('[data-company-review]').trigger('click')
  await wrapper.get('[data-company-target-status]').setValue(status)
  await wrapper.get('[data-company-reason]').setValue('Revisión documental administrativa')
}
it('shows actual private company data and applies filters only explicitly', async () => {
  const w = await render()
  expect(w.text()).toContain(item.legalName)
  expect(w.text()).toContain(item.taxId)
  const n = mocks.request.mock.calls.length
  await w.get('[data-company-query]').setValue('B12345678')
  await w.get('[data-company-filter-status]').setValue('approved')
  expect(mocks.request).toHaveBeenCalledTimes(n)
  await w.get('[data-company-filter]').trigger('submit')
  await flushPromises()
  expect(mocks.request.mock.lastCall?.[1]).toMatchObject({
    method: 'GET',
    query: { q: 'B12345678', status: 'approved', page: 1, perPage: 20 },
    retry: 0
  })
})
it('uses bounded server pages without changing the applied filter', async () => {
  mocks.request
    .mockResolvedValueOnce(list([item], { total: 21 }))
    .mockResolvedValueOnce(list([], { page: 2, total: 21 }))
  const w = await render()
  await w.get('[data-company-next]').trigger('click')
  await flushPromises()
  expect(mocks.request.mock.lastCall?.[1].query).toMatchObject({ page: 2, perPage: 20 })
  expect(w.get('[data-company-next]').attributes('disabled')).toBeDefined()
})
it('read errors are never represented as confirmed empty', async () => {
  mocks.request.mockRejectedValueOnce(new Error('offline'))
  const w = await render()
  expect(w.find('[data-company-read-error]').exists()).toBe(true)
  expect(w.find('[data-company-empty]').exists()).toBe(false)
  await w.get('[data-company-retry]').trigger('click')
  await flushPromises()
  expect(w.text()).toContain(item.legalName)
})
it.each([
  list([], { source: 'node' }),
  list([], { page: 2 }),
  list([], { perPage: 50 }),
  list([{ ...item, extra: 'secret' }]),
  list([item, item])
])('fails closed on mismatched listing DTO', async (value) => {
  mocks.request.mockResolvedValueOnce(value)
  const w = await render()
  expect(w.find('[data-company-read-error]').exists()).toBe(true)
  expect(w.text()).not.toContain(item.contactEmail)
})
it('confirms an exact CAS command with a durable receipt then refreshes the server list', async () => {
  const w = await render()
  await review(w)
  await w.get('[data-company-command]').trigger('submit')
  await flushPromises()
  expect(commands()).toHaveLength(1)
  expect(commands()[0]![1]).toMatchObject({
    method: 'PUT',
    body: {
      expectedStatus: 'pending',
      expectedChangeId: null,
      status: 'approved',
      reason: 'Revisión documental administrativa'
    },
    retry: 0
  })
  expect(commands()[0]![1].headers['Idempotency-Key']).toMatch(/^[a-f0-9-]{36}$/)
  expect(w.find('[data-company-confirmed]').exists()).toBe(true)
  expect(mocks.request.mock.lastCall?.[1].method).toBe('GET')
})
it('requires a valid reason and never mutates by opening or editing', async () => {
  const w = await render()
  await w.get('[data-company-review]').trigger('click')
  await w.get('[data-company-reason]').setValue('x')
  await w.get('[data-company-command]').trigger('submit')
  await flushPromises()
  expect(commands()).toHaveLength(0)
})
it('prevents double submit while the original command is pending', async () => {
  let resolve!: (value: unknown) => void
  const w = await render()
  mocks.request.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r
      })
  )
  await review(w)
  await w.get('[data-company-command]').trigger('submit')
  await w.get('[data-company-command]').trigger('submit')
  expect(commands()).toHaveLength(1)
  resolve(saved(commands()[0]![1]))
  await flushPromises()
  expect(commands()).toHaveLength(1)
})
it('recovers a lost PUT response using the frozen manual GET, never another PUT', async () => {
  const w = await render()
  await review(w)
  mocks.request.mockRejectedValueOnce(new Error('lost response'))
  await w.get('[data-company-command]').trigger('submit')
  await flushPromises()
  expect(w.find('[data-company-unknown]').exists()).toBe(true)
  expect(commands()).toHaveLength(1)
  const intent = commands()[0]![1],
    receipt = saved(intent)
  mocks.request.mockResolvedValueOnce({
    source: 'cloudflare',
    companyId: id,
    commandId: receipt.commandId,
    outcome: 'applied',
    receipt
  })
  await w.get('[data-company-check]').trigger('click')
  await flushPromises()
  expect(commands()).toHaveLength(1)
  expect(w.find('[data-company-confirmed]').exists()).toBe(true)
  const reads = mocks.request.mock.calls.filter(([p]) => p.includes('/commands/'))
  expect(reads).toHaveLength(1)
  expect(reads[0]![0]).toBe(`/api/admin/companies/${id}/commands/${receipt.commandId}`)
})
it('unknown receipt preserves uncertainty and only offers an explicit identical replay', async () => {
  const w = await render()
  await review(w)
  mocks.request.mockRejectedValueOnce(new Error('lost'))
  await w.get('[data-company-command]').trigger('submit')
  await flushPromises()
  const original = commands()[0]![1],
    key = original.headers['Idempotency-Key']
  mocks.request.mockResolvedValueOnce({
    source: 'cloudflare',
    companyId: id,
    commandId: key,
    outcome: 'unknown',
    receipt: null
  })
  await w.get('[data-company-check]').trigger('click')
  await flushPromises()
  expect(commands()).toHaveLength(1)
  expect(w.find('[data-company-unknown]').exists()).toBe(true)
  await w.get('[data-company-replay]').trigger('click')
  await flushPromises()
  expect(commands()).toHaveLength(2)
  expect(commands()[1]![1].body).toEqual(original.body)
  expect(commands()[1]![1].headers).toEqual(original.headers)
})
it.each(['wrong-id', 'wrong-key', 'wrong-status', 'malformed'])('does not confirm a %s receipt', async (mode) => {
  const w = await render()
  await review(w)
  mocks.request.mockImplementationOnce(async (_p, o) =>
    saved(
      o,
      mode === 'wrong-id'
        ? { companyId: actorId }
        : mode === 'wrong-key'
          ? { commandId: actorId, changeId: actorId }
          : mode === 'wrong-status'
            ? { status: 'rejected' }
            : { extra: 'internal' }
    )
  )
  await w.get('[data-company-command]').trigger('submit')
  await flushPromises()
  expect(w.find('[data-company-confirmed]').exists()).toBe(false)
  expect(w.find('[data-company-unknown]').exists()).toBe(true)
})
it('a CAS conflict retains original intent until manual receipt recovery, never claims no effect', async () => {
  const w = await render()
  await review(w)
  mocks.request.mockRejectedValueOnce({ statusCode: 409, data: { error: { code: 'conflict' } } })
  await w.get('[data-company-command]').trigger('submit')
  await flushPromises()
  expect(w.find('[data-company-unknown]').exists()).toBe(true)
  expect(w.find('[data-company-check]').exists()).toBe(true)
  expect(commands()).toHaveLength(1)
})
it('preserves a confirmed receipt when the following current-list refresh fails', async () => {
  const w = await render()
  await review(w)
  mocks.request.mockImplementationOnce(async (_p, o) => saved(o)).mockRejectedValueOnce(new Error('refresh failed'))
  await w.get('[data-company-command]').trigger('submit')
  await flushPromises()
  expect(w.find('[data-company-confirmed]').exists()).toBe(true)
  expect(w.find('[data-company-read-error]').exists()).toBe(true)
})
it.each(['grant', 'session', 'email', 'mfa'])(
  'purges private state and stale in-flight success on %s revocation',
  async (mode) => {
    const w = await render()
    await w.get('[data-company-query]').setValue('B12345678')
    await w.get('[data-company-filter]').trigger('submit')
    await flushPromises()
    await review(w)
    let resolve!: (value: unknown) => void
    mocks.request.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r
        })
    )
    await w.get('[data-company-command]').trigger('submit')
    const intent = commands()[0]![1],
      n = mocks.request.mock.calls.length
    if (mode === 'grant') caps.value = { ...caps.value, permissions: [] }
    if (mode === 'session') session.session.value.sessionVersion = 2
    if (mode === 'email') session.user.value.emailVerified = false
    if (mode === 'mfa') session.user.value.mfaVerified = false
    await flushPromises()
    resolve(saved(intent))
    await flushPromises()
    expect(w.text()).not.toContain(item.contactEmail)
    expect(w.find('[data-company-confirmed]').exists()).toBe(false)
    expect(mocks.request).toHaveBeenCalledTimes(n)
    const state = (w.vm.$ as unknown as { setupState: Record<string, unknown> }).setupState
    expect(state.query).toBe('')
    expect(state.appliedQuery).toBe('')
  }
)
it('unmount prevents a late command from dispatching current-list reads', async () => {
  const w = await render()
  await review(w)
  let resolve!: (value: unknown) => void
  mocks.request.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r
      })
  )
  await w.get('[data-company-command]').trigger('submit')
  const n = mocks.request.mock.calls.length
  w.unmount()
  resolve(saved(commands()[0]![1]))
  await flushPromises()
  expect(mocks.request).toHaveBeenCalledTimes(n)
})
it('unmount purges private DTO, draft, frozen command and applied fiscal search from setupState', async () => {
  const w = await render()
  await w.get('[data-company-query]').setValue('B12345678')
  await w.get('[data-company-filter]').trigger('submit')
  await flushPromises()
  await review(w)
  let resolve!: (value: unknown) => void
  mocks.request.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r
      })
  )
  await w.get('[data-company-command]').trigger('submit')
  const state = (w.vm.$ as unknown as { setupState: Record<string, unknown> }).setupState
  expect(state.intent).not.toBeNull()
  expect(state.reason).toBe('Revisión documental administrativa')
  expect(state.query).toBe('B12345678')
  expect(state.appliedQuery).toBe('B12345678')
  const command = commands()[0]![1],
    n = mocks.request.mock.calls.length
  w.unmount()
  expect(state.intent).toBeNull()
  expect(state.reason).toBe('')
  expect(state.query).toBe('')
  expect(state.appliedQuery).toBe('')
  expect(state.snapshot).toBeNull()
  expect(state.target).toBeNull()
  resolve(saved(command))
  await flushPromises()
  expect(mocks.request).toHaveBeenCalledTimes(n)
})
it('does not call Cloudflare APIs under the legacy Node runtime', async () => {
  await render('node')
  expect(mocks.request).not.toHaveBeenCalled()
})
it.each(['cloudflare', 'node'])(
  'mounts the actual page without mixing %s and the other runtime contract',
  async (runtime) => {
    mocks.runtime = runtime
    const wrapper = await mountSuspended(CompaniesPage, {
      global: {
        stubs: {
          CompanyReviewPanel: { props: ['runtime'], template: '<div data-cf-company-panel />' },
          UiDataTable: true,
          UiPageHeader: true,
          USelect: true,
          UModal: true
        }
      }
    })
    mounted.push(wrapper)
    await flushPromises()
    expect(wrapper.find('[data-cf-company-panel]').exists()).toBe(runtime === 'cloudflare')
    if (runtime === 'cloudflare') expect(mocks.nodeFetch).not.toHaveBeenCalled()
    else {
      expect(mocks.nodeFetch).toHaveBeenCalledTimes(1)
      expect(mocks.nodeFetch.mock.calls[0]?.[0]).toBe('/api/admin/companies')
    }
  }
)
it.each([401, 403])(
  'purges private company data on server %s while preserving manual uncertain receipt recovery',
  async (status) => {
    const w = await render()
    await review(w)
    mocks.request.mockRejectedValueOnce({
      statusCode: status,
      data: { error: { code: status === 401 ? 'unauthenticated' : 'forbidden' } }
    })
    await w.get('[data-company-command]').trigger('submit')
    await flushPromises()
    expect(w.text()).not.toContain(item.contactEmail)
    expect(w.text()).not.toContain(item.legalName)
    expect(w.find('[data-company-unknown]').exists()).toBe(true)
    expect(commands()).toHaveLength(1)
    const state = (w.vm.$ as unknown as { setupState: Record<string, unknown> }).setupState
    expect(state.intent).toMatchObject({ key: commands()[0]![1].headers['Idempotency-Key'], body: null })
    expect(state.reason).toBe('')
    expect(state.target).toBeNull()
  }
)
it('purges stale PII when manual receipt lookup is denied by live server authority', async () => {
  const w = await render()
  await review(w)
  mocks.request.mockRejectedValueOnce(new Error('lost response'))
  await w.get('[data-company-command]').trigger('submit')
  await flushPromises()
  mocks.request.mockRejectedValueOnce({ statusCode: 403, data: { error: { code: 'forbidden' } } })
  await w.get('[data-company-check]').trigger('click')
  await flushPromises()
  expect(w.text()).not.toContain(item.contactEmail)
  expect(w.text()).not.toContain(item.legalName)
  expect(w.find('[data-company-unknown]').exists()).toBe(true)
  expect(commands()).toHaveLength(1)
  const state = (w.vm.$ as unknown as { setupState: Record<string, unknown> }).setupState
  expect(state.intent).toMatchObject({ body: null })
  expect(state.reason).toBe('')
  expect(state.target).toBeNull()
})
it('does not restore a late private read after the session changes', async () => {
  let resolve!: (value: unknown) => void
  mocks.request.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r
      })
  )
  const w = await render()
  session.session.value.sessionVersion = 2
  await flushPromises()
  resolve(list())
  await flushPromises()
  expect(w.text()).not.toContain(item.contactEmail)
  expect(w.find('[data-company-review]').exists()).toBe(false)
})
it.each([
  [400, 'invalid_input'],
  [429, 'rate_limited'],
  [403, 'csrf_rejected']
])('a replay rejected with %s %s does not resolve the original lost command', async (status, code) => {
  const w = await render()
  await review(w)
  mocks.request.mockRejectedValueOnce(new Error('lost original'))
  await w.get('[data-company-command]').trigger('submit')
  await flushPromises()
  const original = commands()[0]![1],
    key = original.headers['Idempotency-Key']
  mocks.request.mockResolvedValueOnce({
    source: 'cloudflare',
    companyId: id,
    commandId: key,
    outcome: 'unknown',
    receipt: null
  })
  await w.get('[data-company-check]').trigger('click')
  await flushPromises()
  mocks.request.mockRejectedValueOnce({ statusCode: status, data: { error: { code } } })
  await w.get('[data-company-replay]').trigger('click')
  await flushPromises()
  expect(w.find('[data-company-unknown]').exists()).toBe(true)
  expect(w.find('[data-company-check]').exists()).toBe(true)
  expect(commands()).toHaveLength(2)
  expect(commands()[1]![1].body).toEqual(original.body)
})
