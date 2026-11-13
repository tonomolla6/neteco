<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import type { DeliveryRoute, ReoptimizeDeliveryRouteResult } from '~~/shared/delivery-route-planning'
import type { AdminTone } from '~/utils/adminLabels'

const props = defineProps<{
  routeId: string
}>()

const requestFetch = useRequestFetch()

const loading = ref(true)
const reoptimizing = ref(false)
const error = ref<string | null>(null)
const successNotice = ref<string | null>(null)
const route = ref<DeliveryRoute | null>(null)
const strategy = ref<'window_priority' | 'distance_priority'>('window_priority')

async function fetchRoute() {
  loading.value = true
  error.value = null
  try {
    const res = await requestFetch<{ route: DeliveryRoute }>(`/api/admin/delivery-routes/${props.routeId}`)
    route.value = res.route
  } catch {
    error.value = 'No se ha podido cargar la ruta de reparto.'
  } finally {
    loading.value = false
  }
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
      successNotice.value = 'Ruta reoptimizada correctamente'
    }
  } catch (err: unknown) {
    const errorObject = err && typeof err === 'object' ? (err as Record<string, unknown>) : null
    const errorData =
      errorObject?.data && typeof errorObject.data === 'object' ? (errorObject.data as Record<string, unknown>) : null
    const nestedError =
      errorData?.error && typeof errorData.error === 'object' ? (errorData.error as Record<string, unknown>) : null
    error.value =
      (typeof nestedError?.message === 'string' ? nestedError.message : null) ||
      'No se ha podido recalcular la ruta de reparto. Vuelve a intentarlo.'
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

onMounted(() => {
  void fetchRoute()
})
</script>

<template>
  <div class="adm-stack">
    <div v-if="loading" role="status" aria-live="polite" class="adm-help">Cargando planificación de ruta…</div>

    <AdminCard v-else-if="!route">
      <div v-if="error" role="alert">
        <AdminEmptyState
          compact
          variant="error"
          title="No se ha podido cargar la ruta de reparto"
          description="Vuelve a intentarlo en unos segundos."
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
            :disabled="reoptimizing || route.status === 'completed' || route.status === 'cancelled'"
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
        <AdminEmptyState
          v-if="route.stops.length === 0"
          compact
          icon="i-lucide-map-pin"
          title="No hay paradas asignadas a esta ruta"
        />
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
  </div>
</template>
