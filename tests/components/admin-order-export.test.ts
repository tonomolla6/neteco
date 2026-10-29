import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import AdminOrderExport from '../../app/components/AdminOrderExport.vue'
import { ORDER_EXPORT_COLUMNS, ORDER_EXPORT_MAX_BYTES, ORDER_EXPORT_MAX_ROWS } from '../../shared/order-export'
import { csvCell } from '../../server/utils/csv'
import '#app/nuxt-vitest-app-entry'

// Matrix: explicit GET of applied filters only; strict CSV+metadata/limits;
// distinct loading/error/empty; singleflight; scope/query/authority abort+purge;
// no late files; private fixed filename; temporary link and URL cleanup.
const mocks = vi.hoisted(() => ({ raw: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => ({ raw: mocks.raw }))
const QUERY = { q: 'cliente sintético', bucket: 'todos', sortKey: 'createdAt', sortDir: 'desc' }
const ROOT = '/api/admin/orders/export.csv'
const mounted: Array<{ unmount: () => void }> = []
let create: ReturnType<typeof vi.fn>, revoke: ReturnType<typeof vi.fn>, click: MockInstance<() => void>
const files: Array<{ bytes: Uint8Array; type: string }> = []
function csv(rows = 1) {
  return (
    '\uFEFF' +
    [
      ORDER_EXPORT_COLUMNS.map(csvCell).join(','),
      ...Array.from({ length: rows }, () =>
        ORDER_EXPORT_COLUMNS.map((_, index) =>
          csvCell(index === 0 ? '10000000-0000-4000-8000-000000000001' : index === 13 ? 12100 : 'dato sintético')
        ).join(',')
      )
    ].join('\r\n') +
    '\r\n'
  )
}
function response(text = csv(), count = 1, changes: Record<string, string> = {}) {
  const bytes = new TextEncoder().encode(text)
  return {
    ok: true,
    status: 200,
    headers: new Headers({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="neteco-pedidos.csv"',
      'Cache-Control': 'private, no-store',
      'X-Neteco-Export-Source': 'cloudflare',
      'X-Neteco-Export-Rows': String(count),
      'X-Neteco-Export-Bytes': String(bytes.byteLength),
      ...changes
    }),
    _data: bytes.buffer
  }
}
function deferred() {
  let resolve!: (value: unknown) => void
  const promise = new Promise<unknown>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
async function render(props = {}) {
  const wrapper = await mountSuspended(AdminOrderExport, {
    props: { scopeKey: 'identity/session/1', enabled: true, pending: false, appliedQuery: { ...QUERY }, ...props }
  })
  mounted.push(wrapper)
  await flushPromises()
  return wrapper
}
type Wrapper = Awaited<ReturnType<typeof render>>
async function download(wrapper: Wrapper) {
  await wrapper.get('[data-order-export-download]').trigger('click')
  await flushPromises()
}
beforeEach(() => {
  mocks.raw.mockReset().mockImplementation(async () => response())
  files.splice(0)
  const NativeBlob = Blob
  vi.stubGlobal(
    'Blob',
    class extends NativeBlob {
      constructor(parts: BlobPart[], options: BlobPropertyBag) {
        super(parts, options)
        if (!(parts[0] instanceof ArrayBuffer)) throw new Error('owned_buffer_required')
        files.push({ bytes: new Uint8Array(parts[0]).slice(), type: this.type })
      }
    }
  )
  create = vi.fn(() => `blob:test-order-${files.length}`)
  revoke = vi.fn()
  vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: create, revokeObjectURL: revoke }))
  click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
})
afterEach(() => {
  mounted.splice(0).forEach((wrapper) => wrapper.unmount())
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
describe('private export of applied admin order filters', () => {
  it('reports its GET in flight to block competing context and releases on completion or purge', async () => {
    const waiting = deferred(),
      wrapper = await render()
    mocks.raw.mockReturnValueOnce(waiting.promise)
    await download(wrapper)
    expect(wrapper.emitted('pending')?.at(-1)).toEqual([true])
    waiting.resolve(response())
    await flushPromises()
    expect(wrapper.emitted('pending')?.at(-1)).toEqual([false])
    const next = deferred()
    mocks.raw.mockReturnValueOnce(next.promise)
    await download(wrapper)
    await wrapper.setProps({ scopeKey: 'other-owner/session/1' })
    expect(wrapper.emitted('pending')?.at(-1)).toEqual([false])
    next.resolve(response())
    await flushPromises()
    expect(files).toHaveLength(1)
  })
  it('does not fetch until an accessible explicit button is activated', async () => {
    const wrapper = await render()
    expect(mocks.raw).not.toHaveBeenCalled()
    expect(wrapper.get('[data-order-export-download]').element.tagName).toBe('BUTTON')
    expect(wrapper.get('[data-order-export-download]').attributes('type')).toBe('button')
    expect(wrapper.text()).toContain('filtros aplicados')
  })
  it('GETs the frozen applied query privately and downloads exact safe CSV with fixed filename', async () => {
    let dispatchedQuery: unknown
    mocks.raw.mockImplementationOnce(async (_path, options) => {
      // Capture the wire input before completion intentionally wipes its private
      // mutable copy. Mock call references are not historical snapshots.
      dispatchedQuery = structuredClone(options.query)
      return response()
    })
    const wrapper = await render()
    await download(wrapper)
    expect(mocks.raw).toHaveBeenCalledExactlyOnceWith(
      ROOT,
      expect.objectContaining({
        method: 'GET',
        query: expect.any(Object),
        responseType: 'arrayBuffer',
        cache: 'no-store',
        retry: 0,
        credentials: 'same-origin',
        referrerPolicy: 'no-referrer'
      })
    )
    expect(dispatchedQuery).toEqual(QUERY)
    expect(files).toHaveLength(1)
    expect(new TextDecoder('utf-8', { ignoreBOM: true }).decode(files[0]!.bytes)).toBe(csv())
    expect(files[0]!.type).toBe('text/csv;charset=utf-8')
    const link = click.mock.instances[0] as HTMLAnchorElement
    expect(link.download).toBe('neteco-pedidos.csv')
    expect(link.isConnected).toBe(false)
    expect(wrapper.get('[data-order-export-success]').text()).toContain('1')
    expect(revoke).toHaveBeenCalledWith('blob:test-order-1')
  })
  it.each([{ enabled: false }, { pending: true }, { scopeKey: '' }])(
    'hides with no fetch/file for %j',
    async (props) => {
      const wrapper = await render(props)
      expect(wrapper.text()).toBe('')
      expect(mocks.raw).not.toHaveBeenCalled()
      expect(create).not.toHaveBeenCalled()
    }
  )
  it.each([{ page: '2' }, { perPage: '25' }, { unknown: 'private' }, { q: 'x'.repeat(121) }, { q: 'unsafe\nquery' }])(
    'rejects invalid applied query before GET: %j',
    async (changes) => {
      const wrapper = await render({ appliedQuery: { ...QUERY, ...changes } })
      expect(wrapper.get('[data-order-export-download]').attributes('disabled')).toBeDefined()
      expect(wrapper.find('[data-order-export-error]').exists()).toBe(true)
      expect(mocks.raw).not.toHaveBeenCalled()
    }
  )
  it('singleflights repeated clicks and makes every later download a fresh explicit GET', async () => {
    const waiting = deferred()
    mocks.raw.mockReturnValueOnce(waiting.promise)
    const wrapper = await render()
    await download(wrapper)
    expect(wrapper.get('[data-order-export-loading]').attributes('role')).toBe('status')
    await download(wrapper)
    expect(mocks.raw).toHaveBeenCalledTimes(1)
    waiting.resolve(response())
    await flushPromises()
    await download(wrapper)
    expect(mocks.raw).toHaveBeenCalledTimes(2)
  })
  it.each([401, 403, 409, 429, 503])('never downloads a rejected %i response', async (status) => {
    mocks.raw.mockRejectedValueOnce({ statusCode: status })
    const wrapper = await render()
    await download(wrapper)
    expect(wrapper.get('[data-order-export-error]').attributes('role')).toBe('alert')
    expect(create).not.toHaveBeenCalled()
    expect(click).not.toHaveBeenCalled()
  })
  it.each([
    ['content-type', 'text/html'],
    ['content-disposition', 'inline'],
    ['x-neteco-export-source', 'postgres'],
    ['x-neteco-export-rows', String(ORDER_EXPORT_MAX_ROWS + 1)],
    ['x-neteco-export-bytes', String(ORDER_EXPORT_MAX_BYTES + 1)],
    ['x-neteco-export-rows', '2'],
    ['x-neteco-export-bytes', '1'],
    ['cache-control', 'public, max-age=60']
  ])('rejects invalid response metadata %s=%s', async (header, value) => {
    mocks.raw.mockResolvedValueOnce(response(csv(), 1, { [header!]: value! }))
    const wrapper = await render()
    await download(wrapper)
    expect(wrapper.find('[data-order-export-error]').exists()).toBe(true)
    expect(create).not.toHaveBeenCalled()
  })
  it.each(['missing-bom', 'bad-header', 'bad-width', 'bad-utf8', 'html', 'oversize'])(
    'rejects invalid CSV %s without a file',
    async (mode) => {
      const text =
        mode === 'missing-bom'
          ? csv().slice(1)
          : mode === 'bad-header'
            ? csv().replace(ORDER_EXPORT_COLUMNS[0], 'private')
            : mode === 'bad-width'
              ? '\uFEFF' + ORDER_EXPORT_COLUMNS.map(csvCell).join(',') + '\r\n"only one"\r\n'
              : mode === 'html'
                ? '\uFEFF<html>private</html>'
                : csv()
      const raw = response(text)
      if (mode === 'bad-utf8') raw._data = new Uint8Array([239, 187, 191, 255]).buffer
      if (mode === 'oversize') raw._data = new Uint8Array(ORDER_EXPORT_MAX_BYTES + 1).buffer
      mocks.raw.mockResolvedValueOnce(raw)
      const wrapper = await render()
      await download(wrapper)
      expect(wrapper.find('[data-order-export-error]').exists()).toBe(true)
      expect(create).not.toHaveBeenCalled()
    }
  )
  it('distinguishes a confirmed zero-row CSV from failure', async () => {
    mocks.raw.mockResolvedValueOnce(response(csv(0), 0))
    const wrapper = await render()
    await download(wrapper)
    expect(wrapper.get('[data-order-export-empty]').text()).toContain('Sin pedidos')
    expect(wrapper.find('[data-order-export-error]').exists()).toBe(false)
    expect(files).toHaveLength(1)
  })
  it('accepts escaped quotes, commas and embedded newlines without altering server-safe CSV', async () => {
    const body =
      '\uFEFF' +
      ORDER_EXPORT_COLUMNS.map(csvCell).join(',') +
      '\r\n' +
      ORDER_EXPORT_COLUMNS.map((_, index) => csvCell(index === 1 ? '=formula,"quoted"\nsecond line' : 'value')).join(
        ','
      ) +
      '\r\n'
    mocks.raw.mockResolvedValueOnce(response(body))
    const wrapper = await render()
    await download(wrapper)
    expect(new TextDecoder('utf-8', { ignoreBOM: true }).decode(files[0]!.bytes)).toBe(body)
  })
  it.each([null, {}, { ok: false }, { ...response(), _data: '<html>private</html>' }])(
    'rejects malformed transport %j without a file',
    async (raw) => {
      mocks.raw.mockResolvedValueOnce(raw)
      const wrapper = await render()
      await download(wrapper)
      expect(wrapper.find('[data-order-export-error]').exists()).toBe(true)
      expect(create).not.toHaveBeenCalled()
    }
  )
  it.each([
    { scopeKey: 'other/session/1' },
    { enabled: false },
    { pending: true },
    { appliedQuery: { ...QUERY, q: 'otra consulta' } }
  ])('aborts and discards a late response across %j without automatic GET', async (props) => {
    const waiting = deferred()
    mocks.raw.mockReturnValueOnce(waiting.promise)
    const wrapper = await render()
    await download(wrapper)
    const signal = mocks.raw.mock.calls[0]![1].signal as AbortSignal
    await wrapper.setProps(props)
    expect(signal.aborted).toBe(true)
    waiting.resolve(response())
    await flushPromises()
    expect(mocks.raw).toHaveBeenCalledTimes(1)
    expect(files).toHaveLength(0)
    expect(wrapper.find('[data-order-export-success]').exists()).toBe(false)
  })
  it('clears previous outcome and private query on revocation and needs explicit click after regrant', async () => {
    const wrapper = await render()
    await download(wrapper)
    await wrapper.setProps({ enabled: false })
    expect(wrapper.text()).toBe('')
    await wrapper.setProps({ enabled: true, scopeKey: 'other/session/1', appliedQuery: { ...QUERY, q: '' } })
    expect(wrapper.text()).not.toContain(QUERY.q)
    expect(wrapper.find('[data-order-export-success]').exists()).toBe(false)
    expect(mocks.raw).toHaveBeenCalledTimes(1)
  })
  it('aborts unmount and never creates an orphaned file from a late response', async () => {
    const waiting = deferred()
    mocks.raw.mockReturnValueOnce(waiting.promise)
    const wrapper = await render()
    await download(wrapper)
    const signal = mocks.raw.mock.calls[0]![1].signal as AbortSignal
    wrapper.unmount()
    expect(signal.aborted).toBe(true)
    waiting.resolve(response())
    await flushPromises()
    expect(create).not.toHaveBeenCalled()
  })
})
