<script setup lang="ts">
import { ref, computed, onMounted, reactive } from 'vue'
import type { DeliveryRoute, ReoptimizeDeliveryRouteResult } from '~~/shared/delivery-route-planning'
import type { AdminTone } from '~/utils/adminLabels'

const props = defineProps<{
  routeId: string
}>()
const emit = defineEmits<{
  /** La ruta ha cambiado (paradas, orden): quien la lista puede actualizar su resumen. */
  changed: [route: DeliveryRoute]
  /** La ruta ya no existe: conviene volver a cargar el listado. */
  gone: []
}>()

const requestFetch = useRequestFetch()

const loading = ref(true)
const reoptimizing = ref(false)
const error = ref<string | null>(null)
const successNotice = ref<string | null>(null)
const route = ref<DeliveryRoute | null>(null)
/** La ruta pedida no existe (404): no es un fallo, se explica y se ofrece volver al listado. */
const missing = ref(false)
const strategy = ref<'window_priority' | 'distance_priority'>('window_priority')

function failure(err: unknown): { status: number | null; code: string | null } {
  const value = err && typeof err === 'object' ? (err as Record<string, unknown>) : null
  const response =
    value?.response && typeof value.response === 'object' ? (value.response as { status?: unknown }) : null
  const rawStatus = value?.statusCode ?? value?.status ?? response?.status
  const data = value?.data && typeof value.data === 'object' ? (value.data as Record<string, unknown>) : null
  const nested = data?.error && typeof data.error === 'object' ? (data.error as Record<string, unknown>) : null
  return {
    status: typeof rawStatus === 'number' ? rawStatus : null,
    code: typeof nested?.code === 'string' ? nested.code : null
  }
}

const FAILURE_TEXT: Record<string, string> = {
  version_conflict:
    'Otra persona ha cambiado esta ruta mientras tanto. Ya ves los datos actuales: vuelve a intentarlo.',
  idempotency_conflict: 'Esta operación ya se había enviado. Vuelve a intentarlo.',
  forbidden: 'Una ruta completada o cancelada ya no se puede modificar.',
  capacity_exceeded: 'El vehículo no tiene capacidad para más peso o más bultos en esta ruta.',
  invalid_input: 'Revisa los datos: hay algún campo incompleto o con un formato no válido.'
}

async function fetchRoute(options: { silent?: boolean } = {}) {
  if (!options.silent) {
    loading.value = true
    error.value = null
  }
  try {
    const res = await requestFetch<{ route: DeliveryRoute }>(`/api/admin/delivery-routes/${props.routeId}`)
    route.value = res.route
    missing.value = false
  } catch (err: unknown) {
    const { status, code } = failure(err)
    if (status === 404 || code === 'not_found') {
      route.value = null
      missing.value = true
    } else if (!options.silent) {
      error.value = 'No se ha podido cargar la ruta de reparto.'
    }
  } finally {
    loading.value = false
  }
}

/** Traduce un fallo al guardar a un mensaje llano; devuelve `null` si la ruta ha dejado de existir. */
async function explainFailure(err: unknown, fallback: string): Promise<string | null> {
  const { status, code } = failure(err)
  if (status === 404 || code === 'not_found') {
    route.value = null
    missing.value = true
    return null
  }
  if (code === 'version_conflict') await fetchRoute({ silent: true })
  return (code && FAILURE_TEXT[code]) || fallback
}

const weightPercent = computed(() => {
  if (!route.value?.maxWeightGrams || route.value.maxWeightGrams <= 0) return 0
  return Math.min(Math.round((route.value.totalWeightGrams / route.value.maxWeightGrams) * 100), 100)
})

const parcelPercent = computed(() => {
  if (!route.value?.maxParcels || route.value.maxParcels <= 0) return 0
  return Math.min(Math.round((route.value.totalParcels / route.value.maxParcels) * 100), 100)
})

async function handleReoptimize() {
  if (!route.value) return
  reoptimizing.value = true
  error.value = null
  successNotice.value = null

  const commandId = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `cmd-reopt-${Date.now()}`

  try {
    const res = await requestFetch<ReoptimizeDeliveryRouteResult>(
      `/api/admin/delivery-routes/${props.routeId}/reoptimize`,
      {
        method: 'POST',
        body: {
          expectedVersion: route.value.version,
          commandId,
          optimizationStrategy: strategy.value
        }
      }
    )

    if (res?.route) {
      route.value = res.route
      successNotice.value = 'Ruta recalculada: las paradas ya están en su nuevo orden'
      emit('changed', res.route)
    }
  } catch (err: unknown) {
    error.value = await explainFailure(err, 'No se ha podido recalcular la ruta de reparto. Vuelve a intentarlo.')
  } finally {
    reoptimizing.value = false
  }
}

const routeStatusLabel: Record<string, string> = {
  draft: 'Borrador',
  planned: 'Planificada',
  in_progress: 'En reparto',
  completed: 'Completada',
  cancelled: 'Cancelada'
}
const routeStatusTone: Record<string, AdminTone> = {
  planned: 'info',
  in_progress: 'info',
  completed: 'success'
}
const stopStatusLabel: Record<string, string> = {
  pending: 'Pendiente',
  in_progress: 'En camino',
  delivered: 'Entregada',
  failed: 'No entregada',
  skipped: 'Omitida',
  cancelled: 'Cancelada'
}
const stopStatusTone: Record<string, AdminTone> = {
  in_progress: 'info',
  delivered: 'success',
  failed: 'danger'
}
const capacityMeters = computed(() => {
  const current = route.value
  if (!current) return []
  return [
    {
      label: 'Peso',
      used: `${(current.totalWeightGrams / 1000).toFixed(1)} kg`,
      max: current.maxWeightGrams ? `${(current.maxWeightGrams / 1000).toFixed(0)} kg` : '—',
      percent: weightPercent.value
    },
    {
      label: 'Bultos',
      used: String(current.totalParcels),
      max: current.maxParcels ? String(current.maxParcels) : '—',
      percent: parcelPercent.value
    }
  ]
})
const stopsSummary = computed(() => {
  const count = route.value?.stops.length ?? 0
  return `${count} ${count === 1 ? 'parada' : 'paradas'}`
})

const editable = computed(
  () => route.value !== null && route.value.status !== 'completed' && route.value.status !== 'cancelled'
)

/* --- Añadir una parada --- */
const stopOpen = ref(false)
const stopSaving = ref(false)
const stopError = ref('')
const stopForm = reactive({
  recipientName: '',
  streetAddress: '',
  postalCode: '',
  city: '',
  parcelCount: 1,
  weightKg: 1,
  timeWindowStart: '',
  timeWindowEnd: ''
})
const stopProblem = computed(() => {
  if (!stopForm.recipientName.trim() || !stopForm.streetAddress.trim() || !stopForm.city.trim())
    return 'Indica el destinatario, la dirección y la población.'
  if (!/^\d{5}$/.test(stopForm.postalCode.trim())) return 'El código postal tiene 5 cifras.'
  if (!Number.isInteger(stopForm.parcelCount) || stopForm.parcelCount < 1) return 'Indica cuántos bultos se entregan.'
  if (!Number.isFinite(stopForm.weightKg) || stopForm.weightKg < 0) return 'Indica el peso en kilos.'
  if (Boolean(stopForm.timeWindowStart) !== Boolean(stopForm.timeWindowEnd))
    return 'Indica las dos horas de la franja de entrega, o déjalas vacías.'
  if (stopForm.timeWindowStart && stopForm.timeWindowEnd <= stopForm.timeWindowStart)
    return 'La franja de entrega tiene que terminar después de empezar.'
  return ''
})

function openStop() {
  Object.assign(stopForm, {
    recipientName: '',
    streetAddress: '',
    postalCode: '',
    city: '',
    parcelCount: 1,
    weightKg: 1,
    timeWindowStart: '',
    timeWindowEnd: ''
  })
  stopError.value = ''
  stopOpen.value = true
}

async function addStop() {
  if (!route.value || stopProblem.value || stopSaving.value) return
  stopSaving.value = true
  stopError.value = ''
  successNotice.value = null
  const commandId = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `cmd-stop-${Date.now()}`
  try {
    const res = await requestFetch<{ route: DeliveryRoute }>(`/api/admin/delivery-routes/${props.routeId}/stops`, {
      method: 'POST',
      body: {
        recipientName: stopForm.recipientName.trim(),
        streetAddress: stopForm.streetAddress.trim(),
        postalCode: stopForm.postalCode.trim(),
        city: stopForm.city.trim(),
        parcelCount: stopForm.parcelCount,
        weightGrams: Math.round(stopForm.weightKg * 1000),
        ...(stopForm.timeWindowStart
          ? { timeWindowStart: stopForm.timeWindowStart, timeWindowEnd: stopForm.timeWindowEnd }
          : {}),
        expectedVersion: route.value.version,
        commandId
      }
    })
    if (res?.route) {
      route.value = res.route
      emit('changed', res.route)
    }
    stopOpen.value = false
    successNotice.value = 'Parada añadida a la ruta'
  } catch (err: unknown) {
    const text = await explainFailure(err, 'No se ha podido añadir la parada. Vuelve a intentarlo.')
    if (text === null) stopOpen.value = false
    else stopError.value = text
  } finally {
    stopSaving.value = false
  }
}

onMounted(() => {
  void fetchRoute()
})
</script>

<template>
  <div class="adm-stack">
    <div v-if="loading" role="status" aria-live="polite" class="adm-card adm-table-skeleton" aria-busy="true">
      <span class="sr-only">Cargando planificación de ruta…</span>
      <div v-for="row in 4" :key="row"><i /><i /><i /></div>
    </div>

    <AdminCard v-else-if="!route">
      <AdminEmptyState
        v-if="missing"
        icon="i-lucide-map-pin-off"
        title="Esta ruta ya no existe"
        description="Puede que se haya eliminado o que el enlace sea antiguo. Vuelve al listado para elegir otra."
      >
        <AdminButton icon="i-lucide-list" @click="emit('gone')">Ver las rutas disponibles</AdminButton>
      </AdminEmptyState>
      <div v-else-if="error" role="alert">
        <AdminEmptyState
          compact
          variant="error"
          title="No se ha podido cargar la ruta de reparto"
          description="Puede ser un fallo puntual de conexión. Vuelve a intentarlo en unos segundos."
        >
          <AdminButton icon="i-lucide-rotate-cw" @click="fetchRoute()">Reintentar</AdminButton>
        </AdminEmptyState>
      </div>
      <AdminEmptyState
        v-else
        compact
        icon="i-lucide-map-pin"
        title="No hay ninguna ruta planificada"
        description="Cuando se planifique una ruta de reparto aparecerá aquí."
      />
    </AdminCard>

    <template v-else>
      <div class="adm-toolbar">
        <AdminBadge :tone="routeStatusTone[route.status] ?? 'neutral'">
          {{ routeStatusLabel[route.status] ?? adminStatusLabel(route.status) }}
        </AdminBadge>
        <span class="adm-help">
          {{ adminDate(route.routeDate) }} · Horario {{ route.windowStart }} - {{ route.windowEnd }}
        </span>
        <div class="adm-toolbar__end">
          <select v-model="strategy" class="adm-input" aria-label="Criterio para ordenar las paradas">
            <option value="window_priority">Priorizar la franja horaria</option>
            <option value="distance_priority">Priorizar zona y código postal</option>
          </select>
          <button
            type="button"
            data-test="reoptimize-btn"
            class="adm-btn adm-btn--primary"
            :disabled="reoptimizing || !editable"
            @click="handleReoptimize"
          >
            <span v-if="reoptimizing">Recalculando…</span>
            <span v-else>Recalcular ruta</span>
          </button>
        </div>
      </div>

      <UAlert v-if="error" role="alert" color="error" variant="subtle" :title="error" />
      <UAlert v-if="successNotice" role="status" color="success" variant="subtle" :title="successNotice" />

      <div class="adm-grid">
        <AdminStat
          label="Vehículo"
          icon="i-lucide-truck"
          :value="route.vehicle?.name || 'Sin asignar'"
          :hint="route.vehicle?.registrationPlate || undefined"
        />
        <AdminStat
          label="Conductor"
          icon="i-lucide-user"
          :value="route.driver?.name || 'Sin asignar'"
          :hint="route.driver?.phone || undefined"
        />
        <AdminCard data-test="capacity-meter" title="Ocupación del vehículo">
          <div class="space-y-3 text-[0.8125rem]">
            <div v-for="meter in capacityMeters" :key="meter.label">
              <div class="flex justify-between gap-2">
                <span class="font-semibold text-[var(--text-strong)]">{{ meter.label }}: {{ meter.used }}</span>
                <span class="text-[var(--text-muted)]">Máximo: {{ meter.max }}</span>
              </div>
              <div class="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface-sunken)]">
                <div class="h-full rounded-full bg-neteco-600" :style="{ width: `${meter.percent}%` }" />
              </div>
            </div>
          </div>
        </AdminCard>
      </div>

      <AdminCard flush title="Orden de las paradas" :description="stopsSummary">
        <template v-if="editable" #actions>
          <AdminButton size="sm" icon="i-lucide-plus" @click="openStop">Añadir parada</AdminButton>
        </template>
        <AdminEmptyState
          v-if="route.stops.length === 0"
          compact
          icon="i-lucide-map-pin"
          title="Esta ruta todavía no tiene paradas"
          :description="
            editable
              ? 'Añade las entregas del día y después pulsa «Recalcular ruta» para ordenarlas.'
              : 'La ruta se cerró sin entregas asignadas.'
          "
        >
          <AdminButton v-if="editable" icon="i-lucide-plus" @click="openStop">Añadir la primera parada</AdminButton>
        </AdminEmptyState>
        <ol v-else class="adm-list">
          <li v-for="(stop, index) in route.stops" :key="stop.id">
            <span class="adm-list__index">{{ index + 1 }}</span>
            <div class="min-w-0 flex-1">
              <p class="adm-list__title">{{ stop.recipientName }}</p>
              <p class="adm-help">{{ stop.streetAddress }}, {{ stop.postalCode }} {{ stop.city }}</p>
            </div>
            <span v-if="stop.timeWindowStart" class="adm-help">
              Entrega {{ stop.timeWindowStart }} - {{ stop.timeWindowEnd || '' }}
            </span>
            <span class="adm-help">
              {{ stop.parcelCount }} {{ stop.parcelCount === 1 ? 'bulto' : 'bultos' }} ·
              {{ (stop.weightGrams / 1000).toFixed(1) }} kg
            </span>
            <AdminBadge :tone="stopStatusTone[stop.status] ?? 'neutral'">
              {{ stopStatusLabel[stop.status] ?? adminStatusLabel(stop.status) }}
            </AdminBadge>
          </li>
        </ol>
      </AdminCard>
    </template>

    <AdminDrawer
      v-model:open="stopOpen"
      title="Añadir una parada"
      description="Una parada es una entrega de la ruta. El orden se decide al recalcular la ruta."
    >
      <form id="route-stop-form" class="adm-stack" @submit.prevent="addStop">
        <UAlert v-if="stopError" role="alert" color="error" variant="subtle" :title="stopError" />
        <AdminFormField v-slot="{ id }" label="Destinatario" required>
          <input :id="id" v-model="stopForm.recipientName" type="text" class="adm-input" maxlength="100" required />
        </AdminFormField>
        <AdminFormField v-slot="{ id }" label="Dirección" required>
          <input :id="id" v-model="stopForm.streetAddress" type="text" class="adm-input" maxlength="200" required />
        </AdminFormField>
        <div class="adm-form-grid">
          <AdminFormField v-slot="{ id }" label="Código postal" required>
            <input
              :id="id"
              v-model="stopForm.postalCode"
              type="text"
              inputmode="numeric"
              class="adm-input"
              maxlength="5"
              required
            />
          </AdminFormField>
          <AdminFormField v-slot="{ id }" label="Población" required>
            <input :id="id" v-model="stopForm.city" type="text" class="adm-input" maxlength="100" required />
          </AdminFormField>
        </div>
        <div class="adm-form-grid">
          <AdminFormField v-slot="{ id }" label="Bultos" required>
            <input :id="id" v-model.number="stopForm.parcelCount" type="number" min="1" step="1" class="adm-input" />
          </AdminFormField>
          <AdminFormField v-slot="{ id }" label="Peso (kg)" required>
            <input :id="id" v-model.number="stopForm.weightKg" type="number" min="0" step="0.1" class="adm-input" />
          </AdminFormField>
        </div>
        <div class="adm-form-grid">
          <AdminFormField v-slot="{ id }" label="Entregar desde las" help="Opcional.">
            <input :id="id" v-model="stopForm.timeWindowStart" type="time" class="adm-input" />
          </AdminFormField>
          <AdminFormField v-slot="{ id }" label="Entregar hasta las" help="Opcional.">
            <input :id="id" v-model="stopForm.timeWindowEnd" type="time" class="adm-input" />
          </AdminFormField>
        </div>
        <p v-if="stopProblem" class="adm-help">{{ stopProblem }}</p>
      </form>
      <template #footer>
        <AdminButton @click="stopOpen = false">Cancelar</AdminButton>
        <AdminButton
          variant="primary"
          type="submit"
          form="route-stop-form"
          :loading="stopSaving"
          :disabled="Boolean(stopProblem)"
        >
          Añadir parada
        </AdminButton>
      </template>
    </AdminDrawer>
  </div>
</template>
