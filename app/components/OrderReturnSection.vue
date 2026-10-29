<script setup lang="ts">
import OrderReturnPanel from './OrderReturnPanel.vue'
import {
  adminOrderReturnSchema,
  adminReturnListSchema,
  returnPublicRefSchema,
  returnStateLabels,
  returnStateSchema,
  type AdminOrderReturn,
  type AdminReturnList,
  type ReturnCommandReceipt
} from '~~/shared/order-returns'
import { catalogPolicyUuidSchema } from '~~/shared/catalog-publication-policy'
import { useAdminNavigation } from '~/composables/useAdminNavigation'
const props = defineProps<{ runtime: unknown; publicRef?: string }>()
const emit = defineEmits<{ confirmed: [receipt: ReturnCommandReceipt]; pending: [value: boolean] }>()
const { ready, loggedIn, user, session } = useUserSession(),
  requestFetch = useRequestFetch()
const navigation = useAdminNavigation()
const selected = ref(props.publicRef ?? ''),
  query = ref(''),
  state = ref(''),
  page = ref(1),
  pending = ref(false)
const snapshot = shallowRef<AdminOrderReturn | null>(null),
  list = shallowRef<AdminReturnList | null>(null),
  loading = ref(false),
  failed = ref(false),
  listLoading = ref(false),
  listFailed = ref(false)
const operatorId = computed(() => (typeof user.value?.id === 'string' ? user.value.id : ''))
const actorKey = computed(() => {
  const caps = navigation.capabilities.value
  if (
    !loggedIn.value ||
    user.value?.emailVerified !== true ||
    !catalogPolicyUuidSchema.safeParse(operatorId.value).success ||
    !catalogPolicyUuidSchema.safeParse(session.value?.sessionId).success ||
    typeof session.value?.sessionVersion !== 'number' ||
    !Number.isSafeInteger(session.value.sessionVersion) ||
    session.value.sessionVersion < 1 ||
    navigation.status.value === 'unauthenticated' ||
    (navigation.status.value === 'ready' &&
      caps &&
      (caps.state === 'forbidden' || (caps.state === 'ready' && !caps.permissions.includes('administration.manage'))))
  )
    return null
  return JSON.stringify([operatorId.value, session.value.sessionId, session.value.sessionVersion])
})
const ownerKey = computed(() =>
  actorKey.value && returnPublicRefSchema.safeParse(selected.value).success
    ? `${selected.value}:${actorKey.value}`
    : null
)
let active = true,
  generation = 0,
  detailFlight: { key: string; epoch: number; promise: Promise<AdminOrderReturn> } | null = null,
  listFlight: Promise<void> | null = null
function authorize() {
  const caps = navigation.capabilities.value
  return (
    active &&
    props.runtime === 'cloudflare' &&
    ready.value === true &&
    loggedIn.value === true &&
    user.value?.emailVerified === true &&
    user.value?.mfaVerified === true &&
    actorKey.value !== null &&
    navigation.status.value === 'ready' &&
    caps?.state === 'ready' &&
    caps.identityId === operatorId.value &&
    caps.sessionId === session.value?.sessionId &&
    caps.sessionVersion === session.value?.sessionVersion &&
    caps.permissions.includes('administration.manage')
  )
}
function reload(): Promise<AdminOrderReturn> {
  if (!authorize() || !ownerKey.value) {
    snapshot.value = null
    return Promise.reject(new Error('return_access_unconfirmed'))
  }
  const key = ownerKey.value,
    epoch = generation,
    publicRef = selected.value,
    current = () =>
      active && generation === epoch && ownerKey.value === key && authorize() && selected.value === publicRef
  if (detailFlight?.key === key && detailFlight.epoch === epoch) return detailFlight.promise
  snapshot.value = null
  loading.value = true
  failed.value = false
  const promise = Promise.resolve().then(async () => {
    try {
      if (!current()) throw new Error('return_access_unconfirmed')
      const endpoint: string = `/api/admin/returns/${publicRef}`
      const raw: unknown = await requestFetch(endpoint, {
        method: 'GET',
        query: { page: 1, perPage: 25 },
        retry: 0,
        cache: 'no-store'
      })
      if (!current()) throw new Error('return_access_unconfirmed')
      const parsed = adminOrderReturnSchema.safeParse(raw)
      if (!parsed.success || parsed.data.publicRef !== publicRef || !current())
        throw new Error('return_read_unconfirmed')
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
        detailFlight = null
      }
    }
  })
  detailFlight = { key, epoch, promise }
  return promise
}
function reloadList(): Promise<void> {
  if (!authorize()) {
    list.value = null
    return Promise.reject(new Error('return_access_unconfirmed'))
  }
  if (listFlight) return listFlight
  const key = actorKey.value,
    epoch = generation,
    current = () => active && generation === epoch && actorKey.value === key && authorize()
  list.value = null
  listLoading.value = true
  listFailed.value = false
  const promise = Promise.resolve().then(async () => {
    try {
      if (!current()) throw new Error('return_access_unconfirmed')
      const endpoint: string = '/api/admin/returns'
      const raw: unknown = await requestFetch(endpoint, {
        method: 'GET',
        query: {
          page: page.value,
          perPage: 25,
          ...(query.value.trim() ? { q: query.value.trim() } : {}),
          ...(state.value ? { state: state.value } : {})
        },
        retry: 0,
        cache: 'no-store'
      })
      if (!current()) throw new Error('return_access_unconfirmed')
      const parsed = adminReturnListSchema.safeParse(raw)
      if (!parsed.success || !current()) throw new Error('return_list_unconfirmed')
      list.value = parsed.data
    } catch (error) {
      if (current()) {
        list.value = null
        listFailed.value = true
      }
      throw error
    } finally {
      if (active && generation === epoch && actorKey.value === key) {
        listLoading.value = false
        listFlight = null
      }
    }
  })
  listFlight = promise
  return promise
}
function refresh() {
  if (authorize()) {
    if (ownerKey.value) void reload().catch(() => undefined)
    if (!props.publicRef) void reloadList().catch(() => undefined)
  }
}
function select(value: string) {
  if (pending.value || !returnPublicRefSchema.safeParse(value).success) return
  selected.value = value
}
function filter(value = 1) {
  if (listLoading.value || value < 1) return
  page.value = value
  void reloadList().catch(() => undefined)
}
watch(
  () => props.publicRef,
  () => {
    selected.value = props.publicRef ?? ''
  }
)
watch(
  () => [
    props.runtime,
    operatorId.value,
    ready.value,
    loggedIn.value,
    user.value?.emailVerified,
    user.value?.mfaVerified,
    actorKey.value,
    navigation.status.value,
    navigation.capabilities.value,
    selected.value
  ],
  () => {
    generation++
    snapshot.value = null
    list.value = null
    loading.value = false
    failed.value = false
    listLoading.value = false
    listFailed.value = false
    detailFlight = null
    listFlight = null
    if (authorize()) refresh()
  },
  { immediate: true, flush: 'sync' }
)
watch(
  actorKey,
  () => {
    selected.value = props.publicRef ?? ''
    page.value = 1
    pendingChanged(false)
    query.value = ''
    state.value = ''
  },
  { flush: 'sync' }
)
onBeforeUnmount(() => {
  active = false
  generation++
  snapshot.value = null
  list.value = null
  detailFlight = null
  listFlight = null
  selected.value = query.value = state.value = ''
  pendingChanged(false)
})
function confirmed(receipt: ReturnCommandReceipt) {
  emit('confirmed', receipt)
  if (!props.publicRef) void reloadList().catch(() => undefined)
}
function pendingChanged(value: boolean) {
  pending.value = value
  emit('pending', value)
}
</script>
<template>
  <section aria-label="Devoluciones nativas del almacén único" class="space-y-5">
    <h1 class="text-2xl font-bold">Devoluciones · custodia e inspección</h1>
    <p class="text-sm">
      Solicitud, admisión documentada, recepción, inspección y resolución preparada. Sin autoridad económica, fiscal ni
      de transportistas.
    </p>
    <p v-if="runtime !== 'cloudflare'" role="status">El flujo nativo está disponible en el adaptador Cloudflare.</p>
    <p v-else-if="!authorize()" role="status">
      Confirma sesión administrativa, correo verificado y MFA. No se muestra historial privado sin acceso vigente.
    </p>
    <template v-else>
      <form v-if="!publicRef" class="flex flex-wrap gap-3" @submit.prevent="filter()">
        <label
          >Buscar referencia, pedido o cliente
          <input v-model="query" data-testid="return-list-query" maxlength="160" class="rounded border p-2" /></label
        ><label
          >Estado
          <select v-model="state" data-testid="return-list-state">
            <option value="">Todos</option>
            <option v-for="value in returnStateSchema.options" :key="value" :value="value">
              {{ returnStateLabels[value] }}
            </option>
          </select></label
        ><button data-testid="return-list-filter" :disabled="listLoading" class="rounded border p-2">Buscar</button>
      </form>
      <p v-if="listLoading && !publicRef" data-testid="return-list-loading" role="status">Confirmando lista privada…</p>
      <p v-if="listFailed && !publicRef" data-testid="return-list-error" role="alert">
        Lista no confirmada. No se interpreta como ausencia de devoluciones.
      </p>
      <div v-if="list && !publicRef">
        <p v-if="list.pagination.total === 0">No hay expedientes confirmados con estos filtros.</p>
        <ul class="space-y-2">
          <li v-for="item in list.items" :key="item.id">
            <button
              :data-testid="`return-open-${item.publicRef}`"
              :disabled="pending"
              type="button"
              class="rounded border p-3 text-left"
              @click="select(item.publicRef)"
            >
              {{ item.publicRef }} · {{ returnStateLabels[item.state] }} ·
              {{ item.customerName ?? 'Cliente no identificado' }} · solicitadas {{ item.requestedQuantity }}, recibidas
              {{ item.receivedQuantity }}
            </button>
          </li>
        </ul>
        <nav v-if="list.pagination.pages > 1" aria-label="Páginas de devoluciones">
          <button :disabled="page <= 1 || listLoading" @click="filter(page - 1)">Anterior</button
          ><span>{{ page }} / {{ list.pagination.pages }}</span
          ><button :disabled="page >= list.pagination.pages || listLoading" @click="filter(page + 1)">Siguiente</button>
        </nav>
      </div>
      <p v-if="loading" data-testid="return-detail-loading" role="status">Confirmando expediente…</p>
      <p v-else-if="failed" data-testid="return-detail-error" role="alert">
        No se ha podido confirmar el expediente. No se habilita ninguna operación con datos antiguos.
      </p>
      <button
        data-testid="return-refresh"
        :disabled="loading || listLoading"
        type="button"
        class="rounded border p-2"
        @click="refresh"
      >
        Actualizar datos confirmados
      </button>
    </template>
    <OrderReturnPanel
      v-if="ownerKey"
      :key="ownerKey"
      :snapshot="snapshot"
      :operator-id="operatorId"
      :runtime="runtime"
      :authorize="authorize"
      :reload="reload"
      @confirmed="confirmed"
      @pending="pendingChanged"
    />
  </section>
</template>
