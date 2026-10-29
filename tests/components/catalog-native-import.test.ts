import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { reactive, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CatalogNativeImport from '../../app/components/CatalogNativeImport.vue'
import { catalogTabularColumns, type CatalogTabularRecord } from '../../shared/catalog-tabular-core'
import type { NativeImportPreview } from '../../shared/catalog-native-import'
import '#app/nuxt-vitest-app-entry'

const { request, decode, session } = vi.hoisted(() => ({ request: vi.fn(), decode: vi.fn(), session: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => request)
mockNuxtImport('useUserSession', () => session)
vi.mock('../../app/utils/catalog-import-file.client', () => ({ decodeCatalogImportFile: decode }))
const ACTOR = '10000000-0000-4000-8000-000000000071',
  ID = '20000000-0000-4000-8000-000000000071',
  HASH = 'a'.repeat(64),
  ROOT = '/api/admin/catalog/native-import'
const record = () => Object.fromEntries(catalogTabularColumns.map((key) => [key, ''])) as CatalogTabularRecord
const local = () => ({
  records: [record()],
  validation: { valid: true, issues: [], summary: { rows: 1, products: 1, variants: 1, assets: 1, documents: 0 } }
})
const fixture = (status: NativeImportPreview['status'] = 'pending'): NativeImportPreview => ({
  source: 'cloudflare',
  outcome: 'preview',
  id: ID,
  hash: HASH,
  createdAt: '2026-10-04T10:00:00Z',
  expiresAt: '2026-10-04T10:30:00Z',
  status,
  counts: { products: 1, variants: 1, assets: 1, mappings: 1 },
  policy: { publication: 'draft_only', media: 'pending_verification', priceStock: 'authorized_initialization' }
})
const receipt = (action: 'apply' | 'revert' = 'apply') => ({
  source: 'cloudflare',
  action,
  previewId: ID,
  previewHash: HASH,
  commandId: '30000000-0000-4000-8000-000000000071',
  counts: fixture().counts,
  updated: true
})
function identity() {
  return {
    ready: ref(true),
    loggedIn: ref(true),
    user: ref<Record<string, unknown> | null>({ id: ACTOR, role: 'admin', emailVerified: true, mfaVerified: true })
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { resolve, promise }
}
function file(name = 'catalogo.csv') {
  const bytes = new Uint8Array([1, 2, 3]).buffer,
    value = new File([bytes], name),
    read = vi.fn().mockResolvedValue(bytes)
  Object.defineProperty(value, 'arrayBuffer', { value: read })
  return { value, read }
}
let actor: ReturnType<typeof identity>,
  wrappers: Awaited<ReturnType<typeof mountSuspended>>[] = []
async function mount(props: Record<string, unknown> = {}) {
  const wrapper = await mountSuspended(CatalogNativeImport, {
    props: { runtime: 'cloudflare', available: true, ...props }
  })
  wrappers.push(wrapper)
  return wrapper
}
async function select(wrapper: Awaited<ReturnType<typeof mount>>, source = file().value) {
  const input = wrapper.get('input[type=file]')
  Object.defineProperty(input.element, 'files', { configurable: true, value: [source] })
  await input.trigger('change')
  await flushPromises()
}
async function prepare(wrapper: Awaited<ReturnType<typeof mount>>) {
  await select(wrapper)
  await wrapper.get('[data-native-preview]').trigger('click')
  await flushPromises()
}
async function confirm(wrapper: Awaited<ReturnType<typeof mount>>) {
  await wrapper.get('[data-native-reason]').setValue('Inicialización autorizada del catálogo')
  await wrapper.get('[data-native-confirm]').setValue(true)
}
beforeEach(() => {
  vi.clearAllMocks()
  actor = identity()
  session.mockReturnValue(actor)
  decode.mockResolvedValue(local())
  request.mockImplementation(async (path: string) =>
    path.endsWith('/apply') ? receipt() : path.endsWith('/revert') ? receipt('revert') : fixture()
  )
})
afterEach(() => {
  for (const wrapper of wrappers) wrapper.unmount()
  wrappers = []
  vi.unstubAllGlobals()
})
describe('native catalogue import is bounded and explicitly authorized', () => {
  it.each(['csv', 'xlsx'])('decodes %s locally and never writes automatically', async (format) => {
    const wrapper = await mount()
    expect(decode).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
    await select(wrapper, file(`catalogo.${format}`).value)
    expect(decode).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]), format)
    expect(request).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('no se ha enviado')
    expect(wrapper.text()).toContain('500 registros')
    expect(wrapper.text()).toContain('900.000 bytes')
  })
  it('previews, applies with a receipt, queries, and explicitly reverts without publishing', async () => {
    const wrapper = await mount()
    await prepare(wrapper)
    expect(request.mock.calls[0]).toEqual([
      `${ROOT}/preview`,
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ records: local().records }), retry: 0 })
    ])
    expect(wrapper.text()).toContain('draft_only')
    expect(wrapper.text()).toContain('pending_verification')
    expect(wrapper.get('[data-native-apply]').attributes('disabled')).toBeDefined()
    await confirm(wrapper)
    await wrapper.get('[data-native-apply]').trigger('click')
    await flushPromises()
    const apply = request.mock.calls.find(([path]) => path.endsWith('/apply'))!
    expect(apply[1].headers['Idempotency-Key']).toMatch(/^[\da-f-]{36}$/)
    expect(JSON.parse(apply[1].body)).toEqual({ previewHash: HASH, reason: 'Inicialización autorizada del catálogo' })
    expect(wrapper.emitted('changed')?.[0]).toEqual([receipt()])
    expect(request).toHaveBeenCalledTimes(2)
    request.mockResolvedValueOnce(fixture('applied'))
    await wrapper.get('[data-native-refresh]').trigger('click')
    await flushPromises()
    await confirm(wrapper)
    await wrapper.get('[data-native-revert]').trigger('click')
    await flushPromises()
    expect(wrapper.emitted('changed')?.[1]).toEqual([receipt('revert')])
    expect(wrapper.text()).toContain('historial')
  })
  it.each(['node', null, undefined, 'Cloudflare'])('refuses runtime %s', async (runtime) => {
    expect((await mount({ runtime })).find('input').exists()).toBe(false)
    expect(request).not.toHaveBeenCalled()
  })
  it('requires the explicit capability, including its default', async () => {
    expect((await mount({ available: false })).find('input').exists()).toBe(false)
    const wrapper = await mountSuspended(CatalogNativeImport, { props: { runtime: 'cloudflare' } })
    wrappers.push(wrapper)
    expect(wrapper.find('input').exists()).toBe(false)
  })
  it.each(['ready', 'loggedIn', 'id', 'role', 'emailVerified', 'mfaVerified'])(
    'rejects unconfirmed auth %s',
    async (field) => {
      if (field === 'ready' || field === 'loggedIn') actor[field].value = false
      else actor.user.value![field] = field === 'id' ? 'bad' : field === 'role' ? 'customer' : false
      expect((await mount()).find('input').exists()).toBe(false)
    }
  )
  it('does not execute session accessors', async () => {
    const getter = vi.fn(() => true),
      value = reactive({ id: ACTOR, role: 'admin', emailVerified: true })
    Object.defineProperty(value, 'mfaVerified', { get: getter, configurable: true })
    actor.user.value = value
    expect((await mount()).find('input').exists()).toBe(false)
    expect(getter).not.toHaveBeenCalled()
  })
  it.each([0, 20_000_001])('rejects size %s before reading', async (size) => {
    const wrapper = await mount(),
      source = file()
    Object.defineProperty(source.value, 'size', { value: size })
    await select(wrapper, source.value)
    expect(source.read).not.toHaveBeenCalled()
    expect(decode).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
  })
  it('rejects non-native extensions', async () => {
    const wrapper = await mount(),
      source = file('catalogo.xls')
    await select(wrapper, source.value)
    expect(source.read).not.toHaveBeenCalled()
  })
  it.each(['rows', 'bytes'])('enforces bounded application %s locally', async (bound) => {
    const result = local()
    result.records =
      bound === 'rows'
        ? Array.from({ length: 501 }, record)
        : Array.from({ length: 50 }, () => ({ ...record(), description: 'x'.repeat(20_000) }))
    decode.mockResolvedValue(result)
    const wrapper = await mount()
    await select(wrapper)
    expect(wrapper.text()).toContain('Divide el archivo')
    expect(wrapper.get('[data-native-preview]').attributes('disabled')).toBeDefined()
    expect(request).not.toHaveBeenCalled()
  })
  it('renders local and server issues as text and caps local issues', async () => {
    const result = local()
    decode.mockResolvedValue({
      ...result,
      validation: {
        ...result.validation,
        valid: false,
        issues: Array.from({ length: 101 }, () => ({ code: 'invalid', field: 'sku', row: 2, message: '<img src=x>' }))
      }
    })
    const wrapper = await mount()
    await select(wrapper)
    expect(wrapper.findAll('[data-native-issue]')).toHaveLength(100)
    expect(wrapper.find('img').exists()).toBe(false)
    expect(request).not.toHaveBeenCalled()
    decode.mockResolvedValue(local())
    await select(wrapper)
    request.mockResolvedValueOnce({
      source: 'cloudflare',
      outcome: 'invalid',
      issues: [{ code: 'invalid', row: 2, message: '<script>evil</script>' }]
    })
    await wrapper.get('[data-native-preview]').trigger('click')
    await flushPromises()
    expect(wrapper.find('script').exists()).toBe(false)
    expect(wrapper.text()).toContain('servidor ha rechazado')
  })
  it.each([
    { ...fixture(), source: 'node' },
    { ...fixture(), extra: true },
    { ...fixture(), policy: { ...fixture().policy, media: 'approved' } }
  ])('fails closed for malformed previews', async (raw) => {
    request.mockResolvedValueOnce(raw)
    const wrapper = await mount()
    await prepare(wrapper)
    expect(wrapper.find('[data-native-summary]').exists()).toBe(false)
    expect(wrapper.emitted('changed')).toBeUndefined()
  })
  it('never claims completion for a malformed receipt; retries retain exact key and body', async () => {
    const wrapper = await mount()
    await prepare(wrapper)
    await confirm(wrapper)
    request.mockResolvedValueOnce({ ...receipt(), previewHash: 'b'.repeat(64) })
    await wrapper.get('[data-native-apply]').trigger('click')
    await flushPromises()
    expect(wrapper.emitted('changed')).toBeUndefined()
    expect(wrapper.text()).toContain('Resultado no confirmado')
    const first = request.mock.calls[1]
    await wrapper.get('[data-native-retry]').trigger('click')
    await flushPromises()
    expect(request.mock.calls[2]).toEqual(first)
    expect(wrapper.emitted('changed')?.[0]).toEqual([receipt()])
  })
  it('retains the original intent after a lost response and refresh never replays a write', async () => {
    const wrapper = await mount()
    await prepare(wrapper)
    await confirm(wrapper)
    request.mockRejectedValueOnce(new Error('SQL password stack secret'))
    await wrapper.get('[data-native-apply]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).not.toContain('secret')
    request.mockResolvedValueOnce(fixture('applied'))
    await wrapper.get('[data-native-refresh]').trigger('click')
    await flushPromises()
    expect(request.mock.calls[2][1].method).toBe('GET')
    expect(wrapper.emitted('changed')).toBeUndefined()
    await wrapper.get('[data-native-retry]').trigger('click')
    await flushPromises()
    expect(request.mock.calls[3]).toEqual(request.mock.calls[1])
  })
  it('prevents a double click from duplicating an apply', async () => {
    const wrapper = await mount()
    await prepare(wrapper)
    await confirm(wrapper)
    const pending = deferred<unknown>()
    request.mockReturnValueOnce(pending.promise)
    await wrapper.get('[data-native-apply]').trigger('click')
    await wrapper.get('[data-native-apply]').trigger('click')
    expect(request.mock.calls.filter(([path]) => path.endsWith('/apply'))).toHaveLength(1)
    pending.resolve(receipt())
    await flushPromises()
  })
  it.each(['mfaVerified', 'emailVerified', 'role', 'id', 'loggedIn', 'ready', 'capability', 'runtime'])(
    'clears retained data and ignores stale previews after %s drift',
    async (part) => {
      const wrapper = await mount()
      await select(wrapper)
      const pending = deferred<unknown>()
      request.mockReturnValueOnce(pending.promise)
      await wrapper.get('[data-native-preview]').trigger('click')
      if (part === 'loggedIn' || part === 'ready') actor[part].value = false
      else if (part === 'capability') await wrapper.setProps({ available: false })
      else if (part === 'runtime') await wrapper.setProps({ runtime: 'node' })
      else
        actor.user.value![part] =
          part === 'id' ? '40000000-0000-4000-8000-000000000071' : part === 'role' ? 'customer' : false
      pending.resolve(fixture())
      await flushPromises()
      actor.ready.value = actor.loggedIn.value = true
      actor.user.value = identity().user.value
      await wrapper.setProps({ available: true, runtime: 'cloudflare' })
      await flushPromises()
      expect(wrapper.find('[data-native-summary]').exists()).toBe(false)
      expect(wrapper.get('[data-native-preview]').attributes('disabled')).toBeDefined()
      expect(wrapper.emitted('changed')).toBeUndefined()
      expect(request).toHaveBeenCalledTimes(1)
    }
  )
  it('ignores stale file parsing after reselection and clears the previous intent', async () => {
    const wrapper = await mount(),
      pending = deferred<ReturnType<typeof local>>()
    decode.mockReturnValueOnce(pending.promise)
    await select(wrapper)
    await select(wrapper, file('next.xlsx').value)
    pending.resolve({ ...local(), records: Array.from({ length: 501 }, record) })
    await flushPromises()
    expect(wrapper.text()).not.toContain('Divide el archivo')
    expect(wrapper.text()).toContain('1 registros')
    await wrapper.get('[data-native-preview]').trigger('click')
    await flushPromises()
    await confirm(wrapper)
    request.mockRejectedValueOnce(new Error('lost'))
    await wrapper.get('[data-native-apply]').trigger('click')
    await flushPromises()
    await select(wrapper)
    expect(wrapper.find('[data-native-retry]').exists()).toBe(false)
    expect(wrapper.find('[data-native-summary]').exists()).toBe(false)
  })
  it('ignores late receipts after unmount', async () => {
    const wrapper = await mount()
    await prepare(wrapper)
    await confirm(wrapper)
    const pending = deferred<unknown>()
    request.mockReturnValueOnce(pending.promise)
    await wrapper.get('[data-native-apply]').trigger('click')
    wrapper.unmount()
    pending.resolve(receipt())
    await flushPromises()
    expect(wrapper.emitted('changed')).toBeUndefined()
  })
  it('ignores a late receipt after admin MFA is lost and regained', async () => {
    const wrapper = await mount()
    await prepare(wrapper)
    await confirm(wrapper)
    const pending = deferred<unknown>()
    request.mockReturnValueOnce(pending.promise)
    await wrapper.get('[data-native-apply]').trigger('click')
    actor.user.value!.mfaVerified = false
    actor.user.value!.mfaVerified = true
    pending.resolve(receipt())
    await flushPromises()
    expect(wrapper.emitted('changed')).toBeUndefined()
    expect(wrapper.find('[data-native-retry]').exists()).toBe(false)
    expect(wrapper.get('[data-native-preview]').attributes('disabled')).toBeDefined()
  })
  it('rejects refreshed snapshots with changed counts without enabling further commands', async () => {
    const wrapper = await mount()
    await prepare(wrapper)
    request.mockResolvedValueOnce({ ...fixture(), counts: { ...fixture().counts, products: 2 } })
    await wrapper.get('[data-native-refresh]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-native-summary]').exists()).toBe(false)
    expect(wrapper.text()).toContain('No se ha confirmado el estado')
  })
})
