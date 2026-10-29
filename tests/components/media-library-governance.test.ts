import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises, type DOMWrapper } from '@vue/test-utils'
import { defineComponent, h, ref, type PropType } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import MediaLibraryPage from '../../app/pages/admin/medios.vue'
import '#app/nuxt-vitest-app-entry'

const { fetchMock, mutationMock, toastMock, runtimeMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  mutationMock: vi.fn(),
  toastMock: vi.fn(),
  runtimeMock: vi.fn(() => ({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'cloudflare', baseUrl: 'https://neteco.invalid' }
  }))
}))
mockNuxtImport('useFetch', () => fetchMock)
mockNuxtImport('$fetch', () => mutationMock)
mockNuxtImport('useToast', () => () => ({ add: toastMock }))
mockNuxtImport('useRuntimeConfig', () => runtimeMock)
mockNuxtImport('useUserSession', () => () => ({
  ready: ref(true),
  loggedIn: ref(true),
  user: ref({ id: 'synthetic-admin', role: 'admin', mfaVerified: true }),
  session: ref(null),
  clear: async () => undefined,
  openInPopup: () => undefined,
  fetch: async () => undefined
}))

interface Publication {
  id: string
  title: string
  role: string
  version: string
  status: 'active' | 'withdrawn'
  publicationVersion: number
}
interface Asset {
  id: string
  originalName: string
  mimeType: string
  bytes: number
  width: number | null
  height: number | null
  ownerName: string | null
  license: string | null
  authorizedAt: string | null
  rightsStatus: string
  quarantineStatus: string
  altText: string | null
  sourceUrl: string | null
  createdAt: string
  canApprove?: boolean
  rightsVersion?: number
  canPublish?: boolean
  publications?: Publication[]
}
type Capabilities = { canUpload?: unknown; canApprove?: unknown; canPublish?: unknown }
interface Library {
  items: Asset[]
  capabilities?: Capabilities
}
const ALL_CAPABILITIES = { canUpload: true, canApprove: true, canPublish: true }
const asset = (overrides: Partial<Asset> = {}): Asset => ({
  id: '11111111-1111-4111-8111-111111111111',
  originalName: 'Foto autorizada.png',
  mimeType: 'image/png',
  bytes: 24000,
  width: 600,
  height: 400,
  ownerName: 'Proveedor de prueba',
  license: 'Cesión para catálogo',
  authorizedAt: '2026-08-01T00:00:00Z',
  rightsStatus: 'pending',
  quarantineStatus: 'pending',
  altText: 'Caja de producto de prueba',
  sourceUrl: null,
  createdAt: '2026-08-12T12:00:00Z',
  canApprove: true,
  rightsVersion: 4,
  canPublish: false,
  publications: [],
  ...overrides
})
const publication = (overrides: Partial<Publication> = {}): Publication => ({
  id: '22222222-2222-4222-8222-222222222222',
  title: 'Imagen principal del producto',
  role: 'main',
  version: '2026.1',
  status: 'active',
  publicationVersion: 1,
  ...overrides
})

// Render the real page's event handlers and slots. Only visual primitives and the
// separately tested publication dialog are stubbed; disabled/loading buttons
// retain their native interaction boundary.
const Slot = defineComponent({
  setup(_, { slots }) {
    return () => h('section', [slots.default?.(), slots.actions?.()])
  }
})
const Alert = defineComponent({
  props: { title: String, description: String },
  setup(props) {
    return () => h('aside', [h('strong', props.title), h('p', props.description)])
  }
})
const Button = defineComponent({
  inheritAttrs: false,
  props: { disabled: Boolean, loading: Boolean },
  setup(props, { attrs, slots }) {
    return () =>
      h(
        'button',
        {
          ...attrs,
          type: attrs.type ?? 'button',
          disabled: props.disabled || props.loading,
          'data-loading': String(props.loading)
        },
        slots.default?.()
      )
  }
})
const modelControl = (tag: 'input' | 'textarea') =>
  defineComponent({
    inheritAttrs: false,
    props: { modelValue: String },
    emits: ['update:modelValue'],
    setup(props, { attrs, emit }) {
      return () =>
        h(tag, {
          ...attrs,
          value: props.modelValue ?? '',
          onInput: (event: Event) =>
            emit('update:modelValue', (event.target as HTMLInputElement | HTMLTextAreaElement).value)
        })
    }
  })
const FormField = defineComponent({
  props: { label: String },
  setup(props, { slots }) {
    return () => h('label', { 'data-field': props.label }, [h('span', props.label), slots.default?.()])
  }
})
const Modal = defineComponent({
  props: { open: Boolean, title: String },
  setup(props, { slots }) {
    return () =>
      props.open
        ? h('dialog', { open: true, 'data-title': props.title }, [
            h('h2', props.title),
            slots.body?.(),
            slots.footer?.()
          ])
        : null
  }
})
const Table = defineComponent({
  props: {
    rows: { type: Array as PropType<Asset[]>, default: () => [] },
    status: String,
    emptyTitle: String,
    errorMessage: String
  },
  emits: ['retry'],
  setup(props, { emit, slots }) {
    return () => {
      const content =
        props.status === 'pending'
          ? h('div', { role: 'status' }, 'Cargando biblioteca')
          : props.status === 'error'
            ? h('div', { role: 'alert' }, [
                props.errorMessage,
                h('button', { onClick: () => emit('retry') }, 'Reintentar')
              ])
            : props.rows.length
              ? props.rows.map((row) =>
                  h('article', { 'data-row': row.id }, [
                    slots['cell-originalName']?.({ row }),
                    slots['cell-ownerName']?.({ row }),
                    slots['cell-quarantineStatus']?.({ row }),
                    slots['cell-sourceUrl']?.({ row }),
                    slots['row-actions']?.({ row })
                  ])
                )
              : [h('p', props.emptyTitle), slots['empty-action']?.()]
      return h('div', { 'data-table-status': props.status }, content)
    }
  }
})
const PublicationDialog = defineComponent({
  props: { asset: { type: Object as PropType<Asset>, required: true } },
  emits: ['close', 'published'],
  setup(props, { emit }) {
    return () =>
      h('section', { 'data-publication-dialog': props.asset.id }, [
        props.asset.originalName,
        h('button', { onClick: () => emit('close') }, 'Cerrar asociación'),
        h('button', { onClick: () => emit('published') }, 'Simular asociación confirmada')
      ])
  }
})

type Page = Awaited<ReturnType<typeof mountSuspended>>
type Scope = { findAll(selector: string): DOMWrapper<Element>[] }
let wrapper: Page | undefined
async function render(
  options: { items?: Asset[]; capabilities?: Capabilities | null; status?: string; noData?: boolean } = {}
) {
  const data = ref<Library | null>(
    options.noData
      ? null
      : {
          items: options.items ?? [asset()],
          ...(options.capabilities === null ? {} : { capabilities: options.capabilities ?? ALL_CAPABILITIES })
        }
  )
  const status = ref(options.status ?? 'success')
  const refresh = vi.fn().mockResolvedValue(undefined)
  fetchMock.mockReturnValue({ data, status, error: ref(null), refresh })
  wrapper = await mountSuspended(MediaLibraryPage, {
    global: {
      stubs: {
        UiPageHeader: Slot,
        UiDataTable: Table,
        UAlert: Alert,
        UBadge: Slot,
        UButton: Button,
        UInput: modelControl('input'),
        UTextarea: modelControl('textarea'),
        UFormField: FormField,
        UModal: Modal,
        MediaPublicationDialog: PublicationDialog
      }
    }
  })
  return { page: wrapper, data, status, refresh }
}
function button(scope: Scope, text: string) {
  const found = scope.findAll('button').find((candidate) => candidate.text() === text)
  if (!found) throw new Error(`Missing button: ${text}`)
  return found
}
const dialog = (page: Page, title: string) => page.get(`dialog[data-title="${title}"]`)
const requestOptions = (index: number) => {
  const options = mutationMock.mock.calls[index]?.[1]
  if (!options) throw new Error(`Missing mutation request ${index}`)
  return options as { method: string; body: Record<string, unknown>; headers: Record<string, string> }
}
async function openRights(page: Page, decision: 'approve' | 'reject' = 'approve') {
  await button(page, decision === 'approve' ? 'Aprobar' : 'Bloquear').trigger('click')
  return dialog(page, decision === 'approve' ? 'Aprobar los derechos' : 'Bloquear el archivo')
}
async function openWithdrawal(page: Page, index = 0) {
  const target = page.findAll('button').filter((candidate) => candidate.text() === 'Retirar')[index]
  if (!target) throw new Error(`Missing withdrawal action ${index}`)
  await target.trigger('click')
  return dialog(page, 'Retirar asociación')
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((fulfil) => {
    resolve = fulfil
  })
  return { promise, resolve }
}

describe('Cloudflare media library governance', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    mutationMock.mockReset().mockResolvedValue({ ok: true })
    toastMock.mockReset()
  })
  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
  })

  it.each([
    ['missing', null],
    ['empty', {}],
    ['false', { canUpload: false, canApprove: false, canPublish: false }],
    ['non-boolean', { canUpload: 'true', canApprove: 'true', canPublish: 'true' }]
  ] satisfies Array<[string, Capabilities | null]>)(
    'fails closed for %s capabilities even when individual row flags claim authorization',
    async (_, capabilities) => {
      const { page } = await render({ capabilities, items: [asset({ canPublish: true, quarantineStatus: 'clean' })] })
      await button(page, 'Subir archivo').trigger('click')
      expect(page.find('dialog').exists()).toBe(false)
      expect(button(page, 'Subir archivo').attributes('disabled')).toBeDefined()
      expect(page.findAll('button').some((candidate) => ['Aprobar', 'Bloquear'].includes(candidate.text()))).toBe(false)
      await button(page, 'Asociar').trigger('click')
      expect(page.find('[data-publication-dialog]').exists()).toBe(false)
      expect(button(page, 'Asociar').attributes('disabled')).toBeDefined()
      expect(mutationMock).not.toHaveBeenCalled()
    }
  )

  it('does not infer publication capability from the upload or rights capability', async () => {
    const { page } = await render({
      capabilities: { canUpload: true, canApprove: true },
      items: [asset({ canPublish: true })]
    })
    await button(page, 'Asociar').trigger('click')
    expect(page.find('[data-publication-dialog]').exists()).toBe(false)
    expect(button(page, 'Asociar').attributes('disabled')).toBeDefined()
    expect(mutationMock).not.toHaveBeenCalled()
  })

  it('keeps a non-publishable row from opening any association dialog', async () => {
    const { page } = await render({ items: [asset({ rightsStatus: 'approved', canPublish: false })] })
    await button(page, 'Asociar').trigger('click')
    expect(button(page, 'Asociar').attributes('disabled')).toBeDefined()
    expect(page.find('[data-publication-dialog]').exists()).toBe(false)
    expect(mutationMock).not.toHaveBeenCalled()
  })

  it('opens an explicit association only for the selected eligible asset and can close without publishing', async () => {
    const selected = asset({ canPublish: true, rightsStatus: 'approved', quarantineStatus: 'clean' })
    const { page } = await render({ items: [selected] })
    await button(page, 'Asociar').trigger('click')
    expect(page.get('[data-publication-dialog]').attributes('data-publication-dialog')).toBe(selected.id)
    expect(mutationMock).not.toHaveBeenCalled()
    await button(page, 'Cerrar asociación').trigger('click')
    expect(page.find('[data-publication-dialog]').exists()).toBe(false)
  })

  it('hides an open association dialog immediately if the global publication capability is revoked', async () => {
    const { page, data } = await render({ items: [asset({ canPublish: true })] })
    await button(page, 'Asociar').trigger('click')
    expect(page.find('[data-publication-dialog]').exists()).toBe(true)
    data.value!.capabilities = { canPublish: false }
    await flushPromises()
    expect(page.find('[data-publication-dialog]').exists()).toBe(false)
    expect(button(page, 'Asociar').attributes('disabled')).toBeDefined()
    expect(mutationMock).not.toHaveBeenCalled()
  })

  it.each(['blocked', 'rejected'])('renders %s rights as Bloqueado rather than a raw status', async (rightsStatus) => {
    const { page } = await render({ items: [asset({ rightsStatus, canApprove: false })] })
    expect(page.get('[data-row]').text()).toContain('Bloqueado')
    expect(page.get('[data-row]').text()).not.toContain(rightsStatus)
    expect(page.findAll('button').some((candidate) => candidate.text() === 'Bloquear')).toBe(false)
  })

  it('can block previously approved rights without deleting the upload or publication', async () => {
    const upload = asset({ rightsStatus: 'approved', publications: [publication()] })
    const { page, refresh } = await render({ items: [upload] })
    expect(page.findAll('button').some((candidate) => candidate.text() === 'Aprobar')).toBe(false)
    const review = await openRights(page, 'reject')
    await review.get('textarea').setValue('El titular revoca su autorización')
    await button(review, 'Bloquear').trigger('click')
    await flushPromises()
    expect(mutationMock).toHaveBeenCalledTimes(1)
    expect(mutationMock).toHaveBeenCalledWith(`/api/admin/media/${upload.id}`, {
      method: 'PUT',
      body: { decision: 'reject', reason: 'El titular revoca su autorización' },
      headers: { 'Idempotency-Key': expect.any(String), 'If-Match': '4' }
    })
    expect(refresh).toHaveBeenCalledOnce()
    expect(upload.publications).toEqual([publication()])
  })

  it('approves rights independently of a pending scan and does not automatically publish or associate', async () => {
    const { page, refresh } = await render({ items: [asset({ quarantineStatus: 'pending', canApprove: true })] })
    const review = await openRights(page)
    expect(review.text()).toContain('Aprobar los derechos no publica el archivo')
    await review.get('textarea').setValue('Contrato de cesión verificado')
    await button(review, 'Aprobar').trigger('click')
    await flushPromises()
    expect(mutationMock).toHaveBeenCalledTimes(1)
    expect(requestOptions(0).method).toBe('PUT')
    expect(requestOptions(0).body).toEqual({ decision: 'approve', reason: 'Contrato de cesión verificado' })
    expect(page.find('dialog').exists()).toBe(false)
    expect(page.find('[data-publication-dialog]').exists()).toBe(false)
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Derechos aprobados; la publicación es independiente' })
    )
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('honors a negative per-asset rights capability even when scan and global permissions allow review', async () => {
    const { page } = await render({ items: [asset({ canApprove: false, quarantineStatus: 'clean' })] })
    await button(page, 'Aprobar').trigger('click')
    expect(button(page, 'Aprobar').attributes('disabled')).toBeDefined()
    expect(page.find('dialog[data-title="Aprobar los derechos"]').exists()).toBe(false)
    expect(mutationMock).not.toHaveBeenCalled()
  })

  it('requires a trimmed reason of at least three characters before a rights mutation', async () => {
    const { page } = await render()
    const review = await openRights(page)
    await review.get('textarea').setValue('  ab  ')
    await button(review, 'Aprobar').trigger('click')
    expect(button(review, 'Aprobar').attributes('disabled')).toBeDefined()
    expect(mutationMock).not.toHaveBeenCalled()
  })

  it('reuses rights Idempotency-Key and If-Match on exact retries but changes the key for a different reason', async () => {
    mutationMock.mockRejectedValueOnce({ data: { statusMessage: 'Respuesta perdida' } })
    mutationMock.mockRejectedValueOnce({ data: { statusMessage: 'Respuesta perdida otra vez' } })
    const { page, refresh } = await render()
    const review = await openRights(page)
    await review.get('textarea').setValue('  Contrato verificado  ')
    await button(review, 'Aprobar').trigger('click')
    await flushPromises()
    expect(page.find('dialog').exists()).toBe(true)
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ color: 'error' }))
    expect(refresh).not.toHaveBeenCalled()
    await review.get('textarea').setValue('Contrato verificado')
    await button(review, 'Aprobar').trigger('click')
    await flushPromises()
    expect(requestOptions(1)).toEqual(requestOptions(0))
    expect(requestOptions(0).headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/i)
    expect(requestOptions(0).headers['If-Match']).toBe('4')
    await review.get('textarea').setValue('Contrato y referencia revisados')
    await button(review, 'Aprobar').trigger('click')
    await flushPromises()
    expect(requestOptions(2).headers['Idempotency-Key']).not.toBe(requestOptions(0).headers['Idempotency-Key'])
    expect(requestOptions(2).headers['If-Match']).toBe('4')
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('does not reuse a rights command key when the optimistic rights version changes', async () => {
    mutationMock.mockRejectedValueOnce({ data: { statusMessage: 'Versión obsoleta' } })
    const { page, data } = await render()
    const review = await openRights(page)
    await review.get('textarea').setValue('Contrato revisado')
    await button(review, 'Aprobar').trigger('click')
    await flushPromises()
    data.value!.items[0]!.rightsVersion = 5
    await button(review, 'Aprobar').trigger('click')
    await flushPromises()
    expect(requestOptions(1).headers['If-Match']).toBe('5')
    expect(requestOptions(1).headers['Idempotency-Key']).not.toBe(requestOptions(0).headers['Idempotency-Key'])
  })

  it('rechecks rights capability after a review dialog has opened', async () => {
    const { page, data } = await render()
    const review = await openRights(page)
    await review.get('textarea').setValue('Contrato revisado')
    data.value!.capabilities = {}
    await button(review, 'Aprobar').trigger('click')
    await flushPromises()
    expect(mutationMock).not.toHaveBeenCalled()
    expect(page.find('dialog[data-title="Aprobar los derechos"]').exists()).toBe(true)
  })

  it('exposes rights saving state and prevents duplicate submission while awaiting the response', async () => {
    const pending = deferred<{ ok: boolean }>()
    mutationMock.mockReturnValueOnce(pending.promise)
    const { page } = await render()
    const review = await openRights(page)
    await review.get('textarea').setValue('Contrato revisado')
    await button(review, 'Aprobar').trigger('click')
    expect(button(review, 'Aprobar').attributes('data-loading')).toBe('true')
    await button(review, 'Aprobar').trigger('click')
    expect(mutationMock).toHaveBeenCalledTimes(1)
    pending.resolve({ ok: true })
    await flushPromises()
    expect(page.find('dialog[data-title="Aprobar los derechos"]').exists()).toBe(false)
  })

  it('rechecks upload capability after opening the upload form instead of trusting the initial permission', async () => {
    const { page, data } = await render()
    await button(page, 'Subir archivo').trigger('click')
    const upload = dialog(page, 'Subir archivo')
    const input = upload.get('input[type="file"]')
    Object.defineProperty(input.element, 'files', {
      value: [new File(['fixture'], 'fixture.png', { type: 'image/png' })]
    })
    await input.trigger('change')
    data.value!.capabilities = {}
    await upload.get('form').trigger('submit')
    await flushPromises()
    expect(mutationMock).not.toHaveBeenCalled()
  })

  it('uploads an authorization declaration to quarantine without deciding rights or creating publications', async () => {
    mutationMock.mockResolvedValueOnce({ quarantineStatus: 'pending' })
    const { page, refresh } = await render()
    await button(page, 'Subir archivo').trigger('click')
    const upload = dialog(page, 'Subir archivo')
    const input = upload.get('input[type="file"]')
    Object.defineProperty(input.element, 'files', {
      value: [new File(['fixture'], 'fixture.png', { type: 'image/png' })]
    })
    await input.trigger('change')
    await upload.get('[data-field="Propietario o licenciante"] input').setValue('Proveedor de prueba')
    await upload.get('[data-field="Licencia o autorización"] input').setValue('Cesión para catálogo')
    await upload.get('[data-field="Fecha de autorización"] input').setValue('2026-08-01')
    await upload.get('[data-field="Texto alternativo"] input').setValue('Foto de producto')
    await upload.get('[data-field="Referencia de autorización"] input').setValue('  CONTRATO-123  ')
    await upload.get('form').trigger('submit')
    await flushPromises()
    expect(mutationMock).toHaveBeenCalledTimes(1)
    const [path, options] = mutationMock.mock.calls[0]!
    expect(path).toBe('/api/admin/media')
    expect(options.method).toBe('POST')
    expect(options.body).toBeInstanceOf(FormData)
    expect(options.body.get('source')).toBe('CONTRATO-123')
    expect(options.body.get('ownerName')).toBe('Proveedor de prueba')
    expect(options.body.get('file').name).toBe('fixture.png')
    expect(page.find('dialog[data-title="Subir archivo"]').exists()).toBe(false)
    expect(page.find('[data-publication-dialog]').exists()).toBe(false)
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Subido a cuarentena. No se puede publicar hasta que pase el análisis.' })
    )
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('preserves the upload form and clears loading after an upload failure so the user can retry', async () => {
    mutationMock.mockRejectedValueOnce({ data: { statusMessage: 'Subida rechazada' } })
    const { page, refresh } = await render()
    await button(page, 'Subir archivo').trigger('click')
    const upload = dialog(page, 'Subir archivo')
    const input = upload.get('input[type="file"]')
    Object.defineProperty(input.element, 'files', {
      value: [new File(['fixture'], 'fixture.png', { type: 'image/png' })]
    })
    await input.trigger('change')
    await upload.get('form').trigger('submit')
    await flushPromises()
    expect(page.find('dialog[data-title="Subir archivo"]').exists()).toBe(true)
    expect(button(upload, 'Subir').attributes('data-loading')).toBe('false')
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ color: 'error' }))
    expect(refresh).not.toHaveBeenCalled()
  })

  it('shows upload loading and prevents a second form submission until the first request finishes', async () => {
    const pending = deferred<{ quarantineStatus: string }>()
    mutationMock.mockReturnValueOnce(pending.promise)
    const { page } = await render()
    await button(page, 'Subir archivo').trigger('click')
    const upload = dialog(page, 'Subir archivo')
    const input = upload.get('input[type="file"]')
    Object.defineProperty(input.element, 'files', {
      value: [new File(['fixture'], 'fixture.png', { type: 'image/png' })]
    })
    await input.trigger('change')
    await upload.get('form').trigger('submit')
    expect(button(upload, 'Subir').attributes('data-loading')).toBe('true')
    await upload.get('form').trigger('submit')
    expect(mutationMock).toHaveBeenCalledTimes(1)
    pending.resolve({ quarantineStatus: 'pending' })
    await flushPromises()
    expect(page.find('dialog[data-title="Subir archivo"]').exists()).toBe(false)
  })

  it('withdraws only the chosen association and retains the upload, history and other associations', async () => {
    const first = publication()
    const second = publication({ id: '33333333-3333-4333-8333-333333333333', title: 'Ficha de seguridad', role: 'sds' })
    const upload = asset({ rightsStatus: 'approved', publications: [first, second] })
    const { page, data, refresh } = await render({ items: [upload] })
    refresh.mockImplementation(async () => {
      data.value = {
        capabilities: ALL_CAPABILITIES,
        items: [asset({ ...upload, publications: [{ ...first, status: 'withdrawn', publicationVersion: 2 }, second] })]
      }
    })
    const withdrawal = await openWithdrawal(page)
    expect(withdrawal.text()).toContain('sin borrar el archivo ni el historial')
    expect(withdrawal.text()).toContain('El resto de asociaciones no cambia')
    await withdrawal.get('textarea').setValue('Versión reemplazada')
    await button(withdrawal, 'Retirar asociación').trigger('click')
    await flushPromises()
    expect(mutationMock).toHaveBeenCalledTimes(1)
    expect(mutationMock).toHaveBeenCalledWith(`/api/admin/media/publications/${first.id}`, {
      method: 'DELETE',
      body: { reason: 'Versión reemplazada' },
      headers: { 'Idempotency-Key': expect.any(String), 'If-Match': '1' }
    })
    expect(data.value!.items).toHaveLength(1)
    expect(data.value!.items[0]!.id).toBe(upload.id)
    expect(data.value!.items[0]!.publications).toEqual([
      { ...first, status: 'withdrawn', publicationVersion: 2 },
      second
    ])
    expect(upload.publications).toEqual([first, second])
    expect(page.get('[data-row]').text()).toContain(upload.originalName)
    expect(page.get('[data-row]').text()).toContain('Retirada')
    expect(page.get('[data-row]').text()).toContain(second.title)
    expect(page.findAll('button').filter((candidate) => candidate.text() === 'Retirar')).toHaveLength(1)
    expect(page.find('dialog[data-title="Retirar asociación"]').exists()).toBe(false)
  })

  it('reuses withdrawal Idempotency-Key and If-Match on retries and replaces the key when the reason changes', async () => {
    mutationMock.mockRejectedValueOnce({ data: { statusMessage: 'Respuesta perdida' } })
    mutationMock.mockRejectedValueOnce({ data: { statusMessage: 'Respuesta perdida otra vez' } })
    const { page, refresh } = await render({ items: [asset({ publications: [publication()] })] })
    const withdrawal = await openWithdrawal(page)
    await withdrawal.get('textarea').setValue('  Versión reemplazada  ')
    await button(withdrawal, 'Retirar asociación').trigger('click')
    await flushPromises()
    expect(page.find('dialog[data-title="Retirar asociación"]').exists()).toBe(true)
    expect(button(withdrawal, 'Retirar asociación').attributes('data-loading')).toBe('false')
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ color: 'error' }))
    expect(refresh).not.toHaveBeenCalled()
    await withdrawal.get('textarea').setValue('Versión reemplazada')
    await button(withdrawal, 'Retirar asociación').trigger('click')
    await flushPromises()
    expect(requestOptions(1)).toEqual(requestOptions(0))
    expect(requestOptions(0).headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/i)
    expect(requestOptions(0).headers['If-Match']).toBe('1')
    await withdrawal.get('textarea').setValue('Retirada por revocación de derechos')
    await button(withdrawal, 'Retirar asociación').trigger('click')
    await flushPromises()
    expect(requestOptions(2).headers['Idempotency-Key']).not.toBe(requestOptions(0).headers['Idempotency-Key'])
    expect(requestOptions(2).headers['If-Match']).toBe('1')
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('does not reuse a withdrawal key for another association with the same reason and version', async () => {
    mutationMock.mockRejectedValueOnce({ data: { statusMessage: 'Respuesta perdida' } })
    const second = publication({ id: '33333333-3333-4333-8333-333333333333', title: 'Segunda asociación' })
    const { page } = await render({ items: [asset({ publications: [publication(), second] })] })
    const firstDialog = await openWithdrawal(page)
    await firstDialog.get('textarea').setValue('Versión reemplazada')
    await button(firstDialog, 'Retirar asociación').trigger('click')
    await flushPromises()
    await button(firstDialog, 'Cancelar').trigger('click')
    const secondDialog = await openWithdrawal(page, 1)
    await secondDialog.get('textarea').setValue('Versión reemplazada')
    await button(secondDialog, 'Retirar asociación').trigger('click')
    await flushPromises()
    expect(mutationMock.mock.calls[1]![0]).toBe(`/api/admin/media/publications/${second.id}`)
    expect(requestOptions(1).headers['Idempotency-Key']).not.toBe(requestOptions(0).headers['Idempotency-Key'])
    expect(requestOptions(1).headers['If-Match']).toBe('1')
  })

  it('creates a new withdrawal command when the optimistic association version changes', async () => {
    mutationMock.mockRejectedValueOnce({ data: { statusMessage: 'Versión obsoleta' } })
    const { page, data } = await render({ items: [asset({ publications: [publication()] })] })
    const withdrawal = await openWithdrawal(page)
    await withdrawal.get('textarea').setValue('Versión reemplazada')
    await button(withdrawal, 'Retirar asociación').trigger('click')
    await flushPromises()
    data.value!.items[0]!.publications![0]!.publicationVersion = 2
    await button(withdrawal, 'Retirar asociación').trigger('click')
    await flushPromises()
    expect(requestOptions(1).headers['If-Match']).toBe('2')
    expect(requestOptions(1).headers['Idempotency-Key']).not.toBe(requestOptions(0).headers['Idempotency-Key'])
  })

  it('does not offer withdrawal for a withdrawn association or without global publication capability', async () => {
    const { page } = await render({
      capabilities: { canApprove: true },
      items: [asset({ publications: [publication(), publication({ id: 'withdrawn-history', status: 'withdrawn' })] })]
    })
    expect(page.text()).toContain('Retirada')
    expect(page.findAll('button').some((candidate) => candidate.text() === 'Retirar')).toBe(false)
    expect(mutationMock).not.toHaveBeenCalled()
  })

  it('requires a meaningful withdrawal reason and rechecks permission while the dialog is open', async () => {
    const { page, data } = await render({ items: [asset({ publications: [publication()] })] })
    const withdrawal = await openWithdrawal(page)
    await withdrawal.get('textarea').setValue(' ab ')
    await button(withdrawal, 'Retirar asociación').trigger('click')
    expect(mutationMock).not.toHaveBeenCalled()
    await withdrawal.get('textarea').setValue('Versión reemplazada')
    data.value!.capabilities = { canPublish: false }
    await button(withdrawal, 'Retirar asociación').trigger('click')
    expect(button(withdrawal, 'Retirar asociación').attributes('disabled')).toBeDefined()
    expect(mutationMock).not.toHaveBeenCalled()
  })

  it('shows withdrawal loading and prevents duplicate deletion or cancellation during the request', async () => {
    const pending = deferred<{ ok: boolean }>()
    mutationMock.mockReturnValueOnce(pending.promise)
    const { page } = await render({ items: [asset({ publications: [publication()] })] })
    const withdrawal = await openWithdrawal(page)
    await withdrawal.get('textarea').setValue('Versión reemplazada')
    await button(withdrawal, 'Retirar asociación').trigger('click')
    expect(button(withdrawal, 'Retirar asociación').attributes('data-loading')).toBe('true')
    expect(button(withdrawal, 'Cancelar').attributes('disabled')).toBeDefined()
    await button(withdrawal, 'Retirar asociación').trigger('click')
    await button(withdrawal, 'Cancelar').trigger('click')
    expect(mutationMock).toHaveBeenCalledTimes(1)
    expect(page.find('dialog[data-title="Retirar asociación"]').exists()).toBe(true)
    pending.resolve({ ok: true })
    await flushPromises()
    expect(page.find('dialog[data-title="Retirar asociación"]').exists()).toBe(false)
  })

  it.each([
    'https://private-bucket.r2.dev/quarantine/secret.png',
    '/api/admin/media/11111111-1111-4111-8111-111111111111/original',
    'quarantine/11111111-1111-4111-8111-111111111111/secret.png',
    'javascript:alert("quarantine")'
  ])('never exposes a hostile sourceUrl in the Cloudflare library: %s', async (sourceUrl) => {
    const { page } = await render({
      items: [asset({ sourceUrl, publications: [publication()] }), asset({ id: 'other-upload', sourceUrl })]
    })
    expect(page.text()).not.toContain(sourceUrl)
    expect(page.html()).not.toContain(sourceUrl)
    expect(page.findAll('a, img, source')).toHaveLength(0)
    expect(page.text()).toContain('Asociada (entrega condicionada)')
    expect(page.text()).toContain('Sin asociación pública')
    expect(mutationMock).not.toHaveBeenCalled()
  })

  it('refreshes association state after an explicitly published dialog event without synthesizing public URLs', async () => {
    const { page, refresh } = await render({ items: [asset({ canPublish: true })] })
    await button(page, 'Asociar').trigger('click')
    await button(page, 'Simular asociación confirmada').trigger('click')
    await flushPromises()
    expect(refresh).toHaveBeenCalledOnce()
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Asociación creada; la entrega sigue sujeta a las comprobaciones de publicación'
      })
    )
    expect(page.findAll('a, img, source')).toHaveLength(0)
    expect(mutationMock).not.toHaveBeenCalled()
  })

  it('passes the pending state to the table without inventing editable rows from missing data', async () => {
    const { page } = await render({ noData: true, status: 'pending' })
    expect(page.get('[data-table-status]').attributes('data-table-status')).toBe('pending')
    expect(page.find('[role="status"]').exists()).toBe(true)
    expect(page.find('[data-row]').exists()).toBe(false)
    expect(button(page, 'Subir archivo').attributes('disabled')).toBeDefined()
    expect(mutationMock).not.toHaveBeenCalled()
  })

  it('passes load failures to the table and retries its fetch rather than issuing a mutation', async () => {
    const { page, refresh } = await render({ noData: true, status: 'error' })
    expect(page.get('[data-table-status]').attributes('data-table-status')).toBe('error')
    expect(page.get('[role="alert"]').text()).toContain('No hemos podido cargar la biblioteca.')
    await button(page, 'Reintentar').trigger('click')
    expect(refresh).toHaveBeenCalledOnce()
    expect(mutationMock).not.toHaveBeenCalled()
  })

  it('keeps empty-state upload closed when capabilities are absent', async () => {
    const { page } = await render({ items: [], capabilities: null })
    expect(page.text()).toContain('La biblioteca está vacía')
    await button(page, 'Subir el primer archivo').trigger('click')
    expect(button(page, 'Subir el primer archivo').attributes('disabled')).toBeDefined()
    expect(page.find('dialog').exists()).toBe(false)
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(['/api/admin/media'])
    expect(mutationMock).not.toHaveBeenCalled()
  })
})
