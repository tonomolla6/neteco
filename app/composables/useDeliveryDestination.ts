/**
 * El destino de entrega, preguntado una sola vez.
 *
 * Código postal y población se guardan en el navegador y se reutilizan en la ficha y en el
 * carrito: «Entrega en 46870 Ontinyent · Cambiar». No sale del navegador hasta que se pide
 * una estimación, y no es una dirección: la de verdad se da al tramitar el pedido.
 */
export interface DeliveryDestination {
  postalCode: string
  city: string
}
const STORAGE_KEY = 'neteco-destination'

function valid(value: unknown): value is DeliveryDestination {
  if (!value || typeof value !== 'object') return false
  const { postalCode, city } = value as Record<string, unknown>
  return (
    typeof postalCode === 'string' &&
    /^\d{5}$/.test(postalCode) &&
    typeof city === 'string' &&
    city.trim().length >= 2 &&
    city.length <= 80
  )
}

export function useDeliveryDestination() {
  const destination = useState<DeliveryDestination | null>('delivery-destination', () => null)

  /** Solo en cliente y tras hidratar: el HTML del servidor nunca lleva el destino de nadie. */
  function restore() {
    if (!import.meta.client || destination.value) return destination.value
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')
      if (valid(stored)) destination.value = { postalCode: stored.postalCode, city: stored.city.trim() }
    } catch {
      /* Sin almacenamiento disponible, simplemente se vuelve a preguntar. */
    }
    return destination.value
  }
  function remember(value: DeliveryDestination) {
    const next = { postalCode: value.postalCode.trim(), city: value.city.trim() }
    if (!valid(next)) return false
    destination.value = next
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    } catch {
      /* La estimación de esta página sigue valiendo aunque no se pueda recordar. */
    }
    return true
  }
  return { destination, restore, remember }
}
