import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdminConfigurableRoleDashboard from '../../app/components/AdminConfigurableRoleDashboard.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({ request: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => mocks.request)

describe('AdminConfigurableRoleDashboard.vue (ADM-025)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.request.mockImplementation((url: string) => {
      if (url.includes('/api/admin/dashboard/config')) {
        return Promise.resolve({
          roleCode: 'order_manager',
          version: 1,
          widgets: [
            { widgetId: 'mandatory_alerts', visible: true, order: 1, colSpan: 12, isMandatory: true },
            { widgetId: 'orders_summary', visible: true, order: 2, colSpan: 6 },
            { widgetId: 'inventory_shortages', visible: true, order: 3, colSpan: 6 }
          ],
          columnPreferences: { ordersTable: ['createdAt', 'total'] }
        })
      }
      if (url.includes('/api/admin/dashboard/views')) {
        return Promise.resolve({
          views: [
            {
              id: 'view-1',
              name: 'Pedidos Urgentes',
              isDefault: true,
              scope: 'role_shared',
              version: 1,
              definition: {}
            }
          ]
        })
      }
      return Promise.resolve({})
    })
  })

  it('renders role dashboard with permanently visible mandatory alert banner and locked mandatory widget', async () => {
    const wrapper = await mountSuspended(AdminConfigurableRoleDashboard)
    await flushPromises()

    expect(wrapper.text()).toContain('Panel Configurable por Rol')
    // Mandatory alert banner
    expect(wrapper.text()).toContain('Canal de Alertas Obligatorias y Críticas')
    expect(wrapper.text()).toContain('Obligatorio por Gobernanza')

    // Mandatory widget is displayed with lock badge
    expect(wrapper.text()).toContain('mandatory_alerts')
    expect(wrapper.text()).toContain('Siempre Visible (Bloqueado)')

    // Checkbox for mandatory widget is disabled
    const mandatoryCheckbox = wrapper
      .findAll('input[type="checkbox"]')
      .find((input) => input.element.closest('.p-4')?.textContent?.includes('mandatory_alerts'))
    expect(mandatoryCheckbox).toBeDefined()
    expect((mandatoryCheckbox?.element as HTMLInputElement).disabled).toBe(true)
  })

  it('renders saved views and allows selecting views', async () => {
    const wrapper = await mountSuspended(AdminConfigurableRoleDashboard)
    await flushPromises()

    expect(wrapper.text()).toContain('Vistas Guardadas para Pedidos')
    expect(wrapper.text()).toContain('Pedidos Urgentes')
    expect(wrapper.text()).toContain('(Default)')
  })
})
