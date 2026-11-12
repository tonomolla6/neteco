import type { OrderSummary } from '~/composables/useAccount'
import { rankHabitualLines, type HabitualProduct } from '~~/shared/habitual-products'

/**
 * Lee el contenido de los últimos pedidos del cliente (tres como mucho) y devuelve sus
 * referencias habituales. Solo en cliente y nunca bloquea la página: si una lectura falla,
 * simplemente hay menos historial con el que calcular.
 */
export function useHabituals(orders: Ref<OrderSummary[]>, limit = 6) {
  const habituals = ref<HabitualProduct[]>([])
  const loading = ref(false)
  let generation = 0

  async function load(list: OrderSummary[]) {
    const epoch = ++generation
    if (!import.meta.client || !list.length) {
      habituals.value = []
      return
    }
    loading.value = true
    const details = await Promise.all(
      list.slice(0, 3).map(async (order) => {
        try {
          const raw = await $fetch<unknown>(`/api/orders/${encodeURIComponent(order.id)}/lines`)
          return readOrderDetail(raw, order.id)
        } catch {
          return null
        }
      })
    )
    if (epoch !== generation) return
    habituals.value = rankHabitualLines(
      details.filter((detail) => detail !== null),
      limit
    )
    loading.value = false
  }
  watch(orders, (list) => void load(list), { immediate: true })
  onBeforeUnmount(() => generation++)
  return { habituals, loading }
}
