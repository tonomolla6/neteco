import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AdminCommandPalette from '../../app/components/AdminCommandPalette.vue'
import { adminNavigationGroups } from '../../shared/admin-navigation'
import '#app/nuxt-vitest-app-entry'

// UI003 palette acceptance: only supplied authorized destinations; no private
// data/network search or invented recent actions. Native labelled trigger and
// modal/search/listbox semantics; Ctrl/Cmd+K, arrows, Enter, Escape, focus trap
// and focus return; local accent-insensitive name/category matching; empty
// results, authority loss/group replacement, unmount and duplicate navigation;
// supplied legacy Node routes preserved and mobile overflow bounded.
const mocks = vi.hoisted(() => ({ navigate: vi.fn(), request: vi.fn() }))
mockNuxtImport('navigateTo', () => mocks.navigate)
mockNuxtImport('useRequestFetch', () => () => mocks.request)
const groups = () =>
  adminNavigationGroups({
    source: 'cloudflare',
    identityId: '10000000-0000-4000-8000-000000000001',
    sessionId: '20000000-0000-4000-8000-000000000001',
    sessionVersion: 1,
    state: 'ready',
    permissions: ['catalog.write', 'support.manage']
  })
type Wrapper = Awaited<ReturnType<typeof mountSuspended>>
const mounted: Array<{ wrapper: Wrapper; host: HTMLElement }> = []
async function render(value = groups(), enabled = true) {
  const host = document.createElement('div')
  document.body.append(host)
  const wrapper = await mountSuspended(AdminCommandPalette, { props: { groups: value, enabled }, attachTo: host })
  mounted.push({ wrapper, host })
  return wrapper
}
async function open(wrapper: Wrapper) {
  await wrapper.get('[data-palette-open]').trigger('click')
  await flushPromises()
}
async function shortcut(key: 'ctrlKey' | 'metaKey' = 'ctrlKey', extra = {}) {
  const event = new KeyboardEvent('keydown', { key: 'k', [key]: true, bubbles: true, cancelable: true, ...extra })
  window.dispatchEvent(event)
  await flushPromises()
  return event
}
beforeEach(() => {
  mocks.navigate.mockReset().mockResolvedValue(undefined)
  mocks.request.mockReset()
})
afterEach(() => {
  for (const { wrapper, host } of mounted.splice(0)) {
    wrapper.unmount()
    host.remove()
  }
  vi.restoreAllMocks()
})

describe('authorized administrative command palette', () => {
  it('does not steal focus from the current task when authorized groups refresh while closed', async () => {
    const wrapper = await render()
    const taskInput = document.createElement('input')
    mounted.at(-1)!.host.append(taskInput)
    taskInput.focus()
    await wrapper.setProps({
      groups: [{ label: 'Operación', links: [{ to: '/admin/soporte', label: 'Soporte', icon: '' }] }]
    })
    await flushPromises()
    expect(document.activeElement).toBe(taskInput)
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
  })
  it('has a native labelled trigger and opens a labelled modal with focused search', async () => {
    const wrapper = await render()
    expect(wrapper.get('[data-palette-open]').element.tagName).toBe('BUTTON')
    expect(wrapper.get('[data-palette-open]').attributes('aria-label')).toBe('Buscar sección del panel')
    expect(wrapper.get('[data-palette-open]').attributes('aria-keyshortcuts')).toBe('Control+K Meta+K')
    expect(wrapper.get('[data-palette-open] svg').attributes('aria-hidden')).toBe('true')
    expect(wrapper.get('[data-palette-open] svg').attributes('tabindex')).toBeUndefined()
    expect(wrapper.get('[data-palette-open]').attributes('aria-expanded')).toBe('false')
    await open(wrapper)
    const dialog = wrapper.get('[role="dialog"]'),
      input = wrapper.get('[data-palette-query]')
    expect(dialog.attributes('aria-modal')).toBe('true')
    expect(wrapper.find(`label[for="${input.attributes('id')}"]`).exists()).toBe(true)
    expect(document.activeElement).toBe(input.element)
    expect(wrapper.get('[data-palette-open]').attributes('aria-expanded')).toBe('true')
  })
  it.each(['ctrlKey', 'metaKey'] as const)(
    'opens with %s+K and prevents the browser shortcut only when enabled',
    async (key) => {
      const wrapper = await render(),
        event = await shortcut(key)
      expect(event.defaultPrevented).toBe(true)
      expect(wrapper.find('[role="dialog"]').exists()).toBe(true)
    }
  )
  it('does not open with a plain K, composing input or repeated shortcut', async () => {
    const wrapper = await render()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', bubbles: true }))
    await shortcut('ctrlKey', { isComposing: true })
    await shortcut('ctrlKey', { repeat: true })
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
  })
  it('searches local names and category labels without accents, preserving only supplied destinations', async () => {
    const wrapper = await render()
    await open(wrapper)
    await wrapper.get('[data-palette-query]').setValue('catalogo precios')
    expect(wrapper.get('[data-palette-results]').text()).toContain('Precios')
    expect(wrapper.get('[data-palette-results]').text()).not.toContain('Soporte')
    await wrapper.get('[data-palette-query]').setValue('busqueda')
    expect(wrapper.get('[data-palette-results]').text()).toContain('Relevancia de búsqueda')
    expect(mocks.request).not.toHaveBeenCalled()
    expect(mocks.navigate).not.toHaveBeenCalled()
    expect(wrapper.text()).not.toContain('Recientes')
  })
  it('does not expose missing permissions or search private order/customer data', async () => {
    const wrapper = await render()
    await open(wrapper)
    expect(wrapper.get('[data-palette-results]').text()).not.toContain('Pedidos')
    await wrapper.get('[data-palette-query]').setValue('pedido cliente 123')
    expect(wrapper.find('[data-palette-empty]').exists()).toBe(true)
    expect(wrapper.findAll('[role="option"]')).toHaveLength(0)
    await wrapper.get('[data-palette-query]').trigger('keydown', { key: 'Enter' })
    expect(mocks.request).not.toHaveBeenCalled()
    expect(mocks.navigate).not.toHaveBeenCalled()
  })
  it('moves selection with wrapping arrows and navigates the current authorized destination on Enter', async () => {
    const wrapper = await render()
    await open(wrapper)
    const input = wrapper.get('[data-palette-query]')
    await input.trigger('keydown', { key: 'ArrowUp' })
    const active = input.attributes('aria-activedescendant')
    expect(wrapper.get(`[id="${active}"]`).text()).toContain('Relevancia de búsqueda')
    await input.trigger('keydown', { key: 'ArrowDown' })
    const wrapped = input.attributes('aria-activedescendant')
    expect(wrapper.get(`[id="${wrapped}"]`).text()).toContain('Ficha de cliente')
    // Operación lists ten links for support.manage before Catálogo (Ficha de cliente, Soporte, Análisis de
    // contactos, Asistente y educación, Solicitudes B2B, Chat de soporte, Soporte RCA, Gestores de cuenta B2B,
    // Reseñas y preguntas, Suplantación de soporte), so Productos is ten steps after the wrap.
    await input.trigger('keydown', { key: 'ArrowDown' })
    await input.trigger('keydown', { key: 'ArrowDown' })
    await input.trigger('keydown', { key: 'ArrowDown' })
    await input.trigger('keydown', { key: 'ArrowDown' })
    await input.trigger('keydown', { key: 'ArrowDown' })
    await input.trigger('keydown', { key: 'ArrowDown' })
    await input.trigger('keydown', { key: 'ArrowDown' })
    await input.trigger('keydown', { key: 'ArrowDown' })
    await input.trigger('keydown', { key: 'ArrowDown' })
    await input.trigger('keydown', { key: 'ArrowDown' })
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith('/admin/productos')
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
  })
  it('resets keyboard selection to the first match when query changes', async () => {
    const wrapper = await render()
    await open(wrapper)
    const input = wrapper.get('[data-palette-query]')
    await input.trigger('keydown', { key: 'ArrowUp' })
    await input.setValue('familias')
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith('/admin/categorias')
  })
  it('Escape closes, clears the query and restores focus to its trigger', async () => {
    const wrapper = await render()
    await open(wrapper)
    await wrapper.get('[data-palette-query]').setValue('productos')
    await wrapper.get('[data-palette-query]').trigger('keydown', { key: 'Escape' })
    await flushPromises()
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    expect(document.activeElement).toBe(wrapper.get('[data-palette-open]').element)
    await open(wrapper)
    expect((wrapper.get('[data-palette-query]').element as HTMLInputElement).value).toBe('')
  })
  it('keeps Tab focus inside the modal and supports a visible close button', async () => {
    const wrapper = await render()
    await open(wrapper)
    const input = wrapper.get('[data-palette-query]'),
      close = wrapper.get('[data-palette-close]')
    await input.trigger('keydown', { key: 'Tab' })
    expect(document.activeElement).toBe(close.element)
    await close.trigger('keydown', { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(input.element)
    await close.trigger('click')
    await flushPromises()
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
  })
  it('closes on its backdrop without accidentally navigating', async () => {
    const wrapper = await render()
    await open(wrapper)
    await wrapper.get('[data-palette-overlay]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    expect(mocks.navigate).not.toHaveBeenCalled()
  })
  it('synchronously closes and clears results when authority is revoked', async () => {
    const wrapper = await render()
    await open(wrapper)
    await wrapper.get('[data-palette-query]').setValue('precios')
    await wrapper.setProps({ enabled: false })
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Precios')
    const event = await shortcut()
    expect(event.defaultPrevented).toBe(false)
    await wrapper.setProps({ enabled: true })
    await open(wrapper)
    expect((wrapper.get('[data-palette-query]').element as HTMLInputElement).value).toBe('')
  })
  it('closes on an authoritative group replacement rather than using a stale selected destination', async () => {
    const wrapper = await render()
    await open(wrapper)
    await wrapper.get('[data-palette-query]').setValue('precios')
    await wrapper.setProps({
      groups: [{ label: 'Operación', links: [{ to: '/admin/soporte', label: 'Soporte', icon: '' }] }]
    })
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    await open(wrapper)
    await wrapper.get('[data-palette-query]').trigger('keydown', { key: 'Enter' })
    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith('/admin/soporte')
  })
  it.each([false, true])('does not open with no destinations (enabled=%s)', async (enabled) => {
    const wrapper = await render([], enabled)
    expect(wrapper.get('[data-palette-open]').attributes('disabled')).toBeDefined()
    const event = await shortcut()
    expect(event.defaultPrevented).toBe(false)
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
  })
  it('preserves the authorized legacy Node destinations provided by its parent', async () => {
    const wrapper = await render([
      { label: 'Sistema', links: [{ to: '/admin/flags', label: 'Feature flags', icon: '' }] }
    ])
    await open(wrapper)
    await wrapper.get('[data-palette-query]').trigger('keydown', { key: 'Enter' })
    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith('/admin/flags')
  })
  it('rejects external or traversal destinations rather than turning props into arbitrary navigation', async () => {
    const wrapper = await render([
      {
        label: 'Sistema',
        links: [
          { to: 'https://externo.example', label: 'Externo', icon: '' },
          { to: '/admin/../cuenta', label: 'Fuera del panel', icon: '' }
        ]
      }
    ])
    await shortcut()
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    expect(mocks.navigate).not.toHaveBeenCalled()
  })
  it('bounds mobile width and scrolls long destination labels inside the panel', async () => {
    const wrapper = await render()
    await open(wrapper)
    expect(wrapper.get('[role="dialog"]').attributes('class')).toContain('max-w-xl')
    expect(wrapper.get('[data-palette-results]').attributes('class')).toContain('overflow-y-auto')
    expect(wrapper.get('[data-palette-results]').attributes('class')).toContain('break-words')
  })
  it('prevents duplicate navigation and reports a failed route instead of pretending an action completed', async () => {
    let reject!: (error: unknown) => void
    mocks.navigate.mockReturnValueOnce(
      new Promise((_resolve, fail) => {
        reject = fail
      })
    )
    const wrapper = await render()
    await open(wrapper)
    const option = wrapper.get('[role="option"]')
    await option.trigger('click')
    ;(option.element as HTMLElement).click()
    expect(mocks.navigate).toHaveBeenCalledTimes(1)
    reject(new Error('route failed'))
    await flushPromises()
    expect(wrapper.text()).toContain('No se ha podido abrir')
  })
  it('removes global shortcuts on unmount', async () => {
    const remove = vi.spyOn(window, 'removeEventListener')
    const wrapper = await render()
    wrapper.unmount()
    await shortcut()
    expect(remove).toHaveBeenCalledWith('keydown', expect.any(Function))
    expect(mocks.navigate).not.toHaveBeenCalled()
  })
})
