import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdminIntegrationsDashboard from '../../app/components/AdminIntegrationsDashboard.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({ request: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => mocks.request)

describe('AdminIntegrationsDashboard (INT-018, INT-019, INT-021)', () => {
  beforeEach(() => {
    mocks.request.mockReset()
  })

  it('muestra carga mientras espera datos de la API', async () => {
    let finish!: (value: unknown) => void
    mocks.request.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      })
    )

    const wrapper = mount(AdminIntegrationsDashboard)
    expect(wrapper.text()).toContain('Cargando panel de integraciones')
    finish({ quotas: [], runs: [], alerts: [], rules: [], subscriptions: [], deliveries: [] })
    await flushPromises()
  })

  it('comunica error y permite reintentar', async () => {
    mocks.request
      .mockRejectedValueOnce(new Error('error_red'))
      .mockResolvedValue({ quotas: [], runs: [], alerts: [], rules: [], subscriptions: [], deliveries: [] })

    const wrapper = await mountSuspended(AdminIntegrationsDashboard)
    await flushPromises()
    expect(wrapper.text()).toContain('No se pudieron cargar las integraciones')

    await wrapper.get('button[data-testid="retry-load-button"]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).not.toContain('No se pudieron cargar las integraciones')
  })

  it('renderiza las tres pestañas de requerimientos y navega entre ellas', async () => {
    mocks.request.mockResolvedValue({
      quotas: [
        { provider: 'beply', dailyLimit: 100, dailyUsed: 5, hourlyLimit: 20, hourlyUsed: 1 },
        { provider: 'redsys', dailyLimit: 200, dailyUsed: 10, hourlyLimit: 40, hourlyUsed: 2 }
      ],
      runs: [],
      alerts: [],
      rules: [],
      subscriptions: [],
      deliveries: []
    })

    const wrapper = await mountSuspended(AdminIntegrationsDashboard)
    await flushPromises()

    // Pestañas visibles
    expect(wrapper.text()).toContain('Contratos Sandbox')
    expect(wrapper.text()).toContain('Inyección de Fallos')
    expect(wrapper.text()).toContain('Webhooks Salientes')

    // Tab 1 activo por defecto
    expect(wrapper.text()).toContain('Presupuesto de Cuotas')
    expect(wrapper.text()).toContain('beply')

    // Cambiar a Tab 2: Inyección de fallos
    await wrapper.get('button[data-tab="faults"]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('Banco de Pruebas de Resiliencia')
    expect(wrapper.text()).toContain('Simular fallo y probar recuperación')

    // Cambiar a Tab 3: Webhooks salientes
    await wrapper.get('button[data-tab="webhooks"]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('Suscripciones a Webhooks')
    expect(wrapper.text()).toContain('Cola de Dead-Letter (DLQ)')
  })

  it('permite ejecutar simulación de inyección de fallo y veredicto de no corrupción', async () => {
    mocks.request.mockImplementation((url: string, opts?: { method?: string; body?: unknown }) => {
      if (opts?.method === 'POST' && url.includes('/fault-injection/simulate')) {
        return Promise.resolve({
          faultInjected: 'timeout',
          recovered: true,
          recoveryAction: 'retried',
          stateConsistent: true,
          auditDetails: { entityId: 'order-123' }
        })
      }
      return Promise.resolve({
        quotas: [],
        runs: [],
        alerts: [],
        rules: [],
        subscriptions: [],
        deliveries: []
      })
    })

    const wrapper = await mountSuspended(AdminIntegrationsDashboard)
    await flushPromises()

    await wrapper.get('button[data-tab="faults"]').trigger('click')
    await flushPromises()

    // Ejecutar simulación
    await wrapper.get('button[data-testid="run-fault-simulation"]').trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('100% Sin corrupción')
    expect(wrapper.text()).toContain('Recuperado con éxito')
  })
})
