import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import RegistrationPage from '../../app/pages/registro.vue'
// Nuxt's test entry deliberately defers this graph to a fixed beforeAll hook.
// Preload the graph while collecting the test; Nuxt's test transform disables
// its automatic mount, so setup still runs once in the normal Nuxt hook.
// This avoids spending the setup deadline on cold imports on a busy host.
import '#app/nuxt-vitest-app-entry'

const { fetchMock, refreshSession, navigate } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  refreshSession: vi.fn().mockResolvedValue(undefined),
  navigate: vi.fn()
}))
mockNuxtImport('$fetch', () => fetchMock)
// This auto-import is also consumed by Nuxt's session plugin and route/layout
// code during bootstrap. Model the complete ready anonymous session, not only
// the one method the page calls, so those consumers can initialise normally.
mockNuxtImport('useUserSession', () => () => ({
  ready: ref(true),
  loggedIn: ref(false),
  user: ref(null),
  session: ref(null),
  clear: async () => undefined,
  openInPopup: () => undefined,
  fetch: refreshSession
}))
mockNuxtImport('navigateTo', () => navigate)
const Input = defineComponent({
  inheritAttrs: false,
  props: { modelValue: String, label: String },
  emits: ['update:modelValue'],
  setup(props, { attrs, emit }) {
    return () =>
      h('input', {
        ...attrs,
        'aria-label': props.label,
        value: props.modelValue,
        onInput: (event: Event) => emit('update:modelValue', (event.target as HTMLInputElement).value)
      })
  }
})
const Checkbox = defineComponent({
  props: { modelValue: Boolean, label: String },
  emits: ['update:modelValue'],
  setup(props, { emit }) {
    return () =>
      h('input', {
        type: 'checkbox',
        'aria-label': props.label,
        checked: props.modelValue,
        onChange: (event: Event) => emit('update:modelValue', (event.target as HTMLInputElement).checked)
      })
  }
})
const Slot = defineComponent({ template: '<div><slot /></div>' })
const Alert = defineComponent({
  props: { title: String, description: String },
  template: '<div role="alert">{{ title }} {{ description }}</div>'
})
let wrapper: Awaited<ReturnType<typeof mountSuspended>> | undefined
async function render() {
  wrapper = await mountSuspended(RegistrationPage, {
    route: '/registro',
    global: {
      stubs: {
        UInput: Input,
        PasswordField: Input,
        UCheckbox: Checkbox,
        UFormField: Slot,
        UAlert: Alert,
        UButton: Slot
      }
    }
  })
  return wrapper
}
async function fill() {
  const page = await render()
  await page.get('input[autocomplete="name"]').setValue('Cliente de prueba')
  await page.get('input[type="email"]').setValue('cliente@example.invalid')
  await page.get('input[aria-label="Contraseña"]').setValue('Synthetic-password-123')
  await page.get('input[aria-label="Repite la contraseña"]').setValue('Synthetic-password-123')
  await page.get('input[aria-label="Acepto las condiciones de la cuenta"]').setValue(true)
  return page
}

describe('registration response and accessible confirmation states', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    refreshSession.mockReset().mockResolvedValue(undefined)
    navigate.mockReset()
  })
  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
  })
  it('shows generic confirmation without assuming a session or disclosing whether the account exists', async () => {
    fetchMock.mockResolvedValue({ ok: true, verificationRequired: true })
    const page = await fill()
    await page.get('form').trigger('submit')
    await flushPromises()
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/register', {
      method: 'POST',
      body: {
        name: 'Cliente de prueba',
        email: 'cliente@example.invalid',
        password: 'Synthetic-password-123',
        phone: undefined,
        company: undefined,
        termsAccepted: true,
        newsletter: false
      }
    })
    expect(page.find('form').exists()).toBe(false)
    expect(page.get('[role="status"]').attributes('aria-live')).toBe('polite')
    expect(page.text()).toContain('Si la dirección puede utilizarse')
    expect(page.text()).not.toContain('Cuenta creada')
    expect(page.find('a[href="/recuperar-clave"]').exists()).toBe(true)
    expect(refreshSession).not.toHaveBeenCalled()
    expect(navigate).not.toHaveBeenCalled()
  })
  it('preserves the existing Node registration session contract', async () => {
    fetchMock.mockResolvedValue({ user: { id: 'synthetic-user' } })
    const page = await fill()
    await page.get('form').trigger('submit')
    await flushPromises()
    expect(refreshSession).toHaveBeenCalledOnce()
    expect(navigate).toHaveBeenCalledWith('/cuenta')
    expect(page.find('[role="status"]').exists()).toBe(false)
  })
  it('keeps the form and a visible error when the server is unavailable', async () => {
    fetchMock.mockRejectedValue(new Error('synthetic-unavailable'))
    const page = await fill()
    await page.get('form').trigger('submit')
    await flushPromises()
    expect(page.get('[role="alert"]').text()).toContain('No se ha podido crear la cuenta')
    expect(page.find('form').exists()).toBe(true)
    expect(page.find('[role="status"]').exists()).toBe(false)
    expect(refreshSession).not.toHaveBeenCalled()
  })
  it('does not submit without explicit terms acceptance', async () => {
    const page = await fill()
    await page.get('input[aria-label="Acepto las condiciones de la cuenta"]').setValue(false)
    await page.get('form').trigger('submit')
    expect(page.get('[role="alert"]').text()).toContain('Debes aceptar las condiciones')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
