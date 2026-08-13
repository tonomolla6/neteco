export const ORDER_STATES = ['draft', 'awaiting_payment', 'confirmed', 'on_hold', 'cancelled', 'completed'] as const
export const PAYMENT_STATES = [
  'initiated',
  'pending',
  'authorized',
  'captured',
  'failed',
  'cancelled',
  'partially_refunded',
  'refunded',
  'chargeback'
] as const
export const INVENTORY_STATES = [
  'unreserved',
  'reserved',
  'allocated',
  'picked',
  'shipped',
  'released',
  'returned',
  'damaged'
] as const
export const FULFILLMENT_STATES = [
  'pending',
  'picking',
  'packed',
  'ready_for_pickup',
  'in_transit',
  'delivered',
  'exception',
  'returned'
] as const
export const INVOICE_STATES = [
  'not_requested',
  'queued',
  'issuing',
  'issued',
  'fiscal_pending',
  'failed',
  'rectified'
] as const
export const RETURN_STATES = [
  'requested',
  'approved',
  'rejected',
  'in_transit',
  'received',
  'inspected',
  'resolved'
] as const

export type OrderState = (typeof ORDER_STATES)[number]
export type PaymentState = (typeof PAYMENT_STATES)[number]
export type InventoryState = (typeof INVENTORY_STATES)[number]
export type FulfillmentState = (typeof FULFILLMENT_STATES)[number]
export type InvoiceState = (typeof INVOICE_STATES)[number]
export type ReturnState = (typeof RETURN_STATES)[number]

type TransitionMap<State extends string> = Readonly<Record<State, readonly State[]>>

export const orderTransitions: TransitionMap<OrderState> = {
  draft: ['awaiting_payment', 'cancelled'],
  awaiting_payment: ['confirmed', 'on_hold', 'cancelled'],
  confirmed: ['on_hold', 'cancelled', 'completed'],
  on_hold: ['awaiting_payment', 'confirmed', 'cancelled'],
  cancelled: [],
  completed: []
}

export const paymentTransitions: TransitionMap<PaymentState> = {
  initiated: ['pending', 'authorized', 'captured', 'failed', 'cancelled'],
  pending: ['authorized', 'captured', 'failed', 'cancelled'],
  authorized: ['captured', 'cancelled'],
  captured: ['partially_refunded', 'refunded', 'chargeback'],
  failed: ['pending', 'cancelled'],
  cancelled: [],
  partially_refunded: ['partially_refunded', 'refunded', 'chargeback'],
  refunded: ['chargeback'],
  chargeback: []
}

export const inventoryTransitions: TransitionMap<InventoryState> = {
  unreserved: ['reserved'],
  reserved: ['allocated', 'released'],
  allocated: ['picked', 'released'],
  picked: ['shipped', 'released'],
  shipped: ['returned', 'damaged'],
  released: ['reserved'],
  returned: ['reserved', 'damaged'],
  damaged: []
}

export const fulfillmentTransitions: TransitionMap<FulfillmentState> = {
  pending: ['picking', 'exception'],
  picking: ['packed', 'exception'],
  packed: ['ready_for_pickup', 'in_transit', 'exception'],
  ready_for_pickup: ['delivered', 'exception', 'returned'],
  in_transit: ['delivered', 'exception', 'returned'],
  delivered: ['returned'],
  exception: ['picking', 'packed', 'in_transit', 'returned'],
  returned: []
}

export const invoiceTransitions: TransitionMap<InvoiceState> = {
  not_requested: ['queued'],
  queued: ['issuing', 'failed'],
  issuing: ['issued', 'fiscal_pending', 'failed'],
  issued: ['rectified'],
  fiscal_pending: ['issued', 'failed'],
  failed: ['queued'],
  rectified: []
}

export const returnTransitions: TransitionMap<ReturnState> = {
  requested: ['approved', 'rejected'],
  approved: ['in_transit', 'received'],
  rejected: [],
  in_transit: ['received'],
  received: ['inspected'],
  inspected: ['resolved'],
  resolved: []
}

export function canTransition<State extends string>(map: TransitionMap<State>, from: State, to: State) {
  return map[from].includes(to)
}

export function assertTransition<State extends string>(map: TransitionMap<State>, from: State, to: State) {
  if (!canTransition(map, from, to)) throw new Error(`Invalid transition: ${from} -> ${to}`)
}
