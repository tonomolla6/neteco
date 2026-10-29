import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Editor from '../../app/components/CategoryAttributeDefinitionsEditor.vue'
import '#app/nuxt-vitest-app-entry'

const { request, session } = vi.hoisted(() => ({ request: vi.fn(), session: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => request)
mockNuxtImport('useUserSession', () => session)
const DEF = 'a1000000-0000-4000-8000-000000000007',
  ACTOR = 'a2000000-0000-4000-8000-000000000007'
const CATEGORY = 'a3000000-0000-4000-8000-000000000007',
  ROOT = '/api/admin/catalog-attributes/definitions'
const definition = (kind = 'text', config: unknown = { maxLength: 500 }) => ({
  id: DEF,
  categoryId: 7,
  categoryUuid: CATEGORY,
  code: 'material',
  kind,
  label: 'Material',
  revision: 1,
  status: 'active',
  config
})
const response = (definitions = [definition()]) => ({
  source: 'cloudflare',
  categoryId: 7,
  categoryUuid: CATEGORY,
  definitions,
  capabilities: { read: true, create: true, update: true, retire: true }
})
const receipt = (action = 'create', value = definition()) => ({
  source: 'cloudflare',
  action,
  commandId: 'a4000000-0000-4000-8000-000000000007',
  definition: value,
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
    props: { runtime: 'cloudflare', available: true, categories: [{ id: 7, name: 'Higiene' }], ...props }
  })
  mounted.push(wrapper)
  return wrapper
}
async function load(wrapper: Awaited<ReturnType<typeof mount>>) {
  await wrapper.get('[data-definition-category]').setValue('7')
  await wrapper.get('[data-definitions-load]').trigger('click')
  await flushPromises()
}
async function confirm(wrapper: Awaited<ReturnType<typeof mount>>) {
  await wrapper.get('[data-definition-reason]').setValue('Definición explícitamente revisada')
  await wrapper.get('[data-definition-confirm]').setValue(true)
}
beforeEach(() => {
  vi.clearAllMocks()
  actor = identity()
  session.mockReturnValue(actor)
  request.mockResolvedValue(response())
})
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount()
  vi.restoreAllMocks()
})

describe('category typed attribute definitions editor', () => {
  it.each([401, 403])('revokes cached definition authority after HTTP %s, including recovery reads', async (status) => {
    for (const deniedRead of [false, true]) {
      const wrapper = await mount()
      await load(wrapper)
      await wrapper.get(`[data-definition-edit="${DEF}"]`).trigger('click')
      await confirm(wrapper)
      request.mockRejectedValueOnce(
        deniedRead ? new Error('network') : Object.assign(new Error('private'), { statusCode: status })
      )
      await wrapper.get('[data-definition-form]').trigger('submit')
      await flushPromises()
      if (deniedRead) {
        request.mockRejectedValueOnce(Object.assign(new Error('private'), { statusCode: status }))
        await load(wrapper)
      }
      expect(wrapper.find('[data-definition-retry]').exists()).toBe(false)
      expect(wrapper.find('[data-definition-form]').exists()).toBe(false)
      expect(wrapper.find('[data-definition-create]').exists()).toBe(false)
      expect(wrapper.text()).not.toContain('private')
      request.mockResolvedValueOnce(response())
      await load(wrapper)
      expect(wrapper.find('[data-definition-create]').exists()).toBe(true)
      expect(wrapper.find('[data-definition-retry]').exists()).toBe(false)
    }
  })
  it('allows explicit discard of a known 409 after fresh GET without losing the definition draft', async () => {
    const wrapper = await mount()
    await load(wrapper)
    await wrapper.get(`[data-definition-edit="${DEF}"]`).trigger('click')
    await wrapper.get('[data-definition-label]').setValue('Borrador Ñ')
    await confirm(wrapper)
    request.mockRejectedValueOnce(
      Object.assign(new Error('private'), { statusCode: 409, data: { error: { code: 'version_conflict' } } })
    )
    await wrapper.get('[data-definition-form]').trigger('submit')
    await flushPromises()
    const original = request.mock.calls.at(-1)![1]
    expect(wrapper.find('[data-definition-discard]').exists()).toBe(false)
    request.mockResolvedValueOnce(response([{ ...definition(), revision: 2 }]))
    await load(wrapper)
    expect(request).toHaveBeenCalledTimes(3)
    await wrapper.get('[data-definition-discard]').trigger('click')
    expect((wrapper.get('[data-definition-label]').element as HTMLInputElement).value).toBe('Borrador Ñ')
    expect((wrapper.get('[data-definition-confirm]').element as HTMLInputElement).checked).toBe(false)
    await wrapper.get('[data-definition-confirm]').setValue(true)
    request.mockResolvedValueOnce(receipt('update', { ...definition(), revision: 3, label: 'Borrador Ñ' }))
    await wrapper.get('[data-definition-form]').trigger('submit')
    await flushPromises()
    const next = request.mock.calls.at(-1)![1]
    expect(JSON.parse(next.body)).toEqual({ ...JSON.parse(original.body), expectedVersion: 2 })
    expect(next.headers['Idempotency-Key']).not.toBe(original.headers['Idempotency-Key'])
    expect(JSON.parse(original.body).expectedVersion).toBe(1)
  })
  it.each([undefined, 'unrecognized'])('never discards ambiguous definition outcomes after GET (%s)', async (code) => {
    const wrapper = await mount()
    await load(wrapper)
    await wrapper.get(`[data-definition-edit="${DEF}"]`).trigger('click')
    await confirm(wrapper)
    request.mockRejectedValueOnce(
      code ? Object.assign(new Error('private'), { statusCode: 409, data: { error: { code } } }) : new Error('network')
    )
    await wrapper.get('[data-definition-form]').trigger('submit')
    await flushPromises()
    const original = request.mock.calls.at(-1)
    await load(wrapper)
    expect(wrapper.find('[data-definition-discard]').exists()).toBe(false)
    request.mockResolvedValueOnce(receipt('update', { ...definition(), revision: 2 }))
    await wrapper.get('[data-definition-retry]').trigger('click')
    await flushPromises()
    expect(request.mock.calls.at(-1)).toEqual(original)
  })
  it.each([{ runtime: 'node' }, { available: false }, { available: 'true' }])(
    'fails closed outside current Cloudflare access %j',
    async (props) => {
      const wrapper = await mount(props)
      expect(wrapper.find('[data-definition-category]').exists()).toBe(false)
      expect(request).not.toHaveBeenCalled()
    }
  )
  it('never automatically reads/writes and loads only the explicitly selected category', async () => {
    const wrapper = await mount()
    expect(request).not.toHaveBeenCalled()
    await load(wrapper)
    expect(request).toHaveBeenCalledExactlyOnceWith(
      ROOT,
      expect.objectContaining({ method: 'GET', query: { categoryId: 7 }, retry: 0, cache: 'no-store' })
    )
    expect(wrapper.text()).toContain('Material')
  })
  it.each(['text', 'number', 'unit', 'boolean', 'list', 'reference'])(
    'supports explicit creation of a %s definition',
    async (kind) => {
      const wrapper = await mount()
      await load(wrapper)
      await wrapper.get('[data-definition-create]').trigger('click')
      await wrapper.get('[data-definition-code]').setValue('material')
      await wrapper.get('[data-definition-label]').setValue('Material')
      await wrapper.get('[data-definition-kind]').setValue(kind)
      if (kind === 'list') {
        await wrapper.get('[data-definition-option-add]').trigger('click')
        await wrapper.get('[data-definition-option-code]').setValue('azul')
        await wrapper.get('[data-definition-option-label]').setValue('Azul')
      }
      await confirm(wrapper)
      const config =
        kind === 'text'
          ? { maxLength: 500 }
          : kind === 'number'
            ? { precision: 0 }
            : kind === 'unit'
              ? { precision: 0, units: ['ud'] }
              : kind === 'list'
                ? { options: [{ code: 'azul', label: 'Azul', status: 'active' }] }
                : {}
      request.mockResolvedValueOnce(receipt('create', definition(kind, config)))
      await wrapper.get('[data-definition-form]').trigger('submit')
      await flushPromises()
      expect(request.mock.calls.at(-1)).toEqual([
        ROOT,
        expect.objectContaining({
          method: 'POST',
          retry: 0,
          body: expect.any(String),
          headers: expect.objectContaining({ 'Idempotency-Key': expect.stringMatching(/^[0-9a-f-]{36}$/) })
        })
      ])
      expect(JSON.parse(request.mock.calls.at(-1)![1].body)).toEqual({
        categoryId: 7,
        code: 'material',
        kind,
        label: 'Material',
        config,
        expectedVersion: 0,
        reason: 'Definición explícitamente revisada'
      })
      expect(wrapper.emitted('completed')).toHaveLength(1)
    }
  )
  it('revises and retires with exact current revision, never changing the stable code or kind', async () => {
    const wrapper = await mount()
    await load(wrapper)
    await wrapper.get(`[data-definition-edit="${DEF}"]`).trigger('click')
    expect(wrapper.get('[data-definition-code]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-definition-kind]').attributes('disabled')).toBeDefined()
    await wrapper.get('[data-definition-label]').setValue('Material revisado')
    await confirm(wrapper)
    request.mockResolvedValueOnce(receipt('update', { ...definition(), label: 'Material revisado', revision: 2 }))
    await wrapper.get('[data-definition-form]').trigger('submit')
    await flushPromises()
    expect(JSON.parse(request.mock.calls.at(-1)![1].body)).toEqual({
      action: 'update',
      label: 'Material revisado',
      config: { maxLength: 500 },
      expectedVersion: 1,
      reason: 'Definición explícitamente revisada'
    })
    request.mockResolvedValueOnce(response([{ ...definition(), label: 'Material revisado', revision: 2 }]))
    await wrapper.get('[data-definitions-load]').trigger('click')
    await flushPromises()
    await wrapper.get(`[data-definition-retire="${DEF}"]`).trigger('click')
    await confirm(wrapper)
    request.mockResolvedValueOnce(
      receipt('retire', { ...definition(), label: 'Material revisado', revision: 3, status: 'retired' })
    )
    await wrapper.get('[data-definition-form]').trigger('submit')
    await flushPromises()
    expect(JSON.parse(request.mock.calls.at(-1)![1].body)).toEqual({
      action: 'retire',
      expectedVersion: 2,
      reason: 'Definición explícitamente revisada'
    })
  })
  it('preserves an unknown intent exactly through GET and explicit retry, never an automatic POST', async () => {
    const wrapper = await mount()
    await load(wrapper)
    await wrapper.get(`[data-definition-edit="${DEF}"]`).trigger('click')
    await confirm(wrapper)
    request.mockRejectedValueOnce(new Error('SQL private'))
    await wrapper.get('[data-definition-form]').trigger('submit')
    await flushPromises()
    const original = request.mock.calls.at(-1)
    expect(wrapper.get('[data-definition-reason]').attributes('disabled')).toBeDefined()
    request.mockResolvedValueOnce(response())
    await wrapper.get('[data-definitions-load]').trigger('click')
    await flushPromises()
    expect(request.mock.calls.filter(([, options]) => options.method === 'PUT')).toHaveLength(1)
    request.mockResolvedValueOnce(receipt('update', { ...definition(), revision: 2 }))
    await wrapper.get('[data-definition-retry]').trigger('click')
    await flushPromises()
    expect(request.mock.calls.at(-1)).toEqual(original)
    expect(wrapper.text()).not.toContain('SQL')
  })
  it.each(['capability', 'owner', 'mfa'])(
    'drops late acknowledgements and replay after %s revocation',
    async (change) => {
      const wrapper = await mount()
      await load(wrapper)
      await wrapper.get(`[data-definition-edit="${DEF}"]`).trigger('click')
      await confirm(wrapper)
      let resolve!: (value: unknown) => void
      request.mockReturnValueOnce(
        new Promise((done) => {
          resolve = done
        })
      )
      await wrapper.get('[data-definition-form]').trigger('submit')
      if (change === 'capability') await wrapper.setProps({ available: false })
      if (change === 'owner') actor.user.value.id = CATEGORY
      if (change === 'mfa') actor.user.value.mfaVerified = false
      resolve(receipt('update', { ...definition(), revision: 2 }))
      await flushPromises()
      expect(wrapper.emitted('completed')).toBeUndefined()
      expect(wrapper.find('[data-definition-retry]').exists()).toBe(false)
    }
  )
  it('drops a late receipt if the supplied category identity changes in place', async () => {
    const categories = ref([{ id: 7, name: 'Higiene' }])
    const wrapper = await mount({ categories: categories.value })
    await load(wrapper)
    await wrapper.get(`[data-definition-edit="${DEF}"]`).trigger('click')
    await confirm(wrapper)
    let resolve!: (value: unknown) => void
    request.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done
      })
    )
    await wrapper.get('[data-definition-form]').trigger('submit')
    categories.value[0]!.id = 8
    await flushPromises()
    resolve(receipt('update', { ...definition(), revision: 2 }))
    await flushPromises()
    expect(wrapper.emitted('completed')).toBeUndefined()
    expect(wrapper.find('[data-definition-retry]').exists()).toBe(false)
  })
  it('rejects foreign category GET, unknown fields and retired definition writes', async () => {
    const wrapper = await mount()
    request.mockResolvedValueOnce({ ...response(), categoryId: 8 })
    await load(wrapper)
    expect(wrapper.find('[data-definition-create]').exists()).toBe(false)
    request.mockResolvedValueOnce(response([{ ...definition(), status: 'retired' }]))
    await wrapper.get('[data-definitions-load]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('Retirada')
    expect(wrapper.find(`[data-definition-edit="${DEF}"]`).exists()).toBe(false)
  })
})
