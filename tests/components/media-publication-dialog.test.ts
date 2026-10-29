import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import type { DOMWrapper } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import type { PropType } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import MediaPublicationDialog from '../../app/components/MediaPublicationDialog.vue'
import { buildMediaPublicationPayload, publicationLocalTime, publicationRoles } from '../../app/utils/mediaPublication'
import type { MediaPublicationPayload, PublicationFormInput } from '../../app/utils/mediaPublication'
import '#app/nuxt-vitest-app-entry'

interface FetchOptions {
  method?: string
  query?: Record<string, unknown>
  body?: MediaPublicationPayload
  headers?: Record<string, string>
}
const { fetchMock } = vi.hoisted(() => ({
  fetchMock: vi.fn<(path: string, options?: FetchOptions) => Promise<unknown>>()
}))
mockNuxtImport('$fetch', () => fetchMock)
mockNuxtImport('useUserSession', () => () => ({
  ready: ref(true),
  loggedIn: ref(true),
  user: ref({ id: 'synthetic-admin', role: 'admin', mfaVerified: true }),
  session: ref(null),
  clear: async () => undefined,
  openInPopup: () => undefined,
  fetch: async () => undefined
}))

const PRODUCT_A = 'a1000000-0000-4000-8000-000000000001'
const PRODUCT_B = 'b1000000-0000-4000-8000-000000000002'
const VARIANT_A = 'c2000000-0000-4000-8000-000000000001'
const VARIANT_B = 'd2000000-0000-4000-8000-000000000002'
const ASSET_ID = '30000000-0000-4000-8000-000000000001'
const PRIVATE_URL = 'https://quarantine.invalid/private/never-deliver.pdf'
const LOCAL_FROM = '2026-10-01T12:34:56'
const LOCAL_UNTIL = '2026-10-02T01:02:03'
const utc = (local: string) => new Date(local).toISOString().replace('.000Z', 'Z')
const asset = (overrides = {}) => ({
  id: ASSET_ID,
  originalName: 'Documento técnico.pdf',
  mimeType: 'application/pdf',
  altText: 'Descripción detallada del documento',
  canPublish: true,
  quarantineKey: 'private/never-deliver.pdf',
  quarantineUrl: PRIVATE_URL,
  ...overrides
})
const list = () => ({
  source: 'cloudflare',
  capabilities: { productsRead: true },
  items: [
    { id: 101, uuid: PRODUCT_A, name: 'Producto A' },
    { id: 202, uuid: PRODUCT_B, name: 'Producto B' }
  ]
})
const details = () => ({
  '/api/admin/products/101': {
    ...list().items[0]!,
    source: 'cloudflare',
    capabilities: { productDetailRead: true },
    variants: [{ id: 1001, uuid: VARIANT_A, sku: 'SKU-A', format: 'Caja A' }]
  },
  '/api/admin/products/202': {
    ...list().items[1]!,
    source: 'cloudflare',
    capabilities: { productDetailRead: true },
    variants: [{ id: 2002, uuid: VARIANT_B, sku: 'SKU-B', format: 'Caja B' }]
  }
})

const Modal = defineComponent({
  props: { open: Boolean, title: String },
  emits: ['update:open'],
  setup(props, { slots, emit }) {
    return () =>
      props.open
        ? h('dialog', { open: true }, [
            props.title,
            h('button', { 'data-modal-close': '', onClick: () => emit('update:open', false) }, 'Cerrar diálogo'),
            slots.body?.(),
            slots.footer?.()
          ])
        : null
  }
})
const FormField = defineComponent({
  props: { label: String, hint: String },
  setup(props, { slots }) {
    return () => h('label', [h('span', props.label), slots.default?.(), props.hint ? h('small', props.hint) : null])
  }
})
const Input = defineComponent({
  inheritAttrs: false,
  props: { modelValue: String },
  emits: ['update:modelValue'],
  setup(props, { attrs, emit }) {
    return () =>
      h('input', {
        ...attrs,
        value: props.modelValue ?? '',
        onInput: (event: Event) => emit('update:modelValue', (event.target as HTMLInputElement).value)
      })
  }
})
const Select = defineComponent({
  inheritAttrs: false,
  props: {
    modelValue: String,
    items: Array as PropType<Array<{ label: string; value: string }>>
  },
  emits: ['update:modelValue'],
  setup(props, { attrs, emit }) {
    return () =>
      h(
        'select',
        {
          ...attrs,
          value: props.modelValue,
          onChange: (event: Event) => emit('update:modelValue', (event.target as HTMLSelectElement).value)
        },
        [
          h('option', { value: '', disabled: true }, 'Selecciona'),
          ...(props.items ?? []).map((item) => h('option', { value: item.value }, item.label))
        ]
      )
  }
})
const Button = defineComponent({
  inheritAttrs: false,
  props: { loading: Boolean },
  setup(props, { attrs, slots }) {
    return () =>
      h('button', { ...attrs, type: attrs.type ?? 'button', disabled: Boolean(attrs.disabled) || props.loading }, [
        slots.default?.()
      ])
  }
})
const Alert = defineComponent({
  props: { title: String, description: String },
  setup(props) {
    return () => h('p', { role: 'alert' }, [props.title, props.description])
  }
})

let wrapper: Awaited<ReturnType<typeof mountSuspended>> | undefined
let listResponse: ReturnType<typeof list>
let detailResponses: ReturnType<typeof details>
let postResponse: () => Promise<unknown>

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
async function render(overrides = {}) {
  wrapper = await mountSuspended(MediaPublicationDialog, {
    props: { asset: asset(overrides) },
    global: {
      stubs: {
        UModal: Modal,
        UFormField: FormField,
        UInput: Input,
        UTextarea: Input,
        USelect: Select,
        UButton: Button,
        UAlert: Alert
      }
    }
  })
  await flushPromises()
  return wrapper
}
function field(label: string): DOMWrapper<Element> {
  const result = wrapper!.findAll('label').find((node: DOMWrapper<Element>) => node.get('span').text() === label)
  if (!result) throw new Error(`Missing accessible field: ${label}`)
  return result.get('input, select')
}
function submitButton() {
  return wrapper!.get('button[type="submit"]')
}
async function selectProduct(uuid = PRODUCT_A) {
  await field('Producto').setValue(uuid)
  await flushPromises()
}
async function submit() {
  await wrapper!.get('form').trigger('submit')
  await flushPromises()
}
function postCalls() {
  return fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST')
}
function lastPost() {
  const call = postCalls().at(-1)
  if (!call?.[1]) throw new Error('Expected a publication request')
  return { path: call[0], options: call[1] }
}
async function validForm() {
  await selectProduct()
  await field('Título').setValue('  Ficha técnica A  ')
  await field('Texto alternativo / descripción').setValue('  Documento detallado y accesible  ')
  await field('Idioma').setValue(' es ')
  await field('Versión').setValue(' 2 ')
  await field('Inicio de vigencia').setValue(LOCAL_FROM)
  await field('Fin de vigencia').setValue(LOCAL_UNTIL)
}

beforeEach(() => {
  listResponse = list()
  detailResponses = details()
  postResponse = async () => ({ publication: { id: '40000000-0000-4000-8000-000000000001' }, replayed: false })
  fetchMock.mockReset().mockImplementation(async (path, options) => {
    if (path === '/api/admin/products') return listResponse
    if (path in detailResponses) return detailResponses[path as keyof typeof detailResponses]
    if (path === `/api/admin/media/${ASSET_ID}/publications` && options?.method === 'POST') return postResponse()
    throw new Error(`Unexpected local request: ${path}`)
  })
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
})

describe('media publication dialog private catalog contract', () => {
  it('reads the bounded private list and exact legacy detail, then publishes product and variant UUIDs only', async () => {
    await render()
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/products', { query: { q: '', page: 1, perPage: 50 } })
    await validForm()
    await field('Variante / SKU').setValue(VARIANT_A)
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/products/101')
    await submit()
    expect(lastPost()).toEqual({
      path: `/api/admin/media/${ASSET_ID}/publications`,
      options: {
        method: 'POST',
        headers: { 'Idempotency-Key': expect.stringMatching(/^[0-9a-f-]{36}$/i) },
        body: {
          productId: PRODUCT_A,
          variantId: VARIANT_A,
          role: 'datasheet',
          title: 'Ficha técnica A',
          altText: 'Documento detallado y accesible',
          language: 'es',
          version: '2',
          validFrom: utc(LOCAL_FROM),
          validUntil: utc(LOCAL_UNTIL)
        }
      }
    })
    expect(wrapper!.html()).not.toContain(PRIVATE_URL)
    expect(JSON.stringify(lastPost().options)).not.toContain('quarantine')
  })

  it('clears the previous SKU when another product is selected and supports product-level publication', async () => {
    await render()
    await validForm()
    await field('Variante / SKU').setValue(VARIANT_A)
    await selectProduct(PRODUCT_B)
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/products/202')
    expect((field('Variante / SKU').element as HTMLSelectElement).value).toBe('product-level')
    expect(field('Variante / SKU').text()).toContain('SKU-B')
    expect(field('Variante / SKU').text()).not.toContain('SKU-A')
    await submit()
    expect(lastPost().options.body).toMatchObject({ productId: PRODUCT_B, variantId: null })
  })

  it('does not accept another product UUID returned by the selected detail endpoint', async () => {
    detailResponses['/api/admin/products/101'].uuid = PRODUCT_B
    await render()
    await selectProduct()
    expect(wrapper!.text()).toContain('No se ha podido cargar este producto')
    expect(submitButton().attributes('disabled')).toBeDefined()
    await submit()
    expect(postCalls()).toHaveLength(0)
  })

  it('rejects an injected variant UUID belonging to a different product', async () => {
    await render()
    await validForm()
    wrapper!.findAllComponents(Select)[1]!.vm.$emit('update:modelValue', VARIANT_B)
    await flushPromises()
    expect(submitButton().attributes('disabled')).toBeDefined()
    await submit()
    expect(postCalls()).toHaveLength(0)
  })

  it.each([
    ['application/pdf', ['datasheet', 'sds', 'certificate', 'label']],
    ['image/jpeg', ['main', 'image', 'label']],
    ['image/png', ['main', 'image', 'label']]
  ])('offers only the legal roles for %s', async (mimeType, expected) => {
    await render({ mimeType })
    const options = field('Uso del archivo')
      .findAll('option')
      .map((option) => option.attributes('value'))
      .filter(Boolean)
    expect(options).toEqual(expected)
    await validForm()
    expect(submitButton().attributes('disabled')).toBeUndefined()
    await submit()
    expect(lastPost().options.body?.role).toBe(expected[0])
  })

  it('uses the administrative search route for both Buscar and Enter', async () => {
    await render()
    await field('Buscar producto').setValue('draft literal %_')
    await wrapper!
      .findAll('button')
      .find((button: DOMWrapper<Element>) => button.text() === 'Buscar')!
      .trigger('click')
    await flushPromises()
    expect(fetchMock).toHaveBeenLastCalledWith('/api/admin/products', {
      query: { q: 'draft literal %_', page: 1, perPage: 50 }
    })
    await field('Buscar producto').setValue('hidden')
    await field('Buscar producto').trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(fetchMock).toHaveBeenLastCalledWith('/api/admin/products', {
      query: { q: 'hidden', page: 1, perPage: 50 }
    })
    expect(fetchMock.mock.calls.every(([path]) => path.startsWith('/api/admin/'))).toBe(true)
  })

  it.each([false, undefined])('performs no reads or writes when canPublish is %s', async (canPublish) => {
    await render({ canPublish })
    expect(wrapper!.text()).toContain('Este archivo no se puede publicar')
    expect(wrapper!.get('fieldset').attributes('disabled')).toBeDefined()
    expect(submitButton().attributes('disabled')).toBeDefined()
    await submit()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('blocks a previously valid form when publication capability is revoked', async () => {
    await render()
    await validForm()
    expect(submitButton().attributes('disabled')).toBeUndefined()
    await wrapper!.setProps({ asset: asset({ canPublish: false }) })
    expect(submitButton().attributes('disabled')).toBeDefined()
    await submit()
    expect(postCalls()).toHaveLength(0)
  })

  it('does not publish an unsupported MIME type despite otherwise valid catalog and metadata', async () => {
    await render({ mimeType: 'image/webp' })
    await validForm()
    expect(field('Uso del archivo').findAll('option')).toHaveLength(1)
    expect(submitButton().attributes('disabled')).toBeDefined()
    await submit()
    expect(postCalls()).toHaveLength(0)
  })

  it.each(['node', 'missing-capability', 'denied-capability'])('fails closed for %s list metadata', async (mode) => {
    if (mode === 'node') listResponse.source = 'node'
    else if (mode === 'missing-capability') Object.assign(listResponse, { capabilities: undefined })
    else listResponse.capabilities.productsRead = false
    await render()
    expect(wrapper!.text()).toContain('No se ha podido consultar el catálogo autorizado')
    expect(field('Producto').attributes('disabled')).toBeDefined()
    await submit()
    expect(postCalls()).toHaveLength(0)
    expect(wrapper!.html()).not.toContain(PRIVATE_URL)
  })

  it.each(['node', 'missing-capability', 'denied-capability'])('fails closed for %s detail metadata', async (mode) => {
    const result = detailResponses['/api/admin/products/101']
    if (mode === 'node') result.source = 'node'
    else if (mode === 'missing-capability') Object.assign(result, { capabilities: undefined })
    else result.capabilities.productDetailRead = false
    await render()
    await selectProduct()
    expect(field('Variante / SKU').attributes('disabled')).toBeDefined()
    await submit()
    expect(postCalls()).toHaveLength(0)
  })

  it('shows bounded loading states without requests or invented product/variant choices', async () => {
    const pendingList = deferred<ReturnType<typeof list>>()
    const pendingDetail = deferred<ReturnType<typeof details>['/api/admin/products/101']>()
    fetchMock.mockImplementation(async (path) => {
      if (path === '/api/admin/products') return pendingList.promise
      if (path === '/api/admin/products/101') return pendingDetail.promise
      throw new Error(`Unexpected loading request: ${path}`)
    })
    await render()
    expect(wrapper!.text()).toContain('Cargando catálogo')
    expect(field('Producto').attributes('disabled')).toBeDefined()
    await submit()
    expect(postCalls()).toHaveLength(0)
    pendingList.resolve(list())
    await flushPromises()
    await selectProduct()
    expect(wrapper!.text()).toContain('Cargando variantes')
    expect(field('Variante / SKU').attributes('disabled')).toBeDefined()
    await submit()
    expect(postCalls()).toHaveLength(0)
    pendingDetail.resolve(details()['/api/admin/products/101'])
    await flushPromises()
    expect(field('Variante / SKU').text()).toContain('SKU-A')
    expect(submitButton().attributes('disabled')).toBeUndefined()
  })

  it('ignores stale detail responses while a different product is selected', async () => {
    const stale = deferred<ReturnType<typeof details>['/api/admin/products/101']>()
    fetchMock.mockImplementation(async (path) => {
      if (path === '/api/admin/products') return listResponse
      if (path === '/api/admin/products/101') return stale.promise
      if (path === '/api/admin/products/202') return detailResponses['/api/admin/products/202']
      return postResponse()
    })
    await render()
    await selectProduct()
    await selectProduct(PRODUCT_B)
    stale.resolve(details()['/api/admin/products/101'])
    await flushPromises()
    expect(field('Variante / SKU').text()).toContain('SKU-B')
    expect(field('Variante / SKU').text()).not.toContain('SKU-A')
    await submit()
    expect(lastPost().options.body?.productId).toBe(PRODUCT_B)
  })

  it('clears product and SKU when refreshed results exclude the previous selection', async () => {
    await render()
    await validForm()
    await field('Variante / SKU').setValue(VARIANT_A)
    listResponse.items = [list().items[1]!]
    await field('Buscar producto').setValue('Producto B')
    await field('Buscar producto').trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect((field('Producto').element as HTMLSelectElement).value).toBe('')
    expect(field('Variante / SKU').text()).not.toContain('SKU-A')
    expect(submitButton().attributes('disabled')).toBeDefined()
    await submit()
    expect(postCalls()).toHaveLength(0)
  })

  it('ignores stale catalog responses after a newer search completes', async () => {
    const initial = deferred<ReturnType<typeof list>>()
    fetchMock.mockImplementation(async (path, options) => {
      if (path !== '/api/admin/products') throw new Error('Only catalog reads expected')
      return options?.query?.q === '' ? initial.promise : { ...list(), items: [list().items[1]!] }
    })
    await render()
    await field('Buscar producto').setValue('Producto B')
    await field('Buscar producto').trigger('keydown', { key: 'Enter' })
    await flushPromises()
    initial.resolve(list())
    await flushPromises()
    expect(field('Producto').text()).toContain('Producto B')
    expect(field('Producto').text()).not.toContain('Producto A')
    expect(wrapper!.text()).not.toContain('Cargando catálogo')
    await submit()
    expect(postCalls()).toHaveLength(0)
  })

  it('does not manufacture a publication when the authorized catalog is empty or unavailable', async () => {
    listResponse.items = []
    await render()
    expect(field('Producto').findAll('option')).toHaveLength(1)
    await submit()
    expect(postCalls()).toHaveLength(0)
    wrapper!.unmount()
    fetchMock.mockRejectedValue(new Error(`Private diagnostic: ${PRIVATE_URL}`))
    await render()
    expect(wrapper!.text()).toContain('No se ha podido consultar el catálogo autorizado')
    expect(wrapper!.html()).not.toContain(PRIVATE_URL)
    await submit()
    expect(postCalls()).toHaveLength(0)
  })
})

describe('media publication validation and command lifecycle', () => {
  it.each([
    ['Título', ''],
    ['Texto alternativo / descripción', 'abc'],
    ['Idioma', 'invalid_language'],
    ['Versión', ''],
    ['Inicio de vigencia', ''],
    ['Fin de vigencia', '2026-09-01T00:00:00']
  ])('blocks invalid %s even if a form submit event is forced', async (label, value) => {
    await render()
    await validForm()
    await field(label).setValue(value)
    expect(submitButton().attributes('disabled')).toBeDefined()
    await submit()
    expect(postCalls()).toHaveLength(0)
  })

  it('retains the exact idempotency key after a lost response but changes it after a changed payload', async () => {
    postResponse = async () => {
      throw new TypeError('Synthetic response was lost')
    }
    await render()
    await validForm()
    await submit()
    const first = lastPost().options
    expect(wrapper!.emitted('published')).toBeUndefined()
    expect(wrapper!.emitted('close')).toBeUndefined()
    expect(wrapper!.text()).toContain('Puedes reintentar sin duplicar')
    await submit()
    expect(lastPost().options).toEqual(first)
    await field('Título').setValue('Ficha técnica A')
    await submit()
    expect(lastPost().options).toEqual(first)
    await field('Título').setValue('Ficha técnica revisada')
    await submit()
    expect(lastPost().options.body?.title).toBe('Ficha técnica revisada')
    expect(lastPost().options.headers?.['Idempotency-Key']).not.toBe(first.headers?.['Idempotency-Key'])
    expect(postCalls()).toHaveLength(4)
  })

  it('does not expose private URLs from a structured publication error', async () => {
    postResponse = async () => {
      throw { data: { statusMessage: `Storage failed at ${PRIVATE_URL}` } }
    }
    await render()
    await validForm()
    await submit()
    expect(wrapper!.html()).not.toContain(PRIVATE_URL)
    expect(wrapper!.emitted('published')).toBeUndefined()
    expect(wrapper!.emitted('close')).toBeUndefined()
  })

  it('blocks duplicate submissions and modal close while saving, then emits published and close exactly once', async () => {
    const pending = deferred<unknown>()
    postResponse = () => pending.promise
    await render()
    await validForm()
    await submit()
    expect(wrapper!.get('fieldset').attributes('disabled')).toBeDefined()
    await submit()
    await wrapper!.get('[data-modal-close]').trigger('click')
    expect(postCalls()).toHaveLength(1)
    expect(wrapper!.emitted('close')).toBeUndefined()
    pending.resolve({ publication: { id: '40000000-0000-4000-8000-000000000001' }, replayed: true })
    await flushPromises()
    expect(wrapper!.emitted('published')).toHaveLength(1)
    expect(wrapper!.emitted('close')).toHaveLength(1)
  })

  it('closes without creating a publication when the modal is dismissed', async () => {
    await render()
    await wrapper!.get('[data-modal-close]').trigger('click')
    expect(wrapper!.emitted('close')).toHaveLength(1)
    expect(wrapper!.emitted('published')).toBeUndefined()
    expect(postCalls()).toHaveLength(0)
  })
})

describe('media publication payload boundary', () => {
  const input = (): PublicationFormInput => ({
    productId: PRODUCT_A.toUpperCase(),
    variantId: VARIANT_A.toUpperCase(),
    mimeType: 'application/pdf',
    role: 'sds',
    title: ' Documento ',
    altText: ' Descripción accesible ',
    language: 'es-ES',
    version: ' 1 ',
    validFromLocal: LOCAL_FROM,
    validUntilLocal: LOCAL_UNTIL
  })

  it('whitelists fields, lowercases UUIDs and sends canonical UTC seconds instead of local inputs', () => {
    const payload = buildMediaPublicationPayload({
      ...input(),
      url: PRIVATE_URL,
      quarantineKey: 'private/never-deliver.pdf',
      scanStatus: 'clean',
      rightsVerified: true,
      publicEligible: true
    } as PublicationFormInput)
    expect(payload).toEqual({
      productId: PRODUCT_A,
      variantId: VARIANT_A,
      role: 'sds',
      title: 'Documento',
      altText: 'Descripción accesible',
      language: 'es-ES',
      version: '1',
      validFrom: utc(LOCAL_FROM),
      validUntil: utc(LOCAL_UNTIL)
    })
    expect(JSON.stringify(payload)).not.toContain(PRIVATE_URL)
  })

  it.each([
    { productId: '101' },
    { variantId: '1001' },
    { role: 'image' },
    { mimeType: 'image/webp' },
    { title: 'x'.repeat(201) },
    { altText: 'tiny' },
    { altText: 'x'.repeat(501) },
    { title: 'control\u0000' },
    { version: 'con\ntrol' },
    { language: 'es_ES' },
    { validFromLocal: '2026-02-30T12:00:00' },
    { validFromLocal: '2026-10-01T25:00:00' },
    { validFromLocal: '2026-10-01T12:00:00Z' },
    { validUntilLocal: '2026-02-30T12:00:00' },
    { validUntilLocal: LOCAL_FROM }
  ])('rejects malformed identifiers, roles, metadata or validity: %j', (override) => {
    expect(buildMediaPublicationPayload({ ...input(), ...override } as PublicationFormInput)).toBeNull()
  })

  it('supports a product-level association with no expiry and minute-resolution local input', () => {
    expect(
      buildMediaPublicationPayload({
        ...input(),
        variantId: null,
        validFromLocal: '2026-10-01T12:34',
        validUntilLocal: ''
      })
    ).toMatchObject({ variantId: null, validFrom: utc('2026-10-01T12:34:00'), validUntil: null })
  })

  it('offers no publication role for unsupported MIME types and formats local time without UTC masquerading', () => {
    expect(publicationRoles('image/webp')).toEqual([])
    expect(publicationRoles('application/octet-stream')).toEqual([])
    const date = new Date(2026, 9, 1, 2, 3, 4)
    expect(publicationLocalTime(date)).toBe('2026-10-01T02:03:04')
  })
})
