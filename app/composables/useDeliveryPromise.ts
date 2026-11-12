import type { MaybeRefOrGetter } from 'vue'
import {
  deliveryPromise,
  formatPromiseCondition,
  formatPromiseHeadline,
  madridToday,
  type DeliveryPromise
} from '~~/shared/delivery-promise'

export interface DeliveryPromiseView {
  promise: DeliveryPromise
  /** «Te llega el martes 17». */
  headline: string
  /** «si lo pides hoy antes de las 13:00». */
  condition: string
  /** «Reparto propio» o «Envío por agencia». */
  methodLabel: string
}

/**
 * Fecha de entrega concreta para la ficha y el carrito, con el código postal recordado.
 *
 * Depende del reloj y del navegador (destino guardado), así que solo existe tras montar:
 * el HTML del servidor nunca lleva una fecha que podría no coincidir al hidratar. El reloj
 * avanza cada minuto para que la cuenta atrás hasta la hora de corte sea verdad.
 */
export function useDeliveryPromise(options: { preparationDays?: MaybeRefOrGetter<number | null | undefined> } = {}) {
  const { terms } = useCommercialTerms()
  const memory = useDeliveryDestination()
  const now = ref<Date | null>(null)
  let timer: ReturnType<typeof setInterval> | undefined

  onMounted(() => {
    memory.restore()
    now.value = new Date()
    timer = setInterval(() => (now.value = new Date()), 60_000)
  })
  onBeforeUnmount(() => {
    if (timer) clearInterval(timer)
  })

  const view = computed<DeliveryPromiseView | null>(() => {
    if (!now.value) return null
    const preparation = toValue(options.preparationDays)
    // Bajo pedido sin plazo conocido no hay fecha que prometer.
    if (preparation === null) return null
    const promise = deliveryPromise({
      now: now.value,
      terms: terms.value,
      postalCode: memory.destination.value?.postalCode ?? null,
      preparationDays: preparation ?? 0
    })
    if (!promise) return null
    const today = madridToday(now.value)
    return {
      promise,
      headline: formatPromiseHeadline(promise, today),
      condition: formatPromiseCondition(promise),
      methodLabel: promise.method === 'own_delivery' ? 'Reparto propio' : 'Envío por agencia'
    }
  })

  return { view, destination: memory.destination, remember: memory.remember }
}
