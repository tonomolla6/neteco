/**
 * Nombres legibles para códigos internos del panel. La interfaz nunca enseña
 * `ORDER_MANAGER`, `pending_review` ni referencias de tarea: siempre pasa por aquí.
 */
export type AdminTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info'

const ROLES: Record<string, string> = {
  admin: 'Administrador',
  administrator: 'Administrador',
  owner: 'Propietario',
  super_admin: 'Administrador general',
  order_manager: 'Gestor de pedidos',
  catalog_manager: 'Gestor de catálogo',
  catalog_editor: 'Editor de catálogo',
  inventory_manager: 'Gestor de inventario',
  warehouse_manager: 'Responsable de almacén',
  warehouse_operator: 'Operario de almacén',
  support_agent: 'Agente de soporte',
  support_manager: 'Responsable de soporte',
  marketing_manager: 'Responsable de marketing',
  sales_manager: 'Responsable comercial',
  sales_rep: 'Comercial',
  account_manager: 'Gestor de cuentas',
  finance_manager: 'Responsable de finanzas',
  finance: 'Finanzas',
  auditor: 'Auditor',
  viewer: 'Solo lectura',
  developer: 'Desarrollador',
  customer: 'Cliente',
  staff: 'Equipo'
}
const STATUSES: Record<string, [string, AdminTone]> = {
  active: ['Activo', 'success'],
  enabled: ['Activo', 'success'],
  inactive: ['Inactivo', 'neutral'],
  disabled: ['Desactivado', 'neutral'],
  draft: ['Borrador', 'neutral'],
  published: ['Publicado', 'success'],
  archived: ['Archivado', 'neutral'],
  scheduled: ['Programado', 'info'],
  pending: ['Pendiente', 'warning'],
  pending_review: ['Pendiente de revisión', 'warning'],
  in_review: ['En revisión', 'warning'],
  review: ['En revisión', 'warning'],
  approved: ['Aprobado', 'success'],
  rejected: ['Rechazado', 'danger'],
  open: ['Abierto', 'info'],
  closed: ['Cerrado', 'neutral'],
  resolved: ['Resuelto', 'success'],
  in_progress: ['En curso', 'info'],
  processing: ['En curso', 'info'],
  running: ['En curso', 'info'],
  completed: ['Completado', 'success'],
  done: ['Hecho', 'success'],
  success: ['Correcto', 'success'],
  ok: ['Correcto', 'success'],
  healthy: ['Correcto', 'success'],
  failed: ['Fallido', 'danger'],
  error: ['Error', 'danger'],
  critical: ['Crítico', 'danger'],
  blocked: ['Bloqueado', 'danger'],
  degraded: ['Con incidencias', 'warning'],
  warning: ['Aviso', 'warning'],
  cancelled: ['Cancelado', 'neutral'],
  canceled: ['Cancelado', 'neutral'],
  expired: ['Caducado', 'neutral'],
  paused: ['En pausa', 'neutral'],
  paid: ['Pagado', 'success'],
  unpaid: ['Sin pagar', 'warning'],
  pending_payment: ['Esperando cobro', 'warning'],
  awaiting_payment: ['Esperando cobro', 'warning'],
  authorized: ['Autorizado', 'info'],
  captured: ['Cobrado', 'success'],
  voided: ['Anulado', 'neutral'],
  refunded: ['Reembolsado', 'neutral'],
  partially_refunded: ['Reembolso parcial', 'neutral'],
  preparing: ['En preparación', 'info'],
  ready_to_ship: ['Listo para enviar', 'info'],
  shipped: ['Enviado', 'info'],
  in_transit: ['En reparto', 'info'],
  delivered: ['Entregado', 'success'],
  returned: ['Devuelto', 'neutral'],
  requested: ['Solicitado', 'warning'],
  received: ['Recibido', 'info'],
  sent: ['Enviado', 'success'],
  accepted: ['Aceptado', 'success'],
  converted: ['Convertido en pedido', 'success'],
  low: ['Baja', 'neutral'],
  medium: ['Media', 'warning'],
  high: ['Alta', 'danger'],
  urgent: ['Urgente', 'danger'],
  in_stock: ['En stock', 'success'],
  low_stock: ['Stock bajo', 'warning'],
  out_of_stock: ['Sin stock', 'danger']
}

/** `ORDER_MANAGER` → «Gestor de pedidos». Los códigos desconocidos se humanizan. */
export function adminRoleLabel(code: string | null | undefined): string {
  if (!code) return '—'
  return ROLES[code.toLowerCase()] ?? adminHumanize(code)
}
export function adminStatusLabel(code: string | null | undefined): string {
  if (!code) return '—'
  return STATUSES[code.toLowerCase()]?.[0] ?? adminHumanize(code)
}
export function adminStatusTone(code: string | null | undefined): AdminTone {
  return (code && STATUSES[code.toLowerCase()]?.[1]) || 'neutral'
}
/** Último recurso: `some_internal_code` → «Some internal code». */
export function adminHumanize(code: string): string {
  const text = code.replace(/[_-]+/g, ' ').trim().toLowerCase()
  return text.charAt(0).toUpperCase() + text.slice(1)
}
const euros = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' })
/** Importe en céntimos → «1.234,56 €». */
export function adminMoney(cents: number | null | undefined): string {
  return cents === null || cents === undefined ? '—' : euros.format(cents / 100)
}
export function adminDate(value: string | number | Date | null | undefined, withTime = false): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString('es-ES', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
    timeZone: 'Europe/Madrid'
  })
}
