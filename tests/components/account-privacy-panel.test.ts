import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Panel from '../../app/components/AccountPrivacyPanel.vue'
import '#app/nuxt-vitest-app-entry'
const mocks = vi.hoisted(() => ({ request: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => mocks.request)
mockNuxtImport('useRuntimeConfig', () => () => ({
  app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
  public: { serverRuntime: 'cloudflare' }
}))
const ID = '10000000-0000-4000-8000-000000000065',
  KEY = '20000000-0000-4000-8000-000000000065'
const receipt = (commandId = KEY, requestType: 'export' | 'anonymize' = 'export') => ({
  id: ID,
  commandId,
  requestType,
  status: requestType === 'export' ? 'completed' : 'requested',
  requestedAt: '2026-10-08T12:00:00Z',
  dueAt: '2026-11-07T12:00:00Z',
  completedAt: requestType === 'export' ? '2026-10-08T12:00:00Z' : null
})
const state = (requests: unknown[] = []) => ({ source: 'cloudflare', requests })
type Wrapper = Awaited<ReturnType<typeof mountSuspended>>
const wrappers: Wrapper[] = []
const posts = () => mocks.request.mock.calls.filter((c) => c[1]?.method === 'POST')
async function render(props = {}) {
  const w = await mountSuspended(Panel, {
    props: { scopeKey: 'owner/session/1', enabled: true, pending: false, ...props }
  })
  wrappers.push(w)
  await flushPromises()
  return w
}
async function submit(w: Wrapper, type = 'export') {
  await w.get('select').setValue(type)
  await w.get('input[type=checkbox]').setValue(true)
  await w.get('form').trigger('submit')
  await flushPromises()
}
beforeEach(() => mocks.request.mockReset().mockResolvedValue(state()))
afterEach(() => wrappers.splice(0).forEach((w) => w.unmount()))
it('loads an authorized private snapshot without POST or download', async () => {
  const w = await render()
  expect(mocks.request).toHaveBeenCalledExactlyOnceWith(
    '/api/account/privacy',
    expect.objectContaining({ method: 'GET', retry: 0, cache: 'no-store' })
  )
  expect(w.text()).toContain('No hay solicitudes')
  expect(posts()).toHaveLength(0)
})
it.each([{ enabled: false }, { pending: true }, { scopeKey: '' }])(
  'does not read or expose private state when %j',
  async (props) => {
    const w = await render(props)
    expect(w.text()).toBe('')
    expect(mocks.request).not.toHaveBeenCalled()
  }
)
it('requires explicit confirmation and preserves legal/operational limitation', async () => {
  const w = await render()
  await w.get('form').trigger('submit')
  expect(posts()).toHaveLength(0)
  expect(w.text()).toContain('no borra')
  expect(w.text()).toContain('operativo')
})
it('confirms only correlated ACK followed by matching fresh state', async () => {
  mocks.request.mockImplementation(async (_path, opts = {}) => {
    if (opts.method === 'POST') return receipt(opts.body.idempotencyKey)
    if (posts().length) return state([receipt(posts()[0]![1].body.idempotencyKey)])
    return state()
  })
  const w = await render()
  await submit(w)
  expect(w.text()).toContain('Solicitud confirmada')
  expect(w.get('a[download]').attributes('href')).toBe(`/api/account/privacy/${ID}/download`)
  expect(w.emitted('confirmed')).toHaveLength(1)
})
it.each(['failed', 'stale', 'malformed'])('does not proclaim success after ACK and %s GET', async (mode) => {
  mocks.request.mockImplementation(async (_path, opts = {}) => {
    if (opts.method === 'POST') return receipt(opts.body.idempotencyKey)
    if (_path === '/api/account/privacy' && opts.method === 'GET' && posts().length) {
      if (mode === 'failed') throw new Error('private backend')
      if (mode === 'malformed') return { source: 'other', requests: [] }
      return state()
    }
    return state()
  })
  const w = await render()
  await submit(w)
  expect(w.text()).toContain('No se ha podido confirmar')
  expect(w.text()).not.toContain('Solicitud confirmada')
  expect(w.emitted('pending')?.at(-1)).toEqual([true])
  expect(w.emitted('confirmed')).toBeUndefined()
})
it('keeps unknown intent and retries only exact original body/key explicitly', async () => {
  mocks.request.mockImplementation(async (_p, o = {}) => {
    if (o.method === 'POST') throw new Error('lost')
    return state()
  })
  const w = await render()
  await submit(w, 'anonymize')
  const first = posts()[0]![1]
  expect(posts()).toHaveLength(1)
  await w.get('[data-privacy-retry]').trigger('click')
  await flushPromises()
  expect(posts()).toHaveLength(2)
  expect(posts()[1]![1].body).toEqual(first.body)
  expect(posts()[1]![1].headers).toEqual(first.headers)
  expect(w.text()).not.toContain('private backend')
})
it('manual receipt recovery does not POST and unknown retains ambiguity', async () => {
  mocks.request.mockImplementation(async (path, o = {}) => {
    if (o.method === 'POST') throw new Error('lost')
    if (String(path).includes('/commands/'))
      return { source: 'cloudflare', commandId: posts()[0]![1].body.idempotencyKey, outcome: 'unknown', receipt: null }
    return state()
  })
  const w = await render()
  await submit(w)
  await w.get('[data-privacy-recover]').trigger('click')
  await flushPromises()
  expect(posts()).toHaveLength(1)
  expect(w.emitted('pending')?.at(-1)).toEqual([true])
  expect(w.text()).toContain('No se ha podido confirmar')
})
it('purges all old requests and intention on owner/session change, without reusing old query', async () => {
  mocks.request.mockResolvedValue(state([receipt()]))
  const w = await render()
  expect(w.find('a[download]').exists()).toBe(true)
  await w.setProps({ scopeKey: 'another/session/2' })
  await flushPromises()
  expect(w.find('a[download]').exists()).toBe(false)
  expect(w.text()).not.toContain(ID)
  expect(posts()).toHaveLength(0)
})
it('ignores late read after scope invalidation and disposal', async () => {
  let resolve!: (v: unknown) => void
  mocks.request.mockReturnValueOnce(
    new Promise((r) => {
      resolve = r
    })
  )
  const w = await render()
  const signal = mocks.request.mock.calls[0]![1].signal as AbortSignal
  await w.setProps({ enabled: false })
  expect(signal.aborted).toBe(true)
  resolve(state([receipt()]))
  await flushPromises()
  expect(w.text()).toBe('')
  w.unmount()
})
it('singleflights a double submit', async () => {
  mocks.request.mockImplementation(async (_p, o = {}) => (o.method === 'POST' ? new Promise(() => {}) : state()))
  const w = await render()
  await submit(w)
  await w.get('form').trigger('submit')
  expect(posts()).toHaveLength(1)
  w.unmount()
  expect(w.emitted('pending')?.at(-1)).toEqual([false])
})
it('rejects mismatched receipt key and malformed download targets', async () => {
  mocks.request.mockImplementation(async (_p, o = {}) => (o.method === 'POST' ? receipt(KEY) : state()))
  const w = await render()
  await submit(w)
  expect(w.emitted('confirmed')).toBeUndefined()
  expect(w.find('a[download]').exists()).toBe(false)
})
