<script setup lang="ts">
import CustomerReturnPanel from './CustomerReturnPanel.vue'
import {
  customerOrderReturnsSchema,
  returnOrderIdSchema,
  type CustomerOrderReturns,
  type ReturnCommandReceipt
} from '~~/shared/order-returns'
import { catalogPolicyUuidSchema } from '~~/shared/catalog-publication-policy'
const props = defineProps<{ orderId: string; runtime: unknown }>()
const emit = defineEmits<{ confirmed: [receipt: ReturnCommandReceipt]; pending: [value: boolean] }>()
const { ready, loggedIn, user, session } = useUserSession(),
  requestFetch = useRequestFetch()
const snapshot = shallowRef<CustomerOrderReturns | null>(null),
  loading = ref(false),
  failed = ref(false),
  page = ref(1),
  pending = ref(false)
const operatorId = computed(() => (typeof user.value?.id === 'string' ? user.value.id : ''))
const ownerKey = computed(() =>
  loggedIn.value === true &&
  user.value?.emailVerified === true &&
  catalogPolicyUuidSchema.safeParse(operatorId.value).success &&
  catalogPolicyUuidSchema.safeParse(session.value?.sessionId).success &&
  typeof session.value?.sessionVersion === 'number' &&
  Number.isSafeInteger(session.value.sessionVersion) &&
  session.value.sessionVersion >= 1 &&
  returnOrderIdSchema.safeParse(props.orderId).success
    ? JSON.stringify([props.orderId, operatorId.value, session.value.sessionId, session.value.sessionVersion])
    : null
)
let active = true,
  generation = 0,
  flight: { key: string; epoch: number; promise: Promise<CustomerOrderReturns> } | null = null
function authorize() {
  return (
    active &&
    props.runtime === 'cloudflare' &&
    ready.value === true &&
    loggedIn.value === true &&
    user.value?.emailVerified === true &&
    ownerKey.value !== null
  )
}
function reload(): Promise<CustomerOrderReturns> {
  if (!authorize() || !ownerKey.value) {
    snapshot.value = null
    return Promise.reject(new Error('return_access_unconfirmed'))
  }
  const key = ownerKey.value,
    epoch = generation,
    orderId = props.orderId,
    current = () => active && generation === epoch && ownerKey.value === key && authorize() && props.orderId === orderId
  if (flight?.key === key && flight.epoch === epoch) return flight.promise
  snapshot.value = null
  loading.value = true
  failed.value = false
  const promise = Promise.resolve().then(async () => {
    try {
      if (!current()) throw new Error('return_access_unconfirmed')
      const endpoint: string = `/api/orders/${orderId}/returns`
      const raw: unknown = await requestFetch(endpoint, {
        method: 'GET',
        query: { page: page.value, perPage: 25 },
        retry: 0,
        cache: 'no-store'
      })
      if (!current()) throw new Error('return_access_unconfirmed')
      const parsed = customerOrderReturnsSchema.safeParse(raw)
      if (!parsed.success || parsed.data.orderId !== orderId || !current()) throw new Error('return_read_unconfirmed')
      snapshot.value = parsed.data
      return parsed.data
    } catch (error) {
      if (current()) {
        snapshot.value = null
        failed.value = true
      }
      throw error
    } finally {
      if (active && generation === epoch && ownerKey.value === key) {
        loading.value = false
        flight = null
      }
    }
  })
  flight = { key, epoch, promise }
  return promise
}
function refresh() {
  if (authorize()) void reload().catch(() => undefined)
}
function changePage(value: number) {
  if (loading.value || pending.value || value < 1) return
  page.value = value
  generation++
  refresh()
}
watch(
  () => [
    props.orderId,
    props.runtime,
    operatorId.value,
    ready.value,
    loggedIn.value,
    user.value?.emailVerified,
    ownerKey.value
  ],
  () => {
    generation++
    snapshot.value = null
    failed.value = false
    loading.value = false
    flight = null
    if (authorize()) refresh()
  },
  { immediate: true, flush: 'sync' }
)
watch(
  ownerKey,
  () => {
    page.value = 1
    pendingChanged(false)
  },
  { flush: 'sync' }
)
onBeforeUnmount(() => {
  active = false
  generation++
  snapshot.value = null
  flight = null
  pendingChanged(false)
})
function pendingChanged(value: boolean) {
  pending.value = value
  emit('pending', value)
}
</script>
<template>
  <section aria-label="Contexto privado de devolución del pedido" class="space-y-4">
    <p v-if="runtime !== 'cloudflare'" role="status">
      Las devoluciones nativas están disponibles en el adaptador Cloudflare.
    </p>
    <p v-else-if="!authorize()" role="status">
      Entra con la cuenta verificada propietaria del pedido. Los pedidos de invitado necesitan un contrato de
      verificación que aún no está disponible; conocer el correo o el número de pedido no permite reclamarlos.
    </p>
    <div v-else class="flex flex-wrap items-center gap-3">
      <p v-if="loading" data-testid="customer-return-loading" role="status">Confirmando cantidades e historial…</p>
      <p v-else-if="failed" data-testid="customer-return-read-error" role="alert">
        No se ha podido confirmar este pedido. No se interpreta como historial vacío ni unidades disponibles.
      </p>
      <button
        data-testid="customer-return-refresh"
        :disabled="loading"
        type="button"
        class="rounded border p-2"
        @click="refresh"
      >
        Actualizar devolución
      </button>
    </div>
    <CustomerReturnPanel
      v-if="ownerKey"
      :key="ownerKey"
      :snapshot="snapshot"
      :operator-id="operatorId"
      :runtime="runtime"
      :authorize="authorize"
      :reload="reload"
      @confirmed="emit('confirmed', $event)"
      @pending="pendingChanged"
    />
    <nav v-if="snapshot && snapshot.pagination.pages > 1" aria-label="Páginas de solicitudes">
      <button
        data-testid="customer-return-previous"
        :disabled="page <= 1 || loading || pending"
        @click="changePage(page - 1)"
      >
        Anterior</button
      ><span>{{ page }} / {{ snapshot.pagination.pages }}</span
      ><button
        data-testid="customer-return-next"
        :disabled="page >= snapshot.pagination.pages || loading || pending"
        @click="changePage(page + 1)"
      >
        Siguiente
      </button>
    </nav>
  </section>
</template>
