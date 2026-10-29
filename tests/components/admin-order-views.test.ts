import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AdminOrderViews from '../../app/components/AdminOrderViews.vue'
import { adminOrderViewIntentHash } from '~~/shared/admin-order-views'
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
const ID = '30000000-0000-4000-8000-000000000001',
  ACTOR = '10000000-0000-4000-8000-000000000001',
  SESSION = '20000000-0000-4000-8000-000000000001'
const definition = () => ({
  bucket: 'todos',
  sortKey: 'createdAt',
  sortDir: 'desc',
  columns: ['createdAt', 'customer', 'total']
})
const view = (version = 1, archived = false) => ({
  id: ID,
  name: 'Mi cola privada',
  definition: definition(),
  version,
  archived,
  createdAt: '2026-10-09T12:00:00Z',
  updatedAt: '2026-10-09T12:00:00Z',
  archivedAt: archived ? '2026-10-09T12:00:00Z' : null
})
function deferred() {
  let resolve!: (value: unknown) => void
  const promise = new Promise((done) => {
    resolve = done
  })
  return { resolve, promise }
}
let session: {
  ready: ReturnType<typeof ref<boolean>>
  loggedIn: ReturnType<typeof ref<boolean>>
  user: ReturnType<typeof ref<{ id: string; emailVerified: boolean; mfaVerified: boolean }>>
  session: ReturnType<typeof ref<{ sessionId: string; sessionVersion: number }>>
}
type RequestOptions = { method?: string; headers: Record<string, string>; body: unknown }
const wrappers: Awaited<ReturnType<typeof mountSuspended>>[] = []
async function render(props = {}) {
  const wrapper = await mountSuspended(AdminOrderViews, {
    props: { scopeKey: 'scope-a', enabled: true, pending: false, appliedDefinition: definition(), ...props }
  })
  wrappers.push(wrapper)
  await flushPromises()
  return wrapper
}
async function load(wrapper: Awaited<ReturnType<typeof render>>) {
  await wrapper.get('[data-views-refresh]').trigger('click')
  await flushPromises()
}
async function choose(wrapper: Awaited<ReturnType<typeof render>>) {
  await load(wrapper)
  await wrapper.get('[data-views-select]').setValue(ID)
  await flushPromises()
}
async function create(wrapper: Awaited<ReturnType<typeof render>>) {
  await wrapper.get('[data-views-name]').setValue('Nueva cola')
  await wrapper.get('[data-views-create]').trigger('click')
  await flushPromises()
  await vi.waitFor(() => expect(wrapper.attributes('aria-busy')).not.toBe('true'))
}
const writes = () => mocks.request.mock.calls.filter(([, options]) => options?.method && options.method !== 'GET')
beforeEach(() => {
  session = {
    ready: ref(true),
    loggedIn: ref(true),
    user: ref({ id: ACTOR, emailVerified: true, mfaVerified: true }),
    session: ref({ sessionId: SESSION, sessionVersion: 1 })
  }
  mocks.session.mockReturnValue(session)
  mocks.navigation.mockReturnValue({
    status: ref('ready'),
    capabilities: ref({
      source: 'cloudflare',
      state: 'ready',
      identityId: ACTOR,
      sessionId: SESSION,
      sessionVersion: 1,
      permissions: ['administration.manage']
    })
  })
  mocks.runtime.mockReturnValue({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'cloudflare' }
  })
  mocks.request
    .mockReset()
    .mockImplementation(async (path: string) =>
      path === '/api/admin/order-views'
        ? { source: 'cloudflare', items: [view()] }
        : { source: 'cloudflare', view: view() }
    )
})
afterEach(() => wrappers.splice(0).forEach((wrapper) => wrapper.unmount()))
describe('owner-private saved order views', () => {
  it('does not read or write until an explicit GET and distinguishes empty from failure', async () => {
    const wrapper = await render()
    expect(mocks.request).not.toHaveBeenCalled()
    mocks.request.mockResolvedValueOnce({ source: 'cloudflare', items: [] })
    await load(wrapper)
    expect(wrapper.get('[data-views-empty]').text()).toContain('No hay vistas')
    mocks.request.mockRejectedValueOnce(new Error('outage'))
    await load(wrapper)
    expect(wrapper.find('[data-views-empty]').exists()).toBe(false)
    expect(wrapper.get('[data-views-error]').attributes('role')).toBe('alert')
  })
  it('selects via exact GET and applies only on explicit apply, never a mutation', async () => {
    const wrapper = await render()
    await choose(wrapper)
    expect(wrapper.emitted('apply')).toBeUndefined()
    expect(writes()).toHaveLength(0)
    expect(mocks.request.mock.calls.some(([path]) => path === '/api/admin/order-views/' + ID)).toBe(true)
    await wrapper.get('[data-views-apply]').trigger('click')
    expect(wrapper.emitted('apply')?.[0]).toEqual([definition()])
    expect(writes()).toHaveLength(0)
  })
  for (const action of ['create', 'update', 'archive'] as const)
    it(`confirms ${action} only after correlated receipt and fresh exact detail plus list`, async () => {
      const wrapper = await render()
      if (action !== 'create') await choose(wrapper)
      let committed = false
      mocks.request.mockImplementation(async (path: string, options: RequestOptions) => {
        if (options?.method !== 'GET') {
          committed = true
          return {
            source: 'cloudflare',
            commandId: options.headers['Idempotency-Key'],
            payloadHash: await adminOrderViewIntentHash(action, action === 'create' ? null : ID, options.body),
            action,
            viewId: ID,
            version: action === 'create' ? 1 : 2,
            recordedAt: '2026-10-09T12:00:00Z'
          }
        }
        const confirmed = {
          ...view(action === 'create' ? 1 : 2, action === 'archive'),
          name: action === 'create' ? 'Nueva cola' : 'Mi cola privada'
        }
        if (path === '/api/admin/order-views')
          return { source: 'cloudflare', items: action === 'archive' ? [] : [confirmed] }
        return { source: 'cloudflare', view: confirmed }
      })
      if (action === 'create') await create(wrapper)
      else {
        await wrapper.get('[data-views-' + action + ']').trigger('click')
        await flushPromises()
        await vi.waitFor(() => expect(wrapper.attributes('aria-busy')).not.toBe('true'))
      }
      expect(committed).toBe(true)
      expect(writes()).toHaveLength(1)
      expect(wrapper.get('[data-views-confirmed]').text()).toContain('confirmad')
      expect(wrapper.emitted('pending')?.at(-1)).toEqual([false])
    })
  it('never saves search text, paging, selection or rows with the applied configuration', async () => {
    const wrapper = await render()
    mocks.request.mockRejectedValueOnce(new Error('lost'))
    await create(wrapper)
    expect(writes()).toHaveLength(1)
    const body = writes()[0]![1].body
    expect(Object.keys(body).sort()).toEqual(['definition', 'name'])
    expect(body.definition).toEqual(definition())
    expect(JSON.stringify(body)).not.toMatch(/query|perPage|email|orderIds|selected/)
  })
  it('refuses a configuration containing a private search or unsupported column', async () => {
    const wrapper = await render({ appliedDefinition: { ...definition(), q: 'private customer' } })
    await create(wrapper)
    expect(writes()).toHaveLength(0)
    await wrapper.setProps({ appliedDefinition: { ...definition(), columns: ['email'] } })
    await create(wrapper)
    expect(writes()).toHaveLength(0)
  })
  it('retains uncertainty on lost ACK and unknown manual GET without an automatic POST retry', async () => {
    const wrapper = await render()
    mocks.request.mockRejectedValueOnce(new Error('lost'))
    await create(wrapper)
    expect(wrapper.get('[data-views-uncertain]').exists()).toBe(true)
    expect(wrapper.find('[data-views-confirmed]').exists()).toBe(false)
    mocks.request.mockResolvedValueOnce({ source: 'cloudflare', outcome: 'unknown', receipt: null })
    await wrapper.get('[data-views-recover]').trigger('click')
    await flushPromises()
    expect(writes()).toHaveLength(1)
    expect(wrapper.get('[data-views-uncertain]').exists()).toBe(true)
    const recovery = mocks.request.mock.calls.at(-1)!
    expect(recovery[1].method).toBe('GET')
    expect(recovery[1].query.payloadHash).toMatch(/^[a-f0-9]{64}$/)
  })
  it('recovers applied through the exact command then fresh detail and list with no second POST', async () => {
    const wrapper = await render()
    mocks.request.mockRejectedValueOnce(new Error('lost'))
    await create(wrapper)
    const options = writes()[0]![1]
    const receipt = {
      source: 'cloudflare',
      commandId: options.headers['Idempotency-Key'],
      payloadHash: await adminOrderViewIntentHash('create', null, options.body),
      action: 'create',
      viewId: ID,
      version: 1,
      recordedAt: '2026-10-09T12:00:00Z'
    }
    mocks.request.mockImplementation(async (path: string) =>
      path.includes('/commands/')
        ? { source: 'cloudflare', outcome: 'applied', receipt }
        : path === '/api/admin/order-views'
          ? { source: 'cloudflare', items: [{ ...view(), name: 'Nueva cola' }] }
          : { source: 'cloudflare', view: { ...view(), name: 'Nueva cola' } }
    )
    await wrapper.get('[data-views-recover]').trigger('click')
    await flushPromises()
    await vi.waitFor(() => expect(wrapper.attributes('aria-busy')).not.toBe('true'))
    expect(wrapper.get('[data-views-confirmed]').exists()).toBe(true)
    expect(writes()).toHaveLength(1)
  })
  it('preserves the editable draft on a definite initial version conflict without auto retry', async () => {
    const wrapper = await render()
    await choose(wrapper)
    await wrapper.get('[data-views-name]').setValue('Mi revisión conservada')
    mocks.request.mockRejectedValueOnce({ statusCode: 409, data: { error: { code: 'version_conflict' } } })
    await wrapper.get('[data-views-update]').trigger('click')
    await flushPromises()
    await vi.waitFor(() => expect(wrapper.attributes('aria-busy')).not.toBe('true'))
    expect((wrapper.get('[data-views-name]').element as HTMLInputElement).value).toBe('Mi revisión conservada')
    expect(wrapper.get('[data-views-conflict]').exists()).toBe(true)
    expect(writes()).toHaveLength(1)
    expect(wrapper.emitted('pending')?.at(-1)).toEqual([false])
    expect(wrapper.find('[data-views-confirmed]').exists()).toBe(false)
  })
  it('confirms historical create/update after lost ACK when a later owner operation archived the view, without recreating or applying it', async () => {
    for (const action of ['create', 'update'] as const) {
      mocks.request
        .mockReset()
        .mockImplementation(async (path: string) =>
          path === '/api/admin/order-views'
            ? { source: 'cloudflare', items: [view()] }
            : { source: 'cloudflare', view: view() }
        )
      const wrapper = await render()
      if (action === 'update') await choose(wrapper)
      mocks.request.mockRejectedValueOnce(new Error('lost committed response'))
      if (action === 'create') await create(wrapper)
      else {
        await wrapper.get('[data-views-update]').trigger('click')
        await flushPromises()
        await vi.waitFor(() => expect(wrapper.attributes('aria-busy')).not.toBe('true'))
      }
      const options = writes()[0]![1]
      const receipt = {
        source: 'cloudflare',
        commandId: options.headers['Idempotency-Key'],
        payloadHash: await adminOrderViewIntentHash(action, action === 'create' ? null : ID, options.body),
        action,
        viewId: ID,
        version: action === 'create' ? 1 : 2,
        recordedAt: '2026-10-09T12:00:00Z'
      }
      mocks.request.mockImplementation(async (path: string) =>
        path.includes('/commands/')
          ? { source: 'cloudflare', outcome: 'applied', receipt }
          : path === '/api/admin/order-views'
            ? { source: 'cloudflare', items: [] }
            : { source: 'cloudflare', view: view(receipt.version + 1, true) }
      )
      await wrapper.get('[data-views-recover]').trigger('click')
      await flushPromises()
      await vi.waitFor(() => expect(wrapper.attributes('aria-busy')).not.toBe('true'))
      expect(wrapper.get('[data-views-confirmed]').text()).toContain('archivada posteriormente')
      expect(wrapper.vm.$.setupState.intent).toBeNull()
      expect(wrapper.find('[data-views-uncertain]').exists()).toBe(false)
      expect(wrapper.find('[data-views-apply]').exists()).toBe(false)
      expect(wrapper.emitted('apply')).toBeUndefined()
      expect(writes()).toHaveLength(1)
      expect(wrapper.emitted('pending')?.at(-1)).toEqual([false])
    }
  })
  it('rejects a receipt correlated to another command as uncertain rather than success', async () => {
    const wrapper = await render()
    mocks.request.mockImplementationOnce(async (_path: string, options: RequestOptions) => ({
      source: 'cloudflare',
      commandId: '40000000-0000-4000-8000-000000000099',
      payloadHash: await adminOrderViewIntentHash('create', null, options.body),
      action: 'create',
      viewId: ID,
      version: 1,
      recordedAt: '2026-10-09T12:00:00Z'
    }))
    await create(wrapper)
    expect(wrapper.find('[data-views-confirmed]').exists()).toBe(false)
    expect(wrapper.get('[data-views-uncertain]').exists()).toBe(true)
  })
  it('does not announce success or discard intention when fresh confirmation GET fails', async () => {
    const wrapper = await render()
    mocks.request.mockImplementation(async (_path: string, options: RequestOptions) => {
      if (options.method === 'GET') throw new Error('read outage')
      return {
        source: 'cloudflare',
        action: 'create',
        commandId: options.headers['Idempotency-Key'],
        payloadHash: await adminOrderViewIntentHash('create', null, options.body),
        viewId: ID,
        version: 1,
        recordedAt: '2026-10-09T12:00:00Z'
      }
    })
    await create(wrapper)
    expect(wrapper.find('[data-views-confirmed]').exists()).toBe(false)
    expect(wrapper.get('[data-views-uncertain]').exists()).toBe(true)
  })
  it('rejects a mismatched exact detail instead of applying another view', async () => {
    const wrapper = await render()
    await load(wrapper)
    mocks.request.mockResolvedValueOnce({
      source: 'cloudflare',
      view: { ...view(), id: '30000000-0000-4000-8000-000000000002' }
    })
    await wrapper.get('[data-views-select]').setValue(ID)
    await flushPromises()
    expect(wrapper.find('[data-views-apply]').exists()).toBe(false)
    expect(wrapper.emitted('apply')).toBeUndefined()
  })
  for (const boundary of ['identity', 'session', 'email', 'mfa', 'scope'] as const)
    it(`purges private draft and late GET at ${boundary} boundary`, async () => {
      const waiting = deferred(),
        wrapper = await render()
      await wrapper.get('[data-views-name]').setValue('Nombre privado')
      mocks.request.mockReturnValueOnce(waiting.promise)
      await wrapper.get('[data-views-refresh]').trigger('click')
      if (boundary === 'identity')
        session.user.value = { ...session.user.value, id: '10000000-0000-4000-8000-000000000002' }
      if (boundary === 'session') session.session.value = { ...session.session.value, sessionVersion: 2 }
      if (boundary === 'email') session.user.value.emailVerified = false
      if (boundary === 'mfa') session.user.value.mfaVerified = false
      if (boundary === 'scope') await wrapper.setProps({ scopeKey: 'scope-b' })
      await flushPromises()
      waiting.resolve({ source: 'cloudflare', items: [view()] })
      await flushPromises()
      expect(wrapper.text()).not.toContain('Mi cola privada')
      expect(wrapper.text()).not.toContain('Nombre privado')
      const input = wrapper.find('[data-views-name]')
      expect(input.exists() ? (input.element as HTMLInputElement).value : '').toBe('')
      expect(wrapper.vm.$.setupState.name).toBe('')
    })
  it('single-flights GET and mutation and respects competing pending without self echo', async () => {
    const waiting = deferred(),
      wrapper = await render()
    mocks.request.mockReturnValueOnce(waiting.promise)
    await wrapper.get('[data-views-refresh]').trigger('click')
    await wrapper.get('[data-views-refresh]').trigger('click')
    expect(mocks.request).toHaveBeenCalledTimes(1)
    waiting.resolve({ source: 'cloudflare', items: [] })
    await flushPromises()
    await wrapper.setProps({ pending: true })
    await create(wrapper)
    expect(writes()).toHaveLength(0)
    await wrapper.setProps({ pending: false })
    mocks.request.mockRejectedValueOnce(new Error('lost'))
    await create(wrapper)
    await create(wrapper)
    expect(writes()).toHaveLength(1)
    expect(wrapper.get('[data-views-recover]').attributes('disabled')).toBeUndefined()
  })
  it('purges private memory after server403 and unmounts pending false', async () => {
    const wrapper = await render()
    await wrapper.get('[data-views-name]').setValue('Nombre privado')
    mocks.request.mockRejectedValueOnce({ statusCode: 403 })
    await create(wrapper)
    const input = wrapper.find('[data-views-name]')
    expect(input.exists() ? (input.element as HTMLInputElement).value : '').toBe('')
    expect(wrapper.vm.$.setupState.name).toBe('')
    wrapper.unmount()
    expect(wrapper.emitted('pending')?.at(-1)).toEqual([false])
  })
  it('keeps Node inactive without reading private Cloudflare endpoints', async () => {
    mocks.runtime.mockReturnValue({
      app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
      public: { serverRuntime: 'node' }
    })
    const wrapper = await render()
    expect(wrapper.find('[data-views-refresh]').exists()).toBe(false)
    expect(mocks.request).not.toHaveBeenCalled()
  })
})
