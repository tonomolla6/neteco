<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { WarehouseTelemetryAggregate, WarehouseDeviceTelemetry } from '../../shared/warehouse-route-telemetry'

const requestFetch = useRequestFetch()
const loading = ref(true)
const busy = ref(false)
const errorMessage = ref('')
const notice = ref('')

const aggregate = ref<WarehouseTelemetryAggregate | null>(null)
const devices = ref<WarehouseDeviceTelemetry[]>([])

// Query filters
const selectedDate = ref('2026-10-29')
const selectedShift = ref('morning')
const selectedZone = ref('chemicals_bulk')

function errorText(error: unknown, fallback: string): string {
  const code = (error as { data?: { error?: { code?: string } } })?.data?.error?.code
  return code ? `${fallback} (${code})` : fallback
}

async function loadData() {
  loading.value = true
  errorMessage.value = ''
  try {
    const [aggRes, devRes] = await Promise.all([
      requestFetch(
        `/api/admin/observability/telemetry/aggregates?periodDate=${selectedDate.value}&shiftCode=${selectedShift.value}&zoneCode=${selectedZone.value}`
      ) as Promise<{ aggregate: WarehouseTelemetryAggregate | null }>,
      requestFetch('/api/admin/observability/telemetry/devices') as Promise<{ devices: WarehouseDeviceTelemetry[] }>
    ])
    aggregate.value = aggRes?.aggregate ?? null
    devices.value = devRes?.devices ?? []
  } catch (error) {
    errorMessage.value = errorText(error, 'Error al cargar los datos de telemetría')
  } finally {
    loading.value = false
  }
}

async function computeAggregates() {
  busy.value = true
  errorMessage.value = ''
  try {
    const res = (await requestFetch('/api/admin/observability/telemetry/compute', {
      method: 'POST',
      body: {
        commandId: crypto.randomUUID(),
        idempotencyKey: `compute-${selectedDate.value}-${selectedShift.value}-${selectedZone.value}`,
        periodDate: selectedDate.value,
        shiftCode: selectedShift.value,
        zoneCode: selectedZone.value
      }
    })) as { aggregate: WarehouseTelemetryAggregate }
    aggregate.value = res.aggregate
    notice.value = 'Métricas agregadas del turno calculadas con éxito.'
  } catch (error) {
    errorMessage.value = errorText(error, 'Error al computar los agregados de telemetría')
  } finally {
    busy.value = false
  }
}

onMounted(() => {
  loadData()
})
</script>

<template>
  <div class="space-y-6">
    <!-- Mandatory Labor Privacy Notice -->
    <div
      data-labor-privacy-notice
      class="rounded-xl border border-sky-200 bg-sky-50/70 p-4 text-sm text-sky-900 shadow-sm flex items-start gap-3"
    >
      <div class="shrink-0 mt-0.5">
        <span
          class="inline-flex h-6 w-6 items-center justify-center rounded-full bg-sky-600 text-white font-bold text-xs"
        >
          §
        </span>
      </div>
      <div class="space-y-1">
        <h4 class="font-bold text-sky-950">Garantía de Privacidad Laboral y Protección de Datos (Art. 20 bis ET)</h4>
        <p class="text-xs text-sky-800">
          En cumplimiento del <strong>artículo 20 bis del Estatuto de los Trabajadores</strong> y arts. 89-90 de la
          <strong>LOPDGDD</strong>, esta telemetría almacena métricas operativas colectivas sin fines disciplinarios
          directos. Los identificadores de operarios están pseudonimizados irreversiblemente mediante resúmenes SHA-256
          con sal interna, impidiendo la exposición de nombres personales en cuadros de mando.
        </p>
      </div>
    </div>

    <!-- Header & Shift Selector -->
    <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
      <div>
        <h2 class="text-lg font-bold text-neutral-900">Telemetría de Almacén y Rutas (OBS-029)</h2>
        <p class="text-sm text-neutral-600">
          Monitorización de las 8 facetas operativas: Pick rate, dock-to-stock, packing, puntualidad en ruta, mermas,
          capacidad y salud de terminales.
        </p>
      </div>

      <div class="flex items-center gap-2">
        <input
          v-model="selectedDate"
          type="date"
          class="rounded border-neutral-300 p-1.5 text-sm border"
          @change="loadData"
        />
        <select v-model="selectedShift" class="rounded border-neutral-300 p-1.5 text-sm border" @change="loadData">
          <option value="morning">Turno Mañana</option>
          <option value="afternoon">Turno Tarde</option>
          <option value="night">Turno Noche</option>
          <option value="all_day">Jornada Completa</option>
        </select>
        <select v-model="selectedZone" class="rounded border-neutral-300 p-1.5 text-sm border" @change="loadData">
          <option value="chemicals_bulk">Químicos Granel</option>
          <option value="picking_flow">Flujo de Picking</option>
          <option value="packing_dock">Muelle Empaquetado</option>
          <option value="fleet_transit">Tránsito Flota</option>
          <option value="all_warehouse">Todo el Almacén</option>
        </select>
        <button
          class="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-neutral-800 disabled:opacity-50"
          :disabled="busy"
          @click="computeAggregates"
        >
          Calcular Agregados
        </button>
      </div>
    </div>

    <!-- Notices -->
    <div v-if="notice" class="rounded-md bg-emerald-50 p-4 text-sm text-emerald-800 border border-emerald-200">
      {{ notice }}
    </div>
    <div
      v-if="errorMessage"
      data-error
      class="rounded-md bg-rose-50 p-4 text-sm text-rose-800 border border-rose-200 flex items-center justify-between"
    >
      <span>{{ errorMessage }}</span>
      <button class="underline font-semibold" @click="loadData">Reintentar</button>
    </div>

    <!-- Loading State -->
    <div v-if="loading" data-loading class="py-12 text-center text-sm text-neutral-500">
      Cargando métricas de telemetría...
    </div>

    <!-- 8 Facets Cards -->
    <div v-else-if="aggregate" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      <!-- 1. Pick Rate -->
      <div class="rounded-xl border border-neutral-200 bg-white p-4 shadow-sm">
        <span class="text-xs font-semibold text-neutral-500 uppercase tracking-wider">1. Pick Rate Medio</span>
        <div class="mt-1 text-2xl font-bold text-neutral-900">{{ aggregate.avgPickRatePerHour }} u/h</div>
        <p class="text-xs text-neutral-500 mt-1">Líneas de pedido por hora</p>
      </div>

      <!-- 2. Pick Error Rate -->
      <div class="rounded-xl border border-neutral-200 bg-white p-4 shadow-sm">
        <span class="text-xs font-semibold text-neutral-500 uppercase tracking-wider">2. Error en Picking</span>
        <div
          class="mt-1 text-2xl font-bold"
          :class="aggregate.pickErrorRateBasisPoints > 50 ? 'text-rose-600' : 'text-neutral-900'"
        >
          {{ aggregate.pickErrorRateBasisPoints }} bp
        </div>
        <p class="text-xs text-neutral-500 mt-1">
          {{ (aggregate.pickErrorRateBasisPoints / 100).toFixed(2) }}% de error
        </p>
      </div>

      <!-- 3. Dock to Stock -->
      <div class="rounded-xl border border-neutral-200 bg-white p-4 shadow-sm">
        <span class="text-xs font-semibold text-neutral-500 uppercase tracking-wider">3. Dock to Stock</span>
        <div class="mt-1 text-2xl font-bold text-neutral-900">{{ aggregate.dockToStockMinutes }} min</div>
        <p class="text-xs text-neutral-500 mt-1">Recepción hasta ubicación</p>
      </div>

      <!-- 4. Packing Rate -->
      <div class="rounded-xl border border-neutral-200 bg-white p-4 shadow-sm">
        <span class="text-xs font-semibold text-neutral-500 uppercase tracking-wider">4. Empaquetado</span>
        <div class="mt-1 text-2xl font-bold text-neutral-900">{{ aggregate.packingParcelsPerHour }} bultos/h</div>
        <p class="text-xs text-neutral-500 mt-1">Ritmo mesas de embalaje</p>
      </div>

      <!-- 5. On-Time Delivery -->
      <div class="rounded-xl border border-neutral-200 bg-white p-4 shadow-sm">
        <span class="text-xs font-semibold text-neutral-500 uppercase tracking-wider">5. Puntualidad Rutas (OTD)</span>
        <div class="mt-1 text-2xl font-bold text-emerald-600">
          {{ (aggregate.onTimeDeliveryRatio * 100).toFixed(1) }}%
        </div>
        <p class="text-xs text-neutral-500 mt-1">Entregas dentro de ventana</p>
      </div>

      <!-- 6. Damages Count -->
      <div class="rounded-xl border border-neutral-200 bg-white p-4 shadow-sm">
        <span class="text-xs font-semibold text-neutral-500 uppercase tracking-wider">6. Daños / Mermas</span>
        <div
          class="mt-1 text-2xl font-bold"
          :class="aggregate.damagesCount > 0 ? 'text-amber-600' : 'text-neutral-900'"
        >
          {{ aggregate.damagesCount }}
        </div>
        <p class="text-xs text-neutral-500 mt-1">Incidencias de producto</p>
      </div>

      <!-- 7. Capacities (Warehouse & Vehicle) -->
      <div class="rounded-xl border border-neutral-200 bg-white p-4 shadow-sm">
        <span class="text-xs font-semibold text-neutral-500 uppercase tracking-wider">7. Capacidad Ocupada</span>
        <div class="mt-1 text-lg font-bold text-neutral-900">Almacén: {{ aggregate.warehouseCapacityPercent }}%</div>
        <div class="text-lg font-bold text-neutral-900">Vehículos: {{ aggregate.vehicleCapacityPercent }}%</div>
      </div>

      <!-- 8. Healthy Devices Ratio -->
      <div class="rounded-xl border border-neutral-200 bg-white p-4 shadow-sm">
        <span class="text-xs font-semibold text-neutral-500 uppercase tracking-wider">8. Dispositivos Operativos</span>
        <div class="mt-1 text-2xl font-bold text-neutral-900">
          {{ (aggregate.healthyDevicesRatio * 100).toFixed(0) }}%
        </div>
        <p class="text-xs text-neutral-500 mt-1">Terminales RF y tablets saludables</p>
      </div>
    </div>

    <!-- Empty State for Aggregates -->
    <div
      v-else
      data-empty-aggregate
      class="rounded-lg border-2 border-dashed border-neutral-200 p-8 text-center text-sm text-neutral-500"
    >
      No hay métricas consolidadas para la fecha y turno seleccionados. Pulsa «Calcular Agregados» para procesar los
      eventos de telemetría.
    </div>

    <!-- Devices Fleet Table -->
    <div class="rounded-xl border border-neutral-200 bg-white p-6 shadow-sm space-y-4">
      <div class="flex items-center justify-between">
        <h3 class="text-base font-bold text-neutral-900">Parque de Dispositivos de Almacén y Rutas</h3>
        <span class="text-xs text-neutral-500">{{ devices.length }} dispositivos monitorizados</span>
      </div>

      <div v-if="devices.length === 0" data-empty-devices class="py-6 text-center text-sm text-neutral-500">
        No se han recibido latidos (heartbeats) de terminales móviles recientemente.
      </div>
      <div v-else class="overflow-x-auto">
        <table class="min-w-full divide-y divide-neutral-200 text-sm">
          <thead>
            <tr class="text-left text-xs font-semibold text-neutral-500 uppercase">
              <th class="py-2">Dispositivo</th>
              <th class="py-2">Tipo</th>
              <th class="py-2">Batería</th>
              <th class="py-2">Versión App</th>
              <th class="py-2">Latencia Sincro</th>
              <th class="py-2">Estado</th>
              <th class="py-2">Último Latido</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-neutral-100">
            <tr v-for="dev in devices" :key="dev.deviceId">
              <td class="py-2 font-mono text-xs font-semibold text-neutral-900">{{ dev.deviceId }}</td>
              <td class="py-2 text-xs uppercase">{{ dev.deviceType }}</td>
              <td class="py-2 font-medium" :class="dev.batteryPercent < 20 ? 'text-rose-600' : 'text-neutral-800'">
                {{ dev.batteryPercent }}%
              </td>
              <td class="py-2 text-xs font-mono">{{ dev.appVersion }}</td>
              <td class="py-2 text-xs">{{ dev.syncLatencyMs }} ms</td>
              <td class="py-2">
                <span
                  class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold"
                  :class="{
                    'bg-emerald-100 text-emerald-800': dev.status === 'online',
                    'bg-amber-100 text-amber-800': dev.status === 'degraded',
                    'bg-rose-100 text-rose-800': dev.status === 'offline'
                  }"
                >
                  {{ dev.status }}
                </span>
              </td>
              <td class="py-2 font-mono text-xs text-neutral-500">{{ dev.lastHeartbeatAt }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
