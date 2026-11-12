import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h, nextTick, proxyRefs, ref, shallowRef } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import FavoritesPage from '../../app/pages/cuenta/listas.vue'
import type { AccountFavoriteItem, AccountFavoriteList } from '../../app/composables/useFavorites'
import '#app/nuxt-vitest-app-entry'

const { fetchMock, mutationMock, refreshMock, runtimeMock, addMock, confirmMock, cartState } = vi.hoisted(() => ({
  cartState: { pending: false },
  fetchMock: vi.fn(),
  mutationMock: vi.fn(),
  refreshMock: vi.fn(),
  runtimeMock: vi.fn(() => ({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'cloudflare' }
  })),
  addMock: vi.fn(),
  confirmMock: vi.fn()
}))
mockNuxtImport('useFetch', () => fetchMock)
mockNuxtImport('$fetch', () => mutationMock)
mockNuxtImport('useRuntimeConfig', () => runtimeMock)
vi.mock('../../app/stores/cart', () => ({
  useCartStore: () => ({
    add: addMock,
    get pendingMutation() {
      return cartState.pending
    },
    get blockedMutations() {
      return cartState.pending
    }
  })
}))
mockNuxtImport('useUserSession', () => () => ({
  ready: ref(true),
  loggedIn: ref(true),
  user: ref({ id: '30000000-0000-4000-8000-000000000041', role: 'customer', emailVerified: true }),
  session: ref({ sessionId: '40000000-0000-4000-8000-000000000041', sessionVersion: 1 }),
  clear: async () => undefined,
  openInPopup: () => undefined,
  fetch: async () => undefined
}))

const ITEM: AccountFavoriteItem = {
  variantId: '10000000-0000-4000-8000-000000000041',
  cartVariantId: 11,
  sku: 'SYNTHETIC-REF',
  quantity: '3',
  name: 'Referencia de prueba',
  slug: 'referencia-de-prueba',
  format: 'Caja',
  unitLabel: 'cajas',
  minimumQuantity: 1,
  maximumQuantity: null,
  quantityIncrement: 1,
  available: true,
  reason: null
}
const LIST: AccountFavoriteList = {
  id: '20000000-0000-4000-8000-000000000041',
  name: 'Reposición de prueba',
  isDefault: false,
  items: [ITEM]
}
const OTHER_LIST = '20000000-0000-4000-8000-000000000042'
const FOREIGN = '30000000-0000-4000-8000-000000000041'
const PRIVATE = 'SQL private_table customer@example.invalid synthetic-token'
const READ_ERROR = 'No hemos podido cargar tus listas. Vuelve a intentarlo.'
const NODE_ITEM = {
  variantId: ITEM.variantId,
  sku: ITEM.sku,
  quantity: '3.000',
  name: ITEM.name,
  slug: ITEM.slug,
  available: true
}
const Header = defineComponent({
  props: { title: String, count: Number },
  setup(props) {
    return () => h('header', { 'data-count': props.count }, h('h1', props.title))
  }
})
const Surface = defineComponent({
  setup(_props, { slots }) {
    return () => h('section', slots.default?.())
  }
})
const Empty = defineComponent({
  props: { title: String, description: String },
  setup(props, { slots }) {
    return () => h('div', [h('h2', props.title), h('p', props.description), slots.default?.()])
  }
})
const Button = defineComponent({
  inheritAttrs: false,
  props: { disabled: Boolean, loading: Boolean },
  setup(props, { attrs, slots }) {
    return () =>
      h(
        'button',
        { ...attrs, type: attrs.type ?? 'button', disabled: props.disabled || props.loading },
        slots.default?.()
      )
  }
})
const Input = defineComponent({
  inheritAttrs: false,
  props: { modelValue: [String, Number], disabled: Boolean },
  emits: ['update:modelValue'],
  setup(props, { attrs, emit }) {
    return () =>
      h('input', {
        ...attrs,
        value: props.modelValue,
        disabled: props.disabled,
        onInput: (event: Event) => emit('update:modelValue', (event.target as HTMLInputElement).value)
      })
  }
})
const Feedback = defineComponent({
  props: { notice: String, error: String },
  setup(props) {
    return () =>
      h('div', [
        props.notice ? h('p', props.notice) : null,
        props.error ? h('p', { role: 'alert' }, props.error) : null
      ])
  }
})
type Wrapper = Awaited<ReturnType<typeof mountSuspended>>
type Actions = {
  retryRead(): Promise<void>
  createList(): Promise<void>
  saveItem(listId: unknown, item: unknown, quantity?: unknown): Promise<void>
  renameList(list: unknown): Promise<void>
  startRename(list: unknown): void
  deleteList(list: unknown): Promise<void>
  removeItem(listId: unknown, variantId: unknown): Promise<void>
  addListToCart(list: unknown): Promise<void>
  newListName: string
  editingListName: string
}
let wrapper: Wrapper | undefined
let currentData: ReturnType<typeof shallowRef<unknown>>
let currentStatus: ReturnType<typeof ref<string>>
let currentError: ReturnType<typeof shallowRef<unknown>>
const originalConfirm = Object.getOwnPropertyDescriptor(window, 'confirm')
function actions(page: Wrapper) {
  return proxyRefs(page.setupState) as Actions
}
function button(page: Wrapper, label: string) {
  return page.findAll('button').find((entry) => entry.text() === label)
}
function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function plan() {
  return {
    outcome: 'ready',
    ready: [{ variantId: ITEM.variantId, cartVariantId: 11, quantity: 3, unitLabel: ITEM.unitLabel }],
    unavailable: []
  }
}
async function render(options: { status?: string; error?: unknown; data?: unknown; runtime?: unknown } = {}) {
  currentData = shallowRef(Object.hasOwn(options, 'data') ? options.data : { lists: [LIST] })
  currentStatus = ref(options.status ?? 'success')
  currentError = shallowRef(options.error ?? null)
  runtimeMock.mockReturnValue({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: Object.hasOwn(options, 'runtime') ? options.runtime : 'cloudflare' }
  })
  fetchMock.mockReturnValue({ data: currentData, status: currentStatus, error: currentError, refresh: refreshMock })
  wrapper = await mountSuspended(FavoritesPage, {
    global: {
      stubs: {
        UiPageHeader: Header,
        UiSurface: Surface,
        UiEmptyState: Empty,
        AccountFeedback: Feedback,
        UButton: Button,
        UInput: Input,
        UFormField: { template: '<div><slot /></div>' },
        USelect: true,
        UBadge: { template: '<span><slot /></span>' }
      }
    }
  })
  return wrapper
}
function noWrites() {
  expect(mutationMock).not.toHaveBeenCalled()
  expect(addMock).not.toHaveBeenCalled()
}
async function tryEveryAction(page: Wrapper) {
  const controller = actions(page)
  controller.newListName = 'Nueva lista sintética'
  controller.editingListName = 'Otro nombre sintético'
  await controller.createList()
  await controller.saveItem(LIST.id, ITEM, 3)
  controller.startRename(LIST)
  await controller.renameList(LIST)
  await controller.deleteList(LIST)
  await controller.removeItem(LIST.id, ITEM.variantId)
  await controller.addListToCart(LIST)
}
beforeEach(() => {
  fetchMock.mockReset()
  cartState.pending = false
  mutationMock.mockReset().mockImplementation(
    async (
      path: string,
      options: {
        method: string
        body?: { name?: string; listId?: string; variantId?: string; quantity?: number }
        query?: { listId: string }
      }
    ) => {
      const current = structuredClone(currentData.value) as { lists: AccountFavoriteList[] }
      const body = options.body
      if (path === '/api/account/favorites/lists') {
        current.lists.push({ id: OTHER_LIST, name: body!.name!, isDefault: false, items: [] })
        currentData.value = current
        return { ok: true, id: OTHER_LIST }
      }
      if (path === '/api/account/favorites') {
        const target = current.lists.find((list) => list.id === body!.listId)!
        const source = current.lists.flatMap((list) => list.items).find((item) => item.variantId === body!.variantId)!
        target.items = [
          ...target.items.filter((item) => item.variantId !== source.variantId),
          { ...source, quantity: String(body!.quantity) }
        ]
        currentData.value = current
        return { listId: target.id, variantId: source.variantId, quantity: body!.quantity }
      }
      const targetId = path.includes('/lists/') ? path.split('/').at(-1)! : options.query!.listId
      if (options.method === 'PUT') current.lists.find((list) => list.id === targetId)!.name = body!.name!
      else if (path.includes('/lists/')) current.lists = current.lists.filter((list) => list.id !== targetId)
      else
        current.lists.find((list) => list.id === targetId)!.items = current.lists
          .find((list) => list.id === targetId)!
          .items.filter((item) => !path.endsWith(item.variantId))
      currentData.value = current
      return { ok: true, id: targetId }
    }
  )
  refreshMock.mockReset().mockResolvedValue(undefined)
  runtimeMock.mockReset()
  addMock.mockReset().mockResolvedValue(undefined)
  confirmMock.mockReset().mockReturnValue(true)
  Object.defineProperty(window, 'confirm', { value: confirmMock, writable: true, configurable: true })
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  vi.restoreAllMocks()
  if (originalConfirm) Object.defineProperty(window, 'confirm', originalConfirm)
  else Reflect.deleteProperty(window, 'confirm')
})

describe('account favorite lists: confirmed reads and explicit GET retry', () => {
  it.each(['idle', 'pending'])('hides cached lists, counts and creation during %s', async (status) => {
    const page = await render({ status })
    expect(page.get('[role="status"]').text()).toBe('Cargando tus listas.')
    expect(page.get('[aria-busy]').attributes('aria-busy')).toBe('true')
    expect(page.text()).not.toContain(LIST.name)
    expect(page.text()).not.toContain('Todavía no tienes ninguna lista')
    expect(page.get('header').attributes('data-count')).toBeUndefined()
    expect(button(page, 'Crear lista')).toBeUndefined()
    await actions(page).retryRead()
    await tryEveryAction(page)
    expect(refreshMock).not.toHaveBeenCalled()
    noWrites()
  })
  it.each(['error', 'success'])('does not expose cached rows when %s carries a read error', async (status) => {
    const page = await render({ status, error: { message: PRIVATE } })
    expect(page.get('[role="alert"]').text()).toBe(READ_ERROR)
    expect(page.text()).not.toContain(PRIVATE)
    expect(page.text()).not.toContain(LIST.name)
    expect(page.get('header').attributes('data-count')).toBeUndefined()
    expect(button(page, 'Crear lista')).toBeUndefined()
    await tryEveryAction(page)
    noWrites()
  })
  it('shows empty and permits creation only after a valid success', async () => {
    const page = await render({ data: { lists: [] } })
    expect(page.text()).toContain('Todavía no tienes ninguna lista')
    expect(page.get('header').attributes('data-count')).toBe('0')
    expect(button(page, 'Crear lista')).toBeDefined()
    await actions(page).retryRead()
    expect(refreshMock).not.toHaveBeenCalled()
    noWrites()
  })
  it('renders a confirmed Cloudflare list without altering the source DTO', async () => {
    const input = { lists: [LIST] },
      before = JSON.stringify(input)
    const page = await render({ data: input })
    expect(page.text()).toContain(LIST.name)
    expect(page.text()).toContain(ITEM.name)
    expect(page.get('header').attributes('data-count')).toBe('1')
    expect(JSON.stringify(input)).toBe(before)
    noWrites()
  })
  it('accepts only the Node core contract under an explicit Node runtime without invented cart metadata', async () => {
    const page = await render({ runtime: 'node', data: { lists: [{ ...LIST, items: [NODE_ITEM] }] } })
    expect(page.text()).toContain(ITEM.name)
    expect(page.get('header').attributes('data-count')).toBe('1')
    expect(button(page, 'Añadir todo al carrito')?.attributes('disabled')).toBeDefined()
    await actions(page).addListToCart(LIST)
    noWrites()
  })
  it.each(['cloudflare', 'unexpected', null, undefined])('rejects a Node core DTO in runtime %s', async (runtime) => {
    const page = await render({ runtime, data: { lists: [{ ...LIST, items: [NODE_ITEM] }] } })
    expect(page.get('[role="alert"]').text()).toBe(READ_ERROR)
    await tryEveryAction(page)
    noWrites()
  })
  it.each([
    null,
    {},
    [],
    { lists: null },
    { lists: 'invalid' },
    { lists: [{}] },
    { lists: [{ ...LIST, items: null }] },
    { lists: [{ ...LIST, isDefault: 'false' }] },
    { lists: [{ ...LIST, items: [{ ...ITEM, cartVariantId: '11' }] }] },
    { lists: [{ ...LIST, items: [{ ...ITEM, quantity: '3.0' }] }] },
    { lists: [{ ...LIST, items: [{ ...ITEM, quantity: '3\n' }] }] },
    { lists: [{ ...LIST, items: [{ ...ITEM, slug: '../private' }] }] },
    { lists: [{ ...LIST, items: [{ ...ITEM, reason: 'SQL raw' }] }] },
    { lists: [{ ...LIST, items: [{ ...ITEM, quantityIncrement: 0 }] }] },
    { lists: [LIST, LIST] },
    { lists: [{ ...LIST, items: [ITEM, ITEM] }] },
    { lists: Array.from({ length: 22 }, (_, index) => ({ ...LIST, id: `list-${index}` })) },
    {
      lists: [
        { ...LIST, items: Array.from({ length: 101 }, (_, index) => ({ ...ITEM, variantId: `variant-${index}` })) }
      ]
    }
  ])('rejects malformed, duplicate or oversized reads without writes: %#', async (data) => {
    const page = await render({ data })
    expect(page.get('[role="alert"]').text()).toBe(READ_ERROR)
    expect(page.get('header').attributes('data-count')).toBeUndefined()
    expect(page.text()).not.toContain(ITEM.name)
    await tryEveryAction(page)
    noWrites()
  })
  it('never calls getters or trusts inherited/prototype/sparse DTO fields', async () => {
    const getter = vi.fn(() => [LIST])
    const payloads: unknown[] = [
      Object.create({ lists: [LIST] }),
      { lists: Object.assign([], { extra: LIST }) },
      { lists: Array(1) },
      { lists: [Object.assign(Object.create({ name: LIST.name }), { id: LIST.id, isDefault: false, items: [ITEM] })] },
      { lists: [{ ...LIST, items: [{ ...ITEM, quantity: { toString: getter } }] }] }
    ]
    const accessor = {}
    Object.defineProperty(accessor, 'lists', { enumerable: true, get: getter })
    payloads.push(accessor)
    payloads.push({ lists: [{ ...LIST, items: [{ ...ITEM, reason: { toString: getter } }] }] })
    for (const data of payloads) {
      const page = await render({ data })
      expect(page.get('[role="alert"]').text()).toBe(READ_ERROR)
      noWrites()
      page.unmount()
      wrapper = undefined
    }
    expect(getter).not.toHaveBeenCalled()
  })
  it.each([{ lists: [] }, { lists: [LIST] }])(
    'recovers from a deliberate GET refresh without repeating writes: %#',
    async ({ lists }) => {
      const page = await render({ status: 'error' })
      refreshMock.mockImplementationOnce(async () => {
        currentData.value = { lists }
        currentError.value = null
        currentStatus.value = 'success'
      })
      await button(page, 'Reintentar')!.trigger('click')
      await flushPromises()
      expect(refreshMock).toHaveBeenCalledExactlyOnceWith()
      expect(page.find('[role="alert"]').exists()).toBe(false)
      expect(page.get('header').attributes('data-count')).toBe(String(lists.length))
      noWrites()
    }
  )
  it('synchronously blocks double GET retry and all actions while a deferred read is pending', async () => {
    const pending = deferred(),
      page = await render({ status: 'error' })
    refreshMock.mockReturnValueOnce(pending.promise)
    const retry = actions(page).retryRead
    const first = retry()
    await retry()
    await nextTick()
    await tryEveryAction(page)
    expect(refreshMock).toHaveBeenCalledTimes(1)
    expect(page.get('[role="status"]').text()).toBe('Cargando tus listas.')
    noWrites()
    pending.resolve()
    await first
  })
  it('keeps a thrown refresh generic even if it leaves a success cache, and permits a new explicit retry', async () => {
    const page = await render({ data: { lists: null } })
    refreshMock.mockImplementationOnce(async () => {
      currentData.value = { lists: [LIST] }
      throw { data: { statusMessage: PRIVATE } }
    })
    await actions(page).retryRead()
    await nextTick()
    expect(page.get('[role="alert"]').text()).toBe(READ_ERROR)
    expect(page.text()).not.toContain(LIST.name)
    expect(page.text()).not.toContain(PRIVATE)
    await actions(page).retryRead()
    expect(refreshMock).toHaveBeenCalledTimes(2)
    noWrites()
  })
  it('a callback retained after unmount cannot refresh, write, prompt or start a cart preparation', async () => {
    const page = await render({ status: 'error' }),
      controller = actions(page)
    page.unmount()
    wrapper = undefined
    await controller.retryRead()
    await tryEveryAction(page)
    expect(refreshMock).not.toHaveBeenCalled()
    expect(window.confirm).not.toHaveBeenCalled()
    noWrites()
  })
})

describe('favorite actions use only confirmed identities and validated preparation', () => {
  it('rejects forged list/variant callbacks before a network call or confirmation', async () => {
    const page = await render(),
      controller = actions(page)
    await controller.saveItem(FOREIGN, ITEM, 3)
    await controller.saveItem(LIST.id, { ...ITEM, variantId: FOREIGN }, 3)
    await controller.renameList({ ...LIST, id: FOREIGN })
    await controller.deleteList({ ...LIST, id: FOREIGN })
    await controller.removeItem(LIST.id, FOREIGN)
    await controller.removeItem(FOREIGN, ITEM.variantId)
    await controller.addListToCart({ ...LIST, id: FOREIGN })
    expect(window.confirm).not.toHaveBeenCalled()
    noWrites()
  })
  it.each([0, -1, 1.5, 1000, Number.NaN, Number.POSITIVE_INFINITY, '3', {}, null])(
    'rejects invalid callback quantity without coercion: %s',
    async (quantity) => {
      const page = await render()
      await actions(page).saveItem(LIST.id, ITEM, quantity)
      noWrites()
    }
  )
  it('respects actual minimum, maximum and increment before saving', async () => {
    const item = { ...ITEM, minimumQuantity: 3, maximumQuantity: 9, quantityIncrement: 3 }
    const page = await render({ data: { lists: [{ ...LIST, items: [item] }] } })
    for (const quantity of [1, 4, 10]) await actions(page).saveItem(LIST.id, item, quantity)
    noWrites()
    await actions(page).saveItem(LIST.id, item, 6)
    expect(mutationMock).toHaveBeenCalledExactlyOnceWith('/api/account/favorites', {
      method: 'POST',
      retry: 0,
      body: { listId: LIST.id, variantId: ITEM.variantId, quantity: 6 }
    })
    expect(refreshMock).toHaveBeenCalledTimes(1)
  })
  it('preserves existing rename/remove/create requests and never retries a failed mutation', async () => {
    const page = await render(),
      controller = actions(page)
    controller.newListName = ' Nueva lista '
    await controller.createList()
    controller.startRename(LIST)
    controller.editingListName = ' Nuevo nombre '
    await controller.renameList(LIST)
    await controller.removeItem(LIST.id, ITEM.variantId)
    expect(mutationMock.mock.calls.map(([path, options]) => [path, options.method])).toEqual([
      ['/api/account/favorites/lists', 'POST'],
      [`/api/account/favorites/lists/${LIST.id}`, 'PUT'],
      [`/api/account/favorites/${ITEM.variantId}`, 'DELETE']
    ])
    mutationMock.mockRejectedValueOnce({ data: { statusMessage: PRIVATE } })
    await controller.deleteList(LIST)
    expect(mutationMock).toHaveBeenCalledTimes(4)
    expect(refreshMock).toHaveBeenCalledTimes(3)
    expect(page.text()).not.toContain(PRIVATE)
  })
  it('copies only to another list from the same confirmed read', async () => {
    const page = await render({ data: { lists: [LIST, { ...LIST, id: OTHER_LIST, name: 'Otra lista', items: [] }] } })
    await actions(page).saveItem(OTHER_LIST, ITEM)
    expect(mutationMock).toHaveBeenCalledExactlyOnceWith('/api/account/favorites', {
      method: 'POST',
      retry: 0,
      body: { listId: OTHER_LIST, variantId: ITEM.variantId, quantity: 3 }
    })
  })
  it('preserves the chosen source quantity when one variant belongs to multiple lists', async () => {
    const secondItem = { ...ITEM, quantity: '6' }
    const page = await render({
      data: { lists: [LIST, { ...LIST, id: OTHER_LIST, name: 'Otra lista', items: [secondItem] }] }
    })
    await actions(page).saveItem(LIST.id, secondItem)
    expect(mutationMock).toHaveBeenCalledExactlyOnceWith('/api/account/favorites', {
      method: 'POST',
      retry: 0,
      body: { listId: LIST.id, variantId: ITEM.variantId, quantity: 6 }
    })
  })
  it('rejects a later invalid row before adding an earlier valid ready row', async () => {
    const second = { ...ITEM, variantId: FOREIGN, cartVariantId: 12 }
    const list = { ...LIST, items: [ITEM, second] }
    const page = await render({ data: { lists: [list] } })
    mutationMock.mockResolvedValueOnce({
      ...plan(),
      ready: [
        ...plan().ready,
        { variantId: second.variantId, cartVariantId: 99, quantity: 3, unitLabel: second.unitLabel }
      ]
    })
    await actions(page).addListToCart(list)
    expect(addMock).not.toHaveBeenCalled()
    expect(refreshMock).not.toHaveBeenCalled()
  })
  it('does not promote a confirmed unavailable item into a ready cart addition', async () => {
    const unavailable: AccountFavoriteItem = {
      ...ITEM,
      variantId: FOREIGN,
      cartVariantId: 12,
      available: false,
      reason: 'out_of_stock'
    }
    const list = { ...LIST, items: [ITEM, unavailable] }
    const page = await render({ data: { lists: [list] } })
    mutationMock.mockResolvedValueOnce({
      ...plan(),
      ready: [
        ...plan().ready,
        { variantId: unavailable.variantId, cartVariantId: 12, quantity: 3, unitLabel: unavailable.unitLabel }
      ]
    })
    await actions(page).addListToCart(list)
    expect(addMock).not.toHaveBeenCalled()
  })
  it.each([
    null,
    {},
    { outcome: 'ready', ready: null, unavailable: [] },
    { ...plan(), ready: [{ ...plan().ready[0], variantId: FOREIGN }] },
    { ...plan(), ready: [{ ...plan().ready[0], cartVariantId: 12 }] },
    { ...plan(), ready: [{ ...plan().ready[0], quantity: 2 }] },
    { ...plan(), ready: [{ ...plan().ready[0], quantity: '3' }] },
    { ...plan(), ready: [...plan().ready, ...plan().ready] },
    { ...plan(), unavailable: [ITEM] },
    Object.create(plan())
  ])('validates the whole hostile preparation before any cart addition: %#', async (response) => {
    const page = await render()
    mutationMock.mockResolvedValueOnce(response)
    await actions(page).addListToCart(LIST)
    expect(mutationMock).toHaveBeenCalledTimes(1)
    expect(addMock).not.toHaveBeenCalled()
    expect(refreshMock).not.toHaveBeenCalled()
    expect(page.text()).not.toContain(PRIVATE)
  })
  it('never invokes a preparation getter', async () => {
    const getter = vi.fn(() => plan().ready),
      response = { outcome: 'ready', unavailable: [] }
    Object.defineProperty(response, 'ready', { enumerable: true, get: getter })
    const page = await render()
    mutationMock.mockResolvedValueOnce(response)
    await actions(page).addListToCart(LIST)
    expect(getter).not.toHaveBeenCalled()
    expect(addMock).not.toHaveBeenCalled()
  })
  it('adds only the prepared real mapping and quantity, preserving existing partial-add reporting', async () => {
    const page = await render()
    mutationMock.mockResolvedValueOnce(plan())
    await actions(page).addListToCart(LIST)
    expect(addMock).toHaveBeenCalledExactlyOnceWith({ variantId: 11 }, 3)
    expect(refreshMock).toHaveBeenCalledTimes(1)
    expect(page.text()).toContain('1 referencia añadida al carrito.')
  })
  it('preserves partial-add reporting without retrying a failed cart mutation', async () => {
    const second = { ...ITEM, variantId: FOREIGN, cartVariantId: 12 }
    const list = { ...LIST, items: [ITEM, second] }
    const page = await render({ data: { lists: [list] } })
    mutationMock.mockResolvedValueOnce({
      ...plan(),
      ready: [
        ...plan().ready,
        { variantId: second.variantId, cartVariantId: 12, quantity: 3, unitLabel: second.unitLabel }
      ]
    })
    addMock.mockImplementationOnce(async () => {
      cartState.pending = true
      throw { data: { statusMessage: PRIVATE } }
    })
    await actions(page).addListToCart(list)
    expect(addMock.mock.calls).toEqual([[{ variantId: 11 }, 3]])
    expect(refreshMock).not.toHaveBeenCalled()
    expect(page.text()).toContain('resultado incierto')
    expect(page.text()).toContain('1 referencias sin intentar')
    expect(page.text()).not.toContain('no se han añadido')
    expect(page.text()).not.toContain(PRIVATE)
  })
  it.each(['pending', 'error', 'replaced', 'mutated', 'unmount'])(
    'late preparation cannot add after read %s',
    async (change) => {
      const pending = deferred<unknown>(),
        payload = { lists: [{ ...LIST, items: [{ ...ITEM }] }] },
        page = await render({ data: payload }),
        controller = actions(page)
      mutationMock.mockReturnValueOnce(pending.promise)
      const first = controller.addListToCart(LIST)
      await controller.addListToCart(LIST)
      expect(mutationMock).toHaveBeenCalledTimes(1)
      if (change === 'replaced') currentData.value = { lists: [] }
      else if (change === 'mutated') payload.lists[0]!.items[0]!.quantity = '4'
      else if (change === 'unmount') {
        page.unmount()
        wrapper = undefined
      } else currentStatus.value = change
      pending.resolve(plan())
      await first
      await nextTick()
      expect(addMock).not.toHaveBeenCalled()
      expect(refreshMock).not.toHaveBeenCalled()
    }
  )
})
