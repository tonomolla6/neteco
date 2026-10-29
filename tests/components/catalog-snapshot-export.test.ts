import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h, reactive, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import CatalogSnapshotExport from '../../app/components/CatalogSnapshotExport.vue'
import {
  CATALOG_EXPORT_COLUMNS,
  CATALOG_EXPORT_MAX_BYTES,
  CATALOG_EXPORT_PROFILE,
  CATALOG_EXPORT_SHEET_NAMES,
  catalogExportHash,
  type CatalogExportFilters,
  type CatalogExportSnapshot
} from '../../shared/catalog-export'
import '#app/nuxt-vitest-app-entry'

const { requestMock, sessionMock, xlsxMock } = vi.hoisted(() => ({
  requestMock: vi.fn(),
  sessionMock: vi.fn(),
  xlsxMock: vi.fn()
}))
mockNuxtImport('useRequestFetch', () => () => requestMock)
mockNuxtImport('useUserSession', () => sessionMock)
vi.mock('../../app/utils/catalog-export-xlsx.client', () => ({ exportCatalogSnapshotXlsx: xlsxMock }))
const ACTOR = '10000000-0000-4000-8000-000000000071',
  OTHER = '10000000-0000-4000-8000-000000000072',
  SNAPSHOT = '20000000-0000-4000-8000-000000000071',
  ROOT = '/api/admin/catalog/export/snapshot'
function session() {
  return {
    ready: ref(true),
    loggedIn: ref(true),
    user: ref<Record<string, unknown> | null>({
      id: ACTOR,
      role: 'admin',
      emailVerified: true,
      mfaVerified: true
    })
  }
}
async function fixture(filters: CatalogExportFilters = { q: '' }, empty = false): Promise<CatalogExportSnapshot> {
  const sheets = CATALOG_EXPORT_SHEET_NAMES.map((name) => {
    const columns = [...CATALOG_EXPORT_COLUMNS[name]],
      record: Record<string, string | number | boolean | null> = {}
    for (const column of columns.slice(0, -1)) record[column] = null
    if (name === 'Products')
      Object.assign(record, { id: SNAPSHOT, legacy_id: 71, name: 'Producto de prueba', featured: false })
    if (name === 'Variants')
      Object.assign(record, { id: SNAPSHOT, product_id: SNAPSHOT, price_gross_cents: 1234, currency: 'EUR' })
    if (name === 'Inventory')
      Object.assign(record, { variant_id: SNAPSHOT, physical_quantity: 3, blocked_quantity: 1, sellable_quantity: 2 })
    if (name === 'Prices') Object.assign(record, { id: SNAPSHOT, variant_id: SNAPSHOT, gross_cents: 1234 })
    if (name === 'Media') Object.assign(record, { id: SNAPSHOT, product_id: SNAPSHOT, title: '' })
    if (name === 'References') Object.assign(record, { kind: 'category', id: SNAPSHOT, name: 'Referencia de prueba' })
    const row = columns.slice(0, -1).map((column) => {
      const value = record[column] ?? null
      return value === null ? '' : typeof value === 'string' ? value : String(value)
    })
    row.push(JSON.stringify(record))
    return { name, columns, rows: empty ? [] : [row] }
  })
  const snapshot: Omit<CatalogExportSnapshot, 'hash'> = {
    source: 'cloudflare',
    profile: CATALOG_EXPORT_PROFILE,
    snapshotId: SNAPSHOT,
    observedAt: '2026-10-03T12:00:00Z',
    filters,
    counts: {
      products: empty ? 0 : 1,
      variants: empty ? 0 : 1,
      inventory: empty ? 0 : 1,
      prices: empty ? 0 : 1,
      media: empty ? 0 : 1,
      references: empty ? 0 : 1
    },
    sheets
  }
  return { ...snapshot, hash: await catalogExportHash(snapshot) }
}
const Button = defineComponent({
  inheritAttrs: false,
  props: { disabled: Boolean },
  setup:
    (props, { attrs, slots }) =>
    () =>
      h('button', { ...attrs, disabled: props.disabled, type: attrs.type ?? 'button' }, slots.default?.())
})
const mounted: Array<{ unmount: () => void }> = []
let currentSession: ReturnType<typeof session>,
  state: CatalogExportSnapshot,
  create: ReturnType<typeof vi.fn>,
  revoke: ReturnType<typeof vi.fn>,
  click: MockInstance<() => void>,
  files: Array<{ bytes: Uint8Array; type: string }>
beforeEach(async () => {
  currentSession = session()
  state = await fixture()
  sessionMock.mockImplementation(() => currentSession)
  requestMock.mockReset().mockImplementation(async (path: string) => {
    if (path !== ROOT) throw new Error('unexpected_snapshot_path')
    return structuredClone(state)
  })
  xlsxMock.mockReset().mockResolvedValue(new Uint8Array([80, 75, 3, 4]))
  files = []
  const NativeBlob = Blob
  vi.stubGlobal(
    'Blob',
    class extends NativeBlob {
      constructor(parts: BlobPart[], options: BlobPropertyBag) {
        super(parts, options)
        if (!(parts[0] instanceof ArrayBuffer)) throw new Error('expected_owned_array_buffer')
        files.push({ bytes: new Uint8Array(parts[0]).slice(), type: this.type })
      }
    }
  )
  create = vi.fn(() => `blob:test-snapshot-${files.length}`)
  revoke = vi.fn()
  vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: create, revokeObjectURL: revoke }))
  click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
})
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
async function render(props: Record<string, unknown> = {}) {
  const wrapper = await mountSuspended(CatalogSnapshotExport, {
    props: { runtime: 'cloudflare', available: true, ...props },
    global: { stubs: { UButton: Button } }
  })
  mounted.push(wrapper)
  await flushPromises()
  return wrapper
}
type Wrapper = Awaited<ReturnType<typeof render>>
async function download(wrapper: Wrapper, format: 'csv' | 'xlsx' = 'csv', waitForCompletion = true) {
  await wrapper.get('[data-snapshot-export-format]').setValue(format)
  await wrapper.get('form').trigger('submit')
  await flushPromises()
  if (waitForCompletion) await vi.waitFor(() => expect(wrapper.get('section').attributes('aria-busy')).toBe('false'))
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

describe('private native catalog snapshot export', () => {
  it('does not fetch or download on mount or format selection', async () => {
    const wrapper = await render()
    await wrapper.get('[data-snapshot-export-format]').setValue('xlsx')
    expect(requestMock).not.toHaveBeenCalled()
    expect(xlsxMock).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })
  it('uses only the exact GET filters with no retry, mutation or pagination', async () => {
    const filters = { q: 'Producto', category: 71, status: 'draft' as const }
    state = await fixture(filters)
    const wrapper = await render({ filters })
    await download(wrapper)
    expect(requestMock).toHaveBeenCalledExactlyOnceWith(ROOT, {
      method: 'GET',
      query: filters,
      retry: 0,
      cache: 'no-store',
      credentials: 'same-origin',
      referrerPolicy: 'no-referrer'
    })
    expect(wrapper.get('[data-snapshot-export-result]').text()).toContain('Producto')
    expect(wrapper.text()).toContain('Borrador')
  })
  it('downloads the complete CSV with Manifest and all six entities, then removes the temporary link', async () => {
    const append = vi.spyOn(window.document.body, 'appendChild'),
      wrapper = await render()
    await download(wrapper)
    expect(create).toHaveBeenCalledTimes(1)
    expect(click).toHaveBeenCalledTimes(1)
    expect(append).toHaveBeenCalled()
    const link = click.mock.instances[0] as HTMLAnchorElement,
      csv = new TextDecoder().decode(files[0]!.bytes)
    expect(link.download).toBe('neteco-catalogo-snapshot-v1.csv')
    expect(link.referrerPolicy).toBe('no-referrer')
    expect(link.isConnected).toBe(false)
    expect(files[0]!.type).toBe('text/csv;charset=utf-8')
    expect(csv).toContain('"sheet","row_index","record_json"')
    for (const name of ['Manifest', ...CATALOG_EXPORT_SHEET_NAMES]) expect(csv).toContain(`"${name}","1",`)
    expect(csv).toContain('""gross_cents"":1234')
    expect(csv).toContain('""title"":""""')
    expect(csv).toContain('""short_description"":null')
    expect(xlsxMock).not.toHaveBeenCalled()
    expect(wrapper.get('time').attributes('datetime')).toBe(state.observedAt)
    expect(wrapper.findAll('[data-snapshot-export-count]').map((item) => item.text())).toEqual([
      '1',
      '1',
      '1',
      '1',
      '1',
      '1'
    ])
    expect(wrapper.text()).toContain('No es importable')
    expect(wrapper.text()).toContain('no datos vivos')
    expect(wrapper.get('section').attributes('aria-labelledby')).toBe(wrapper.get('h2').attributes('id'))
    expect(wrapper.find('a').exists()).toBe(false)
  })
  it('calls the client XLSX adapter only for the selected format and uses a fixed private download name', async () => {
    const wrapper = await render()
    await download(wrapper, 'xlsx')
    expect(xlsxMock).toHaveBeenCalledTimes(1)
    expect(xlsxMock).toHaveBeenCalledWith(state)
    expect(files[0]!.bytes).toEqual(new Uint8Array([80, 75, 3, 4]))
    expect(files[0]!.type).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    expect((click.mock.instances[0] as HTMLAnchorElement).download).toBe('neteco-catalogo-snapshot-v1.xlsx')
  })
  it.each([
    ['runtime Node', { runtime: 'node' }],
    ['missing capability', { available: false }],
    ['truthy nonboolean capability', { available: 'true' }],
    ['pagination filter', { filters: { q: '', page: 1 } }],
    ['oversized search', { filters: { q: 'x'.repeat(161) } }],
    ['noninteger category', { filters: { q: '', category: '71' } }],
    ['unknown status', { filters: { q: '', status: 'approved' } }]
  ])('fails closed without GET or a file for %s', async (_label, props) => {
    const wrapper = await render(props)
    expect(wrapper.find('[data-snapshot-export-unavailable]').exists()).toBe(true)
    expect(wrapper.find('form').exists()).toBe(false)
    expect(requestMock).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })
  it.each(['id', 'role', 'emailVerified', 'mfaVerified'] as const)(
    'rejects an unconfirmed current actor field %s',
    async (field) => {
      currentSession.user.value![field] = field === 'id' ? 'not-a-uuid' : field === 'role' ? 'customer' : false
      const wrapper = await render()
      expect(wrapper.find('[data-snapshot-export-unavailable]').exists()).toBe(true)
      expect(requestMock).not.toHaveBeenCalled()
    }
  )
  it('does not execute an actor getter before gating private state', async () => {
    const actorGetter = vi.fn(() => ACTOR)
    currentSession.user.value = Object.defineProperty({ role: 'admin', emailVerified: true, mfaVerified: true }, 'id', {
      enumerable: true,
      get: actorGetter
    })
    const wrapper = await render()
    expect(wrapper.find('[data-snapshot-export-unavailable]').exists()).toBe(true)
    expect(actorGetter).not.toHaveBeenCalled()
    expect(requestMock).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })
  it('rejects a filter getter delivered to the mounted component without reading it', async () => {
    const wrapper = await render(),
      filterGetter = vi.fn(() => ''),
      input = Object.defineProperty({}, 'q', { enumerable: true, get: filterGetter })
    // VTU's initial mount runs Object.values() to detect deep refs in props;
    // setProps hands off this object without that unrelated pre-setup traversal.
    expect(wrapper.find('form').exists()).toBe(true)
    expect(filterGetter).not.toHaveBeenCalled()
    await wrapper.setProps({ filters: input })
    await flushPromises()
    expect(wrapper.find('[data-snapshot-export-unavailable]').exists()).toBe(true)
    expect(wrapper.find('form').exists()).toBe(false)
    expect(filterGetter).not.toHaveBeenCalled()
    expect(requestMock).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })
  it.each(['hash', 'counts', 'extra', 'sparse', 'oversized-cell'] as const)(
    'rejects malformed response %s without a partial file',
    async (kind) => {
      const invalid = structuredClone(state)
      if (kind === 'hash') invalid.hash = '0'.repeat(64)
      if (kind === 'counts') invalid.counts.products = 2
      if (kind === 'extra') Object.assign(invalid, { secret: 'never-render-this-private-value' })
      if (kind === 'sparse') delete invalid.sheets[0]!.rows[0]
      if (kind === 'oversized-cell') invalid.sheets[0]!.rows[0]![0] = 'x'.repeat(20_001)
      requestMock.mockResolvedValue(invalid)
      const wrapper = await render()
      await download(wrapper)
      expect(wrapper.find('[data-snapshot-export-error]').exists()).toBe(true)
      expect(wrapper.find('[data-snapshot-export-result]').exists()).toBe(false)
      expect(wrapper.text()).not.toContain('never-render-this-private-value')
      expect(create).not.toHaveBeenCalled()
      expect(xlsxMock).not.toHaveBeenCalled()
    }
  )
  it('rejects a response accessor without calling it or displaying its contents', async () => {
    const getter = vi.fn(() => state.sheets),
      invalid = Object.defineProperty({ ...state }, 'sheets', { enumerable: true, get: getter })
    requestMock.mockResolvedValue(invalid)
    const wrapper = await render()
    await download(wrapper)
    expect(getter).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
    expect(wrapper.find('[data-snapshot-export-error]').exists()).toBe(true)
  })
  it('rejects a valid hash for a different filter scope', async () => {
    state = await fixture({ q: 'Other scope' })
    const wrapper = await render()
    await download(wrapper)
    expect(wrapper.find('[data-snapshot-export-error]').exists()).toBe(true)
    expect(create).not.toHaveBeenCalled()
  })
  it('distinguishes null failure from a verified empty snapshot with its own Manifest', async () => {
    const wrapper = await render()
    requestMock.mockResolvedValueOnce(null)
    await download(wrapper)
    expect(wrapper.find('[data-snapshot-export-error]').exists()).toBe(true)
    expect(wrapper.find('[data-snapshot-export-empty]').exists()).toBe(false)
    expect(create).not.toHaveBeenCalled()
    state = await fixture({ q: '' }, true)
    await download(wrapper)
    expect(wrapper.find('[data-snapshot-export-error]').exists()).toBe(false)
    expect(wrapper.find('[data-snapshot-export-empty]').exists()).toBe(true)
    expect(new TextDecoder().decode(files[0]!.bytes)).toContain('"Manifest","1",')
    expect(wrapper.findAll('[data-snapshot-export-count]').map((item) => item.text())).toEqual([
      '0',
      '0',
      '0',
      '0',
      '0',
      '0'
    ])
  })
  it.each(['actor', 'mfa', 'runtime', 'capability', 'filters'] as const)(
    'discards a late GET after %s changes without an automatic replacement request',
    async (change) => {
      const pending = deferred<CatalogExportSnapshot>()
      requestMock.mockReturnValueOnce(pending.promise)
      const wrapper = await render()
      await download(wrapper, 'csv', false)
      if (change === 'actor') currentSession.user.value!.id = OTHER
      if (change === 'mfa') currentSession.user.value!.mfaVerified = false
      if (change === 'runtime') await wrapper.setProps({ runtime: 'node' })
      if (change === 'capability') await wrapper.setProps({ available: false })
      if (change === 'filters') await wrapper.setProps({ filters: { q: 'Changed' } })
      pending.resolve(state)
      await flushPromises()
      expect(requestMock).toHaveBeenCalledTimes(1)
      expect(create).not.toHaveBeenCalled()
      expect(wrapper.find('[data-snapshot-export-result]').exists()).toBe(false)
    }
  )
  it('tracks an in-place filter change while the GET is pending', async () => {
    const selected = reactive({ q: '' }),
      pending = deferred<CatalogExportSnapshot>()
    requestMock.mockReturnValueOnce(pending.promise)
    const wrapper = await render({ filters: selected })
    await download(wrapper, 'csv', false)
    selected.q = 'Changed in place'
    pending.resolve(state)
    await flushPromises()
    expect(create).not.toHaveBeenCalled()
    expect(requestMock).toHaveBeenCalledTimes(1)
  })
  it('rechecks the live actor after asynchronous XLSX generation', async () => {
    const pending = deferred<Uint8Array>()
    xlsxMock.mockReturnValueOnce(pending.promise)
    const wrapper = await render()
    await download(wrapper, 'xlsx', false)
    await vi.waitFor(() => expect(xlsxMock).toHaveBeenCalledTimes(1))
    currentSession.user.value!.id = OTHER
    pending.resolve(new Uint8Array([80, 75, 3, 4]))
    await flushPromises()
    expect(create).not.toHaveBeenCalled()
    expect(wrapper.find('[data-snapshot-export-result]').exists()).toBe(false)
  })
  it('discards a late XLSX completion after unmount', async () => {
    const pending = deferred<Uint8Array>()
    xlsxMock.mockReturnValueOnce(pending.promise)
    const wrapper = await render()
    await download(wrapper, 'xlsx', false)
    await vi.waitFor(() => expect(xlsxMock).toHaveBeenCalledTimes(1))
    wrapper.unmount()
    pending.resolve(new Uint8Array([80, 75, 3, 4]))
    await flushPromises()
    expect(create).not.toHaveBeenCalled()
    expect(click).not.toHaveBeenCalled()
  })
  it('allows only one in-flight GET and requires an explicit fresh GET for every download', async () => {
    const pending = deferred<CatalogExportSnapshot>()
    requestMock.mockReturnValueOnce(pending.promise)
    const wrapper = await render()
    await download(wrapper, 'csv', false)
    await wrapper.get('form').trigger('submit')
    expect(requestMock).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-snapshot-export-download]').attributes('disabled')).toBeDefined()
    pending.resolve(state)
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    await download(wrapper)
    expect(requestMock).toHaveBeenCalledTimes(2)
    expect(revoke).toHaveBeenCalledWith('blob:test-snapshot-1')
    expect(create).toHaveBeenCalledTimes(2)
  })
  it('clears and revokes the previous successful download when a fresh read fails', async () => {
    const wrapper = await render()
    await download(wrapper)
    expect(wrapper.find('[data-snapshot-export-result]').exists()).toBe(true)
    requestMock.mockRejectedValueOnce(new Error('private-provider-response-must-not-escape'))
    await download(wrapper)
    expect(revoke).toHaveBeenCalledWith('blob:test-snapshot-1')
    expect(wrapper.find('[data-snapshot-export-result]').exists()).toBe(false)
    expect(wrapper.find('[data-snapshot-export-error]').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('private-provider-response-must-not-escape')
    expect(click).toHaveBeenCalledTimes(1)
  })
  it('revokes a completed Blob and clears its metadata on actor change and unmount', async () => {
    const wrapper = await render()
    await download(wrapper)
    currentSession.user.value!.id = OTHER
    await flushPromises()
    expect(revoke).toHaveBeenCalledWith('blob:test-snapshot-1')
    expect(wrapper.find('[data-snapshot-export-result]').exists()).toBe(false)
    await download(wrapper)
    wrapper.unmount()
    expect(revoke).toHaveBeenCalledWith('blob:test-snapshot-2')
  })
  it.each(['array', 'oversized'] as const)('rejects %s XLSX bytes instead of creating an artifact', async (kind) => {
    xlsxMock.mockResolvedValueOnce(kind === 'array' ? [80, 75, 3, 4] : new Uint8Array(CATALOG_EXPORT_MAX_BYTES + 1))
    const wrapper = await render()
    await download(wrapper, 'xlsx')
    expect(create).not.toHaveBeenCalled()
    expect(wrapper.find('[data-snapshot-export-error]').exists()).toBe(true)
  })
})
