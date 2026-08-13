import { describe, expect, it } from 'vitest'
import { nextAdminFulfillmentStatus } from '../../server/domain/admin-order-status'

describe('admin order status transitions', () => {
  it('moves pickup orders through preparation to ready for pickup', () => {
    expect(nextAdminFulfillmentStatus({ current: 'pending', requested: 'pagado', shippingMethod: 'recogida' })).toBe(
      'pending'
    )
    expect(
      nextAdminFulfillmentStatus({ current: 'pending', requested: 'preparando', shippingMethod: 'recogida' })
    ).toBe('picking')
    expect(
      nextAdminFulfillmentStatus({ current: 'picking', requested: 'listo_recogida', shippingMethod: 'recogida' })
    ).toBe('ready_for_pickup')
    expect(
      nextAdminFulfillmentStatus({ current: 'packed', requested: 'listo_recogida', shippingMethod: 'recogida' })
    ).toBe('ready_for_pickup')
  })

  it('moves delivery orders through preparation, shipment and delivery', () => {
    expect(nextAdminFulfillmentStatus({ current: 'picking', requested: 'enviado', shippingMethod: 'envio' })).toBe(
      'in_transit'
    )
    expect(nextAdminFulfillmentStatus({ current: 'packed', requested: 'enviado', shippingMethod: 'envio' })).toBe(
      'in_transit'
    )
    expect(nextAdminFulfillmentStatus({ current: 'in_transit', requested: 'entregado', shippingMethod: 'envio' })).toBe(
      'delivered'
    )
  })

  it('rejects pickup/shipping state mismatches and invalid jumps', () => {
    expect(() =>
      nextAdminFulfillmentStatus({ current: 'picking', requested: 'enviado', shippingMethod: 'recogida' })
    ).toThrow('Un pedido con recogida no se marca como enviado')
    expect(() =>
      nextAdminFulfillmentStatus({ current: 'picking', requested: 'listo_recogida', shippingMethod: 'envio' })
    ).toThrow('Solo un pedido con recogida puede marcarse listo')
    expect(() =>
      nextAdminFulfillmentStatus({ current: 'pending', requested: 'listo_recogida', shippingMethod: 'recogida' })
    ).toThrow('Invalid transition')
  })
})
