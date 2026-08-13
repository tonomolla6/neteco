export function publicOrderStatus(input: {
  orderStatus: string
  paymentStatus: string
  fulfillmentStatus: string
  paymentMethod: string
}) {
  if (input.orderStatus === 'cancelled') return 'cancelado'
  if (input.fulfillmentStatus === 'delivered') return 'entregado'
  if (input.fulfillmentStatus === 'in_transit') return 'enviado'
  if (input.fulfillmentStatus === 'ready_for_pickup') return 'listo_recogida'
  if (['picking', 'packed'].includes(input.fulfillmentStatus)) return 'preparando'
  if (input.paymentStatus === 'refunded') return 'reembolsado'
  if (input.paymentStatus === 'partially_refunded') return 'reembolso_parcial'
  if (['captured', 'authorized'].includes(input.paymentStatus)) return 'pagado'
  return input.paymentMethod === 'transferencia' ? 'pendiente_transferencia' : 'pendiente_pago'
}
