import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CustomerAccountManagerCard from '../../app/components/CustomerAccountManagerCard.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({
  request: vi.fn()
}))

mockNuxtImport('useRequestFetch', () => () => mocks.request)

describe('Componente CustomerAccountManagerCard.vue (SUP-016)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('muestra contacto visible del gestor asignado con SLA correspondiente', async () => {
    mocks.request.mockResolvedValueOnce({
      hasAssignedManager: true,
      manager: {
        name: 'Carlos Ruiz',
        email: 'carlos.ruiz@neteco.es',
        phone: '+34 962 123 456 ext 102',
        availabilitySchedule: 'L-V 08:30 - 17:30',
        slaTier: 'vip',
        slaResponseHours: 2,
        slaDescription: 'SLA VIP: Respuesta en menos de 2 horas laborables.'
      }
    })

    const wrapper = await mountSuspended(CustomerAccountManagerCard)
    await flushPromises()

    expect(wrapper.text()).toContain('Carlos Ruiz')
    expect(wrapper.text()).toContain('carlos.ruiz@neteco.es')
    expect(wrapper.text()).toContain('+34 962 123 456 ext 102')
    expect(wrapper.text()).toContain('SLA VIP')
    expect(wrapper.text()).toContain('2 horas')
  })

  it('muestra canales generales de soporte cuando el cliente no tiene gestor dedicado asignado', async () => {
    mocks.request.mockResolvedValueOnce({
      hasAssignedManager: false,
      generalSupport: {
        email: 'soporte@neteco.es',
        phone: '+34 962 000 000',
        hours: 'L-V 08:00 - 18:00'
      }
    })

    const wrapper = await mountSuspended(CustomerAccountManagerCard)
    await flushPromises()

    expect(wrapper.text()).toContain('soporte@neteco.es')
    expect(wrapper.text()).toContain('+34 962 000 000')
    expect(wrapper.text()).not.toContain('undefined')
    expect(wrapper.text()).not.toContain('null')
  })
})
