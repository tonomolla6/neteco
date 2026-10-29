import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h, nextTick, proxyRefs, ref, shallowRef } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SecurityPage from '../../app/pages/cuenta/seguridad.vue'
import '#app/nuxt-vitest-app-entry'

const { fetchMock, requestMock, refreshMock, userRefreshMock, sessionMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  requestMock: vi.fn(),
  refreshMock: vi.fn(),
  userRefreshMock: vi.fn(),
  sessionMock: vi.fn()
}))
mockNuxtImport('useFetch', () => fetchMock)
mockNuxtImport('$fetch', () => requestMock)
mockNuxtImport('useUserSession', () => sessionMock)
const CURRENT = {
  id: '10000000-0000-4000-8000-000000000001',
  current: true,
  mfaVerified: true,
  createdAt: '2026-10-01T08:00:00Z',
  lastSeenAt: '2026-10-01T09:00:00Z',
  expiresAt: '2026-10-04T08:00:00Z'
}
const OTHER = { ...CURRENT, id: '10000000-0000-4000-8000-000000000002', current: false }
const PRIVATE = 'SQL private_sessions synthetic-secret@example.invalid'
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
const Surface = defineComponent({
  setup:
    (_, { slots }) =>
    () =>
      h('section', slots.default?.())
})
const Modal = defineComponent({
  props: { open: Boolean },
  setup:
    (props, { slots }) =>
    () =>
      props.open ? h('div', { role: 'dialog' }, [slots.body?.(), slots.footer?.()]) : null
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
  retrySessions(): Promise<void>
  revokeSession(): Promise<void>
  confirmingSession: typeof OTHER | null
  notice: string
}
let wrapper: Wrapper | undefined
let data: ReturnType<typeof shallowRef<unknown>>
let status: ReturnType<typeof ref<string>>
let error: ReturnType<typeof shallowRef<unknown>>
let loggedIn: ReturnType<typeof ref<boolean>>
const actions = (page: Wrapper) => proxyRefs(page.setupState) as Actions
const button = (page: Wrapper, label: string) => page.findAll('button').find((entry) => entry.text() === label)
function deferred() {
  let resolve!: () => void, reject!: (reason: unknown) => void
  const promise = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
async function render(options: { data?: unknown; status?: string; error?: unknown } = {}) {
  data = shallowRef(Object.hasOwn(options, 'data') ? options.data : { sessions: [CURRENT, OTHER] })
  status = ref(options.status ?? 'success')
  error = shallowRef(options.error ?? null)
  loggedIn = ref(true)
  fetchMock.mockReturnValue({ data, status, error, refresh: refreshMock })
  sessionMock.mockReturnValue({
    ready: ref(true),
    loggedIn,
    user: ref({ id: 'synthetic-customer', mfaVerified: true }),
    fetch: userRefreshMock
  })
  wrapper = await mountSuspended(SecurityPage, {
    global: {
      stubs: {
        UiPageHeader: { template: '<header />' },
        UiSurface: Surface,
        UButton: Button,
        UModal: Modal,
        AccountFeedback: Feedback,
        UBadge: { template: '<span><slot /></span>' },
        PasswordField: true,
        UInput: true,
        UCheckbox: true
      }
    }
  })
  return wrapper
}
function recovered(sessions = [CURRENT, OTHER]) {
  data.value = { sessions }
  status.value = 'success'
  error.value = null
}
beforeEach(() => {
  fetchMock.mockReset()
  requestMock.mockReset().mockResolvedValue({ revoked: true })
  refreshMock.mockReset().mockResolvedValue(undefined)
  userRefreshMock.mockReset().mockResolvedValue(undefined)
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
})

describe('account sessions: confirmed reads and deliberate recovery only', () => {
  it.each(['idle', 'pending'])('hides cached sessions during %s', async (readStatus) => {
    const page = await render({ status: readStatus })
    expect(page.text()).toContain('Cargando tus sesiones')
    expect(page.text()).not.toContain('No hay ninguna otra sesión abierta')
    expect(page.text()).not.toContain('Otro dispositivo')
    expect(page.get('[aria-busy]').attributes('aria-busy')).toBe('true')
    actions(page).confirmingSession = OTHER
    await actions(page).revokeSession()
    await actions(page).retrySessions()
    expect(requestMock).not.toHaveBeenCalled()
    expect(refreshMock).not.toHaveBeenCalled()
  })
  it.each([
    { status: 'error', error: new Error(PRIVATE) },
    { status: 'success', error: new Error(PRIVATE) },
    { data: null },
    { data: {} },
    { data: { sessions: null } },
    { data: { sessions: [] } },
    { data: { sessions: [OTHER] } },
    { data: { sessions: [CURRENT, CURRENT] } },
    { data: { sessions: [{ ...CURRENT, mfaVerified: 1 }] } },
    { data: { sessions: [{ ...CURRENT, id: '../password' }] } },
    { data: { sessions: [{ ...CURRENT, createdAt: 'invalid' }] } },
    { data: { sessions: [{ ...CURRENT, current: 'true' }] } },
    { data: Object.create({ sessions: [CURRENT, OTHER] }) },
    { data: { sessions: [Object.create(CURRENT)] } }
  ])('does not turn failed or invalid data into an empty/safe session list %#', async (options) => {
    const page = await render(options)
    expect(page.text()).toContain('No se han podido cargar tus sesiones')
    expect(page.text()).not.toContain('No hay ninguna otra sesión abierta')
    expect(page.text()).not.toContain('Otro dispositivo')
    expect(page.text()).not.toContain(PRIVATE)
    expect(button(page, 'Reintentar')).toBeDefined()
    actions(page).confirmingSession = OTHER
    await actions(page).revokeSession()
    expect(requestMock).not.toHaveBeenCalled()
  })
  it('shows a confirmed current-only list as no other devices, including Node milliseconds', async () => {
    const page = await render({ data: { sessions: [{ ...CURRENT, createdAt: '2026-10-01T08:00:00.123Z' }] } })
    expect(page.text()).toContain('Este dispositivo')
    expect(page.text()).toContain('No hay ninguna otra sesión abierta')
    expect(button(page, 'Reintentar')).toBeUndefined()
    expect(requestMock).not.toHaveBeenCalled()
    expect(fetchMock.mock.calls.map((call) => call.slice(0, 2))).toEqual([['/api/account/sessions', { method: 'GET' }]])
  })
  it('recovers with exactly one GET and no mutation while duplicate clicks are blocked', async () => {
    const page = await render({ status: 'error', error: new Error(PRIVATE) })
    const pending = deferred()
    refreshMock.mockImplementation(async () => {
      await pending.promise
      recovered()
    })
    const first = actions(page).retrySessions()
    await actions(page).retrySessions()
    await nextTick()
    expect(refreshMock).toHaveBeenCalledTimes(1)
    expect(page.text()).toContain('Cargando tus sesiones')
    expect(requestMock).not.toHaveBeenCalled()
    pending.resolve()
    await first
    await nextTick()
    expect(page.text()).toContain('Otro dispositivo')
    expect(page.text()).not.toContain('No se han podido cargar tus sesiones')
  })
  it('keeps failure visible after refresh rejection even when old data/status stay success', async () => {
    const page = await render({ error: new Error(PRIVATE) })
    refreshMock.mockRejectedValue(new Error(PRIVATE))
    error.value = null
    await nextTick()
    status.value = 'error'
    await nextTick()
    await actions(page).retrySessions()
    status.value = 'success'
    await nextTick()
    expect(page.text()).toContain('No se han podido cargar tus sesiones')
    expect(page.text()).not.toContain('Otro dispositivo')
    expect(page.text()).not.toContain(PRIVATE)
    expect(requestMock).not.toHaveBeenCalled()
  })
  it('does not revoke the current session or a target absent from the current read', async () => {
    const page = await render()
    actions(page).confirmingSession = CURRENT
    await actions(page).revokeSession()
    actions(page).confirmingSession = { ...OTHER, id: '10000000-0000-4000-8000-000000000003' }
    await actions(page).revokeSession()
    expect(requestMock).not.toHaveBeenCalled()
  })
  it('revokes once, then requires a confirmed GET before reporting success', async () => {
    const page = await render()
    const pending = deferred()
    requestMock.mockReturnValue(pending.promise)
    refreshMock.mockImplementation(async () => recovered([CURRENT]))
    actions(page).confirmingSession = OTHER
    const first = actions(page).revokeSession()
    await actions(page).revokeSession()
    expect(requestMock).toHaveBeenCalledTimes(1)
    pending.resolve()
    await first
    await flushPromises()
    expect(requestMock).toHaveBeenCalledWith(`/api/account/sessions/${OTHER.id}`, { method: 'DELETE' })
    expect(actions(page).notice).toBe('Sesión cerrada.')
    expect(page.text()).not.toContain('Otro dispositivo')
  })
  it('ambiguous DELETE failure requires GET recovery and never automatically repeats the write', async () => {
    const page = await render()
    requestMock.mockRejectedValue(new Error(PRIVATE))
    actions(page).confirmingSession = OTHER
    await actions(page).revokeSession()
    await nextTick()
    expect(page.text()).toContain('No se han podido cargar tus sesiones')
    expect(actions(page).notice).toBe('')
    refreshMock.mockImplementation(async () => recovered([CURRENT]))
    await actions(page).retrySessions()
    await nextTick()
    expect(requestMock).toHaveBeenCalledTimes(1)
    expect(page.text()).toContain('No hay ninguna otra sesión abierta')
    expect(page.text()).not.toContain(PRIVATE)
  })
  it('a failed post-DELETE refresh never reports success or exposes cached revoke controls', async () => {
    const page = await render()
    refreshMock.mockRejectedValue(new Error(PRIVATE))
    actions(page).confirmingSession = OTHER
    await actions(page).revokeSession()
    await nextTick()
    expect(actions(page).notice).toBe('')
    expect(page.text()).toContain('No se han podido cargar tus sesiones')
    expect(page.text()).not.toContain('Otro dispositivo')
    expect(requestMock).toHaveBeenCalledTimes(1)
  })
  it('does not claim a device was revoked while the new list still includes it', async () => {
    const page = await render()
    refreshMock.mockImplementation(async () => recovered())
    actions(page).confirmingSession = OTHER
    await actions(page).revokeSession()
    await nextTick()
    expect(actions(page).notice).toBe('')
    expect(page.text()).toContain('No se han podido cargar tus sesiones')
    expect(requestMock).toHaveBeenCalledTimes(1)
  })
  it('rejects accessor data without invoking it or exposing a target', async () => {
    const getter = vi.fn(() => [CURRENT, OTHER])
    const payload = Object.defineProperty({}, 'sessions', { enumerable: true, get: getter })
    const page = await render({ data: payload })
    expect(getter).not.toHaveBeenCalled()
    expect(page.text()).toContain('No se han podido cargar tus sesiones')
    expect(requestMock).not.toHaveBeenCalled()
  })
  it.each(['accessor', 'extra_property', 'custom_prototype'])(
    'rejects an unconfirmed sessions array (%s) without evaluating its accessors',
    async (kind) => {
      const getter = vi.fn(() => CURRENT)
      const sessions = [CURRENT, OTHER]
      if (kind === 'accessor') Object.defineProperty(sessions, '0', { enumerable: true, get: getter })
      if (kind === 'extra_property') Object.defineProperty(sessions, 'unexpected', { value: true, enumerable: true })
      if (kind === 'custom_prototype') Object.setPrototypeOf(sessions, Object.create(Array.prototype))
      const page = await render({ data: { sessions } })
      expect(getter).not.toHaveBeenCalled()
      expect(page.text()).toContain('No se han podido cargar tus sesiones')
      expect(page.text()).not.toContain('Otro dispositivo')
      actions(page).confirmingSession = OTHER
      await actions(page).revokeSession()
      expect(requestMock).not.toHaveBeenCalled()
    }
  )
  it('does not display a late recovery after logout or act on stale targets', async () => {
    const page = await render({ status: 'error' })
    const pending = deferred()
    refreshMock.mockImplementation(async () => {
      await pending.promise
      recovered()
    })
    const first = actions(page).retrySessions()
    loggedIn.value = false
    await nextTick()
    pending.resolve()
    await first
    await nextTick()
    expect(page.text()).not.toContain('Otro dispositivo')
    actions(page).confirmingSession = OTHER
    await actions(page).revokeSession()
    expect(requestMock).not.toHaveBeenCalled()
  })
  it('ignores a late DELETE completion after unmount', async () => {
    const page = await render()
    const pending = deferred()
    requestMock.mockReturnValue(pending.promise)
    const state = actions(page)
    state.confirmingSession = OTHER
    const first = state.revokeSession()
    page.unmount()
    wrapper = undefined
    pending.resolve()
    await first
    expect(refreshMock).not.toHaveBeenCalled()
    expect(state.notice).toBe('')
  })
})
