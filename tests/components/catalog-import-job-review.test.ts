import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h, reactive, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CatalogImportJobReview from '../../app/components/CatalogImportJobReview.vue'
import { projectCatalogImportJobReviewEntry } from '../../shared/catalog-import-job-review'
import { validateCatalogRecords } from '../../shared/catalog-tabular-core'
import { catalogRecord, catalogFixtureIds as ids } from '../support/catalog-tabular-fixture'
import type { CatalogImportJob } from '../../shared/catalog-import-job'
import '#app/nuxt-vitest-app-entry'

const { request, session } = vi.hoisted(() => ({ request: vi.fn(), session: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => request)
mockNuxtImport('useUserSession', () => session)
const ACTOR = '10000000-0000-4000-8000-000000000076',
  ID = '20000000-0000-4000-8000-000000000076',
  HASH = 'a'.repeat(64)
const instant = (time: number) => new Date(time).toISOString().replace(/\.\d{3}Z$/, 'Z')
let selectedJob: CatalogImportJob
function identity() {
  return {
    ready: ref(true),
    loggedIn: ref(true),
    user: ref<Record<string, unknown> | null>({ id: ACTOR, role: 'admin', emailVerified: true, mfaVerified: true })
  }
}
function entries() {
  const source = catalogRecord(),
    validation = validateCatalogRecords([source])
  if (!validation.valid) throw new Error('fixture_invalid')
  return (['assets', 'media', 'products', 'variants'] as const).map((kind) => {
    const payload = validation.dataset[kind][0]!,
      itemId =
        kind === 'media'
          ? JSON.stringify([ids.product, null, ids.image, 'primary', '1'])
          : (payload as { id: string }).id
    return projectCatalogImportJobReviewEntry({ kind, itemId, payload }, { warehouseId: ids.shipping })
  })
}
function page(offset = 0) {
  return {
    source: 'cloudflare',
    outcome: 'review',
    jobId: ID,
    jobHash: HASH,
    offset,
    nextOffset: offset === 0 ? 2 : null,
    totalEntries: 4,
    entries: entries().slice(offset, offset + 2),
    policy: selectedJob.policy
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
let actor: ReturnType<typeof identity>,
  wrappers: Awaited<ReturnType<typeof mountSuspended>>[] = []
async function mount(props: Record<string, unknown> = {}) {
  const wrapper = await mountSuspended(CatalogImportJobReview, {
    props: { runtime: 'cloudflare', available: true, job: selectedJob, ...props }
  })
  wrappers.push(wrapper)
  return wrapper
}
async function start(wrapper: Awaited<ReturnType<typeof mount>>) {
  await wrapper.get('[data-review-start]').trigger('click')
  await flushPromises()
}
beforeEach(() => {
  vi.clearAllMocks()
  actor = identity()
  session.mockReturnValue(actor)
  selectedJob = {
    source: 'cloudflare',
    outcome: 'job',
    id: ID,
    status: 'ready',
    createdAt: instant(Date.now() - 1000),
    expiresAt: instant(Date.now() + 30 * 60_000),
    totalPages: 1,
    receivedPages: 1,
    recordCount: 1,
    hash: HASH,
    counts: { products: 1, variants: 1, assets: 1, mappings: 1 },
    policy: { publication: 'draft_only', media: 'pending_verification', priceStock: 'authorized_initialization' }
  }
  request.mockImplementation(async (path: string) =>
    page(new URL(path, 'https://example.invalid').searchParams.get('offset') === '2' ? 2 : 0)
  )
})
afterEach(() => {
  for (const wrapper of wrappers) wrapper.unmount()
  wrappers = []
  vi.restoreAllMocks()
})
describe('read-only paginated real catalogue job review', () => {
  it('never fetches automatically or invents apply/revert and warns about staged authority', async () => {
    const wrapper = await mount()
    expect(request).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('Sólo lectura')
    expect(wrapper.text()).toContain('no son verificaciones')
    expect(wrapper.find('[data-review-apply]').exists()).toBe(false)
    expect(wrapper.find('[data-review-revert]').exists()).toBe(false)
    expect(wrapper.find('[data-review-entry]').exists()).toBe(false)
  })
  it('fetches only explicit GET pages with bound offset and renders real media/product/variant differences', async () => {
    const wrapper = await mount()
    await start(wrapper)
    expect(request.mock.calls[0]).toEqual([
      `/api/admin/catalog/import-jobs/${ID}/review?offset=0&limit=25`,
      expect.objectContaining({ method: 'GET', retry: 0, cache: 'no-store' })
    ])
    expect(request.mock.calls[0][1].body).toBeUndefined()
    expect(wrapper.get('[data-review-range]').text()).toBe('Entradas 1–2 de 4.')
    expect(wrapper.text()).toContain('approved → pending')
    expect(wrapper.text()).toContain('clean → pending')
    expect(wrapper.text()).toContain('Upload verificado: null')
    expect(wrapper.get('[data-review-claimed]').text()).toContain('"rightsStatus": "approved"')
    await wrapper.get('[data-review-next]').trigger('click')
    await flushPromises()
    expect(request.mock.calls[1][0]).toBe(`/api/admin/catalog/import-jobs/${ID}/review?offset=2&limit=25`)
    expect(wrapper.get('[data-review-range]').text()).toBe('Entradas 3–4 de 4.')
    expect(wrapper.text()).toContain('Detergente profesional 5 L')
    expect(wrapper.text()).toContain('published → draft')
    expect(wrapper.text()).toContain('SKU: DET-5L')
    expect(wrapper.text()).toContain('1599 céntimos EUR')
    expect(wrapper.text()).toContain('1799')
    expect(wrapper.text()).toContain('Físico: 40')
    expect(wrapper.text()).toContain('Bloqueado: 2')
    expect(wrapper.text()).toContain('Seguridad: 2')
    expect(wrapper.text()).toContain('Pedidos sin stock: no')
    expect(wrapper.text()).toContain('server_on_apply')
    expect(wrapper.text()).toContain(ids.tax)
    expect(wrapper.text()).toContain(ids.shipping)
    expect(wrapper.get('[data-review-next]').attributes('disabled')).toBeDefined()
    expect(request.mock.calls.every(([_path, options]) => options.method === 'GET' && options.body === undefined)).toBe(
      true
    )
  })
  it('retrieves the same failed page on explicit retry without leaking stack or SQL', async () => {
    const wrapper = await mount()
    await start(wrapper)
    request.mockRejectedValueOnce(new Error('SQL password private stack'))
    await wrapper.get('[data-review-next]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).not.toContain('password')
    expect(wrapper.find('[data-review-entry]').exists()).toBe(false)
    expect(request).toHaveBeenCalledTimes(2)
    await wrapper.get('[data-review-retry]').trigger('click')
    await flushPromises()
    expect(request.mock.calls[2]).toEqual(request.mock.calls[1])
    expect(wrapper.get('[data-review-range]').text()).toBe('Entradas 3–4 de 4.')
  })
  it('does not duplicate a read on double click and permits an explicit restart at offset0', async () => {
    const wrapper = await mount(),
      pending = deferred<ReturnType<typeof page>>()
    request.mockReturnValueOnce(pending.promise)
    await wrapper.get('[data-review-start]').trigger('click')
    await wrapper.get('[data-review-start]').trigger('click')
    expect(request).toHaveBeenCalledTimes(1)
    pending.resolve(page())
    await flushPromises()
    await wrapper.get('[data-review-next]').trigger('click')
    await flushPromises()
    await start(wrapper)
    expect(wrapper.get('[data-review-range]').text()).toBe('Entradas 1–2 de 4.')
    expect(request).toHaveBeenCalledTimes(3)
  })
  it.each([
    'source',
    'outcome',
    'jobId',
    'jobHash',
    'totalEntries',
    'offset',
    'nextOffset',
    'policy',
    'empty',
    'duplicate',
    'extra',
    'forged_after',
    'too_many'
  ] as const)('rejects malformed/binding drift %s without claiming a confirmed diff', async (field) => {
    const raw: Record<string, unknown> = { ...page() }
    if (field === 'source') raw.source = 'node'
    if (field === 'outcome') raw.outcome = 'applied'
    if (field === 'jobId') raw.jobId = '30000000-0000-4000-8000-000000000076'
    if (field === 'jobHash') raw.jobHash = 'b'.repeat(64)
    if (field === 'totalEntries') raw.totalEntries = 5
    if (field === 'offset') raw.offset = 1
    if (field === 'nextOffset') raw.nextOffset = null
    if (field === 'policy') raw.policy = { ...selectedJob.policy, media: 'approved' }
    if (field === 'empty') raw.entries = []
    if (field === 'duplicate') raw.entries = [entries()[0], entries()[0]]
    if (field === 'extra') raw.stack = 'secretSQL'
    if (field === 'forged_after') {
      const forged = structuredClone(entries()[0]!)
      Object.assign(forged.after, { rightsStatus: 'approved' })
      raw.entries = [forged, entries()[1]]
    }
    if (field === 'too_many') raw.entries = Array.from({ length: 26 }, () => entries()[0])
    request.mockResolvedValueOnce(raw)
    const wrapper = await mount()
    await start(wrapper)
    expect(wrapper.find('[data-review-entry]').exists()).toBe(false)
    expect(wrapper.text()).toContain('No se ha confirmado')
    expect(wrapper.text()).not.toContain('secretSQL')
  })
  it('checks per-kind totals and consistent warehouse context instead of merely accepting a count sum', async () => {
    const duplicateKind = structuredClone(entries()[0]!)
    duplicateKind.id = '00570000-0000-4000-8000-000000000099'
    Object.assign(duplicateKind.claimed, { id: duplicateKind.id })
    Object.assign(duplicateKind.after, { id: duplicateKind.id })
    request.mockResolvedValueOnce({ ...page(), entries: [entries()[0], duplicateKind] })
    const wrapper = await mount()
    await start(wrapper)
    expect(wrapper.find('[data-review-entry]').exists()).toBe(false)
    const otherWarehouse = structuredClone(entries()[1]!)
    otherWarehouse.context.warehouseId = ids.category
    request.mockResolvedValueOnce({ ...page(), entries: [entries()[0], otherWarehouse] })
    await wrapper.get('[data-review-retry]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-review-entry]').exists()).toBe(false)
  })
  it('rejects duplicate entries repeated across consecutive pages', async () => {
    const wrapper = await mount()
    await start(wrapper)
    request.mockResolvedValueOnce({ ...page(2), entries: [entries()[0], entries()[1]] })
    await wrapper.get('[data-review-next]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-review-entry]').exists()).toBe(false)
  })
  it('escapes imported HTML in readable values and complete collapsed JSON', async () => {
    const source = catalogRecord()
    source.product_name = '<img src=x onerror=alert(1)>'
    source.description = '<script>bad()</script> Descripción original completa para el catálogo.'
    const validation = validateCatalogRecords([source])
    expect(validation.valid).toBe(true)
    const product = projectCatalogImportJobReviewEntry(
      { kind: 'products', itemId: ids.product, payload: validation.dataset.products[0] },
      { warehouseId: ids.shipping }
    )
    request.mockResolvedValueOnce({ ...page(), nextOffset: 1, entries: [product] })
    const wrapper = await mount()
    await start(wrapper)
    expect(wrapper.text()).toContain('<img src=x')
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.find('script').exists()).toBe(false)
    expect(wrapper.get('details').attributes('open')).toBeUndefined()
    expect(wrapper.get('[data-review-claimed]').text()).toContain('<script>bad()</script>')
  })
  it('rejects response accessors and oversized transport data before rendering them', async () => {
    const getter = vi.fn(() => entries()),
      raw = Object.defineProperty({ ...page() }, 'entries', { enumerable: true, get: getter })
    request.mockResolvedValueOnce(raw)
    const wrapper = await mount()
    await start(wrapper)
    expect(getter).not.toHaveBeenCalled()
    expect(wrapper.find('[data-review-entry]').exists()).toBe(false)
    request.mockResolvedValueOnce({ ...page(), extra: 'x'.repeat(2_000_001) })
    await wrapper.get('[data-review-retry]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-review-entry]').exists()).toBe(false)
  })
  it.each(['node', null, undefined, 'Cloudflare'])('refuses runtime %s', async (runtime) => {
    expect((await mount({ runtime })).find('[data-review-start]').exists()).toBe(false)
    expect(request).not.toHaveBeenCalled()
  })
  it('requires explicit capability including its default', async () => {
    expect((await mount({ available: false })).find('[data-review-start]').exists()).toBe(false)
    const wrapper = await mountSuspended(CatalogImportJobReview, { props: { runtime: 'cloudflare', job: selectedJob } })
    wrappers.push(wrapper)
    expect(wrapper.find('[data-review-start]').exists()).toBe(false)
  })
  it.each(['ready', 'loggedIn', 'id', 'role', 'emailVerified', 'mfaVerified'])(
    'requires confirmed session %s',
    async (field) => {
      if (field === 'ready' || field === 'loggedIn') actor[field].value = false
      else actor.user.value![field] = field === 'id' ? 'bad' : field === 'role' ? 'customer' : false
      expect((await mount()).find('[data-review-start]').exists()).toBe(false)
      expect(request).not.toHaveBeenCalled()
    }
  )
  it.each(['uploading', 'expired', 'node', 'hash', 'undefined', 'accessor'])(
    'requires a future, confirmed ready job: %s',
    async (problem) => {
      let job: unknown = { ...selectedJob }
      if (problem === 'uploading')
        job = {
          ...selectedJob,
          status: 'uploading',
          hash: null,
          counts: { products: 0, variants: 0, assets: 0, mappings: 0 }
        }
      if (problem === 'expired') job = { ...selectedJob, expiresAt: instant(Date.now() - 1) }
      if (problem === 'node') job = { ...selectedJob, source: 'node' }
      if (problem === 'hash') job = { ...selectedJob, hash: null }
      if (problem === 'undefined') job = undefined
      const getter = vi.fn(() => 'ready')
      if (problem === 'accessor')
        job = Object.defineProperty({ ...selectedJob }, 'status', { enumerable: true, get: getter })
      if (problem === 'accessor') {
        // Pass the untrusted projection directly: mountSuspended's own props
        // cloning is outside the component boundary and may evaluate accessors.
        const host = defineComponent({
          setup: () => () => h(CatalogImportJobReview, { runtime: 'cloudflare', available: true, job })
        })
        const wrapper = await mountSuspended(host)
        wrappers.push(wrapper)
        expect(wrapper.find('[data-review-start]').exists()).toBe(false)
      } else expect((await mount({ job })).find('[data-review-start]').exists()).toBe(false)
      expect(getter).not.toHaveBeenCalled()
      expect(request).not.toHaveBeenCalled()
    }
  )
  it.each([
    'mfaVerified',
    'emailVerified',
    'role',
    'id',
    'ready',
    'loggedIn',
    'capability',
    'runtime',
    'jobHash',
    'counts',
    'status'
  ])('clears private bindings and ignores stale reads after %s drift', async (part) => {
    const wrapper = await mount(),
      pending = deferred<ReturnType<typeof page>>()
    request.mockReturnValueOnce(pending.promise)
    await wrapper.get('[data-review-start]').trigger('click')
    if (part === 'ready' || part === 'loggedIn') actor[part].value = false
    else if (part === 'capability') await wrapper.setProps({ available: false })
    else if (part === 'runtime') await wrapper.setProps({ runtime: 'node' })
    else if (part === 'jobHash') await wrapper.setProps({ job: { ...selectedJob, hash: 'b'.repeat(64) } })
    else if (part === 'counts')
      await wrapper.setProps({
        job: { ...selectedJob, recordCount: 2, counts: { ...selectedJob.counts, products: 2 } }
      })
    else if (part === 'status') await wrapper.setProps({ job: { ...selectedJob, status: 'applied' } })
    else
      actor.user.value![part] =
        part === 'id' ? '40000000-0000-4000-8000-000000000076' : part === 'role' ? 'customer' : false
    actor.ready.value = actor.loggedIn.value = true
    actor.user.value = identity().user.value
    await wrapper.setProps({ runtime: 'cloudflare', available: true, job: selectedJob })
    pending.resolve(page())
    await flushPromises()
    expect(wrapper.find('[data-review-entry]').exists()).toBe(false)
    expect(wrapper.find('[data-review-retry]').exists()).toBe(false)
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('tracks same-object nested job count changes without running job/session accessors', async () => {
    const job = reactive(selectedJob)
    const host = defineComponent({
      setup: () => () => h(CatalogImportJobReview, { runtime: 'cloudflare', available: true, job })
    })
    const wrapper = await mountSuspended(host)
    wrappers.push(wrapper)
    await start(wrapper)
    job.counts.products = 2
    await flushPromises()
    expect(wrapper.find('[data-review-entry]').exists()).toBe(false)
  })
  it('rechecks non-reactive projections at every explicit read boundary and refuses stale bindings', async () => {
    const wrapper = await mount()
    await start(wrapper)
    const job = wrapper.props('job') as CatalogImportJob
    job.hash = 'b'.repeat(64)
    await wrapper.get('[data-review-next]').trigger('click')
    await flushPromises()
    expect(request).toHaveBeenCalledTimes(1)
    expect(wrapper.find('[data-review-entry]').exists()).toBe(false)
  })
  it('ignores a late read after expiry or unmount', async () => {
    const expiresAt = instant(Date.now() + 60_000),
      wrapper = await mount({ job: { ...selectedJob, expiresAt } }),
      pending = deferred<ReturnType<typeof page>>()
    request.mockReturnValueOnce(pending.promise)
    await wrapper.get('[data-review-start]').trigger('click')
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(expiresAt) + 1)
    pending.resolve(page())
    await flushPromises()
    expect(wrapper.find('[data-review-entry]').exists()).toBe(false)
    vi.restoreAllMocks()
    const other = await mount(),
      late = deferred<ReturnType<typeof page>>()
    request.mockReturnValueOnce(late.promise)
    await other.get('[data-review-start]').trigger('click')
    other.unmount()
    late.resolve(page())
    await flushPromises()
    expect(request).toHaveBeenCalledTimes(2)
  })
})
