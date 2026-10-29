import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h, nextTick, proxyRefs, ref, shallowRef, type PropType } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ProfilePage from '../../app/pages/cuenta/datos.vue'
import type { AccountProfile } from '../../app/composables/useAccount'
import '#app/nuxt-vitest-app-entry'

const { fetchMock, requestMock, refreshMock, userRefreshMock, runtimeMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  requestMock: vi.fn(),
  refreshMock: vi.fn(),
  userRefreshMock: vi.fn(),
  runtimeMock: vi.fn(() => ({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'node' }
  }))
}))
mockNuxtImport('useFetch', () => fetchMock)
mockNuxtImport('$fetch', () => requestMock)
mockNuxtImport('useRuntimeConfig', () => runtimeMock)
mockNuxtImport('useUserSession', () => () => ({
  ready: ref(true),
  loggedIn: ref(true),
  user: ref({
    id:
      runtimeMock().public.serverRuntime === 'cloudflare' ? '71000000-0000-4000-8000-000000000001' : 'synthetic-owner',
    role: 'customer',
    emailVerified: true
  }),
  session: ref(
    runtimeMock().public.serverRuntime === 'cloudflare'
      ? { sessionId: '73000000-0000-4000-8000-000000000001', sessionVersion: 1 }
      : null
  ),
  clear: async () => undefined,
  openInPopup: () => undefined,
  fetch: userRefreshMock
}))
const PROFILE: AccountProfile = {
  name: 'Nombre existente',
  phone: '+34 600 111 222',
  email: 'owner@example.invalid',
  company: 'Empresa existente',
  tradeName: 'Marca existente',
  taxId: 'B12345678',
  countryCode: 'PT',
  companyStatus: 'pending',
  companyRole: 'company_admin'
}
const D1_PROFILE = { ...PROFILE, companyId: '10000000-0000-4000-8000-000000000011', companyRole: null }
const NULLABLE_PROFILE: AccountProfile = {
  name: null,
  phone: null,
  email: PROFILE.email,
  company: null,
  tradeName: null,
  taxId: null,
  countryCode: null,
  companyStatus: null,
  companyRole: null
}
const PRIVATE = 'SQL private_table owner@example.invalid synthetic-private-error'
const Header = defineComponent({
  props: { title: String },
  setup: (props) => () => h('header', h('h1', props.title))
})
const Surface = defineComponent({
  setup:
    (_, { slots }) =>
    () =>
      h('section', slots.default?.())
})
const Button = defineComponent({
  inheritAttrs: false,
  props: { disabled: Boolean, loading: Boolean },
  setup:
    (props, { attrs, slots }) =>
    () =>
      h(
        'button',
        {
          ...attrs,
          type: attrs.type ?? 'button',
          disabled: props.disabled || props.loading
        },
        slots.default?.()
      )
})
const Input = defineComponent({
  inheritAttrs: false,
  props: { modelValue: String },
  emits: ['update:modelValue'],
  setup:
    (props, { attrs, emit }) =>
    () =>
      h('input', {
        ...attrs,
        value: props.modelValue,
        onInput: (event: Event) => emit('update:modelValue', (event.target as HTMLInputElement).value)
      })
})
const Select = defineComponent({
  inheritAttrs: false,
  props: { modelValue: String, items: Array as PropType<Array<{ label: string; value: string }>> },
  emits: ['update:modelValue'],
  setup:
    (props, { attrs, emit }) =>
    () =>
      h(
        'select',
        {
          ...attrs,
          value: props.modelValue,
          onChange: (event: Event) => emit('update:modelValue', (event.target as HTMLSelectElement).value)
        },
        props.items?.map((item) => h('option', { value: item.value }, item.label))
      )
})
const Field = defineComponent({
  props: { label: String },
  setup:
    (props, { slots }) =>
    () =>
      h('label', [h('span', props.label), slots.default?.()])
})
const Feedback = defineComponent({
  props: { notice: String, error: String },
  setup: (props) => () =>
    h('div', [
      props.notice ? h('p', { role: 'status' }, props.notice) : null,
      props.error ? h('p', { role: 'alert' }, props.error) : null
    ])
})
type Wrapper = Awaited<ReturnType<typeof mountSuspended>>
type Actions = {
  retryRead(): Promise<void>
  saveProfile(): Promise<void>
  saveCompany(): Promise<void>
  requestEmailChange(): Promise<void>
  profileForm: { name: string; phone: string }
  companyForm: { legalName: string; tradeName: string; taxId: string; countryCode: string; currentPassword: string }
  emailForm: { email: string; currentPassword: string }
  busy: boolean
  loggedIn: boolean
  notice: string
}
let wrapper: Wrapper | undefined
let data: ReturnType<typeof shallowRef<unknown>>
let status: ReturnType<typeof ref<string>>
let error: ReturnType<typeof shallowRef<unknown>>
const actions = (page: Wrapper) => proxyRefs(page.setupState) as Actions
const button = (page: Wrapper, label: string) => page.findAll('button').find((entry) => entry.text() === label)
function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
async function render(options: { data?: unknown; status?: string; error?: unknown; runtime?: string } = {}) {
  data = shallowRef(Object.hasOwn(options, 'data') ? options.data : { profile: PROFILE })
  status = ref(options.status ?? 'success')
  error = shallowRef(options.error ?? null)
  runtimeMock.mockReturnValue({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: options.runtime ?? 'node' }
  })
  fetchMock.mockReturnValue({ data, status, error, refresh: refreshMock })
  wrapper = await mountSuspended(ProfilePage, {
    global: {
      stubs: {
        UiPageHeader: Header,
        UiSurface: Surface,
        UButton: Button,
        UInput: Input,
        USelect: Select,
        UFormField: Field,
        AccountFeedback: Feedback,
        UBadge: { template: '<span><slot /></span>' },
        UIcon: true
      }
    }
  })
  return wrapper
}
function noWrites() {
  expect(requestMock).not.toHaveBeenCalled()
  expect(userRefreshMock).not.toHaveBeenCalled()
  expect(fetchMock.mock.calls.map((call) => call.slice(0, 2))).toEqual([['/api/account', { method: 'GET' }]])
}
async function everyCommand(page: Wrapper) {
  const state = actions(page)
  state.profileForm.name = 'Nombre deliberado'
  state.emailForm.email = 'new@example.invalid'
  state.emailForm.currentPassword = 'synthetic-current-password'
  state.companyForm.legalName = 'Empresa deliberada'
  state.companyForm.currentPassword = 'synthetic-current-password'
  await state.saveProfile()
  await state.requestEmailChange()
  await state.saveCompany()
}
function recover(profile: AccountProfile = PROFILE) {
  data.value = { profile }
  status.value = 'success'
  error.value = null
}
beforeEach(() => {
  fetchMock.mockReset()
  requestMock.mockReset().mockResolvedValue({ message: 'Revisa tu correo para confirmar el cambio.' })
  refreshMock.mockReset().mockResolvedValue(undefined)
  userRefreshMock.mockReset().mockResolvedValue(undefined)
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
})

describe('account profile: authoritative read state without implicit blank writes', () => {
  it.each(['idle', 'pending'])('does not confirm cached forms during %s', async (readStatus) => {
    const page = await render({ status: readStatus })
    expect(page.get('[role="status"]').text()).toContain('Cargando tus datos')
    expect(page.get('[aria-busy]').attributes('aria-busy')).toBe('true')
    expect(page.find('form').exists()).toBe(false)
    expect(page.text()).not.toContain(PROFILE.email)
    expect(button(page, 'Reintentar')).toBeUndefined()
    await everyCommand(page)
    await actions(page).retryRead()
    expect(refreshMock).not.toHaveBeenCalled()
    noWrites()
  })
  it.each([
    { runtime: 'node', profile: PROFILE },
    { runtime: 'cloudflare', profile: D1_PROFILE },
    { runtime: 'node', profile: NULLABLE_PROFILE }
  ])('accepts actual Node/D1 nullable profile projections without coercion %#', async ({ runtime, profile }) => {
    const original = { profile }
    const page = await render({ data: original, runtime })
    expect(page.findAll('form')).toHaveLength(3)
    expect(page.findAll('form').map((form) => form.attributes('aria-labelledby'))).toEqual([
      'account-contact-title',
      'account-email-title',
      'account-company-title'
    ])
    expect(page.find('[role="alert"]').exists()).toBe(false)
    expect(actions(page).profileForm).toEqual({ name: profile.name ?? '', phone: profile.phone ?? '' })
    expect(actions(page).companyForm).toEqual({
      legalName: profile.company ?? '',
      tradeName: profile.tradeName ?? '',
      taxId: profile.taxId ?? '',
      countryCode: profile.countryCode ?? '',
      currentPassword: ''
    })
    expect(page.get('input[autocomplete="name"]').element).toHaveProperty('value', profile.name ?? '')
    expect(page.get('input[type="tel"]').element).toHaveProperty('value', profile.phone ?? '')
    expect(data.value).toEqual(original)
    expect(page.text()).toContain(PROFILE.email)
    noWrites()
  })
  it('preserves legitimate historic whitespace and freeform values rather than applying write rules to reads', async () => {
    const historic = {
      ...PROFILE,
      name: '  Nombre histórico  ',
      phone: ' extensión 4 ',
      companyStatus: 'estado-nuevo',
      companyRole: 'papel-nuevo'
    }
    const page = await render({ data: { profile: historic } })
    expect(actions(page).profileForm).toEqual({ name: historic.name, phone: historic.phone })
    expect(page.text()).toContain('estado-nuevo')
    expect(page.text()).toContain('papel-nuevo')
    noWrites()
  })
  it.each([undefined, null, {}, { profile: PROFILE }])(
    'hides cached/absent personal data after GET error %#',
    async (cached) => {
      const page = await render({ data: cached, status: 'error', error: new Error(PRIVATE) })
      expect(page.get('[role="alert"]').text()).toContain('No hemos podido cargar tus datos')
      expect(page.text()).not.toContain(PRIVATE)
      expect(page.find('form').exists()).toBe(false)
      expect(page.text()).not.toContain('Solicitar cuenta profesional')
      expect(button(page, 'Reintentar')?.attributes('type')).toBe('button')
      await everyCommand(page)
      noWrites()
    }
  )
  it('rejects a successful cached payload accompanied by a live read error', async () => {
    const page = await render({ error: { data: { statusMessage: PRIVATE } } })
    expect(page.find('form').exists()).toBe(false)
    expect(page.get('[role="alert"]').text()).not.toContain(PRIVATE)
    await everyCommand(page)
    noWrites()
  })
  it.each([
    undefined,
    null,
    {},
    [],
    { profile: null },
    { profile: [] },
    { profile: {} },
    { profile: { ...PROFILE, name: undefined } },
    { profile: { ...PROFILE, phone: 123 } },
    { profile: { ...PROFILE, email: null } },
    { profile: { ...PROFILE, email: '' } },
    { profile: { ...PROFILE, company: {} } },
    { profile: { ...PROFILE, tradeName: [] } },
    { profile: { ...PROFILE, taxId: false } },
    { profile: { ...PROFILE, countryCode: 1 } },
    { profile: { ...PROFILE, companyStatus: true } },
    { profile: { ...PROFILE, companyRole: undefined } },
    { profile: { ...PROFILE, name: 'x'.repeat(4097) } }
  ])('rejects malformed/missing DTO instead of initializing writable blanks %#', async (payload) => {
    const page = await render({ data: payload })
    expect(page.find('form').exists()).toBe(false)
    expect(page.get('[role="alert"]').text()).toContain('No hemos podido cargar tus datos')
    await everyCommand(page)
    noWrites()
  })
  it.each(['root_getter', 'profile_getter', 'extra_getter', 'root_prototype', 'profile_prototype', 'symbol'])(
    'rejects %s without accessor execution',
    async (poison) => {
      const getter = vi.fn(() => PROFILE)
      let payload: unknown = { profile: PROFILE }
      if (poison === 'root_getter') payload = Object.defineProperty({}, 'profile', { enumerable: true, get: getter })
      if (poison === 'profile_getter')
        payload = { profile: Object.defineProperty({ ...PROFILE }, 'phone', { enumerable: true, get: getter }) }
      if (poison === 'extra_getter')
        payload = { profile: Object.defineProperty({ ...PROFILE }, 'extra', { enumerable: true, get: getter }) }
      if (poison === 'root_prototype') payload = Object.create({ profile: PROFILE })
      if (poison === 'profile_prototype')
        payload = { profile: Object.assign(Object.create({ phone: PROFILE.phone }), { ...PROFILE }) }
      if (poison === 'symbol') payload = { profile: { ...PROFILE, [Symbol('hostile')]: true } }
      const page = await render({ data: payload })
      expect(page.find('form').exists()).toBe(false)
      await everyCommand(page)
      expect(getter).not.toHaveBeenCalled()
      noWrites()
    }
  )
  it('recovers by explicit GET and preserves the actual existing phone in the next PUT', async () => {
    const page = await render({ status: 'error' })
    refreshMock.mockImplementationOnce(async () => recover())
    await button(page, 'Reintentar')!.trigger('click')
    await flushPromises()
    expect(refreshMock).toHaveBeenCalledExactlyOnceWith()
    expect(actions(page).profileForm.phone).toBe(PROFILE.phone)
    noWrites()
    actions(page).profileForm.name = 'Nombre nuevo'
    refreshMock.mockImplementationOnce(async () => recover({ ...PROFILE, name: 'Nombre nuevo' }))
    await page.get('form').trigger('submit')
    await flushPromises()
    expect(requestMock).toHaveBeenCalledExactlyOnceWith('/api/account/profile', {
      method: 'PUT',
      body: { name: 'Nombre nuevo', phone: PROFILE.phone }
    })
    expect(userRefreshMock).toHaveBeenCalledExactlyOnceWith()
    expect(page.text()).toContain('Datos actualizados.')
  })
  it('keeps all callbacks blocked across duplicate/manual GET retries', async () => {
    const pending = deferred()
    const page = await render({ status: 'error' })
    refreshMock.mockReturnValueOnce(pending.promise)
    const callback = actions(page).retryRead
    const first = callback()
    await callback()
    await everyCommand(page)
    await nextTick()
    expect(refreshMock).toHaveBeenCalledOnce()
    expect(page.find('form').exists()).toBe(false)
    expect(page.get('[role="status"]').text()).toContain('Cargando tus datos')
    noWrites()
    recover()
    pending.resolve()
    await first
    await nextTick()
    expect(page.findAll('form')).toHaveLength(3)
    expect(actions(page).profileForm.phone).toBe(PROFILE.phone)
    noWrites()
  })
  it('keeps a rejected GET unconfirmed even when transport leaves success and cached data', async () => {
    const page = await render({ status: 'error' })
    refreshMock.mockImplementationOnce(async () => {
      status.value = 'success'
      error.value = null
      throw new Error(PRIVATE)
    })
    await actions(page).retryRead()
    await nextTick()
    expect(page.find('form').exists()).toBe(false)
    expect(page.get('[role="alert"]').text()).not.toContain(PRIVATE)
    await everyCommand(page)
    noWrites()
  })
  it('hydrates clean fields after recovery while keeping deliberate edits in all forms', async () => {
    const page = await render()
    const state = actions(page)
    state.profileForm.name = 'Nombre editado'
    state.companyForm.legalName = 'Empresa editada'
    state.companyForm.currentPassword = 'typed-password'
    state.emailForm.email = 'typed@example.invalid'
    state.emailForm.currentPassword = 'typed-email-password'
    status.value = 'error'
    await nextTick()
    expect(page.find('form').exists()).toBe(false)
    refreshMock.mockImplementationOnce(async () =>
      recover({
        ...PROFILE,
        name: 'Nombre del servidor',
        phone: '+34 600 999 999',
        company: 'Empresa del servidor',
        tradeName: 'Marca del servidor'
      })
    )
    await state.retryRead()
    await nextTick()
    expect(state.profileForm).toEqual({ name: 'Nombre editado', phone: '+34 600 999 999' })
    expect(state.companyForm.legalName).toBe('Empresa editada')
    expect(state.companyForm.tradeName).toBe('Marca del servidor')
    expect(state.companyForm.currentPassword).toBe('typed-password')
    expect(state.emailForm).toEqual({ email: 'typed@example.invalid', currentPassword: 'typed-email-password' })
    noWrites()
  })
  it.each(['error', 'pending', 'malformed', 'logout', 'busy'])(
    'cached callbacks recheck live %s authority',
    async (revocation) => {
      const page = await render()
      const state = actions(page)
      if (revocation === 'error') status.value = 'error'
      if (revocation === 'pending') status.value = 'pending'
      if (revocation === 'malformed') data.value = { profile: { ...PROFILE, phone: [] } }
      if (revocation === 'logout') state.loggedIn = false
      if (revocation === 'busy') state.busy = true
      await everyCommand(page)
      noWrites()
    }
  )
  it('guards all three write callbacks with one synchronous in-flight latch', async () => {
    const pending = deferred<unknown>()
    const page = await render()
    requestMock.mockReturnValueOnce(pending.promise)
    const state = actions(page)
    state.profileForm.name = 'Nombre enviado'
    const first = state.saveProfile()
    await state.saveProfile()
    await state.requestEmailChange()
    await state.saveCompany()
    await state.retryRead()
    await nextTick()
    expect(requestMock).toHaveBeenCalledOnce()
    expect(refreshMock).not.toHaveBeenCalled()
    expect(page.findAll('fieldset').every((field) => field.attributes('disabled') !== undefined)).toBe(true)
    pending.resolve({ user: { name: 'Historical receipt must not replace profile', phone: 'wrong' } })
    refreshMock.mockImplementationOnce(async () => recover({ ...PROFILE, name: 'Nombre enviado' }))
    await first
    expect(data.value).toEqual({ profile: { ...PROFILE, name: 'Nombre enviado' } })
    expect(state.profileForm.phone).toBe(PROFILE.phone)
  })
  it.each(['error', 'new_read', 'unmount'])(
    'ignores a late write response after %s without refresh or clearing text',
    async (change) => {
      const pending = deferred<unknown>()
      const page = await render()
      const state = actions(page)
      state.emailForm.email = 'typed@example.invalid'
      state.emailForm.currentPassword = 'typed-password'
      requestMock.mockReturnValueOnce(pending.promise)
      const first = state.requestEmailChange()
      if (change === 'error') status.value = 'error'
      if (change === 'new_read') recover({ ...PROFILE, phone: '+34 600 333 333' })
      if (change === 'unmount') page.unmount()
      pending.resolve({ message: 'Historical success' })
      await first
      expect(state.emailForm).toEqual({ email: 'typed@example.invalid', currentPassword: 'typed-password' })
      expect(state.notice).toBe('')
      expect(refreshMock).not.toHaveBeenCalled()
      expect(userRefreshMock).not.toHaveBeenCalled()
      if (change === 'unmount') {
        await everyCommand(page)
        await state.retryRead()
        expect(requestMock).toHaveBeenCalledOnce()
      }
    }
  )
  it('does not retry a write or announce current success after its refresh fails; manual GET recovers buffers', async () => {
    const page = await render()
    const state = actions(page)
    state.profileForm.name = 'Nombre enviado'
    refreshMock.mockImplementationOnce(async () => {
      throw new Error(PRIVATE)
    })
    await state.saveProfile()
    await nextTick()
    expect(requestMock).toHaveBeenCalledOnce()
    expect(state.profileForm).toEqual({ name: 'Nombre enviado', phone: PROFILE.phone })
    expect(page.find('form').exists()).toBe(false)
    expect(page.get('[role="alert"]').text()).not.toContain(PRIVATE)
    expect(state.notice).toBe('')
    expect(userRefreshMock).not.toHaveBeenCalled()
    refreshMock.mockImplementationOnce(async () => recover({ ...PROFILE, name: 'Nombre enviado' }))
    await state.retryRead()
    await nextTick()
    expect(page.findAll('form')).toHaveLength(3)
    expect(state.profileForm.phone).toBe(PROFILE.phone)
    expect(requestMock).toHaveBeenCalledOnce()
    expect(userRefreshMock).not.toHaveBeenCalled()
  })
  it('keeps company text/password after a postwrite GET error and retains the original endpoint/body', async () => {
    const page = await render()
    const state = actions(page)
    state.companyForm.legalName = 'Empresa enviada'
    state.companyForm.currentPassword = 'typed-password'
    const command = { ...state.companyForm }
    refreshMock.mockImplementationOnce(async () => {
      status.value = 'error'
      error.value = new Error(PRIVATE)
    })
    await state.saveCompany()
    await nextTick()
    expect(requestMock).toHaveBeenCalledExactlyOnceWith('/api/account/company', { method: 'PUT', body: command })
    expect(state.companyForm).toEqual(command)
    expect(state.notice).toBe('')
    expect(page.find('form').exists()).toBe(false)
  })
  it('blocks completion after revocation during session refresh without clearing submitted company text', async () => {
    const pending = deferred()
    const page = await render()
    const state = actions(page)
    state.companyForm.currentPassword = 'typed-password'
    userRefreshMock.mockReturnValueOnce(pending.promise)
    const first = state.saveCompany()
    await flushPromises()
    status.value = 'error'
    pending.resolve()
    await first
    expect(state.companyForm.currentPassword).toBe('typed-password')
    expect(state.notice).toBe('')
  })
  it('ignores a late rejected session refresh after unmount without clearing text or adding historical feedback', async () => {
    const pending = deferred()
    const page = await render()
    const state = actions(page)
    state.companyForm.currentPassword = 'typed-password'
    userRefreshMock.mockReturnValueOnce(pending.promise)
    const first = state.saveCompany()
    await flushPromises()
    page.unmount()
    pending.reject(new Error(PRIVATE))
    await first
    expect(state.companyForm.currentPassword).toBe('typed-password')
    expect(state.notice).toBe('')
    expect(requestMock).toHaveBeenCalledOnce()
  })
  it('keeps edits and does not automatically retry a rejected PUT', async () => {
    const page = await render()
    const state = actions(page)
    state.profileForm.name = 'Nombre deliberado'
    requestMock.mockRejectedValueOnce(new Error(PRIVATE))
    await state.saveProfile()
    await nextTick()
    expect(state.profileForm).toEqual({ name: 'Nombre deliberado', phone: PROFILE.phone })
    expect(requestMock).toHaveBeenCalledOnce()
    expect(refreshMock).not.toHaveBeenCalled()
    expect(userRefreshMock).not.toHaveBeenCalled()
    expect(page.get('[role="alert"]').text()).toBe('No se han podido actualizar tus datos.')
    expect(page.text()).not.toContain(PRIVATE)
    expect(page.find('form').exists()).toBe(false)
    expect(button(page, 'Reintentar')).toBeDefined()
  })
  it.each(['node', 'cloudflare'])(
    'requires a manual confirmed GET after a committed PUT loses its response in %s, keeping every buffer',
    async (runtime) => {
      const page = await render({ runtime })
      const state = actions(page)
      state.profileForm.name = 'Nombre enviado'
      Object.assign(state.companyForm, {
        legalName: 'Empresa editada',
        tradeName: 'Marca editada',
        taxId: 'B87654321',
        countryCode: 'FR',
        currentPassword: 'typed-company-password'
      })
      Object.assign(state.emailForm, { email: 'typed@example.invalid', currentPassword: 'typed-email-password' })
      const buffers = {
        profile: { ...state.profileForm },
        company: { ...state.companyForm },
        email: { ...state.emailForm }
      }
      let serverProfile = { ...PROFILE }
      requestMock.mockImplementationOnce(async () => {
        serverProfile = { ...PROFILE, ...buffers.profile }
        throw new Error(PRIVATE)
      })
      await state.saveProfile()
      await nextTick()
      expect(requestMock).toHaveBeenCalledExactlyOnceWith('/api/account/profile', {
        method: 'PUT',
        body: buffers.profile
      })
      expect(refreshMock).not.toHaveBeenCalled()
      expect(userRefreshMock).not.toHaveBeenCalled()
      expect(data.value).toEqual({ profile: PROFILE })
      expect(page.findAll('form')).toHaveLength(0)
      expect(page.text()).toContain('No se han podido actualizar tus datos.')
      expect(page.text()).not.toContain(PRIVATE)
      expect(state.notice).toBe('')
      await state.saveProfile()
      await state.saveCompany()
      await state.requestEmailChange()
      expect(requestMock).toHaveBeenCalledOnce()

      refreshMock.mockImplementationOnce(async () => {
        status.value = 'success'
        error.value = null
        data.value = { profile: { ...serverProfile, phone: 123 } }
      })
      await button(page, 'Reintentar')!.trigger('click')
      await flushPromises()
      expect(refreshMock).toHaveBeenCalledExactlyOnceWith()
      expect(page.findAll('form')).toHaveLength(0)
      await state.saveProfile()
      await state.saveCompany()
      await state.requestEmailChange()
      expect(requestMock).toHaveBeenCalledOnce()

      refreshMock.mockImplementationOnce(async () => recover(serverProfile))
      await button(page, 'Reintentar')!.trigger('click')
      await flushPromises()
      expect(refreshMock).toHaveBeenCalledTimes(2)
      expect(data.value).toEqual({ profile: serverProfile })
      expect(page.findAll('form')).toHaveLength(3)
      expect(state.profileForm).toEqual(buffers.profile)
      expect(state.profileForm.phone).toBe(PROFILE.phone)
      expect(state.companyForm).toEqual(buffers.company)
      expect(state.emailForm).toEqual(buffers.email)
      expect(requestMock).toHaveBeenCalledOnce()
      expect(userRefreshMock).not.toHaveBeenCalled()
      expect(state.notice).toBe('')

      refreshMock.mockImplementationOnce(async () => recover(serverProfile))
      await state.saveProfile()
      expect(requestMock).toHaveBeenCalledTimes(2)
      expect(requestMock).toHaveBeenLastCalledWith('/api/account/profile', { method: 'PUT', body: buffers.profile })
      expect(state.companyForm).toEqual(buffers.company)
      expect(state.emailForm).toEqual(buffers.email)
    }
  )
  it('keeps the company-specific error and all inputs after a rejected company PUT until a manual GET', async () => {
    const page = await render()
    const state = actions(page)
    state.companyForm.legalName = 'Empresa enviada'
    state.companyForm.currentPassword = 'typed-password'
    const command = { ...state.companyForm }
    requestMock.mockRejectedValueOnce(new Error(PRIVATE))
    await state.saveCompany()
    await nextTick()
    expect(requestMock).toHaveBeenCalledExactlyOnceWith('/api/account/company', { method: 'PUT', body: command })
    expect(state.companyForm).toEqual(command)
    expect(state.profileForm.phone).toBe(PROFILE.phone)
    expect(page.find('form').exists()).toBe(false)
    expect(page.text()).toContain('No se han podido guardar los datos profesionales.')
    expect(page.text()).not.toContain(PRIVATE)
    expect(button(page, 'Reintentar')).toBeDefined()
    expect(refreshMock).not.toHaveBeenCalled()
    expect(userRefreshMock).not.toHaveBeenCalled()
    refreshMock.mockImplementationOnce(async () => recover())
    await state.retryRead()
    await nextTick()
    expect(refreshMock).toHaveBeenCalledExactlyOnceWith()
    expect(requestMock).toHaveBeenCalledOnce()
    expect(state.companyForm).toEqual(command)
    expect(state.profileForm.phone).toBe(PROFILE.phone)
    expect(page.findAll('form')).toHaveLength(3)
  })
  it('preserves the email-change POST without GET/autosave and clears only unchanged command inputs', async () => {
    const page = await render()
    const state = actions(page)
    state.emailForm.email = 'new@example.invalid'
    state.emailForm.currentPassword = 'typed-password'
    await state.requestEmailChange()
    expect(requestMock).toHaveBeenCalledExactlyOnceWith('/api/account/email-change', {
      method: 'POST',
      body: { email: 'new@example.invalid', currentPassword: 'typed-password' }
    })
    expect(state.emailForm).toEqual({ email: '', currentPassword: '' })
    expect(data.value).toEqual({ profile: PROFILE })
    expect(refreshMock).not.toHaveBeenCalled()
    expect(userRefreshMock).not.toHaveBeenCalled()
  })
  it('does not erase newer deliberate input or describe its historical command as saved', async () => {
    const pending = deferred<unknown>()
    const page = await render()
    const state = actions(page)
    state.emailForm.email = 'first@example.invalid'
    state.emailForm.currentPassword = 'first-password'
    requestMock.mockReturnValueOnce(pending.promise)
    const first = state.requestEmailChange()
    state.emailForm.email = 'newer@example.invalid'
    state.emailForm.currentPassword = 'newer-password'
    pending.resolve({ message: 'Revisa tu correo.' })
    await first
    expect(state.emailForm).toEqual({ email: 'newer@example.invalid', currentPassword: 'newer-password' })
    expect(state.notice).toBe('')
  })
  it('does not refresh or write from an unmounted retry or cached callbacks', async () => {
    const pending = deferred()
    const page = await render({ status: 'error' })
    const state = actions(page)
    refreshMock.mockReturnValueOnce(pending.promise)
    const first = state.retryRead()
    page.unmount()
    recover()
    pending.resolve()
    await first
    expect(state.profileForm).toEqual({ name: '', phone: '' })
    await everyCommand(page)
    await state.retryRead()
    expect(refreshMock).toHaveBeenCalledOnce()
    noWrites()
  })
})
