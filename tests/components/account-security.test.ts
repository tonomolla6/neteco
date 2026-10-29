import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h, proxyRefs, ref, shallowRef } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SecurityPage from '../../app/pages/cuenta/seguridad.vue'
import '#app/nuxt-vitest-app-entry'

// Matrix: real CF DTOs and explicit session/password/MFA flows; shared singleflight;
// strict receipt + fresh current-session proof; controlled own password rotation;
// identity/email/session revocation, secret purge, late/copy/unmount guards;
// uncertain delivery -> manual GET only, no automatic mutation retries.
const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
  refresh: vi.fn(),
  auth: vi.fn(),
  session: vi.fn(),
  clipboard: vi.fn()
}))
mockNuxtImport('useFetch', () => mocks.read)
mockNuxtImport('$fetch', () => mocks.write)
mockNuxtImport('useUserSession', () => mocks.session)
mockNuxtImport('useRuntimeConfig', () => () => ({
  app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
  public: { serverRuntime: 'cloudflare' }
}))
const OWNER = '81000000-0000-4000-8000-000000000001'
const CURRENT = {
  id: '82000000-0000-4000-8000-000000000001',
  current: true,
  mfaVerified: false,
  createdAt: '2026-10-08T10:00:00Z',
  lastSeenAt: '2026-10-08T10:00:00Z',
  expiresAt: '2026-10-09T10:00:00Z'
}
const OTHER = { ...CURRENT, id: '82000000-0000-4000-8000-000000000002', current: false }
const USER = {
  id: OWNER,
  email: 'synthetic@example.invalid',
  name: 'Persona sintética',
  phone: null,
  company: null,
  role: 'customer',
  roles: ['customer'],
  emailVerified: true,
  mfaVerified: false
}
const ENROLLMENT = {
  setupId: '83000000-0000-4000-8000-000000000001',
  manualKey: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567',
  uri: 'otpauth://totp/NETECO:synthetic%40example.invalid?issuer=NETECO&secret=ABCDEFGHIJKLMNOPQRSTUVWXYZ234567&algorithm=SHA1&digits=6&period=30',
  recoveryCodes: Array.from({ length: 8 }, (_, index) => `ABCD-EF01-2345-000${index}`)
}
const Slot = defineComponent({
  setup:
    (_, { slots }) =>
    () =>
      h('section', [slots.default?.(), slots.body?.(), slots.footer?.()])
})
const Modal = defineComponent({
  props: { open: Boolean },
  setup:
    (props, { slots }) =>
    () =>
      props.open ? h('dialog', [slots.body?.(), slots.footer?.()]) : null
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
  changePassword(): Promise<void>
  beginMfa(): Promise<void>
  verifyMfa(): Promise<void>
  copyCodes(): Promise<void>
  downloadCodes(): void
  retrySessions(): Promise<void>
  revokeSession(): Promise<void>
  passwordForm: { currentPassword: string; newPassword: string; confirmation: string }
  mfaCurrentPassword: string
  mfaCode: string
  enrollment: typeof ENROLLMENT | null
  codesSaved: boolean
  confirmingSession: typeof OTHER | null
  notice: string
  copied: boolean
}
let wrapper: Awaited<ReturnType<typeof mountSuspended>> | undefined
let data: ReturnType<typeof shallowRef<unknown>>
let status: ReturnType<typeof ref<string>>
let user: ReturnType<typeof ref<typeof USER>>
let session: ReturnType<typeof ref<{ sessionId: string; sessionVersion: number }>>
let loggedIn: ReturnType<typeof ref<boolean>>
let originalClipboard: PropertyDescriptor | undefined
async function render() {
  data = shallowRef({ sessions: [CURRENT, OTHER] })
  status = ref('success')
  mocks.read.mockReturnValue({ data, status, error: ref(null), refresh: mocks.refresh })
  wrapper = await mountSuspended(SecurityPage, {
    global: {
      stubs: {
        UiPageHeader: Slot,
        UiSurface: Slot,
        UButton: Button,
        AccountFeedback: Feedback,
        UModal: Modal,
        UBadge: Slot,
        PasswordField: true,
        UInput: true,
        UCheckbox: true
      }
    }
  })
  return proxyRefs(wrapper.setupState) as unknown as State
}
function password(page: State) {
  Object.assign(page.passwordForm, {
    currentPassword: 'Original-password1',
    newPassword: 'New-password-123',
    confirmation: 'New-password-123'
  })
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
  mocks.clipboard.mockReset().mockResolvedValue(undefined)
  user = ref({ ...USER })
  session = ref({ sessionId: CURRENT.id, sessionVersion: 1 })
  loggedIn = ref(true)
  mocks.session.mockReturnValue({ user, session, loggedIn, ready: ref(true), fetch: mocks.auth })
  originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: mocks.clipboard } })
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard)
  else Reflect.deleteProperty(navigator, 'clipboard')
})

describe('Cloudflare account security complete flows', () => {
  it.each(['email', 'identity', 'session', 'version', 'logout'])(
    'purges every secret, session and modal on %s revocation',
    async (change) => {
      const page = await render()
      password(page)
      page.enrollment = { ...ENROLLMENT }
      page.mfaCurrentPassword = 'MFA-password1'
      page.mfaCode = '123456'
      page.confirmingSession = OTHER
      page.codesSaved = true
      if (change === 'email') user.value.emailVerified = false
      if (change === 'identity') user.value.id = '81000000-0000-4000-8000-000000000002'
      if (change === 'session') session.value.sessionId = OTHER.id
      if (change === 'version') session.value.sessionVersion++
      if (change === 'logout') loggedIn.value = false
      await flushPromises()
      expect(page.enrollment).toBeNull()
      expect(page.passwordForm.currentPassword).toBe('')
      expect(page.passwordForm.newPassword).toBe('')
      expect(page.mfaCurrentPassword).toBe('')
      expect(page.mfaCode).toBe('')
      expect(page.confirmingSession).toBeNull()
      expect(data.value).toBeNull()
      expect(wrapper!.text()).not.toContain(ENROLLMENT.manualKey)
      await page.changePassword()
      await page.beginMfa()
      await page.verifyMfa()
      await page.copyCodes()
      page.downloadCodes()
      expect(mocks.write).not.toHaveBeenCalled()
      expect(mocks.clipboard).not.toHaveBeenCalled()
    }
  )
  it('purges late enrollment after revocation and never reveals its recovery codes', async () => {
    const response = deferred()
    const page = await render()
    page.mfaCurrentPassword = 'Password1'
    mocks.write.mockReturnValue(response.promise)
    const first = page.beginMfa()
    user.value.emailVerified = false
    response.resolve(ENROLLMENT)
    await first
    expect(page.enrollment).toBeNull()
    expect(page.mfaCurrentPassword).toBe('')
    expect(wrapper!.text()).not.toContain(ENROLLMENT.manualKey)
  })
  it('purges every secret on unmount and ignores late feedback', async () => {
    const response = deferred()
    const page = await render()
    password(page)
    page.mfaCurrentPassword = 'Password1'
    mocks.write.mockReturnValue(response.promise)
    const first = page.beginMfa()
    wrapper!.unmount()
    wrapper = undefined
    response.resolve(ENROLLMENT)
    await first
    expect(page.enrollment).toBeNull()
    expect(page.passwordForm.newPassword).toBe('')
    expect(page.mfaCurrentPassword).toBe('')
    expect(page.notice).toBe('')
  })
  it('shares a single synchronous write latch across password, MFA and session revocation', async () => {
    const response = deferred()
    const page = await render()
    password(page)
    page.mfaCurrentPassword = 'Password1'
    page.confirmingSession = OTHER
    mocks.write.mockReturnValue(response.promise)
    const first = page.beginMfa()
    const second = page.changePassword()
    const third = page.beginMfa()
    const fourth = page.revokeSession()
    await flushPromises()
    const count = mocks.write.mock.calls.length
    response.resolve(ENROLLMENT)
    await Promise.all([first, second, third, fourth])
    expect(count).toBe(1)
  })
  it.each([
    {},
    { ...ENROLLMENT, setupId: 'bad' },
    { ...ENROLLMENT, manualKey: '<secret>' },
    { ...ENROLLMENT, recoveryCodes: ['bad'] }
  ])('rejects malformed enrollment DTO %#', async (receipt) => {
    const page = await render()
    page.mfaCurrentPassword = 'Password1'
    mocks.write.mockResolvedValue(receipt)
    await page.beginMfa()
    expect(page.enrollment).toBeNull()
    expect(wrapper!.text()).toContain('No podemos confirmar')
  })
  it('accepts actual CF enrollment and requires saved recovery codes plus six digits', async () => {
    const page = await render()
    page.mfaCurrentPassword = 'Password1'
    mocks.write.mockResolvedValue(ENROLLMENT)
    await page.beginMfa()
    expect(page.enrollment?.setupId).toBe(ENROLLMENT.setupId)
    expect(page.mfaCurrentPassword).toBe('')
    expect(wrapper!.text()).toContain(ENROLLMENT.manualKey)
    page.mfaCode = '123456'
    await page.verifyMfa()
    expect(mocks.write).toHaveBeenCalledTimes(1)
    page.codesSaved = true
    page.mfaCode = 'abcdef'
    await page.verifyMfa()
    expect(mocks.write).toHaveBeenCalledTimes(1)
  })
  it('confirms MFA only after strict receipt and fresh auth plus current-session proof', async () => {
    const page = await render()
    page.enrollment = { ...ENROLLMENT }
    page.codesSaved = true
    page.mfaCode = '123456'
    mocks.write.mockResolvedValue({ ok: true })
    mocks.auth.mockImplementation(async () => {
      user.value.mfaVerified = true
    })
    mocks.refresh.mockImplementation(async () => {
      data.value = { sessions: [{ ...CURRENT, mfaVerified: true }, OTHER] }
    })
    await page.verifyMfa()
    expect(mocks.auth).toHaveBeenCalledTimes(1)
    expect(page.enrollment).toBeNull()
    expect(page.mfaCode).toBe('')
    expect(page.notice).toContain('activada')
  })
  it('does not announce MFA active when fresh server authority still says false', async () => {
    const page = await render()
    page.enrollment = { ...ENROLLMENT }
    page.codesSaved = true
    page.mfaCode = '123456'
    mocks.write.mockResolvedValue({ ok: true })
    await page.verifyMfa()
    expect(page.notice).toBe('')
    expect(wrapper!.text()).toContain('No podemos confirmar')
  })
  it('accepts only its acknowledged password version rotation and proves other sessions absent', async () => {
    const page = await render()
    password(page)
    mocks.write.mockResolvedValue({ ok: true, sessionVersion: 2, user: USER })
    mocks.auth.mockImplementation(async () => {
      session.value.sessionVersion = 2
    })
    mocks.refresh.mockImplementation(async () => {
      data.value = { sessions: [CURRENT] }
    })
    await page.changePassword()
    expect(mocks.auth).toHaveBeenCalledTimes(1)
    expect(page.notice).toContain('Contraseña actualizada')
    expect(page.passwordForm.newPassword).toBe('')
    expect(session.value.sessionVersion).toBe(2)
  })
  it.each(['identity', 'session', 'version', 'email'])(
    'rejects non-own %s transition during password refresh',
    async (change) => {
      const page = await render()
      password(page)
      mocks.write.mockResolvedValue({ ok: true, sessionVersion: 2, user: USER })
      mocks.auth.mockImplementation(async () => {
        if (change === 'identity') user.value.id = '81000000-0000-4000-8000-000000000002'
        if (change === 'session') session.value.sessionId = OTHER.id
        if (change === 'version') session.value.sessionVersion = 3
        if (change === 'email') user.value.emailVerified = false
      })
      await page.changePassword()
      expect(page.notice).toBe('')
      expect(page.passwordForm.newPassword).toBe('')
      expect(data.value).toBeNull()
    }
  )
  it.each([
    {},
    { ok: true, sessionVersion: 1, user: USER },
    { ok: true, sessionVersion: 2, user: { ...USER, id: OTHER.id } }
  ])('rejects invalid password receipt %# without current success', async (receipt) => {
    const page = await render()
    password(page)
    mocks.write.mockResolvedValue(receipt)
    await page.changePassword()
    expect(page.notice).toBe('')
    expect(wrapper!.text()).toContain('No podemos confirmar')
  })
  it('does not claim other sessions closed if a confirmed GET still returns them', async () => {
    const page = await render()
    password(page)
    mocks.write.mockResolvedValue({ ok: true, sessionVersion: 2, user: USER })
    mocks.auth.mockImplementation(async () => {
      session.value.sessionVersion = 2
    })
    await page.changePassword()
    expect(page.notice).toBe('')
    expect(wrapper!.text()).toContain('No podemos confirmar')
  })
  it('validates password transport before dispatch, not just confirmation equality', async () => {
    const page = await render()
    page.passwordForm.newPassword = 'short'
    page.passwordForm.confirmation = 'short'
    await page.changePassword()
    expect(mocks.write).not.toHaveBeenCalled()
    expect(wrapper!.text()).toContain('Revisa')
  })
  it('blocks all mutations after ambiguous setup until a manual auth+sessions GET', async () => {
    const page = await render()
    page.mfaCurrentPassword = 'Password1'
    password(page)
    mocks.write.mockRejectedValue({ data: { statusMessage: 'private SQL SECRET' } })
    await page.beginMfa()
    await page.beginMfa()
    await page.changePassword()
    expect(mocks.write).toHaveBeenCalledTimes(1)
    expect(wrapper!.text()).not.toContain('private SQL')
    expect(wrapper!.text()).toContain('No podemos confirmar')
    await page.retrySessions()
    expect(mocks.auth).toHaveBeenCalledTimes(1)
    expect(mocks.refresh).toHaveBeenCalledTimes(1)
    expect(mocks.write).toHaveBeenCalledTimes(1)
    expect(page.notice).toBe('')
  })
  it('requires a valid revocation receipt plus fresh absence proof', async () => {
    const page = await render()
    page.confirmingSession = OTHER
    mocks.write.mockResolvedValue({})
    mocks.refresh.mockImplementation(async () => {
      data.value = { sessions: [CURRENT] }
    })
    await page.revokeSession()
    expect(page.notice).toBe('')
    expect(wrapper!.text()).toContain('No podemos confirmar')
  })
  it('confirms a valid session revocation only after its current GET omits the target', async () => {
    const page = await render()
    page.confirmingSession = OTHER
    mocks.write.mockResolvedValue({ ok: true })
    mocks.refresh.mockImplementation(async () => {
      data.value = { sessions: [CURRENT] }
    })
    await page.revokeSession()
    expect(page.notice).toBe('Sesión cerrada.')
    expect(page.confirmingSession).toBeNull()
    expect(mocks.write).toHaveBeenCalledTimes(1)
  })
  it('reports clipboard failure generically without exposing secret details', async () => {
    const page = await render()
    page.enrollment = { ...ENROLLMENT }
    mocks.clipboard.mockRejectedValue(new Error('private clipboard SECRET'))
    await page.copyCodes()
    expect(page.copied).toBe(false)
    expect(wrapper!.text()).not.toContain('private clipboard')
    expect(wrapper!.text()).toContain('No se han podido copiar')
  })
  it('does not publish copied feedback after clipboard settles under a new identity', async () => {
    const response = deferred()
    const page = await render()
    page.enrollment = { ...ENROLLMENT }
    mocks.clipboard.mockReturnValue(response.promise)
    const copy = page.copyCodes()
    user.value.id = '81000000-0000-4000-8000-000000000002'
    response.resolve(undefined)
    await copy
    expect(page.copied).toBe(false)
    expect(page.enrollment).toBeNull()
  })
  it.each(['unauthenticated', 'email_unverified'])(
    'purges secrets on live server %s denial even when client flags are stale',
    async (code) => {
      const page = await render()
      password(page)
      page.enrollment = { ...ENROLLMENT }
      page.codesSaved = true
      page.mfaCode = '123456'
      mocks.write.mockRejectedValue({ statusCode: code === 'unauthenticated' ? 401 : 403, data: { error: { code } } })
      await page.verifyMfa()
      expect(page.enrollment).toBeNull()
      expect(page.passwordForm.newPassword).toBe('')
      expect(page.mfaCode).toBe('')
      expect(data.value).toBeNull()
      expect(page.notice).toBe('')
      await page.beginMfa()
      expect(mocks.write).toHaveBeenCalledTimes(1)
    }
  )
})
