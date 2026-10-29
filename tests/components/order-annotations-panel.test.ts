import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import OrderAnnotationsPanel from '../../app/components/OrderAnnotationsPanel.vue'
import '#app/nuxt-vitest-app-entry'

// Matrix: private bounded authoritative read/pagination, plain author/date/text,
// explicit note+label CAS; frozen durable intent, manual receipt then fresh read;
// uncertain errors never success; singleflight/revocation/late/unmount purge.
const mocks = vi.hoisted(() => ({ request: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => mocks.request)
const ORDER = '10000000-0000-4000-8000-000000000001',
  OTHER = '10000000-0000-4000-8000-000000000002',
  AUTHOR = '20000000-0000-4000-8000-000000000001',
  NOTE = '30000000-0000-4000-8000-000000000001',
  NEXT = '30000000-0000-4000-8000-000000000002'
const root = `/api/admin/orders/${ORDER}/annotations`
const note = (id = NOTE, text = 'Nota interna sintética') => ({
  id,
  authorId: AUTHOR,
  createdAt: '2026-10-08T12:00:00Z',
  text
})
const state = () => ({
  source: 'cloudflare',
  orderId: ORDER,
  version: 4,
  labels: ['prioritario'],
  notes: [note()],
  nextCursor: null as string | null
})
const receipt = (key: string) => ({
  source: 'cloudflare',
  orderId: ORDER,
  commandId: key,
  version: 5,
  noteId: NEXT,
  labels: ['prioritario', 'revisar'],
  createdAt: '2026-10-08T12:01:00Z'
})
const updated = () => ({
  ...state(),
  version: 5,
  labels: ['prioritario', 'revisar'],
  notes: [{ ...note(NEXT, 'Nueva nota interna'), createdAt: '2026-10-08T12:01:00Z' }, note()]
})
function deferred() {
  let resolve!: (value: unknown) => void
  const promise = new Promise<unknown>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
type Wrapper = Awaited<ReturnType<typeof mountSuspended>>
const mounted: Wrapper[] = []
async function render(props = {}) {
  const wrapper = await mountSuspended(OrderAnnotationsPanel, {
    props: { orderId: ORDER, scopeKey: 'identity/session/1', enabled: true, pending: false, ...props }
  })
  mounted.push(wrapper)
  await flushPromises()
  return wrapper
}
async function fill(wrapper: Wrapper) {
  await wrapper.get('[data-annotations-note]').setValue('Nueva nota interna')
  await wrapper.get('[data-annotations-labels]').setValue('prioritario\nrevisar')
}
async function submit(wrapper: Wrapper) {
  await fill(wrapper)
  await wrapper.get('form').trigger('submit')
  await flushPromises()
}
const posts = () => mocks.request.mock.calls.filter((call) => call[1]?.method === 'POST')
beforeEach(() => {
  mocks.request.mockReset().mockImplementation(async () => state())
})
afterEach(() => mounted.splice(0).forEach((wrapper) => wrapper.unmount()))
describe('private order notes and label command panel', () => {
  it('reads current bounded notes once, with author/date and no automatic write', async () => {
    const wrapper = await render()
    expect(mocks.request).toHaveBeenCalledExactlyOnceWith(
      root,
      expect.objectContaining({ method: 'GET', query: { limit: 20 }, cache: 'no-store', retry: 0 })
    )
    expect(wrapper.text()).toContain(AUTHOR)
    expect(wrapper.get('time').attributes('datetime')).toBe('2026-10-08T12:00:00Z')
    expect(wrapper.get('[data-annotations-submit]').attributes('disabled')).toBeDefined()
    expect(posts()).toHaveLength(0)
  })
  it.each([{ enabled: false }, { pending: true }, { scopeKey: '' }, { orderId: '../private' }])(
    'hides with no read for %j',
    async (props) => {
      const wrapper = await render(props)
      expect(wrapper.text()).toBe('')
      expect(mocks.request).not.toHaveBeenCalled()
    }
  )
  it('distinguishes loading, failed read and confirmed empty notes', async () => {
    const waiting = deferred()
    mocks.request.mockReturnValueOnce(waiting.promise)
    const wrapper = await render()
    expect(wrapper.get('[data-annotations-loading]').attributes('role')).toBe('status')
    expect(wrapper.find('[data-annotations-empty]').exists()).toBe(false)
    waiting.resolve({})
    await flushPromises()
    expect(wrapper.get('[data-annotations-error]').attributes('role')).toBe('alert')
    expect(wrapper.find('form').exists()).toBe(false)
    mocks.request.mockResolvedValueOnce({ ...state(), notes: [], labels: [] })
    await wrapper.get('[data-annotations-refresh]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-annotations-empty]').exists()).toBe(true)
  })
  it('rejects non-plain internal note DTO without rendering HTML', async () => {
    mocks.request.mockResolvedValueOnce({ ...state(), notes: [note(NOTE, '<img src=x onerror=alert(1)>')] })
    const wrapper = await render()
    expect(wrapper.find('[data-annotations-error]').exists()).toBe(true)
    expect(wrapper.find('img').exists()).toBe(false)
  })
  it('paginates explicitly with a same-context cursor, appending without overwriting draft', async () => {
    mocks.request.mockResolvedValueOnce({ ...state(), nextCursor: NOTE })
    const wrapper = await render()
    await wrapper.get('[data-annotations-note]').setValue('Borrador sin enviar')
    expect(mocks.request).toHaveBeenCalledTimes(1)
    mocks.request.mockResolvedValueOnce({ ...state(), notes: [note(NEXT, 'Nota anterior')], nextCursor: null })
    await wrapper.get('[data-annotations-more]').trigger('click')
    await flushPromises()
    expect(mocks.request).toHaveBeenLastCalledWith(
      root,
      expect.objectContaining({ method: 'GET', query: { limit: 20, before: NOTE }, cache: 'no-store', retry: 0 })
    )
    expect(wrapper.text()).toContain('Nota anterior')
    expect(wrapper.text()).toContain('Nota interna sintética')
    expect((wrapper.get('[data-annotations-note]').element as HTMLTextAreaElement).value).toBe('Borrador sin enviar')
  })
  it('rejects changed version during pagination instead of mixing snapshots or mutating', async () => {
    mocks.request.mockResolvedValueOnce({ ...state(), nextCursor: NOTE })
    const wrapper = await render()
    mocks.request.mockResolvedValueOnce({ ...state(), version: 1, notes: [note(NEXT, 'Nueva autoridad de datos')] })
    await wrapper.get('[data-annotations-more]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-annotations-error]').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('Nueva autoridad de datos')
    expect(wrapper.get('[data-annotations-submit]').attributes('disabled')).toBeDefined()
    expect(posts()).toHaveLength(0)
  })
  it.each(['wrong-order', 'private-field', 'bad-label', 'bad-date'])(
    'rejects invalid read %s before form visibility',
    async (mode) => {
      mocks.request.mockResolvedValueOnce({
        ...state(),
        ...(mode === 'wrong-order'
          ? { orderId: OTHER }
          : mode === 'private-field'
            ? { secret: 'private' }
            : mode === 'bad-label'
              ? { labels: ['x'.repeat(41)] }
              : { notes: [{ ...note(), createdAt: 'yesterday' }] })
      })
      const wrapper = await render()
      expect(wrapper.find('[data-annotations-error]').exists()).toBe(true)
      expect(wrapper.find('form').exists()).toBe(false)
    }
  )
  it.each(['note-long', 'labels-nine', 'label-long', 'empty'])(
    'rejects %s input before allocating a POST',
    async (mode) => {
      const wrapper = await render()
      if (mode === 'note-long') await wrapper.get('[data-annotations-note]').setValue('x'.repeat(2001))
      if (mode === 'labels-nine')
        await wrapper
          .get('[data-annotations-labels]')
          .setValue(Array.from({ length: 9 }, (_, i) => 'label' + i).join('\n'))
      if (mode === 'label-long') await wrapper.get('[data-annotations-labels]').setValue('x'.repeat(41))
      await wrapper.get('form').trigger('submit')
      await flushPromises()
      expect(posts()).toHaveLength(0)
    }
  )
  it('submits explicit CAS note/labels and emits confirmed only after receipt plus fresh state', async () => {
    const wrapper = await render()
    mocks.request
      .mockImplementationOnce(async (_path: string, options: Record<string, unknown>) =>
        receipt((options.headers as Record<string, string>)['Idempotency-Key']!)
      )
      .mockResolvedValueOnce(updated())
    await submit(wrapper)
    const options = posts()[0]![1]
    expect(options.body).toEqual({ expectedVersion: 4, note: 'Nueva nota interna', labels: ['prioritario', 'revisar'] })
    expect(options.headers['Idempotency-Key']).toMatch(/^[a-f0-9-]{36}$/)
    expect(options.retry).toBe(0)
    expect(wrapper.find('[data-annotations-confirmed]').exists()).toBe(true)
    expect(wrapper.emitted('pending')).toEqual([[true], [false]])
    expect(wrapper.emitted('confirmed')).toEqual([[receipt(options.headers['Idempotency-Key'])]])
    expect((wrapper.get('[data-annotations-note]').element as HTMLTextAreaElement).value).toBe('')
  })
  it('singleflights double submit and disables edits during frozen command', async () => {
    const wrapper = await render(),
      waiting = deferred()
    mocks.request.mockReturnValueOnce(waiting.promise)
    await fill(wrapper)
    await wrapper.get('form').trigger('submit')
    await wrapper.get('form').trigger('submit')
    expect(posts()).toHaveLength(1)
    expect(wrapper.get('[data-annotations-note]').attributes('disabled')).toBeDefined()
    waiting.resolve({})
    await flushPromises()
    expect(wrapper.find('[data-annotations-unknown]').exists()).toBe(true)
  })
  it.each([400, 401, 403, 404, 409, 429, 503])(
    'retains rejected POST %i as unknown without exposing error details',
    async (statusCode) => {
      const wrapper = await render()
      mocks.request.mockRejectedValueOnce({ statusCode, message: 'SQL secret customer@example.invalid' })
      await submit(wrapper)
      expect(wrapper.find('[data-annotations-unknown]').exists()).toBe(true)
      expect(wrapper.find('[data-annotations-confirmed]').exists()).toBe(false)
      expect(wrapper.text()).not.toMatch(/SQL secret|customer@/)
      expect(posts()).toHaveLength(1)
      expect(wrapper.emitted('pending')).toEqual([[true]])
      expect(wrapper.get('[data-annotations-replay]').attributes('disabled')).toBeDefined()
    }
  )
  it('checks unknown manually before exact explicit replay using the same UUID and frozen body', async () => {
    const wrapper = await render()
    mocks.request.mockRejectedValueOnce(new Error('lost'))
    await submit(wrapper)
    const first = posts()[0]!,
      key = first[1].headers['Idempotency-Key']
    mocks.request.mockResolvedValueOnce({
      source: 'cloudflare',
      orderId: ORDER,
      commandId: key,
      outcome: 'unknown',
      receipt: null
    })
    await wrapper.get('[data-annotations-check]').trigger('click')
    await flushPromises()
    expect(mocks.request).toHaveBeenCalledWith(
      `${root}/commands/${key}`,
      expect.objectContaining({ method: 'GET', cache: 'no-store', retry: 0 })
    )
    expect(posts()).toHaveLength(1)
    mocks.request.mockResolvedValueOnce(receipt(key)).mockResolvedValueOnce(updated())
    await wrapper.get('[data-annotations-replay]').trigger('click')
    await flushPromises()
    expect(posts()[1]![1].body).toEqual(first[1].body)
    expect(posts()[1]![1].headers).toEqual(first[1].headers)
    expect(wrapper.find('[data-annotations-confirmed]').exists()).toBe(true)
  })
  it('resolves an impossible stale CAS only after a second unknown receipt, retaining note but adopting current labels for explicit new save', async () => {
    const wrapper = await render()
    mocks.request.mockRejectedValueOnce({ statusCode: 409 })
    await submit(wrapper)
    const original = posts()[0]!,
      key = original[1].headers['Idempotency-Key']
    const unknown = { source: 'cloudflare', orderId: ORDER, commandId: key, outcome: 'unknown', receipt: null }
    const fresh = { ...state(), version: 5, labels: ['etiqueta actual de otro administrador'] }
    mocks.request.mockResolvedValueOnce(unknown).mockResolvedValueOnce(fresh).mockResolvedValueOnce(unknown)
    const start = mocks.request.mock.calls.length
    await wrapper.get('[data-annotations-check]').trigger('click')
    await flushPromises()
    expect(mocks.request.mock.calls.slice(start).map((call) => call[0])).toEqual([
      `${root}/commands/${key}`,
      root,
      `${root}/commands/${key}`
    ])
    expect(posts()).toHaveLength(1)
    expect(wrapper.find('[data-annotations-conflict]').exists()).toBe(true)
    expect(wrapper.find('[data-annotations-unknown]').exists()).toBe(false)
    expect(wrapper.emitted('pending')).toEqual([[true], [false]])
    expect(wrapper.emitted('confirmed')).toBeUndefined()
    expect((wrapper.get('[data-annotations-note]').element as HTMLTextAreaElement).value).toBe('Nueva nota interna')
    expect((wrapper.get('[data-annotations-labels]').element as HTMLTextAreaElement).value).toBe(fresh.labels[0])
    mocks.request.mockRejectedValueOnce(new Error('new explicit response lost'))
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(posts()).toHaveLength(2)
    expect(posts()[1]![1].body).toEqual({ expectedVersion: 5, note: 'Nueva nota interna' })
    expect(posts()[1]![1].headers['Idempotency-Key']).not.toBe(key)
  })
  it('honors a receipt that becomes applied at the second lookup instead of falsely clearing the original intent', async () => {
    const wrapper = await render()
    mocks.request.mockRejectedValueOnce(new Error('lost'))
    await submit(wrapper)
    const key = posts()[0]![1].headers['Idempotency-Key']
    mocks.request
      .mockResolvedValueOnce({
        source: 'cloudflare',
        orderId: ORDER,
        commandId: key,
        outcome: 'unknown',
        receipt: null
      })
      .mockResolvedValueOnce(updated())
      .mockResolvedValueOnce({
        source: 'cloudflare',
        orderId: ORDER,
        commandId: key,
        outcome: 'applied',
        receipt: receipt(key)
      })
      .mockResolvedValueOnce(updated())
    await wrapper.get('[data-annotations-check]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-annotations-confirmed]').exists()).toBe(true)
    expect(wrapper.find('[data-annotations-conflict]').exists()).toBe(false)
    expect(posts()).toHaveLength(1)
    expect(wrapper.emitted('confirmed')).toEqual([[receipt(key)]])
  })
  it.each(['fresh-outage', 'fresh-schema', 'second-outage'])(
    'keeps the original command pending when stale-CAS proof fails: %s',
    async (mode) => {
      const wrapper = await render()
      mocks.request.mockRejectedValueOnce({ statusCode: 409 })
      await submit(wrapper)
      const key = posts()[0]![1].headers['Idempotency-Key']
      mocks.request.mockResolvedValueOnce({
        source: 'cloudflare',
        orderId: ORDER,
        commandId: key,
        outcome: 'unknown',
        receipt: null
      })
      if (mode === 'fresh-outage') mocks.request.mockRejectedValueOnce({ statusCode: 503 })
      else if (mode === 'fresh-schema') mocks.request.mockResolvedValueOnce({ ...updated(), orderId: OTHER })
      else mocks.request.mockResolvedValueOnce(updated()).mockRejectedValueOnce({ statusCode: 503 })
      await wrapper.get('[data-annotations-check]').trigger('click')
      await flushPromises()
      expect(wrapper.find('[data-annotations-unknown]').exists()).toBe(true)
      expect(wrapper.find('[data-annotations-conflict]').exists()).toBe(false)
      expect(wrapper.emitted('pending')).toEqual([[true]])
      expect(wrapper.emitted('confirmed')).toBeUndefined()
      expect(wrapper.get('[data-annotations-replay]').attributes('disabled')).toBeDefined()
      expect(posts()).toHaveLength(1)
    }
  )
  it('recovers an applied command via GET without another POST', async () => {
    const wrapper = await render()
    mocks.request.mockRejectedValueOnce(new Error('lost'))
    await submit(wrapper)
    const key = posts()[0]![1].headers['Idempotency-Key']
    mocks.request
      .mockResolvedValueOnce({
        source: 'cloudflare',
        orderId: ORDER,
        commandId: key,
        outcome: 'applied',
        receipt: receipt(key)
      })
      .mockResolvedValueOnce(updated())
    await wrapper.get('[data-annotations-check]').trigger('click')
    await flushPromises()
    expect(posts()).toHaveLength(1)
    expect(wrapper.find('[data-annotations-confirmed]').exists()).toBe(true)
  })
  it.each(['wrong-key', 'wrong-order', 'wrong-version', 'fresh-read-fails', 'fresh-stale', 'lookup404'])(
    'does not release uncertainty on %s',
    async (mode) => {
      const wrapper = await render()
      mocks.request.mockRejectedValueOnce(new Error('lost'))
      await submit(wrapper)
      const key = posts()[0]![1].headers['Idempotency-Key']
      if (mode === 'lookup404') mocks.request.mockRejectedValueOnce({ statusCode: 404 })
      else {
        mocks.request.mockResolvedValueOnce({
          source: 'cloudflare',
          orderId: ORDER,
          commandId: key,
          outcome: 'applied',
          receipt: {
            ...receipt(key),
            ...(mode === 'wrong-key'
              ? { commandId: OTHER }
              : mode === 'wrong-order'
                ? { orderId: OTHER }
                : mode === 'wrong-version'
                  ? { version: 9 }
                  : {})
          }
        })
        if (mode === 'fresh-read-fails') mocks.request.mockRejectedValueOnce({ statusCode: 403 })
        else mocks.request.mockResolvedValueOnce(mode === 'fresh-stale' ? state() : updated())
      }
      await wrapper.get('[data-annotations-check]').trigger('click')
      await flushPromises()
      expect(wrapper.find('[data-annotations-unknown]').exists()).toBe(true)
      expect(wrapper.emitted('confirmed')).toBeUndefined()
      expect(wrapper.emitted('pending')).toEqual([[true]])
    }
  )
  it.each(['scope', 'order', 'enabled', 'pending', 'unmount'])(
    'purges and aborts a late command on %s boundary',
    async (mode) => {
      const wrapper = await render(),
        waiting = deferred()
      mocks.request.mockReturnValueOnce(waiting.promise)
      await fill(wrapper)
      await wrapper.get('form').trigger('submit')
      const call = posts()[0]!,
        signal = call[1].signal as AbortSignal,
        key = call[1].headers['Idempotency-Key']
      if (mode === 'unmount') wrapper.unmount()
      else
        await wrapper.setProps(
          mode === 'scope'
            ? { scopeKey: 'other/session' }
            : mode === 'order'
              ? { orderId: OTHER }
              : mode === 'enabled'
                ? { enabled: false }
                : { pending: true }
        )
      expect(signal.aborted).toBe(true)
      waiting.resolve(receipt(key))
      await flushPromises()
      expect(wrapper.find('[data-annotations-confirmed]').exists()).toBe(false)
      expect(wrapper.emitted('pending')?.at(-1)).toEqual([false])
      expect(wrapper.emitted('confirmed')).toBeUndefined()
    }
  )
  it('has labeled native keyboard controls and wrapping layout', async () => {
    const wrapper = await render()
    expect(wrapper.findAll('label')).toHaveLength(2)
    expect(wrapper.get('[data-annotations-submit]').attributes('type')).toBe('submit')
    expect(wrapper.get('section').classes()).toContain('min-w-0')
    for (const element of wrapper.findAll('textarea')) expect(element.attributes('id')).toBeTruthy()
  })
})
