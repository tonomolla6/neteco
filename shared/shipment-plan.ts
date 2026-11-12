/**
 * Plan de envíos de un pedido, como en Amazon: cada producto tiene su plazo y el cliente
 * elige recibirlo todo junto (un porte, llega en la fecha más tardía) o por separado (un
 * porte por envío, lo que está en almacén sale antes).
 *
 * Nunca se le dice al cliente que algo «no tiene stock»: lo que no está en el almacén se
 * sirve con su plazo de reposición. Ese plazo es el de la variante (`lead_time_days`) y, si
 * no tiene, el plazo por defecto de la tienda.
 *
 * Este módulo es puro: lo usan el Worker, el runtime Node y la interfaz.
 */

/** Días naturales de reposición cuando ni la variante ni la tienda fijan otro plazo. */
export const DEFAULT_RESTOCK_LEAD_DAYS = 7

/** Tope de envíos de un pedido: los plazos más largos se agrupan en el último. */
export const MAX_SHIPMENTS_PER_ORDER = 3

export type ShipmentMode = 'together' | 'split'

// `type`, no `interface`: así el plan es asignable a un valor JSON al persistirlo.
export type ShipmentPlanLine = {
  variantId: string
  sku: string
  quantity: number
}

export type ShipmentPlanEntry = {
  index: number
  /** Días naturales antes de salir del almacén: 0 si todo está en almacén. */
  leadDays: number
  /** Primer y último día estimado de entrega (`YYYY-MM-DD`); `null` si el servidor no tiene calendario. */
  from: string | null
  to: string | null
  /** Porte de este envío. En «todo junto» solo hay un envío y lleva el porte entero. */
  netCents: number
  taxCents: number
  grossCents: number
  lines: ShipmentPlanLine[]
}

/** Plazo de una línea: 0 si hay existencias para la cantidad pedida; si no, su reposición. */
export function lineLeadDays(input: {
  quantity: number
  availableQuantity: number
  leadTimeDays: number | null | undefined
  defaultRestockDays?: number | null
}): number {
  if (input.availableQuantity >= input.quantity) return 0
  const configured = input.leadTimeDays ?? input.defaultRestockDays ?? DEFAULT_RESTOCK_LEAD_DAYS
  if (!Number.isFinite(configured)) return DEFAULT_RESTOCK_LEAD_DAYS
  return Math.max(1, Math.min(365, Math.trunc(configured)))
}

/**
 * Agrupa las líneas por plazo, del más corto al más largo. Con más grupos que
 * `MAX_SHIPMENTS_PER_ORDER`, los plazos largos comparten el último envío (sale cuando llega
 * lo más lento de ese grupo).
 */
export function groupByLeadDays<T>(
  lines: readonly T[],
  lead: (line: T) => number
): Array<{ leadDays: number; lines: T[] }> {
  const byLead = new Map<number, T[]>()
  for (const line of lines) {
    const days = lead(line)
    byLead.set(days, [...(byLead.get(days) ?? []), line])
  }
  const groups = [...byLead.entries()]
    .sort(([left], [right]) => left - right)
    .map(([leadDays, grouped]) => ({ leadDays, lines: grouped }))
  while (groups.length > MAX_SHIPMENTS_PER_ORDER) {
    const last = groups.pop()!
    const previous = groups[groups.length - 1]!
    previous.leadDays = Math.max(previous.leadDays, last.leadDays)
    previous.lines.push(...last.lines)
  }
  return groups
}

/** Días naturales → laborables, para la previsión del navegador (que cuenta en laborables). */
export function businessDaysForLead(leadDays: number): number {
  return Math.max(0, Math.round((leadDays * 5) / 7))
}
