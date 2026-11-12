import type { OrderSummary } from '~/composables/useAccount'

/**
 * El último pedido del cliente con sesión. Es lo que alimenta «Repetir último pedido» en la
 * cabecera, la portada y el carrito vacío. Se lee solo en cliente: las páginas públicas se
 * sirven desde una caché compartida y no pueden llevar datos de una cuenta.
 */
export async function useLastOrder() {
  const { loggedIn } = useUserSession()
  const { data, execute } = await useFetch<{ orders: OrderSummary[] }>('/api/orders', {
    key: 'last-order',
    lazy: true,
    server: false,
    immediate: loggedIn.value,
    default: () => ({ orders: [] })
  })
  // Quien inicia sesión sin recargar la página también tiene su último pedido a mano.
  if (import.meta.client) watch(loggedIn, (value) => value && void execute())
  const orders = computed(() => (loggedIn.value ? (data.value?.orders ?? []) : []))
  const lastOrder = computed(() => orders.value[0] ?? null)
  return { orders, lastOrder }
}
