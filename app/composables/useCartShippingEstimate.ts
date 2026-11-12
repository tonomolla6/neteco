import { useCartStore } from '~/stores/cart'
import type { DeliveryDestination } from '~/composables/useDeliveryDestination'

/**
 * Coste y día de entrega en el carrito.
 *
 * Los costes que aparecen tarde son el primer motivo de abandono. Con el destino recordado
 * (código postal y población, preguntados una vez) se pide al servidor la misma cotización
 * que usará el pago y se enseña método, coste y día. Nunca se inventa una cifra: si no se
 * puede calcular, se dice. Tras cambiar el carrito la estimación queda marcada como antigua
 * y se recalcula a petición, para no lanzar una cotización por cada pulsación de cantidad.
 *
 * Solo existe donde la tienda puede cotizar con código postal y población (entorno
 * Cloudflare); el otro entorno necesita la dirección completa, que se da en el pago.
 */
export interface CartShippingRate {
  serviceCode: string
  label: string
  netCents: number
  taxRateBasisPoints: number
  estimatedDeliveryFrom: string | null
  estimatedDeliveryTo: string | null
  profile: string
  totalGrossCents: number
}

export function useCartShippingEstimate() {
  const cart = useCartStore()
  const runtime = useRuntimeConfig()
  const memory = useDeliveryDestination()
  const available = computed(() => runtime.public.serverRuntime === 'cloudflare')
  const destination = memory.destination
  const rates = ref<CartShippingRate[]>([])
  const quotedVersion = ref<number | null>(null)
  const loading = ref(false)
  const error = ref('')
  let request = 0

  /** La opción que se enseña: la primera que no es recogida en almacén. */
  const rate = computed(() => rates.value.find((option) => option.profile !== 'pickup') ?? rates.value[0] ?? null)
  const stale = computed(() => !!rate.value && quotedVersion.value !== cart.version)
  const shippingGross = computed(() =>
    rate.value ? Math.round((rate.value.netCents * (10000 + rate.value.taxRateBasisPoints)) / 10000) : null
  )
  const pickup = computed(() => rates.value.some((option) => option.profile === 'pickup'))

  async function calculate(target: DeliveryDestination | null = destination.value) {
    if (!available.value || !target || !cart.items.length || cart.pendingMutation) return
    const current = ++request
    loading.value = true
    error.value = ''
    try {
      const quote = await $fetch<{ cartVersion: number; rates: CartShippingRate[] }>('/api/shipping/rates', {
        method: 'POST',
        headers: { 'Idempotency-Key': randomId() },
        body: { postalCode: target.postalCode, city: target.city }
      })
      if (current !== request) return
      if (!quote.rates.length) {
        rates.value = []
        error.value = 'No tenemos un envío disponible para ese código postal. Llámanos al 600 861 334.'
        return
      }
      rates.value = quote.rates
      quotedVersion.value = quote.cartVersion
      memory.remember(target)
    } catch {
      if (current !== request) return
      rates.value = []
      error.value = 'No hemos podido calcular el envío ahora. Lo verás en el siguiente paso, antes de pagar.'
    } finally {
      if (current === request) loading.value = false
    }
  }

  function day(value: string) {
    return new Intl.DateTimeFormat('es-ES', { weekday: 'long', day: 'numeric' }).format(new Date(value))
  }
  /** «jueves, 19» o «entre el jueves, 19 y el viernes, 20»; vacío si el servidor no da fecha. */
  const deliveryDay = computed(() => {
    const from = rate.value?.estimatedDeliveryFrom
    const to = rate.value?.estimatedDeliveryTo
    if (!from) return ''
    return !to || day(from) === day(to) ? day(from) : `entre el ${day(from)} y el ${day(to)}`
  })

  onMounted(() => {
    if (!available.value) return
    memory.restore()
    // Una sola cotización al llegar con destino conocido; el resto, a petición.
    watch(
      () => cart.ready && cart.items.length > 0 && !!destination.value,
      (ready) => {
        if (ready && !rate.value && !loading.value && !error.value) void calculate()
      },
      { immediate: true }
    )
  })

  return { available, destination, rate, rates, stale, shippingGross, pickup, deliveryDay, loading, error, calculate }
}
