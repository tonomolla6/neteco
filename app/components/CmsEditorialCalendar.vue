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
  <section :aria-labelledby="`${prefix}-heading`" class="rounded-xl border border-slate-200 bg-white p-4 space-y-4">
    <div>
      <h3 :id="`${prefix}-heading`" class="font-semibold text-slate-900">Calendario editorial</h3>
      <p class="text-sm text-slate-600">
        Horarios en Europe/Madrid. Consultar el calendario no publica ni ejecuta tareas.
      </p>
    </div>
    <p v-if="!authority" role="alert">
      El calendario requiere publicación configurada y una sesión vigente con permiso de contenido y MFA.
    </p>
    <form v-if="authority" class="flex flex-wrap items-end gap-3" @submit.prevent="load()">
      <div>
        <label :for="`${prefix}-month`" class="block text-sm font-medium">Mes</label>
        <input
          :id="`${prefix}-month`"
          v-model="month"
          data-cms-calendar-month
          type="month"
          min="2000-01"
          max="2099-12"
          required
          :disabled="reading"
          class="mt-1 rounded border border-slate-300 px-3 py-2"
        />
      </div>
      <UButton type="submit" data-cms-calendar-refresh :disabled="reading">Consultar calendario</UButton>
      <UButton
        type="button"
        variant="outline"
        data-cms-calendar-previous-month
        :disabled="reading || month <= '2000-01'"
        @click="shiftMonth(-1)"
        >Mes anterior</UButton
      >
      <UButton
        type="button"
        variant="outline"
        data-cms-calendar-next-month
        :disabled="reading || month >= '2099-12'"
        @click="shiftMonth(1)"
        >Mes siguiente</UButton
      >
    </form>
    <p v-if="authority && status === 'pending'" role="status">Consultando calendario y avisos…</p>
    <p v-else-if="authority && !current" role="alert">
      No hay un calendario confirmado. Esto no significa que no existan programaciones ni fallos. Reintenta sólo la
      consulta.
    </p>
    <template v-if="current">
      <div
        v-if="current.alerts.blockedCount"
        role="alert"
        data-cms-calendar-failures
        class="rounded-lg border border-amber-300 bg-amber-50 p-3"
      >
        <p class="font-medium">
          {{ current.alerts.blockedCount }} operaciones bloqueadas todavía activas, en cualquier mes.
        </p>
        <ul class="mt-2 space-y-2">
          <li v-for="event in current.alerts.blockedEvents" :key="`${event.scheduleId}:${event.phase}`">
            <UButton
              variant="link"
              :data-cms-calendar-alert-page="event.pageId"
              :disabled="canSelect === false"
              @click="selectPage(event)"
              >{{ event.title }} · {{ phaseLabel(event) }} · {{ event.localDateTime.slice(0, 10) }}
              {{ timeLabel(event) }}</UButton
            >
            <p class="text-sm">{{ failureLabel(event.code) }}</p>
          </li>
        </ul>
        <p v-if="current.alerts.hasMore" class="mt-2 text-sm">
          Se muestran los 10 fallos activos más antiguos. Revisa también las programaciones de las páginas restantes.
        </p>
      </div>
      <p v-if="current.alerts.dueCount" role="status" class="rounded bg-slate-100 p-3">
        {{ current.alerts.dueCount }} operaciones vencidas esperan ejecución, en cualquier mes. Todavía no tienen un
        resultado registrado; no son fallos confirmados.
      </p>
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h4 class="font-semibold capitalize">{{ monthTitle }}</h4>
        <span class="text-sm">{{ current.pagination.total }} operaciones · página {{ current.pagination.page }}</span>
      </div>
      <p v-if="current.pagination.total === 0" role="status">No hay operaciones programadas en este mes.</p>
      <p v-else-if="current.pagination.total > 25" role="status" class="text-sm">
        Se muestran {{ current.events.length }} de {{ current.pagination.total }} operaciones. Un día vacío puede tener
        operaciones en otras páginas del calendario.
      </p>
      <div
        role="region"
        :aria-label="`Calendario de ${monthTitle}, Europe/Madrid`"
        tabindex="0"
        class="overflow-x-auto rounded-lg border border-slate-200"
      >
        <div class="grid min-w-[720px] grid-cols-7">
          <div
            v-for="day in ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo']"
            :key="day"
            class="border-b bg-slate-50 px-2 py-2 text-sm font-medium"
          >
            {{ day }}
          </div>
          <div
            v-for="(day, index) in days"
            :key="day.key || `padding-${index}`"
            :data-cms-calendar-day="day.key || undefined"
            class="min-h-24 border-b border-r border-slate-100 p-2"
            :class="day.key ? '' : 'bg-slate-50'"
          >
            <template v-if="day.key">
              <time :datetime="day.key" class="text-sm font-medium">{{ day.day }}</time>
              <ul class="mt-1 space-y-2">
                <li
                  v-for="event in day.events"
                  :key="`${event.scheduleId}:${event.phase}`"
                  class="rounded border p-1 text-xs"
                  :class="
                    event.status === 'blocked' && event.active ? 'border-amber-400 bg-amber-50' : 'border-slate-200'
                  "
                >
                  <UButton
                    variant="link"
                    size="xs"
                    :data-cms-calendar-page="event.pageId"
                    :disabled="canSelect === false"
                    :aria-label="`${phaseLabel(event)} de ${event.title}, ${day.key}, ${timeLabel(event)}, ${labels[event.status]}`"
                    class="max-w-full whitespace-normal p-0 text-left"
                    @click="selectPage(event)"
                    >{{ event.title }}</UButton
                  >
                  <p>{{ phaseLabel(event) }} · v{{ event.version }}</p>
                  <time :datetime="event.scheduledAt">{{ timeLabel(event) }}</time>
                  <p class="font-medium">
                    {{ labels[event.status]
                    }}<span v-if="event.status === 'blocked' && !event.active"> · histórica, ya no activa</span>
                  </p>
                </li>
              </ul>
            </template>
          </div>
        </div>
      </div>
      <div v-if="current.pagination.total > 25" class="flex flex-wrap gap-2">
        <UButton
          data-cms-calendar-previous-page
          variant="outline"
          :disabled="reading || current.pagination.page <= 1"
          @click="load(current.month, current.pagination.page - 1)"
          >Página anterior</UButton
        >
        <UButton
          data-cms-calendar-next-page
          variant="outline"
          :disabled="reading || !current.pagination.hasMore"
          @click="load(current.month, current.pagination.page + 1)"
          >Página siguiente</UButton
        >
      </div>
      <p class="text-xs text-slate-500">
        Estado confirmado a {{ current.asOf }}. Usa «Consultar calendario» para actualizar. Para corregir un fallo, abre
        la página y usa sus controles editoriales explícitos.
      </p>
    </template>
  </section>
</template>
