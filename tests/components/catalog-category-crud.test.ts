import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h, proxyRefs, ref, shallowRef } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CategoryCrudEditor from '../../app/components/CategoryCrudEditor.vue'
import { parseD1CategoryAdminView, type CatalogCategorySnapshot } from '../../shared/catalog-category-commands'
import '#app/nuxt-vitest-app-entry'

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }))
mockNuxtImport('$fetch', () => requestMock)
const uuid = (id: number) => `a0400000-0000-4000-8000-${String(id).padStart(12, '0')}`
function snapshot(
  id: number,
  parentId: number | null = null,
  extra: Partial<CatalogCategorySnapshot> = {}
): CatalogCategorySnapshot {
  return {
    id,
    uuid: uuid(id),
    version: 1,
    name: `Familia ${id}`,
    slug: `familia-${id}`,
    status: 'published',
    actualParentUuid: parentId === null ? null : uuid(parentId),
    actualParentId: parentId,
    parentMapped: true,
    sort: id,
    directChildren: 0,
    directProducts: 0,
    ...extra
  }
}
function row(value: CatalogCategorySnapshot, parentId: number | null = value.actualParentId) {
  return {
    id: value.id,
    name: value.name,
    slug: value.slug,
    parentId,
    sort: value.sort,
    status: value.status,
    directCount: value.directProducts,
    count: value.directProducts,
    authoring: value
  }
}
function view(overrides: Partial<CatalogCategorySnapshot> = {}) {
  const child = row(snapshot(2, 1, overrides), 1),
    root = row(snapshot(1, null, { directChildren: 1 })),
    empty = row(snapshot(3))
  return {
    source: 'cloudflare',
    capabilities: { categoriesRead: true, categoryCreate: true, categoryUpdate: true, categoryDelete: true },
    flat: [root, child, empty],
    roots: [
      { ...root, children: [{ ...child, children: [] }] },
      { ...empty, children: [] }
    ],
    unmappedCategories: 0
  }
}
function advanced(id = 2, extra: Partial<CatalogCategorySnapshot> = {}) {
  const data = view(id === 2 ? { version: 2, ...extra } : {})
  if (id === 3) {
    const next = row(snapshot(3, null, { version: 2, ...extra }))
    data.flat[2] = next
    data.roots[1] = { ...next, children: [] }
  }
  return data
}
function createdView() {
  const data = view(),
    entry = row(snapshot(1000, null, { status: 'draft', name: 'Nueva familia', slug: 'nueva-familia' }))
  data.flat.push(entry)
  data.roots.push({ ...entry, children: [] })
  return data
}
const receipt = (action = 'update_category', extra: Record<string, unknown> = {}) => ({
  source: 'cloudflare',
  action,
  categoryId: action === 'create_category' ? 1000 : 2,
  categoryUuid: uuid(action === 'create_category' ? 1000 : 2),
  categoryVersion: action === 'create_category' ? 1 : 2,
  slug: action === 'create_category' ? 'nueva-familia' : 'familia-renovada',
  status: action === 'create_category' ? 'draft' : 'published',
  updated: true,
  ...extra
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
const mounted: Array<{ unmount: () => void }> = []
async function render(data: unknown = view(), status = 'success', runtime = 'cloudflare') {
  const response = shallowRef(data),
    readStatus = ref(status),
    currentRuntime = ref(runtime),
    authority = ref(true)
  const authorize = vi.fn((_identity?: { id: number; uuid: string; version: number }) => authority.value)
  const refresh = vi.fn<() => Promise<unknown>>(async () => undefined)
  const Host = defineComponent({
    setup: () => () =>
      h(CategoryCrudEditor, {
        view: response.value,
        readStatus: readStatus.value,
        runtime: currentRuntime.value,
        authorize,
        refresh
      })
  })
  const wrapper = await mountSuspended(Host, { global: { stubs: { UButton: Button } } })
  mounted.push(wrapper)
  const editor = wrapper.findComponent(CategoryCrudEditor)
  async function invoke(name: string, ...args: unknown[]) {
    const raw: unknown = Object.getOwnPropertyDescriptor(editor.vm.$, 'setupState')?.value
    if (!raw || typeof raw !== 'object') throw new Error('Missing editor state')
    const state = proxyRefs(raw as Record<string, unknown>),
      action = state[name]
    if (typeof action !== 'function') throw new Error(`Missing action ${name}`)
    await action(...args)
  }
  return { wrapper, editor, response, readStatus, currentRuntime, authority, authorize, refresh, invoke }
}
type Render = Awaited<ReturnType<typeof render>>
async function prepare(result: Render, action = 'update_category', id = 2) {
  if (action !== 'create_category') await result.wrapper.get('[data-category-target]').setValue(String(id))
  if (action === 'create_category') await result.wrapper.get('[data-category-create]').trigger('click')
  else if (action === 'delete_category') {
    await result.wrapper.get(`[data-category-delete="${id}"]`).trigger('click')
    await result.wrapper.get('[data-category-confirm]').setValue(true)
  } else await result.wrapper.get(`[data-category-edit="${id}"]`).trigger('click')
  if (action !== 'delete_category')
    await result.wrapper
      .get('[data-category-name]')
      .setValue(action === 'create_category' ? 'Nueva familia' : 'Familia renovada')
  await result.wrapper.get('[data-category-reason]').setValue('Cambio editorial explícito')
}
function pending<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
beforeEach(() => {
  requestMock.mockReset()
})
afterEach(() => {
  mounted.splice(0).forEach((wrapper) => wrapper.unmount())
  vi.restoreAllMocks()
})

describe('category editorial UI uses only confirmed own tree identity', () => {
  it('accepts the exact private DTO and preserves negative historical sort/name', async () => {
    const data = view({ name: 'X', sort: -2 })
    expect(parseD1CategoryAdminView(data)).not.toBeNull()
    const result = await render(data)
    await result.wrapper.get('[data-category-target]').setValue('2')
    expect(result.wrapper.get('[data-category-edit="2"]').text()).toContain('X')
    expect(result.wrapper.text()).toContain('Crear no publica')
    expect(requestMock).not.toHaveBeenCalled()
  })
  it.each(['pending', 'error', 'idle'])('does not expose cached names/forms/actions while %s', async (status) => {
    const result = await render(view(), status)
    expect(result.wrapper.text()).not.toContain('Familia 2')
    expect(result.wrapper.find('form,[data-category-create],[data-category-edit]').exists()).toBe(false)
    await result.invoke('begin', 'create_category')
    await result.invoke('submit')
    expect(requestMock).not.toHaveBeenCalled()
  })
  it.each(['node', 'Cloudflare', 'unknown', ''])('never falls back to Node writes for runtime %j', async (runtime) => {
    const result = await render(view(), 'success', runtime)
    await result.invoke('begin', 'create_category')
    await result.invoke('submit')
    await result.invoke('reload')
    expect(requestMock).not.toHaveBeenCalled()
    expect(result.refresh).not.toHaveBeenCalled()
  })
  it.each([
    'source',
    'unknown-field',
    'duplicate',
    'partial-tree',
    'snapshot',
    'ancestor-cycle',
    'count',
    'capability-string',
    'oversized'
  ])('rejects malformed private graph %s', async (shape) => {
    const data = view()
    if (shape === 'source') data.source = 'node'
    else if (shape === 'unknown-field') Object.assign(data, { unsafe: 'private' })
    else if (shape === 'duplicate') data.flat.push(data.flat[0]!)
    else if (shape === 'partial-tree') data.roots = []
    else if (shape === 'snapshot') data.flat[1]!.authoring.uuid = uuid(3)
    else if (shape === 'ancestor-cycle') {
      data.flat[0]!.parentId = 2
      data.roots[0]!.parentId = 2
    } else if (shape === 'count') data.flat[1]!.count = -1
    else if (shape === 'capability-string') Object.assign(data.capabilities, { categoryCreate: 'true' })
    else data.flat = Array.from({ length: 1001 }, () => data.flat[0]!)
    const result = await render(data)
    expect(result.wrapper.find('form,[data-category-create],[data-category-edit]').exists()).toBe(false)
    expect(result.wrapper.text()).not.toContain('Familia 2')
    expect(requestMock).not.toHaveBeenCalled()
  })
  it.each(['getter', 'prototype', 'inherited-cap', 'array-getter'])(
    'never invokes hostile read data %s',
    async (shape) => {
      const result = await render(),
        data = view(),
        getter = vi.fn(() => true)
      if (shape === 'getter') Object.defineProperty(data, 'source', { get: getter, enumerable: true })
      else if (shape === 'prototype') Object.setPrototypeOf(data, { private: true })
      else if (shape === 'inherited-cap') {
        Reflect.deleteProperty(data.capabilities, 'categoryCreate')
        Object.setPrototypeOf(data.capabilities, { categoryCreate: true })
      } else Object.defineProperty(data.roots, '0', { get: getter, enumerable: true })
      result.response.value = data
      await flushPromises()
      expect(result.wrapper.find('form,[data-category-create]').exists()).toBe(false)
      expect(getter).not.toHaveBeenCalled()
      expect(requestMock).not.toHaveBeenCalled()
    }
  )
  it('read permission never implies administration.manage and programmatic actions remain blocked', async () => {
    const data = view()
    Object.assign(data.capabilities, { categoryCreate: false, categoryUpdate: false, categoryDelete: false })
    const result = await render(data)
    await result.invoke('begin', 'create_category')
    await result.invoke('begin', 'update_category', 2)
    await result.invoke('submit')
    expect(result.wrapper.find('form').exists()).toBe(false)
    expect(requestMock).not.toHaveBeenCalled()
  })
  it('searches/selects one editorial target instead of duplicating the full tree as expanded action buttons', async () => {
    const result = await render()
    expect(result.wrapper.find('[data-category-edit],[data-category-delete]').exists()).toBe(false)
    await result.wrapper.get('[data-category-search]').setValue('Familia 2')
    expect(result.wrapper.findAll('[data-category-target] option').map((option) => option.text())).toEqual([
      'Selecciona una familia',
      'Familia 2'
    ])
    await result.wrapper.get('[data-category-target]').setValue('2')
    expect(result.wrapper.findAll('[data-category-edit],[data-category-delete]')).toHaveLength(2)
    expect(result.wrapper.find('[data-category-edit="1"]').exists()).toBe(false)
    expect(result.wrapper.text()).not.toContain('legacy-category-')
    expect(requestMock).not.toHaveBeenCalled()
  })
  it('shows an empty confirmed tree with an explicit draft creator but does not create until valid reason', async () => {
    const data = view()
    data.flat = []
    data.roots = []
    const result = await render(data)
    await result.wrapper.get('[data-category-create]').trigger('click')
    await result.wrapper.get('[data-category-name]').setValue('Familia')
    await result.invoke('submit')
    expect(requestMock).not.toHaveBeenCalled()
    expect(result.wrapper.get('[data-category-name]').attributes()).toMatchObject({
      required: '',
      minlength: '2',
      maxlength: '160'
    })
  })
  it('creates only a draft with reason, version0, explicit parent and a receipt followed by GET', async () => {
    const result = await render()
    requestMock.mockResolvedValue(receipt('create_category'))
    result.refresh.mockImplementation(async () => {
      result.response.value = createdView()
    })
    await prepare(result, 'create_category')
    await result.invoke('submit')
    expect(requestMock).toHaveBeenCalledOnce()
    expect(requestMock.mock.calls[0]).toEqual([
      '/api/admin/categories',
      expect.objectContaining({
        method: 'POST',
        body: { name: 'Nueva familia', parentId: null, expectedVersion: 0, reason: 'Cambio editorial explícito' },
        retry: 0,
        headers: expect.objectContaining({ 'Idempotency-Key': expect.any(String) })
      })
    ])
    expect(result.refresh).toHaveBeenCalledOnce()
    expect(result.wrapper.text()).toContain('Sigue pendiente de publicación explícita')
    expect(result.wrapper.find('form').exists()).toBe(false)
  })
  it('renames without substituting the projected legacy ancestor for the exact unmapped parent', async () => {
    const result = await render(
      view({ actualParentUuid: 'historic-unmapped-parent', actualParentId: null, parentMapped: false })
    )
    requestMock.mockResolvedValue(receipt())
    result.refresh.mockImplementation(async () => {
      result.response.value = advanced(2, {
        actualParentUuid: 'historic-unmapped-parent',
        actualParentId: null,
        parentMapped: false
      })
    })
    await prepare(result)
    expect(result.wrapper.get<HTMLSelectElement>('[data-category-parent]').element.value).toBe('keep')
    await result.invoke('submit')
    expect(requestMock.mock.calls[0]?.[1].body).toEqual({
      name: 'Familia renovada',
      expectedVersion: 1,
      reason: 'Cambio editorial explícito'
    })
    expect(result.authorize).toHaveBeenCalledWith({ id: 2, uuid: uuid(2), version: 1 })
  })
  it('sends a chosen parent explicitly and never offers self/descendant/discontinued references', async () => {
    const data = view()
    data.flat[2]!.status = 'discontinued'
    data.flat[2]!.authoring.status = 'discontinued'
    data.roots[1]!.status = 'discontinued'
    data.roots[1]!.authoring.status = 'discontinued'
    const result = await render(data)
    await prepare(result, 'update_category', 1)
    const values = result.wrapper.findAll('[data-category-parent] option').map((entry) => entry.attributes('value'))
    expect(values).toEqual(['keep', 'root'])
    await result.invoke('cancel')
    await prepare(result)
    await result.wrapper.get('[data-category-parent]').setValue('root')
    requestMock.mockRejectedValue(new Error('unknown'))
    await result.invoke('submit')
    expect(requestMock.mock.calls[0]?.[1].body.parentId).toBeNull()
  })
  it('requires an explicit empty-family withdrawal confirmation and retains its tombstone in fresh GET', async () => {
    const result = await render()
    requestMock.mockResolvedValue(
      receipt('delete_category', { categoryId: 3, categoryUuid: uuid(3), status: 'discontinued' })
    )
    result.refresh.mockImplementation(async () => {
      result.response.value = advanced(3, { status: 'discontinued' })
    })
    await result.wrapper.get('[data-category-target]').setValue('3')
    await result.wrapper.get('[data-category-delete="3"]').trigger('click')
    await result.wrapper.get('[data-category-reason]').setValue('Retirada explícita')
    await result.invoke('submit')
    expect(requestMock).not.toHaveBeenCalled()
    await result.wrapper.get('[data-category-confirm]').setValue(true)
    await result.invoke('submit')
    expect(requestMock.mock.calls[0]).toEqual([
      '/api/admin/categories/3',
      expect.objectContaining({
        method: 'DELETE',
        body: { expectedVersion: 1, reason: 'Retirada explícita' },
        retry: 0
      })
    ])
    expect(result.wrapper.text()).toContain('identidad, historial y direcciones anteriores se conservan')
  })
  it('does not permit delete when actual unmapped child/product evidence is nonzero', async () => {
    const data = view({ directChildren: 1, directProducts: 1 })
    data.flat[1]!.directCount = 1
    data.flat[1]!.count = 1
    data.flat[0]!.count = 1
    data.roots[0]!.count = 1
    data.roots[0]!.children[0] = { ...data.flat[1]!, children: [] }
    const result = await render(data)
    await result.wrapper.get('[data-category-target]').setValue('2')
    expect(result.wrapper.get('[data-category-delete="2"]').attributes('disabled')).toBeDefined()
    await result.invoke('begin', 'delete_category', 2)
    await result.invoke('submit')
    expect(requestMock).not.toHaveBeenCalled()
  })
  it('guards duplicate submissions and exposes no write retry until the first request settles', async () => {
    const result = await render(),
      deferred = pending<unknown>()
    requestMock.mockReturnValue(deferred.promise)
    await prepare(result)
    const first = result.invoke('submit')
    await flushPromises()
    await result.invoke('submit')
    await result.invoke('reload')
    expect(requestMock).toHaveBeenCalledOnce()
    expect(result.refresh).not.toHaveBeenCalled()
    deferred.resolve(receipt())
    await first
    expect(result.wrapper.find('[data-category-retry]').exists()).toBe(true)
  })
  it('early manual retry cannot cache a permanently false reactive gate', async () => {
    const result = await render()
    await result.invoke('retry')
    requestMock.mockRejectedValue(new Error('provider private SQL'))
    await prepare(result)
    await result.invoke('submit')
    expect(result.wrapper.get('[data-category-retry]').attributes('disabled')).toBeUndefined()
    await result.invoke('retry')
    expect(requestMock).toHaveBeenCalledTimes(2)
    expect(requestMock.mock.calls[1]?.[1].body).toEqual(requestMock.mock.calls[0]?.[1].body)
    expect(requestMock.mock.calls[1]?.[1].headers['Idempotency-Key']).toBe(
      requestMock.mock.calls[0]?.[1].headers['Idempotency-Key']
    )
    expect(result.wrapper.text()).not.toContain('private SQL')
  })
  it('historical retry retains the original version/body/key after status and version advance', async () => {
    const result = await render()
    requestMock.mockRejectedValueOnce(new Error('ambiguous')).mockResolvedValueOnce(receipt())
    await prepare(result)
    await result.invoke('submit')
    result.response.value = advanced(2, { version: 4, status: 'discontinued' })
    await flushPromises()
    result.refresh.mockImplementation(async () => {
      result.response.value = advanced(2, { version: 5, status: 'discontinued' })
    })
    await result.invoke('retry')
    expect(requestMock).toHaveBeenCalledTimes(2)
    expect(requestMock.mock.calls[1]?.[1].body.expectedVersion).toBe(1)
    expect(requestMock.mock.calls[1]?.[1].headers).toEqual(requestMock.mock.calls[0]?.[1].headers)
    expect(result.authorize).toHaveBeenCalledWith({ id: 2, uuid: uuid(2), version: 4 })
    expect(result.wrapper.find('[data-category-retry]').exists()).toBe(false)
  })
  it('a historical draft-create receipt never overrides a newer confirmed published status or claims it remains pending', async () => {
    const result = await render()
    requestMock.mockRejectedValueOnce(new Error('ambiguous')).mockResolvedValueOnce(receipt('create_category'))
    await prepare(result, 'create_category')
    await result.invoke('submit')
    const current = createdView(),
      entry = current.flat.find((row) => row.id === 1000)!
    entry.status = 'published'
    entry.authoring.status = 'published'
    entry.authoring.version = 4
    const root = current.roots.find((row) => row.id === 1000)!
    root.status = 'published'
    result.response.value = current
    result.refresh.mockImplementation(async () => {
      result.response.value = { ...current }
    })
    await flushPromises()
    await result.invoke('retry')
    expect(requestMock).toHaveBeenCalledTimes(2)
    expect(requestMock.mock.calls[1]?.[1].headers).toEqual(requestMock.mock.calls[0]?.[1].headers)
    expect(result.wrapper.text()).toContain('el árbol muestra el estado vigente')
    expect(result.wrapper.text()).not.toContain('Sigue pendiente')
    expect(parseD1CategoryAdminView(result.response.value)?.flat.find((row) => row.id === 1000)?.status).toBe(
      'published'
    )
  })
  it.each([401, 403])(
    'preserves the original intention on auth%d because denial may follow a committed batch',
    async (status) => {
      const result = await render()
      requestMock.mockImplementation(async (_path, options) => {
        options.onResponseError({ response: { status, _data: { error: { code: 'forbidden' } } } })
        throw Object.assign(new Error('private'), { data: { error: { code: 'forbidden' } } })
      })
      await prepare(result, 'create_category')
      await result.invoke('submit')
      await result.invoke('retry')
      expect(requestMock).toHaveBeenCalledTimes(2)
      expect(requestMock.mock.calls[1]?.[1].headers).toEqual(requestMock.mock.calls[0]?.[1].headers)
      expect(result.wrapper.get('[data-category-create]').attributes('disabled')).toBeDefined()
    }
  )
  it('a deterministic version conflict requires fresh GET and no automatic retry', async () => {
    const result = await render()
    requestMock.mockRejectedValue(
      Object.assign(new Error('raw SQL'), { data: { error: { code: 'version_conflict' } } })
    )
    await prepare(result)
    await result.invoke('submit')
    await result.invoke('submit')
    await result.invoke('retry')
    expect(requestMock).toHaveBeenCalledOnce()
    expect(result.wrapper.find('[data-category-retry]').exists()).toBe(false)
    result.refresh.mockImplementation(async () => {
      result.response.value = advanced()
    })
    await result.invoke('reload')
    await prepare(result)
    await result.invoke('submit')
    expect(requestMock.mock.calls[1]?.[1].body.expectedVersion).toBe(2)
    expect(requestMock.mock.calls[1]?.[1].headers['Idempotency-Key']).not.toBe(
      requestMock.mock.calls[0]?.[1].headers['Idempotency-Key']
    )
  })
  it.each(['action', 'target', 'uuid', 'version', 'status', 'extra', 'accessor'])(
    'rejects a malformed or foreign receipt %s and keeps the exact pending intention',
    async (shape) => {
      const result = await render(),
        data = receipt(),
        calls = vi.fn()
      if (shape === 'action') data.action = 'create_category'
      else if (shape === 'target') data.categoryId = 3
      else if (shape === 'uuid') data.categoryUuid = uuid(3)
      else if (shape === 'version') data.categoryVersion = 3
      else if (shape === 'status') data.status = 'published-other'
      else if (shape === 'extra') Object.assign(data, { token: 'private' })
      else Object.defineProperty(data, 'status', { get: calls, enumerable: true })
      requestMock.mockResolvedValue(data)
      await prepare(result)
      await result.invoke('submit')
      expect(result.refresh).not.toHaveBeenCalled()
      expect(result.wrapper.find('[data-category-retry]').exists()).toBe(true)
      expect(calls).not.toHaveBeenCalled()
      expect(result.wrapper.text()).not.toContain('private')
    }
  )
  it('refresh failure after a valid receipt stays ambiguous and repeats the same intent manually', async () => {
    const result = await render()
    requestMock.mockResolvedValue(receipt())
    result.refresh.mockRejectedValueOnce(new Error('read outage'))
    await prepare(result)
    await result.invoke('submit')
    expect(result.wrapper.text()).not.toContain('Cambio confirmado')
    result.refresh.mockImplementation(async () => {
      result.response.value = advanced()
    })
    await result.invoke('retry')
    expect(requestMock.mock.calls[1]?.[1].headers).toEqual(requestMock.mock.calls[0]?.[1].headers)
    expect(result.wrapper.text()).toContain('Cambio confirmado')
  })
  it.each(['authority', 'read', 'identity', 'runtime', 'unmount'])(
    'late write cannot refresh or report success after %s changes',
    async (change) => {
      const result = await render(),
        deferred = pending<unknown>()
      requestMock.mockReturnValue(deferred.promise)
      await prepare(result)
      const first = result.invoke('submit')
      await flushPromises()
      if (change === 'authority') result.authority.value = false
      else if (change === 'read') result.readStatus.value = 'error'
      else if (change === 'identity') result.response.value = view({ uuid: uuid(44) })
      else if (change === 'runtime') result.currentRuntime.value = 'node'
      else result.wrapper.unmount()
      await flushPromises()
      deferred.resolve(receipt())
      await first
      expect(result.refresh).not.toHaveBeenCalled()
      if (change !== 'unmount') {
        expect(result.wrapper.text()).not.toContain('Cambio confirmado')
        await result.invoke('retry')
        expect(requestMock).toHaveBeenCalledOnce()
      }
    }
  )
  it('GET recovery is explicit and guarded, never resubmits writes', async () => {
    const result = await render(view(), 'error'),
      deferred = pending<unknown>()
    result.refresh.mockReturnValue(deferred.promise)
    const first = result.invoke('reload')
    await flushPromises()
    await result.invoke('reload')
    expect(result.refresh).toHaveBeenCalledOnce()
    expect(requestMock).not.toHaveBeenCalled()
    result.readStatus.value = 'success'
    deferred.resolve(undefined)
    await first
    expect(result.wrapper.get('[data-category-create]').exists()).toBe(true)
    expect(requestMock).not.toHaveBeenCalled()
  })
})
