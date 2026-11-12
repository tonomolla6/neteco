import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import Panel from '../../app/components/BeplyOrderStatus.vue'
import type { BeplyOrderView } from '../../shared/beply-orders'
const view: BeplyOrderView = {
  audience: 'customer',
  orderId: '10000000-0000-4000-8000-000000000010',
  status: 'synced',
  version: 2,
  syncedVersion: 2,
  state: 'shipped',
  stateLabel: 'Enviado',
  providerOrderId: '71',
  providerCode: 'PED71',
  erp: { served: true, deliveryNoteIds: ['81'], invoiceIds: ['91'] },
  erpCheckedAt: '2026-11-12T10:00:00Z',
  expectedDeliveryAt: '2026-11-14T10:00:00Z',
  shipments: [{ parcelIndex: 0, carrier: 'Synthetic carrier', trackingNumber: 'TRACK1', shipmentNumber: 'SHIP1' }],
  lastErrorCode: null
}
describe('Beply order account/admin display', () => {
  it('shows local shipment state, estimated date, tracking and ERP documents', () => {
    const panel = mount(Panel, { props: { view } })
    expect(panel.text()).toContain('Enviado')
    expect(panel.text()).toContain('Synthetic carrier')
    expect(panel.text()).toContain('TRACK1')
    expect(panel.text()).toContain('Albarán generado')
    expect(panel.text()).toContain('Facturado')
    expect(panel.text()).toContain('Fecha prevista')
  })
  it('never treats served/invoiced ERP facts as customer delivery', () => {
    const panel = mount(Panel, {
      props: { view: { ...view, state: 'preparing', stateLabel: 'En preparación', shipments: [] } }
    })
    expect(panel.text()).toContain('En preparación')
    expect(panel.text()).not.toContain('Entregado')
  })
  it('shows pending/stale/unavailable states without a false success', () => {
    expect(mount(Panel, { props: { view: null, pending: true } }).text()).toContain('Consultando')
    expect(mount(Panel, { props: { view: null, failed: true } }).text()).toContain('No se ha podido')
    const panel = mount(Panel, { props: { view: { ...view, status: 'pending', syncedVersion: 1 } } })
    expect(panel.text()).toContain('Pendiente de actualizar')
    expect(panel.text()).toContain('Última consulta')
  })
  it('renders provider strings as text and clears all private data while authorization changes', async () => {
    const panel = mount(Panel, {
      props: { view: { ...view, shipments: [{ ...view.shipments[0]!, carrier: '<script>alert(1)</script>' }] } }
    })
    expect(panel.find('script').exists()).toBe(false)
    await panel.setProps({ view: null, pending: true })
    expect(panel.text()).not.toContain('TRACK1')
    expect(panel.text()).not.toContain('Facturado')
  })
})
