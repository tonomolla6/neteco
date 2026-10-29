/** Error plumbing shared by the SHP-027/028/030 admin screens. */
export function opsErrorCode(error: unknown): string {
  const e = error as { data?: { error?: { code?: string } } }
  return e?.data?.error?.code ?? 'network'
}
export function opsErrorDetails(error: unknown): Record<string, unknown> {
  const e = error as { data?: { error?: { details?: Record<string, unknown> } } }
  return e?.data?.error?.details ?? {}
}

const MESSAGES: Record<string, string> = {
  unauthorized: 'Tu sesión ha caducado. Vuelve a iniciar sesión.',
  forbidden: 'No tienes permisos de administración para esta acción.',
  not_found: 'No se ha encontrado el recurso solicitado.',
  version_conflict: 'Otro usuario ha cambiado este registro. Recarga y vuelve a intentarlo.',
  idempotency_conflict: 'Esta operación ya se envió con otros datos. Recarga la página.',
  invalid_transition: 'La operación no es válida en el estado actual.',
  invalid_input: 'Los datos enviados no son válidos.',
  conflict: 'Ya existe un manifiesto activo para ese transportista y fecha.',
  nothing_to_manifest: 'No hay expediciones de ese transportista para manifestar.',
  manifest_not_open: 'El manifiesto ya no está abierto.',
  manifest_not_closed: 'El manifiesto debe estar cerrado primero.',
  carrier_unavailable: 'El transportista no está disponible. No se ha cambiado nada; reintenta más tarde.',
  unknown_profile: 'Faltan perfiles de peso/dimensiones para algunos SKU.',
  unpackable: 'Un producto no cabe en ninguna caja activa o supera los límites.',
  no_active_boxes: 'No hay cajas activas configuradas.',
  too_many_units: 'Demasiadas unidades para una sola propuesta.',
  too_many_parcels: 'La propuesta requeriría demasiados bultos.',
  plan_stale: 'La configuración ha cambiado desde la propuesta. Genera una nueva.',
  validation_out_of_tolerance: 'El peso real se desvía demasiado de lo previsto o supera el máximo de la caja.',
  payload_too_large: 'La petición es demasiado grande.',
  network: 'No se ha podido contactar con el servidor.'
}
export function opsErrorMessage(error: unknown): string {
  const code = opsErrorCode(error)
  const base = MESSAGES[code] ?? 'Ha ocurrido un error inesperado.'
  const details = opsErrorDetails(error)
  if (code === 'unknown_profile' && Array.isArray(details.skus))
    return `${base} (${(details.skus as string[]).join(', ')})`
  if (code === 'unpackable' && typeof details.sku === 'string')
    return `${base} (${details.sku}: ${String(details.reason)})`
  return base
}
