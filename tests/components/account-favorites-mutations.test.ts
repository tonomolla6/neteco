import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h, proxyRefs, ref, shallowRef } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import FavoritesPage from '../../app/pages/cuenta/listas.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
  refresh: vi.fn(),
  add: vi.fn(),
  session: vi.fn(),
  config: vi.fn(() => ({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'cloudflare' }
  })),
  blocked: false
}))
mockNuxtImport('useFetch', () => mocks.read)
mockNuxtImport('$fetch', () => mocks.write)
mockNuxtImport('useRuntimeConfig', () => mocks.config)
mockNuxtImport('useUserSession', () => mocks.session)
vi.mock('../../app/stores/cart', () => ({
  useCartStore: () => ({
    add: mocks.add,
    get pendingMutation() {
      return mocks.blocked
    },
    get blockedMutations() {
      return mocks.blocked
    }
  })
}))

const LIST_ID = '20000000-0000-4000-8000-000000000041'
const NEW_ID = '20000000-0000-4000-8000-000000000042'
const item = {
  variantId: '10000000-0000-4000-8000-000000000041',
  cartVariantId: 11,
  sku: 'SYNTHETIC',
  quantity: '3',
  name: 'Referencia privada',
  slug: 'referencia',
  format: 'Caja',
  unitLabel: 'cajas',
  minimumQuantity: 1,
  maximumQuantity: null,
  quantityIncrement: 1,
  available: true,
  reason: null
}
const initial = () => ({ lists: [{ id: LIST_ID, name: 'Lista privada', isDefault: false, items: [{ ...item }] }] })
const Surface = defineComponent({
  setup(_, { slots }) {
    return () => h('div', slots.default?.())
  }
})
const Button = defineComponent({
  props: ['disabled', 'loading'],
  setup(props, { slots }) {
    return () => h('button', { disabled: props.disabled || props.loading }, slots.default?.())
  }
})
const Feedback = defineComponent({
  props: ['notice', 'error'],
  setup(props) {
    return () => h('div', [props.notice, props.error])
  }
})
let wrapper: Awaited<ReturnType<typeof mountSuspended>> | undefined
let state: ReturnType<typeof shallowRef<unknown>>
let status: ReturnType<typeof ref<string>>
let error: ReturnType<typeof shallowRef<unknown>>
let auth: {
  ready: ReturnType<typeof ref<boolean>>
  loggedIn: ReturnType<typeof ref<boolean>>
  user: ReturnType<typeof ref<{ id: string; emailVerified: boolean; role: string }>>
  session: ReturnType<typeof ref<{ sessionId: string; sessionVersion: number }>>
}
let server: ReturnType<typeof initial>
function actions() {
  return proxyRefs(wrapper!.setupState) as unknown as {
    newListName: string
    editingListName: string
    createList(): Promise<void>
    renameList(v: unknown): Promise<void>
    deleteList(v: unknown): Promise<void>
    saveItem(id: string, v: unknown, q: number): Promise<void>
    removeItem(id: string, variant: string): Promise<void>
    addListToCart(v: unknown): Promise<void>
    reviewUncertain(): Promise<void>
    continueAfterReview(): void
    continueBatch(): Promise<void>
  }
}
async function render() {
  state = shallowRef(structuredClone(server))
  status = ref('success')
  error = shallowRef(null)
  mocks.read.mockReturnValue({ data: state, status, error, refresh: mocks.refresh })
  mocks.refresh.mockImplementation(async () => {
    state.value = structuredClone(server)
    status.value = 'success'
    error.value = null
  })
  wrapper = await mountSuspended(FavoritesPage, {
    global: {
      stubs: {
        UiPageHeader: Surface,
        UiSurface: Surface,
        UiEmptyState: Surface,
        AccountFeedback: Feedback,
        UButton: Button,
        UInput: true,
        USelect: true,
        UBadge: Surface,
        UFormField: Surface
      }
    }
  })
  return actions()
}
function deferred() {
  let resolve!: (v: unknown) => void
  const promise = new Promise((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
const kinds = ['create', 'rename', 'delete', 'save', 'remove'] as const
type Kind = (typeof kinds)[number]
async function mutate(kind: Kind) {
  const api = actions()
  api.newListName = 'Nueva privada'
  api.editingListName = 'Renombrada privada'
  if (kind === 'create') return api.createList()
  if (kind === 'rename') return api.renameList(server.lists[0])
  if (kind === 'delete') return api.deleteList(server.lists[0])
  if (kind === 'save') return api.saveItem(LIST_ID, item, 6)
  return api.removeItem(LIST_ID, item.variantId)
}
function commit(kind: Kind) {
  if (kind === 'create') {
    server.lists.push({ id: NEW_ID, name: 'Nueva privada', isDefault: false, items: [] })
    return { ok: true, id: NEW_ID }
  }
  if (kind === 'rename') server.lists[0]!.name = 'Renombrada privada'
  if (kind === 'delete') server.lists = []
  if (kind === 'save') {
    server.lists[0]!.items[0]!.quantity = '6'
    return { listId: LIST_ID, variantId: item.variantId, quantity: 6 }
  }
  if (kind === 'remove') server.lists[0]!.items = []
  return { ok: true, id: LIST_ID }
}
beforeEach(() => {
  server = initial()
  mocks.blocked = false
  for (const fn of [mocks.read, mocks.write, mocks.refresh, mocks.add]) fn.mockReset()
  mocks.add.mockResolvedValue(undefined)
  auth = {
    ready: ref(true),
    loggedIn: ref(true),
    user: ref({ id: '30000000-0000-4000-8000-000000000041', emailVerified: true, role: 'customer' }),
    session: ref({ sessionId: '40000000-0000-4000-8000-000000000041', sessionVersion: 1 })
  }
  mocks.session.mockReturnValue(auth)
  Object.defineProperty(window, 'confirm', { value: vi.fn(() => true), configurable: true, writable: true })
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  vi.restoreAllMocks()
})
describe('favorite mutations: actual ACK plus current read, no fictional receipt', () => {
  it.each(kinds)('%s confirms only correlated ACK plus fresh state', async (kind) => {
    await render()
    mocks.write.mockImplementation(async () => commit(kind))
    await mutate(kind)
    expect(mocks.write).toHaveBeenCalledTimes(1)
    expect(mocks.write.mock.calls[0]![1]).toMatchObject({ retry: 0 })
    expect(mocks.refresh).toHaveBeenCalledTimes(1)
    expect(wrapper!.text()).not.toContain('resultado incierto')
    expect(wrapper!.text()).toMatch(/creada|actualizado|eliminada|guardada|quitada/)
  })
  it.each(kinds)('%s does not announce success or release the intent after failed GET', async (kind) => {
    await render()
    mocks.write.mockImplementation(async () => commit(kind))
    mocks.refresh.mockRejectedValue(new Error('private SQL'))
    await mutate(kind)
    expect(wrapper!.text()).toContain('resultado incierto')
    expect(wrapper!.text()).not.toContain('private SQL')
    await actions().createList()
    expect(mocks.write).toHaveBeenCalledTimes(1)
    if (kind === 'create') expect(actions().newListName).toBe('Nueva privada')
  })
  it.each(kinds)('%s rejects malformed ACK even if a GET could look successful', async (kind) => {
    await render()
    mocks.write.mockResolvedValue({ ok: true, id: 'foreign' })
    await mutate(kind)
    expect(wrapper!.text()).toContain('resultado incierto')
  })
  it.each(['identity', 'sessionId', 'sessionVersion', 'email', 'logout'])(
    'purges private state on %s changes and rejects late completion',
    async (boundary) => {
      const api = await render()
      const wait = deferred()
      mocks.write.mockReturnValue(wait.promise)
      api.newListName = 'Borrador privado'
      const writing = api.createList()
      if (boundary === 'identity') auth.user.value.id = NEW_ID
      if (boundary === 'sessionId') auth.session.value.sessionId = NEW_ID
      if (boundary === 'sessionVersion') auth.session.value.sessionVersion++
      if (boundary === 'email') auth.user.value.emailVerified = false
      if (boundary === 'logout') auth.loggedIn.value = false
      await flushPromises()
      expect(wrapper!.text()).not.toContain('Lista privada')
      expect(api.newListName).toBe('')
      wait.resolve({ ok: true, id: NEW_ID })
      await writing
      expect(mocks.refresh).not.toHaveBeenCalled()
      expect(wrapper!.text()).not.toContain('Lista creada')
    }
  )
  it('unknown delivery requires manual GET and explicit review, never repeats POST', async () => {
    const api = await render()
    mocks.write.mockRejectedValue(new Error('lost response'))
    await mutate('create')
    expect(wrapper!.text()).toContain('resultado incierto')
    await api.reviewUncertain()
    expect(mocks.refresh).toHaveBeenCalledTimes(1)
    expect(wrapper!.text()).toContain('He revisado las listas; continuar')
    api.continueAfterReview()
    await flushPromises()
    expect(mocks.write).toHaveBeenCalledTimes(1)
    expect(wrapper!.text()).toContain('duplicados')
    expect(api.newListName).toBe('Nueva privada')
  })
  it('double click is one write with frozen body', async () => {
    const api = await render()
    const wait = deferred()
    mocks.write.mockReturnValue(wait.promise)
    api.newListName = 'Original'
    const first = api.createList()
    api.newListName = 'Changed'
    await api.createList()
    expect(mocks.write).toHaveBeenCalledTimes(1)
    expect(mocks.write.mock.calls[0]![1].body).toEqual({ name: 'Original' })
    wait.resolve({})
    await first
  })
  it.each([401, 403])(
    'purges private lists and drafts when the server rejects current authority (%s)',
    async (statusCode) => {
      const api = await render()
      mocks.write.mockRejectedValue({ statusCode })
      await mutate('create')
      expect(wrapper!.text()).not.toContain('Lista privada')
      expect(api.newListName).toBe('')
      expect(mocks.refresh).not.toHaveBeenCalled()
    }
  )
  it('a preexisting uncertain cart prevents every batch request', async () => {
    const api = await render()
    mocks.blocked = true
    await api.addListToCart(server.lists[0])
    expect(mocks.write).not.toHaveBeenCalled()
    expect(mocks.add).not.toHaveBeenCalled()
    expect(wrapper!.text()).toContain('carrito')
  })
  it('stops on unknown ADD; only explicit continuation after store recovery sends untouched references', async () => {
    const second = { ...item, variantId: NEW_ID, cartVariantId: 12 }
    server.lists[0]!.items.push(second)
    const api = await render()
    mocks.write.mockResolvedValue({
      outcome: 'ready',
      ready: [item, second].map((v) => ({
        variantId: v.variantId,
        cartVariantId: v.cartVariantId,
        quantity: 3,
        unitLabel: v.unitLabel
      })),
      unavailable: []
    })
    mocks.add.mockImplementationOnce(async () => {
      mocks.blocked = true
      throw new Error('uncertain')
    })
    await api.addListToCart(server.lists[0])
    expect(mocks.add).toHaveBeenCalledTimes(1)
    expect(wrapper!.text()).toContain('sin intentar')
    expect(wrapper!.text()).not.toContain('no se han añadido')
    await api.continueBatch()
    expect(mocks.add).toHaveBeenCalledTimes(1)
    mocks.blocked = false
    await flushPromises()
    expect(mocks.add).toHaveBeenCalledTimes(1)
    await api.continueBatch()
    expect(mocks.add).toHaveBeenCalledTimes(2)
    expect(mocks.add).toHaveBeenLastCalledWith({ variantId: 12 }, 3)
  })
})
