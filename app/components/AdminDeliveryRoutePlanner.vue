<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import type { DeliveryRoute, ReoptimizeDeliveryRouteResult } from '~~/shared/delivery-route-planning'

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
      'Error al reoptimizar la ruta de reparto.'
  } finally {
    reoptimizing.value = false
  }
}

onMounted(() => {
  void fetchRoute()
})
</script>

<template>
  <div class="space-y-6 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
    <!-- Header -->
    <div class="flex flex-col gap-4 border-b border-slate-100 pb-4 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <div class="flex items-center space-x-2">
          <h3 class="text-lg font-semibold text-slate-900">Planificación de Ruta Propia</h3>
          <span
            v-if="route"
            class="rounded px-2 py-0.5 text-xs font-medium uppercase"
            :class="
              route.status === 'completed'
                ? 'bg-emerald-100 text-emerald-800'
                : route.status === 'in_progress'
                  ? 'bg-blue-100 text-blue-800'
                  : 'bg-slate-100 text-slate-800'
            "
          >
            {{ route.status }}
          </span>
        </div>
        <p v-if="route" class="text-xs text-slate-500">
          Fecha: {{ route.routeDate }} · Ventana: {{ route.windowStart }} - {{ route.windowEnd }}
        </p>
      </div>

      <!-- Action Button -->
      <div v-if="route" class="flex items-center space-x-2">
        <select
          v-model="strategy"
          class="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs shadow-sm focus:border-neteco-500 focus:outline-none"
        >
          <option value="window_priority">Priorizar ventana horaria</option>
          <option value="distance_priority">Priorizar zona y código postal</option>
        </select>

        <button
          type="button"
          data-test="reoptimize-btn"
          :disabled="reoptimizing || route.status === 'completed' || route.status === 'cancelled'"
          class="inline-flex items-center rounded-lg bg-neteco-600 px-3.5 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-neteco-700 focus:outline-none focus:ring-2 focus:ring-neteco-500 disabled:opacity-50"
          @click="handleReoptimize"
        >
          <span v-if="reoptimizing">Reoptimizando...</span>
          <span v-else>Reoptimizar ruta</span>
        </button>
      </div>
    </div>

    <!-- Loading State -->
    <div
      v-if="loading"
      role="status"
      aria-live="polite"
      class="flex items-center justify-center p-8 text-sm text-slate-500"
    >
      <svg
        class="mr-2 h-5 w-5 animate-spin text-slate-400"
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
      >
        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
        <path
          class="opacity-75"
          fill="currentColor"
          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
        ></path>
      </svg>
      Cargando planificación de ruta...
    </div>

    <!-- Error State -->
    <div v-else-if="error" role="alert" class="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
      {{ error }}
    </div>

    <div v-else-if="route" class="space-y-6">
      <!-- Success Notice -->
      <div
        v-if="successNotice"
        role="status"
        class="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800"
      >
        {{ successNotice }}
      </div>

      <!-- Resources & Capacity Grid -->
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <!-- Vehicle -->
        <div class="rounded-lg border border-slate-100 bg-slate-50 p-3">
          <span class="text-[11px] font-medium uppercase text-slate-400">Vehículo</span>
          <div class="mt-1 font-medium text-slate-900">
            {{ route.vehicle?.name || 'No asignado' }}
          </div>
          <div class="text-xs text-slate-500">
            {{ route.vehicle?.registrationPlate || '—' }}
          </div>
        </div>

        <!-- Driver -->
        <div class="rounded-lg border border-slate-100 bg-slate-50 p-3">
          <span class="text-[11px] font-medium uppercase text-slate-400">Conductor</span>
          <div class="mt-1 font-medium text-slate-900">
            {{ route.driver?.name || 'No asignado' }}
          </div>
          <div class="text-xs text-slate-500">
            {{ route.driver?.phone || '—' }}
          </div>
        </div>

        <!-- Capacity Meter -->
        <div data-test="capacity-meter" class="rounded-lg border border-slate-100 bg-slate-50 p-3">
          <span class="text-[11px] font-medium uppercase text-slate-400">Ocupación y Capacidad</span>
          <div class="mt-2 space-y-1.5 text-xs">
            <div>
              <div class="flex justify-between text-slate-600">
                <span>Peso: {{ (route.totalWeightGrams / 1000).toFixed(1) }} kg</span>
                <span>Max: {{ route.maxWeightGrams ? (route.maxWeightGrams / 1000).toFixed(0) + ' kg' : '—' }}</span>
              </div>
              <div class="h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
                <div
                  class="h-full bg-neteco-600 transition-all duration-300"
                  :style="{ width: `${weightPercent}%` }"
                ></div>
              </div>
            </div>

            <div>
              <div class="flex justify-between text-slate-600">
                <span>Bultos: {{ route.totalParcels }}</span>
                <span>Max: {{ route.maxParcels || '—' }}</span>
              </div>
              <div class="h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
                <div
                  class="h-full bg-blue-600 transition-all duration-300"
                  :style="{ width: `${parcelPercent}%` }"
                ></div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Stops Sequence List -->
      <div>
        <div class="mb-3 flex items-center justify-between">
          <h4 class="text-sm font-semibold text-slate-900">Secuencia de paradas ({{ route.stops.length }})</h4>
          <span class="text-xs text-slate-400">Versión: {{ route.version }}</span>
        </div>

        <div
          v-if="route.stops.length === 0"
          class="rounded-lg border border-dashed border-slate-200 p-8 text-center text-sm text-slate-500"
        >
          No hay paradas asignadas a esta ruta.
        </div>

        <ol v-else class="space-y-2">
          <li
            v-for="(stop, index) in route.stops"
            :key="stop.id"
            class="flex items-center justify-between rounded-lg border border-slate-200 bg-white p-3 shadow-xs hover:border-slate-300"
          >
            <div class="flex items-center space-x-3">
              <span
                class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-bold text-slate-700"
              >
                {{ index + 1 }}
              </span>

              <div>
                <div class="font-medium text-slate-900 text-sm">
                  {{ stop.recipientName }}
                </div>
                <div class="text-xs text-slate-500">
                  {{ stop.streetAddress }}, {{ stop.postalCode }} {{ stop.city }}
                </div>
              </div>
            </div>

            <div class="flex items-center space-x-4 text-xs text-slate-600">
              <div v-if="stop.timeWindowStart" class="rounded bg-slate-50 px-2 py-1">
                Ventana: {{ stop.timeWindowStart }} - {{ stop.timeWindowEnd || '' }}
              </div>
              <div>{{ stop.parcelCount }} bulto(s) · {{ (stop.weightGrams / 1000).toFixed(1) }} kg</div>
              <span
                class="rounded px-2 py-0.5 text-[11px] font-medium"
                :class="
                  stop.status === 'delivered'
                    ? 'bg-emerald-100 text-emerald-800'
                    : stop.status === 'failed'
                      ? 'bg-red-100 text-red-800'
                      : 'bg-slate-100 text-slate-700'
                "
              >
                {{ stop.status }}
              </span>
            </div>
          </li>
        </ol>
      </div>
    </div>
  </div>
</template>
