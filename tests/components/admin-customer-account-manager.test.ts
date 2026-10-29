import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AdminCustomerAccountManager from '../../app/components/AdminCustomerAccountManager.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  fetch: vi.fn()
}))

mockNuxtImport('useRequestFetch', () => () => mocks.request)
mockNuxtImport('$fetch', () => mocks.fetch)

describe('Componente AdminCustomerAccountManager.vue (SUP-016)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('monta el panel de gestor y muestra asignación, notas, oportunidades y calendario', async () => {
    mocks.request
      .mockResolvedValueOnce({
        manager: {
          id: '11111111-0000-0000-0000-000000000001',
          managerName: 'Elena Garrido',
          managerEmail: 'elena.garrido@neteco.es',
          managerPhone: '+34 962 555 666',
          slaTier: 'vip',
          slaResponseHours: 2,
          slaDescription: 'Compromiso de respuesta 2h.'
        }
      })
      .mockResolvedValueOnce({
        notes: [
          {
            id: '22222222-0000-0000-0000-000000000001',
            title: 'Historial de solvencia excelente',
            content: 'Línea de crédito aprobada.',
            category: 'credit'
          }
        ]
      })
      .mockResolvedValueOnce({
        opportunities: [
          {
            id: '33333333-0000-0000-0000-000000000001',
            title: 'Suministro lavanderías 2027',
            estimatedValueCents: 2500000,
            stage: 'proposal',
            probabilityPercent: 70
          }
        ]
      })
      .mockResolvedValueOnce({
        events: [
          {
            id: '44444444-0000-0000-0000-000000000001',
            subject: 'Reunión anual de precios marco',
            scheduledAt: '2026-11-12T10:00:00Z',
            durationMinutes: 60,
            channel: 'video',
            status: 'confirmed'
          }
        ]
      })

    const wrapper = await mountSuspended(AdminCustomerAccountManager, {
      props: {
        customerId: '30000000-0000-4000-8000-000000000046'
      }
    })
    await flushPromises()

    expect(wrapper.text()).toContain('Gestor de Cuenta y CRM (SUP-016)')
    expect(wrapper.text()).toContain('Elena Garrido')
    expect(wrapper.text()).toContain('elena.garrido@neteco.es')
    expect(wrapper.text()).toContain('VIP')
    expect(wrapper.text()).toContain('Historial de solvencia excelente')
    expect(wrapper.text()).toContain('Suministro lavanderías 2027')
    expect(wrapper.text()).toContain('25000.00 €')
    expect(wrapper.text()).toContain('Reunión anual de precios marco')
  })
})
