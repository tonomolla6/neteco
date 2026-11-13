<script setup lang="ts">
import OrderReturnPanel from './OrderReturnPanel.vue'
import {
  adminOrderReturnSchema,
  adminReturnListSchema,
  returnPublicRefSchema,
  returnStateSchema,
  type AdminOrderReturn,
  type AdminReturnList,
  type ReturnCommandReceipt,
  type ReturnState
} from '~~/shared/order-returns'
import type { AdminTone } from '~/utils/adminLabels'
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
// Presentación: nombres llanos de los estados, columnas y panel lateral de detalle.
const stateLabels: Record<ReturnState, string> = {
  requested: 'Solicitada',
  approved: 'Aceptada',
  rejected: 'Rechazada',
  received: 'Recibida',
  inspected: 'Revisada',
  resolution_ready: 'Lista para resolver'
}
const stateTones: Record<ReturnState, AdminTone> = {
  requested: 'warning',
  approved: 'info',
  rejected: 'danger',
  received: 'info',
  inspected: 'info',
  resolution_ready: 'success'
}
const columns = [
  { key: 'publicRef', label: 'Devolución' },
  { key: 'orderId', label: 'Pedido', hideOnMobile: true },
  { key: 'customerName', label: 'Cliente' },
  { key: 'reason', label: 'Motivo', hideOnMobile: true },
  { key: 'units', label: 'Recibidas / pedidas', numeric: true, hideOnMobile: true },
  { key: 'state', label: 'Estado' },
  { key: 'createdAt', label: 'Solicitada', hideOnMobile: true }
]
// El panel lateral refleja la devolución elegida; no se cierra con una operación a medias.
const drawerOpen = computed({
  get: () => !props.publicRef && ownerKey.value !== null,
  set: (value: boolean) => {
    if (!value && !pending.value) selected.value = ''
  }
})
function clearFilters() {
  query.value = ''
  state.value = ''
  filter()
}
</script>
<template>
  <section aria-label="Devoluciones nativas del almacén único" class="adm-stack">
    <UAlert
      v-if="runtime !== 'cloudflare'"
      role="status"
      color="warning"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      title="Las devoluciones no están disponibles en esta instalación"
    />
    <UAlert
      v-else-if="!authorize()"
      role="status"
      color="warning"
      variant="subtle"
      icon="i-lucide-lock"
      title="No podemos mostrar las devoluciones todavía"
      description="Inicia sesión como administrador, con el correo verificado y la verificación en dos pasos activa."
    />
    <template v-else>
      <template v-if="!publicRef">
        <p v-if="listLoading" data-testid="return-list-loading" role="status" class="sr-only">Cargando devoluciones…</p>
        <AdminCard v-if="listFailed">
          <div data-testid="return-list-error" role="alert">
            <AdminEmptyState
              variant="error"
              title="No hemos podido cargar las devoluciones"
              description="No significa que no haya ninguna. Vuelve a intentarlo."
            >
              <button
                data-testid="return-refresh"
                type="button"
                class="adm-btn adm-btn--secondary"
                :disabled="loading || listLoading"
                @click="refresh"
              >
                <UIcon name="i-lucide-rotate-cw" class="size-4" />Reintentar
              </button>
            </AdminEmptyState>
          </div>
        </AdminCard>
        <AdminTable
          v-else
          :rows="list?.items ?? []"
          :columns="columns"
          :row-key="(row) => row.id"
          :status="listLoading ? 'pending' : 'idle'"
          :total="list?.pagination.total ?? 0"
          :per-page="25"
          :page="page"
          :filtered="Boolean(list && (query.trim() || state))"
          empty-icon="i-lucide-rotate-ccw"
          empty-title="Aún no hay devoluciones"
          empty-description="Cuando un cliente pida devolver un pedido, la solicitud aparecerá aquí para que la revises, registres la recepción y prepares la resolución."
          caption="Devoluciones"
          @update:page="filter($event)"
          @clear-filters="clearFilters"
          @row-click="select($event.publicRef)"
        >
          <template #toolbar>
            <form class="adm-toolbar" role="search" @submit.prevent="filter()">
              <label class="adm-toolbar__search">
                <span class="sr-only">Buscar por referencia, pedido o cliente</span>
                <UIcon name="i-lucide-search" class="size-4" />
                <input
                  v-model="query"
                  type="search"
                  data-testid="return-list-query"
                  data-slot="adm-search"
                  maxlength="160"
                  placeholder="Buscar por referencia, pedido o cliente"
                />
              </label>
              <select v-model="state" data-testid="return-list-state" aria-label="Estado" @change="filter()">
                <option value="">Todos los estados</option>
                <option v-for="value in returnStateSchema.options" :key="value" :value="value">
                  {{ stateLabels[value] }}
                </option>
              </select>
              <button data-testid="return-list-filter" type="submit" class="sr-only" :disabled="listLoading">
                Buscar
              </button>
              <div class="adm-toolbar__end">
                <button
                  data-testid="return-refresh"
                  type="button"
                  class="adm-btn adm-btn--secondary"
                  :disabled="loading || listLoading"
                  @click="refresh"
                >
                  <UIcon name="i-lucide-rotate-cw" class="size-4" />Actualizar
                </button>
              </div>
            </form>
          </template>
          <template #cell-publicRef="{ row }">
            <span class="font-semibold text-[var(--text-strong)]">{{ row.publicRef }}</span>
          </template>
          <template #cell-orderId="{ row }">
            <span :title="row.orderId">#{{ row.orderId.slice(0, 8).toUpperCase() }}</span>
          </template>
          <template #cell-customerName="{ row }">{{ row.customerName ?? 'Cliente sin identificar' }}</template>
          <template #cell-reason="{ row }">
            <span class="line-clamp-2 max-w-xs text-[var(--text-muted)]">{{ row.reason }}</span>
          </template>
          <template #cell-units="{ row }">{{ row.receivedQuantity }} / {{ row.requestedQuantity }}</template>
          <template #cell-state="{ row }">
            <AdminBadge :tone="stateTones[row.state]">{{ stateLabels[row.state] }}</AdminBadge>
          </template>
          <template #cell-createdAt="{ row }">{{ adminDate(row.createdAt) }}</template>
          <template #actions="{ row }">
            <button
              :data-testid="`return-open-${row.publicRef}`"
              :disabled="pending"
              type="button"
              class="adm-btn adm-btn--secondary adm-btn--sm"
              @click="select(row.publicRef)"
            >
              Gestionar
            </button>
          </template>
        </AdminTable>

        <AdminDrawer
          v-model:open="drawerOpen"
          wide
          :title="`Devolución ${selected}`"
          description="Revisa la solicitud, registra la recepción y prepara la resolución."
        >
          <div class="adm-stack">
            <p v-if="loading" data-testid="return-detail-loading" role="status" class="adm-help">
              Cargando la devolución…
            </p>
            <div v-else-if="failed" data-testid="return-detail-error" role="alert">
              <AdminEmptyState
                variant="error"
                compact
                title="No hemos podido cargar esta devolución"
                description="Para evitar errores no se muestran datos antiguos. Vuelve a intentarlo."
              >
                <AdminButton icon="i-lucide-rotate-cw" :disabled="loading || listLoading" @click="refresh">
                  Reintentar
                </AdminButton>
              </AdminEmptyState>
            </div>
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
          </div>
          <template #footer>
            <AdminButton :disabled="pending" @click="drawerOpen = false">Cerrar</AdminButton>
          </template>
        </AdminDrawer>
      </template>

      <template v-else>
        <div class="flex flex-wrap items-center gap-3">
          <p v-if="loading" data-testid="return-detail-loading" role="status" class="adm-help">
            Cargando la devolución…
          </p>
          <button
            data-testid="return-refresh"
            type="button"
            class="adm-btn adm-btn--secondary adm-btn--sm"
            :disabled="loading || listLoading"
            @click="refresh"
          >
            <UIcon name="i-lucide-rotate-cw" class="size-4" />Actualizar
          </button>
        </div>
        <UAlert
          v-if="!loading && failed"
          data-testid="return-detail-error"
          role="alert"
          color="error"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          title="No hemos podido cargar esta devolución"
          description="Para evitar errores no se muestran datos antiguos. Pulsa «Actualizar» para reintentarlo."
        />
      </template>
    </template>
    <OrderReturnPanel
      v-if="ownerKey && publicRef"
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
