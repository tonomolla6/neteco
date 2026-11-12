/**
 * Disponibilidad de una variante, dicha siempre igual en listado, ficha y carrito.
 * El estado nunca va solo por color: lleva texto e icono.
 */
export interface AvailabilityInput {
  stock: number
  minimumQuantity: number
  backorderAllowed: boolean
  leadTimeDays?: number | null
}
export interface Availability {
  state: 'available' | 'low' | 'backorder' | 'out'
  label: string
  icon: string
  /** Clase de color del texto; usa los tokens `--stock-*`. */
  tone: string
  /** Se puede pedir online. */
  orderable: boolean
}

export function variantAvailability(variant: AvailabilityInput): Availability {
  if (variant.stock >= variant.minimumQuantity) {
    const low = Math.max(variant.minimumQuantity * 3, 5)
    return variant.stock <= low
      ? {
          state: 'low',
          label: `Quedan ${variant.stock}`,
          icon: 'i-lucide-circle-alert',
          tone: 'text-[var(--stock-low)]',
          orderable: true
        }
      : {
          state: 'available',
          label: 'Disponible',
          icon: 'i-lucide-circle-check',
          tone: 'text-[var(--stock-ok)]',
          orderable: true
        }
  }
  if (variant.backorderAllowed)
    return {
      state: 'backorder',
      label: variant.leadTimeDays ? `Bajo pedido · ${variant.leadTimeDays} días` : 'Bajo pedido',
      icon: 'i-lucide-clock',
      tone: 'text-[var(--stock-low)]',
      orderable: true
    }
  return {
    state: 'out',
    label: 'Agotado',
    icon: 'i-lucide-circle-x',
    tone: 'text-[var(--stock-out)]',
    orderable: false
  }
}
