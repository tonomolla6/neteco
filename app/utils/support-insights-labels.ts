/** Spanish labels shared by the SUP-012/014/015/017 screens. */
export const B2B_KIND_LABELS: Record<string, string> = {
  quote: 'Presupuesto',
  product_onboarding: 'Alta de producto',
  documentation: 'Documentación',
  credit: 'Crédito',
  claim: 'Reclamación'
}
export const B2B_STATUS_LABELS: Record<string, string> = {
  submitted: 'Recibida',
  in_review: 'En revisión',
  waiting_customer: 'Esperando tu respuesta',
  approved: 'Aprobada',
  rejected: 'Rechazada',
  resolved: 'Resuelta',
  cancelled: 'Cancelada'
}
export const SLA_LABELS: Record<string, string> = {
  on_track: 'En plazo',
  at_risk: 'En riesgo',
  met: 'Cumplido',
  breached: 'Fuera de plazo'
}
export const SLA_CLASSES: Record<string, string> = {
  on_track: 'bg-emerald-50 text-emerald-700',
  at_risk: 'bg-amber-50 text-amber-800',
  met: 'bg-slate-100 text-slate-700',
  breached: 'bg-red-50 text-red-700'
}
export const ROOT_CAUSE_LABELS: Record<string, string> = {
  delivery_delay: 'Retraso en la entrega',
  transit_damage: 'Daño en transporte',
  wrong_item: 'Artículo equivocado',
  missing_item: 'Artículo faltante',
  stock_unavailable: 'Sin stock',
  product_information: 'Información de producto',
  safety_usage_question: 'Uso y seguridad',
  payment_issue: 'Incidencia de pago',
  invoice_issue: 'Incidencia de factura',
  return_process: 'Proceso de devolución',
  account_access: 'Acceso a la cuenta',
  other: 'Otros',
  unclassified: 'Sin clasificar'
}
export const formatInstant = (value: string | null | undefined): string =>
  value
    ? new Intl.DateTimeFormat('es-ES', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Madrid' }).format(
        new Date(value)
      )
    : '—'
export const formatRate = (value: number | null | undefined): string =>
  value === null || value === undefined ? '—' : value.toLocaleString('es-ES', { maximumFractionDigits: 2 })
export const formatBp = (value: number | null | undefined): string =>
  value === null || value === undefined ? '—' : `${Math.round(value) / 100} %`
export function errorCodeOf(error: unknown): string {
  return (error as { data?: { error?: { code?: string } } })?.data?.error?.code ?? ''
}
