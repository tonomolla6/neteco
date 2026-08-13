import { describe, expect, it } from 'vitest'
import { publicOrderStatus } from '../../server/utils/order-status'

const base = {
  orderStatus: 'confirmed',
  paymentStatus: 'captured',
  fulfillmentStatus: 'pending',
  paymentMethod: 'tarjeta'
}

describe('public order status', () => {
  it('distinguishes preparation, pickup, shipment and delivery', () => {
    expect(publicOrderStatus({ ...base, fulfillmentStatus: 'picking' })).toBe('preparando')
    expect(publicOrderStatus({ ...base, fulfillmentStatus: 'ready_for_pickup' })).toBe('listo_recogida')
    expect(publicOrderStatus({ ...base, fulfillmentStatus: 'in_transit' })).toBe('enviado')
    expect(publicOrderStatus({ ...base, fulfillmentStatus: 'delivered' })).toBe('entregado')
  })

  it('keeps cancellation and payment states explicit', () => {
    expect(publicOrderStatus({ ...base, orderStatus: 'cancelled' })).toBe('cancelado')
    expect(publicOrderStatus({ ...base, paymentStatus: 'refunded' })).toBe('reembolsado')
    expect(publicOrderStatus({ ...base, paymentStatus: 'partially_refunded' })).toBe('reembolso_parcial')
    expect(publicOrderStatus({ ...base, paymentStatus: 'pending', paymentMethod: 'transferencia' })).toBe(
      'pendiente_transferencia'
    )
    expect(publicOrderStatus({ ...base, paymentStatus: 'pending' })).toBe('pendiente_pago')
  })
})
