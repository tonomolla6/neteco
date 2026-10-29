import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { ref, type Ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SearchSynonymsPanel from '../../app/components/SearchSynonymsPanel.vue'
import '#app/nuxt-vitest-app-entry'

// Acceptance matrix, exercised through DOM and the real shared DTO:
// - confirmed paginated/searchable read; failure is never an empty result;
// - create/edit/pause/retire, reason, schema bounds, versioned identity;
// - server before/after preview, form invalidation, explicit confirmation;
// - exact frozen command/key, no double click, receipt then fresh read;
// - unknown delivery: manual lookup, then explicit exact retry, never re-preview;
// - malformed/mismatched replies, no-effect errors, stale reads, expiry;
// - revocation/actor changes/unmount suppress stale UI and follow-up effects;
// - native keyboard controls and mobile-safe long strings.
const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  session: { value: null as unknown },
  navigation: { value: null as unknown }
}))
vi.mock('../../app/composables/useAdminNavigation', () => ({ useAdminNavigation: () => mocks.navigation.value }))
mockNuxtImport('useRequestFetch', () => () => mocks.request)
mockNuxtImport('useUserSession', () => () => mocks.session.value)
const id = 'a0400000-0000-4000-8000-000000000001'
const previewId = 'a0400000-0000-4000-8000-000000000002'
const item = {
  id,
  sourceTerm: 'lejía',
  replacements: ['cloro'],
  active: true,
  version: 1,
  updatedAt: '2026-10-08T12:00:00Z',
  retired: false
}
const list = (items = [item], extra = {}) => ({
  source: 'cloudflare',
  items,
  total: items.length,
  page: 1,
  perPage: 25,
  ...extra
})
const receipt = (draft: Record<string, unknown>, extra = {}) => ({
  source: 'cloudflare',
  commandId: id,
  previewId,
  action: draft.action,
  item: {
    ...item,
    id: draft.id ?? id,
    version: Number(draft.expectedVersion) + 1,
    sourceTerm: draft.sourceTerm,
    replacements: draft.replacements,
    active: draft.action === 'retire' ? false : draft.active,
    retired: draft.action === 'retire'
  },
  ...extra
})
let latestPreview: Record<string, unknown>
function preview(body: { draft: Record<string, unknown>; query: string }) {
  latestPreview = {
    source: 'cloudflare',
    previewId,
    previewHash: 'a'.repeat(64),
    expiresAt: '2099-10-08T12:00:00Z',
    ...body,
    before: [],
    after: [{ slug: 'cloro', name: 'Cloro profesional' }],
    beforeTerms: [body.query],
    afterTerms: [body.query, 'cloro']
  }
  return latestPreview
}
const mounted: Array<{ unmount: () => void }> = []
let session: {
  ready: Ref<boolean>
  loggedIn: Ref<boolean>
  user: Ref<Record<string, unknown>>
  session: Ref<Record<string, unknown>>
}
let capabilities: Ref<Record<string, unknown>>
beforeEach(() => {
  session = {
    ready: ref(true),
    loggedIn: ref(true),
    user: ref({ id, role: 'admin', emailVerified: true, mfaVerified: true }),
    session: ref({ sessionId: previewId, sessionVersion: 1 })
  }
  capabilities = ref({
    source: 'cloudflare',
    identityId: id,
    sessionId: previewId,
    sessionVersion: 1,
    state: 'ready',
    permissions: ['catalog.write']
  })
  mocks.navigation.value = { capabilities, status: ref('ready') }
  mocks.session.value = session
  mocks.request.mockReset().mockImplementation(async (path: string, options?: { body?: unknown }) => {
    if (path.endsWith('/preview')) return preview(options!.body as Parameters<typeof preview>[0])
    return list()
  })
})
afterEach(() => {
  mounted.splice(0).forEach((wrapper) => wrapper.unmount())
  vi.restoreAllMocks()
})
async function render(runtime: unknown = 'cloudflare') {
  const wrapper = await mountSuspended(SearchSynonymsPanel, { props: { runtime } })
  mounted.push(wrapper)
  await flushPromises()
  return wrapper
}
async function prepare(wrapper: Awaited<ReturnType<typeof render>>, action = 'create') {
  await wrapper.get(`[data-synonym-${action}]`).trigger('click')
  if (action === 'create') {
    await wrapper.get('[data-synonym-source]').setValue('lejía')
    await wrapper.get('[data-synonym-replacements]').setValue('cloro')
  }
  await wrapper.get('[data-synonym-reason]').setValue('Mejora de búsqueda aprobada')
  await wrapper.get('[data-synonym-query]').setValue('lejía')
  await wrapper.get('[data-synonym-form]').trigger('submit')
  await flushPromises()
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('governed synonym administration', () => {
  it('allows a verified catalog editor through the current server capability, not its role label', async () => {
    session.user.value = { ...session.user.value, role: 'catalog_editor' }
    const wrapper = await render()
    await prepare(wrapper)
    expect(wrapper.find('[data-synonym-confirm]').exists()).toBe(true)
    expect(mocks.request.mock.calls.some(([path]) => path.endsWith('/preview'))).toBe(true)
  })
  it('does not infer catalog.write from an administrator role without a current explicit grant', async () => {
    capabilities.value = { ...capabilities.value, permissions: ['support.manage'] }
    const wrapper = await render()
    expect(mocks.request).not.toHaveBeenCalled()
    expect(wrapper.find('[data-synonym-create]').exists()).toBe(false)
  })
  it('reads confirmed results and exposes native keyboard-safe create/search controls', async () => {
    const wrapper = await render()
    expect(wrapper.find('[data-synonym-create]').exists()).toBe(true)
    expect(wrapper.text()).toContain('lejía')
    expect(wrapper.find('[data-synonym-search-form]').exists()).toBe(true)
    expect(wrapper.find('[data-synonym-list]').attributes('class')).toContain('break-words')
  })
  it.each(['node', 'unknown'])('does not access Cloudflare data for %s', async (runtime) => {
    await render(runtime)
    expect(mocks.request).not.toHaveBeenCalled()
  })
  it('keeps failed reads distinct from a confirmed empty list and permits explicit retry', async () => {
    mocks.request.mockRejectedValueOnce(new Error('offline'))
    const wrapper = await render()
    expect(wrapper.text()).toContain('No se ha podido confirmar')
    expect(wrapper.text()).not.toContain('No hay sinónimos')
    await wrapper.get('[data-synonym-read-retry]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('lejía')
  })
  it('uses server-owned before/after preview, invalidates it on edits and enforces replacement bounds', async () => {
    const wrapper = await render()
    await prepare(wrapper)
    expect(wrapper.text()).toContain('Cloro profesional')
    expect(wrapper.text()).toContain('Antes')
    expect(wrapper.text()).toContain('Después')
    await wrapper.get('[data-synonym-replacements]').setValue('uno,dos,tres,cuatro,cinco,seis,siete,ocho,nueve')
    expect(wrapper.find('[data-synonym-confirm]').exists()).toBe(false)
    const calls = mocks.request.mock.calls.length
    await wrapper.get('[data-synonym-form]').trigger('submit')
    expect(mocks.request).toHaveBeenCalledTimes(calls)
  })
  it.each(['edit', 'pause', 'retire'])('previews versioned %s with an explicit reason', async (action) => {
    const wrapper = await render()
    await prepare(wrapper, action)
    const call = mocks.request.mock.calls.find(([path]) => path.endsWith('/preview'))!
    expect(call[1].body.draft).toMatchObject({
      id,
      expectedVersion: 1,
      action: action === 'retire' ? 'retire' : 'save',
      active: action === 'pause' ? false : true
    })
  })
  it('rejects malformed list DTOs without exposing cached names', async () => {
    mocks.request.mockResolvedValueOnce({ ...list(), injected: true })
    const wrapper = await render()
    expect(wrapper.text()).toContain('No se ha podido confirmar')
    expect(wrapper.text()).not.toContain('lejía')
  })
  it('sends one frozen preview command despite double clicks and shows an audited receipt only after a valid response', async () => {
    const wrapper = await render()
    await prepare(wrapper)
    const pending = deferred<unknown>()
    mocks.request.mockReturnValueOnce(pending.promise)
    await wrapper.get('[data-synonym-confirm]').trigger('click')
    await wrapper.get('[data-synonym-confirm]').trigger('click')
    const commands = mocks.request.mock.calls.filter(([, options]) => options?.headers)
    expect(commands).toHaveLength(1)
    expect(commands[0]![1].body).toEqual({ previewId, previewHash: 'a'.repeat(64) })
    const draft = latestPreview.draft as Record<string, unknown>
    const result = receipt(draft)
    pending.resolve(result)
    await flushPromises()
    expect(wrapper.text()).toContain('Recibo confirmado')
    expect(mocks.request.mock.calls.at(-1)![1].method).toBe('GET')
  })
  it('looks up an unknown command before allowing an explicit same-key same-body retry, never automatic preview', async () => {
    const wrapper = await render()
    await prepare(wrapper)
    mocks.request.mockRejectedValueOnce(new Error('lost response'))
    await wrapper.get('[data-synonym-confirm]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-synonym-command-retry]').exists()).toBe(false)
    const original = mocks.request.mock.calls.at(-1)!
    mocks.request.mockRejectedValueOnce({ statusCode: 404, data: { error: { code: 'not_found' } } })
    await wrapper.get('[data-synonym-lookup]').trigger('click')
    await flushPromises()
    mocks.request.mockRejectedValueOnce(new Error('lost again'))
    await wrapper.get('[data-synonym-command-retry]').trigger('click')
    await flushPromises()
    const retried = mocks.request.mock.calls.at(-1)!
    expect(retried).toEqual(original)
    expect(mocks.request.mock.calls.filter(([path]) => path.endsWith('/preview'))).toHaveLength(1)
  })
  it.each(['edit', 'pause', 'retire'])(
    'confirms the audited %s command using its exact method and identity',
    async (action) => {
      const wrapper = await render()
      await prepare(wrapper, action)
      mocks.request.mockResolvedValueOnce(receipt(latestPreview.draft as Record<string, unknown>))
      await wrapper.get('[data-synonym-confirm]').trigger('click')
      await flushPromises()
      const command = mocks.request.mock.calls.find(([, options]) => options?.headers)!
      expect(command[0]).toBe('/api/admin/search-synonyms/' + id)
      expect(command[1].method).toBe(action === 'retire' ? 'DELETE' : 'PUT')
      expect(command[1].body).toEqual({ previewId, previewHash: 'a'.repeat(64) })
      expect(wrapper.text()).toContain('Recibo confirmado')
      expect(mocks.request.mock.calls.at(-1)![1].method).toBe('GET')
    }
  )
  it('discards stale preview after form mutation and stale reads after authority revocation', async () => {
    const wrapper = await render()
    await wrapper.get('[data-synonym-create]').trigger('click')
    await wrapper.get('[data-synonym-source]').setValue('lejía')
    await wrapper.get('[data-synonym-replacements]').setValue('cloro')
    await wrapper.get('[data-synonym-reason]').setValue('Motivo explícito')
    await wrapper.get('[data-synonym-query]').setValue('lejía')
    const pending = deferred<unknown>()
    mocks.request.mockReturnValueOnce(pending.promise)
    await wrapper.get('[data-synonym-form]').trigger('submit')
    const call = mocks.request.mock.calls.at(-1)![1].body
    await wrapper.get('[data-synonym-source]').setValue('jabón')
    pending.resolve(preview(call))
    await flushPromises()
    expect(wrapper.find('[data-synonym-confirm]').exists()).toBe(false)
    session.user.value = { ...session.user.value, mfaVerified: false }
    await flushPromises()
    expect(wrapper.text()).not.toContain('lejía')
    expect(wrapper.find('[data-synonym-create]').exists()).toBe(false)
  })
  it('searches and paginates explicitly with confirmed page identity', async () => {
    const wrapper = await render()
    mocks.request.mockResolvedValueOnce(list([item], { total: 30 }))
    await wrapper.get('[data-synonym-search]').setValue('lejía')
    await wrapper.get('[data-synonym-search-form]').trigger('submit')
    await flushPromises()
    expect(mocks.request.mock.calls.at(-1)![1].query).toMatchObject({ q: 'lejía', page: 1 })
    mocks.request.mockResolvedValueOnce(list([], { total: 30, page: 2 }))
    await wrapper.get('[data-synonym-next]').trigger('click')
    await flushPromises()
    expect(mocks.request.mock.calls.at(-1)![1].query.page).toBe(2)
  })
  it('does not refresh or show receipts after unmount during a command', async () => {
    const wrapper = await render()
    await prepare(wrapper)
    const pending = deferred<unknown>()
    mocks.request.mockReturnValueOnce(pending.promise)
    await wrapper.get('[data-synonym-confirm]').trigger('click')
    const count = mocks.request.mock.calls.length
    wrapper.unmount()
    pending.resolve({})
    await flushPromises()
    expect(mocks.request).toHaveBeenCalledTimes(count)
  })
  it('explains expired preview at confirmation without sending a command', async () => {
    const wrapper = await render()
    await prepare(wrapper)
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2100-01-01T00:00:00Z'))
    const count = mocks.request.mock.calls.length
    await wrapper.get('[data-synonym-confirm]').trigger('click')
    expect(mocks.request).toHaveBeenCalledTimes(count)
    expect(wrapper.text()).toContain('La simulación ha caducado')
    expect(wrapper.find('[data-synonym-confirm]').exists()).toBe(false)
  })
  it('rejects a preview for another draft without displaying its results', async () => {
    const wrapper = await render()
    mocks.request.mockImplementationOnce(async (_path, options) => ({
      ...preview(options.body),
      query: 'consulta distinta'
    }))
    await prepare(wrapper)
    expect(wrapper.find('[data-synonym-confirm]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Cloro profesional')
    expect(wrapper.text()).toContain('No se ha podido confirmar la simulación')
  })
  it('does not treat a mismatched receipt or failed receipt lookup as successful or retryable', async () => {
    const wrapper = await render()
    await prepare(wrapper)
    mocks.request.mockResolvedValueOnce({ source: 'cloudflare', commandId: id, previewId: id, action: 'save', item })
    await wrapper.get('[data-synonym-confirm]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).not.toContain('Recibo confirmado')
    mocks.request.mockRejectedValueOnce(new Error('lookup offline'))
    await wrapper.get('[data-synonym-lookup]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-synonym-command-retry]').exists()).toBe(false)
    expect(wrapper.text()).toContain('sigue desconocido')
  })
  it('refreshes a deterministic rejected command without reporting a successful effect', async () => {
    const wrapper = await render()
    await prepare(wrapper, 'edit')
    mocks.request.mockRejectedValueOnce({ statusCode: 409, data: { error: { code: 'version_conflict' } } })
    await wrapper.get('[data-synonym-confirm]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).not.toContain('Recibo confirmado')
    expect(wrapper.find('[data-synonym-confirm]').exists()).toBe(false)
    expect(wrapper.text()).toContain('Cambio rechazado')
    expect(mocks.request.mock.calls.at(-1)![1].method).toBe('GET')
  })
  it('does not expose an old actor receipt or perform a follow-up read after revocation', async () => {
    const wrapper = await render()
    await prepare(wrapper)
    const pending = deferred<unknown>()
    mocks.request.mockReturnValueOnce(pending.promise)
    await wrapper.get('[data-synonym-confirm]').trigger('click')
    const count = mocks.request.mock.calls.length
    session.user.value = { ...session.user.value, id: previewId }
    await flushPromises()
    expect(mocks.request).toHaveBeenCalledTimes(count)
    capabilities.value = { ...capabilities.value, identityId: previewId }
    await flushPromises()
    const afterActorRead = mocks.request.mock.calls.length
    pending.resolve({ source: 'cloudflare', commandId: id, previewId, action: 'save', item })
    await flushPromises()
    expect(afterActorRead).toBe(count + 1)
    expect(mocks.request).toHaveBeenCalledTimes(afterActorRead)
    expect(wrapper.text()).not.toContain('Recibo confirmado')
  })
  it('keeps the latest searched list when an earlier read resolves last', async () => {
    const wrapper = await render()
    const pending = deferred<unknown>()
    mocks.request.mockReturnValueOnce(pending.promise)
    await wrapper.get('[data-synonym-search]').setValue('viejo')
    await wrapper.get('[data-synonym-search-form]').trigger('submit')
    mocks.request.mockResolvedValueOnce(list([{ ...item, sourceTerm: 'Nuevo término' }]))
    await wrapper.get('[data-synonym-search]').setValue('nuevo')
    await wrapper.get('[data-synonym-search-form]').trigger('submit')
    await flushPromises()
    pending.resolve(list())
    await flushPromises()
    expect(wrapper.text()).toContain('Nuevo término')
    expect(wrapper.text()).not.toContain('lejía')
  })
})
