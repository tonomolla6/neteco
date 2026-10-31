import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdminPaymentContingencyPanel from '../../app/components/AdminPaymentContingencyPanel.vue'
import '#app/nuxt-vitest-app-entry'

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => fetchMock)
mockNuxtImport('$fetch', () => fetchMock)

const sampleContingencyData = {
  routes: [
    {
      id: 'route-es',
      marketCode: 'ES',
      primaryProvider: 'redsys',
      alternativeProvider: 'euro_contingency',
      activeProvider: 'redsys',
      contingencyActive: false,
      contingencyReason: null,
      circuitState: 'closed',
      version: 1
    }
  ],
  reconciliations: [
    {
      id: 'rec-1',
      intentId: 'pi-01',
      orderId: '55555555-5555-4555-8555-555555555555',
      provider: 'redsys',
      providerReference: 'redsys-123',
      amountCents: 6000,
      currency: 'EUR',
      status: 'settled',
      settledAt: '2026-10-31T09:00:00Z'
    }
  ]
}

describe('AdminPaymentContingencyPanel component', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('renders loading state before contingency status arrives', async () => {
    fetchMock.mockReturnValue(new Promise(() => {}))
    const wrapper = await mountSuspended(AdminPaymentContingencyPanel)
    expect(wrapper.text()).toContain('Cargando estado de pasarelas...')
  })

  it('renders routing table, active provider and toggle button', async () => {
    fetchMock.mockResolvedValueOnce(sampleContingencyData)
    const wrapper = await mountSuspended(AdminPaymentContingencyPanel)
    await flushPromises()

    expect(wrapper.text()).toContain('Pasarelas de Pago y Contingencia')
    expect(wrapper.text()).toContain('Mercado ES')
    expect(wrapper.text()).toContain('Activo: redsys')
    expect(wrapper.find('[data-testid="toggle-contingency-btn"]').exists()).toBe(true)
  })

  it('triggers contingency switch when toggle button is clicked', async () => {
    fetchMock.mockResolvedValueOnce(sampleContingencyData)
    fetchMock.mockResolvedValueOnce({
      ...sampleContingencyData.routes[0],
      activeProvider: 'euro_contingency',
      contingencyActive: true,
      version: 2
    })

    const wrapper = await mountSuspended(AdminPaymentContingencyPanel)
    await flushPromises()

    await wrapper.find('[data-testid="toggle-contingency-btn"]').trigger('click')
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/admin/payments/contingency/toggle',
      expect.objectContaining({
        method: 'POST'
      })
    )
  })
})
