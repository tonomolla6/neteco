import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h, reactive, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CatalogImportJobCommands from '../../app/components/CatalogImportJobCommands.vue'
import CatalogImportJobPanel from '../../app/components/CatalogImportJob.vue'
import ProductsPage from '../../app/pages/admin/productos/index.vue'
import CatalogNativeImport from '../../app/components/CatalogNativeImport.vue'
import { catalogTabularColumns } from '../../shared/catalog-tabular-core'
import type { CatalogImportJob } from '../../shared/catalog-import-job'
import '#app/nuxt-vitest-app-entry'
import { testNow } from '../support/deterministic'

const { request, session, decode, fetchPage } = vi.hoisted(() => ({
  request: vi.fn(),
  session: vi.fn(),
  decode: vi.fn(),
  fetchPage: vi.fn()
}))
mockNuxtImport('useRequestFetch', () => () => request)
mockNuxtImport('useUserSession', () => session)
mockNuxtImport('useFetch', () => fetchPage)
mockNuxtImport('useRuntimeConfig', () => () => ({
  app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
  public: { serverRuntime: 'cloudflare', baseUrl: 'https://neteco.invalid' }
}))
mockNuxtImport('useToast', () => () => ({ add: () => undefined }))
vi.mock('../../app/utils/catalog-import-file.client', () => ({ decodeCatalogImportFile: decode }))
const ID = '20000000-0000-4000-8000-000000000081',
  HASH = 'b'.repeat(64),
  ACTOR = '10000000-0000-4000-8000-000000000081',
  ROOT = '/api/admin/catalog/import-jobs/' + ID
const utc = (offset = 0) => new Date(testNow() + offset).toISOString().replace(/\.\d{3}Z$/, 'Z')
function job(status: CatalogImportJob['status'] = 'ready', expired = false): CatalogImportJob {
  return {
    source: 'cloudflare',
    outcome: 'job',
    id: ID,
    hash: HASH,
    status,
    createdAt: utc(-3_600_000),
    expiresAt: utc(expired ? -1000 : 1_800_000),
    totalPages: 2,
    receivedPages: 2,
    recordCount: 601,
    counts: { products: 601, variants: 601, assets: 601, mappings: 601 },
    policy: { publication: 'draft_only', media: 'pending_verification', priceStock: 'authorized_initialization' }
  }
}
const receipt = (action: 'apply' | 'revert' = 'apply') => ({
  source: 'cloudflare',
  action,
  jobId: ID,
  jobHash: HASH,
  commandId: '30000000-0000-4000-8000-000000000081',
  counts: job().counts,
  updated: true
})
function identity() {
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
function deferred() {
  let resolve!: (value: unknown) => void
  const promise = new Promise<unknown>((done) => {
    resolve = done
  })
  return { resolve, promise }
}
let actor: ReturnType<typeof identity>,
  wrappers: Awaited<ReturnType<typeof mountSuspended>>[] = []
async function mount(props: Record<string, unknown> = {}) {
  const wrapper = await mountSuspended(CatalogImportJobCommands, {
    props: { runtime: 'cloudflare', available: true, job: job(), ...props }
  })
  wrappers.push(wrapper)
  return wrapper
}
async function confirm(
  wrapper: Awaited<ReturnType<typeof mount>>,
  reason = 'Inicialización explícitamente autorizada'
) {
  await wrapper.get('[data-command-reason]').setValue(reason)
  await wrapper.get('[data-command-confirm]').setValue(true)
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(testNow())
  vi.clearAllMocks()
  actor = identity()
  session.mockReturnValue(actor)
  request.mockResolvedValue(receipt())
})

describe('native products-page receipt recovery', () => {
  async function prepareNativePage() {
    const status = ref('success'),
      refresh = vi.fn(async () => {
        status.value = 'pending'
      })
    fetchPage.mockImplementation((path: string) => ({
      data: ref(
        path.endsWith('categories')
          ? { roots: [], flat: [] }
          : {
              source: 'cloudflare',
              items: [],
              capabilities: {
                productsRead: true,
                productMetadataUpdate: true,
                productEditorialImport: true,
                productNativeImport: true
              }
            }
      ),
      status,
      refresh,
      error: ref(null)
    }))
    const snapshot = {
      source: 'cloudflare',
      outcome: 'preview',
      id: ID,
      hash: HASH,
      status: 'pending',
      createdAt: utc(-1000),
      expiresAt: utc(1_800_000),
      counts: { products: 1, variants: 1, assets: 1, mappings: 1 },
      policy: job().policy
    }
    const nativeReceipt = (action: 'apply' | 'revert') => ({
      source: 'cloudflare',
      action,
      previewId: ID,
      previewHash: HASH,
      commandId: '30000000-0000-4000-8000-000000000081',
      counts: snapshot.counts,
      updated: true
    })
    let state = snapshot
    request.mockImplementation(async (path: string) => {
      if (path.endsWith('/apply') || path.endsWith('/revert')) {
        const action = path.endsWith('/apply') ? 'apply' : 'revert'
        state = { ...snapshot, status: action === 'apply' ? 'applied' : 'reverted' }
        return nativeReceipt(action)
      }
      return state
    })
    decode.mockResolvedValue({
      records: [Object.fromEntries(catalogTabularColumns.map((key) => [key, '']))],
      validation: { valid: true, issues: [] }
    })
    const wrapper = await mountSuspended(ProductsPage, {
      global: {
        stubs: {
          UiPageHeader: true,
          UiDataTable: true,
          UModal: true,
          UButton: true,
          CatalogEditorialImport: true,
          CatalogFilePreflight: true,
          CatalogImportJob: true,
          CatalogSnapshotExport: true
        }
      }
    })
    wrappers.push(wrapper)
    const native = wrapper.findComponent(CatalogNativeImport)
    const source = new File([new Uint8Array([1])], 'catalogo.csv')
    Object.defineProperty(source, 'arrayBuffer', { value: async () => new Uint8Array([1]).buffer })
    const input = native.get('input[type=file]')
    Object.defineProperty(input.element, 'files', { configurable: true, value: [source] })
    await input.trigger('change')
    await flushPromises()
    await native.get('[data-native-preview]').trigger('click')
    await flushPromises()
    await native.get('[data-native-reason]').setValue('Inicialización autorizada del catálogo')
    await native.get('[data-native-confirm]').setValue(true)
    await native.get('[data-native-apply]').trigger('click')
    await flushPromises()
    return { wrapper, native, refresh, status }
  }

  it('retains validated receipt and binding without an implicit catalogue refresh; manual GET enables explicit revert', async () => {
    const { native, refresh } = await prepareNativePage()
    expect(refresh).not.toHaveBeenCalled()
    expect(native.text()).toContain('Recibo validado: lote aplicado')
    expect(native.find('[data-native-refresh]').exists()).toBe(true)
    expect(request).toHaveBeenCalledTimes(2)
    await native.get('[data-native-refresh]').trigger('click')
    await flushPromises()
    expect(native.get('[data-native-summary]').text()).toContain('applied')
    expect(request.mock.calls.at(-1)?.[1]).toEqual(expect.objectContaining({ method: 'GET', retry: 0 }))
    await native.get('[data-native-reason]').setValue('Reversión explícitamente autorizada')
    await native.get('[data-native-confirm]').setValue(true)
    await native.get('[data-native-revert]').trigger('click')
    await flushPromises()
    expect(native.text()).toContain('Recibo validado: reversión compensatoria')
    expect(native.find('[data-native-refresh]').exists()).toBe(true)
    expect(refresh).not.toHaveBeenCalled()
    expect(request.mock.calls.filter(([, options]) => options.method === 'POST')).toHaveLength(3)
  })

  it.each(['pending', 'error'])('still clears native state when catalogue authority becomes %s', async (revoked) => {
    const { native, refresh, status } = await prepareNativePage()
    expect(refresh).not.toHaveBeenCalled()
    status.value = revoked
    await flushPromises()
    expect(native.find('section').exists()).toBe(false)
    status.value = 'success'
    await flushPromises()
    expect(native.find('section').exists()).toBe(true)
    expect(native.find('[data-native-refresh]').exists()).toBe(false)
    expect(native.text()).not.toContain('Recibo validado')
    expect(request).toHaveBeenCalledTimes(2)
  })
})

describe('prepared job panel command integration', () => {
  async function preparePanel(commandsAvailable?: boolean) {
    const sealed = {
      ...job(),
      totalPages: 1,
      receivedPages: 1,
      recordCount: 1,
      counts: { products: 1, variants: 1, assets: 1, mappings: 1 }
    }
    let state: CatalogImportJob = {
      ...sealed,
      status: 'uploading',
      hash: null,
      receivedPages: 0,
      counts: { products: 0, variants: 0, assets: 0, mappings: 0 },
      expiresAt: utc(86_400_000)
    }
    decode.mockResolvedValue({
      records: [Object.fromEntries(catalogTabularColumns.map((key) => [key, '']))],
      validation: { valid: true, issues: [] }
    })
    request.mockImplementation(async (path: string, options: { method: string }) => {
      if (path.endsWith('/apply') || path.endsWith('/revert')) {
        const action = path.endsWith('/apply') ? 'apply' : 'revert'
        state = { ...sealed, status: action === 'apply' ? 'applied' : 'reverted' }
        return { ...receipt(action), counts: sealed.counts }
      }
      if (options.method === 'PUT') state = { ...state, receivedPages: 1, counts: sealed.counts }
      if (path.endsWith('/seal')) state = sealed
      return state
    })
    const wrapper = await mountSuspended(CatalogImportJobPanel, {
      props: {
        runtime: 'cloudflare',
        available: true,
        ...(commandsAvailable === undefined ? {} : { commandsAvailable })
      }
    })
    wrappers.push(wrapper)
    const source = new File([new Uint8Array([1])], 'catalogo.csv')
    Object.defineProperty(source, 'arrayBuffer', { value: async () => new Uint8Array([1]).buffer })
    const input = wrapper.get('input[type=file]')
    Object.defineProperty(input.element, 'files', { configurable: true, value: [source] })
    await input.trigger('change')
    await flushPromises()
    await wrapper.get('[data-job-create]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-job-upload]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-job-reason]').setValue('Revisión explícita del lote')
    await wrapper.get('[data-job-confirm]').setValue(true)
    await wrapper.get('[data-job-seal]').trigger('click')
    await flushPromises()
    return { wrapper, sealed }
  }

  it('keeps preparation read-only with respect to apply/revert when command availability is absent', async () => {
    const { wrapper } = await preparePanel()
    expect(wrapper.emitted('prepared')).toHaveLength(1)
    expect(wrapper.find('[data-command-apply]').exists()).toBe(false)
    expect(request.mock.calls.some(([path]) => /\/(apply|revert)$/.test(path))).toBe(false)
  })

  it('keeps the complete preview hash wrappable inside the summary', async () => {
    const { wrapper, sealed } = await preparePanel(true)
    const hash = wrapper.get('[data-job-summary] [data-job-hash]')
    expect(hash.text()).toBe(sealed.hash)
    expect(hash.text()).toHaveLength(64)
    expect(hash.classes()).toContain('break-all')
  })

  it('retains commands through validated applied and reverted GETs, without optimistic state', async () => {
    const { wrapper, sealed } = await preparePanel(true)
    expect(wrapper.find('[data-command-apply]').exists()).toBe(true)
    await confirm(wrapper)
    await wrapper.get('[data-command-apply]').trigger('click')
    await flushPromises()
    expect(wrapper.emitted('completed')?.[0]).toEqual([{ ...receipt(), counts: sealed.counts }])
    expect(wrapper.get('[data-job-summary]').text()).toContain('ready')
    expect(wrapper.text()).toContain('No se ha aplicado ningún producto')
    await wrapper.get('[data-command-refresh]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-job-summary]').text()).toContain('applied')
    expect(wrapper.text()).not.toContain('No se ha aplicado ningún producto')
    expect(wrapper.find('[data-command-revert]').exists()).toBe(true)
    await confirm(wrapper, 'Reversión explícitamente autorizada')
    await wrapper.get('[data-command-revert]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-job-summary]').text()).toContain('applied')
    await wrapper.get('[data-command-refresh]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-job-summary]').text()).toContain('reverted')
    expect(wrapper.text()).not.toContain('No se ha aplicado ningún producto')
    expect(wrapper.find('[data-command-refresh]').exists()).toBe(true)
    expect(wrapper.emitted('completed')).toHaveLength(2)
    expect(request.mock.calls.filter(([path]) => /\/(apply|revert)$/.test(path))).toHaveLength(2)
    // Recovery belongs to the command child once sealed: the staging GET must
    // not unmount it and discard an unresolved idempotent intent.
    expect(wrapper.find('[data-job-recover]').exists()).toBe(false)
  })

  it('preserves an unknown command across the parent GET update until explicit same-intent replay', async () => {
    const { wrapper, sealed } = await preparePanel(true)
    request.mockRejectedValueOnce(new Error('lost response'))
    await confirm(wrapper)
    await wrapper.get('[data-command-apply]').trigger('click')
    await flushPromises()
    const original = request.mock.calls.at(-1)
    expect(wrapper.find('[data-job-recover]').exists()).toBe(false)
    request.mockResolvedValueOnce({ ...sealed, status: 'applied' })
    await wrapper.get('[data-command-refresh]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-job-summary]').text()).toContain('applied')
    expect(wrapper.emitted('completed')).toBeUndefined()
    expect(wrapper.find('[data-command-retry]').exists()).toBe(true)
    request.mockResolvedValueOnce({ ...receipt(), counts: sealed.counts })
    await wrapper.get('[data-command-retry]').trigger('click')
    await flushPromises()
    expect(request.mock.calls.at(-1)).toEqual(original)
    expect(wrapper.emitted('completed')).toHaveLength(1)
  })
})
afterEach(() => {
  for (const wrapper of wrappers) wrapper.unmount()
  wrappers = []
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('prepared job commands require explicit current authority and durable receipts', () => {
  it('never fetches or writes automatically and explains draft/media/compensation authority', async () => {
    const wrapper = await mount()
    expect(request).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('borradores')
    expect(wrapper.text()).toContain('pendientes')
    expect(wrapper.text()).toContain('sin cambios ni uso posterior')
    expect(wrapper.text()).toContain('auditoría')
  })
  it.each(['node', null, 'Cloudflare'])('refuses runtime %s', async (runtime) => {
    expect((await mount({ runtime })).find('section').exists()).toBe(false)
  })
  it('defaults capability to false and requires a strict true', async () => {
    const wrapper = await mountSuspended(CatalogImportJobCommands, { props: { runtime: 'cloudflare', job: job() } })
    wrappers.push(wrapper)
    expect(wrapper.find('section').exists()).toBe(false)
    expect((await mount({ available: false })).find('section').exists()).toBe(false)
    expect((await mount({ available: 'true' })).find('section').exists()).toBe(false)
  })
  it.each(['ready', 'loggedIn', 'role', 'id', 'emailVerified', 'mfaVerified'])(
    'rejects auth drift %s',
    async (field) => {
      if (field === 'ready' || field === 'loggedIn') actor[field].value = false
      else actor.user.value![field] = field === 'id' ? 'bad' : field === 'role' ? 'customer' : false
      expect((await mount()).find('section').exists()).toBe(false)
      expect(request).not.toHaveBeenCalled()
    }
  )
  it.each([null, {}, { ...job(), status: 'uploading', hash: null }, { ...job(), hash: 'wrong' }])(
    'rejects malformed or uploading jobs',
    async (value) => {
      expect((await mount({ job: value })).find('section').exists()).toBe(false)
    }
  )
  it('requires reason and confirmation, bounds reason, then emits only a validated receipt', async () => {
    const wrapper = await mount()
    expect(wrapper.get('[data-command-apply]').attributes('disabled')).toBeDefined()
    for (const value of ['', 'ab', 'x'.repeat(501), 'bad\nreason']) {
      await confirm(wrapper, value)
      expect(wrapper.get('[data-command-apply]').attributes('disabled')).toBeDefined()
    }
    await wrapper.get('[data-command-reason]').setValue('  Motivo válido  ')
    await wrapper.get('[data-command-confirm]').setValue(false)
    expect(wrapper.get('[data-command-apply]').attributes('disabled')).toBeDefined()
    await wrapper.get('[data-command-confirm]').setValue(true)
    await wrapper.get('[data-command-apply]').trigger('click')
    await flushPromises()
    expect(request).toHaveBeenCalledExactlyOnceWith(
      ROOT + '/apply',
      expect.objectContaining({
        method: 'POST',
        retry: 0,
        body: JSON.stringify({ previewHash: HASH, reason: 'Motivo válido' }),
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': expect.stringMatching(/^[0-9a-f-]{36}$/) }
      })
    )
    expect(wrapper.emitted('completed')?.[0]).toEqual([receipt()])
    expect(wrapper.emitted('updated')).toBeUndefined()
    expect(wrapper.get('[data-command-apply]').attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('Recibo validado')
  })
  it('blocks first apply after TTL but allows explicit revert after TTL', async () => {
    const wrapper = await mount({ job: job('ready', true) })
    await confirm(wrapper)
    expect(wrapper.get('[data-command-apply]').attributes('disabled')).toBeDefined()
    const applied = await mount({ job: job('applied', true) })
    await confirm(applied)
    request.mockResolvedValueOnce(receipt('revert'))
    await applied.get('[data-command-revert]').trigger('click')
    await flushPromises()
    expect(applied.emitted('completed')?.[0]).toEqual([receipt('revert')])
  })
  it.each([
    { source: 'node' },
    { action: 'revert' },
    { jobId: ACTOR },
    { jobHash: 'c'.repeat(64) },
    { commandId: 'invalid' },
    { counts: { ...job().counts, variants: 600 } },
    { updated: false },
    { stack: 'SELECT private_password' },
    { counts: { ...job().counts, assets: 25001 } }
  ])('never completes on malformed/foreign receipt %j', async (change) => {
    request.mockResolvedValueOnce({ ...receipt(), ...change })
    const wrapper = await mount()
    await confirm(wrapper)
    await wrapper.get('[data-command-apply]').trigger('click')
    await flushPromises()
    expect(wrapper.emitted('completed')).toBeUndefined()
    expect(wrapper.text()).toContain('Resultado no confirmado')
    expect(wrapper.text()).not.toContain('SELECT')
    expect(wrapper.find('[data-command-retry]').exists()).toBe(true)
  })
  it('retains the exact unknown intent across read-only GET/status change/TTL and explicit replay', async () => {
    const initial = job(),
      wrapper = await mount({ job: initial })
    request.mockRejectedValueOnce(new Error('private SQL stack'))
    await confirm(wrapper)
    await wrapper.get('[data-command-apply]').trigger('click')
    await flushPromises()
    const command = request.mock.calls[0]
    expect(wrapper.get('[data-command-reason]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-command-confirm]').attributes('disabled')).toBeDefined()
    const recovered = { ...initial, status: 'applied' as const }
    request.mockResolvedValueOnce(recovered)
    await wrapper.get('[data-command-refresh]').trigger('click')
    await flushPromises()
    expect(wrapper.emitted('updated')?.[0]).toEqual([recovered])
    expect(wrapper.emitted('completed')).toBeUndefined()
    expect(request).toHaveBeenCalledTimes(2)
    await wrapper.setProps({ job: recovered })
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(initial.expiresAt) + 1000)
    request.mockResolvedValueOnce(receipt())
    await wrapper.get('[data-command-retry]').trigger('click')
    await flushPromises()
    expect(request.mock.calls[2]).toEqual(command)
    expect(wrapper.emitted('completed')?.[0]).toEqual([receipt()])
  })
  it.each(['id', 'hash', 'expiresAt', 'counts', 'policy', 'recordCount'])(
    'rejects GET binding drift %s',
    async (field) => {
      const initial = job(),
        wrapper = await mount({ job: initial })
      const changes: Record<string, unknown> = {
        id: ACTOR,
        hash: 'd'.repeat(64),
        expiresAt: utc(900_000),
        counts: { ...initial.counts, products: 600 },
        policy: { ...initial.policy, publication: 'published' },
        recordCount: 602
      }
      request.mockResolvedValueOnce({ ...initial, [field]: changes[field] })
      await wrapper.get('[data-command-refresh]').trigger('click')
      await flushPromises()
      expect(wrapper.emitted('updated')).toBeUndefined()
      expect(wrapper.text()).toContain('No se ha confirmado el estado')
    }
  )
  it('rejects server status regression and never auto commands for reverted', async () => {
    const initial = job('reverted'),
      wrapper = await mount({ job: initial })
    request.mockResolvedValueOnce({ ...initial, status: 'ready' })
    await wrapper.get('[data-command-refresh]').trigger('click')
    await flushPromises()
    expect(wrapper.emitted('updated')).toBeUndefined()
    await confirm(wrapper)
    expect(wrapper.get('[data-command-apply]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-command-revert]').attributes('disabled')).toBeDefined()
  })
  it('double click sends once and late response after unmount cannot emit', async () => {
    const waiting = deferred(),
      wrapper = await mount()
    request.mockReturnValueOnce(waiting.promise)
    await confirm(wrapper)
    await wrapper.get('[data-command-apply]').trigger('click')
    await wrapper.get('[data-command-apply]').trigger('click')
    expect(request).toHaveBeenCalledTimes(1)
    wrapper.unmount()
    waiting.resolve(receipt())
    await flushPromises()
    expect(wrapper.emitted('completed')).toBeUndefined()
  })
  it.each(['owner', 'mfa', 'runtime', 'capability', 'job'])(
    'clears retained intent and drops late promise on %s',
    async (change) => {
      const wrapper = await mount(),
        waiting = deferred()
      request.mockReturnValueOnce(waiting.promise)
      await confirm(wrapper)
      await wrapper.get('[data-command-apply]').trigger('click')
      if (change === 'owner') actor.user.value!.id = '10000000-0000-4000-8000-000000000082'
      if (change === 'mfa') actor.user.value!.mfaVerified = false
      if (change === 'runtime') await wrapper.setProps({ runtime: 'node' })
      if (change === 'capability') await wrapper.setProps({ available: false })
      if (change === 'job') await wrapper.setProps({ job: { ...job(), id: ACTOR } })
      waiting.resolve(receipt())
      await flushPromises()
      expect(wrapper.emitted('completed')).toBeUndefined()
      expect(wrapper.find('[data-command-retry]').exists()).toBe(false)
      expect(request).toHaveBeenCalledTimes(1)
    }
  )
  it('rejects job/session getters without evaluating them', async () => {
    const getter = vi.fn(() => HASH),
      value = job()
    Object.defineProperty(value, 'hash', { enumerable: true, get: getter })
    const Host = defineComponent({
      setup: () => () =>
        h(CatalogImportJobCommands, {
          runtime: 'cloudflare',
          available: true,
          job: value
        })
    })
    const wrapper = await mountSuspended(Host)
    wrappers.push(wrapper)
    expect(wrapper.find('section').exists()).toBe(false)
    expect(getter).not.toHaveBeenCalled()
    const sessionGetter = vi.fn(() => true)
    Object.defineProperty(actor.user.value!, 'mfaVerified', { configurable: true, get: sessionGetter })
    expect((await mount()).find('section').exists()).toBe(false)
    expect(sessionGetter).not.toHaveBeenCalled()
  })
  it('tracks nested same-object job count changes and clears unknown intent', async () => {
    const value = reactive(job()),
      Host = defineComponent({
        setup: () => () =>
          h(CatalogImportJobCommands, {
            runtime: 'cloudflare',
            available: true,
            job: value
          })
      })
    const wrapper = await mountSuspended(Host)
    wrappers.push(wrapper)
    request.mockRejectedValueOnce(new Error('lost'))
    await confirm(wrapper)
    await wrapper.get('[data-command-apply]').trigger('click')
    await flushPromises()
    value.counts.assets = 600
    await flushPromises()
    expect(wrapper.find('[data-command-retry]').exists()).toBe(false)
    expect(wrapper.get('[data-command-reason]').element).toHaveProperty('value', '')
  })
  it('checks TTL at the explicit click, not merely at mount', async () => {
    const value = job(),
      wrapper = await mount({ job: value })
    await confirm(wrapper)
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(value.expiresAt))
    await wrapper.get('[data-command-apply]').trigger('click')
    expect(request).not.toHaveBeenCalled()
  })
  it('fails closed if a secure command key cannot be generated', async () => {
    const wrapper = await mount()
    await confirm(wrapper)
    vi.spyOn(crypto, 'randomUUID').mockImplementationOnce(() => {
      throw new Error('private_provider_error')
    })
    await wrapper.get('[data-command-apply]').trigger('click')
    expect(request).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('No se ha enviado')
    expect(wrapper.text()).not.toContain('private_provider_error')
  })
  it('clears unknown intent on revocation even if authority is later restored', async () => {
    const wrapper = await mount()
    request.mockRejectedValueOnce(new Error('lost'))
    await confirm(wrapper)
    await wrapper.get('[data-command-apply]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-command-retry]').exists()).toBe(true)
    actor.user.value!.mfaVerified = false
    await flushPromises()
    actor.user.value!.mfaVerified = true
    await flushPromises()
    expect(wrapper.find('[data-command-retry]').exists()).toBe(false)
    expect(wrapper.get('[data-command-confirm]').element).toHaveProperty('checked', false)
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('drops late GET after actor switch and never emits foreign-owner state', async () => {
    const wrapper = await mount(),
      waiting = deferred()
    request.mockReturnValueOnce(waiting.promise)
    await wrapper.get('[data-command-refresh]').trigger('click')
    actor.user.value!.id = '10000000-0000-4000-8000-000000000082'
    waiting.resolve(job('applied'))
    await flushPromises()
    expect(wrapper.emitted('updated')).toBeUndefined()
    expect(wrapper.emitted('completed')).toBeUndefined()
  })
  it.each(['hash', 'expiresAt', 'policy'])('clears unknown intent on a new immutable %s binding', async (field) => {
    const wrapper = await mount()
    request.mockRejectedValueOnce(new Error('lost'))
    await confirm(wrapper)
    await wrapper.get('[data-command-apply]').trigger('click')
    await flushPromises()
    const initial = job(),
      changes: Record<string, unknown> = {
        hash: 'c'.repeat(64),
        expiresAt: utc(900_000),
        policy: { ...initial.policy, media: 'approved' }
      }
    await wrapper.setProps({ job: { ...initial, [field]: changes[field] } })
    expect(wrapper.find('[data-command-retry]').exists()).toBe(false)
    expect(wrapper.emitted('completed')).toBeUndefined()
  })
  it('does not re-authorize new writes from a regressed external status', async () => {
    const initial = job('applied'),
      wrapper = await mount({ job: initial })
    await confirm(wrapper)
    await wrapper.setProps({ job: { ...initial, status: 'ready' } })
    await confirm(wrapper)
    expect(wrapper.get('[data-command-apply]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-command-revert]').attributes('disabled')).toBeDefined()
    expect(request).not.toHaveBeenCalled()
  })
  it.each(['receipt', 'state'])('rejects response accessors without evaluating them: %s', async (kind) => {
    const getter = vi.fn(() => true),
      value = kind === 'receipt' ? receipt() : job()
    Object.defineProperty(value, kind === 'receipt' ? 'updated' : 'hash', { enumerable: true, get: getter })
    const wrapper = await mount()
    request.mockResolvedValueOnce(value)
    if (kind === 'receipt') {
      await confirm(wrapper)
      await wrapper.get('[data-command-apply]').trigger('click')
    } else await wrapper.get('[data-command-refresh]').trigger('click')
    await flushPromises()
    expect(getter).not.toHaveBeenCalled()
    expect(wrapper.emitted('completed')).toBeUndefined()
    expect(wrapper.emitted('updated')).toBeUndefined()
  })
  it('never renders unexpected long response data, HTML, SQL or stack', async () => {
    const wrapper = await mount()
    request.mockResolvedValueOnce({ ...receipt(), stack: '<img src=x onerror=alert(1)>SELECT secret'.repeat(1000) })
    await confirm(wrapper)
    await wrapper.get('[data-command-apply]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).not.toContain('SELECT')
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.emitted('completed')).toBeUndefined()
  })
})
