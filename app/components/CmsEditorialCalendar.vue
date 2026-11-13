<script setup lang="ts">
import {
  cmsCalendarMonthSchema,
  cmsEditorialCalendarSchema,
  type CmsCalendarEvent,
  type CmsEditorialCalendar
} from '~~/shared/cms-calendar'
import { catalogPolicyUuidSchema } from '~~/shared/catalog-publication-policy'
import { madridDateKey } from '~~/server/utils/madrid-calendar'

const props = withDefaults(
  defineProps<{
    runtime: unknown
    operatorId: string
    authorize: () => boolean
    enabled: boolean
    canSelect?: boolean
  }>(),
  { canSelect: true }
)
const emit = defineEmits<{ selectPage: [pageId: string] }>(),
  prefix = useId(),
  fetchCalendar = useRequestFetch()
const month = ref(madridDateKey(new Date()).slice(0, 7)),
  snapshot = shallowRef<CmsEditorialCalendar | null>(null),
  reading = ref(false),
  status = ref('idle')
let alive = true,
  generation = 0,
  actor = ''
function authorized() {
  try {
    return (
      alive &&
      props.runtime === 'cloudflare' &&
      props.enabled === true &&
      catalogPolicyUuidSchema.safeParse(props.operatorId).success &&
      props.authorize() === true
    )
  } catch {
    return false
  }
}
const authority = computed(authorized),
  current = computed(() =>
    authority.value && status.value === 'success' && actor === props.operatorId ? snapshot.value : null
  )
watch([() => props.runtime, () => props.operatorId, () => props.enabled, authority], () => {
  generation++
  snapshot.value = null
  status.value = 'idle'
})
onBeforeUnmount(() => {
  alive = false
  generation++
})
function epochCurrent(epoch: number, operator: string) {
  return alive && generation === epoch && authorized() && props.operatorId === operator
}
async function load(selected = month.value, page = 1) {
  if (!authorized() || reading.value) return
  if (
    !cmsCalendarMonthSchema.safeParse(selected).success ||
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > 1_000_000
  ) {
    snapshot.value = null
    status.value = 'error'
    return
  }
  reading.value = true
  status.value = 'pending'
  snapshot.value = null
  const operator = props.operatorId,
    epoch = generation
  try {
    const raw: unknown = await fetchCalendar('/api/admin/content/calendar', {
      method: 'GET',
      query: { month: selected, page, perPage: 25 },
      retry: 0,
      cache: 'no-store'
    })
    if (!epochCurrent(epoch, operator)) return
    const parsed = cmsEditorialCalendarSchema.safeParse(raw)
    if (
      !parsed.success ||
      parsed.data.month !== selected ||
      parsed.data.pagination.page !== page ||
      parsed.data.pagination.perPage !== 25
    )
      throw new Error('calendar_read_unconfirmed')
    snapshot.value = parsed.data
    actor = operator
    month.value = selected
    status.value = 'success'
  } catch {
    if (epochCurrent(epoch, operator)) {
      snapshot.value = null
      status.value = 'error'
    }
  } finally {
    if (alive) reading.value = false
  }
}
onMounted(() => {
  void load()
})
function shiftMonth(delta: -1 | 1) {
  if (!cmsCalendarMonthSchema.safeParse(month.value).success) return
  const [year, index] = month.value.split('-').map(Number),
    target = new Date(Date.UTC(year!, index! - 1 + delta, 1)).toISOString().slice(0, 7)
  if (cmsCalendarMonthSchema.safeParse(target).success) void load(target)
}
const monthTitle = computed(() =>
    current.value
      ? new Intl.DateTimeFormat('es-ES', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
          new Date(`${current.value.month}-01T12:00:00Z`)
        )
      : ''
  ),
  days = computed(() => {
    if (!current.value) return []
    const [year, index] = current.value.month.split('-').map(Number),
      count = new Date(Date.UTC(year!, index!, 0)).getUTCDate(),
      padding = (new Date(Date.UTC(year!, index! - 1, 1)).getUTCDay() + 6) % 7,
      cells = Math.ceil((padding + count) / 7) * 7
    return Array.from({ length: cells }, (_, offset) => {
      const day = offset - padding + 1,
        key = day >= 1 && day <= count ? `${current.value!.month}-${String(day).padStart(2, '0')}` : ''
      return {
        day,
        key,
        events: key ? current.value!.events.filter((event) => event.localDateTime.slice(0, 10) === key) : []
      }
    })
  })
const labels: Record<CmsCalendarEvent['status'], string> = {
  scheduled: 'Programada',
  due: 'Pendiente de ejecución',
  applied: 'Aplicada',
  blocked: 'Bloqueada',
  cancelled: 'Cancelada',
  superseded: 'Sustituida'
}
function phaseLabel(event: CmsCalendarEvent) {
  return event.phase === 'publish' ? 'Publicación' : 'Despublicación'
}
function timeLabel(event: CmsCalendarEvent) {
  const offset = Math.abs(event.utcOffsetMinutes)
  return `${event.localDateTime.slice(11, 16)} (UTC${event.utcOffsetMinutes < 0 ? '−' : '+'}${String(Math.floor(offset / 60)).padStart(2, '0')}:${String(offset % 60).padStart(2, '0')})`
}
function failureLabel(code: string | null) {
  if (code === 'media_blocked') return 'Los medios ya no tienen evidencia vigente de seguridad o derechos.'
  if (code === 'publication_changed') return 'La publicación ha cambiado desde la aprobación; revisa la programación.'
  if (code === 'media_unavailable') return 'No está disponible el servicio de medios necesario.'
  return 'La operación no pudo completarse. Consulta los controles de la página antes de programarla de nuevo.'
}
function selectPage(event: CmsCalendarEvent) {
  const value = current.value
  if (!value || props.canSelect === false || reading.value || !authorized()) return
  if (
    ![...value.events, ...value.alerts.blockedEvents].some(
      (item) => item.scheduleId === event.scheduleId && item.phase === event.phase && item.pageId === event.pageId
    )
  )
    return
  emit('selectPage', event.pageId)
}
</script>

<template>
  <AdminCard
    :aria-labelledby="`${prefix}-heading`"
    description="Horas en horario peninsular (Europe/Madrid). Consultar el calendario no publica ni ejecuta nada."
  >
    <template #title>
      <span :id="`${prefix}-heading`">Calendario de publicaciones</span>
    </template>
    <div class="adm-stack">
      <UAlert
        v-if="!authority"
        role="alert"
        color="warning"
        variant="subtle"
        icon="i-lucide-lock"
        title="El calendario necesita la publicación configurada y una sesión vigente con permiso de contenido y verificación en dos pasos."
      />
      <form v-if="authority" class="flex flex-wrap items-end gap-2" @submit.prevent="load()">
        <AdminFormField label="Mes" :for="`${prefix}-month`">
          <input
            :id="`${prefix}-month`"
            v-model="month"
            data-cms-calendar-month
            type="month"
            min="2000-01"
            max="2099-12"
            required
            :disabled="reading"
          />
        </AdminFormField>
        <button
          type="button"
          class="adm-btn adm-btn--secondary"
          data-cms-calendar-previous-month
          :disabled="reading || month <= '2000-01'"
          @click="shiftMonth(-1)"
        >
          Mes anterior
        </button>
        <button
          type="button"
          class="adm-btn adm-btn--secondary"
          data-cms-calendar-next-month
          :disabled="reading || month >= '2099-12'"
          @click="shiftMonth(1)"
        >
          Mes siguiente
        </button>
        <button type="submit" class="adm-btn adm-btn--secondary" data-cms-calendar-refresh :disabled="reading">
          Actualizar
        </button>
      </form>
      <p v-if="authority && status === 'pending'" role="status" class="adm-help">Consultando el calendario…</p>
      <div v-else-if="authority && !current" role="alert">
        <AdminEmptyState
          variant="error"
          compact
          title="No se ha podido cargar el calendario"
          description="No hay un calendario confirmado. Esto no significa que no existan programaciones ni fallos."
        >
          <button type="button" class="adm-btn adm-btn--secondary" :disabled="reading" @click="load()">
            Reintentar
          </button>
        </AdminEmptyState>
      </div>
      <template v-if="current">
        <div
          v-if="current.alerts.blockedCount"
          role="alert"
          data-cms-calendar-failures
          class="rounded-[var(--radius-surface)] border border-[var(--border)] bg-[var(--surface-sunken)] p-3"
        >
          <p class="font-semibold text-[var(--text-strong)]">
            <AdminBadge tone="warning">Atención</AdminBadge>
            {{ current.alerts.blockedCount }} operaciones bloqueadas todavía activas, en cualquier mes.
          </p>
          <ul class="mt-2 space-y-2">
            <li v-for="event in current.alerts.blockedEvents" :key="`${event.scheduleId}:${event.phase}`">
              <button
                type="button"
                class="text-left font-semibold text-[var(--text-strong)] underline disabled:opacity-60"
                :data-cms-calendar-alert-page="event.pageId"
                :disabled="canSelect === false"
                @click="selectPage(event)"
              >
                {{ event.title }} · {{ phaseLabel(event) }} · {{ event.localDateTime.slice(0, 10) }}
                {{ timeLabel(event) }}
              </button>
              <p class="adm-help">{{ failureLabel(event.code) }}</p>
            </li>
          </ul>
          <p v-if="current.alerts.hasMore" class="adm-help mt-2">
            Se muestran los 10 fallos activos más antiguos. Revisa también las programaciones de las páginas restantes.
          </p>
        </div>
        <UAlert
          v-if="current.alerts.dueCount"
          role="status"
          color="neutral"
          variant="subtle"
          icon="i-lucide-clock"
          :title="`${current.alerts.dueCount} operaciones vencidas esperan ejecución, en cualquier mes. Todavía no tienen un resultado registrado; no son fallos confirmados.`"
        />
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h4 class="font-semibold capitalize text-[var(--text-strong)]">{{ monthTitle }}</h4>
          <span class="adm-help">
            {{ current.pagination.total }} operaciones · página {{ current.pagination.page }}
          </span>
        </div>
        <p v-if="current.pagination.total === 0" role="status" class="adm-help">
          No hay operaciones programadas en este mes.
        </p>
        <p v-else-if="current.pagination.total > 25" role="status" class="adm-help">
          Se muestran {{ current.events.length }} de {{ current.pagination.total }} operaciones. Un día vacío puede
          tener operaciones en otras páginas del calendario.
        </p>
        <div
          role="region"
          :aria-label="`Calendario de ${monthTitle}, Europe/Madrid`"
          tabindex="0"
          class="overflow-x-auto rounded-[var(--radius-surface)] border border-[var(--border)]"
        >
          <div class="grid min-w-[720px] grid-cols-7">
            <div
              v-for="day in ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo']"
              :key="day"
              class="border-b border-[var(--border)] bg-[var(--canvas)] px-2 py-2 text-xs font-semibold text-[var(--text-muted)]"
            >
              {{ day }}
            </div>
            <div
              v-for="(day, index) in days"
              :key="day.key || `padding-${index}`"
              :data-cms-calendar-day="day.key || undefined"
              class="min-h-24 border-b border-r border-[var(--border)] p-2"
              :class="day.key ? '' : 'bg-[var(--canvas)]'"
            >
              <template v-if="day.key">
                <time :datetime="day.key" class="text-xs font-semibold text-[var(--text-muted)]">{{ day.day }}</time>
                <ul class="mt-1 space-y-2">
                  <li
                    v-for="event in day.events"
                    :key="`${event.scheduleId}:${event.phase}`"
                    class="rounded-[var(--radius-control)] border border-[var(--border)] p-1.5 text-xs"
                    :class="event.status === 'blocked' && event.active ? 'bg-[var(--surface-sunken)]' : ''"
                  >
                    <button
                      type="button"
                      :data-cms-calendar-page="event.pageId"
                      :disabled="canSelect === false"
                      :aria-label="`${phaseLabel(event)} de ${event.title}, ${day.key}, ${timeLabel(event)}, ${labels[event.status]}`"
                      class="max-w-full whitespace-normal text-left font-semibold text-[var(--text-strong)] underline disabled:opacity-60"
                      @click="selectPage(event)"
                    >
                      {{ event.title }}
                    </button>
                    <p>{{ phaseLabel(event) }} · versión {{ event.version }}</p>
                    <time :datetime="event.scheduledAt">{{ timeLabel(event) }}</time>
                    <p class="font-semibold">
                      {{ labels[event.status]
                      }}<span v-if="event.status === 'blocked' && !event.active"> · antigua, ya no activa</span>
                    </p>
                  </li>
                </ul>
              </template>
            </div>
          </div>
        </div>
        <div v-if="current.pagination.total > 25" class="flex flex-wrap gap-2">
          <button
            type="button"
            class="adm-btn adm-btn--secondary adm-btn--sm"
            data-cms-calendar-previous-page
            :disabled="reading || current.pagination.page <= 1"
            @click="load(current.month, current.pagination.page - 1)"
          >
            Página anterior
          </button>
          <button
            type="button"
            class="adm-btn adm-btn--secondary adm-btn--sm"
            data-cms-calendar-next-page
            :disabled="reading || !current.pagination.hasMore"
            @click="load(current.month, current.pagination.page + 1)"
          >
            Página siguiente
          </button>
        </div>
        <p class="adm-help">
          Datos del {{ adminDate(current.asOf, true) }}. Para corregir un fallo, abre la página y usa su pestaña
          «Publicación».
        </p>
      </template>
    </div>
  </AdminCard>
</template>
