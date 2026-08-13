import { createError } from 'h3'
import { assertTransition, fulfillmentTransitions, type FulfillmentState } from './states'

export type AdminOrderStatus = 'pagado' | 'preparando' | 'listo_recogida' | 'enviado' | 'entregado'

export function nextAdminFulfillmentStatus(input: {
  current: FulfillmentState
  requested: AdminOrderStatus
  shippingMethod: string
}) {
  if (input.requested === 'pagado') return input.current
  if (input.requested === 'preparando') {
    assertTransition(fulfillmentTransitions, input.current, 'picking')
    return 'picking' as const
  }
  if (input.requested === 'listo_recogida') {
    if (input.shippingMethod !== 'recogida') {
      throw createError({ statusCode: 409, statusMessage: 'Solo un pedido con recogida puede marcarse listo' })
    }
    const packed = input.current === 'picking' ? 'packed' : input.current
    if (input.current === 'picking') assertTransition(fulfillmentTransitions, input.current, packed)
    assertTransition(fulfillmentTransitions, packed, 'ready_for_pickup')
    return 'ready_for_pickup' as const
  }
  if (input.requested === 'enviado') {
    if (input.shippingMethod === 'recogida') {
      throw createError({ statusCode: 409, statusMessage: 'Un pedido con recogida no se marca como enviado' })
    }
    const packed = input.current === 'picking' ? 'packed' : input.current
    if (input.current === 'picking') assertTransition(fulfillmentTransitions, input.current, packed)
    assertTransition(fulfillmentTransitions, packed, 'in_transit')
    return 'in_transit' as const
  }
  assertTransition(fulfillmentTransitions, input.current, 'delivered')
  return 'delivered' as const
}
