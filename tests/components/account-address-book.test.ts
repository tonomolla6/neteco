import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h, proxyRefs, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AddressPage from '../../app/pages/cuenta/direcciones.vue'
import type { AddressInput } from '../../server/domain/customer'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), write: vi.fn(), refresh: vi.fn(), session: vi.fn() }))
mockNuxtImport('useFetch', () => mocks.fetch)
mockNuxtImport('$fetch', () => mocks.write)
mockNuxtImport('useRuntimeConfig', () => () => ({
  app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
  public: { serverRuntime: 'cloudflare' }
}))
mockNuxtImport('useUserSession', () => mocks.session)

const ID = '51000000-0000-4000-8000-000000000001'
const ADDRESS = {
  id: ID,
  kind: 'both',
  label: 'Oficina sintética',
  recipientName: 'Persona sintética',
  companyName: null,
  taxId: null,
  line1: 'Calle sintética 12',
  line2: null,
  postalCode: '28001',
  city: 'Madrid',
  region: 'Madrid',
  countryCode: 'ES',
  phone: null,
  instructions: null,
  isDefault: false,
  createdAt: '2026-10-08T10:00:00.000Z',
  updatedAt: '2026-10-08T10:00:00.000Z'
}
const Button = defineComponent({
  props: { disabled: Boolean, loading: Boolean },
  setup(props, { attrs, slots }) {
    return () => h('button', { ...attrs, disabled: props.disabled || props.loading }, slots.default?.())
  }
})
const Slot = defineComponent({
  setup:
    (_, { slots }) =>
    () =>
      h('section', [slots.default?.(), slots.actions?.()])
})
const Modal = defineComponent({
  props: { open: Boolean },
  setup:
    (props, { slots }) =>
    () =>
      props.open ? h('dialog', [slots.body?.(), slots.footer?.()]) : null
})
const Feedback = defineComponent({
  props: { notice: String, error: String },
  setup: (props) => () => h('aside', [props.notice, props.error])
})
let wrapper: Awaited<ReturnType<typeof mountSuspended>> | undefined
let data: ReturnType<typeof ref<unknown>>
let user: ReturnType<typeof ref<{ id: string; emailVerified: boolean }>>
let session: ReturnType<typeof ref<{ sessionId: string; sessionVersion: number }>>
let loggedIn: ReturnType<typeof ref<boolean>>
let status: ReturnType<typeof ref<string>>
type PageState = {
  startCreate: () => void
  startEdit: (address: typeof ADDRESS) => void
  save: () => Promise<void>
  remove: () => Promise<void>
  form: AddressInput
  confirming: typeof ADDRESS | null
  open: boolean
  notice: string
}
async function render(payload: unknown = { addresses: [ADDRESS] }) {
  data = ref(payload)
  status = ref('success')
  mocks.fetch.mockImplementation((path: string) =>
    path === '/api/account'
      ? { data: ref({ profile: { name: 'Perfil sintético', company: null, taxId: null, phone: null } }) }
      : { data, status, error: ref(null), refresh: mocks.refresh }
  )
  wrapper = await mountSuspended(AddressPage, {
    global: {
      stubs: {
        UiPageHeader: Slot,
        UiSurface: Slot,
        UiEmptyState: Slot,
        UButton: Button,
        UModal: Modal,
        AccountFeedback: Feedback,
        UFormField: Slot,
        UInput: true,
        USelect: true,
        UTextarea: true,
        UCheckbox: true,
        UBadge: Slot
      }
    }
  })
  return proxyRefs(wrapper.setupState) as unknown as PageState
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
beforeEach(() => {
  mocks.fetch.mockReset()
  mocks.write.mockReset()
  mocks.refresh.mockReset().mockResolvedValue(undefined)
  user = ref({ id: '52000000-0000-4000-8000-000000000001', emailVerified: true })
  session = ref({ sessionId: '53000000-0000-4000-8000-000000000001', sessionVersion: 1 })
  loggedIn = ref(true)
  mocks.session.mockReturnValue({ user, session, loggedIn, ready: ref(true) })
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
})

describe('Cloudflare account address book authority and commands', () => {
  it.each(['email', 'identity', 'session', 'version', 'logout'])(
    'purges all PII and dialogs on %s revocation',
    async (change) => {
      const page = await render()
      page.startEdit(ADDRESS)
      page.confirming = ADDRESS
      expect(wrapper!.text()).toContain(ADDRESS.line1)
      if (change === 'email') user.value.emailVerified = false
      if (change === 'identity') user.value.id = '52000000-0000-4000-8000-000000000002'
      if (change === 'session') session.value.sessionId = '53000000-0000-4000-8000-000000000002'
      if (change === 'version') session.value.sessionVersion++
      if (change === 'logout') loggedIn.value = false
      await flushPromises()
      expect(wrapper!.text()).not.toContain(ADDRESS.line1)
      expect(page.form.recipientName).toBe('')
      expect(page.open).toBe(false)
      expect(page.confirming).toBe(null)
      await page.save()
      await page.remove()
      expect(mocks.write).not.toHaveBeenCalled()
    }
  )
  it.each([
    { ...ADDRESS, id: 'not-uuid' },
    { ...ADDRESS, isDefault: 1 },
    { ...ADDRESS, kind: 'invalid' },
    { ...ADDRESS, recipientName: {} },
    { ...ADDRESS, updatedAt: 'yesterday' }
  ])('rejects malformed D1 address rows without showing PII', async (address) => {
    await render({ addresses: [address] })
    expect(wrapper!.text()).not.toContain(ADDRESS.line1)
    expect(wrapper!.find('[role="alert"]').exists()).toBe(true)
  })
  it('blocks create and delete when the read failed', async () => {
    const page = await render()
    status.value = 'error'
    page.startCreate()
    page.confirming = ADDRESS
    await page.remove()
    expect(page.open).toBe(false)
    expect(mocks.write).not.toHaveBeenCalled()
  })
  it('validates the existing address policy before sending', async () => {
    const page = await render()
    page.startCreate()
    await page.save()
    expect(mocks.write).not.toHaveBeenCalled()
    expect(wrapper!.text()).toContain('Revisa')
  })
  it.each(['A58818502', 'B12345678', '12345678A'])(
    'rejects a checksum-invalid Spanish address identifier %s before transport',
    async (taxId) => {
      const page = await render()
      page.startEdit(ADDRESS)
      page.form.taxId = taxId
      await page.save()
      expect(mocks.write).not.toHaveBeenCalled()
      expect(wrapper!.text()).toContain('identificador fiscal')
      expect(page.open).toBe(true)
      expect(page.form.taxId).toBe(taxId)
    }
  )
  it.each(['', ' b.123-45674 '])('accepts optional or checksum-valid address tax ID %j', async (taxId) => {
    const page = await render()
    page.startEdit(ADDRESS)
    page.form.taxId = taxId
    const normalized = taxId ? 'B12345674' : ''
    mocks.write.mockResolvedValue({ ok: true })
    mocks.refresh.mockImplementation(async () => {
      data.value = { addresses: [{ ...ADDRESS, taxId: normalized || null }] }
    })
    await page.save()
    expect(mocks.write).toHaveBeenCalledTimes(1)
    expect(mocks.write.mock.calls[0]![1].body.taxId).toBe(normalized)
    expect(wrapper!.text()).toContain('Dirección actualizada.')
  })
  it('freezes one edit/default command and confirms only after current GET', async () => {
    const response = deferred<unknown>()
    mocks.write.mockReturnValue(response.promise)
    const page = await render()
    page.startEdit(ADDRESS)
    page.form.isDefault = true
    const first = page.save()
    const duplicate = page.save()
    await flushPromises()
    const calls = mocks.write.mock.calls.length
    const body = mocks.write.mock.calls[0]![1].body
    page.form.line1 = 'Otro borrador'
    expect(body.line1).toBe(ADDRESS.line1)
    expect(body.isDefault).toBe(true)
    mocks.refresh.mockImplementation(async () => {
      data.value = { addresses: [{ ...ADDRESS, isDefault: true }] }
    })
    response.resolve({ ok: true })
    await Promise.all([first, duplicate])
    expect(calls).toBe(1)
    expect(wrapper!.text()).toContain('Dirección actualizada.')
    expect(page.open).toBe(false)
  })
  it('creates using the returned UUID and a confirmed fresh agenda', async () => {
    const page = await render({ addresses: [] })
    page.startCreate()
    Object.assign(page.form, { ...ADDRESS, companyName: '', taxId: '', line2: '', phone: '', instructions: '' })
    mocks.write.mockResolvedValue({ id: ID })
    mocks.refresh.mockImplementation(async () => {
      data.value = { addresses: [ADDRESS] }
    })
    await page.save()
    expect(mocks.write.mock.calls[0]![1].method).toBe('POST')
    expect(wrapper!.text()).toContain('Dirección guardada.')
  })
  it('deletes only explicitly and confirms against a fresh agenda', async () => {
    const page = await render()
    page.confirming = ADDRESS
    expect(mocks.write).not.toHaveBeenCalled()
    mocks.write.mockResolvedValue({ ok: true })
    mocks.refresh.mockImplementation(async () => {
      data.value = { addresses: [] }
    })
    await page.remove()
    expect(mocks.write).toHaveBeenCalledTimes(1)
    expect(wrapper!.text()).toContain('Dirección eliminada.')
  })
  it.each(['network', 'malformed', 'read'])(
    'does not claim success or permit blind replay after %s ambiguity',
    async (failure) => {
      const page = await render()
      page.startEdit(ADDRESS)
      if (failure === 'network') mocks.write.mockRejectedValue(new Error('private server data'))
      else mocks.write.mockResolvedValue(failure === 'malformed' ? {} : { ok: true })
      if (failure === 'read') mocks.refresh.mockRejectedValue(new Error('private read data'))
      await page.save()
      expect(wrapper!.text()).not.toContain('Dirección actualizada.')
      expect(wrapper!.text()).not.toContain('private')
      expect(wrapper!.text()).toContain('No podemos confirmar')
      await page.save()
      expect(mocks.write).toHaveBeenCalledTimes(1)
    }
  )
  it('discards write feedback and refreshed PII after authority changes during await', async () => {
    const response = deferred<unknown>()
    mocks.write.mockReturnValue(response.promise)
    const page = await render()
    page.startEdit(ADDRESS)
    const saving = page.save()
    user.value.emailVerified = false
    response.resolve({ ok: true })
    await saving
    expect(mocks.refresh).not.toHaveBeenCalled()
    expect(wrapper!.text()).not.toContain(ADDRESS.line1)
    expect(wrapper!.text()).not.toContain('Dirección actualizada.')
  })
  it('purges late GET data after revocation instead of retaining it in the cache ref', async () => {
    await render()
    session.value.sessionVersion++
    await flushPromises()
    data.value = { addresses: [ADDRESS] }
    await flushPromises()
    expect(data.value).toBeNull()
    expect(wrapper!.text()).not.toContain(ADDRESS.line1)
  })
  it('does not refresh or show write feedback after unmount', async () => {
    const response = deferred<unknown>()
    mocks.write.mockReturnValue(response.promise)
    const page = await render()
    page.startEdit(ADDRESS)
    const saving = page.save()
    wrapper!.unmount()
    wrapper = undefined
    response.resolve({ ok: true })
    await saving
    expect(mocks.refresh).not.toHaveBeenCalled()
    expect(page.form.recipientName).toBe('')
    expect(page.notice).toBe('')
  })
  it('requires a fresh GET and explicit acknowledgement to leave uncertainty without replay', async () => {
    const page = await render()
    page.startEdit(ADDRESS)
    mocks.write.mockRejectedValue(new Error('lost response'))
    await page.save()
    const acknowledge = () =>
      wrapper!.findAll('button').find((button) => button.text() === 'He revisado la agenda; continuar')
    expect(acknowledge()?.attributes('disabled')).toBeDefined()
    await wrapper!
      .findAll('button')
      .find((button) => button.text() === 'Revisar agenda')!
      .trigger('click')
    await flushPromises()
    expect(acknowledge()?.attributes('disabled')).toBeUndefined()
    expect(wrapper!.text()).toContain('posibles duplicados')
    await acknowledge()!.trigger('click')
    await flushPromises()
    expect(mocks.write).toHaveBeenCalledTimes(1)
    expect(page.open).toBe(false)
    expect(page.form.recipientName).toBe('')
    expect(wrapper!.text()).not.toContain('Dirección actualizada.')
    page.startEdit(ADDRESS)
    expect(page.open).toBe(true)
  })
  it('keeps uncertainty blocked if the explicit fresh GET fails', async () => {
    const page = await render()
    page.startEdit(ADDRESS)
    mocks.write.mockRejectedValue(new Error('lost response'))
    await page.save()
    mocks.refresh.mockRejectedValue(new Error('read unavailable'))
    await wrapper!
      .findAll('button')
      .find((button) => button.text() === 'Revisar agenda')!
      .trigger('click')
    await flushPromises()
    expect(
      wrapper!
        .findAll('button')
        .find((button) => button.text() === 'He revisado la agenda; continuar')!
        .attributes('disabled')
    ).toBeDefined()
    await page.save()
    expect(mocks.write).toHaveBeenCalledTimes(1)
  })
})
