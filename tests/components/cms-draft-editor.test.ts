import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h, ref, proxyRefs } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CmsDraftEditor from '../../app/components/CmsDraftEditor.vue'
import '#app/nuxt-vitest-app-entry'
const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }))
mockNuxtImport('$fetch', () => requestMock)
const ACTOR = '10000000-0000-4000-8000-000000000044',
  PAGE = '20000000-0000-4000-8000-000000000044',
  BLOCK = '30000000-0000-4000-8000-000000000044',
  VERSION = '40000000-0000-4000-8000-000000000044',
  ROOT = '/api/admin/content/pages',
  STAMP = '2026-10-03T08:00:00Z'
const versionId = (n: number) => `40000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const caps = () => ({
  contentRead: true,
  contentCreate: true,
  contentUpdate: true,
  contentRestore: true,
  contentArchive: true,
  contentPublish: false,
  contentPreview: false,
  contentSchedule: false
})
const document = () => ({
  title: 'Guía editorial',
  slug: 'guia-editorial',
  seo: { title: 'Guía editorial', description: 'Descripción editorial privada.', noindex: true },
  blocks: [{ id: BLOCK, type: 'paragraph', text: 'Contenido editorial privado.' }],
  changeSummary: 'Versión editorial inicial'
})
function detail(version = 1, status: 'draft' | 'hidden' = 'draft') {
  const id = version === 1 ? VERSION : versionId(version),
    draft = {
      id,
      pageId: PAGE,
      version,
      document: document(),
      basedOnId: version === 1 ? null : VERSION,
      createdBy: ACTOR,
      createdAt: STAMP
    }
  return {
    source: 'cloudflare',
    capabilities: caps(),
    page: {
      id: PAGE,
      title: 'Guía editorial',
      slug: 'guia-editorial',
      status,
      pageVersion: status === 'hidden' ? version + 1 : version,
      draftVersion: version,
      draftVersionId: id,
      createdBy: ACTOR,
      createdAt: STAMP,
      updatedAt: STAMP,
      archivedAt: status === 'hidden' ? STAMP : null
    },
    draft,
    history: {
      versions: Array.from({ length: version }, (_, index) => {
        const n = version - index
        return { ...draft, id: n === 1 ? VERSION : versionId(n), version: n, basedOnId: n === 1 ? null : VERSION }
      }),
      pagination: { page: 1, perPage: 5, total: version, hasMore: false }
    }
  }
}
const list = (data = detail()) => ({
  source: 'cloudflare',
  capabilities: data.capabilities,
  pages: [data.page],
  pagination: { page: 1, perPage: 25, total: 1, hasMore: false }
})
const receipt = (action = 'update_draft', extra: Record<string, unknown> = {}) => ({
  source: 'cloudflare',
  action,
  pageId: PAGE,
  pageVersion: action === 'create_draft' ? 1 : 2,
  versionId: action === 'create_draft' || action === 'archive_draft' ? VERSION : versionId(2),
  draftVersion: action === 'create_draft' || action === 'archive_draft' ? 1 : 2,
  slug: 'guia-editorial',
  status: action === 'archive_draft' ? 'hidden' : 'draft',
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
const Alert = defineComponent({
  props: { title: String, description: String },
  setup: (props) => () => h('div', [props.title, props.description])
})
// Calendar DTO/HTTP interactions are covered by its own actual component suite.
// This stub isolates the editor's navigation and unsaved-command boundary.
const Calendar = defineComponent({
  name: 'CmsEditorialCalendar',
  props: { canSelect: Boolean },
  emits: ['selectPage'],
  setup:
    (props, { emit }) =>
    () =>
      h(
        'button',
        { 'data-editor-calendar': '', disabled: !props.canSelect, onClick: () => emit('selectPage', ACTOR) },
        'Open calendar page'
      )
})
const mounted: Array<{ unmount: () => void }> = []
let current = detail(),
  listResponse: unknown,
  listFailure = false,
  detailFailure = false
beforeEach(() => {
  requestMock.mockReset()
  current = detail()
  listResponse = list()
  listFailure = false
  detailFailure = false
  requestMock.mockImplementation(async (path: string, options?: { method?: string; body?: string }) => {
    if (options?.method === 'GET' && path.endsWith('/publication'))
      return {
        source: 'cloudflare',
        pageId: PAGE,
        pageVersion: current.page.pageVersion,
        draftVersionId: current.draft.id,
        revision: 0,
        publication: null,
        schedule: null,
        capabilities: { publish: false, withdraw: false, schedule: false, preview: false, revokePreview: false },
        previews: []
      }
    if (!options?.method) {
      if (path === ROOT) {
        if (listFailure) throw new Error('list-down')
        return listResponse
      }
      if (detailFailure) throw new Error('detail-down')
      return current
    }
    const action = path.endsWith('/rollback')
      ? 'restore_draft'
      : options.method === 'PUT'
        ? 'update_draft'
        : options.method === 'DELETE'
          ? 'archive_draft'
          : 'create_draft'
    current = action === 'archive_draft' ? detail(1, 'hidden') : detail(action === 'create_draft' ? 1 : 2)
    listResponse = list(current)
    return receipt(action)
  })
})
afterEach(() => {
  mounted.splice(0).forEach((wrapper) => wrapper.unmount())
  vi.restoreAllMocks()
})
async function render(runtime = 'cloudflare', actor = ACTOR, allowed = true) {
  const runtimeRef = ref(runtime),
    operatorId = ref(actor),
    authority = ref(allowed),
    authorize = vi.fn(() => authority.value)
  const Host = defineComponent({
    setup: () => () => h(CmsDraftEditor, { runtime: runtimeRef.value, operatorId: operatorId.value, authorize })
  })
  const wrapper = await mountSuspended(Host, {
    global: { stubs: { UButton: Button, UAlert: Alert, CmsEditorialCalendar: Calendar } }
  })
  mounted.push(wrapper)
  await flushPromises()
  const editor = wrapper.findComponent(CmsDraftEditor)
  async function invoke(name: string, ...args: unknown[]) {
    const raw: unknown = Object.getOwnPropertyDescriptor(editor.vm.$, 'setupState')?.value
    if (!raw || typeof raw !== 'object') throw new Error('Missing editor state')
    const state = proxyRefs(raw as Record<string, unknown>),
      action = state[name]
    if (typeof action !== 'function') throw new Error(`Missing action ${name}`)
    await action(...args)
    await flushPromises()
  }
  return { wrapper, editor, runtimeRef, operatorId, authority, authorize, invoke }
}
type Render = Awaited<ReturnType<typeof render>>
async function select(result: Render) {
  await result.wrapper.get(`[data-cms-select="${PAGE}"]`).trigger('click')
  await flushPromises()
}
async function prepare(result: Render, action = 'update_draft') {
  if (action === 'create_draft') {
    await result.wrapper.get('[data-cms-create]').trigger('click')
    await result.wrapper.get('[data-cms-title]').setValue('Guía editorial')
    await result.wrapper.get('[data-cms-slug]').setValue('guia-editorial')
    await result.wrapper.get('[data-cms-seo-title]').setValue('Guía editorial')
    await result.wrapper.get('[data-cms-seo-description]').setValue('Descripción editorial privada.')
  } else {
    await select(result)
    if (action === 'restore_draft') await result.wrapper.get(`[data-cms-restore="${VERSION}"]`).trigger('click')
    else
      await result.wrapper.get(action === 'archive_draft' ? '[data-cms-archive]' : '[data-cms-edit]').trigger('click')
    if (action === 'archive_draft') await result.wrapper.get('[data-cms-archive-confirm]').setValue(true)
  }
  await result.wrapper.get('[data-cms-reason]').setValue('Cambio editorial explícito')
}
const writes = () => requestMock.mock.calls.filter((call) => ['POST', 'PUT', 'DELETE'].includes(call[1]?.method))
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('Cloudflare CMS UI uses confirmed snapshots and never publishes', () => {
  it('creates a typed promotional document visually without entering block JSON or publishing', async () => {
    const result = await render()
    await prepare(result, 'create_draft')
    await result.wrapper.get('[data-cms-promo-enabled]').setValue(true)
    await result.wrapper.get('[data-cms-promo-format]').setValue('banner')
    await result.wrapper.get('[data-cms-promo-placement="home"]').setValue(true)
    await result.wrapper.get('[data-cms-promo-heading]').setValue('Información editorial revisada')
    await result.wrapper.get('[data-cms-promo-text]').setValue('Consulta las condiciones operativas vigentes.')
    await result.wrapper.get('[data-cms-promo-cta-label]').setValue('Condiciones de envío')
    await result.wrapper.get('[data-cms-promo-cta-href]').setValue('/envios')
    expect(result.wrapper.find('[data-cms-blocks]').exists()).toBe(false)
    await result.wrapper.get('form').trigger('submit')
    await vi.waitFor(() => expect(writes()).toHaveLength(1))
    const body = JSON.parse(writes()[0]![1].body)
    expect(body.promotional).toEqual({
      format: 'banner',
      placements: ['home'],
      priority: 0,
      paths: [],
      categorySlugs: [],
      productSlugs: []
    })
    expect(body.blocks.map((block: { type: string }) => block.type)).toEqual(['heading', 'paragraph', 'cta'])
    expect(body.blocks.at(-1)).toMatchObject({ label: 'Condiciones de envío', href: '/envios' })
    expect(writes()[0]![0]).toBe(ROOT)
  })
  it('requires explicit placement and rejects an unsafe promotional CTA without any write', async () => {
    const result = await render()
    await prepare(result, 'create_draft')
    await result.wrapper.get('[data-cms-promo-enabled]').setValue(true)
    await result.wrapper.get('[data-cms-promo-text]').setValue('Contenido editorial')
    expect(result.wrapper.get('[data-cms-submit]').attributes('disabled')).toBeDefined()
    await result.wrapper.get('[data-cms-promo-placement="home"]').setValue(true)
    await result.wrapper.get('[data-cms-promo-cta-label]').setValue('Destino')
    await result.wrapper.get('[data-cms-promo-cta-href]').setValue('javascript:alert(1)')
    expect(result.wrapper.get('[data-cms-submit]').attributes('disabled')).toBeDefined()
    expect(writes()).toHaveLength(0)
  })
  it('restores promotional metadata into visual controls and preserves ordinary block editing', async () => {
    const data = detail()
    const documentWithPromo = {
      ...data.draft.document,
      promotional: {
        format: 'card',
        placements: ['product'],
        priority: 7,
        paths: [],
        categorySlugs: [],
        productSlugs: ['limpiador']
      }
    }
    current = {
      ...data,
      draft: { ...data.draft, document: documentWithPromo },
      history: { ...data.history, versions: [{ ...data.history.versions[0]!, document: documentWithPromo }] }
    }
    const result = await render()
    await prepare(result)
    expect(result.wrapper.get<HTMLInputElement>('[data-cms-promo-enabled]').element.checked).toBe(true)
    expect(result.wrapper.get<HTMLSelectElement>('[data-cms-promo-format]').element.value).toBe('card')
    expect(result.wrapper.get('[data-cms-promo-products]').element).toHaveProperty('value', 'limpiador')
    await result.wrapper.get('[data-cms-promo-enabled]').setValue(false)
    expect(result.wrapper.find('[data-cms-blocks]').exists()).toBe(true)
  })
  it.each(['create_draft', 'update_draft'])(
    'requires explicit help metadata for %s without default dates or categories',
    async (action) => {
      const result = await render()
      await prepare(result, action)
      expect(result.wrapper.get<HTMLInputElement>('[data-cms-help-enabled]').element.checked).toBe(false)
      await result.wrapper.get('[data-cms-help-enabled]').setValue(true)
      expect(result.wrapper.get<HTMLSelectElement>('[data-cms-help-category]').element.value).toBe('')
      expect(result.wrapper.get<HTMLInputElement>('[data-cms-help-review]').element.value).toBe('')
      expect(result.wrapper.get('[data-cms-submit]').attributes('disabled')).toBeDefined()
      await result.wrapper.get('[data-cms-help-category]').setValue('envios')
      await result.wrapper.get('[data-cms-help-review]').setValue('2026-02-30T10:00:00Z')
      expect(result.wrapper.get('[data-cms-submit]').attributes('disabled')).toBeDefined()
      await result.wrapper.get('[data-cms-help-review]').setValue('2027-03-01T10:00:00Z')
      await result.wrapper.get('form').trigger('submit')
      await flushPromises()
      expect(writes()).toHaveLength(1)
      expect(JSON.parse(writes()[0]![1].body).supportKnowledge).toEqual({
        category: 'envios',
        reviewDueAt: '2027-03-01T10:00:00Z'
      })
    }
  )
  it('preserves confirmed help metadata when editing and permits explicit opt-out without another authoring flow', async () => {
    const metadata = { category: 'pagos', reviewDueAt: '2027-03-01T10:00:00Z' }
    Object.assign(current.draft.document, { supportKnowledge: metadata })
    const result = await render()
    await prepare(result)
    expect(result.wrapper.get<HTMLInputElement>('[data-cms-help-enabled]').element.checked).toBe(true)
    expect(result.wrapper.get<HTMLSelectElement>('[data-cms-help-category]').element.value).toBe('pagos')
    expect(result.wrapper.get<HTMLInputElement>('[data-cms-help-review]').element.value).toBe(metadata.reviewDueAt)
    await result.wrapper.get('[data-cms-help-enabled]').setValue(false)
    await result.wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(writes()).toHaveLength(1)
    expect(JSON.parse(writes()[0]![1].body)).not.toHaveProperty('supportKnowledge')
  })
  it('keeps confirmed help metadata when saving an unrelated editorial change', async () => {
    const metadata = { category: 'pagos', reviewDueAt: '2027-03-01T10:00:00Z' }
    Object.assign(current.draft.document, { supportKnowledge: metadata })
    const result = await render()
    await prepare(result)
    await result.wrapper.get('[data-cms-seo-title]').setValue('Título editorial revisado')
    await result.wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(writes()).toHaveLength(1)
    expect(JSON.parse(writes()[0]![1].body).supportKnowledge).toEqual(metadata)
  })
  it('restores help metadata from the exact historical revision without rewriting the rollback contract', async () => {
    Object.assign(current.history.versions[0]!.document, {
      supportKnowledge: { category: 'facturas', reviewDueAt: '2027-03-01T10:00:00Z' }
    })
    const result = await render()
    await prepare(result, 'restore_draft')
    expect(result.wrapper.get('[data-cms-help-restore]').text()).toContain('facturas')
    expect(result.wrapper.get('[data-cms-help-restore]').text()).toContain('2027-03-01T10:00:00Z')
    expect(result.wrapper.find('[data-cms-help-enabled]').exists()).toBe(false)
    await result.wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(JSON.parse(writes()[0]![1].body)).toEqual({
      expectedVersion: 1,
      versionId: VERSION,
      reason: 'Cambio editorial explícito'
    })
  })
  it('freezes help metadata with the idempotent payload after an ambiguous save', async () => {
    Object.assign(current.draft.document, {
      supportKnowledge: { category: 'pagos', reviewDueAt: '2027-03-01T10:00:00Z' }
    })
    const result = await render()
    await prepare(result)
    const original = requestMock.getMockImplementation()!
    let attempts = 0
    requestMock.mockImplementation(async (path: string, options?: { method?: string }) => {
      if (options?.method) {
        if (++attempts === 1) throw new Error('connection-lost')
        return receipt()
      }
      return original(path, options)
    })
    await result.invoke('submit')
    expect(result.wrapper.text()).toContain('Puede haberse guardado')
    await result.wrapper.get('[data-cms-detail-read]').trigger('click')
    await flushPromises()
    expect(result.wrapper.get('fieldset').attributes('disabled')).toBeDefined()
    await result.wrapper.get('[data-cms-help-category]').setValue('envios')
    await result.wrapper.get('[data-cms-retry]').trigger('click')
    await flushPromises()
    expect(writes()).toHaveLength(2)
    expect(writes()[1]![1].body).toBe(writes()[0]![1].body)
    expect(JSON.parse(writes()[1]![1].body).supportKnowledge).toEqual({
      category: 'pagos',
      reviewDueAt: '2027-03-01T10:00:00Z'
    })
    expect(writes()[1]![1].headers['Idempotency-Key']).toBe(writes()[0]![1].headers['Idempotency-Key'])
  })
  it('calendar can select a page outside the current list only through a fresh exact detail read', async () => {
    listResponse = { ...list(), capabilities: { ...caps(), contentSchedule: true } }
    const result = await render()
    const calendarPage = detail()
    calendarPage.page.id = ACTOR
    calendarPage.draft.pageId = ACTOR
    calendarPage.history.versions.forEach((version) => {
      version.pageId = ACTOR
    })
    requestMock.mockResolvedValue(calendarPage)
    const before = requestMock.mock.calls.length
    await result.invoke('loadDetail', ACTOR)
    expect(requestMock).toHaveBeenCalledTimes(before)
    await result.wrapper.get('[data-editor-calendar]').trigger('click')
    await flushPromises()
    expect(requestMock.mock.calls.some((call) => call[0] === `${ROOT}/${ACTOR}` && !call[1]?.method)).toBe(true)
    expect(result.wrapper.find('[data-cms-edit]').exists()).toBe(true)
    expect(writes()).toHaveLength(0)
  })
  it('calendar event cannot discard an unsaved editor form even if a child emits directly', async () => {
    listResponse = { ...list(), capabilities: { ...caps(), contentSchedule: true } }
    const result = await render()
    await prepare(result)
    await result.wrapper.get('[data-cms-title]').setValue('Unsaved title preserved')
    const before = requestMock.mock.calls.length
    expect(result.wrapper.get('[data-editor-calendar]').attributes('disabled')).toBeDefined()
    result.wrapper.findComponent(Calendar).vm.$emit('selectPage', ACTOR)
    await flushPromises()
    expect(requestMock).toHaveBeenCalledTimes(before)
    expect(result.wrapper.get<HTMLInputElement>('[data-cms-title]').element.value).toBe('Unsaved title preserved')
    expect(writes()).toHaveLength(0)
  })
  it('reads the private list and exposes exact publication gaps without a public action', async () => {
    const result = await render()
    expect(result.wrapper.text()).toContain('Borrador y publicación son independientes')
    expect(result.wrapper.find('[data-cms-create]').exists()).toBe(true)
    expect(result.wrapper.find('[data-cms-publish],[data-cms-preview],[data-cms-schedule]').exists()).toBe(false)
    expect(writes()).toHaveLength(0)
  })
  it.each(['node', 'Cloudflare', 'unknown', ''])('never calls the Node writer for runtime %j', async (runtime) => {
    const result = await render(runtime)
    await result.invoke('begin', 'create_draft')
    await result.invoke('submit')
    await result.invoke('loadList')
    expect(requestMock).not.toHaveBeenCalled()
    expect(result.wrapper.find('form').exists()).toBe(false)
  })
  it.each(['actor', 'authority'])('requires current %s before any reads or forms', async (shape) => {
    const result = await render('cloudflare', shape === 'actor' ? 'not-uuid' : ACTOR, shape !== 'authority')
    await result.invoke('begin', 'create_draft')
    await result.invoke('submit')
    expect(requestMock).not.toHaveBeenCalled()
    expect(result.wrapper.find('form').exists()).toBe(false)
  })
  it('shows a read failure instead of treating it as empty and retries only GET', async () => {
    listFailure = true
    const result = await render()
    expect(result.wrapper.text()).toContain('Esto no significa que no existan páginas')
    expect(result.wrapper.text()).not.toContain('Todavía no hay páginas')
    expect(result.wrapper.find('[data-cms-create]').exists()).toBe(false)
    listFailure = false
    await result.wrapper.get('[data-cms-read]').trigger('click')
    await flushPromises()
    expect(result.wrapper.find('[data-cms-create]').exists()).toBe(true)
    expect(writes()).toHaveLength(0)
  })
  it('shows empty only after a confirmed zero-total DTO', async () => {
    listResponse = { ...list(), pages: [], pagination: { page: 1, perPage: 25, total: 0, hasMore: false } }
    const result = await render()
    expect(result.wrapper.text()).toContain('Todavía no hay páginas')
    expect(result.wrapper.find('[data-cms-create]').exists()).toBe(true)
  })
  it.each(['source', 'unknown', 'missing-cap', 'duplicate', 'pagination', 'getter', 'array-getter'])(
    'blocks malformed list %s without evaluating accessors',
    async (shape) => {
      const data = list(),
        getter = vi.fn(() => 'cloudflare')
      if (shape === 'source') data.source = 'node'
      if (shape === 'unknown') Object.assign(data, { extra: true })
      if (shape === 'missing-cap') Reflect.deleteProperty(data.capabilities, 'contentCreate')
      if (shape === 'duplicate') data.pages.push(data.pages[0]!)
      if (shape === 'pagination') data.pagination.total = 2
      if (shape === 'getter') Object.defineProperty(data, 'source', { enumerable: true, get: getter })
      if (shape === 'array-getter') Object.defineProperty(data.pages, '0', { enumerable: true, get: getter })
      listResponse = data
      const result = await render()
      expect(result.wrapper.find('[data-cms-create],[data-cms-select],form').exists()).toBe(false)
      expect(getter).not.toHaveBeenCalled()
      expect(writes()).toHaveLength(0)
    }
  )
  it.each(['identity', 'draft', 'history', 'getter', 'source'])(
    'blocks malformed detail %s and provides a read recovery',
    async (shape) => {
      const result = await render(),
        getter = vi.fn(() => PAGE)
      if (shape === 'identity') current.page.id = ACTOR
      if (shape === 'draft') current.page.draftVersionId = ACTOR
      if (shape === 'history') current.history.versions = []
      if (shape === 'getter') Object.defineProperty(current.page, 'id', { enumerable: true, get: getter })
      if (shape === 'source') current.source = 'node'
      await select(result)
      expect(result.wrapper.find('[data-cms-edit],form').exists()).toBe(false)
      expect(getter).not.toHaveBeenCalled()
      expect(writes()).toHaveLength(0)
    }
  )
  it.each(['create_draft', 'update_draft', 'restore_draft', 'archive_draft'])(
    'confirms %s only after preflight, exact receipt and fresh GET',
    async (action) => {
      const result = await render()
      await prepare(result, action)
      await result.wrapper.get('form').trigger('submit')
      await flushPromises()
      expect(writes()).toHaveLength(1)
      const [path, options] = writes()[0]!
      expect(path).toBe(
        action === 'create_draft' ? ROOT : `${ROOT}/${PAGE}${action === 'restore_draft' ? '/rollback' : ''}`
      )
      expect(options.retry).toBe(0)
      expect(typeof options.body).toBe('string')
      expect(JSON.parse(options.body).expectedVersion).toBe(action === 'create_draft' ? 0 : 1)
      expect(result.wrapper.text()).toContain(
        action === 'archive_draft'
          ? 'Archivo confirmado'
          : action === 'restore_draft'
            ? 'Restauración confirmada'
            : 'Nueva versión de borrador confirmada'
      )
      expect(result.wrapper.find('[data-cms-retry]').exists()).toBe(false)
      expect(result.wrapper.text()).not.toContain('Versión publicada')
    }
  )
  it('requires contextual archive checkbox and reason before submitting', async () => {
    const result = await render()
    await select(result)
    await result.wrapper.get('[data-cms-archive]').trigger('click')
    await result.wrapper.get('[data-cms-reason]').setValue('Archivo editorial explícito')
    await result.invoke('submit')
    expect(writes()).toHaveLength(0)
    await result.wrapper.get('[data-cms-archive-confirm]').setValue(true)
    await result.invoke('submit')
    expect(writes()).toHaveLength(1)
  })
  it('does not infer restore or archive authority from a writable draft', async () => {
    current.capabilities.contentRestore = false
    current.capabilities.contentArchive = false
    const result = await render()
    await select(result)
    expect(result.wrapper.find('[data-cms-edit]').exists()).toBe(true)
    expect(result.wrapper.find('[data-cms-restore],[data-cms-archive]').exists()).toBe(false)
    await result.invoke('begin', 'archive_draft')
    await result.invoke('begin', 'restore_draft', VERSION)
    await result.invoke('submit')
    expect(writes()).toHaveLength(0)
  })
  it('rejects unsafe or duplicate typed blocks and preserves the editable buffer', async () => {
    const result = await render()
    await prepare(result)
    await result.wrapper
      .get('[data-cms-blocks]')
      .setValue(JSON.stringify([{ id: BLOCK, type: 'cta', label: 'Ir', href: '//hostile.invalid' }]))
    await result.invoke('submit')
    expect(writes()).toHaveLength(0)
    expect(result.wrapper.get('[data-cms-blocks]').element).toHaveProperty(
      'value',
      expect.stringContaining('hostile.invalid')
    )
    await result.wrapper.get('[data-cms-blocks]').setValue(JSON.stringify([...document().blocks, ...document().blocks]))
    await result.invoke('submit')
    expect(writes()).toHaveLength(0)
  })
  it('refreshes authority before POST and cancels a changed CAS without sending', async () => {
    const result = await render()
    await prepare(result)
    current = detail(2)
    await result.invoke('submit')
    expect(writes()).toHaveLength(0)
    expect(result.wrapper.text()).toContain('El borrador ha cambiado')
  })
  it('does not send when fresh capabilities revoke write permission', async () => {
    const result = await render()
    await prepare(result)
    current.capabilities.contentUpdate = false
    await result.invoke('submit')
    expect(writes()).toHaveLength(0)
    expect(result.wrapper.text()).toContain('No se ha enviado')
  })
  it('blocks double submission while the first POST is in flight', async () => {
    const result = await render()
    await prepare(result)
    const delayed = deferred<unknown>(),
      defaultRequest = requestMock.getMockImplementation()!
    requestMock.mockImplementation((path: string, options?: { method?: string }) =>
      options?.method ? delayed.promise : defaultRequest(path, options)
    )
    await result.wrapper.get('form').trigger('submit')
    await flushPromises()
    await result.invoke('submit')
    expect(writes()).toHaveLength(1)
    current = detail(2)
    delayed.resolve(receipt())
    await flushPromises()
  })
  it('keeps the original key and payload after ambiguity and manually replays even with an advanced draft', async () => {
    const result = await render()
    await prepare(result)
    const defaultRequest = requestMock.getMockImplementation()!
    let attempts = 0
    requestMock.mockImplementation(async (path: string, options?: { method?: string }) => {
      if (options?.method) {
        attempts++
        if (attempts === 1) {
          current = detail(2)
          throw new Error('connection-lost')
        }
        return receipt()
      }
      return defaultRequest(path, options)
    })
    await result.invoke('submit')
    expect(result.wrapper.text()).toContain('Puede haberse guardado')
    expect(result.wrapper.find('[data-cms-retry]').exists()).toBe(true)
    await result.wrapper.get('[data-cms-detail-read]').trigger('click')
    await flushPromises()
    await result.wrapper.get('[data-cms-retry]').trigger('click')
    await flushPromises()
    expect(writes()).toHaveLength(2)
    expect(writes()[1]![1].body).toBe(writes()[0]![1].body)
    expect(writes()[1]![1].headers['Idempotency-Key']).toBe(writes()[0]![1].headers['Idempotency-Key'])
    expect(result.wrapper.text()).toContain('Nueva versión de borrador confirmada')
  })
  it.each(['wrong-action', 'wrong-page', 'wrong-version', 'wrong-slug', 'wrong-status', 'getter'])(
    'never reports success for a malformed receipt %s',
    async (shape) => {
      const result = await render()
      await prepare(result)
      const bad = receipt(),
        getter = vi.fn(() => 'cloudflare')
      if (shape === 'wrong-action') bad.action = 'create_draft'
      if (shape === 'wrong-page') bad.pageId = ACTOR
      if (shape === 'wrong-version') bad.pageVersion = 3
      if (shape === 'wrong-slug') bad.slug = 'otra'
      if (shape === 'wrong-status') bad.status = 'hidden'
      if (shape === 'getter') Object.defineProperty(bad, 'source', { enumerable: true, get: getter })
      const defaultRequest = requestMock.getMockImplementation()!
      requestMock.mockImplementation((path: string, options?: { method?: string }) =>
        options?.method ? Promise.resolve(bad) : defaultRequest(path, options)
      )
      await result.invoke('submit')
      expect(result.wrapper.text()).not.toContain('Nueva versión de borrador confirmada')
      expect(result.wrapper.find('[data-cms-retry]').exists()).toBe(true)
      expect(getter).not.toHaveBeenCalled()
    }
  )
  it('distinguishes a historical receipt from a failed refresh and retains the exact recovery attempt', async () => {
    const result = await render()
    await prepare(result)
    const defaultRequest = requestMock.getMockImplementation()!
    requestMock.mockImplementation(async (path: string, options?: { method?: string }) => {
      if (options?.method) {
        detailFailure = true
        return receipt()
      }
      return defaultRequest(path, options)
    })
    await result.invoke('submit')
    expect(result.wrapper.text()).toContain('Hay un recibo histórico')
    expect(result.wrapper.text()).not.toContain('Nueva versión de borrador confirmada')
    expect(result.wrapper.find('[data-cms-retry]').exists()).toBe(true)
  })
  it.each(['actor', 'authority', 'runtime', 'unmount'])('ignores late POST success after %s changes', async (shape) => {
    const result = await render()
    await prepare(result)
    const delayed = deferred<unknown>(),
      defaultRequest = requestMock.getMockImplementation()!
    requestMock.mockImplementation((path: string, options?: { method?: string }) =>
      options?.method ? delayed.promise : defaultRequest(path, options)
    )
    await result.wrapper.get('form').trigger('submit')
    await flushPromises()
    if (shape === 'actor') result.operatorId.value = PAGE
    if (shape === 'authority') result.authority.value = false
    if (shape === 'runtime') result.runtimeRef.value = 'node'
    if (shape === 'unmount') result.wrapper.unmount()
    await flushPromises()
    delayed.resolve(receipt())
    await flushPromises()
    if (shape !== 'unmount') expect(result.wrapper.text()).not.toContain('Nueva versión de borrador confirmada')
    expect(writes()).toHaveLength(1)
  })
})
