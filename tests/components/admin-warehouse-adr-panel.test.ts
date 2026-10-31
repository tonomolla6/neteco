import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import AdminWarehouseAdrPanel from '../../app/components/AdminWarehouseAdrPanel.vue'
import '#app/nuxt-vitest-app-entry'

const MOCK_LABEL = {
  source: 'cloudflare',
  variantId: 'var-cloro-5l',
  lotNumber: 'LOT-202610-042',
  productName: 'Hipoclorito Sódico Neteco 150g/L',
  variantLabel: 'Garrafa 5 Litros',
  netQuantity: '5 L',
  unNumber: 'UN 1791',
  properShippingName: 'HIPOCLORITO EN SOLUCIÓN',
  signalWord: 'PELIGRO',
  pictograms: ['GHS05', 'GHS09'],
  hazardStatements: ['H314: Provoca quemaduras graves en la piel'],
  precautionaryStatements: ['P280: Llevar guantes y protección ocular'],
  ufiCode: 'UFI: 42A0-E03Y-9008-7H9X',
  emergencyPhone: '+34 91 562 04 20',
  supplierInfo: {
    name: 'Neteco Professional Cleaning S.L.',
    address: 'Polígono Industrial Los Ángeles, Getafe, Madrid',
    vatNumber: 'ES-B84920194'
  },
  manufacturingDate: '2026-10-25',
  expiryDate: '2027-10-25',
  specVersion: 1,
  sdsVersion: 'REV-2026.3',
  barcodeData: '01NET-CLO-5L10LOT-202610-0421720271025',
  generatedAt: '2026-10-29T12:00:00Z'
}

registerEndpoint('/api/warehouse/operational-assets/generate-label', () => MOCK_LABEL)

describe('AdminWarehouseAdrPanel component (MED-022)', () => {
  it('renders warehouse ADR panel and generates CLP container label preview with emergency phone and GHS pictograms', async () => {
    const wrapper = await mountSuspended(AdminWarehouseAdrPanel)
    expect(wrapper.find('[data-testid="admin-warehouse-adr-panel"]').exists()).toBe(true)

    // Trigger label generation via form submit
    const form = wrapper.find('form')
    expect(form.exists()).toBe(true)
    await form.trigger('submit')

    await vi.waitFor(() => expect(wrapper.find('[data-testid="clp-label-preview"]').exists()).toBe(true))
    await flushPromises()

    const text = wrapper.text()
    expect(text).toContain('Assets Operativos de Almacén y Gestión ADR')
    expect(text).toContain('Hipoclorito Sódico Neteco 150g/L')
    expect(text).toContain('PELIGRO')
    expect(text).toContain('GHS05')
    expect(text).toContain('GHS09')
    expect(text).toContain('+34 91 562 04 20')
  })
})
