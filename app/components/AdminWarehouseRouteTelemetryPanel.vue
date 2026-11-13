<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { WarehouseTelemetryAggregate, WarehouseDeviceTelemetry } from '~~/shared/warehouse-route-telemetry'

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
  return code ? `${fallback}. Vuelve a intentarlo.` : fallback
}
const deviceStatusLabels: Record<string, string> = {
  online: 'Conectado',
  degraded: 'Con incidencias',
  offline: 'Sin conexión'
}
const deviceStatusTones: Record<string, 'success' | 'warning' | 'danger'> = {
  online: 'success',
  degraded: 'warning',
  offline: 'danger'
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
    errorMessage.value = errorText(error, 'No se han podido cargar los datos del almacén')
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
    notice.value = 'Resumen del turno calculado.'
  } catch (error) {
    errorMessage.value = errorText(error, 'No se ha podido calcular el resumen')
  } finally {
    busy.value = false
  }
}

onMounted(() => {
  loadData()
})
</script>

<template>
  <div class="adm-stack">
    <AdminPageActions>
      <button type="button" class="adm-btn adm-btn--primary" :disabled="busy" @click="computeAggregates">
        Calcular resumen
      </button>
    </AdminPageActions>

    <UAlert v-if="notice" role="status" color="success" variant="subtle" icon="i-lucide-circle-check" :title="notice" />
    <UAlert
      v-if="errorMessage"
      role="alert"
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="errorMessage"
      data-error
    >
      <template #description>
        <button type="button" class="underline" @click="loadData">Reintentar</button>
      </template>
    </UAlert>

    <div class="adm-toolbar">
      <label class="sr-only" for="wh-telemetry-date">Día</label>
      <input id="wh-telemetry-date" v-model="selectedDate" type="date" @change="loadData" />
      <label class="sr-only" for="wh-telemetry-shift">Turno</label>
      <select id="wh-telemetry-shift" v-model="selectedShift" @change="loadData">
        <option value="morning">Turno de mañana</option>
        <option value="afternoon">Turno de tarde</option>
        <option value="night">Turno de noche</option>
        <option value="all_day">Jornada completa</option>
      </select>
      <label class="sr-only" for="wh-telemetry-zone">Zona</label>
      <select id="wh-telemetry-zone" v-model="selectedZone" @change="loadData">
        <option value="chemicals_bulk">Químicos a granel</option>
        <option value="picking_flow">Preparación de pedidos</option>
        <option value="packing_dock">Muelle de embalaje</option>
        <option value="fleet_transit">Vehículos en ruta</option>
        <option value="all_warehouse">Todo el almacén</option>
      </select>
    </div>

    <div v-if="loading" data-loading class="adm-table-skeleton" aria-busy="true">
      <span class="sr-only">Cargando datos del almacén…</span>
      <div v-for="row in 3" :key="row"><i /><i /><i /><i /></div>
    </div>

    <div v-else-if="aggregate" class="adm-grid">
      <AdminStat
        label="Ritmo de preparación"
        :value="`${aggregate.avgPickRatePerHour} líneas/h`"
        hint="Líneas de pedido por hora"
      />
      <AdminStat
        label="Errores de preparación"
        :value="`${(aggregate.pickErrorRateBasisPoints / 100).toFixed(2)} %`"
        :hint="aggregate.pickErrorRateBasisPoints > 50 ? 'Por encima de lo habitual' : 'Dentro de lo habitual'"
      />
      <AdminStat
        label="De la recepción a la estantería"
        :value="`${aggregate.dockToStockMinutes} min`"
        hint="Tiempo hasta ubicar la mercancía"
      />
      <AdminStat
        label="Embalaje"
        :value="`${aggregate.packingParcelsPerHour} bultos/h`"
        hint="Ritmo de las mesas de embalaje"
      />
      <AdminStat
        label="Entregas a tiempo"
        :value="`${(aggregate.onTimeDeliveryRatio * 100).toFixed(1)} %`"
        hint="Dentro de la franja acordada"
      />
      <AdminStat label="Daños y mermas" :value="aggregate.damagesCount" hint="Incidencias de producto" />
      <AdminStat
        label="Ocupación"
        :value="`${aggregate.warehouseCapacityPercent} %`"
        :hint="`Almacén · vehículos al ${aggregate.vehicleCapacityPercent} %`"
      />
      <AdminStat
        label="Dispositivos en buen estado"
        :value="`${(aggregate.healthyDevicesRatio * 100).toFixed(0)} %`"
        hint="Lectores y tabletas"
      />
    </div>

    <div v-else data-empty-aggregate>
      <AdminEmptyState
        title="No hay resumen para este día y turno"
        description="Pulsa «Calcular resumen» para prepararlo con la actividad registrada."
        icon="i-lucide-warehouse"
      />
    </div>

    <AdminCard title="Dispositivos del almacén y de reparto" :description="`${devices.length} dispositivos`" flush>
      <div v-if="devices.length === 0" data-empty-devices>
        <AdminEmptyState compact title="Ningún dispositivo ha dado señal últimamente" icon="i-lucide-smartphone" />
      </div>
      <div v-else class="adm-table-wrap">
        <table class="adm-table">
          <thead>
            <tr>
              <th scope="col">Dispositivo</th>
              <th scope="col">Tipo</th>
              <th scope="col" data-numeric>Batería</th>
              <th scope="col">Versión de la aplicación</th>
              <th scope="col" data-numeric>Retraso de sincronización</th>
              <th scope="col">Estado</th>
              <th scope="col">Última señal</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="dev in devices" :key="dev.deviceId">
              <td class="font-semibold text-[var(--text-strong)]">{{ dev.deviceId }}</td>
              <td>{{ adminHumanize(String(dev.deviceType)) }}</td>
              <td data-numeric :class="dev.batteryPercent < 20 && 'font-semibold text-red-700'">
                {{ dev.batteryPercent }} %
              </td>
              <td>{{ dev.appVersion }}</td>
              <td data-numeric>{{ dev.syncLatencyMs }} ms</td>
              <td>
                <AdminBadge :tone="deviceStatusTones[dev.status] ?? 'neutral'">
                  {{ deviceStatusLabels[dev.status] ?? adminHumanize(String(dev.status)) }}
                </AdminBadge>
              </td>
              <td>{{ adminDate(dev.lastHeartbeatAt, true) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </AdminCard>

    <p data-labor-privacy-notice class="adm-help">
      <strong>Privacidad del personal:</strong> estos datos son de conjunto y no se usan con fines disciplinarios
      (artículo 20 bis del Estatuto de los Trabajadores y artículos 89 y 90 de la LOPDGDD). No se guarda ni se muestra
      el nombre de ningún operario.
    </p>
  </div>
</template>
