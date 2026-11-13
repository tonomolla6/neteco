<script setup lang="ts">
import { ref, watch, onMounted } from 'vue'
import type { CarrierScorecardReport } from '../../workers/fulfillment/carrier-scorecard'

defineProps<{
  runtime?: unknown
}>()

const requestFetch = useRequestFetch()

const loading = ref(true)
const error = ref<string | null>(null)
const data = ref<CarrierScorecardReport | null>(null)

// Default range: last 30 days
const now = new Date()
const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000)

const fromDate = ref(thirtyDaysAgo.toISOString().slice(0, 10))
const toDate = ref(now.toISOString().slice(0, 10))
const selectedCarrier = ref('all')
const preset = ref('30')
const presetOptions = [
  { value: '7', label: '7 días' },
  { value: '30', label: '30 días' },
  { value: '90', label: '90 días' }
]
type CarrierRow = CarrierScorecardReport['carriers'][number]
const columns = [
  { key: 'carrierName', label: 'Transportista', sortable: true },
  { key: 'service', label: 'Servicio', hideOnMobile: true },
  { key: 'totalShipments', label: 'Envíos', numeric: true, sortable: true },
  { key: 'onTimeRate', label: 'A tiempo', numeric: true, sortable: true },
  { key: 'firstAttemptRate', label: 'Primer intento', numeric: true, sortable: true },
  { key: 'incidentRate', label: 'Incidencias', numeric: true, sortable: true },
  { key: 'damageRate', label: 'Daños', numeric: true, sortable: true, hideOnMobile: true },
  { key: 'averageCostCents', label: 'Coste medio', numeric: true, sortable: true },
  { key: 'averageResolutionTimeHours', label: 'Resolución', numeric: true, sortable: true, hideOnMobile: true }
]

async function fetchScorecard() {
  loading.value = true
  error.value = null

  try {
    const fromIso = `${fromDate.value}T00:00:00Z`
    const toIso = `${toDate.value}T23:59:59Z`

    const response = await requestFetch<CarrierScorecardReport>('/api/admin/carriers/scorecard', {
      method: 'GET',
      query: {
        from: fromIso,
        to: toIso,
        carrier: selectedCarrier.value
      }
    })

    data.value = response
  } catch {
    error.value = 'Comprueba que tu usuario tiene permiso para ver los envíos y vuelve a intentarlo.'
  } finally {
    loading.value = false
  }
}

function setPreset(days: number) {
  const end = new Date()
  const start = new Date(end.getTime() - days * 86400000)
  fromDate.value = start.toISOString().slice(0, 10)
  toDate.value = end.toISOString().slice(0, 10)
  void fetchScorecard()
}

watch(preset, (value) => {
  if (value) setPreset(Number(value))
})
function onDateChange() {
  preset.value = ''
  void fetchScorecard()
}

function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—'
  return `${(value * 100).toFixed(1)}%`
}

function formatEuros(cents: number | null): string {
  if (cents === null || !Number.isFinite(cents)) return '—'
  return (cents / 100).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €'
}

function formatHours(hours: number | null): string {
  if (hours === null || !Number.isFinite(hours)) return '—'
  return `${hours.toFixed(1)} h`
}

onMounted(() => {
  void fetchScorecard()
})
</script>

<template>
  <div class="adm-stack">
    <div class="adm-toolbar" role="search" aria-label="Filtros de envíos">
      <AdminFilters v-model="preset" :options="presetOptions" label="Periodo" />
      <label class="flex items-center gap-2">
        <span class="adm-help">Desde</span>
        <input id="filter-from" v-model="fromDate" type="date" class="adm-input w-auto" @change="onDateChange" />
      </label>
      <label class="flex items-center gap-2">
        <span class="adm-help">Hasta</span>
        <input id="filter-to" v-model="toDate" type="date" class="adm-input w-auto" @change="onDateChange" />
      </label>
      <label>
        <span class="sr-only">Transportista</span>
        <select
          id="filter-carrier"
          v-model="selectedCarrier"
          data-filter="carrier"
          class="adm-input w-auto"
          @change="fetchScorecard"
        >
          <option value="all">Todos los transportistas</option>
          <option value="correos_express">Correos Express</option>
          <option value="gls">GLS Spain</option>
          <option value="dhl">DHL Parcel</option>
          <option value="seur">SEUR</option>
          <option value="own_delivery">Reparto propio</option>
        </select>
      </label>
      <div class="adm-toolbar__end">
        <button
          type="button"
          data-action="apply-filters"
          class="adm-btn adm-btn--secondary"
          :disabled="loading"
          @click="fetchScorecard"
        >
          <UIcon name="i-lucide-rotate-cw" class="size-4" />Actualizar
        </button>
      </div>
    </div>

    <div v-if="loading && !data" class="adm-grid" aria-busy="true">
      <span class="sr-only">Cargando datos de transportistas…</span>
      <div
        v-for="row in 6"
        :key="row"
        class="h-28 animate-pulse rounded-[var(--radius-surface)] bg-[var(--surface-sunken)]"
      />
    </div>

    <AdminCard v-else-if="error">
      <AdminEmptyState variant="error" title="No hemos podido cargar los datos de transportistas" :description="error">
        <AdminButton icon="i-lucide-rotate-cw" @click="fetchScorecard">Reintentar</AdminButton>
      </AdminEmptyState>
    </AdminCard>

    <AdminCard v-else-if="!data || data.summary.totalShipments === 0">
      <AdminEmptyState
        icon="i-lucide-truck"
        title="Sin envíos registrados"
        description="No hay datos de envíos en el periodo seleccionado. Prueba con otro intervalo o transportista."
      />
    </AdminCard>

    <template v-else>
      <div class="adm-grid" :aria-busy="loading">
        <AdminStat
          label="Envíos"
          icon="i-lucide-package"
          :value="data.summary.totalShipments"
          :hint="`${data.summary.deliveredShipments} entregados`"
        />
        <AdminStat
          label="Entregas a tiempo"
          icon="i-lucide-clock"
          :value="formatPercent(data.summary.onTimeRate)"
          :hint="
            (data.summary.onTimeRate ?? 0) >= 0.95 ? 'Cumple el objetivo del 95 %' : 'Por debajo del objetivo del 95 %'
          "
        />
        <AdminStat
          label="Entregas al primer intento"
          icon="i-lucide-circle-check"
          :value="formatPercent(data.summary.firstAttemptRate)"
          :hint="
            (data.summary.firstAttemptRate ?? 0) >= 0.85
              ? 'Cumple el objetivo del 85 %'
              : 'Por debajo del objetivo del 85 %'
          "
        />
        <AdminStat
          label="Envíos con incidencia"
          icon="i-lucide-triangle-alert"
          :value="formatPercent(data.summary.incidentRate)"
          :hint="
            (data.summary.incidentRate ?? 0) <= 0.05
              ? 'Ausencias y retrasos, dentro del 5 %'
              : 'Por encima del 5 % admitido'
          "
        />
        <AdminStat
          label="Envíos con daños"
          icon="i-lucide-package-x"
          :value="formatPercent(data.summary.damageRate)"
          :hint="
            (data.summary.damageRate ?? 0) <= 0.01
              ? 'Roturas y derrames, dentro del 1 %'
              : 'Por encima del 1 % admitido'
          "
        />
        <AdminStat
          label="Coste medio por envío"
          icon="i-lucide-euro"
          :value="formatEuros(data.summary.averageCostCents)"
          :hint="`Incidencias resueltas en ${formatHours(data.summary.averageResolutionTimeHours)} de media`"
        />
      </div>

      <AdminSection
        title="Comparativa por transportista"
        :description="`Con menos de ${data.minSampleThreshold} envíos los porcentajes son poco fiables.`"
      >
        <AdminTable
          :rows="data.carriers"
          :columns="columns"
          :row-key="(row: CarrierRow) => row.carrier"
          caption="Puntualidad, incidencias y coste de cada transportista"
        >
          <template #cell-carrierName="{ row }">
            <span class="font-semibold text-[var(--text-strong)]">{{ row.carrierName }}</span>
            <AdminBadge
              v-if="!row.hasSufficientSample"
              tone="warning"
              plain
              class="ml-2"
              title="Pocos envíos en el periodo: los porcentajes son poco fiables"
            >
              Muestra baja
            </AdminBadge>
          </template>
          <template #cell-service="{ row }">
            <AdminBadge v-if="row.circuitBreaker?.state === 'closed'" tone="success">Normal</AdminBadge>
            <AdminBadge
              v-else-if="row.circuitBreaker?.state === 'half_open'"
              tone="warning"
              title="Se está comprobando si el transportista vuelve a responder"
            >
              En prueba
            </AdminBadge>
            <AdminBadge
              v-else-if="row.circuitBreaker?.state === 'open'"
              tone="danger"
              title="Corte automático: se ha dejado de usar por fallos repetidos"
            >
              Degradado
            </AdminBadge>
            <template v-else>—</template>
          </template>
          <template #cell-onTimeRate="{ row }">{{ formatPercent(row.onTimeRate) }}</template>
          <template #cell-firstAttemptRate="{ row }">{{ formatPercent(row.firstAttemptRate) }}</template>
          <template #cell-incidentRate="{ row }">{{ formatPercent(row.incidentRate) }}</template>
          <template #cell-damageRate="{ row }">{{ formatPercent(row.damageRate) }}</template>
          <template #cell-averageCostCents="{ row }">{{ formatEuros(row.averageCostCents) }}</template>
          <template #cell-averageResolutionTimeHours="{ row }">
            {{ formatHours(row.averageResolutionTimeHours) }}
          </template>
        </AdminTable>
      </AdminSection>
    </template>
  </div>
</template>
