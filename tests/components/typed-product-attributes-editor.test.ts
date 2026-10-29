import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Editor from '../../app/components/TypedProductAttributesEditor.vue'
import ReferencePicker from '../../app/components/ReferencePicker.vue'
import '#app/nuxt-vitest-app-entry'

const { request, session } = vi.hoisted(() => ({ request: vi.fn(), session: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => request)
mockNuxtImport('useUserSession', () => session)
// Nuxt boot resolves '/' before this isolated editor mounts. Isolate only the
// unrelated homepage; the editor, picker and children remain real. This does
// not replace compiled-browser navigation acceptance or extend setup timeouts.
vi.mock('../../app/pages/index.vue', () => ({ default: { render: () => null } }))
const ACTOR = 'b1000000-0000-4000-8000-000000000007',
  REFERENCE = 'b2000000-0000-4000-8000-000000000007'
const ROOT = '/api/admin/catalog-attributes/products/1'
const kinds = ['text', 'number', 'unit', 'boolean', 'list', 'reference'] as const
const ids = kinds.map((_, index) => `b3000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`)
const definitions = () =>
  kinds.map((kind, index) => ({
    id: ids[index]!,
    categoryId: 7,
    categoryUuid: 'c7',
    code: kind,
    kind,
    label: `Campo ${kind}`,
    revision: 1,
    status: 'active',
    config:
      kind === 'text'
        ? { maxLength: 500 }
        : kind === 'number'
          ? { precision: 2, min: -10, max: 10 }
          : kind === 'unit'
            ? { precision: 2, units: ['ml', 'l'] }
            : kind === 'list'
              ? {
                  options: [
                    { code: 'blue', label: 'Azul', status: 'active' },
                    { code: 'green', label: 'Verde', status: 'active' }
                  ]
                }
              : {}
  }))
const product = () => ({ id: 1, uuid: 'p1', categoryId: 7, categoryUuid: 'c7', catalogVersion: 7, status: 'draft' })
const view = () => ({
  source: 'cloudflare',
  product: product(),
  typed: { version: 1, values: [] as unknown[] },
  definitions: definitions(),
  capabilities: { read: true, update: true }
})
const receipt = (typed: unknown) => ({
  source: 'cloudflare',
  action: 'update_values',
  commandId: ACTOR,
  productId: 1,
  productUuid: 'p1',
  catalogVersion: 8,
  typed,
  updated: true
})
const identity = () => ({
  ready: ref(true),
  loggedIn: ref(true),
  user: ref<Record<string, unknown>>({
    id: ACTOR,
    role: 'admin',
    emailVerified: true,
    mfaVerified: true
  })
})
let actor: ReturnType<typeof identity>
const mounted: Array<{ unmount(): void }> = []
async function mount(props: Record<string, unknown> = {}) {
  const wrapper = await mountSuspended(Editor, {
    props: {
      runtime: 'cloudflare',
      available: true,
      product: { ...product(), attrs: [{ k: 'Legacy', v: 'Conservar' }] },
      ...props
    }
  })
  mounted.push(wrapper)
  return wrapper
}
async function load(wrapper: Awaited<ReturnType<typeof mount>>) {
  await wrapper.get('[data-typed-load]').trigger('click')
  await flushPromises()
}
async function confirm(wrapper: Awaited<ReturnType<typeof mount>>) {
  await wrapper.get('[data-typed-reason]').setValue('Valores explícitamente revisados')
  await wrapper.get('[data-typed-confirm]').setValue(true)
}
beforeEach(() => {
  vi.clearAllMocks()
  actor = identity()
  session.mockReturnValue(actor)
  request.mockResolvedValue(view())
})
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount()
  vi.restoreAllMocks()
})

describe('governed typed product values', () => {
  it('revokes on late private denial for the same authority even after changing search text', async () => {
    const wrapper = await mount()
    await load(wrapper)
    await wrapper.get(`[data-typed-presence="${ids[5]}"]`).setValue(true)
    await wrapper.get('[data-reference-query]').setValue('Jabón')
    let deny!: (error: unknown) => void
    request.mockImplementation((url: string) =>
      url === '/api/admin/products'
        ? new Promise((_resolve, reject) => {
            deny = reject
          })
        : Promise.reject(Object.assign(new Error('public unavailable'), { statusCode: 503 }))
    )
    await wrapper.get('[data-reference-search]').trigger('click')
    await wrapper.get('[data-reference-query]').setValue('Otro')
    deny(Object.assign(new Error('auth revoked'), { statusCode: 401 }))
    await flushPromises()
    expect(wrapper.find('[data-typed-form]').exists()).toBe(false)
  })

  it('does not emit a manual UUID edit from a programmatic disabled input event', async () => {
    const wrapper = await mountSuspended(ReferencePicker, {
      props: {
        modelValue: REFERENCE,
        definitionId: ids[5]!,
        label: 'Referencia',
        selfId: 'p1',
        available: false,
        authority: 'owner'
      }
    })
    mounted.push(wrapper)
    const input = wrapper.get('[data-typed-input]').element as HTMLInputElement
    input.value = ACTOR
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    expect(request.mock.calls).toHaveLength(0)
  })

  it('does not repaint a deferred selected name after invalidating the picker authority', async () => {
    const wrapper = await mountSuspended(ReferencePicker, {
      props: {
        modelValue: '',
        definitionId: ids[5]!,
        label: 'Referencia',
        selfId: 'p1',
        available: true,
        authority: 'owner',
        'onUpdate:modelValue': (value: string) => {
          void wrapper.setProps({ modelValue: value })
        }
      }
    })
    mounted.push(wrapper)
    request.mockImplementation(async (url: string) =>
      url === '/api/admin/products'
        ? {
            source: 'cloudflare',
            capabilities: { productsRead: true },
            items: [],
            pagination: { page: 1, perPage: 1, total: 0, pages: 0 }
          }
        : {
            items: [
              { uuid: REFERENCE, id: 2, categoryId: 7, name: 'Nombre anterior', slug: 'anterior', brand: 'NETECO' }
            ],
            total: 1,
            page: 1,
            pages: 1
          }
    )
    await wrapper.get('[data-reference-query]').setValue('Jabón')
    await wrapper.get('[data-reference-search]').trigger('click')
    await flushPromises()
    wrapper.get('[data-reference-option]').element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await wrapper.setProps({ modelValue: REFERENCE, authority: 'new-owner' })
    await flushPromises()
    expect(wrapper.text()).not.toContain('Seleccionado: Nombre anterior')
  })

  it('bounds explicit Enter searches, shows loading, excludes self and never writes while choosing', async () => {
    const ownProduct = { ...product(), uuid: REFERENCE }
    request.mockResolvedValue({ ...view(), product: ownProduct })
    const wrapper = await mount({ product: ownProduct })
    await load(wrapper)
    await wrapper.get(`[data-typed-presence="${ids[5]}"]`).setValue(true)
    const query = wrapper.get('[data-reference-query]')
    request.mockClear()
    for (const invalid of ['x', 'x'.repeat(101)]) {
      await query.setValue(invalid)
      await query.trigger('keydown', { key: 'Enter' })
      expect(request).not.toHaveBeenCalled()
    }
    await query.setValue('Jabón')
    let finish!: (value: unknown) => void
    request.mockImplementation((url: string) =>
      url === '/api/admin/products'
        ? Promise.resolve({
            source: 'cloudflare',
            capabilities: { productsRead: true },
            items: [],
            pagination: { page: 1, perPage: 1, total: 0, pages: 0 }
          })
        : new Promise((resolve) => {
            finish = resolve
          })
    )
    await query.trigger('keydown', { key: 'Enter' })
    expect(wrapper.get('[data-reference-search]').attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('Buscando…')
    finish({
      items: [{ uuid: REFERENCE, id: 1, categoryId: 7, name: 'Este producto', slug: 'este', brand: 'NETECO' }],
      total: 1,
      page: 1,
      pages: 1
    })
    await flushPromises()
    expect(wrapper.find('[data-reference-option]').exists()).toBe(false)
    expect(wrapper.text()).toContain('Sin coincidencias públicas')
    expect(request.mock.calls).toHaveLength(2)
  })

  it('freezes reference lookup with the uncertain command without mutating its UUID or retry body', async () => {
    const wrapper = await mount()
    await load(wrapper)
    await wrapper.get(`[data-typed-presence="${ids[5]}"]`).setValue(true)
    await wrapper.get(`[data-typed-input="${ids[5]}"]`).setValue(REFERENCE)
    await wrapper.get('[data-reference-query]').setValue('Jabón')
    await confirm(wrapper)
    request.mockRejectedValueOnce(new Error('lost response'))
    await wrapper.get('[data-typed-form]').trigger('submit')
    await flushPromises()
    expect(wrapper.get('[data-reference-search]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-reference-query]').attributes('disabled')).toBeDefined()
    const before = request.mock.calls.length
    await wrapper.get('[data-reference-search]').trigger('click')
    expect(request.mock.calls).toHaveLength(before)
    expect(wrapper.get(`[data-typed-input="${ids[5]}"]`).element).toHaveProperty('value', REFERENCE)
  })

  it('ignores late reference results after the search text or parent authorization changes', async () => {
    for (const revokeParent of [false, true]) {
      request.mockResolvedValue(view())
      const wrapper = await mount()
      await load(wrapper)
      await wrapper.get(`[data-typed-presence="${ids[5]}"]`).setValue(true)
      await wrapper.get('[data-reference-query]').setValue('Jabón')
      let finish!: (value: unknown) => void
      request.mockImplementation((url: string) =>
        url === '/api/admin/products'
          ? Promise.resolve({
              source: 'cloudflare',
              capabilities: { productsRead: true },
              items: [],
              pagination: { page: 1, perPage: 1, total: 0, pages: 0 }
            })
          : new Promise((resolve) => {
              finish = resolve
            })
      )
      await wrapper.get('[data-reference-search]').trigger('click')
      if (revokeParent) await wrapper.setProps({ available: false })
      else await wrapper.get('[data-reference-query]').setValue('Otro')
      finish({
        items: [{ uuid: REFERENCE, id: 2, categoryId: 7, name: 'Anterior', slug: 'anterior', brand: 'NETECO' }],
        total: 1,
        page: 1,
        pages: 1
      })
      await flushPromises()
      expect(wrapper.find('[data-reference-option]').exists()).toBe(false)
      expect(request.mock.calls.some(([, options]) => options?.method === 'PUT')).toBe(false)
      wrapper.unmount()
    }
  })

  it.each(['capability', 'uuid', 'too-many'])('fails closed on malformed reference lookup %s', async (failure) => {
    const wrapper = await mount()
    await load(wrapper)
    await wrapper.get(`[data-typed-presence="${ids[5]}"]`).setValue(true)
    await wrapper.get('[data-reference-query]').setValue('Jabón')
    request.mockImplementation(async (url: string) =>
      url === '/api/admin/products'
        ? {
            source: 'cloudflare',
            capabilities: { productsRead: failure !== 'capability' },
            items: [],
            pagination: { page: 1, perPage: 1, total: 0, pages: 0 }
          }
        : {
            items: Array.from({ length: failure === 'too-many' ? 21 : 1 }, () => ({
              uuid: failure === 'uuid' ? 'not-a-uuid' : REFERENCE,
              id: 2,
              categoryId: 7,
              name: 'Público',
              slug: 'publico',
              brand: 'NETECO'
            })),
            total: 21,
            page: 1,
            pages: 2
          }
    )
    await wrapper.get('[data-reference-search]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-reference-option]').exists()).toBe(false)
    expect(wrapper.text()).toContain('No se han podido consultar')
  })

  it('searches reference candidates explicitly through live admin authority and public results, retaining UUID payloads', async () => {
    const wrapper = await mount()
    await load(wrapper)
    await wrapper.get(`[data-typed-presence="${ids[5]}"]`).setValue(true)
    request.mockClear()
    await wrapper.get('[data-reference-query]').setValue('Jabón')
    await flushPromises()
    expect(request).not.toHaveBeenCalled()
    request.mockImplementation(async (url: string, options?: { method?: string; body?: string }) => {
      if (url === '/api/admin/products')
        return {
          source: 'cloudflare',
          capabilities: { productsRead: true },
          items: [],
          pagination: { page: 1, perPage: 1, total: 0, pages: 0 }
        }
      if (url === '/api/products')
        return {
          items: [
            { uuid: REFERENCE, id: 2, categoryId: 7, name: 'Jabón público', slug: 'jabon-publico', brand: 'NETECO' }
          ],
          total: 1,
          page: 1,
          pages: 1
        }
      if (url === ROOT && options?.method === 'PUT') return receipt(JSON.parse(options.body!).typed)
      throw new Error('Unexpected reference request')
    })
    await wrapper.get('[data-reference-search]').trigger('click')
    await flushPromises()
    expect(request).toHaveBeenCalledWith(
      '/api/admin/products',
      expect.objectContaining({
        query: { q: 'Jabón', status: 'published', page: 1, perPage: 1 }
      })
    )
    expect(request).toHaveBeenCalledWith(
      '/api/products',
      expect.objectContaining({
        query: { q: 'Jabón', page: 1, limit: 20 }
      })
    )
    await wrapper.get(`[data-reference-option="${REFERENCE}"]`).trigger('click')
    expect(wrapper.text()).toContain('Seleccionado: Jabón público')
    expect(wrapper.get(`[data-typed-input="${ids[5]}"]`).element).toHaveProperty('value', REFERENCE)
    await confirm(wrapper)
    await wrapper.get('[data-typed-form]').trigger('submit')
    await flushPromises()
    const mutation = request.mock.calls.find(([, options]) => options?.method === 'PUT')
    expect(JSON.parse(mutation![1].body).typed.values).toEqual([
      { definitionId: ids[5], revision: 1, value: REFERENCE }
    ])
  })

  it.each([401, 403])('revokes the editor when reference lookup returns live HTTP %s denial', async (status) => {
    const wrapper = await mount()
    await load(wrapper)
    await wrapper.get(`[data-typed-presence="${ids[5]}"]`).setValue(true)
    await wrapper.get('[data-reference-query]').setValue('Jabón')
    request.mockRejectedValue(Object.assign(new Error('denied'), { statusCode: status }))
    await wrapper.get('[data-reference-search]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-typed-form]').exists()).toBe(false)
    expect(request.mock.calls.some(([, options]) => options?.method === 'PUT')).toBe(false)
  })

  it.each([401, 403])('revokes cached write authority after HTTP %s, including recovery reads', async (status) => {
    for (const deniedRead of [false, true]) {
      const wrapper = await mount()
      await load(wrapper)
      await confirm(wrapper)
      request.mockRejectedValueOnce(
        deniedRead ? new Error('network') : Object.assign(new Error('private'), { statusCode: status })
      )
      await wrapper.get('[data-typed-form]').trigger('submit')
      await flushPromises()
      if (deniedRead) {
        request.mockRejectedValueOnce(Object.assign(new Error('private'), { statusCode: status }))
        await load(wrapper)
      }
      expect(wrapper.find('[data-typed-retry]').exists()).toBe(false)
      expect(wrapper.find('[data-typed-form]').exists()).toBe(false)
      expect(wrapper.text()).not.toContain('private')
      const calls = request.mock.calls.length
      await flushPromises()
      expect(request).toHaveBeenCalledTimes(calls)
      request.mockResolvedValueOnce(view())
      await load(wrapper)
      expect(wrapper.find('[data-typed-form]').exists()).toBe(true)
      expect(wrapper.find('[data-typed-retry]').exists()).toBe(false)
    }
  })
  it('allows explicit discard of a known 409 only after fresh GET, preserving draft and replacing key/version', async () => {
    const wrapper = await mount()
    await load(wrapper)
    await wrapper.get(`[data-typed-presence="${ids[0]}"]`).setValue(true)
    await wrapper.get(`[data-typed-input="${ids[0]}"]`).setValue('Borrador Ñ')
    await confirm(wrapper)
    request.mockRejectedValueOnce(
      Object.assign(new Error('private'), { statusCode: 409, data: { error: { code: 'version_conflict' } } })
    )
    await wrapper.get('[data-typed-form]').trigger('submit')
    await flushPromises()
    const original = request.mock.calls.at(-1)![1]
    expect(wrapper.find('[data-typed-discard]').exists()).toBe(false)
    request.mockResolvedValueOnce({ ...view(), product: { ...product(), catalogVersion: 8 } })
    await load(wrapper)
    expect(request).toHaveBeenCalledTimes(3)
    await wrapper.get('[data-typed-discard]').trigger('click')
    expect((wrapper.get(`[data-typed-input="${ids[0]}"]`).element as HTMLInputElement).value).toBe('Borrador Ñ')
    expect(wrapper.get('[data-typed-save]').attributes('disabled')).toBeDefined()
    await wrapper.get('[data-typed-confirm]').setValue(true)
    const typed = JSON.parse(original.body).typed
    request.mockResolvedValueOnce({ ...receipt(typed), catalogVersion: 9 })
    await wrapper.get('[data-typed-form]').trigger('submit')
    await flushPromises()
    const next = request.mock.calls.at(-1)![1]
    expect(JSON.parse(next.body)).toEqual({ ...JSON.parse(original.body), expectedVersion: 8 })
    expect(next.headers['Idempotency-Key']).not.toBe(original.headers['Idempotency-Key'])
    expect(JSON.parse(original.body).expectedVersion).toBe(7)
  })
  it.each([undefined, 'unrecognized'])('never discards an ambiguous outcome after GET (%s)', async (code) => {
    const wrapper = await mount()
    await load(wrapper)
    await confirm(wrapper)
    request.mockRejectedValueOnce(
      code ? Object.assign(new Error('private'), { statusCode: 409, data: { error: { code } } }) : new Error('network')
    )
    await wrapper.get('[data-typed-form]').trigger('submit')
    await flushPromises()
    const original = request.mock.calls.at(-1)
    await load(wrapper)
    expect(wrapper.find('[data-typed-discard]').exists()).toBe(false)
    request.mockResolvedValueOnce(receipt({ version: 1, values: [] }))
    await wrapper.get('[data-typed-retry]').trigger('click')
    await flushPromises()
    expect(request.mock.calls.at(-1)).toEqual(original)
  })
  it.each([{ runtime: 'node' }, { available: false }, { product: null }])(
    'does not expose reads or mutations in invalid context %j',
    async (props) => {
      expect((await mount(props)).find('[data-typed-load]').exists()).toBe(false)
      expect(request).not.toHaveBeenCalled()
    }
  )
  it('requires explicit GET and renders the six current definition controls', async () => {
    const wrapper = await mount()
    expect(request).not.toHaveBeenCalled()
    await load(wrapper)
    expect(request).toHaveBeenCalledExactlyOnceWith(
      ROOT,
      expect.objectContaining({ method: 'GET', cache: 'no-store', retry: 0 })
    )
    for (const id of ids) expect(wrapper.find(`[data-typed-presence="${id}"]`).exists()).toBe(true)
  })
  it('submits six strictly typed values with zero/false distinct from absence, without legacy attrs', async () => {
    const wrapper = await mount()
    await load(wrapper)
    for (const id of ids) await wrapper.get(`[data-typed-presence="${id}"]`).setValue(true)
    await wrapper.get(`[data-typed-input="${ids[0]}"]`).setValue('<b>Ñ 🧼</b>')
    await wrapper.get(`[data-typed-input="${ids[1]}"]`).setValue('0')
    await wrapper.get(`[data-typed-input="${ids[2]}"]`).setValue('0')
    await wrapper.get(`[data-typed-unit="${ids[2]}"]`).setValue('ml')
    await wrapper.get(`[data-typed-input="${ids[3]}"]`).setValue('false')
    await wrapper.get(`[data-typed-option="${ids[4]}:blue"]`).setValue(true)
    await wrapper.get(`[data-typed-input="${ids[5]}"]`).setValue(REFERENCE)
    const typed = {
      version: 1,
      values: ['<b>Ñ 🧼</b>', 0, { quantity: 0, unit: 'ml' }, false, ['blue'], REFERENCE].map((value, index) => ({
        definitionId: ids[index],
        revision: 1,
        value
      }))
    }
    await confirm(wrapper)
    request.mockResolvedValueOnce(receipt(typed))
    await wrapper.get('[data-typed-form]').trigger('submit')
    await flushPromises()
    expect(request.mock.calls.at(-1)).toEqual([
      ROOT,
      expect.objectContaining({
        method: 'PUT',
        retry: 0,
        body: JSON.stringify({ expectedVersion: 7, reason: 'Valores explícitamente revisados', typed }),
        headers: expect.objectContaining({ 'Idempotency-Key': expect.stringMatching(/^[0-9a-f-]{36}$/) })
      })
    ])
    expect(wrapper.emitted('completed')?.[0]).toEqual([receipt(typed)])
    expect(wrapper.find('b').exists()).toBe(false)
    expect(request).toHaveBeenCalledTimes(2)
  })
  it('omits unchecked fields, not false or zero, and never coerces invalid numeric or reference input', async () => {
    const wrapper = await mount()
    await load(wrapper)
    await wrapper.get(`[data-typed-presence="${ids[1]}"]`).setValue(true)
    await wrapper.get(`[data-typed-input="${ids[1]}"]`).setValue('0.001')
    await confirm(wrapper)
    expect(wrapper.get('[data-typed-save]').attributes('disabled')).toBeDefined()
    await wrapper.get(`[data-typed-input="${ids[1]}"]`).setValue('0')
    await wrapper.get(`[data-typed-presence="${ids[5]}"]`).setValue(true)
    for (const invalid of ['https://example.invalid', 'p1', 'not-uuid']) {
      await wrapper.get(`[data-typed-input="${ids[5]}"]`).setValue(invalid)
      expect(wrapper.get('[data-typed-save]').attributes('disabled')).toBeDefined()
    }
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('preserves historical revisions unchanged and only removes them on explicit user choice', async () => {
    const historical = { definitionId: ids[0], revision: 1, value: 'Original Ñ' }
    const data = view()
    data.typed.values = [historical]
    data.definitions.push({ ...data.definitions[0]!, revision: 2, label: 'Nueva etiqueta', status: 'retired' })
    request.mockResolvedValueOnce(data)
    const wrapper = await mount()
    await load(wrapper)
    expect(wrapper.get(`[data-typed-historical="${ids[0]}"]`).text()).toContain('Original Ñ')
    expect(wrapper.find(`[data-typed-input="${ids[0]}"]`).exists()).toBe(false)
    await confirm(wrapper)
    request.mockResolvedValueOnce(receipt(data.typed))
    await wrapper.get('[data-typed-form]').trigger('submit')
    await flushPromises()
    expect(JSON.parse(request.mock.calls.at(-1)![1].body).typed.values).toEqual([historical])
    request.mockResolvedValueOnce({ ...data, product: { ...product(), catalogVersion: 8 } })
    await load(wrapper)
    await wrapper.get(`[data-typed-remove="${ids[0]}"]`).trigger('click')
    expect(wrapper.find(`[data-typed-historical="${ids[0]}"]`).exists()).toBe(false)
  })
  it('does not authorize values from a foreign product GET, published state, or update:false', async () => {
    for (const change of [
      { product: { ...product(), uuid: 'foreign' } },
      { product: { ...product(), status: 'published' } },
      { capabilities: { read: true, update: false } }
    ]) {
      request.mockResolvedValueOnce({ ...view(), ...change })
      const wrapper = await mount()
      await load(wrapper)
      expect(
        wrapper.find('[data-typed-save]').exists() ? wrapper.get('[data-typed-save]').attributes('disabled') : 'missing'
      ).toBeDefined()
    }
  })
  it('preserves an uncertain request body/key through explicit read and same-intent retry', async () => {
    const wrapper = await mount()
    await load(wrapper)
    await confirm(wrapper)
    request.mockRejectedValueOnce(new Error('SELECT private'))
    await wrapper.get('[data-typed-form]').trigger('submit')
    await flushPromises()
    const original = request.mock.calls.at(-1)
    expect(wrapper.get('[data-typed-reason]').attributes('disabled')).toBeDefined()
    request.mockResolvedValueOnce(view())
    await load(wrapper)
    request.mockResolvedValueOnce(receipt({ version: 1, values: [] }))
    await wrapper.get('[data-typed-retry]').trigger('click')
    await flushPromises()
    expect(request.mock.calls.at(-1)).toEqual(original)
    expect(wrapper.text()).not.toContain('SELECT')
    expect(request.mock.calls.filter(([, options]) => options.method === 'PUT')).toHaveLength(2)
  })
  it.each(['owner', 'mfa', 'capability', 'product', 'category'])(
    'invalidates a late response and retained replay after %s drift',
    async (change) => {
      const wrapper = await mount()
      await load(wrapper)
      await confirm(wrapper)
      let resolve!: (value: unknown) => void
      request.mockReturnValueOnce(
        new Promise((done) => {
          resolve = done
        })
      )
      await wrapper.get('[data-typed-form]').trigger('submit')
      if (change === 'owner') actor.user.value.id = REFERENCE
      if (change === 'mfa') actor.user.value.mfaVerified = false
      if (change === 'capability') await wrapper.setProps({ available: false })
      if (change === 'product') await wrapper.setProps({ product: { ...product(), catalogVersion: 8 } })
      if (change === 'category') await wrapper.setProps({ product: { ...product(), categoryUuid: 'foreign-category' } })
      resolve(receipt({ version: 1, values: [] }))
      await flushPromises()
      expect(wrapper.emitted('completed')).toBeUndefined()
      expect(wrapper.find('[data-typed-retry]').exists()).toBe(false)
    }
  )
})
