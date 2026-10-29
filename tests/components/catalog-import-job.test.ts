import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { reactive, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CatalogImportJob from '../../app/components/CatalogImportJob.vue'
import { catalogTabularColumns, type CatalogTabularRecord } from '../../shared/catalog-tabular-core'
import type { CatalogImportJob as Job } from '../../shared/catalog-import-job'
import '#app/nuxt-vitest-app-entry'

const { request, decode, session } = vi.hoisted(() => ({ request: vi.fn(), decode: vi.fn(), session: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => request)
mockNuxtImport('useUserSession', () => session)
vi.mock('../../app/utils/catalog-import-file.client', () => ({ decodeCatalogImportFile: decode }))
// Nuxt boot resolves '/' before mounting this isolated panel. Do not compile
// the unrelated homepage/catalog graph inside its 10s setup hook. The job and
// children remain real; compiled-browser acceptance still covers navigation.
vi.mock('../../app/pages/index.vue', () => ({ default: { render: () => null } }))
const ACTOR = '10000000-0000-4000-8000-000000000075',
  ID = '20000000-0000-4000-8000-000000000075',
  ROOT = '/api/admin/catalog/import-jobs',
  HASH = 'a'.repeat(64)
const record = () => Object.fromEntries(catalogTabularColumns.map((key) => [key, ''])) as CatalogTabularRecord
const local = (count = 501) => ({
  records: Array.from({ length: count }, record),
  validation: { valid: true, issues: [] }
})
let jobCreatedAt: string, workspaceExpiresAt: string, sealExpiresAt: string
const instant = (time: number) => new Date(time).toISOString().replace(/\.\d{3}Z$/, 'Z')
function identity() {
  return {
    ready: ref(true),
    loggedIn: ref(true),
    user: ref<Record<string, unknown> | null>({ id: ACTOR, role: 'admin', emailVerified: true, mfaVerified: true })
  }
}
function fixture(receivedPages = 0, status: Job['status'] = 'uploading', recordCount = 501): Job {
  return {
    source: 'cloudflare',
    outcome: 'job',
    id: ID,
    status,
    createdAt: jobCreatedAt,
    expiresAt: status === 'uploading' ? workspaceExpiresAt : sealExpiresAt,
    totalPages: Math.ceil(recordCount / 500),
    receivedPages,
    recordCount,
    hash: status === 'uploading' ? null : HASH,
    counts:
      status === 'uploading'
        ? { products: receivedPages, variants: receivedPages, assets: receivedPages, mappings: receivedPages }
        : { products: 1, variants: 1, assets: 1, mappings: 1 },
    policy: { publication: 'draft_only', media: 'pending_verification', priceStock: 'authorized_initialization' }
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function file(name = 'catalogo.csv') {
  const bytes = new Uint8Array([1, 2, 3]).buffer,
    value = new File([bytes], name),
    read = vi.fn().mockResolvedValue(bytes)
  Object.defineProperty(value, 'arrayBuffer', { value: read })
  return { value, read }
}
let actor: ReturnType<typeof identity>,
  state: Job,
  wrappers: Awaited<ReturnType<typeof mountSuspended>>[] = []
async function mount(props: Record<string, unknown> = {}) {
  const wrapper = await mountSuspended(CatalogImportJob, {
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
  await wrapper.get('[data-job-create]').trigger('click')
  await flushPromises()
}
async function upload(wrapper: Awaited<ReturnType<typeof mount>>) {
  await wrapper.get('[data-job-upload]').trigger('click')
  await flushPromises()
}
async function confirm(wrapper: Awaited<ReturnType<typeof mount>>) {
  await wrapper.get('[data-job-reason]').setValue('Revisión completa del catálogo')
  await wrapper.get('[data-job-confirm]').setValue(true)
}
beforeEach(() => {
  vi.clearAllMocks()
  const now = Date.now()
  jobCreatedAt = instant(now - 1_000)
  workspaceExpiresAt = instant(now + 24 * 3600_000)
  sealExpiresAt = instant(now + 30 * 60_000)
  actor = identity()
  state = fixture()
  session.mockReturnValue(actor)
  decode.mockResolvedValue(local())
  request.mockImplementation(async (path: string, options: { body?: string; method: string }) => {
    if (path === ROOT) return state
    if (options.method === 'PUT') {
      const body = JSON.parse(options.body!)
      state = fixture(body.index + 1)
      return state
    }
    if (path.endsWith('/seal')) {
      state = fixture(2, 'ready')
      return state
    }
    return state
  })
})
afterEach(() => {
  for (const wrapper of wrappers) wrapper.unmount()
  wrappers = []
  vi.unstubAllGlobals()
})
describe('whole catalogue staged import preparation', () => {
  it.each(['csv', 'xlsx'])(
    'prepares whole %s files above500 locally without automatic network writes',
    async (format) => {
      const wrapper = await mount()
      expect(request).not.toHaveBeenCalled()
      expect(decode).not.toHaveBeenCalled()
      await select(wrapper, file(`catalogo.${format}`).value)
      expect(decode).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]), format)
      expect(wrapper.get('[data-job-plan]').text()).toContain('501 registros · 2 páginas')
      expect(request).not.toHaveBeenCalled()
      expect(wrapper.text()).toContain('25.000 registros')
      expect(wrapper.find('[data-job-apply]').exists()).toBe(false)
      expect(wrapper.find('[data-job-revert]').exists()).toBe(false)
    }
  )
  it('creates explicitly, uploads ordered pages, and seals a preview without claiming applied', async () => {
    const wrapper = await mount()
    await prepare(wrapper)
    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0]).toEqual([
      ROOT,
      expect.objectContaining({
        method: 'POST',
        body: '{"totalPages":2,"recordCount":501}',
        headers: expect.objectContaining({ 'Idempotency-Key': expect.stringMatching(/^[\da-f-]{36}$/) })
      })
    ])
    await upload(wrapper)
    const writes = request.mock.calls.filter(([_path, options]) => options.method === 'PUT')
    expect(writes.map(([path]) => path)).toEqual([`${ROOT}/${ID}/pages/0`, `${ROOT}/${ID}/pages/1`])
    expect(writes.map(([_path, options]) => JSON.parse(options.body).records.length)).toEqual([500, 1])
    for (const [_path, options] of writes) {
      expect(Object.keys(JSON.parse(options.body))).toEqual(['index', 'records'])
      expect(new TextEncoder().encode(options.body).length).toBeLessThanOrEqual(900_032)
      expect(options.retry).toBe(0)
    }
    expect(wrapper.get('[data-job-seal]').attributes('disabled')).toBeDefined()
    await confirm(wrapper)
    await wrapper.get('[data-job-seal]').trigger('click')
    await flushPromises()
    expect(request.mock.calls.at(-1)).toEqual([
      `${ROOT}/${ID}/seal`,
      expect.objectContaining({ method: 'POST', body: '{"reason":"Revisión completa del catálogo"}' })
    ])
    expect(wrapper.emitted('prepared')?.[0]).toEqual([fixture(2, 'ready')])
    expect(wrapper.text()).toContain('No se ha aplicado ningún producto')
    expect(request.mock.calls.every(([path]) => !/\/(apply|revert)$/.test(path))).toBe(true)
  })
  it('preserves create key/body through a lost response and explicitly recovers the same job', async () => {
    const wrapper = await mount()
    await select(wrapper)
    request.mockRejectedValueOnce(new Error('secretSQL'))
    await wrapper.get('[data-job-create]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).not.toContain('secretSQL')
    expect(wrapper.find('[data-job-summary]').exists()).toBe(false)
    await wrapper.get('[data-job-create]').trigger('click')
    await flushPromises()
    expect(request.mock.calls[1]).toEqual(request.mock.calls[0])
    expect(wrapper.get('[data-job-summary]').text()).toContain('uploading')
  })
  it('keeps only one page upload in flight and prevents double-click loops', async () => {
    const wrapper = await mount()
    await prepare(wrapper)
    const pending = deferred<Job>()
    request.mockReturnValueOnce(pending.promise)
    await wrapper.get('[data-job-upload]').trigger('click')
    await wrapper.get('[data-job-upload]').trigger('click')
    expect(request.mock.calls.filter(([_path, options]) => options.method === 'PUT')).toHaveLength(1)
    pending.resolve(fixture(1))
    await flushPromises()
    expect(request.mock.calls.filter(([_path, options]) => options.method === 'PUT')).toHaveLength(2)
  })
  it('requires GET after an uncertain page and replays exactly that page even when the server accepted it', async () => {
    const wrapper = await mount()
    await prepare(wrapper)
    request.mockImplementationOnce(async () => {
      state = fixture(1)
      throw new Error('lostresponse')
    })
    await upload(wrapper)
    const uncertain = request.mock.calls[1]
    expect(wrapper.get('[data-job-upload]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-job-reason]').attributes('disabled')).toBeDefined()
    await wrapper.get('[data-job-recover]').trigger('click')
    await flushPromises()
    expect(request.mock.calls[2][1].method).toBe('GET')
    expect(request.mock.calls.filter(([_path, options]) => options.method === 'PUT')).toHaveLength(1)
    expect(wrapper.get('[data-job-summary]').text()).toContain('Confirmadas en esta sesión: 0')
    await upload(wrapper)
    expect(request.mock.calls[3]).toEqual(uncertain)
    expect(request.mock.calls[4][0]).toBe(`${ROOT}/${ID}/pages/1`)
  })
  it('never infers missing indexes from an out-of-order receivedPages count', async () => {
    const wrapper = await mount()
    await prepare(wrapper)
    request.mockRejectedValueOnce(new Error('lost'))
    await upload(wrapper)
    request.mockResolvedValueOnce(fixture(2))
    await wrapper.get('[data-job-recover]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-job-summary]').exists()).toBe(false)
    expect(wrapper.get('[data-job-upload]').attributes('disabled')).toBeDefined()
    expect(request.mock.calls.filter(([_path, options]) => options.method === 'PUT')).toHaveLength(1)
  })
  it('locks an uncertain seal reason and retries the original serialized body only after GET', async () => {
    const wrapper = await mount()
    await prepare(wrapper)
    await upload(wrapper)
    await confirm(wrapper)
    request.mockRejectedValueOnce(new Error('seal lost'))
    await wrapper.get('[data-job-seal]').trigger('click')
    await flushPromises()
    const original = request.mock.calls.at(-1)
    expect(wrapper.get('[data-job-reason]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-job-confirm]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-job-seal]').attributes('disabled')).toBeDefined()
    // Even synthetic input events cannot rewrite the retained command body.
    await wrapper.get('[data-job-reason]').setValue('Motivo diferente después del intento')
    await wrapper.get('[data-job-recover]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-job-seal]').trigger('click')
    await flushPromises()
    expect(request.mock.calls.at(-1)).toEqual(original)
  })
  it('recovers a confirmed sealed preview after a lost seal response without replaying seal', async () => {
    const wrapper = await mount()
    await prepare(wrapper)
    await upload(wrapper)
    await confirm(wrapper)
    request.mockImplementationOnce(async () => {
      state = fixture(2, 'ready')
      throw new Error('lost')
    })
    await wrapper.get('[data-job-seal]').trigger('click')
    await flushPromises()
    expect(wrapper.emitted('prepared')).toBeUndefined()
    await wrapper.get('[data-job-recover]').trigger('click')
    await flushPromises()
    expect(wrapper.emitted('prepared')?.[0]).toEqual([state])
    expect(wrapper.text()).toContain('preparado, no aplicado')
    expect(request.mock.calls.filter(([path]) => path.endsWith('/seal'))).toHaveLength(1)
  })
  it('rejects an unbound page acknowledgement without proceeding to another page', async () => {
    const wrapper = await mount()
    await prepare(wrapper)
    request.mockResolvedValueOnce({ ...fixture(1), id: '30000000-0000-4000-8000-000000000075' })
    await upload(wrapper)
    expect(wrapper.find('[data-job-summary]').exists()).toBe(false)
    expect(request.mock.calls.filter(([_path, options]) => options.method === 'PUT')).toHaveLength(1)
    expect(wrapper.emitted('prepared')).toBeUndefined()
  })
  it('rejects an invalid seal response without representing preparation as complete', async () => {
    const wrapper = await mount()
    await prepare(wrapper)
    await upload(wrapper)
    await confirm(wrapper)
    request.mockResolvedValueOnce({ ...fixture(2, 'ready'), hash: null })
    await wrapper.get('[data-job-seal]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-job-summary]').exists()).toBe(false)
    expect(wrapper.emitted('prepared')).toBeUndefined()
    expect(wrapper.text()).toContain('Sellado no confirmado')
  })
  it('does not accept an expiry shift while the job is still uploading', async () => {
    const wrapper = await mount()
    await prepare(wrapper)
    request.mockResolvedValueOnce({ ...fixture(1), expiresAt: instant(Date.parse(workspaceExpiresAt) + 60_000) })
    await upload(wrapper)
    expect(wrapper.find('[data-job-summary]').exists()).toBe(false)
    expect(request.mock.calls.filter(([_path, options]) => options.method === 'PUT')).toHaveLength(1)
  })
  it.each(['workspace_ttl', 'extended_ttl', 'expired_ttl'] as const)(
    'rejects a seal transition with %s',
    async (expiry) => {
      const wrapper = await mount()
      await prepare(wrapper)
      await upload(wrapper)
      await confirm(wrapper)
      const expiresAt =
        expiry === 'workspace_ttl'
          ? workspaceExpiresAt
          : expiry === 'extended_ttl'
            ? instant(Date.now() + 31 * 60_000)
            : instant(Date.now() - 60_000)
      request.mockResolvedValueOnce({ ...fixture(2, 'ready'), expiresAt })
      await wrapper.get('[data-job-seal]').trigger('click')
      await flushPromises()
      expect(wrapper.emitted('prepared')).toBeUndefined()
      expect(wrapper.find('[data-job-summary]').exists()).toBe(false)
    }
  )
  it.each(['node', null, undefined, 'Cloudflare'])('refuses runtime %s', async (runtime) => {
    expect((await mount({ runtime })).find('input').exists()).toBe(false)
  })
  it('requires explicit available capability including the default', async () => {
    expect((await mount({ available: false })).find('input').exists()).toBe(false)
    const wrapper = await mountSuspended(CatalogImportJob, { props: { runtime: 'cloudflare' } })
    wrappers.push(wrapper)
    expect(wrapper.find('input').exists()).toBe(false)
  })
  it.each(['ready', 'loggedIn', 'id', 'role', 'emailVerified', 'mfaVerified'])(
    'requires confirmed admin auth %s',
    async (field) => {
      if (field === 'ready' || field === 'loggedIn') actor[field].value = false
      else actor.user.value![field] = field === 'id' ? 'invalid' : field === 'role' ? 'customer' : false
      expect((await mount()).find('input').exists()).toBe(false)
      expect(request).not.toHaveBeenCalled()
    }
  )
  it('rejects actor accessors without executing them', async () => {
    const getter = vi.fn(() => true),
      value = reactive({ id: ACTOR, role: 'admin', emailVerified: true })
    Object.defineProperty(value, 'mfaVerified', { get: getter, configurable: true })
    actor.user.value = value
    expect((await mount()).find('input').exists()).toBe(false)
    expect(getter).not.toHaveBeenCalled()
  })
  it.each([0, 20_000_001])('rejects file bytes %s without reading', async (size) => {
    const wrapper = await mount(),
      source = file()
    Object.defineProperty(source.value, 'size', { value: size })
    await select(wrapper, source.value)
    expect(source.read).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
  })
  it('explains the compressed file budget without planning, reading or creating a server job', async () => {
    const wrapper = await mount(),
      source = file('catalogo.xlsx')
    Object.defineProperty(source.value, 'size', { value: 20_000_001 })
    await select(wrapper, source.value)
    expect(wrapper.text()).toContain('comprimido')
    expect(wrapper.text()).toContain('20 MB')
    const help = wrapper.get('[data-import-limit-help]').text()
    expect(help).toContain('0 filas aceptadas')
    expect(help).toContain('productos completos')
    expect(help).toContain('variantes')
    expect(help).toContain('71 columnas')
    expect(help).toContain('independientes')
    expect(wrapper.find('[data-job-plan]').exists()).toBe(false)
    expect(wrapper.get('[data-job-create]').attributes('disabled')).toBeDefined()
    expect(source.read).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
  })
  it('reports expanded XLSX rejection without retaining the previous plan or sending any pages', async () => {
    const wrapper = await mount()
    await select(wrapper)
    decode.mockResolvedValue({
      records: [],
      validation: {
        valid: false,
        issues: [{ code: 'catalog_file_too_large', message: 'El contenido descomprimido del XLSX supera los 100 MB.' }]
      }
    })
    await select(wrapper, file('catalogo.xlsx').value)
    expect(wrapper.text()).toContain('descomprimido')
    expect(wrapper.get('[data-import-limit-help]').text()).toContain('0 filas aceptadas')
    expect(wrapper.find('[data-job-plan]').exists()).toBe(false)
    expect(wrapper.get('[data-job-create]').attributes('disabled')).toBeDefined()
    expect(request).not.toHaveBeenCalled()
  })
  it('rejects unsupported extensions and records beyond25k without sending', async () => {
    const wrapper = await mount(),
      source = file('catalogo.xls')
    await select(wrapper, source.value)
    expect(source.read).not.toHaveBeenCalled()
    decode.mockResolvedValue(local(25_001))
    await select(wrapper)
    expect(wrapper.find('[data-job-plan]').exists()).toBe(false)
    expect(request).not.toHaveBeenCalled()
  })
  it('rejects a single oversized row rather than sending a page outside the planner budget', async () => {
    const large = record()
    for (const key of catalogTabularColumns) large[key] = 'x'.repeat(20_000)
    decode.mockResolvedValue({ ...local(1), records: [large] })
    const wrapper = await mount()
    await select(wrapper)
    expect(wrapper.find('[data-job-plan]').exists()).toBe(false)
    expect(request).not.toHaveBeenCalled()
  })
  it.each(['id', 'totalPages', 'recordCount', 'createdAt', 'expiresAt', 'hash', 'counts'])(
    'rejects incompatible %s response drift on recovery',
    async (field) => {
      const wrapper = await mount()
      await prepare(wrapper)
      await upload(wrapper)
      await confirm(wrapper)
      await wrapper.get('[data-job-seal]').trigger('click')
      await flushPromises()
      const drift: Record<string, unknown> = { ...state }
      if (field === 'id') drift.id = '30000000-0000-4000-8000-000000000075'
      if (field === 'totalPages') drift.totalPages = 3
      if (field === 'recordCount') drift.recordCount = 502
      if (field === 'createdAt') drift.createdAt = instant(Date.parse(state.createdAt) + 1_000)
      if (field === 'expiresAt') drift.expiresAt = instant(Date.parse(state.expiresAt) + 1_000)
      if (field === 'hash') drift.hash = 'b'.repeat(64)
      if (field === 'counts') drift.counts = { ...state.counts, variants: 2 }
      request.mockResolvedValueOnce(drift)
      await wrapper.get('[data-job-recover]').trigger('click')
      await flushPromises()
      expect(wrapper.find('[data-job-summary]').exists()).toBe(false)
      expect(wrapper.emitted('prepared')).toHaveLength(1)
    }
  )
  it.each(['source', 'extra', 'hash', 'counts'])(
    'rejects malformed initial %s without binding a job',
    async (field) => {
      const raw: Record<string, unknown> = { ...fixture() }
      if (field === 'source') raw.source = 'node'
      if (field === 'extra') raw.secret = 'SQL secret'
      if (field === 'hash') raw.hash = HASH
      if (field === 'counts') raw.counts = { ...fixture().counts, products: 1 }
      request.mockResolvedValueOnce(raw)
      const wrapper = await mount()
      await prepare(wrapper)
      expect(wrapper.find('[data-job-summary]').exists()).toBe(false)
      expect(wrapper.text()).not.toContain('SQL secret')
    }
  )
  it('shows local and server invalid issues as bounded escaped text', async () => {
    decode.mockResolvedValue({
      ...local(),
      validation: {
        valid: false,
        issues: Array.from({ length: 101 }, () => ({ code: 'invalid', row: 2, message: '<img src=x>' }))
      }
    })
    const wrapper = await mount()
    await select(wrapper)
    expect(wrapper.findAll('[data-job-issue]')).toHaveLength(100)
    expect(wrapper.find('img').exists()).toBe(false)
    decode.mockResolvedValue(local())
    await prepare(wrapper)
    request.mockResolvedValueOnce({
      source: 'cloudflare',
      outcome: 'invalid',
      issues: [{ code: 'invalid', message: '<script>secret</script>' }]
    })
    await upload(wrapper)
    expect(wrapper.find('script').exists()).toBe(false)
    expect(wrapper.emitted('prepared')).toBeUndefined()
    expect(request.mock.calls.filter(([_path, options]) => options.method === 'PUT')).toHaveLength(1)
  })
  it.each(['mfaVerified', 'emailVerified', 'role', 'id', 'ready', 'loggedIn', 'capability', 'runtime'])(
    'clears plans/bindings and ignores late responses after %s drift',
    async (part) => {
      const wrapper = await mount()
      await prepare(wrapper)
      const pending = deferred<Job>()
      request.mockReturnValueOnce(pending.promise)
      await wrapper.get('[data-job-upload]').trigger('click')
      if (part === 'ready' || part === 'loggedIn') actor[part].value = false
      else if (part === 'capability') await wrapper.setProps({ available: false })
      else if (part === 'runtime') await wrapper.setProps({ runtime: 'node' })
      else
        actor.user.value![part] =
          part === 'id' ? '40000000-0000-4000-8000-000000000075' : part === 'role' ? 'customer' : false
      actor.ready.value = actor.loggedIn.value = true
      actor.user.value = identity().user.value
      await wrapper.setProps({ runtime: 'cloudflare', available: true })
      pending.resolve(fixture(1))
      await flushPromises()
      expect(wrapper.find('[data-job-plan]').exists()).toBe(false)
      expect(wrapper.find('[data-job-summary]').exists()).toBe(false)
      expect(request.mock.calls.filter(([_path, options]) => options.method === 'PUT')).toHaveLength(1)
    }
  )
  it('reselection clears uncertain binding and ignores late responses from the original job', async () => {
    const wrapper = await mount()
    await prepare(wrapper)
    const pending = deferred<Job>()
    request.mockReturnValueOnce(pending.promise)
    await wrapper.get('[data-job-upload]').trigger('click')
    await select(wrapper, file('next.xlsx').value)
    pending.resolve(fixture(1))
    await flushPromises()
    expect(wrapper.find('[data-job-summary]').exists()).toBe(false)
    expect(wrapper.find('[data-job-recover]').exists()).toBe(false)
    expect(wrapper.get('[data-job-plan]').text()).toContain('501 registros')
    expect(request.mock.calls.filter(([_path, options]) => options.method === 'PUT')).toHaveLength(1)
  })
  it('ignores stale local decoding after reselection and late job creation after unmount', async () => {
    const wrapper = await mount(),
      parsing = deferred<ReturnType<typeof local>>()
    decode.mockReturnValueOnce(parsing.promise)
    await select(wrapper)
    await select(wrapper, file('next.xlsx').value)
    parsing.resolve(local(25_001))
    await flushPromises()
    expect(wrapper.get('[data-job-plan]').text()).toContain('501 registros')
    const pending = deferred<Job>()
    request.mockReturnValueOnce(pending.promise)
    await wrapper.get('[data-job-create]').trigger('click')
    wrapper.unmount()
    pending.resolve(fixture())
    await flushPromises()
    expect(wrapper.emitted('prepared')).toBeUndefined()
  })
})
