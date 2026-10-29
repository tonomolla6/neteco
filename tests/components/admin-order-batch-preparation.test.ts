import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AdminOrderBatchPreparation from '../../app/components/AdminOrderBatchPreparation.vue'
import { adminOrderBulkIntentHash } from '~~/shared/admin-order-bulk'
import '#app/nuxt-vitest-app-entry'
const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  session: vi.fn(),
  navigation: vi.fn(),
  runtime: vi.fn(() => ({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'cloudflare' }
  }))
}))
mockNuxtImport('useRequestFetch', () => () => mocks.request)
mockNuxtImport('useUserSession', () => mocks.session)
mockNuxtImport('useAdminNavigation', () => mocks.navigation)
mockNuxtImport('useRuntimeConfig', () => mocks.runtime)
const FIRST = '30000000-0000-4000-8000-000000000001',
  SECOND = '30000000-0000-4000-8000-000000000002',
  ACTOR = '10000000-0000-4000-8000-000000000001',
  SESSION = '20000000-0000-4000-8000-000000000001',
  GROUP = '50000000-0000-4000-8000-000000000001',
  DISPATCH = '60000000-0000-4000-8000-000000000001',
  CHILD = '70000000-0000-4000-8000-000000000001'
const ROOT = '/api/admin/orders/bulk-fulfillment',
  HASH = 'a'.repeat(64)
const preview = () => ({
  source: 'cloudflare',
  action: 'picking',
  previewHash: HASH,
  rows: [
    { orderId: FIRST, expectedVersion: 0, currentVersion: 0, state: 'pending', eligible: true, reason: null },
    {
      orderId: SECOND,
      expectedVersion: 0,
      currentVersion: 0,
      state: 'pending',
      eligible: false,
      reason: 'payment_unconfirmed'
    }
  ],
  eligible: 1,
  blocked: 1,
  inventoryEffect: 'none',
  economicEffect: 'none',
  evaluatedAt: '2026-10-09T12:00:00Z'
})
type Options = { method?: string; body?: unknown; headers?: Record<string, string>; query?: Record<string, string> }
let commandReceipt: {
  source: string
  commandId: string
  payloadHash: string
  groupId: string
  dispatchId: string
  previewHash: string
  selected: number
  eligible: number
  blocked: number
  recordedAt: string
} | null
function group(uncertain = false) {
  const receipt = commandReceipt!
  return {
    source: 'cloudflare',
    groupId: GROUP,
    commandId: receipt.commandId,
    payloadHash: receipt.payloadHash,
    dispatchId: DISPATCH,
    action: 'picking',
    status: uncertain ? 'paused' : 'completed',
    recordedAt: receipt.recordedAt,
    selected: 2,
    completed: uncertain ? 1 : 2,
    remaining: uncertain ? 1 : 0,
    rows: [
      {
        orderId: FIRST,
        expectedVersion: 0,
        childKey: CHILD,
        status: uncertain ? 'unknown' : 'applied',
        reason: null,
        receipt: uncertain
          ? null
          : {
              source: 'cloudflare',
              action: 'picking',
              commandId: CHILD,
              orderId: FIRST,
              warehouseId: 'main',
              state: 'picking',
              interruptedState: null,
              version: 1,
              inventoryEffect: 'none',
              updated: true
            }
      },
      {
        orderId: SECOND,
        expectedVersion: 0,
        childKey: '70000000-0000-4000-8000-000000000002',
        status: 'not_attempted',
        reason: 'payment_unconfirmed',
        receipt: null
      }
    ],
    inventoryEffect: 'none',
    economicEffect: 'none'
  }
}
function deferred() {
  let resolve!: (value: unknown) => void
  const promise = new Promise((done) => {
    resolve = done
  })
  return { resolve, promise }
}
const makeSession = () => ({
  ready: ref(true),
  loggedIn: ref(true),
  user: ref({ id: ACTOR, emailVerified: true, mfaVerified: true }),
  session: ref({ sessionId: SESSION, sessionVersion: 1 })
})
let session: ReturnType<typeof makeSession>, caps: ReturnType<typeof ref<unknown>>
const wrappers: Awaited<ReturnType<typeof mountSuspended>>[] = []
async function render(props = {}) {
  const wrapper = await mountSuspended(AdminOrderBatchPreparation, {
    props: { scopeKey: 'scope-a', enabled: true, pending: false, orderIds: [FIRST, SECOND], ...props }
  })
  wrappers.push(wrapper)
  await flushPromises()
  return wrapper
}
type Wrapper = Awaited<ReturnType<typeof render>>
async function review(wrapper: Wrapper) {
  await wrapper.get('[data-batch-action]').setValue('picking')
  await wrapper.get('[data-batch-reason]').setValue('Preparación explícita del lote sintético.')
  await wrapper.get('[data-batch-preview]').trigger('click')
  await flushPromises()
}
async function commit(wrapper: Wrapper) {
  await wrapper.get('[data-batch-consent]').setValue(true)
  await wrapper.get('[data-batch-confirm]').trigger('click')
  await flushPromises()
  await vi.waitFor(() => expect(wrapper.attributes('aria-busy')).not.toBe('true'))
}
const commands = () =>
  mocks.request.mock.calls.filter(([path, options]) => path === ROOT + '/commands' && options.method === 'POST')
beforeEach(() => {
  session = makeSession()
  caps = ref({
    source: 'cloudflare',
    state: 'ready',
    identityId: ACTOR,
    sessionId: SESSION,
    sessionVersion: 1,
    permissions: ['administration.manage']
  })
  mocks.session.mockReturnValue(session)
  mocks.navigation.mockReturnValue({ status: ref('ready'), capabilities: caps })
  mocks.runtime.mockReturnValue({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'cloudflare' }
  })
  commandReceipt = null
  mocks.request.mockReset().mockImplementation(async (path: string, options: Options) => {
    if (path === ROOT + '/preview') return preview()
    if (path === ROOT + '/commands') {
      commandReceipt = {
        source: 'cloudflare',
        commandId: options.headers!['Idempotency-Key']!,
        payloadHash: await adminOrderBulkIntentHash(options.body),
        groupId: GROUP,
        dispatchId: DISPATCH,
        previewHash: HASH,
        selected: 2,
        eligible: 1,
        blocked: 1,
        recordedAt: '2026-10-09T12:00:00Z'
      }
      return commandReceipt
    }
    if (path.includes('/commands/')) return { source: 'cloudflare', outcome: 'applied', receipt: commandReceipt }
    return group()
  })
})
afterEach(() => wrappers.splice(0).forEach((wrapper) => wrapper.unmount()))
describe('explicit selected-page bulk fulfillment preparation', () => {
  it('waits for explicit preview and sends one bounded set-based request with no client versions or per-order GETs', async () => {
    const wrapper = await render()
    expect(mocks.request).not.toHaveBeenCalled()
    expect(
      wrapper
        .get('[data-batch-action]')
        .findAll('option')
        .filter((option) => option.attributes('value'))
    ).toHaveLength(6)
    await review(wrapper)
    expect(mocks.request).toHaveBeenCalledExactlyOnceWith(
      ROOT + '/preview',
      expect.objectContaining({
        method: 'POST',
        body: { action: 'picking', orderIds: [FIRST, SECOND], reason: 'Preparación explícita del lote sintético.' },
        retry: 0,
        cache: 'no-store'
      })
    )
    expect(commands()).toHaveLength(0)
  })
  it('shows exact eligibility, exclusions, observed versions and no-stock/no-money impact without optimistic success', async () => {
    const wrapper = await render()
    await review(wrapper)
    expect(wrapper.get('[data-batch-review]').text()).toContain(FIRST)
    expect(wrapper.get('[data-batch-review]').text()).toContain(SECOND)
    expect(wrapper.get('[data-batch-review]').text()).toContain('Pago no confirmado')
    expect(wrapper.text()).toContain('No cambia existencias ni cobros')
    expect(wrapper.get('[data-batch-confirm]').attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-batch-results]').exists()).toBe(false)
  })
  it('rejects invalid inputs or required evidence and selection outside1..25 before preview', async () => {
    const wrapper = await render()
    await wrapper.get('[data-batch-action]').setValue('delivered')
    await wrapper.get('[data-batch-reason]').setValue('Motivo suficientemente largo')
    await wrapper.get('[data-batch-preview]').trigger('click')
    await flushPromises()
    expect(mocks.request).not.toHaveBeenCalled()
    await wrapper.setProps({ orderIds: [FIRST, FIRST] })
    await review(wrapper)
    expect(mocks.request).not.toHaveBeenCalled()
    await wrapper.setProps({
      orderIds: Array.from({ length: 26 }, (_, index) => `30000000-0000-4000-8000-${String(index).padStart(12, '0')}`)
    })
    await review(wrapper)
    expect(mocks.request).not.toHaveBeenCalled()
  })
  it('consumes the executed review so a terminal group cannot send a second UUID while preserving results', async () => {
    const wrapper = await render()
    await review(wrapper)
    await commit(wrapper)
    expect(wrapper.find('[data-batch-review]').exists()).toBe(false)
    expect(wrapper.find('[data-batch-confirm]').exists()).toBe(false)
    expect(wrapper.get('[data-batch-results]').text()).toContain('Confirmado')
    const state = wrapper.vm as unknown as { commit: () => Promise<void> }
    await state.commit()
    expect(commands()).toHaveLength(1)
  })
  it('accepts a correlated child receipt ID distinct from its idempotency key', async () => {
    const implementation = mocks.request.getMockImplementation()!
    mocks.request.mockImplementation(async (path: string, options: Options) => {
      if (path !== ROOT + '/' + GROUP) return implementation(path, options)
      const dto = group()
      dto.rows[0]!.receipt!.commandId = '80000000-0000-4000-8000-000000000001'
      return dto
    })
    const wrapper = await render()
    await review(wrapper)
    await commit(wrapper)
    expect(wrapper.emitted('confirmed')).toHaveLength(1)
    expect(wrapper.find('[data-batch-uncertain]').exists()).toBe(false)
    expect(wrapper.get('[data-batch-results]').text()).toContain('Confirmado')
    expect(commands()).toHaveLength(1)
  })
  it('confirms a consented command once with server-reviewed versions then exact fresh group and per-order results', async () => {
    const wrapper = await render()
    await review(wrapper)
    await commit(wrapper)
    expect(commands()).toHaveLength(1)
    expect(commands()[0]![1].body).toEqual({
      action: 'picking',
      orders: [
        { orderId: FIRST, expectedVersion: 0 },
        { orderId: SECOND, expectedVersion: 0 }
      ],
      reason: 'Preparación explícita del lote sintético.',
      previewHash: HASH
    })
    expect(wrapper.get('[data-batch-results]').text()).toContain('Confirmado')
    expect(wrapper.get('[data-batch-results]').text()).toContain('No intentado')
    expect(wrapper.emitted('confirmed')?.[0]).toEqual([group()])
    expect(wrapper.emitted('pending')?.at(-1)).toEqual([false])
    expect(
      mocks.request.mock.calls.some(([path, options]) => path === ROOT + '/' + GROUP && options.method === 'GET')
    ).toBe(true)
  })
  it('recovers a lost ACK through exact command GET and fresh paused group without rePOST or false success', async () => {
    const wrapper = await render()
    await review(wrapper)
    mocks.request.mockImplementationOnce(async (_path: string, options: Options) => {
      commandReceipt = {
        source: 'cloudflare',
        commandId: options.headers!['Idempotency-Key']!,
        payloadHash: await adminOrderBulkIntentHash(options.body),
        groupId: GROUP,
        dispatchId: DISPATCH,
        previewHash: HASH,
        selected: 2,
        eligible: 1,
        blocked: 1,
        recordedAt: '2026-10-09T12:00:00Z'
      }
      throw Error('lost committed ACK')
    })
    await commit(wrapper)
    expect(wrapper.get('[data-batch-uncertain]').exists()).toBe(true)
    mocks.request.mockImplementation(async (path: string) =>
      path.includes('/commands/') ? { source: 'cloudflare', outcome: 'applied', receipt: commandReceipt } : group(true)
    )
    await wrapper.get('[data-batch-recover]').trigger('click')
    await flushPromises()
    expect(commands()).toHaveLength(1)
    expect(wrapper.get('[data-batch-results]').text()).toContain('Resultado incierto')
    expect(wrapper.emitted('confirmed')).toBeUndefined()
    expect(wrapper.emitted('pending')?.at(-1)).toEqual([true])
    expect(mocks.request.mock.calls.find(([path]) => String(path).includes('/commands/'))?.[1].query.payloadHash).toBe(
      commandReceipt!.payloadHash
    )
  })
  it('does not interpret unknown receipt as absence, resend or poll automatically', async () => {
    const wrapper = await render()
    await review(wrapper)
    mocks.request.mockRejectedValueOnce(Error('lost'))
    await commit(wrapper)
    mocks.request.mockResolvedValueOnce({ source: 'cloudflare', outcome: 'unknown', receipt: null })
    await wrapper.get('[data-batch-recover]').trigger('click')
    await flushPromises()
    expect(commands()).toHaveLength(1)
    expect(wrapper.get('[data-batch-uncertain]').exists()).toBe(true)
    const count = mocks.request.mock.calls.length
    await flushPromises()
    expect(mocks.request).toHaveBeenCalledTimes(count)
  })
  it('invalidates reviewed facts and consent when selection, reason or action changes and ignores late preview', async () => {
    const wrapper = await render()
    await review(wrapper)
    await wrapper.get('[data-batch-reason]').setValue('Otro motivo explícito de preparación')
    expect(wrapper.find('[data-batch-review]').exists()).toBe(false)
    const waiting = deferred()
    mocks.request.mockReturnValueOnce(waiting.promise)
    await wrapper.get('[data-batch-preview]').trigger('click')
    await wrapper.setProps({ orderIds: [SECOND] })
    waiting.resolve(preview())
    await flushPromises()
    expect(wrapper.find('[data-batch-review]').exists()).toBe(false)
    expect(commands()).toHaveLength(0)
  })
  it('purges private reason, selection facts and late responses on authority or session changes', async () => {
    for (const boundary of ['session', 'identity', 'email', 'mfa', 'grant'] as const) {
      session = makeSession()
      caps.value = {
        source: 'cloudflare',
        state: 'ready',
        identityId: ACTOR,
        sessionId: SESSION,
        sessionVersion: 1,
        permissions: ['administration.manage']
      }
      mocks.session.mockReturnValue(session)
      const wrapper = await render(),
        waiting = deferred()
      mocks.request.mockReturnValueOnce(waiting.promise)
      await wrapper.get('[data-batch-action]').setValue('picking')
      await wrapper.get('[data-batch-reason]').setValue('Motivo privado que debe purgarse')
      await wrapper.get('[data-batch-preview]').trigger('click')
      if (boundary === 'session') session.session.value.sessionVersion = 2
      if (boundary === 'identity') session.user.value.id = SECOND
      if (boundary === 'email') session.user.value.emailVerified = false
      if (boundary === 'mfa') session.user.value.mfaVerified = false
      if (boundary === 'grant') caps.value = { ...(caps.value as object), permissions: [] }
      waiting.resolve(preview())
      await flushPromises()
      expect(wrapper.find('[data-batch-review]').exists()).toBe(false)
      expect(wrapper.vm.$.setupState.reason).toBe('')
      expect(wrapper.vm.$.setupState.intent).toBeNull()
    }
  })
  it('single-flights preview and commit, respects competing pending, and never self-deadlocks recovery', async () => {
    const wrapper = await render({ pending: true })
    await review(wrapper)
    expect(mocks.request).not.toHaveBeenCalled()
    await wrapper.setProps({ pending: false })
    const waiting = deferred()
    mocks.request.mockReturnValueOnce(waiting.promise)
    await review(wrapper)
    await wrapper.get('[data-batch-preview]').trigger('click')
    expect(mocks.request).toHaveBeenCalledTimes(1)
    waiting.resolve(preview())
    await flushPromises()
    mocks.request.mockRejectedValueOnce(Error('lost'))
    await commit(wrapper)
    await wrapper.get('[data-batch-confirm]').trigger('click')
    expect(commands()).toHaveLength(1)
    expect(wrapper.get('[data-batch-recover]').attributes('disabled')).toBeUndefined()
  })
  it('rejects foreign preview rows and mismatched command/group correlation without claiming success', async () => {
    const wrapper = await render()
    mocks.request.mockResolvedValueOnce({
      ...preview(),
      rows: [{ ...preview().rows[0], orderId: GROUP }, preview().rows[1]]
    })
    await review(wrapper)
    expect(wrapper.find('[data-batch-review]').exists()).toBe(false)
    await review(wrapper)
    mocks.request.mockResolvedValueOnce({
      source: 'cloudflare',
      commandId: GROUP,
      payloadHash: HASH,
      groupId: GROUP,
      dispatchId: DISPATCH,
      previewHash: HASH,
      selected: 2,
      eligible: 1,
      blocked: 1,
      recordedAt: '2026-10-09T12:00:00Z'
    })
    await commit(wrapper)
    expect(wrapper.emitted('confirmed')).toBeUndefined()
    expect(wrapper.get('[data-batch-uncertain]').exists()).toBe(true)
  })
  it('purges on server403 and emits pending false on unmount without keeping private body', async () => {
    const wrapper = await render()
    await review(wrapper)
    mocks.request.mockRejectedValueOnce({ statusCode: 403 })
    await commit(wrapper)
    expect(wrapper.vm.$.setupState.reason).toBe('')
    expect(wrapper.vm.$.setupState.intent).toBeNull()
    wrapper.unmount()
    expect(wrapper.emitted('pending')?.at(-1)).toEqual([false])
  })
  it('does not expose Cloudflare bulk controls or send requests in Node mode', async () => {
    mocks.runtime.mockReturnValue({
      app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
      public: { serverRuntime: 'node' }
    })
    const wrapper = await render()
    expect(wrapper.find('[data-batch-preview]').exists()).toBe(false)
    expect(mocks.request).not.toHaveBeenCalled()
  })
})
