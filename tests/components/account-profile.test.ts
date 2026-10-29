import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h, proxyRefs, ref, shallowRef } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ProfilePage from '../../app/pages/cuenta/datos.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), refresh: vi.fn(), auth: vi.fn(), session: vi.fn() }))
mockNuxtImport('useFetch', () => mocks.read)
mockNuxtImport('$fetch', () => mocks.write)
mockNuxtImport('useUserSession', () => mocks.session)
mockNuxtImport('useRuntimeConfig', () => () => ({
  app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
  public: { serverRuntime: 'cloudflare' }
}))
const OWNER = '71000000-0000-4000-8000-000000000001'
const COMPANY = '72000000-0000-4000-8000-000000000001'
const PROFILE = {
  name: 'Contacto sintético',
  phone: '+34600111222',
  email: 'synthetic@example.invalid',
  companyId: COMPANY,
  company: 'Empresa sintética',
  tradeName: 'Marca sintética',
  taxId: 'B12345674',
  countryCode: 'ES',
  companyStatus: 'approved',
  companyRole: null
}
const RECEIPT_USER = {
  id: OWNER,
  name: PROFILE.name,
  phone: PROFILE.phone,
  email: PROFILE.email,
  company: PROFILE.company,
  role: 'customer',
  roles: ['customer'],
  emailVerified: true,
  mfaVerified: false
}
const Slot = defineComponent({
  setup:
    (_, { slots }) =>
    () =>
      h('section', slots.default?.())
})
const Button = defineComponent({
  props: { disabled: Boolean, loading: Boolean },
  setup:
    (props, { attrs, slots }) =>
    () =>
      h('button', { ...attrs, disabled: props.disabled || props.loading }, slots.default?.())
})
const Feedback = defineComponent({
  props: { notice: String, error: String },
  setup: (props) => () => h('aside', [props.notice, props.error])
})
type State = {
  saveProfile(): Promise<void>
  saveCompany(): Promise<void>
  requestEmailChange(): Promise<void>
  retryRead(): Promise<void>
  profileForm: { name: string; phone: string }
  companyForm: { legalName: string; tradeName: string; taxId: string; countryCode: string; currentPassword: string }
  emailForm: { email: string; currentPassword: string }
  notice: string
}
let wrapper: Awaited<ReturnType<typeof mountSuspended>> | undefined
let data: ReturnType<typeof shallowRef<unknown>>
let user: ReturnType<typeof ref<typeof RECEIPT_USER>>
let session: ReturnType<typeof ref<{ sessionId: string; sessionVersion: number }>>
let loggedIn: ReturnType<typeof ref<boolean>>
async function render(profile: unknown = PROFILE) {
  data = shallowRef({ profile })
  mocks.read.mockReturnValue({ data, status: ref('success'), error: ref(null), refresh: mocks.refresh })
  wrapper = await mountSuspended(ProfilePage, {
    global: {
      stubs: {
        UiPageHeader: Slot,
        UiSurface: Slot,
        UButton: Button,
        AccountFeedback: Feedback,
        UFormField: Slot,
        UInput: true,
        USelect: true,
        UBadge: Slot,
        UIcon: true
      }
    }
  })
  return proxyRefs(wrapper.setupState) as unknown as State
}
function deferred() {
  let resolve!: (value: unknown) => void
  const promise = new Promise<unknown>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
beforeEach(() => {
  mocks.read.mockReset()
  mocks.write.mockReset()
  mocks.refresh.mockReset().mockResolvedValue(undefined)
  mocks.auth.mockReset().mockResolvedValue(undefined)
  user = ref({ ...RECEIPT_USER })
  session = ref({ sessionId: '73000000-0000-4000-8000-000000000001', sessionVersion: 1 })
  loggedIn = ref(true)
  mocks.session.mockReturnValue({ user, session, loggedIn, ready: ref(true), fetch: mocks.auth })
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
})

describe('Cloudflare contact and B2B profile boundaries', () => {
  it.each(['email', 'identity', 'session', 'version', 'logout'])(
    'purges profile and all private drafts on %s boundary',
    async (change) => {
      const page = await render()
      page.companyForm.currentPassword = 'private-company-password'
      page.emailForm.currentPassword = 'private-email-password'
      page.emailForm.email = 'draft@example.invalid'
      if (change === 'email') user.value.emailVerified = false
      if (change === 'identity') user.value.id = '71000000-0000-4000-8000-000000000002'
      if (change === 'session') session.value.sessionId = '73000000-0000-4000-8000-000000000002'
      if (change === 'version') session.value.sessionVersion++
      if (change === 'logout') loggedIn.value = false
      await flushPromises()
      expect(wrapper!.text()).not.toContain(PROFILE.email)
      expect(page.companyForm.currentPassword).toBe('')
      expect(page.profileForm.name).toBe('')
      expect(page.companyForm.legalName).toBe('')
      expect(page.emailForm.email).toBe('')
      expect(page.emailForm.currentPassword).toBe('')
      expect(data.value).toBeNull()
      await page.saveProfile()
      await page.saveCompany()
      await page.requestEmailChange()
      expect(mocks.write).not.toHaveBeenCalled()
    }
  )
  it('ignores late mutation and GET data after a session change', async () => {
    const response = deferred()
    const page = await render()
    mocks.write.mockReturnValue(response.promise)
    page.profileForm.name = 'Nuevo contacto'
    const saving = page.saveProfile()
    session.value.sessionVersion++
    response.resolve({ user: { ...RECEIPT_USER, name: 'Nuevo contacto' } })
    await saving
    data.value = { profile: PROFILE }
    await flushPromises()
    expect(data.value).toBeNull()
    expect(mocks.refresh).not.toHaveBeenCalled()
    expect(page.notice).toBe('')
  })
  it('purges private buffers on unmount and does not refresh a late write', async () => {
    const response = deferred()
    const page = await render()
    page.companyForm.currentPassword = 'private-password'
    mocks.write.mockReturnValue(response.promise)
    const saving = page.saveCompany()
    wrapper!.unmount()
    wrapper = undefined
    response.resolve({ companyId: COMPANY, status: 'approved', user: RECEIPT_USER })
    await saving
    expect(page.companyForm.currentPassword).toBe('')
    expect(page.profileForm.name).toBe('')
    expect(mocks.refresh).not.toHaveBeenCalled()
  })
  it.each([{}, { user: { ...RECEIPT_USER, id: '71000000-0000-4000-8000-000000000002' } }])(
    'does not confirm invalid/wrong-owner PUT receipts %#',
    async (receipt) => {
      const page = await render()
      mocks.write.mockResolvedValue(receipt)
      await page.saveProfile()
      expect(page.notice).toBe('')
      expect(wrapper!.text()).toContain('No podemos confirmar')
      expect(mocks.refresh).not.toHaveBeenCalled()
    }
  )
  it('requires fresh contact fields to match the acknowledged write', async () => {
    const page = await render()
    page.profileForm.name = 'Nuevo contacto'
    mocks.write.mockResolvedValue({ user: { ...RECEIPT_USER, name: 'Nuevo contacto' } })
    await page.saveProfile()
    expect(page.notice).toBe('')
    expect(wrapper!.text()).toContain('No podemos confirmar')
  })
  it('confirms normalized contact data from the fresh read, with one write only', async () => {
    const response = deferred()
    const page = await render()
    page.profileForm.name = '  Nuevo contacto  '
    mocks.write.mockReturnValue(response.promise)
    mocks.refresh.mockImplementation(async () => {
      data.value = { profile: { ...PROFILE, name: 'Nuevo contacto' } }
    })
    const saving = page.saveProfile()
    await page.saveCompany()
    await page.saveProfile()
    expect(mocks.write).toHaveBeenCalledTimes(1)
    expect(mocks.write.mock.calls[0]![1].body.name).toBe('Nuevo contacto')
    response.resolve({ user: { ...RECEIPT_USER, name: 'Nuevo contacto' } })
    await saving
    expect(page.notice).toBe('Datos actualizados.')
  })
  it.each(['pending', 'approved'])(
    'confirms actual company status %s without inventing a review transition',
    async (status) => {
      const page = await render()
      page.companyForm.currentPassword = 'private-password'
      mocks.write.mockResolvedValue({ companyId: COMPANY, status, user: RECEIPT_USER })
      mocks.refresh.mockImplementation(async () => {
        data.value = { profile: { ...PROFILE, companyStatus: status } }
      })
      await page.saveCompany()
      expect(page.companyForm.currentPassword).toBe('')
      expect(page.notice).toBe(
        status === 'pending' ? 'Datos profesionales enviados a revisión.' : 'Datos profesionales actualizados.'
      )
    }
  )
  it('does not confirm company data when the refreshed company identity differs', async () => {
    const page = await render()
    page.companyForm.currentPassword = 'private-password'
    mocks.write.mockResolvedValue({
      companyId: '72000000-0000-4000-8000-000000000002',
      status: 'approved',
      user: RECEIPT_USER
    })
    await page.saveCompany()
    expect(page.notice).toBe('')
    expect(wrapper!.text()).toContain('No podemos confirmar')
  })
  it.each(['profile', 'company'])('validates %s transport before a write', async (kind) => {
    const page = await render()
    if (kind === 'profile') {
      page.profileForm.name = ''
      await page.saveProfile()
    } else {
      page.companyForm.taxId = 'invalid'
      page.companyForm.currentPassword = 'password'
      await page.saveCompany()
    }
    expect(mocks.write).not.toHaveBeenCalled()
    expect(wrapper!.text()).toContain('Revisa')
  })
  it.each(['A58818502', 'B12345678', '12345678A', 'X1234567A', '---', '...'])(
    'rejects an invalid or normalized-empty professional tax ID %s before transport',
    async (taxId) => {
      const page = await render()
      page.companyForm.taxId = taxId
      page.companyForm.currentPassword = 'private-password'
      await page.saveCompany()
      expect(mocks.write).not.toHaveBeenCalled()
      expect(wrapper!.text()).toContain('identificador fiscal')
      expect(page.companyForm.taxId).toBe(taxId)
      expect(page.companyForm.currentPassword).toBe('private-password')
    }
  )
  it('normalizes a checksum-valid professional identifier before its single write', async () => {
    const page = await render()
    page.companyForm.taxId = ' b.123-45674 '
    page.companyForm.currentPassword = 'private-password'
    mocks.write.mockResolvedValue({ companyId: COMPANY, status: 'pending', user: RECEIPT_USER })
    mocks.refresh.mockImplementation(async () => {
      data.value = { profile: { ...PROFILE, companyStatus: 'pending' } }
    })
    await page.saveCompany()
    expect(mocks.write).toHaveBeenCalledTimes(1)
    expect(mocks.write.mock.calls[0]![1].body.taxId).toBe('B12345674')
    expect(page.notice).toBe('Datos profesionales enviados a revisión.')
  })
  it('keeps ambiguous PUT blocked until explicit fresh GET without automatic replay', async () => {
    const page = await render()
    mocks.write.mockRejectedValue({ data: { statusMessage: 'private SQL synthetic@example.invalid' } })
    await page.saveProfile()
    expect(wrapper!.text()).not.toContain('private SQL')
    expect(wrapper!.text()).toContain('No podemos confirmar')
    await page.saveProfile()
    expect(mocks.write).toHaveBeenCalledTimes(1)
    await page.retryRead()
    expect(mocks.refresh).toHaveBeenCalledTimes(1)
    expect(mocks.write).toHaveBeenCalledTimes(1)
    expect(page.notice).toBe('')
  })
})
