import type { MaybeRefOrGetter } from 'vue'
import {
  deliveryPromise,
  formatCutoffCountdown,
  formatDeliveryDate,
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
  /** «miércoles, 18 de noviembre»: el último día estimado, entero. */
  dateLabel: string
  /** «3 h 12 min» hasta la hora de corte; `null` si el pedido ya entra mañana. */
  countdown: string | null
  /** Hora de corte de hoy, «13:00»; `null` si ya ha pasado. */
  cutoffTime: string | null
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
      methodLabel: promise.method === 'own_delivery' ? 'Reparto propio' : 'Envío por agencia',
      dateLabel: formatDeliveryDate(promise.to),
      countdown: formatCutoffCountdown(promise),
      cutoffTime: promise.cutoff?.time ?? null
    }
  })

  /** Ya hay reloj: si `view` sigue vacío es que no hay fecha que prometer, no que falte por calcular. */
  const ready = computed(() => now.value !== null)
  return { view, ready, destination: memory.destination, remember: memory.remember }
}
