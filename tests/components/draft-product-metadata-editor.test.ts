import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h, proxyRefs, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import DraftProductMetadataEditor from '../../app/components/DraftProductMetadataEditor.vue'
import type { AdminProductDetail } from '../../shared/types/admin'
import '#app/nuxt-vitest-app-entry'

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }))
mockNuxtImport('$fetch', () => requestMock)
mockNuxtImport('useUserSession', () => () => ({
  ready: ref(true),
  loggedIn: ref(true),
  user: ref({ id: 'synthetic-admin', role: 'admin', mfaVerified: true }),
  session: ref(null),
  clear: async () => undefined,
  openInPopup: () => undefined,
  fetch: async () => undefined
}))
const UUID = 'a1000000-0000-4000-8000-000000000001'
type PrivateProduct = AdminProductDetail & {
  source: unknown
  uuid: unknown
  catalogVersion: unknown
  capabilities: unknown
}
const product = (): PrivateProduct => ({
  id: 1,
  uuid: UUID,
  catalogVersion: 1,
  source: 'cloudflare',
  capabilities: { productDetailRead: true, productMetadataUpdate: true, productUpdate: false },
  name: 'Producto borrador',
  slug: 'producto-borrador',
  brand: 'NETECO',
  categoryId: 7,
  shortDesc: 'Descripción breve',
  description: 'Descripción completa',
  usage: 'Uso original',
  series: null,
  badges: ['eco'],
  visual: { type: 'caja', color: '#123456' },
  featured: false,
  active: false,
  status: 'draft',
  image: null,
  imageAlt: null,
  imageRightsOwner: null,
  imageRightsLicense: null,
  imageAuthorizedAt: null,
  attrs: [{ k: 'Material', v: 'Acero' }],
  variants: []
})
const receipt = (catalogVersion: unknown = 2) => ({
  source: 'cloudflare',
  productId: 1,
  productUuid: UUID,
  catalogVersion,
  updated: true
})
const Button = defineComponent({
  inheritAttrs: false,
  props: { loading: Boolean, disabled: Boolean },
  setup:
    (props, { attrs, slots }) =>
    () =>
      h(
        'button',
        { ...attrs, type: attrs.type ?? 'button', disabled: props.loading || props.disabled },
        slots.default?.()
      )
})
const mounted: Array<{ unmount: () => void }> = []
type EditorProps = {
  product: PrivateProduct | null
  productId: string
  runtime: unknown
  readStatus: string
  categories: Array<{ label: string; value: number }>
  categoriesReady: boolean
  refreshProduct: () => Promise<unknown>
}
async function render(overrides: Partial<EditorProps> = {}) {
  const data = ref(product())
  const reload = vi.fn<() => Promise<unknown>>(async () => undefined)
  const wrapper = await mountSuspended(DraftProductMetadataEditor, {
    props: {
      product: data.value,
      productId: '1',
      runtime: 'cloudflare',
      readStatus: 'success',
      categories: [
        { label: 'Familia 7', value: 7 },
        { label: 'Familia 8 (oculta)', value: 8 }
      ],
      categoriesReady: true,
      authorize: () => true,
      refreshProduct: reload,
      ...overrides
    },
    global: { stubs: { UButton: Button } }
  })
  mounted.push(wrapper)
  return { wrapper, data, reload }
}
type Page = Awaited<ReturnType<typeof render>>['wrapper']
function state(wrapper: Page) {
  return proxyRefs(wrapper.setupState) as Record<string, unknown>
}
async function invoke(wrapper: Page, action: string, ...args: unknown[]) {
  const handler = state(wrapper)[action]
  if (typeof handler !== 'function') throw new Error(`Missing ${action}`)
  await handler(...args)
}
async function prepare(wrapper: Page, name = 'Nombre actualizado') {
  await wrapper.get('#draft-name').setValue(name)
  await wrapper.get('#draft-reason').setValue('Corrección editorial motivada')
}
const call = () => requestMock.mock.calls.at(-1)!
beforeEach(() => {
  requestMock.mockReset().mockResolvedValue(receipt())
})
afterEach(() => mounted.splice(0).forEach((wrapper) => wrapper.unmount()))

describe('draft-only narrow metadata command', () => {
  it('renders explicitly draft-only accessible controls without any broad catalog or publication controls', async () => {
    const { wrapper } = await render()
    expect(wrapper.text()).toContain('Editar metadatos del borrador')
    expect(wrapper.text()).toContain('no publica')
    expect(wrapper.get('form').attributes('aria-busy')).toBe('false')
    expect(wrapper.get('label[for="draft-reason"]').text()).toContain('Motivo del cambio')
    expect(wrapper.get('#draft-name').attributes()).toMatchObject({ minlength: '3', maxlength: '160' })
    expect(wrapper.get('#draft-description').attributes('maxlength')).toBe('10000')
    expect(
      wrapper.find('input[name="brand"], input[name="slug"], input[name="price"], input[type="file"]').exists()
    ).toBe(false)
    expect(wrapper.find('button[type="submit"]').attributes('disabled')).toBeDefined()
  })
  it('sends only changed flat metadata, expectedVersion/reason, browser Origin and an idempotency key', async () => {
    const { wrapper, reload } = await render()
    await prepare(wrapper, '  Nombre corregido  ')
    Object.assign(state(wrapper).form as object, {
      brand: 'Forged brand',
      slug: 'forged-slug',
      status: 'published',
      variants: [{ price: 1, stock: 1 }],
      image: 'private/forbidden',
      imageRightsOwner: 'Forged owner',
      active: true
    })
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(requestMock).toHaveBeenCalledOnce()
    expect(call()[0]).toBe('/api/admin/products/1')
    expect(call()[1]).toMatchObject({
      method: 'PUT',
      body: { expectedVersion: 1, reason: 'Corrección editorial motivada', name: 'Nombre corregido' }
    })
    expect(Object.keys(call()[1].body).sort()).toEqual(['expectedVersion', 'name', 'reason'])
    expect(call()[1].headers.Origin).toBe(window.location.origin)
    expect(call()[1].headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/)
    expect(reload).toHaveBeenCalledOnce()
    expect(wrapper.text()).toContain('Metadatos guardados en el borrador')
    expect(wrapper.text()).toContain('El producto no se ha publicado')
  })
  it('preserves ordered badges/attributes and multiline text with a bounded, whitelist-only payload', async () => {
    const { wrapper } = await render()
    await prepare(wrapper)
    const form = state(wrapper).form as Record<string, unknown>
    Object.assign(form, {
      categoryId: 8,
      shortDesc: 'Una nueva descripción corta',
      description: 'Primera línea\nSegunda línea',
      usage: '  ',
      series: '  gama-nueva  ',
      featured: true,
      badges: ['concentrado', 'eco', 'alimentaria'],
      visual: { type: 'guante', color: '#ABCDEF' },
      attrs: [
        { k: 'Segundo', v: 'Dos' },
        { k: 'Primero', v: 'Uno' }
      ]
    })
    await invoke(wrapper, 'saveMetadata')
    expect(call()[1].body).toEqual({
      expectedVersion: 1,
      reason: 'Corrección editorial motivada',
      name: 'Nombre actualizado',
      categoryId: 8,
      shortDesc: 'Una nueva descripción corta',
      description: 'Primera línea\nSegunda línea',
      usage: null,
      series: 'gama-nueva',
      featured: true,
      badges: ['concentrado', 'eco', 'alimentaria'],
      visual: { type: 'guante', color: '#abcdef' },
      attrs: [
        { k: 'Segundo', v: 'Dos' },
        { k: 'Primero', v: 'Uno' }
      ]
    })
  })
  it('allows other metadata changes when the category read is unavailable, but disables and rejects category changes', async () => {
    const { wrapper } = await render({ categoriesReady: false, categories: [] })
    expect(wrapper.get('#draft-category').attributes('disabled')).toBeDefined()
    await prepare(wrapper)
    Object.assign(state(wrapper).form as object, { categoryId: 8 })
    await invoke(wrapper, 'saveMetadata')
    expect(requestMock).not.toHaveBeenCalled()
    expect(wrapper.get('[role="alert"]').text()).toContain('consulta privada autorizada')
    Object.assign(state(wrapper).form as object, { categoryId: 7 })
    await invoke(wrapper, 'saveMetadata')
    expect(requestMock).toHaveBeenCalledOnce()
    expect(call()[1].body).not.toHaveProperty('categoryId')
  })
  it('does not send a reason-only/no-op command', async () => {
    const { wrapper } = await render()
    await wrapper.get('#draft-reason').setValue('Motivo sin cambios')
    await invoke(wrapper, 'saveMetadata')
    expect(requestMock).not.toHaveBeenCalled()
    expect(wrapper.get('[role="alert"]').text()).toContain('No hay cambios')
  })
  it.each([
    ['name', 'aa'],
    ['name', 'x'.repeat(161)],
    ['shortDesc', 'abcd'],
    ['shortDesc', 'x'.repeat(501)],
    ['description', 'abcd'],
    ['description', 'x'.repeat(10001)],
    ['usage', 'x'.repeat(2001)],
    ['series', 'x'.repeat(161)],
    ['categoryId', 999],
    ['categoryId', '8'],
    ['categoryId', null],
    ['featured', 'true'],
    ['badges', ['eco', 'eco']],
    ['badges', ['unknown']],
    ['visual', { type: 'unknown', color: '#123456' }],
    ['visual', { type: 'caja', color: '#123' }],
    ['attrs', [{ k: '', v: 'Valor' }]],
    ['attrs', [{ k: 'x'.repeat(101), v: 'Valor' }]],
    ['attrs', [{ k: 'Nombre', v: 'x'.repeat(1001) }]],
    ['attrs', Array.from({ length: 51 }, () => ({ k: 'Nombre', v: 'Valor' }))]
  ])('rejects invalid programmatic %s metadata without any request', async (field, value) => {
    const { wrapper } = await render()
    await prepare(wrapper)
    Object.assign(state(wrapper).form as object, { [field as string]: value })
    await invoke(wrapper, 'saveMetadata')
    expect(requestMock).not.toHaveBeenCalled()
    expect(wrapper.find('[role="alert"]').exists()).toBe(true)
  })
  it.each(['aa', 'x'.repeat(501)])('validates a mandatory bounded change reason (%s)', async (reason) => {
    const { wrapper } = await render()
    await prepare(wrapper)
    state(wrapper).reason = reason
    await invoke(wrapper, 'saveMetadata')
    expect(requestMock).not.toHaveBeenCalled()
    expect(wrapper.get('[role="alert"]').text()).toContain('motivo')
  })
  it('supports bounded ordered attribute actions and suppresses double submission while loading', async () => {
    const { wrapper } = await render()
    await invoke(wrapper, 'addAttribute')
    await wrapper.get('#draft-attribute-name-1').setValue('Tamaño')
    await wrapper.get('#draft-attribute-value-1').setValue('Grande')
    await invoke(wrapper, 'moveAttribute', 1, -1)
    expect((wrapper.get('#draft-attribute-name-0').element as HTMLInputElement).value).toBe('Tamaño')
    let finish!: (value: unknown) => void
    requestMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    await prepare(wrapper)
    const pending = invoke(wrapper, 'saveMetadata')
    await flushPromises()
    expect(wrapper.get('form').attributes('aria-busy')).toBe('true')
    expect(wrapper.get('fieldset').attributes('disabled')).toBeDefined()
    await invoke(wrapper, 'saveMetadata')
    await invoke(wrapper, 'removeAttribute', 0)
    expect(requestMock).toHaveBeenCalledOnce()
    expect(wrapper.findAll('[data-draft-attribute]')).toHaveLength(2)
    finish(receipt())
    await pending
  })
})

describe('fail-closed metadata authority', () => {
  it.each([
    { runtime: 'node' },
    { runtime: '' },
    { runtime: 'Cloudflare' },
    { runtime: 'unknown' },
    { runtime: undefined },
    { runtime: null }
  ])('never maps runtime $runtime to the Node or draft write contract', async ({ runtime }) => {
    const { wrapper } = await render({ runtime })
    Object.assign(state(wrapper).form as object, { name: 'Forged command' })
    state(wrapper).reason = 'Forged reason'
    await invoke(wrapper, 'saveMetadata')
    await invoke(wrapper, 'retry')
    expect(requestMock).not.toHaveBeenCalled()
    expect(wrapper.find('form').exists()).toBe(false)
  })
  it.each([
    { source: undefined },
    { source: 'node' },
    { status: 'published' },
    { status: 'review' },
    { catalogVersion: 0 },
    { catalogVersion: '1' },
    { catalogVersion: Number.MAX_SAFE_INTEGER + 1 },
    { uuid: 'malformed' },
    { id: 2 },
    { capabilities: {} },
    { capabilities: { productDetailRead: true, productMetadataUpdate: 'true' } },
    { capabilities: { productDetailRead: true, productMetadataUpdate: false, productUpdate: true } },
    { capabilities: null }
  ])('rejects revoked or malformed product authority %#', async (override) => {
    const value = Object.assign(product(), override)
    const { wrapper } = await render({ product: value })
    Object.assign(state(wrapper).form as object, { name: 'Forged command' })
    state(wrapper).reason = 'Forged reason'
    await invoke(wrapper, 'saveMetadata')
    expect(requestMock).not.toHaveBeenCalled()
    expect(wrapper.find('form').exists()).toBe(false)
  })
  it.each(['source', 'uuid', 'catalogVersion', 'status'])(
    'requires own data field %s rather than inherited read authority',
    async (field) => {
      const value = product()
      const inherited = { [field]: value[field as keyof PrivateProduct] }
      Reflect.deleteProperty(value, field)
      Object.setPrototypeOf(value, inherited)
      const { wrapper } = await render({ product: value })
      await invoke(wrapper, 'saveMetadata')
      expect(wrapper.find('form').exists()).toBe(false)
      expect(requestMock).not.toHaveBeenCalled()
    }
  )
  it('rejects inherited/read getter capabilities, even when broad productUpdate is forged true', async () => {
    const value = product()
    value.capabilities = Object.assign(Object.create({ productMetadataUpdate: true }), {
      productDetailRead: true,
      productUpdate: true
    })
    const { wrapper } = await render({ product: value })
    await invoke(wrapper, 'saveMetadata')
    expect(wrapper.find('form').exists()).toBe(false)
    expect(requestMock).not.toHaveBeenCalled()
  })
  it.each(['pending', 'error', 'idle'])('does not use a stale product read during %s', async (readStatus) => {
    const { wrapper } = await render({ readStatus })
    await invoke(wrapper, 'saveMetadata')
    expect(wrapper.find('form').exists()).toBe(false)
    expect(requestMock).not.toHaveBeenCalled()
  })
  it.each(['capability', 'status', 'version', 'source', 'runtime', 'readStatus'])(
    'rechecks %s before a cached submit callback',
    async (change) => {
      const { wrapper, data } = await render()
      await prepare(wrapper)
      const submit = state(wrapper).saveMetadata as () => Promise<void>
      if (change === 'capability') data.value.capabilities = { productDetailRead: true, productMetadataUpdate: false }
      if (change === 'status') data.value.status = 'published'
      if (change === 'version') data.value.catalogVersion = 2
      if (change === 'source') data.value.source = 'node'
      if (change === 'runtime') await wrapper.setProps({ runtime: 'unknown' })
      if (change === 'readStatus') await wrapper.setProps({ readStatus: 'pending' })
      await submit()
      expect(requestMock).not.toHaveBeenCalled()
    }
  )
  it.each(['01', '1.0', '0', '1e0', '9007199254740992'])(
    'requires the canonical numeric product route %s',
    async (productId) => {
      const { wrapper } = await render({ productId })
      await invoke(wrapper, 'saveMetadata')
      expect(wrapper.find('form').exists()).toBe(false)
      expect(requestMock).not.toHaveBeenCalled()
    }
  )
})

describe('immutable replay and explicit concurrency recovery', () => {
  it('retries an uncertain response with the exact frozen key/body even after a read observes the committed version', async () => {
    requestMock.mockRejectedValueOnce(new Error('Synthetic lost response'))
    const { wrapper, data } = await render()
    await prepare(wrapper)
    await invoke(wrapper, 'saveMetadata')
    const first = requestMock.mock.calls[0]![1]
    expect(wrapper.text()).toContain('No podemos confirmar')
    expect(wrapper.get('fieldset').attributes('disabled')).toBeDefined()
    data.value.catalogVersion = 2
    Object.assign(state(wrapper).form as object, { name: 'Programmatic new content ignored by retry' })
    state(wrapper).reason = 'Programmatic changed reason ignored by retry'
    await invoke(wrapper, 'retry')
    expect(requestMock).toHaveBeenCalledTimes(2)
    expect(call()[1]).toEqual(first)
    expect(call()[1].body.name).toBe('Nombre actualizado')
    expect(call()[1].body.expectedVersion).toBe(1)
    expect(wrapper.text()).toContain('Metadatos guardados')
  })
  it.each(['capability', 'status', 'source', 'runtime', 'readStatus'])(
    'blocks a cached uncertain retry on %s revocation',
    async (change) => {
      requestMock.mockRejectedValueOnce(new Error('Synthetic lost response'))
      const { wrapper, data } = await render()
      await prepare(wrapper)
      await invoke(wrapper, 'saveMetadata')
      const retry = state(wrapper).retry as () => Promise<void>
      if (change === 'capability') data.value.capabilities = { productDetailRead: true, productMetadataUpdate: false }
      if (change === 'status') data.value.status = 'published'
      if (change === 'source') data.value.source = 'node'
      if (change === 'runtime') await wrapper.setProps({ runtime: 'unknown' })
      if (change === 'readStatus') await wrapper.setProps({ readStatus: 'error' })
      await retry()
      expect(requestMock).toHaveBeenCalledOnce()
      expect(wrapper.text()).not.toContain('Metadatos guardados')
    }
  )
  it.each([
    'conflict',
    'csrf_rejected',
    'version_conflict',
    'idempotency_conflict',
    'product_not_editable',
    'forbidden',
    'mfa_required'
  ])('shows %s and requires explicit refetch instead of silently replacing version or key', async (code) => {
    requestMock.mockRejectedValueOnce({ data: { error: { code } } })
    const { wrapper, data, reload } = await render()
    await prepare(wrapper)
    await invoke(wrapper, 'saveMetadata')
    expect(wrapper.find('[role="alert"]').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('No podemos confirmar si el cambio se guardó')
    expect(reload).not.toHaveBeenCalled()
    await invoke(wrapper, 'saveMetadata')
    await invoke(wrapper, 'retry')
    expect(requestMock).toHaveBeenCalledOnce()
    const originalKey = call()[1].headers['Idempotency-Key']
    reload.mockImplementationOnce(async () => {
      data.value.catalogVersion = 2
      data.value.name = 'Versión nueva consultada'
    })
    await invoke(wrapper, 'reload')
    expect(reload).toHaveBeenCalledOnce()
    await prepare(wrapper, 'Cambio deliberado tras consultar')
    requestMock.mockResolvedValueOnce(receipt(3))
    await invoke(wrapper, 'saveMetadata')
    expect(requestMock).toHaveBeenCalledTimes(2)
    expect(call()[1].body.expectedVersion).toBe(2)
    expect(call()[1].headers['Idempotency-Key']).not.toBe(originalKey)
  })
  it.each(['body_too_large', 'rate_limited', 'invalid_input'])(
    'handles deterministic %s rejection without claiming a lost response',
    async (code) => {
      requestMock.mockRejectedValueOnce({ data: { error: { code } } })
      const { wrapper } = await render()
      await prepare(wrapper)
      await invoke(wrapper, 'saveMetadata')
      expect(wrapper.find('[role="alert"]').exists()).toBe(true)
      expect(wrapper.text()).not.toContain('No podemos confirmar')
      expect(wrapper.text()).not.toContain('Reintentar el mismo cambio')
      expect(wrapper.text()).not.toContain('Metadatos guardados')
    }
  )
  it.each([0, 1, 3, 999, '2', null])(
    'never announces success for a non-exact receipt version %j',
    async (catalogVersion) => {
      requestMock.mockResolvedValueOnce(receipt(catalogVersion))
      const { wrapper, reload } = await render()
      await prepare(wrapper)
      await invoke(wrapper, 'saveMetadata')
      expect(reload).not.toHaveBeenCalled()
      expect(wrapper.text()).not.toContain('Metadatos guardados')
      expect(wrapper.text()).toContain('Reintentar el mismo cambio')
    }
  )
  it('retains frozen retry identity when explicit refetch fails rather than minting another command', async () => {
    requestMock.mockRejectedValueOnce(new Error('Synthetic lost response'))
    const { wrapper, reload } = await render()
    await prepare(wrapper)
    await invoke(wrapper, 'saveMetadata')
    const first = call()[1]
    reload.mockRejectedValueOnce(new Error('Synthetic failed read'))
    await invoke(wrapper, 'reload')
    expect(wrapper.text()).toContain('Tus cambios no se han vuelto a enviar')
    await invoke(wrapper, 'retry')
    expect(call()[1]).toEqual(first)
  })
})
