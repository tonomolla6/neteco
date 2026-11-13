<script setup lang="ts">
import CustomerSupportPanel from './CustomerSupportPanel.vue'
import CustomerSatisfactionPanel from './CustomerSatisfactionPanel.vue'
import {
  supportCustomerListSchema,
  supportCustomerTicketSchema,
  supportRef,
  supportUuid
} from '~~/shared/support-operations'
import { useSupportRead } from './support/state'
import { supportStateLabels } from './support/labels'
const props = defineProps<{ runtime: unknown }>()
const { ready, loggedIn, user, session } = useUserSession(),
  requestFetch = useRequestFetch()
const operatorId = computed(() => (typeof user.value?.id === 'string' ? user.value.id : ''))
const actorKey = computed(() =>
  loggedIn.value === true && supportUuid.safeParse(operatorId.value).success ? operatorId.value : null
)
const authorize = () =>
  props.runtime === 'cloudflare' &&
  ready.value === true &&
  loggedIn.value === true &&
  user.value?.emailVerified === true &&
  actorKey.value !== null
const selected = ref<string | null>(null),
  page = ref(1),
  timelinePage = ref(1),
  supportPending = ref(false),
  satisfactionPending = ref(false)
const pending = computed(() => supportPending.value || satisfactionPending.value)
const satisfactionScope = computed(() =>
  JSON.stringify([actorKey.value, session.value?.sessionId, session.value?.sessionVersion])
)
const satisfactionAuthorized = () =>
  authorize() &&
  supportUuid.safeParse(session.value?.sessionId).success &&
  Number.isSafeInteger(session.value?.sessionVersion) &&
  Number(session.value?.sessionVersion) >= 1
const supportAuthorized = () => authorize() && !satisfactionPending.value
const request = (endpoint: string, query: Record<string, string | number>) =>
  requestFetch<unknown>(endpoint, { method: 'GET', query, retry: 0, cache: 'no-store' })
const list = useSupportRead({
  authorize,
  owner: () => actorKey.value,
  endpoint: () => '/api/account/support',
  query: () => ({ page: page.value, perPage: 25 }),
  request,
  decode: (raw) => {
    const parsed = supportCustomerListSchema.safeParse(raw)
    return parsed.success && parsed.data.pagination.page === page.value ? parsed.data : null
  }
})
const detail = useSupportRead({
  authorize: () => authorize() && selected.value !== null,
  owner: () => (actorKey.value && selected.value ? actorKey.value + ':' + selected.value : null),
  endpoint: () => '/api/account/support/' + selected.value,
  query: () => ({ page: timelinePage.value, perPage: 25 }),
  request,
  decode: (raw) => {
    const parsed = supportCustomerTicketSchema.safeParse(raw)
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
  () => [props.runtime, ready.value, loggedIn.value, user.value?.id, user.value?.emailVerified],
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
    supportPending.value = satisfactionPending.value = false
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
</script>
<template>
  <section aria-label="Mi portal privado de soporte" class="space-y-4">
    <h1 class="text-2xl font-bold">Mis consultas de soporte</h1>
    <p v-if="!authorize()" role="status">
      Necesitas una cuenta verificada y su propiedad vigente. Un correo, una referencia de pedido o una consulta anónima
      no acreditan acceso.
    </p>
    <template v-else>
      <p v-if="listLoading" data-testid="customer-support-loading" role="status">Cargando tus consultas…</p>
      <p v-if="listFailed" data-testid="customer-support-read-error" role="alert">
        No hemos podido cargar tus consultas ahora mismo. Vuelve a intentarlo en unos minutos.
      </p>
      <button
        data-testid="customer-support-refresh"
        :disabled="listLoading || pending"
        class="rounded border p-2"
        @click="list.refresh()"
      >
        Actualizar mis consultas
      </button>
      <a href="/contacto" class="underline">Escribir una consulta nueva</a>
      <div v-if="items">
        <p v-if="items.pagination.total === 0">Todavía no tienes consultas en esta cuenta.</p>
        <ul>
          <li v-for="item in items.items" :key="item.publicRef" class="rounded border p-3">
            <button :disabled="pending || detailLoading" class="underline" @click="select(item.publicRef)">
              {{ item.publicRef }} · {{ item.subject }}
            </button>
            <p>{{ supportStateLabels[item.state] }} · {{ item.updatedAt }}</p>
          </li>
        </ul>
        <nav v-if="items.pagination.pages > 1" aria-label="Páginas de consultas">
          <button :disabled="page <= 1 || listLoading || pending" @click="changePage(page - 1)">Anterior</button>
          {{ page }} / {{ items.pagination.pages }}
          <button :disabled="page >= items.pagination.pages || listLoading || pending" @click="changePage(page + 1)">
            Siguiente
          </button>
        </nav>
      </div>
      <p v-if="detailLoading" role="status">Cargando la conversación…</p>
      <p v-if="detailFailed" role="alert">Ticket no confirmado: no se muestran hechos almacenados de otra lectura.</p>
      <button v-if="selected" :disabled="detailLoading || pending" class="rounded border p-2" @click="detail.refresh()">
        Actualizar conversación
      </button>
    </template>
    <CustomerSupportPanel
      v-if="actorKey && selected"
      :key="actorKey + ':' + selected"
      :snapshot="ticket"
      :public-ref="selected"
      :operator-id="operatorId"
      :runtime="runtime"
      :authorize="supportAuthorized"
      :reload="detail.reload"
      @pending="supportPending = $event"
      @confirmed="list.refresh()"
    />
    <CustomerSatisfactionPanel
      v-if="ticket && selected && satisfactionAuthorized() && ['resolved', 'closed'].includes(ticket.state)"
      kind="support"
      :target-id="selected"
      :scope-key="satisfactionScope"
      :enabled="satisfactionAuthorized()"
      :pending="supportPending || detailLoading"
      @pending="satisfactionPending = $event"
    />
    <nav v-if="ticket && ticket.pagination.pages > 1" aria-label="Páginas de conversación">
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
