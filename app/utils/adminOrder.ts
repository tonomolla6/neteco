import type { UiColor } from '~~/shared/types/catalog'

/**
 * Vocabulario del pedido para el panel.
 *
 * Un pedido lleva cinco máquinas de estado a la vez —pedido, cobro, inventario,
 * preparación y factura— y en la base son cadenas en inglés: `awaiting_payment`,
 * `partially_refunded`, `ready_for_pickup`. En el listado se resumían en un único
 * estado comercial, que es lo correcto para una tabla; en la ficha hacen falta los
 * cinco, porque la pregunta operativa suele ser exactamente en cuál de ellos está
 * atascado el pedido.
 *
 * Cada etiqueta describe lo que ha pasado, no el nombre del estado interno.
 */
type Meta = { label: string; color: UiColor; icon?: string }

export const ORDER_LIFECYCLE: Record<string, Meta> = {
  draft: { label: 'Borrador', color: 'neutral' },
  awaiting_payment: { label: 'Esperando pago', color: 'warning' },
  confirmed: { label: 'Confirmado', color: 'success' },
  on_hold: { label: 'Retenido', color: 'warning' },
  cancelled: { label: 'Cancelado', color: 'error' },
  completed: { label: 'Completado', color: 'success' }
}

export const PAYMENT_STATE: Record<string, Meta> = {
  initiated: { label: 'Iniciado', color: 'neutral' },
  pending: { label: 'Pendiente', color: 'warning' },
  authorized: { label: 'Autorizado sin cobrar', color: 'info' },
  captured: { label: 'Cobrado', color: 'success' },
  failed: { label: 'Fallido', color: 'error' },
  cancelled: { label: 'Anulado', color: 'neutral' },
  partially_refunded: { label: 'Reembolsado en parte', color: 'warning' },
  refunded: { label: 'Reembolsado', color: 'neutral' },
  chargeback: { label: 'Contracargo', color: 'error' }
}

export const INVENTORY_STATE: Record<string, Meta> = {
  unreserved: { label: 'Sin reservar', color: 'neutral' },
  reserved: { label: 'Reservado', color: 'info' },
  allocated: { label: 'Asignado', color: 'info' },
  picked: { label: 'Recogido del almacén', color: 'info' },
  shipped: { label: 'Salido del almacén', color: 'success' },
  released: { label: 'Reserva liberada', color: 'neutral' },
  returned: { label: 'Devuelto al almacén', color: 'warning' },
  damaged: { label: 'Dañado', color: 'error' }
}

export const INVOICE_STATE: Record<string, Meta> = {
  not_requested: { label: 'Sin factura', color: 'neutral' },
  queued: { label: 'En cola', color: 'info' },
  issuing: { label: 'Emitiéndose', color: 'info' },
  issued: { label: 'Emitida', color: 'success' },
  fiscal_pending: { label: 'Pendiente de envío a Hacienda', color: 'warning' },
  failed: { label: 'Error al emitir', color: 'error' },
  rectified: { label: 'Rectificada', color: 'warning' }
}

export const SHIPMENT_STATE: Record<string, Meta> = {
  pending: { label: 'Pendiente de preparación', color: 'neutral' },
  picking: { label: 'En preparación', color: 'info' },
  packed: { label: 'Embalado', color: 'info' },
  ready_for_pickup: { label: 'Listo para recoger', color: 'success' },
  created: { label: 'Creada', color: 'neutral' },
  label_printed: { label: 'Etiqueta impresa', color: 'info' },
  picked_up: { label: 'Recogida por el transportista', color: 'info' },
  in_transit: { label: 'En tránsito', color: 'info' },
  out_for_delivery: { label: 'En reparto', color: 'info' },
  delivered: { label: 'Entregada', color: 'success' },
  exception: { label: 'Incidencia', color: 'error' },
  cancelled: { label: 'Anulada', color: 'neutral' },
  returned: { label: 'Devuelta al remitente', color: 'warning' }
}

export const RETURN_STATE: Record<string, Meta> = {
  requested: { label: 'Solicitada', color: 'warning' },
  approved: { label: 'Aprobada', color: 'info' },
  rejected: { label: 'Rechazada', color: 'error' },
  in_transit: { label: 'De camino', color: 'info' },
  received: { label: 'Recibida', color: 'info' },
  inspected: { label: 'Revisada', color: 'info' },
  resolved: { label: 'Resuelta', color: 'success' }
}

export const REFUND_STATE: Record<string, Meta> = {
  requested: { label: 'Solicitado', color: 'warning' },
  pending: { label: 'En curso', color: 'warning' },
  succeeded: { label: 'Devuelto', color: 'success' },
  failed: { label: 'Fallido', color: 'error' },
  cancelled: { label: 'Anulado', color: 'neutral' }
}

/**
 * Traza del pedido. `event_type` es un identificador de dominio con puntos; en
 * pantalla se lee como una frase en pasado, que es como lo cuenta quien atiende:
 * «el banco confirmó el cobro», no «payment.captured».
 */
export const ORDER_EVENT: Record<string, { label: string; icon: string }> = {
  'order.created': { label: 'Pedido realizado', icon: 'i-lucide-shopping-cart' },
  'order.confirmed': { label: 'Pedido confirmado', icon: 'i-lucide-circle-check' },
  'order.transitioned': { label: 'Cambio de estado', icon: 'i-lucide-arrow-right-left' },
  'order.cancellation_requested': { label: 'Cancelación solicitada', icon: 'i-lucide-circle-x' },
  'order.cancelled': { label: 'Pedido cancelado', icon: 'i-lucide-circle-x' },
  'payment.initiated': { label: 'Pago iniciado', icon: 'i-lucide-credit-card' },
  'payment.authorized': { label: 'Pago autorizado', icon: 'i-lucide-credit-card' },
  'payment.captured': { label: 'Cobro confirmado por el banco', icon: 'i-lucide-banknote' },
  'payment.failed': { label: 'Pago rechazado', icon: 'i-lucide-circle-alert' },
  'payment.expired': { label: 'Intento de pago caducado', icon: 'i-lucide-clock' },
  'refund.requested': { label: 'Reembolso solicitado', icon: 'i-lucide-undo-2' },
  'refund.succeeded': { label: 'Reembolso completado', icon: 'i-lucide-undo-2' },
  'refund.failed': { label: 'Reembolso fallido', icon: 'i-lucide-circle-alert' },
  'invoice.issued': { label: 'Factura emitida', icon: 'i-lucide-file-text' },
  'invoice.credit.issued': { label: 'Factura rectificativa emitida', icon: 'i-lucide-file-minus' },
  'invoice.failed': { label: 'Error al emitir la factura', icon: 'i-lucide-circle-alert' },
  'shipment.created': { label: 'Expedición creada', icon: 'i-lucide-truck' },
  'shipment.tracking.updated': { label: 'Seguimiento actualizado', icon: 'i-lucide-map-pin' },
  'shipment.cancelled': { label: 'Expedición anulada', icon: 'i-lucide-truck' },
  'return.requested': { label: 'Devolución solicitada', icon: 'i-lucide-package-x' },
  'return.transitioned': { label: 'Devolución actualizada', icon: 'i-lucide-package-x' },
  'inventory.reserved': { label: 'Stock reservado', icon: 'i-lucide-boxes' },
  'inventory.released': { label: 'Reserva liberada', icon: 'i-lucide-boxes' }
}

/** Quién lo hizo. Importa al reclamar: no es lo mismo un rechazo del banco que una anulación nuestra. */
export const EVENT_ACTOR: Record<string, { label: string; color: UiColor }> = {
  customer: { label: 'Cliente', color: 'info' },
  staff: { label: 'Equipo NETECO', color: 'primary' },
  system: { label: 'Automático', color: 'neutral' },
  provider: { label: 'Proveedor externo', color: 'warning' }
}

export const PAYMENT_METHOD_LABEL: Record<string, string> = {
  tarjeta: 'Tarjeta',
  card: 'Tarjeta',
  bizum: 'Bizum',
  transferencia: 'Transferencia bancaria',
  contrareembolso: 'Contra reembolso'
}

export function metaFor(map: Record<string, Meta>, value: string): Meta {
  return map[value] ?? { label: value, color: 'neutral' }
}

/**
 * Color de texto por rol semántico. Un mapa literal y no una clase interpolada:
 * Tailwind resuelve las clases leyendo el código fuente, así que `text-[var(--ui-${color})]`
 * compila a nada y el estado sale en negro.
 */
export const STATE_TEXT: Record<UiColor, string> = {
  primary: 'text-neteco-700',
  secondary: 'text-[var(--text)]',
  success: 'text-[var(--ui-success)]',
  info: 'text-[var(--ui-info)]',
  warning: 'text-[var(--ui-warning)]',
  error: 'text-[var(--ui-error)]',
  neutral: 'text-[var(--text-strong)]'
}

/** Los códigos de respuesta de Redsys no dicen nada por sí solos en una pantalla. */
export function redsysReason(code: string | null) {
  if (!code) return null
  const numeric = Number(code)
  if (numeric >= 0 && numeric <= 99) return 'Autorizada'
  const known: Record<string, string> = {
    '0101': 'Tarjeta caducada',
    '0102': 'Tarjeta bloqueada temporalmente o bajo sospecha de fraude',
    '0106': 'PIN introducido demasiadas veces',
    '0125': 'Tarjeta no efectiva',
    '0129': 'Código de seguridad incorrecto',
    '0180': 'Tarjeta ajena al servicio',
    '0184': 'Error en la autenticación del titular',
    '0190': 'Denegada por el banco emisor, sin motivo especificado',
    '0191': 'Fecha de caducidad errónea',
    '0195': 'Se requiere autenticación del titular',
    '0202': 'Tarjeta en excepción transitoria o bajo sospecha de fraude',
    '0904': 'Comercio no registrado en el centro autorizador',
    '0909': 'Error del sistema',
    '0913': 'Pedido repetido',
    '0944': 'Sesión incorrecta',
    '0950': 'Devolución no permitida',
    '9912': 'Emisor no disponible',
    '9915': 'Pago cancelado por el cliente'
  }
  return known[code] ?? `Denegada por el banco (código ${code})`
}
