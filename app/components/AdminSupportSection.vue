<script setup lang="ts">
import AdminSupportPanel from './AdminSupportPanel.vue'
import AdminSatisfactionPanel from './AdminSatisfactionPanel.vue'
import { useAdminNavigation } from '~/composables/useAdminNavigation'
import { supportAdminListSchema, supportAdminTicketSchema, supportRef, supportUuid } from '~~/shared/support-operations'
import { useSupportRead } from './support/state'
import { supportCategoryLabels, supportStateLabels } from './support/labels'
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
</script>
<template>
  <section aria-label="Cola operativa de soporte" class="space-y-4">
    <h1 class="text-2xl font-bold">Soporte e incidencias</h1>
    <AdminSatisfactionPanel :scope-key="satisfactionScope" :enabled="satisfactionAuthorized()" :pending="pending" />
    <p v-if="!authorize()" role="status">
      Acceso con cuenta verificada y MFA. El servidor exige el permiso vigente support.manage; no se concede por entrar
      en esta página.
    </p>
    <template v-else>
      <form class="flex flex-wrap gap-3" @submit.prevent="search">
        <input v-model="filters.q" aria-label="Buscar consulta" maxlength="100" class="rounded border p-2" />
        <select v-model="filters.state" aria-label="Filtrar estado" class="rounded border p-2">
          <option value="">Todos los estados</option>
          <option v-for="(label, state) in supportStateLabels" :key="state" :value="state">{{ label }}</option>
        </select>
        <select v-model="filters.category" aria-label="Filtrar motivo" class="rounded border p-2">
          <option value="">Todos los motivos</option>
          <option v-for="(label, category) in supportCategoryLabels" :key="category" :value="category">
            {{ label }}
          </option>
        </select>
        <input
          v-model="filters.owner"
          aria-label="UUID de responsable"
          placeholder="UUID de responsable"
          class="rounded border p-2"
        />
        <button :disabled="listLoading || pending" class="rounded border p-2">Aplicar filtros</button>
      </form>
      <p v-if="listLoading" data-testid="admin-support-loading" role="status">Confirmando cola e identidad vigente…</p>
      <p v-if="listFailed" data-testid="admin-support-read-error" role="alert">
        No se ha confirmado la cola. Un error o permiso denegado no equivale a cero tickets.
      </p>
      <button
        data-testid="admin-support-refresh"
        :disabled="listLoading"
        class="rounded border p-2"
        @click="list.refresh()"
      >
        Actualizar cola
      </button>
      <div v-if="items">
        <p v-if="items.pagination.total === 0">Cola confirmada sin coincidencias.</p>
        <ul>
          <li v-for="item in items.items" :key="item.publicRef" class="rounded border p-3">
            <button :disabled="pending || detailLoading" class="underline" @click="select(item.publicRef)">
              {{ item.publicRef }} · {{ item.subject }}
            </button>
            <p>
              {{ supportStateLabels[item.state] }} · {{ item.priority
              }}<span v-if="item.ownerId"> · Responsable {{ item.ownerId }}</span
              ><span v-if="item.nextActionAt"> · Acción {{ item.nextActionAt }}</span>
            </p>
          </li>
        </ul>
        <nav v-if="items.pagination.pages > 1" aria-label="Páginas de cola">
          <button :disabled="page <= 1 || listLoading || pending" @click="changePage(page - 1)">Anterior</button>
          {{ page }} / {{ items.pagination.pages }}
          <button :disabled="page >= items.pagination.pages || listLoading || pending" @click="changePage(page + 1)">
            Siguiente
          </button>
        </nav>
      </div>
      <p v-if="detailLoading" role="status">Confirmando conversación seleccionada…</p>
      <p v-if="detailFailed" role="alert">No se ha confirmado este ticket; los hechos anteriores se han ocultado.</p>
      <button v-if="selected" :disabled="detailLoading" class="rounded border p-2" @click="detail.refresh()">
        Actualizar ticket
      </button>
    </template>
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
    <nav v-if="ticket && ticket.pagination.pages > 1" aria-label="Páginas de historial">
      <button :disabled="timelinePage <= 1 || detailLoading || pending" @click="changePage(timelinePage - 1, true)">
        Anterior
      </button>
      {{ timelinePage }} / {{ ticket.pagination.pages }}
      <button
        :disabled="timelinePage >= ticket.pagination.pages || detailLoading || pending"
        @click="changePage(timelinePage + 1, true)"
      >
        Siguiente
      </button>
    </nav>
  </section>
</template>
