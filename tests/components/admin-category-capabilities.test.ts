import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises, type DOMWrapper } from '@vue/test-utils'
import { defineComponent, h, proxyRefs, ref, type PropType } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CategoriesPage from '../../app/pages/admin/categorias.vue'
import type { CategoryNode } from '../../shared/types/catalog'
import type { D1AdminCategoryNode } from '../../workers/catalog/admin-catalog'
import '#app/nuxt-vitest-app-entry'

const { fetchMock, requestMock, toastMock, refreshDataMock, runtimeMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  requestMock: vi.fn(),
  toastMock: vi.fn(),
  refreshDataMock: vi.fn(),
  runtimeMock: vi.fn(() => ({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'cloudflare', baseUrl: 'https://neteco.invalid' }
  }))
}))
mockNuxtImport('useFetch', () => fetchMock)
mockNuxtImport('$fetch', () => requestMock)
mockNuxtImport('useToast', () => () => ({ add: toastMock }))
mockNuxtImport('useRuntimeConfig', () => runtimeMock)
mockNuxtImport('refreshNuxtData', () => refreshDataMock)
const sessionReady = ref(true),
  sessionLoggedIn = ref(true),
  sessionUser = ref({ id: 'synthetic-admin', role: 'admin', mfaVerified: true })
mockNuxtImport('useUserSession', () => () => ({
  ready: sessionReady,
  loggedIn: sessionLoggedIn,
  user: sessionUser,
  session: ref(null),
  clear: async () => undefined,
  openInPopup: () => undefined,
  fetch: async () => undefined
}))

type Payload = {
  source?: string
  capabilities?: Record<string, unknown>
  roots: CategoryNode[]
  flat: Array<Omit<CategoryNode, 'children'>>
  unmappedCategories?: number
}
const category = (
  id: number,
  parentId: number | null = null,
  overrides: Partial<D1AdminCategoryNode> = {}
): D1AdminCategoryNode => {
  const data = {
    id,
    parentId,
    name: `Familia ${id}`,
    slug: `familia-${id}`,
    sort: id,
    status: 'published' as const,
    directCount: 0,
    count: 0,
    children: new Array<D1AdminCategoryNode>(),
    ...overrides
  }
  return {
    ...data,
    authoring: overrides.authoring ?? {
      id,
      uuid: `legacy-category-${id}`,
      version: 1,
      name: data.name,
      slug: data.slug,
      status: data.status,
      actualParentUuid: parentId === null ? null : `legacy-category-${parentId}`,
      actualParentId: parentId,
      parentMapped: true,
      sort: data.sort,
      directChildren: data.children.length,
      directProducts: data.directCount
    }
  }
}
const payload = (
  roots: CategoryNode[] = [
    category(8, null, {
      name: 'Raíz borrador',
      status: 'draft',
      directCount: 1,
      count: 2,
      children: [category(9, 8, { name: 'Hija oculta', status: 'hidden', directCount: 1, count: 1 })]
    }),
    category(10, null, { name: 'Familia revisión', status: 'review' })
  ]
): Payload => {
  const flat: Payload['flat'] = []
  const walk = (nodes: CategoryNode[]) => {
    for (const node of nodes) {
      const { children, ...entry } = node
      flat.push(entry)
      walk(children)
    }
  }
  walk(roots)
  return {
    source: 'cloudflare',
    capabilities: { categoriesRead: true, categoryCreate: false, categoryUpdate: false, categoryDelete: false },
    roots,
    flat,
    unmappedCategories: 0
  }
}
const nodePayload = (): Payload => {
  const data = payload([
    category(8, null, { name: 'Raíz Node', count: 2, children: [category(9, 8, { name: 'Hija Node', count: 1 })] }),
    category(10, null, { name: 'Vacía Node' })
  ])
  delete data.source
  delete data.capabilities
  return data
}
const Header = defineComponent({
  props: { title: String, description: String, count: Number },
  setup:
    (props, { slots }) =>
    () =>
      h('header', { 'data-count': props.count }, [h('h1', props.title), h('p', props.description), slots.actions?.()])
})
const Slot = defineComponent({
  setup:
    (_, { slots }) =>
    () =>
      h('section', slots.default?.())
})
const Button = defineComponent({
  inheritAttrs: false,
  props: { disabled: Boolean, loading: Boolean },
  setup:
    (props, { attrs, slots }) =>
    () =>
      h(
        'button',
        { ...attrs, type: attrs.type ?? 'button', disabled: props.disabled || props.loading },
        slots.default?.()
      )
})
const Input = defineComponent({
  inheritAttrs: false,
  props: { modelValue: String },
  emits: ['update:modelValue'],
  setup:
    (props, { attrs, emit, slots }) =>
    () =>
      h('span', [
        h('input', {
          ...attrs,
          value: props.modelValue ?? '',
          onInput: (event: Event) => emit('update:modelValue', (event.target as HTMLInputElement).value)
        }),
        slots.trailing?.()
      ])
})
const Select = defineComponent({
  props: {
    modelValue: [Number, String],
    items: { type: Array as PropType<Array<{ label: string; value: number | null }>>, default: () => [] }
  },
  emits: ['update:modelValue'],
  setup:
    (props, { emit }) =>
    () =>
      h(
        'select',
        {
          value: props.modelValue === null ? 'null' : props.modelValue,
          onChange: (event: Event) => {
            const value = (event.target as HTMLSelectElement).value
            emit('update:modelValue', value === 'null' ? null : Number(value))
          }
        },
        props.items.map((item) => h('option', { value: item.value === null ? 'null' : item.value }, item.label))
      )
})
const Field = defineComponent({
  props: { label: String },
  setup:
    (props, { slots }) =>
    () =>
      h('label', { 'data-field': props.label }, [props.label, slots.default?.()])
})
const Alert = defineComponent({
  props: { title: String, description: String },
  setup: (props) => () => h('aside', [h('strong', props.title), h('p', props.description)])
})
const Empty = defineComponent({
  props: { title: String, description: String, variant: String },
  setup:
    (props, { slots }) =>
    () =>
      h('div', { 'data-empty': props.variant ?? 'empty', role: props.variant === 'error' ? 'alert' : 'status' }, [
        h('h2', props.title),
        h('p', props.description),
        slots.default?.()
      ])
})
const Modal = defineComponent({
  props: { open: Boolean, title: String },
  emits: ['update:open'],
  setup:
    (props, { slots, emit }) =>
    () =>
      props.open
        ? h('dialog', { open: true }, [
            h('h2', props.title),
            slots.body?.(),
            slots.footer?.(),
            h('button', { onClick: () => emit('update:open', false) }, 'Cerrar modal')
          ])
        : null
})
const mounted: Array<{ unmount: () => void }> = []
async function render(data: Payload | null = payload(), status = 'success', runtime = 'cloudflare') {
  runtimeMock.mockReturnValue({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: runtime, baseUrl: 'https://neteco.invalid' }
  })
  const response = ref(data)
  const readStatus = ref(status)
  const refresh = vi.fn<() => Promise<void>>(async () => undefined)
  fetchMock.mockReturnValue({ data: response, status: readStatus, refresh })
  const wrapper = await mountSuspended(CategoriesPage, {
    global: {
      stubs: {
        UiPageHeader: Header,
        UiSurface: Slot,
        UiEmptyState: Empty,
        UButton: Button,
        UInput: Input,
        USelect: Select,
        UFormField: Field,
        UAlert: Alert,
        UBadge: Slot,
        UModal: Modal,
        UIcon: true
      }
    }
  })
  mounted.push(wrapper)
  return { wrapper, response, readStatus, refresh }
}
type Page = Awaited<ReturnType<typeof render>>['wrapper']
function button(scope: Page | DOMWrapper<Element>, label: string) {
  const match = scope.findAll('button').find((item) => item.text() === label || item.attributes('aria-label') === label)
  if (!match) throw new Error(`Missing button ${label}`)
  return match
}
function setupState(wrapper: Page) {
  // mountSuspended clones/renames the component; use its exposed setup state.
  return proxyRefs(wrapper.setupState) as Record<string, unknown>
}
async function invoke(wrapper: Page, name: string, ...args: unknown[]) {
  const action = setupState(wrapper)[name]
  if (typeof action !== 'function') throw new Error(`Missing action ${name}`)
  await action(...args)
}
beforeEach(() => {
  sessionReady.value = true
  sessionLoggedIn.value = true
  sessionUser.value = { id: 'synthetic-admin', role: 'admin', mfaVerified: true }
  fetchMock.mockReset()
  requestMock.mockReset().mockResolvedValue({ ok: true })
  toastMock.mockReset()
  refreshDataMock.mockReset().mockResolvedValue(undefined)
})
afterEach(() => mounted.splice(0).forEach((wrapper) => wrapper.unmount()))

describe('private Cloudflare category consultation', () => {
  it('uses the private endpoint and a cache key distinct from public categories', async () => {
    const { wrapper } = await render()
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/admin/categories')
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ key: 'admin-category-tree', immediate: true, server: true })
    expect(wrapper.text()).toContain('Familias: gestión editorial privada')
    expect(wrapper.text()).toContain('todos los estados')
    expect(wrapper.text()).toContain('no existencias')
    expect(wrapper.find('dialog').exists()).toBe(false)
    expect(requestMock).not.toHaveBeenCalled()
  })
  it('renders private draft/hidden/review branches and already-accumulated subtree counts exactly once', async () => {
    const { wrapper } = await render()
    expect(wrapper.get('header').attributes('data-count')).toBe('3')
    expect(wrapper.get('[data-category-id="8"]').text()).toContain('Borrador')
    expect(wrapper.get('[data-category-id="9"]').text()).toContain('Oculto')
    expect(wrapper.get('[data-category-id="10"]').text()).toContain('En revisión')
    expect(wrapper.get('[data-category-id="8"]').text()).toContain('2 productos')
    expect(wrapper.get('[data-category-id="8"]').text()).not.toContain('3 productos')
    expect(wrapper.get('[data-category-id="9"]').text()).toContain('1 producto')
  })
  it('renders the full private status union, including published and discontinued families', async () => {
    const { wrapper } = await render(
      payload([
        category(1, null, { status: 'draft' }),
        category(2, null, { status: 'review' }),
        category(3, null, { status: 'published' }),
        category(4, null, { status: 'hidden' }),
        category(5, null, { status: 'discontinued' })
      ])
    )
    for (const [id, label] of ['Borrador', 'En revisión', 'Publicado', 'Oculto', 'Descatalogado'].entries())
      expect(wrapper.get(`[data-category-id="${id + 1}"]`).text()).toContain(label)
  })
  it('renders every category beyond 45 without a client pagination slice or duplicating branches', async () => {
    const data = payload(Array.from({ length: 61 }, (_, index) => category(index + 1)))
    const { wrapper } = await render(data)
    expect(wrapper.findAll('[data-category-id]')).toHaveLength(61)
    expect(wrapper.get('[data-category-id="61"]').text()).toContain('Familia 61')
    expect(wrapper.get('header').attributes('data-count')).toBe('61')
    expect(new Set(wrapper.findAll('[data-category-id]').map((row) => row.attributes('data-category-id'))).size).toBe(
      61
    )
  })
  it('preserves normalized mapped descendants and explicit unmapped-category evidence', async () => {
    const data = payload([
      category(8, null, { count: 4, children: [category(10, 8, { name: 'Descendiente mapeado', count: 1 })] })
    ])
    data.unmappedCategories = 1
    const { wrapper } = await render(data)
    expect(wrapper.text()).toContain('Familias sin identificador heredado')
    expect(wrapper.text()).toContain('Sus descendientes mapeados y sus recuentos se conservan')
    expect(wrapper.get('[data-category-id="10"]').attributes('data-depth')).toBe('1')
    expect(wrapper.get('[data-category-id="8"]').text()).toContain('4 productos')
    expect(wrapper.find('a').exists()).toBe(false)
  })
  it('collapses/expands branches, opens matching ancestors during search and restores the prior collapsed state', async () => {
    const { wrapper } = await render()
    await button(wrapper, 'Plegar Raíz borrador').trigger('click')
    expect(wrapper.find('[data-category-id="9"]').exists()).toBe(false)
    expect(button(wrapper, 'Desplegar Raíz borrador').attributes('aria-expanded')).toBe('false')
    await wrapper.get('input[aria-label="Buscar familia"]').setValue('HIJA OCULTA')
    expect(wrapper.find('[data-category-id="9"]').exists()).toBe(true)
    expect(wrapper.find('[data-category-id="8"]').exists()).toBe(true)
    expect(wrapper.find('[data-category-id="10"]').exists()).toBe(false)
    expect(button(wrapper, 'Plegar Raíz borrador').attributes('aria-expanded')).toBe('true')
    expect(button(wrapper, 'Plegar Raíz borrador').attributes('disabled')).toBeDefined()
    await button(wrapper, 'Borrar búsqueda').trigger('click')
    expect(wrapper.find('[data-category-id="9"]').exists()).toBe(false)
    await button(wrapper, 'Desplegar').trigger('click')
    expect(wrapper.find('[data-category-id="9"]').exists()).toBe(true)
    await button(wrapper, 'Plegar todo').trigger('click')
    expect(wrapper.find('[data-category-id="9"]').exists()).toBe(false)
  })
  it('distinguishes a filtered no-match from a measured empty hierarchy', async () => {
    const { wrapper } = await render()
    await wrapper.get('input[aria-label="Buscar familia"]').setValue('no coincide')
    expect(wrapper.get('[data-empty="filtered"]').text()).toContain('Ninguna familia contiene')
    expect(wrapper.text()).not.toContain('Todavía no hay familias')
    await button(wrapper.get('[data-empty="filtered"]'), 'Borrar búsqueda').trigger('click')
    expect(wrapper.findAll('[data-category-id]')).toHaveLength(3)
  })
  it('shows a verified empty tree without inviting category creation when its writer capability is false', async () => {
    const { wrapper } = await render(payload([]))
    expect(wrapper.get('header').attributes('data-count')).toBe('0')
    expect(wrapper.text()).toContain('Todavía no hay familias')
    expect(wrapper.text()).toContain('Tu sesión no permite crear familias')
    expect(wrapper.text()).not.toContain('Nueva familia')
    expect(wrapper.find('dialog').exists()).toBe(false)
  })
  it.each([undefined, 'node', 'Cloudflare', 'external'])(
    'rejects an untrusted source %j without leaking private rows or claiming zero',
    async (source) => {
      const data = payload()
      data.source = source
      const { wrapper } = await render(data)
      expect(wrapper.find('[data-category-tree]').exists()).toBe(false)
      expect(wrapper.text()).not.toContain('Raíz borrador')
      expect(wrapper.text()).toContain('Consulta de familias no disponible')
      expect(wrapper.get('header').attributes('data-count')).toBeUndefined()
      expect(wrapper.text()).not.toContain('Todavía no hay familias')
    }
  )
  it.each([undefined, false, 'true', 1, null])('requires literal true read capability (%j)', async (cap) => {
    const data = payload()
    data.capabilities!.categoriesRead = cap
    const { wrapper } = await render(data)
    expect(wrapper.find('[data-category-tree]').exists()).toBe(false)
    expect(wrapper.get('header').attributes('data-count')).toBeUndefined()
    expect(wrapper.text()).not.toContain('Hija oculta')
  })
  it('fails closed when all capabilities are absent', async () => {
    const data = payload()
    delete data.capabilities
    const { wrapper } = await render(data)
    expect(wrapper.find('[data-category-tree]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Nueva familia')
  })
  it('the obsolete Node handlers cannot perform D1 writes even when current category capabilities permit the new editor', async () => {
    const data = payload()
    Object.assign(data.capabilities!, { categoryCreate: true, categoryUpdate: true, categoryDelete: true })
    const { wrapper } = await render(data)
    expect(wrapper.text()).toContain('Nueva familia borrador')
    expect(wrapper.find('button[aria-label^="Editar"], button[aria-label^="Eliminar"]').exists()).toBe(false)
    const state = setupState(wrapper)
    Object.assign(state, {
      creating: true,
      editing: { id: 8, name: 'private stale', count: 0, hasChildren: false },
      removing: { id: 10, count: 0, hasChildren: false }
    })
    Object.assign(state.createForm as object, { name: 'Forged creation', parentId: 8 })
    Object.assign(state.editForm as object, { name: 'Forged move', parentId: 9 })
    await invoke(wrapper, 'startEdit', { id: 8, name: 'Forged edit' })
    await invoke(wrapper, 'startRemove', { id: 10, count: 0, hasChildren: false })
    await invoke(wrapper, 'createCategory')
    await invoke(wrapper, 'saveEdit')
    await invoke(wrapper, 'confirmRemove')
    await flushPromises()
    expect(wrapper.find('dialog,form#new-family,form#edit-family').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('private stale')
    expect(requestMock).not.toHaveBeenCalled()
    expect(refreshDataMock).not.toHaveBeenCalled()
  })
  it.each(['', 'unknown', 'Node', 'Cloudflare'])(
    'disables reads and writes for an unknown runtime %j',
    async (runtime) => {
      const { wrapper, refresh } = await render(payload(), 'success', runtime)
      expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/admin/categories')
      expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ immediate: false, server: false })
      expect(wrapper.find('[data-category-tree], dialog, form, input').exists()).toBe(false)
      expect(wrapper.get('header').attributes('data-count')).toBeUndefined()
      await invoke(wrapper, 'reload')
      await invoke(wrapper, 'createCategory')
      await invoke(wrapper, 'saveEdit')
      await invoke(wrapper, 'confirmRemove')
      expect(refresh).not.toHaveBeenCalled()
      expect(requestMock).not.toHaveBeenCalled()
    }
  )
  it('revokes displayed drafts immediately on source/capability loss, including while a focused row exists', async () => {
    const { wrapper, response } = await render()
    const focused = button(wrapper, 'Plegar Raíz borrador')
    ;(focused.element as HTMLButtonElement).focus()
    response.value = { ...payload(), capabilities: { categoriesRead: false } }
    await flushPromises()
    expect(wrapper.find('[data-category-tree]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Raíz borrador')
    response.value = { ...payload(), source: 'node' }
    await flushPromises()
    expect(wrapper.find('[data-category-tree]').exists()).toBe(false)
  })
  it('exposes accessible search/branch labels and wraps deep mobile rows rather than widening the page', async () => {
    let root = category(8, null, { name: 'Una familia de nombre muy largo para una pantalla estrecha' })
    let current = root
    for (let index = 9; index <= 16; index++) {
      const child = category(index, current.id)
      current.children = [child]
      current = child
    }
    root = { ...root }
    const { wrapper } = await render(payload([root]))
    expect(wrapper.get('[data-category-tree]').attributes('aria-label')).toBe('Familias y subfamilias')
    expect(wrapper.get('input').attributes('aria-label')).toBe('Buscar familia')
    const row = wrapper.get('[data-category-id="16"]')
    expect(row.classes()).toContain('flex-wrap')
    expect(row.attributes('style')).toContain('padding-left: 2.25rem')
    expect(row.text()).toContain('Nivel 9')
    expect(row.get('.break-words').classes()).toContain('min-w-0')
    expect(row.classes()).not.toContain('hidden')
    expect(wrapper.find('table, a').exists()).toBe(false)
  })
})

describe('category read lifecycle', () => {
  it.each(['ready', 'loggedIn', 'role', 'mfa'])(
    'current local %s loss hides cached private tree and blocks parent authority and GET callbacks',
    async (field) => {
      const data = payload()
      Object.assign(data.capabilities!, { categoryCreate: true, categoryUpdate: true, categoryDelete: true })
      const { wrapper, refresh } = await render(data)
      const authority = setupState(wrapper).privateCategoryAuthority
      if (typeof authority !== 'function') throw new Error('Missing authority')
      expect(authority({ id: 8, uuid: 'legacy-category-8', version: 1 })).toBe(true)
      if (field === 'ready') sessionReady.value = false
      else if (field === 'loggedIn') sessionLoggedIn.value = false
      else if (field === 'role') sessionUser.value = { ...sessionUser.value, role: 'customer' }
      else sessionUser.value = { ...sessionUser.value, mfaVerified: false }
      await flushPromises()
      expect(authority({ id: 8, uuid: 'legacy-category-8', version: 1 })).toBe(false)
      expect(wrapper.find('[data-category-tree],[data-category-create],form').exists()).toBe(false)
      expect(wrapper.text()).not.toContain('Raíz borrador')
      await invoke(wrapper, 'reload')
      expect(refresh).not.toHaveBeenCalled()
      expect(requestMock).not.toHaveBeenCalled()
    }
  )
  it.each(['pending', 'idle', 'error'])(
    'never leaks stale successful drafts or claims zero during %s',
    async (status) => {
      const { wrapper } = await render(payload(), status)
      expect(wrapper.find('[data-category-tree]').exists()).toBe(false)
      expect(wrapper.get('header').attributes('data-count')).toBeUndefined()
      expect(wrapper.text()).not.toContain('Raíz borrador')
      expect(wrapper.text()).not.toContain('Todavía no hay familias')
      if (status === 'pending')
        expect(wrapper.get('[aria-busy="true"]').attributes('aria-label')).toBe('Cargando familias')
      if (status === 'error')
        expect(wrapper.get('[role="alert"]').text()).toContain('No se han podido consultar las familias')
    }
  )
  it('treats an absent payload as unavailable, not an empty tree', async () => {
    const { wrapper } = await render(null)
    expect(wrapper.get('[role="alert"]').text()).toContain('No se han podido consultar las familias')
    expect(wrapper.text()).not.toContain('Todavía no hay familias')
  })
  it('retries only the configured private GET and displays the fresh authorized result', async () => {
    const { wrapper, response, readStatus, refresh } = await render(null, 'error')
    refresh.mockImplementationOnce(async () => {
      response.value = payload()
      readStatus.value = 'success'
    })
    await button(wrapper, 'Reintentar').trigger('click')
    await flushPromises()
    expect(refresh).toHaveBeenCalledOnce()
    expect(wrapper.findAll('[data-category-id]')).toHaveLength(3)
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(requestMock).not.toHaveBeenCalled()
  })
  it('hides previous private rows immediately during refresh and restores only the new DTO', async () => {
    const { wrapper, response, readStatus } = await render()
    readStatus.value = 'pending'
    await flushPromises()
    expect(wrapper.find('[data-category-tree]').exists()).toBe(false)
    response.value = payload([category(11, null, { name: 'Resultado nuevo' })])
    readStatus.value = 'success'
    await flushPromises()
    expect(wrapper.text()).toContain('Resultado nuevo')
    expect(wrapper.text()).not.toContain('Raíz borrador')
  })
  it('refreshes only the private read while keeping update disabled during a pending request', async () => {
    const { wrapper, readStatus, refresh } = await render()
    let complete: () => void = () => undefined
    refresh.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          readStatus.value = 'pending'
          complete = resolve
        })
    )
    await button(wrapper, 'Actualizar').trigger('click')
    expect(refresh).toHaveBeenCalledOnce()
    expect(button(wrapper, 'Actualizar').attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-category-tree]').exists()).toBe(false)
    await invoke(wrapper, 'reload')
    expect(refresh).toHaveBeenCalledOnce()
    readStatus.value = 'success'
    complete()
    await flushPromises()
    expect(wrapper.findAll('[data-category-id]')).toHaveLength(3)
    expect(requestMock).not.toHaveBeenCalled()
    expect(refreshDataMock).not.toHaveBeenCalled()
  })
  it.each(['bad-id', 'bad-count', 'missing-children', 'duplicate-id', 'wrong-parent'])(
    'fails closed for a malformed tree (%s)',
    async (kind) => {
      const data = payload()
      const root = data.roots[0]!
      if (kind === 'bad-id') root.id = 0
      if (kind === 'bad-count') root.count = -1
      if (kind === 'missing-children') Object.assign(root, { children: null })
      if (kind === 'duplicate-id') data.roots.push({ ...root })
      if (kind === 'wrong-parent') root.children[0]!.parentId = 999
      const { wrapper } = await render(data)
      expect(wrapper.find('[data-category-tree]').exists()).toBe(false)
      expect(wrapper.get('header').attributes('data-count')).toBeUndefined()
    }
  )
  it.each([undefined, null, 'future', '__proto__', 'toString'])(
    'fails closed rather than fabricating a label for an invalid private status (%j)',
    async (status) => {
      const data = payload()
      Object.assign(data.roots[0]!, { status })
      const { wrapper } = await render(data)
      expect(wrapper.find('[data-category-tree]').exists()).toBe(false)
      expect(wrapper.get('header').attributes('data-count')).toBeUndefined()
      expect(wrapper.text()).not.toContain('Raíz borrador')
    }
  )
  it.each(['node', 'cloudflare'])(
    'fails closed for a cyclic tree in %s without recursively rendering it',
    async (runtime) => {
      const data = runtime === 'node' ? nodePayload() : payload()
      const root = data.roots[0]!
      root.children[0]!.children.push(root)
      const { wrapper } = await render(data, 'success', runtime)
      expect(wrapper.find('[data-category-tree], dialog').exists()).toBe(false)
      expect(wrapper.get('header').attributes('data-count')).toBeUndefined()
      expect(wrapper.text()).toContain('Consulta de familias no disponible')
      expect(requestMock).not.toHaveBeenCalled()
    }
  )
})

describe('explicit Node category compatibility', () => {
  it('keeps the original public endpoint/cache and all three existing actions without metadata', async () => {
    const { wrapper } = await render(nodePayload(), 'success', 'node')
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/categories')
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ key: 'categories' })
    expect(wrapper.text()).not.toContain('Familias: gestión editorial privada')
    expect(wrapper.get('[data-category-id="8"]').text()).toContain('2 productos')
    expect(button(wrapper, 'Nueva familia').exists()).toBe(true)
    expect(button(wrapper, 'Editar Raíz Node').exists()).toBe(true)
    expect(button(wrapper, 'Eliminar Vacía Node').attributes('disabled')).toBeUndefined()
    expect(button(wrapper, 'Eliminar Raíz Node').attributes('disabled')).toBeDefined()
  })
  it('retains a published Node root whose unpublished parent is absent from the public tree', async () => {
    const data = nodePayload()
    data.roots[0]!.parentId = 999
    const { wrapper } = await render(data, 'success', 'node')
    expect(wrapper.get('[data-category-id="8"]').attributes('data-depth')).toBe('0')
    expect(wrapper.text()).toContain('Raíz Node')
  })
  it('creates through the original POST and refreshes the original public cache', async () => {
    const { wrapper } = await render(nodePayload(), 'success', 'node')
    await button(wrapper, 'Nueva familia').trigger('click')
    await wrapper.get('dialog [data-field="Nombre"] input').setValue(' Nueva Node ')
    await wrapper.get('dialog [data-field="Dentro de"] select').setValue('8')
    await wrapper.get('form#new-family').trigger('submit')
    await flushPromises()
    expect(requestMock).toHaveBeenCalledExactlyOnceWith('/api/admin/categories', {
      method: 'POST',
      body: { name: 'Nueva Node', parentId: 8 }
    })
    expect(refreshDataMock).toHaveBeenCalledExactlyOnceWith('categories')
    expect(wrapper.find('dialog').exists()).toBe(false)
  })
  it('renames and moves through the original numeric-ID PUT without offering self/descendant parents', async () => {
    const { wrapper } = await render(nodePayload(), 'success', 'node')
    await button(wrapper, 'Editar Raíz Node').trigger('click')
    const options = wrapper.findAll('dialog option').map((item) => item.attributes('value'))
    expect(options).toEqual(['null', '10'])
    await wrapper.get('dialog [data-field="Nombre"] input').setValue(' Raíz renombrada ')
    await wrapper.get('dialog select').setValue('10')
    await wrapper.get('form#edit-family').trigger('submit')
    await flushPromises()
    expect(requestMock).toHaveBeenCalledExactlyOnceWith('/api/admin/categories/8', {
      method: 'PUT',
      body: { name: 'Raíz renombrada', parentId: 10 }
    })
    expect(refreshDataMock).toHaveBeenCalledExactlyOnceWith('categories')
  })
  it('deletes only an empty leaf through the original DELETE', async () => {
    const { wrapper } = await render(nodePayload(), 'success', 'node')
    await button(wrapper, 'Eliminar Vacía Node').trigger('click')
    await button(wrapper.get('dialog'), 'Eliminar familia').trigger('click')
    await flushPromises()
    expect(requestMock).toHaveBeenCalledExactlyOnceWith('/api/admin/categories/10', { method: 'DELETE' })
    expect(refreshDataMock).toHaveBeenCalledExactlyOnceWith('categories')
  })
  it('refuses a programmatic delete of a nonempty parent even though Node mutations are supported', async () => {
    const { wrapper } = await render(nodePayload(), 'success', 'node')
    setupState(wrapper).removing = { id: 8, name: 'Fake empty root', count: 0, hasChildren: false }
    await invoke(wrapper, 'confirmRemove')
    expect(requestMock).not.toHaveBeenCalled()
  })
  it('uses the current authorized row rather than programmatically supplied names or empty-parent flags', async () => {
    const { wrapper } = await render(nodePayload(), 'success', 'node')
    await invoke(wrapper, 'startEdit', { id: 10, name: 'Forged name', parentId: 999 })
    expect((wrapper.get('dialog input').element as HTMLInputElement).value).toBe('Vacía Node')
    await button(wrapper.get('dialog'), 'Cancelar').trigger('click')
    await invoke(wrapper, 'startRemove', { id: 8, name: 'Forged empty root', hasChildren: false, count: 0 })
    expect(wrapper.find('dialog').exists()).toBe(false)
    expect(requestMock).not.toHaveBeenCalled()
  })
  it.each([8, 9, 999, '10'])('refuses a programmatic self/descendant or invalid move target (%j)', async (parentId) => {
    const { wrapper } = await render(nodePayload(), 'success', 'node')
    await button(wrapper, 'Editar Raíz Node').trigger('click')
    Object.assign(setupState(wrapper).editForm as object, { name: 'Invalid move', parentId })
    await invoke(wrapper, 'saveEdit')
    expect(requestMock).not.toHaveBeenCalled()
    expect(refreshDataMock).not.toHaveBeenCalled()
  })
  it.each([999, '8', -1])('refuses a programmatic create with an invalid parent (%j)', async (parentId) => {
    const { wrapper } = await render(nodePayload(), 'success', 'node')
    Object.assign(setupState(wrapper).createForm as object, { name: 'Invalid creation', parentId })
    await invoke(wrapper, 'createCategory')
    expect(requestMock).not.toHaveBeenCalled()
    expect(refreshDataMock).not.toHaveBeenCalled()
  })
  it('honors explicit false action capabilities without replacing them with the Node fallback', async () => {
    const data = nodePayload()
    data.capabilities = { categoriesRead: true, categoryCreate: false, categoryUpdate: false, categoryDelete: false }
    const { wrapper } = await render(data, 'success', 'node')
    expect(wrapper.find('[data-category-tree]').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('Nueva familia')
    expect(wrapper.find('button[aria-label^="Editar"], button[aria-label^="Eliminar"]').exists()).toBe(false)
  })
  it('requires explicit read authority when a Node capability map is present but omits categoriesRead', async () => {
    const data = nodePayload()
    data.capabilities = { categoryCreate: true, categoryUpdate: true, categoryDelete: true }
    const { wrapper } = await render(data, 'success', 'node')
    expect(wrapper.find('[data-category-tree], dialog, form').exists()).toBe(false)
    expect(wrapper.get('header').attributes('data-count')).toBeUndefined()
    expect(wrapper.text()).not.toContain('Raíz Node')
    const state = setupState(wrapper)
    Object.assign(state, {
      creating: true,
      editing: { id: 8, name: 'Stale Node', parentId: null },
      removing: { id: 10, count: 0, hasChildren: false }
    })
    Object.assign(state.createForm as object, { name: 'Forged Node creation' })
    Object.assign(state.editForm as object, { name: 'Forged Node move', parentId: 10 })
    await invoke(wrapper, 'createCategory')
    await invoke(wrapper, 'saveEdit')
    await invoke(wrapper, 'confirmRemove')
    await flushPromises()
    expect(wrapper.find('dialog, form').exists()).toBe(false)
    expect(requestMock).not.toHaveBeenCalled()
  })
  it('does not enable omitted actions in a present Node capability map', async () => {
    const data = nodePayload()
    data.capabilities = { categoriesRead: true }
    const { wrapper } = await render(data, 'success', 'node')
    expect(wrapper.find('[data-category-tree]').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('Nueva familia')
    expect(wrapper.find('button[aria-label^="Editar"], button[aria-label^="Eliminar"]').exists()).toBe(false)
    const state = setupState(wrapper)
    Object.assign(state, {
      creating: true,
      editing: { id: 8, name: 'Stale Node', parentId: null },
      removing: { id: 10, count: 0, hasChildren: false }
    })
    Object.assign(state.createForm as object, { name: 'Forged Node creation' })
    Object.assign(state.editForm as object, { name: 'Forged Node move', parentId: 10 })
    await invoke(wrapper, 'createCategory')
    await invoke(wrapper, 'saveEdit')
    await invoke(wrapper, 'confirmRemove')
    await flushPromises()
    expect(wrapper.find('dialog, form').exists()).toBe(false)
    expect(requestMock).not.toHaveBeenCalled()
  })
  it('accepts only own literal true Node action capabilities, not inherited or coercible values', async () => {
    const data = nodePayload()
    data.capabilities = Object.assign(Object.create({ categoryCreate: true }), {
      categoriesRead: true,
      categoryUpdate: 'true',
      categoryDelete: 1
    })
    const { wrapper } = await render(data, 'success', 'node')
    expect(wrapper.find('[data-category-tree]').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('Nueva familia')
    expect(wrapper.find('button[aria-label^="Editar"], button[aria-label^="Eliminar"]').exists()).toBe(false)
  })
  it.each([{ capabilities: undefined }, { capabilities: null }, { capabilities: 'true' }, { capabilities: [] }])(
    'does not treat a malformed present Node capability map ($capabilities) as a legacy response',
    async ({ capabilities }) => {
      const data = nodePayload()
      Object.assign(data, { capabilities })
      const { wrapper } = await render(data, 'success', 'node')
      expect(wrapper.find('[data-category-tree], dialog, form').exists()).toBe(false)
      expect(wrapper.get('header').attributes('data-count')).toBeUndefined()
    }
  )
  it.each(['node', 'cloudflare'])(
    'rejects a capability array masquerading as a literal true read map in %s',
    async (runtime) => {
      const data = runtime === 'node' ? nodePayload() : payload()
      Object.assign(data, { capabilities: Object.assign([], { categoriesRead: true }) })
      const { wrapper } = await render(data, 'success', runtime)
      expect(wrapper.find('[data-category-tree]').exists()).toBe(false)
      expect(wrapper.get('header').attributes('data-count')).toBeUndefined()
    }
  )
  it.each(['node', 'cloudflare'])('rejects inherited read capabilities in %s', async (runtime) => {
    const data = runtime === 'node' ? nodePayload() : payload()
    data.capabilities = Object.create({ categoriesRead: true })
    const { wrapper } = await render(data, 'success', runtime)
    expect(wrapper.find('[data-category-tree]').exists()).toBe(false)
    expect(wrapper.get('header').attributes('data-count')).toBeUndefined()
  })
  it('preserves explicit true Node actions without enabling the other omitted action', async () => {
    const data = nodePayload()
    data.capabilities = { categoriesRead: true, categoryCreate: true, categoryUpdate: true }
    const { wrapper } = await render(data, 'success', 'node')
    expect(button(wrapper, 'Nueva familia').exists()).toBe(true)
    expect(button(wrapper, 'Editar Raíz Node').exists()).toBe(true)
    expect(wrapper.find('button[aria-label^="Eliminar"]').exists()).toBe(false)
    await button(wrapper, 'Nueva familia').trigger('click')
    await wrapper.get('dialog input').setValue('Nueva con permiso')
    await wrapper.get('form#new-family').trigger('submit')
    await flushPromises()
    expect(requestMock).toHaveBeenCalledExactlyOnceWith('/api/admin/categories', {
      method: 'POST',
      body: { name: 'Nueva con permiso', parentId: null }
    })
  })
  it.each(['cloudflare', 'external', 'node'])(
    'does not reinterpret a foreign source %s as the metadata-free public Node response',
    async (source) => {
      const data = nodePayload()
      data.source = source
      const { wrapper } = await render(data, 'success', 'node')
      expect(wrapper.find('[data-category-tree], dialog').exists()).toBe(false)
      await invoke(wrapper, 'createCategory')
      await invoke(wrapper, 'saveEdit')
      await invoke(wrapper, 'confirmRemove')
      expect(requestMock).not.toHaveBeenCalled()
    }
  )
  it.each(['capability', 'status', 'dto'])(
    'closes a stale edit/move dialog on %s change and prevents its submission',
    async (change) => {
      const { wrapper, response, readStatus } = await render(nodePayload(), 'success', 'node')
      await button(wrapper, 'Editar Vacía Node').trigger('click')
      await wrapper.get('dialog input').setValue('Cambio pendiente')
      const submit = setupState(wrapper).saveEdit as () => Promise<void>
      if (change === 'capability') response.value!.capabilities = { categoryUpdate: false }
      if (change === 'status') readStatus.value = 'error'
      if (change === 'dto') response.value = { ...nodePayload(), roots: [], flat: [] }
      await flushPromises()
      expect(wrapper.find('dialog').exists()).toBe(false)
      await submit()
      expect(requestMock).not.toHaveBeenCalled()
    }
  )
  it('closes stale dialogs on an in-place tree update even when read/action authority remains valid', async () => {
    const { wrapper, response } = await render(nodePayload(), 'success', 'node')
    await button(wrapper, 'Editar Vacía Node').trigger('click')
    const submit = setupState(wrapper).saveEdit as () => Promise<void>
    response.value!.roots[1]!.name = 'Nombre actualizado en servidor'
    await flushPromises()
    expect(wrapper.find('dialog').exists()).toBe(false)
    expect(wrapper.text()).toContain('Nombre actualizado en servidor')
    await submit()
    expect(requestMock).not.toHaveBeenCalled()
  })
  it.each([
    { action: 'categoryCreate', open: 'Nueva familia', callback: 'createCategory' },
    { action: 'categoryUpdate', open: 'Editar Vacía Node', callback: 'saveEdit' },
    { action: 'categoryDelete', open: 'Eliminar Vacía Node', callback: 'confirmRemove' }
  ])(
    'revokes an open $action dialog immediately when its own capability is omitted',
    async ({ action, open, callback }) => {
      const data = nodePayload()
      data.capabilities = { categoriesRead: true, categoryCreate: true, categoryUpdate: true, categoryDelete: true }
      const { wrapper, response } = await render(data, 'success', 'node')
      await button(wrapper, open).trigger('click')
      expect(wrapper.find('dialog').exists()).toBe(true)
      if (action !== 'categoryDelete') await wrapper.get('dialog input').setValue('Pending authorized command')
      const submit = setupState(wrapper)[callback] as () => Promise<void>
      expect(Reflect.deleteProperty(response.value!.capabilities!, action)).toBe(true)
      await submit()
      await flushPromises()
      expect(wrapper.find('[data-category-tree]').exists()).toBe(true)
      expect(wrapper.find('dialog').exists()).toBe(false)
      expect(requestMock).not.toHaveBeenCalled()
      expect(refreshDataMock).not.toHaveBeenCalled()
    }
  )
  it('closes creation/deletion dialogs on revoked read authority, even before cached callbacks can execute', async () => {
    const { wrapper, response } = await render(nodePayload(), 'success', 'node')
    await button(wrapper, 'Nueva familia').trigger('click')
    await wrapper.get('dialog input').setValue('Pending create')
    response.value!.capabilities = { categoriesRead: false }
    await invoke(wrapper, 'createCategory')
    await flushPromises()
    expect(wrapper.find('dialog').exists()).toBe(false)
    expect(requestMock).not.toHaveBeenCalled()
    response.value = nodePayload()
    await flushPromises()
    await button(wrapper, 'Eliminar Vacía Node').trigger('click')
    response.value!.capabilities = { categoriesRead: false }
    await invoke(wrapper, 'confirmRemove')
    await flushPromises()
    expect(wrapper.find('dialog').exists()).toBe(false)
    expect(requestMock).not.toHaveBeenCalled()
  })
  it('retains a failed Node edit for explicit retry without refreshing or claiming success', async () => {
    requestMock.mockRejectedValueOnce(new Error('Synthetic unavailable backend'))
    const { wrapper } = await render(nodePayload(), 'success', 'node')
    await button(wrapper, 'Editar Vacía Node').trigger('click')
    await wrapper.get('dialog input').setValue('Nombre nuevo')
    await wrapper.get('form#edit-family').trigger('submit')
    await flushPromises()
    expect(wrapper.find('dialog').exists()).toBe(true)
    expect(refreshDataMock).not.toHaveBeenCalled()
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ color: 'error' }))
    await wrapper.get('form#edit-family').trigger('submit')
    await flushPromises()
    expect(requestMock).toHaveBeenCalledTimes(2)
    expect(refreshDataMock).toHaveBeenCalledOnce()
  })
})
