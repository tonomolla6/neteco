import type { ProductCardData } from '~~/shared/types/catalog'
import { deliveryPromise, formatPromiseDay, madridToday } from '~~/shared/delivery-promise'

/**
 * «Cuándo te llegaría», en una línea, para las tarjetas de un listado.
 *
 * Una rejilla pinta decenas de tarjetas: todas comparten un único reloj (`useState`) y una
 * caché por minuto, destino y plazo, en lugar de un temporizador y un cálculo por tarjeta.
 * Como depende de la hora y del código postal recordado, solo existe tras montar: el HTML
 * del servidor reserva la línea vacía y no lleva una fecha que podría no coincidir.
 */
/** Días laborables de margen de lo que no está en almacén y se sirve bajo pedido. */
export const LISTING_BACKORDER_DAYS = 5

const cache = new Map<string, string>()

const shortWeekday = new Intl.DateTimeFormat('es-ES', { weekday: 'short', timeZone: 'UTC' })
/** «lun 16»: en un intervalo, el día abreviado cabe en una línea de la tarjeta. */
function shortDay(day: string): string {
  const date = new Date(`${day}T00:00:00Z`)
  return `${shortWeekday.format(date).replace('.', '')} ${date.getUTCDate()}`
}

/** Plazo de preparación de una tarjeta, o `null` si no se puede pedir (no debe enseñarse). */
export function listingPreparationDays(product: Pick<ProductCardData, 'single'>): number | null {
  const single = product.single
  if (!single) return 0
  if (single.stock >= single.minimumQuantity) return 0
  return single.backorderAllowed ? LISTING_BACKORDER_DAYS : null
}

/** Un producto de un solo formato, sin existencias y sin servicio bajo pedido, no se enseña. */
export function listingOrderable(product: Pick<ProductCardData, 'single'>): boolean {
  return listingPreparationDays(product) !== null
}

export function useListingDelivery(product: () => Pick<ProductCardData, 'single'>) {
  const { terms } = useCommercialTerms()
  const memory = useDeliveryDestination()
  const clock = useState<number | null>('listing-delivery-clock', () => null)

  onMounted(() => {
    memory.restore()
    // Minuto en curso: suficiente para la hora de corte y estable entre tarjetas.
    const minute = Math.floor(Date.now() / 60_000) * 60_000
    if (clock.value !== minute) clock.value = minute
  })

  /** «Recíbelo el miércoles 18» o «Recíbelo del lun 16 al mié 18»; vacío sin fecha. */
  const label = computed(() => {
    if (clock.value === null) return ''
    const preparationDays = listingPreparationDays(product())
    if (preparationDays === null) return ''
    const postalCode = memory.destination.value?.postalCode ?? null
    const key = `${clock.value}|${postalCode ?? ''}|${preparationDays}`
    const cached = cache.get(key)
    if (cached !== undefined) return cached
    const now = new Date(clock.value)
    const promise = deliveryPromise({ now, terms: terms.value, postalCode, preparationDays })
    let text = ''
    if (promise) {
      const today = madridToday(now)
      if (promise.from === promise.to) {
        const day = formatPromiseDay(promise.from, today)
        text = day.startsWith('mañana') ? `Recíbelo ${day}` : `Recíbelo el ${day}`
      } else {
        text = `Recíbelo del ${shortDay(promise.from)} al ${shortDay(promise.to)}`
      }
    }
    if (cache.size > 50) cache.clear()
    cache.set(key, text)
    return text
  })

  return { label }
}
