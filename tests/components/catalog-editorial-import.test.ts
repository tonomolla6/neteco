import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h, proxyRefs, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CatalogEditorialImport from '../../app/components/CatalogEditorialImport.vue'
import ProductsPage from '../../app/pages/admin/productos/index.vue'
import { EDITORIAL_CSV_COLUMNS, MAX_BYTES } from '../../shared/catalog-editorial-csv'
import type { EditorialPreview } from '../../shared/catalog-editorial-import'
import '#app/nuxt-vitest-app-entry'

const { requestMock, rawMock, sessionMock, pageFetchMock } = vi.hoisted(() => ({
  requestMock: vi.fn(),
  rawMock: vi.fn(),
  sessionMock: vi.fn(),
  pageFetchMock: vi.fn()
}))
mockNuxtImport('useRequestFetch', () => () => Object.assign(requestMock, { raw: rawMock }))
mockNuxtImport('useUserSession', () => sessionMock)
mockNuxtImport('useFetch', () => pageFetchMock)
mockNuxtImport('useRuntimeConfig', () => () => ({
  app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
  public: { serverRuntime: 'cloudflare', baseUrl: 'https://neteco.invalid' }
}))
mockNuxtImport('useToast', () => () => ({ add: () => undefined }))
const ACTOR = '10000000-0000-4000-8000-000000000063',
  OTHER = '10000000-0000-4000-8000-000000000064',
  PREVIEW = '20000000-0000-4000-8000-000000000063',
  PRODUCT = '30000000-0000-4000-8000-000000000063',
  COMMAND = '40000000-0000-4000-8000-000000000063',
  HASH = 'a'.repeat(64),
  ROOT = '/api/admin/catalog/editorial-import',
  REASON = 'Revisión editorial de los borradores existentes'
const session = () => ({ ready: ref(true), loggedIn: ref(true), user: ref<{ id: string } | null>({ id: ACTOR }) })
function fixture(status: EditorialPreview['status'] = 'pending'): EditorialPreview {
  return {
    source: 'cloudflare',
    outcome: 'preview',
    id: PREVIEW,
    hash: HASH,
    createdAt: new Date(Date.now() - 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    expiresAt: new Date(Date.now() + 29 * 60000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    status,
    products: [
      {
        productId: PRODUCT,
        legacyId: 63,
        expectedVersion: 7,
        before: {
          name: 'Borrador actual',
          shortDesc: null,
          description: '',
          usage: null,
          series: 'Serie previa',
          featured: false
        },
        after: {
          name: 'Borrador editorial',
          shortDesc: 'Descripción breve nueva',
          description: 'Descripción editorial nueva',
          usage: 'Aplicación propuesta',
          series: null,
          featured: true
        }
      }
    ]
  }
}
const receipt = (action: 'apply' | 'revert') => ({
  source: 'cloudflare',
  action,
  previewId: PREVIEW,
  previewHash: HASH,
  commandId: COMMAND,
  productCount: 1,
  updated: true
})
const CSV =
  EDITORIAL_CSV_COLUMNS.join(',') +
  '\r\n' +
  [
    PRODUCT,
    63,
    7,
    'Borrador editorial',
    'Descripción breve nueva',
    'Descripción editorial nueva',
    'Aplicación propuesta',
    '',
    true
  ].join(',') +
  '\r\n'
const Button = defineComponent({
  inheritAttrs: false,
  props: { disabled: Boolean },
  setup:
    (props, { attrs, slots }) =>
    () =>
      h('button', { ...attrs, disabled: props.disabled, type: attrs.type ?? 'button' }, slots.default?.())
})
const mounted: Array<{ unmount: () => void }> = []
let currentSession: ReturnType<typeof session>, state: EditorialPreview
beforeEach(() => {
  currentSession = session()
  state = fixture()
  sessionMock.mockImplementation(() => currentSession)
  requestMock.mockReset()
  rawMock.mockReset()
  requestMock.mockImplementation(async (path: string) => {
    if (path === `${ROOT}/preview`) return structuredClone(state)
    if (path === `${ROOT}/previews/${PREVIEW}`) return structuredClone(state)
    if (path.endsWith('/apply')) {
      state.status = 'applied'
      return receipt('apply')
    }
    if (path.endsWith('/revert')) {
      state.status = 'reverted'
      return receipt('revert')
    }
    throw new Error('unexpected_editorial_path')
  })
})
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
async function render(props: Record<string, unknown> = {}) {
  const wrapper = await mountSuspended(CatalogEditorialImport, {
    props: { runtime: 'cloudflare', available: true, ...props },
    global: { stubs: { UButton: Button } }
  })
  mounted.push(wrapper)
  await flushPromises()
  return wrapper
}
type Wrapper = Awaited<ReturnType<typeof render>>
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
function bytes(text: string) {
  return new TextEncoder().encode(text).buffer as ArrayBuffer
}
function file(text = CSV, name = 'editorial.csv', buffer?: Promise<ArrayBuffer>) {
  const selected = new File([text], name, { type: 'text/csv' })
  Object.defineProperty(selected, 'arrayBuffer', { value: vi.fn(() => buffer ?? Promise.resolve(bytes(text))) })
  return selected
}
async function select(wrapper: Wrapper, selected = file()) {
  const input = wrapper.get('[data-editorial-file]')
  Object.defineProperty(input.element, 'files', { configurable: true, value: [selected] })
  await input.trigger('change')
  await flushPromises()
}
async function preview(wrapper: Wrapper) {
  await select(wrapper)
  await wrapper.get('[data-editorial-preview]').trigger('click')
  await flushPromises()
}
async function submit(wrapper: Wrapper, reason = REASON) {
  await wrapper.get('[data-editorial-reason]').setValue(reason)
  await wrapper.get('[data-editorial-confirm]').setValue(true)
  await wrapper.get('form').trigger('submit')
  await flushPromises()
}
function setup(wrapper: Wrapper) {
  const raw: unknown = Object.getOwnPropertyDescriptor(wrapper.vm.$, 'setupState')?.value
  if (!raw || typeof raw !== 'object') throw new Error('editorial_setup_unavailable')
  return proxyRefs(raw as Record<string, unknown>)
}
function posts() {
  return requestMock.mock.calls.filter((call) => call[1]?.method === 'POST')
}
function downloadResponse(data: ArrayBuffer, headers: Record<string, string> = {}) {
  const response = new Response(null, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="server-editorial.csv"',
      ...headers
    }
  })
  Object.defineProperty(response, '_data', { value: data })
  return response
}

describe('editorial products-page integration', () => {
  async function page() {
    Object.assign(currentSession.user.value!, { role: 'admin', emailVerified: true, mfaVerified: true })
    const status = ref('success'),
      refresh = vi.fn(async () => {
        status.value = 'pending'
      })
    const metadata = ref({
      source: 'cloudflare',
      items: [],
      capabilities: {
        productsRead: true,
        productMetadataUpdate: true,
        productEditorialImport: true
      }
    })
    pageFetchMock.mockImplementation((path: string) => ({
      data: path.endsWith('categories') ? ref({ roots: [], flat: [] }) : metadata,
      status,
      refresh,
      error: ref(null)
    }))
    const wrapper = await mountSuspended(ProductsPage, {
      global: {
        stubs: {
          UiPageHeader: true,
          UiDataTable: true,
          UModal: true,
          UButton: Button,
          CatalogNativeImport: true,
          CatalogFilePreflight: true,
          CatalogImportJob: true,
          CatalogSnapshotExport: true
        }
      }
    })
    mounted.push(wrapper)
    return { wrapper, child: wrapper.findComponent(CatalogEditorialImport), status, refresh, metadata }
  }

  it('retains applied/reverted state and private acknowledgement without an implicit catalogue refresh', async () => {
    const { child, refresh } = await page()
    await preview(child as Wrapper)
    await submit(child as Wrapper)
    expect(refresh).not.toHaveBeenCalled()
    expect(child.text()).toContain('El estado ha sido confirmado por una consulta posterior')
    expect(child.find('[data-editorial-refresh]').exists()).toBe(true)
    expect(child.emitted('changed')?.[0]).toEqual([receipt('apply')])
    await child.get('[data-editorial-refresh]').trigger('click')
    await flushPromises()
    await submit(child as Wrapper, 'Reversión editorial autorizada')
    expect(child.emitted('changed')?.[1]).toEqual([receipt('revert')])
    expect(child.find('[data-editorial-refresh]').exists()).toBe(true)
    expect(refresh).not.toHaveBeenCalled()
    expect(posts()).toHaveLength(3)
    expect(posts().every(([, options]) => options.retry === 0)).toBe(true)
  })

  it.each(['apply', 'revert'] as const)(
    'recovers a lost %s response using GET only without replaying the private intent',
    async (action) => {
      const { child, refresh } = await page()
      await preview(child as Wrapper)
      if (action === 'revert') await submit(child as Wrapper)
      const previousReceipts = child.emitted('changed')?.length ?? 0
      const expectedPosts = action === 'apply' ? 2 : 3
      const implementation = requestMock.getMockImplementation()!
      requestMock.mockImplementation((path: string, options: unknown) => {
        if (path.endsWith(`/${action}`)) {
          state.status = action === 'apply' ? 'applied' : 'reverted'
          return Promise.reject(new Error('private-lost-response'))
        }
        return implementation(path, options)
      })
      await submit(child as Wrapper)
      const retained = setup(child as Wrapper).intent as { key: string; payload: string }
      expect(retained.key).toMatch(/^[0-9a-f-]{36}$/)
      expect(JSON.parse(retained.payload)).toEqual({ previewHash: HASH, reason: REASON })
      expect(child.find('[data-editorial-uncertain]').exists()).toBe(true)
      expect(child.emitted('changed')?.length ?? 0).toBe(previousReceipts)
      expect(refresh).not.toHaveBeenCalled()
      expect(posts()).toHaveLength(expectedPosts)
      expect(child.find('form').exists()).toBe(false)
      await (setup(child as Wrapper).submit as (action: string) => Promise<void>)(action)
      await flushPromises()
      expect(posts()).toHaveLength(expectedPosts)
      await child.get('[data-editorial-refresh]').trigger('click')
      await flushPromises()
      expect(requestMock.mock.calls.at(-1)?.[1]).toEqual(expect.objectContaining({ method: 'GET', retry: 0 }))
      expect(setup(child as Wrapper).intent).toBeNull()
      expect(child.text()).toContain('No se ha reenviado la operación')
      expect(child.emitted('changed')?.length ?? 0).toBe(previousReceipts)
      expect(posts()).toHaveLength(expectedPosts)
    }
  )

  it('rejects foreign receipt/recovery hashes without clearing the frozen intent or replaying a POST', async () => {
    const { child } = await page()
    await preview(child as Wrapper)
    const implementation = requestMock.getMockImplementation()!
    requestMock.mockImplementation((path: string, options: unknown) =>
      path.endsWith('/apply')
        ? Promise.resolve({ ...receipt('apply'), previewHash: 'b'.repeat(64) })
        : implementation(path, options)
    )
    await submit(child as Wrapper)
    const retained = setup(child as Wrapper).intent
    expect(retained).not.toBeNull()
    expect(child.emitted('changed')).toBeUndefined()
    requestMock.mockResolvedValueOnce({ ...state, hash: 'b'.repeat(64), status: 'applied' })
    await child.get('[data-editorial-refresh]').trigger('click')
    await flushPromises()
    expect(setup(child as Wrapper).intent).toEqual(retained)
    expect(child.text()).toContain('No se ha confirmado el estado actual')
    expect(child.emitted('changed')).toBeUndefined()
    expect(posts()).toHaveLength(2)
  })

  it.each(['pending', 'capability', 'mfa', 'owner'] as const)(
    'fails closed and clears a private unknown attempt after parent/session %s changes',
    async (change) => {
      const { child, status, metadata, refresh } = await page()
      await preview(child as Wrapper)
      const implementation = requestMock.getMockImplementation()!
      requestMock.mockImplementation((path: string, options: unknown) =>
        path.endsWith('/apply') ? Promise.reject(new Error('lost')) : implementation(path, options)
      )
      await submit(child as Wrapper)
      expect(setup(child as Wrapper).intent).not.toBeNull()
      if (change === 'pending') status.value = 'pending'
      if (change === 'capability')
        metadata.value = {
          ...metadata.value,
          capabilities: { ...metadata.value.capabilities, productEditorialImport: false }
        }
      if (change === 'mfa') Object.assign(currentSession.user.value!, { mfaVerified: false })
      if (change === 'owner') currentSession.user.value!.id = OTHER
      await flushPromises()
      expect(setup(child as Wrapper).intent).toBeNull()
      expect(setup(child as Wrapper).binding).toBeNull()
      expect(child.emitted('changed')).toBeUndefined()
      expect(refresh).not.toHaveBeenCalled()
      expect(posts()).toHaveLength(2)
    }
  )
})

describe('governed editorial-only CSV import component', () => {
  it.each([
    { available: false },
    { available: undefined },
    { available: 'true' },
    { runtime: 'node' },
    { runtime: 'preview' },
    { runtime: undefined }
  ])('default-off or unavailable context %j does not make requests', async (props) => {
    const wrapper = await render(props)
    expect(wrapper.find('[data-editorial-unavailable]').exists()).toBe(true)
    expect(wrapper.find('input[type="file"]').exists()).toBe(false)
    expect(requestMock).not.toHaveBeenCalled()
    expect(rawMock).not.toHaveBeenCalled()
  })
  it.each(['not-ready', 'logged-out', 'missing-identity'] as const)(
    'identity lifecycle %s cannot expose import state',
    async (change) => {
      if (change === 'not-ready') currentSession.ready.value = false
      if (change === 'logged-out') currentSession.loggedIn.value = false
      if (change === 'missing-identity') currentSession.user.value = null
      const wrapper = await render()
      expect(wrapper.find('[data-editorial-unavailable]').exists()).toBe(true)
      expect(requestMock).not.toHaveBeenCalled()
    }
  )
  it('requires explicit selection and preview, sends only CSV, and renders six escaped metadata fields', async () => {
    state.products[0]!.after.description = '<script>privateText()</script>Descripción segura'
    const wrapper = await render()
    expect(requestMock).not.toHaveBeenCalled()
    await select(wrapper)
    expect(requestMock).not.toHaveBeenCalled()
    await wrapper.get('[data-editorial-preview]').trigger('click')
    await flushPromises()
    expect(requestMock).toHaveBeenCalledTimes(1)
    expect(requestMock.mock.calls[0]).toEqual([
      `${ROOT}/preview`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ csv: CSV }),
        retry: 0,
        credentials: 'same-origin',
        referrerPolicy: 'no-referrer',
        headers: { 'Content-Type': 'application/json' }
      })
    ])
    expect(wrapper.get('[data-editorial-diff]').text()).toContain('Sin valor (null)')
    expect(wrapper.get('[data-editorial-diff]').text()).toContain('Vacío')
    expect(wrapper.get('[data-editorial-diff]').text()).toContain('versión 7')
    expect(wrapper.get('[data-editorial-diff]').text()).toContain(PRODUCT)
    expect(wrapper.findAll('tbody tr')).toHaveLength(6)
    expect(wrapper.find('script').exists()).toBe(false)
    expect(wrapper.find('input[name="price"], input[name="stock"], input[name="status"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('no se publica ningún producto')
    expect(wrapper.find('[data-editorial-apply]').attributes('disabled')).toBeDefined()
  })
  it.each(['editorial.xlsx', 'editorial.json'])('rejects unsupported file %s without transport', async (name) => {
    const wrapper = await render()
    await select(wrapper, file(CSV, name))
    expect(wrapper.text()).toContain('XLSX no está admitido')
    await wrapper.get('[data-editorial-preview]').trigger('click')
    expect(requestMock).not.toHaveBeenCalled()
  })
  it('enforces byte limits and fatal UTF-8 before preview, rather than truncating a file', async () => {
    const wrapper = await render()
    await select(wrapper, file('x'.repeat(MAX_BYTES + 1)))
    expect(wrapper.find('[data-editorial-filename]').exists()).toBe(false)
    await select(wrapper, file(CSV, 'bad.csv', Promise.resolve(new Uint8Array([0xc3, 0x28]).buffer)))
    expect(wrapper.text()).toContain('CSV UTF-8 válido')
    await wrapper.get('[data-editorial-preview]').trigger('click')
    expect(requestMock).not.toHaveBeenCalled()
  })
  it('accepts exactly the byte limit and delegates product count validation to the governed backend', async () => {
    const wrapper = await render(),
      text = 'a'.repeat(MAX_BYTES)
    await select(wrapper, file(text))
    requestMock.mockResolvedValueOnce({
      source: 'cloudflare',
      outcome: 'invalid',
      issues: [
        { code: 'too_many_products', row: 102, field: 'product_id', message: 'El máximo permitido es 100 productos.' }
      ]
    })
    await wrapper.get('[data-editorial-preview]').trigger('click')
    await flushPromises()
    expect(JSON.parse(requestMock.mock.calls[0]![1].body)).toEqual({ csv: text })
    expect(wrapper.get('[data-editorial-issues]').text()).toContain('Fila 102')
    expect(wrapper.find('[data-editorial-diff]').exists()).toBe(false)
    expect(wrapper.find('[data-editorial-apply]').exists()).toBe(false)
  })
  it('ignores a late file read after a new selection and never previews the previous contents', async () => {
    const wrapper = await render(),
      held = deferred<ArrayBuffer>()
    await select(wrapper, file('old-private-csv', 'old.csv', held.promise))
    await select(wrapper, file(CSV, 'new.csv'))
    held.resolve(bytes('old-private-csv'))
    await flushPromises()
    expect(wrapper.get('[data-editorial-filename]').text()).toBe('new.csv')
    await wrapper.get('[data-editorial-preview]').trigger('click')
    await flushPromises()
    expect(JSON.parse(requestMock.mock.calls[0]![1].body)).toEqual({ csv: CSV })
  })
  it('renders invalid row/field issues without an actionable preview or product mutation', async () => {
    requestMock.mockResolvedValueOnce({
      source: 'cloudflare',
      outcome: 'invalid',
      issues: [
        { code: 'invalid_metadata', row: 2, field: 'description', message: 'Completa la descripción del borrador.' }
      ]
    })
    const wrapper = await render()
    await preview(wrapper)
    expect(wrapper.get('[data-editorial-issues]').text()).toContain('Fila 2 · description')
    expect(wrapper.find('[data-editorial-diff]').exists()).toBe(false)
    expect(posts()).toHaveLength(1)
  })
  it.each(['node', 'unknown-field', 'sparse-products', 'duplicate-product'] as const)(
    'malformed DTO %s is not treated as a valid empty preview',
    async (change) => {
      const raw: Record<string, unknown> = structuredClone(state)
      if (change === 'node') raw.source = 'node'
      if (change === 'unknown-field') raw.price = 123
      if (change === 'sparse-products') raw.products = new Array(1)
      if (change === 'duplicate-product') raw.products = [state.products[0], state.products[0]]
      requestMock.mockResolvedValueOnce(raw)
      const wrapper = await render()
      await preview(wrapper)
      expect(wrapper.find('[data-editorial-diff]').exists()).toBe(false)
      expect(wrapper.text()).toContain('No se ha confirmado la vista previa')
    }
  )
  it('rejects DTO getters before evaluation and exposes no stale differences', async () => {
    const getter = vi.fn(() => 'preview'),
      raw = structuredClone(state)
    Object.defineProperty(raw, 'outcome', { enumerable: true, get: getter })
    requestMock.mockResolvedValueOnce(raw)
    const wrapper = await render()
    await preview(wrapper)
    expect(getter).not.toHaveBeenCalled()
    expect(wrapper.find('[data-editorial-diff]').exists()).toBe(false)
  })
  it('requires a valid reason and explicit acknowledgement before a fresh-GET, exact idempotent command and post-GET', async () => {
    const wrapper = await render()
    await preview(wrapper)
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(posts()).toHaveLength(1)
    await submit(wrapper, '  ' + REASON + '  ')
    expect(requestMock.mock.calls.map((call) => call[0])).toEqual([
      `${ROOT}/preview`,
      `${ROOT}/previews/${PREVIEW}`,
      `${ROOT}/previews/${PREVIEW}/apply`,
      `${ROOT}/previews/${PREVIEW}`
    ])
    const command = requestMock.mock.calls[2]![1]
    expect(command).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ previewHash: HASH, reason: REASON }),
      retry: 0,
      credentials: 'same-origin',
      referrerPolicy: 'no-referrer'
    })
    expect(command.headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/)
    for (const call of requestMock.mock.calls.filter((entry) => entry[1]?.method === 'GET'))
      expect(call[1]).toMatchObject({ retry: 0, cache: 'no-store' })
    expect(wrapper.get('[data-editorial-status]').text()).toContain('Aplicada')
    expect(wrapper.emitted('changed')).toEqual([[receipt('apply')]])
    expect(wrapper.get('[data-editorial-reason]').element).toHaveProperty('value', '')
  })
  it('keeps the button disabled while the provider-independent command awaits and never duplicates POST', async () => {
    const held = deferred<unknown>(),
      implementation = requestMock.getMockImplementation()!
    requestMock.mockImplementation((path: string, options: unknown) =>
      path.endsWith('/apply') ? held.promise : implementation(path, options)
    )
    const wrapper = await render()
    await preview(wrapper)
    await submit(wrapper)
    expect(posts()).toHaveLength(2)
    expect(wrapper.get('[data-editorial-apply]').attributes('disabled')).toBeDefined()
    await wrapper.get('form').trigger('submit')
    expect(posts()).toHaveLength(2)
    state.status = 'applied'
    held.resolve(receipt('apply'))
    await flushPromises()
    expect(posts()).toHaveLength(2)
  })
  it('revert uses the historical preview hash and a new reason/key, and becomes readonly after confirmed GET', async () => {
    const wrapper = await render()
    await preview(wrapper)
    await submit(wrapper)
    const applyKey = posts()[1]![1].headers['Idempotency-Key']
    await submit(wrapper, 'Reversión editorial revisada')
    const revert = posts()[2]!
    expect(revert[0]).toBe(`${ROOT}/previews/${PREVIEW}/revert`)
    expect(revert[1].headers['Idempotency-Key']).not.toBe(applyKey)
    expect(JSON.parse(revert[1].body)).toEqual({ previewHash: HASH, reason: 'Reversión editorial revisada' })
    expect(wrapper.get('[data-editorial-status]').text()).toContain('Revertida')
    expect(wrapper.find('form').exists()).toBe(false)
    expect(wrapper.text()).toContain('cambios posteriores')
  })
  it('a failed fresh pre-command GET clears prior facts and sends no product command', async () => {
    const wrapper = await render()
    await preview(wrapper)
    requestMock.mockRejectedValueOnce(new Error('private-DB-info'))
    await submit(wrapper)
    expect(posts()).toHaveLength(1)
    expect(wrapper.find('[data-editorial-diff]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('private-DB-info')
    expect(wrapper.emitted('changed')).toBeUndefined()
  })
  it('a known expired state from the fresh GET prevents apply and never creates a replacement automatically', async () => {
    const wrapper = await render()
    await preview(wrapper)
    state.status = 'expired'
    await submit(wrapper)
    expect(posts()).toHaveLength(1)
    expect(wrapper.get('[data-editorial-status]').text()).toContain('Caducada')
    expect(wrapper.find('form').exists()).toBe(false)
  })
  it('a lost apply response preserves the exact key/body, only manual GET can resolve it, and no POST is retried', async () => {
    const implementation = requestMock.getMockImplementation()!
    requestMock.mockImplementation((path: string, options: unknown) => {
      if (path.endsWith('/apply')) return Promise.reject(new Error('response-lost'))
      return implementation(path, options)
    })
    const wrapper = await render()
    await preview(wrapper)
    await submit(wrapper)
    const command = posts()[1]![1],
      retained = setup(wrapper).intent as { key: string; payload: string }
    expect(retained).toMatchObject({ key: command.headers['Idempotency-Key'], payload: command.body })
    expect(wrapper.get('[data-editorial-uncertain]').text()).toContain('sin reenvío')
    expect(wrapper.find('[data-editorial-diff]').exists()).toBe(false)
    await wrapper.get('[data-editorial-refresh]').trigger('click')
    await flushPromises()
    expect(setup(wrapper).intent).toEqual(expect.objectContaining({ key: retained.key, payload: retained.payload }))
    await wrapper.get('form').trigger('submit')
    expect(posts()).toHaveLength(2)
    state.status = 'applied'
    await wrapper.get('[data-editorial-refresh]').trigger('click')
    await flushPromises()
    expect(setup(wrapper).intent).toBeNull()
    expect(wrapper.get('[data-editorial-status]').text()).toContain('Aplicada')
    expect(posts()).toHaveLength(2)
    expect(wrapper.emitted('changed')).toBeUndefined()
  })
  it('a historical receipt cannot replace failed current-state confirmation', async () => {
    const implementation = requestMock.getMockImplementation()!
    requestMock.mockImplementation((path: string, options: unknown) => {
      if (path === `${ROOT}/previews/${PREVIEW}` && state.status === 'applied')
        return Promise.reject(new Error('read-outage'))
      return implementation(path, options)
    })
    const wrapper = await render()
    await preview(wrapper)
    await submit(wrapper)
    expect(wrapper.find('[data-editorial-diff]').exists()).toBe(false)
    expect(wrapper.get('[data-editorial-feedback]').text()).toContain('falta confirmar el estado actual')
    expect(wrapper.emitted('changed')).toBeUndefined()
    expect(setup(wrapper).intent).not.toBeNull()
    expect(posts()).toHaveLength(2)
  })
  it('typed own-data 409 rollback codes unlock explicit new previews without retrying the rejected write', async () => {
    for (const code of ['version_conflict', 'preview_expired']) {
      const implementation = requestMock.getMockImplementation()!
      requestMock.mockImplementation((path: string, options?: { onResponseError?: (context: unknown) => void }) => {
        if (!path.endsWith('/apply')) return implementation(path, options)
        const response = new Response(null, { status: 409 })
        Object.defineProperty(response, '_data', { value: { error: { code } } })
        options?.onResponseError?.({ response })
        return Promise.reject(new Error('confirmed_editorial_rollback'))
      })
      const wrapper = await render(),
        previousPosts = posts().length
      await preview(wrapper)
      await submit(wrapper)
      expect(posts()).toHaveLength(previousPosts + 2)
      expect(setup(wrapper).intent).toBeNull()
      expect(setup(wrapper).csv).toBe(CSV)
      expect(setup(wrapper).reason).toBe(REASON)
      expect(wrapper.find('[data-editorial-diff]').exists()).toBe(false)
      expect(wrapper.get('[data-editorial-preview]').attributes('disabled')).toBeUndefined()
      expect(wrapper.get('[data-editorial-file]').attributes('disabled')).toBeUndefined()
      expect(wrapper.get('[data-editorial-feedback]').text()).toContain('rechazada sin aplicar cambios')
      expect(wrapper.emitted('changed')).toBeUndefined()
    }
  })
  it('a confirmed expired GET resolves an ambiguous apply without a receipt, reset or repeated POST', async () => {
    const implementation = requestMock.getMockImplementation()!
    requestMock.mockImplementation((path: string, options: unknown) =>
      path.endsWith('/apply') ? Promise.reject(new Error('response-lost')) : implementation(path, options)
    )
    const wrapper = await render()
    await preview(wrapper)
    await submit(wrapper)
    expect(setup(wrapper).intent).not.toBeNull()
    state.status = 'expired'
    await wrapper.get('[data-editorial-refresh]').trigger('click')
    await flushPromises()
    expect(setup(wrapper).intent).toBeNull()
    expect(setup(wrapper).csv).toBe(CSV)
    expect(wrapper.get('[data-editorial-status]').text()).toContain('Caducada')
    expect(wrapper.get('[data-editorial-feedback]').text()).toContain('caducado sin aplicación')
    expect(wrapper.get('[data-editorial-preview]').attributes('disabled')).toBeUndefined()
    expect(posts()).toHaveLength(2)
    expect(wrapper.emitted('changed')).toBeUndefined()
  })
  it('a receipt bound to another preview is ambiguous, not a success, and never causes automatic refresh or retry', async () => {
    const implementation = requestMock.getMockImplementation()!
    requestMock.mockImplementation((path: string, options: unknown) =>
      path.endsWith('/apply')
        ? Promise.resolve({ ...receipt('apply'), previewId: PRODUCT })
        : implementation(path, options)
    )
    const wrapper = await render()
    await preview(wrapper)
    await submit(wrapper)
    expect(wrapper.find('[data-editorial-diff]').exists()).toBe(false)
    expect(wrapper.emitted('changed')).toBeUndefined()
    expect(requestMock.mock.calls.filter((call) => call[1]?.method === 'GET')).toHaveLength(1)
    expect(posts()).toHaveLength(2)
  })
  it('manual refresh errors or a changed hash remove old data without fallback', async () => {
    const wrapper = await render()
    await preview(wrapper)
    requestMock.mockResolvedValueOnce({ ...state, hash: 'b'.repeat(64) })
    await wrapper.get('[data-editorial-refresh]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-editorial-diff]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Borrador editorial')
    requestMock.mockRejectedValueOnce(new Error('403-private-error'))
    await wrapper.get('[data-editorial-refresh]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).not.toContain('403-private-error')
    expect(posts()).toHaveLength(1)
  })
  it.each(['actor', 'runtime', 'available'] as const)(
    'context %s changes clear CSV, preview, reason and any retained command',
    async (change) => {
      const implementation = requestMock.getMockImplementation()!
      requestMock.mockImplementation((path: string, options: unknown) =>
        path.endsWith('/apply') ? Promise.reject(new Error('response-lost')) : implementation(path, options)
      )
      const wrapper = await render()
      await preview(wrapper)
      await submit(wrapper)
      expect(setup(wrapper).intent).not.toBeNull()
      if (change === 'actor') currentSession.user.value = { id: OTHER }
      if (change === 'runtime') await wrapper.setProps({ runtime: 'node' })
      if (change === 'available') await wrapper.setProps({ available: false })
      await flushPromises()
      expect(wrapper.find('[data-editorial-diff]').exists()).toBe(false)
      expect(wrapper.text()).not.toContain(REASON)
      expect(setup(wrapper).csv).toBe('')
      expect(setup(wrapper).reason).toBe('')
      expect(setup(wrapper).intent).toBeNull()
      expect(posts()).toHaveLength(2)
    }
  )
  it('a late preview cannot repopulate private content after actor change or unmount', async () => {
    const held = deferred<unknown>(),
      wrapper = await render()
    requestMock.mockReturnValueOnce(held.promise)
    await select(wrapper)
    await wrapper.get('[data-editorial-preview]').trigger('click')
    currentSession.user.value = { id: OTHER }
    await flushPromises()
    held.resolve(state)
    await flushPromises()
    expect(wrapper.find('[data-editorial-diff]').exists()).toBe(false)
    const second = deferred<unknown>()
    requestMock.mockReturnValueOnce(second.promise)
    await select(wrapper)
    await wrapper.get('[data-editorial-preview]').trigger('click')
    wrapper.unmount()
    second.resolve(state)
    await flushPromises()
    expect(wrapper.emitted('changed')).toBeUndefined()
  })
  it('revocation during the fresh GET prevents the queued POST', async () => {
    const held = deferred<unknown>(),
      wrapper = await render()
    await preview(wrapper)
    requestMock.mockReturnValueOnce(held.promise)
    await submit(wrapper)
    await wrapper.setProps({ available: false })
    held.resolve(state)
    await flushPromises()
    expect(posts()).toHaveLength(1)
    expect(wrapper.emitted('changed')).toBeUndefined()
  })
  it('downloads only an explicit current CSV template to a local blob with a fixed filename, without filling blank cells', async () => {
    const create = vi.fn(() => 'blob:editorial-only'),
      revoke = vi.fn(),
      click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: create, revokeObjectURL: revoke }))
    const incomplete =
      EDITORIAL_CSV_COLUMNS.join(',') + '\r\n' + [PRODUCT, 63, 7, '', '', '', '', '', false].join(',') + '\r\n'
    rawMock.mockResolvedValue(downloadResponse(bytes(incomplete)))
    const wrapper = await render()
    const append = vi.spyOn(window.document.body, 'appendChild')
    expect(rawMock).not.toHaveBeenCalled()
    await wrapper.get('[data-editorial-template]').trigger('click')
    await flushPromises()
    expect(rawMock).toHaveBeenCalledWith(
      `${ROOT}/template`,
      expect.objectContaining({
        method: 'GET',
        responseType: 'arrayBuffer',
        retry: 0,
        cache: 'no-store',
        credentials: 'same-origin',
        referrerPolicy: 'no-referrer'
      })
    )
    expect(create).toHaveBeenCalledTimes(1)
    expect(click).toHaveBeenCalledTimes(1)
    const link = click.mock.instances[0] as HTMLAnchorElement
    expect(link.download).toBe('neteco-editorial-v1.csv')
    expect(link.href).toBe('blob:editorial-only')
    expect(append).toHaveBeenCalledWith(link)
    expect(link.parentNode).toBeNull()
    expect(requestMock).not.toHaveBeenCalled()
    await wrapper.setProps({ available: false })
    expect(revoke).toHaveBeenCalledWith('blob:editorial-only')
  })
  it('a request transport without raw cannot export or create a download', async () => {
    const create = vi.fn(),
      click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: create, revokeObjectURL: vi.fn() }))
    const wrapper = await render()
    Reflect.deleteProperty(requestMock, 'raw')
    await wrapper.get('[data-editorial-template]').trigger('click')
    await flushPromises()
    expect(rawMock).not.toHaveBeenCalled()
    expect(requestMock).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
    expect(click).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('No se ha confirmado la descarga')
  })
  it.each(['oversized', 'wrong-type', 'inline', 'bad-utf8', 'outage'] as const)(
    'template %s does not create or click a download',
    async (change) => {
      const create = vi.fn(),
        click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
      vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: create, revokeObjectURL: vi.fn() }))
      if (change === 'outage') rawMock.mockRejectedValue(new Error('export_too_large'))
      else
        rawMock.mockResolvedValue(
          downloadResponse(
            change === 'oversized'
              ? bytes('a'.repeat(MAX_BYTES + 1))
              : change === 'bad-utf8'
                ? new Uint8Array([0xc3, 0x28]).buffer
                : bytes(CSV),
            change === 'wrong-type'
              ? { 'Content-Type': 'application/json' }
              : change === 'inline'
                ? { 'Content-Disposition': 'inline' }
                : {}
          )
        )
      const wrapper = await render()
      await wrapper.get('[data-editorial-template]').trigger('click')
      await flushPromises()
      expect(create).not.toHaveBeenCalled()
      expect(click).not.toHaveBeenCalled()
      expect(wrapper.text()).toContain('No se exportará una lista parcial')
    }
  )
})
