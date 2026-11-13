<script setup lang="ts">
import OrderFulfillmentPanel from './OrderFulfillmentPanel.vue'
import OrderPackingPanel from './OrderPackingPanel.vue'
import type { OrderPackingReceipt } from '~~/shared/order-packing'
import {
  adminOrderFulfillmentSchema,
  fulfillmentOrderIdSchema,
  type AdminOrderFulfillment,
  type FulfillmentCommandReceipt
} from '~~/shared/order-fulfillment'
import { catalogPolicyUuidSchema } from '~~/shared/catalog-publication-policy'

const props = defineProps<{ orderId: string; runtime: unknown }>()
const emit = defineEmits<{
  confirmed: [receipt: FulfillmentCommandReceipt | OrderPackingReceipt]
  pending: [value: boolean]
}>()
const fulfillmentPending = ref(false),
  packingPending = ref(false)
const packingPanel = ref<InstanceType<typeof OrderPackingPanel> | null>(null)
watch(
  () => fulfillmentPending.value || packingPending.value,
  (value) => emit('pending', value),
  { flush: 'sync' }
)
function blockCompeting(event: Event) {
  if (packingPending.value) {
    event.preventDefault()
    event.stopPropagation()
  }
}
function fulfillmentConfirmed(receipt: FulfillmentCommandReceipt) {
  emit('confirmed', receipt)
  void packingPanel.value?.refresh?.()
}
const { ready, loggedIn, user } = useUserSession()
const requestFetch = useRequestFetch()
const snapshot = shallowRef<AdminOrderFulfillment | null>(null)
const loading = ref(false),
  failed = ref(false)
const operatorId = computed(() => (typeof user.value?.id === 'string' ? user.value.id : ''))
const ownerKey = computed(() =>
  loggedIn.value === true &&
  catalogPolicyUuidSchema.safeParse(operatorId.value).success &&
  fulfillmentOrderIdSchema.safeParse(props.orderId).success
    ? `${props.orderId}:${operatorId.value}`
    : null
)
watch(
  ownerKey,
  () => {
    fulfillmentPending.value = false
    packingPending.value = false
  },
  { flush: 'sync' }
)
let active = true,
  generation = 0
let flight: { key: string; epoch: number; promise: Promise<AdminOrderFulfillment> } | null = null
function authorize() {
  return (
    active &&
    props.runtime === 'cloudflare' &&
    ready.value === true &&
    loggedIn.value === true &&
    user.value?.emailVerified === true &&
    user.value?.mfaVerified === true &&
    ownerKey.value !== null
  )
}
/** Private, uncached and single-flight per current identity/order. The panel
 * always receives a newly confirmed DTO; errors never become empty history. */
function reload(): Promise<AdminOrderFulfillment> {
  if (!authorize() || ownerKey.value === null) {
    snapshot.value = null
    return Promise.reject(new Error('fulfillment_access_unconfirmed'))
  }
  const key = ownerKey.value,
    epoch = generation,
    orderId = props.orderId
  if (flight?.key === key && flight.epoch === epoch) return flight.promise
  snapshot.value = null
  loading.value = true
  failed.value = false
  const current = () =>
    active && generation === epoch && ownerKey.value === key && authorize() && props.orderId === orderId
  // Install the single-flight claim before invoking a fetcher that may throw
  // synchronously. Recheck authority when its microtask actually dispatches.
  const promise = Promise.resolve().then(async () => {
    try {
      if (!current()) throw new Error('fulfillment_access_unconfirmed')
      // Do not let the generated legacy Nitro order wildcard infer PUT for
      // this separately owned native Worker GET resource.
      const endpoint: string = `/api/admin/orders/${orderId}/fulfillment`
      const raw: unknown = await requestFetch(endpoint, {
        method: 'GET',
        query: { page: 1, perPage: 25 },
        retry: 0,
        cache: 'no-store'
      })
      if (!current()) throw new Error('fulfillment_access_unconfirmed')
      const parsed = adminOrderFulfillmentSchema.safeParse(raw)
      if (!parsed.success || parsed.data.orderId !== orderId || !current())
        throw new Error('fulfillment_read_unconfirmed')
      snapshot.value = parsed.data
      return parsed.data
    } catch (failure) {
      if (current()) {
        snapshot.value = null
        failed.value = true
      }
      throw failure
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
watch(
  () => [
    props.orderId,
    props.runtime,
    operatorId.value,
    ready.value,
    loggedIn.value,
    user.value?.emailVerified,
    user.value?.mfaVerified
  ],
  () => {
    generation++
    snapshot.value = null
    failed.value = false
    loading.value = false
    flight = null
    // Do not unmount the panel on temporary MFA/readiness loss for the same
    // logged-in actor: an ambiguous POST keeps its original recovery key.
    if (authorize()) refresh()
  },
  { immediate: true, flush: 'sync' }
)
onBeforeUnmount(() => {
  active = false
  generation++
  snapshot.value = null
  flight = null
})
</script>

<template>
  <section aria-label="Contexto operativo confirmado del pedido" class="space-y-4">
    <div v-if="runtime !== 'cloudflare'" role="status">
      <UAlert
        color="warning"
        variant="subtle"
        icon="i-lucide-info"
        title="La preparación de pedidos no está disponible en este entorno"
      />
    </div>
    <div v-else-if="!authorize()" role="status">
      <UAlert
        color="warning"
        variant="subtle"
        icon="i-lucide-lock"
        title="Confirma tu sesión para ver la preparación"
        description="Hace falta tener el correo verificado y la verificación en dos pasos."
      />
    </div>
    <div v-else class="flex flex-wrap items-center justify-between gap-3">
      <p v-if="loading" data-testid="fulfillment-loading" role="status" class="adm-help">Cargando la preparación…</p>
      <p v-else-if="failed" data-testid="fulfillment-read-error" role="alert" class="text-[var(--text)]">
        No se ha podido cargar la preparación. Vuelve a intentarlo.
      </p>
      <span v-else aria-hidden="true" />
      <button
        data-testid="fulfillment-refresh"
        type="button"
        :disabled="loading || packingPending"
        class="adm-btn adm-btn--secondary adm-btn--sm"
        @click="refresh"
      >
        <UIcon name="i-lucide-rotate-cw" class="size-4" :class="loading && 'animate-spin'" />Actualizar
      </button>
    </div>
    <fieldset
      class="min-w-0"
      :disabled="packingPending"
      @click.capture="blockCompeting"
      @submit.capture="blockCompeting"
    >
      <OrderFulfillmentPanel
        v-if="ownerKey"
        :key="ownerKey"
        :snapshot="snapshot"
        :operator-id="operatorId"
        :runtime="runtime"
        :authorize="authorize"
        :reload="reload"
        @confirmed="fulfillmentConfirmed"
        @pending="fulfillmentPending = $event"
      />
    </fieldset>
    <OrderPackingPanel
      v-if="runtime === 'cloudflare' && ownerKey"
      ref="packingPanel"
      :key="ownerKey"
      :order-id="orderId"
      :runtime="runtime"
      :pending="fulfillmentPending"
      @pending="packingPending = $event"
      @confirmed="emit('confirmed', $event)"
    />
  </section>
</template>
