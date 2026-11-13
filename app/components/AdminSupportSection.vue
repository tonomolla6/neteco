<script setup lang="ts">
import AdminSupportPanel from './AdminSupportPanel.vue'
import AdminSatisfactionPanel from './AdminSatisfactionPanel.vue'
import { useAdminNavigation } from '~/composables/useAdminNavigation'
import { supportAdminListSchema, supportAdminTicketSchema, supportRef, supportUuid } from '~~/shared/support-operations'
import { useSupportRead } from './support/state'
import { supportCategoryLabels, supportPriorityLabels, supportStateLabels } from './support/labels'
import type { SupportAdminList } from '~~/shared/support-operations'
import type { AdminTone } from '~/utils/adminLabels'
const props = defineProps<{ runtime: unknown }>()
const { ready, loggedIn, user, session } = useUserSession(),
  requestFetch = useRequestFetch()
const operatorId = computed(() => (typeof user.value?.id === 'string' ? user.value.id : ''))
const actorKey = computed(() =>
  loggedIn.value === true && supportUuid.safeParse(operatorId.value).success ? operatorId.value : null
)
const navigation = useAdminNavigation()
const satisfactionScope = computed(() =>
  JSON.stringify([actorKey.value, session.value?.sessionId, session.value?.sessionVersion])
)
const satisfactionAuthorized = () => {
  const caps = navigation.capabilities.value
  return (
    authorize() &&
    supportUuid.safeParse(session.value?.sessionId).success &&
    Number.isSafeInteger(session.value?.sessionVersion) &&
    Number(session.value?.sessionVersion) >= 1 &&
    navigation.status.value === 'ready' &&
    caps?.state === 'ready' &&
    caps.identityId === actorKey.value &&
    caps.sessionId === session.value?.sessionId &&
    caps.sessionVersion === session.value?.sessionVersion &&
    caps.permissions.includes('support.manage')
  )
}
const authorize = () =>
  props.runtime === 'cloudflare' &&
  ready.value === true &&
  loggedIn.value === true &&
  user.value?.emailVerified === true &&
  user.value?.mfaVerified === true &&
  actorKey.value !== null
const selected = ref<string | null>(null),
  page = ref(1),
  timelinePage = ref(1),
  pending = ref(false),
  filters = reactive({ q: '', state: '', category: '', owner: '' }),
  applied = reactive<Record<string, string>>({})
const request = (endpoint: string, query: Record<string, string | number>) =>
  requestFetch<unknown>(endpoint, { method: 'GET', query, retry: 0, cache: 'no-store' })
const list = useSupportRead({
  authorize,
  owner: () => actorKey.value,
  endpoint: () => '/api/admin/support',
  query: () => ({ page: page.value, perPage: 25, ...applied }),
  request,
  decode: (raw) => {
    const parsed = supportAdminListSchema.safeParse(raw)
    return parsed.success && parsed.data.pagination.page === page.value ? parsed.data : null
  }
})
const detail = useSupportRead({
  authorize: () => authorize() && selected.value !== null,
  owner: () => (actorKey.value && selected.value ? actorKey.value + ':' + selected.value : null),
  endpoint: () => '/api/admin/support/' + selected.value,
  query: () => ({ page: timelinePage.value, perPage: 25 }),
  request,
  decode: (raw) => {
    const parsed = supportAdminTicketSchema.safeParse(raw)
    return parsed.success &&
      parsed.data.publicRef === selected.value &&
      parsed.data.pagination.page === timelinePage.value
      ? parsed.data
      : null
  }
})
const { snapshot: items, loading: listLoading, failed: listFailed } = list,
  { snapshot: ticket, loading: detailLoading, failed: detailFailed } = detail
watch(
  () => [
    props.runtime,
    ready.value,
    loggedIn.value,
    user.value?.id,
    user.value?.emailVerified,
    user.value?.mfaVerified
  ],
  () => {
    list.reset()
    detail.reset()
    list.refresh()
    detail.refresh()
  },
  { immediate: true, flush: 'sync' }
)
watch(
  actorKey,
  () => {
    selected.value = null
    page.value = 1
    timelinePage.value = 1
    pending.value = false
    filters.q = ''
    filters.owner = ''
    for (const key of Object.keys(applied)) Reflect.deleteProperty(applied, key)
  },
  { flush: 'sync' }
)
function select(ref: string) {
  if (pending.value || detailLoading.value || !supportRef.safeParse(ref).success) return
  selected.value = ref
  timelinePage.value = 1
  detail.reset()
  detail.refresh()
}
function search() {
  if (pending.value || listLoading.value) return
  selected.value = null
  detail.reset()
  page.value = 1
  for (const key of Object.keys(applied)) Reflect.deleteProperty(applied, key)
  for (const [key, value] of Object.entries(filters)) if (value.trim()) applied[key] = value.trim()
  list.reset()
  list.refresh()
}
function changePage(value: number, timeline = false) {
  if (pending.value || value < 1 || (timeline ? detailLoading.value : listLoading.value)) return
  if (timeline) {
    timelinePage.value = value
    detail.reset()
    detail.refresh()
  } else {
    page.value = value
    list.reset()
    list.refresh()
  }
}
function confirmed() {
  list.refresh()
}
/* --- Estado de interfaz: apartados, columnas, filtros en línea y panel lateral de detalle --- */
type SupportRow = SupportAdminList['items'][number]
const view = ref('queue')
const views = [
  { value: 'queue', label: 'Bandeja' },
  { value: 'ratings', label: 'Valoraciones de la atención' }
]
watch(
  () => satisfactionAuthorized(),
  (allowed) => {
    if (!allowed) view.value = 'queue'
  }
)
const columns = [
  { key: 'subject', label: 'Asunto' },
  { key: 'customer', label: 'Cliente', hideOnMobile: true },
  { key: 'state', label: 'Estado' },
  { key: 'priority', label: 'Prioridad' },
  { key: 'slaDueAt', label: 'Plazo de respuesta' },
  { key: 'updatedAt', label: 'Última actividad', hideOnMobile: true }
]
const stateSegments: Record<string, string> = {
  open: 'Abiertas',
  waiting_customer: 'Esperando al cliente',
  waiting_provider: 'Esperando a terceros',
  resolved: 'Resueltas',
  closed: 'Cerradas'
}
const stateOptions = computed(() => [
  { value: '', label: 'Todas', disabled: listLoading.value || pending.value },
  ...Object.entries(stateSegments).map(([value, label]) => ({
    value,
    label,
    disabled: listLoading.value || pending.value
  }))
])
const stateTones: Record<string, AdminTone> = {
  open: 'warning',
  waiting_customer: 'info',
  waiting_provider: 'info',
  resolved: 'success',
  closed: 'neutral'
}
const priorityTones: Record<string, AdminTone> = {
  low: 'neutral',
  normal: 'neutral',
  high: 'warning',
  urgent: 'danger'
}
const hasFilters = computed(() => Object.keys(applied).length > 0)
const openedAt = Date.now()
function overdue(row: SupportRow) {
  return (
    row.slaDueAt !== null && !['resolved', 'closed'].includes(row.state) && new Date(row.slaDueAt).getTime() < openedAt
  )
}
function applyFilter(key: 'state', value: string) {
  if (pending.value || listLoading.value) return
  filters[key] = value
  search()
}
function clearFilters() {
  if (pending.value || listLoading.value) return
  filters.q = ''
  filters.state = ''
  filters.category = ''
  filters.owner = ''
  search()
}
const drawerOpen = computed({
  get: () => selected.value !== null,
  set: (value: boolean) => {
    if (value || pending.value) return
    selected.value = null
    detail.reset()
  }
})
</script>
<template>
  <section aria-label="Cola operativa de soporte" class="adm-stack">
    <AdminTabs v-if="satisfactionAuthorized()" v-model="view" :tabs="views" label="Apartados de consultas" />
    <div v-show="view === 'ratings'">
      <AdminSatisfactionPanel :scope-key="satisfactionScope" :enabled="satisfactionAuthorized()" :pending="pending" />
    </div>
    <div v-show="view === 'queue'" class="adm-stack">
      <UAlert
        v-if="!authorize()"
        role="status"
        color="warning"
        variant="subtle"
        icon="i-lucide-lock"
        title="No puedes ver las consultas con esta sesión"
        description="Hace falta una cuenta con el correo verificado, la verificación en dos pasos y permiso de atención al cliente."
      />
      <template v-else>
        <p v-if="listLoading" data-testid="admin-support-loading" role="status" class="sr-only">Cargando consultas…</p>
        <p v-if="listFailed" data-testid="admin-support-read-error" role="alert" class="sr-only">
          No se han podido cargar las consultas.
        </p>
        <AdminTable
          :rows="items?.items ?? []"
          :columns="columns"
          :row-key="(row) => row.publicRef"
          :status="listFailed ? 'error' : listLoading ? 'pending' : 'idle'"
          :total="items ? items.pagination.total : page * 25"
          :per-page="25"
          :page="page"
          :filtered="hasFilters"
          caption="Consultas de clientes"
          empty-icon="i-lucide-life-buoy"
          empty-title="No hay consultas"
          empty-description="Cuando un cliente escriba desde su pedido o desde el formulario de contacto, su consulta aparecerá aquí."
          error-message="Puede ser un fallo de conexión o de permisos. Vuelve a intentarlo."
          @update:page="changePage($event)"
          @retry="list.refresh()"
          @clear-filters="clearFilters"
          @row-click="select($event.publicRef)"
        >
          <template #toolbar>
            <form class="adm-toolbar" role="search" @submit.prevent="search">
              <label class="adm-toolbar__search">
                <span class="sr-only">Buscar consulta</span>
                <UIcon name="i-lucide-search" class="size-4" />
                <input
                  v-model="filters.q"
                  type="search"
                  aria-label="Buscar consulta"
                  maxlength="100"
                  placeholder="Buscar por asunto o referencia"
                />
              </label>
              <AdminFilters
                :model-value="filters.state"
                :options="stateOptions"
                label="Filtrar estado"
                @update:model-value="applyFilter('state', $event)"
              />
              <select
                v-model="filters.category"
                aria-label="Filtrar motivo"
                class="adm-input"
                :disabled="listLoading || pending"
                @change="search"
              >
                <option value="">Todos los motivos</option>
                <option v-for="(label, category) in supportCategoryLabels" :key="category" :value="category">
                  {{ label }}
                </option>
              </select>
              <select
                v-model="filters.owner"
                aria-label="Filtrar responsable"
                class="adm-input"
                :disabled="listLoading || pending"
                @change="search"
              >
                <option value="">Cualquier responsable</option>
                <option :value="operatorId">Asignadas a mí</option>
              </select>
              <button type="submit" :disabled="listLoading || pending" class="sr-only">Aplicar filtros</button>
              <div class="adm-toolbar__end">
                <button
                  type="button"
                  data-testid="admin-support-refresh"
                  :disabled="listLoading"
                  class="adm-btn adm-btn--secondary"
                  @click="list.refresh()"
                >
                  <UIcon name="i-lucide-rotate-cw" class="size-4" />Actualizar
                </button>
              </div>
            </form>
          </template>
          <template #cell-subject="{ row }">
            <button
              type="button"
              :disabled="pending || detailLoading"
              class="block max-w-md text-left font-semibold text-[var(--text-strong)] hover:underline"
              @click="select(row.publicRef)"
            >
              {{ row.subject }}
              <span class="block text-xs font-normal text-[var(--text-muted)]">
                {{ row.publicRef }} · {{ supportCategoryLabels[row.category] ?? 'Otra consulta' }}
              </span>
            </button>
          </template>
          <template #cell-customer="{ row }">
            <AdminBadge :tone="row.identityStatus === 'verified_customer' ? 'success' : 'neutral'" plain>
              {{ row.identityStatus === 'verified_customer' ? 'Cliente registrado' : 'Contacto sin verificar' }}
            </AdminBadge>
            <p v-if="row.ownerId" class="mt-1 text-xs text-[var(--text-muted)]">
              {{ row.ownerId === operatorId ? 'Asignada a mí' : 'Con responsable' }}
            </p>
          </template>
          <template #cell-state="{ row }">
            <AdminBadge :tone="stateTones[row.state] ?? 'neutral'">{{ supportStateLabels[row.state] }}</AdminBadge>
          </template>
          <template #cell-priority="{ row }">
            <AdminBadge :tone="priorityTones[row.priority] ?? 'neutral'" plain>
              {{ supportPriorityLabels[row.priority] }}
            </AdminBadge>
          </template>
          <template #cell-slaDueAt="{ row }">
            <span v-if="!row.slaDueAt" class="text-[var(--text-muted)]">Sin plazo</span>
            <span v-else :class="overdue(row as Parameters<typeof overdue>[0]) && 'font-semibold text-red-700'">
              <template v-if="overdue(row as Parameters<typeof overdue>[0])">Vencido · </template
              >{{ adminDate(row.slaDueAt, true) }}
            </span>
          </template>
          <template #cell-updatedAt="{ row }">{{ adminDate(row.updatedAt, true) }}</template>
        </AdminTable>
      </template>
    </div>

    <AdminDrawer
      v-model:open="drawerOpen"
      wide
      :title="ticket?.subject ?? 'Consulta'"
      :description="selected ? `Consulta ${selected}` : undefined"
    >
      <div class="adm-stack">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <p v-if="detailLoading" role="status" class="adm-help">Cargando la consulta…</p>
          <span v-else />
          <button
            v-if="selected"
            type="button"
            :disabled="detailLoading"
            class="adm-btn adm-btn--ghost adm-btn--sm"
            @click="detail.refresh()"
          >
            <UIcon name="i-lucide-rotate-cw" class="size-4" />Actualizar consulta
          </button>
        </div>
        <UAlert
          v-if="detailFailed"
          role="alert"
          color="error"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          title="No se ha podido cargar esta consulta"
          description="Puede ser un fallo de conexión o de permisos."
          :actions="[{ label: 'Reintentar', color: 'neutral', variant: 'outline', onClick: () => detail.refresh() }]"
        />
        <AdminSupportPanel
          v-if="actorKey && selected"
          :key="actorKey + ':' + selected"
          :snapshot="ticket"
          :public-ref="selected"
          :operator-id="operatorId"
          :runtime="runtime"
          :authorize="authorize"
          :reload="detail.reload"
          @pending="pending = $event"
          @confirmed="confirmed"
        />
        <nav
          v-if="ticket && ticket.pagination.pages > 1"
          aria-label="Páginas de historial"
          class="flex flex-wrap items-center justify-between gap-2 text-[0.8125rem] text-[var(--text-muted)]"
        >
          <span>Historial: página {{ timelinePage }} de {{ ticket.pagination.pages }}</span>
          <span class="flex gap-2">
            <button
              type="button"
              class="adm-btn adm-btn--secondary adm-btn--sm"
              :disabled="timelinePage <= 1 || detailLoading || pending"
              @click="changePage(timelinePage - 1, true)"
            >
              Anterior
            </button>
            <button
              type="button"
              class="adm-btn adm-btn--secondary adm-btn--sm"
              :disabled="timelinePage >= ticket.pagination.pages || detailLoading || pending"
              @click="changePage(timelinePage + 1, true)"
            >
              Siguiente
            </button>
          </span>
        </nav>
      </div>
    </AdminDrawer>
  </section>
</template>
