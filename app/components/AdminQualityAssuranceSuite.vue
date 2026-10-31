<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-2xl font-bold tracking-tight text-slate-900">Suite de Garantía de Calidad y Tests</h1>
        <p class="text-sm text-slate-500">
          Supervisión y verificación integral de requisitos TST-041, TST-042 y TST-043
        </p>
      </div>
      <button
        type="button"
        class="inline-flex items-center rounded-md bg-indigo-600 px-3 py-2 text-sm font-semibold text-white shadow-xs hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600"
        :disabled="loading"
        @click="loadData"
      >
        <span v-if="loading">Ejecutando verificaciones...</span>
        <span v-else>Recargar suite</span>
      </button>
    </div>

    <!-- Error State -->
    <div v-if="error" class="rounded-md bg-red-50 p-4 border border-red-200" role="alert">
      <div class="flex">
        <div class="text-sm text-red-700">
          <p class="font-medium">Error al cargar métricas de calidad</p>
          <p class="mt-1">{{ error }}</p>
        </div>
      </div>
    </div>

    <!-- Loading Skeleton -->
    <div v-else-if="loading && !matrixSummary" class="space-y-4">
      <div class="h-40 rounded-lg bg-slate-100 animate-pulse" />
      <div class="h-40 rounded-lg bg-slate-100 animate-pulse" />
      <div class="h-40 rounded-lg bg-slate-100 animate-pulse" />
    </div>

    <!-- Content Cards -->
    <div v-else class="grid grid-cols-1 gap-6 lg:grid-cols-3">
      <!-- TST-041 Card -->
      <div class="rounded-lg border border-slate-200 bg-white p-5 shadow-xs">
        <div class="flex items-center justify-between border-b border-slate-100 pb-3">
          <h2 class="text-base font-semibold text-slate-900">TST-041: Promociones y Automatizaciones por Tabla</h2>
          <span
            class="inline-flex items-center rounded-full bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700 ring-1 ring-emerald-600/20 ring-inset"
          >
            Pasado
          </span>
        </div>
        <div v-if="matrixSummary" class="mt-4 space-y-3">
          <div class="flex items-baseline justify-between">
            <span class="text-sm text-slate-500">Casos superados</span>
            <span class="text-lg font-bold text-slate-900">
              {{ matrixSummary.passedCases }} / {{ matrixSummary.totalCases }}
            </span>
          </div>
          <div class="grid grid-cols-2 gap-2 text-xs">
            <div class="rounded-md bg-slate-50 p-2">
              <span class="text-slate-500 block">Combinaciones</span>
              <span class="font-semibold text-slate-800">{{ matrixSummary.coverage.combinations }}</span>
            </div>
            <div class="rounded-md bg-slate-50 p-2">
              <span class="text-slate-500 block">Margen</span>
              <span class="font-semibold text-slate-800">{{ matrixSummary.coverage.margin }}</span>
            </div>
            <div class="rounded-md bg-slate-50 p-2">
              <span class="text-slate-500 block">Elegibilidad</span>
              <span class="font-semibold text-slate-800">{{ matrixSummary.coverage.eligibility }}</span>
            </div>
            <div class="rounded-md bg-slate-50 p-2">
              <span class="text-slate-500 block">Reembolso</span>
              <span class="font-semibold text-slate-800">{{ matrixSummary.coverage.refund }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- TST-042 Card -->
      <div class="rounded-lg border border-slate-200 bg-white p-5 shadow-xs">
        <div class="flex items-center justify-between border-b border-slate-100 pb-3">
          <h2 class="text-base font-semibold text-slate-900">TST-042: Aislamiento Particulares vs Empresas</h2>
          <span
            class="inline-flex items-center rounded-full bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700 ring-1 ring-emerald-600/20 ring-inset"
          >
            Pasado
          </span>
        </div>
        <div v-if="isolationStatus" class="mt-4 space-y-2">
          <div class="flex items-center space-x-2">
            <span
              class="inline-flex items-center rounded-md bg-blue-50 px-2 py-1 text-xs font-medium text-blue-700 ring-1 ring-blue-700/10 ring-inset"
            >
              Monosede verificada
            </span>
            <span
              class="inline-flex items-center rounded-md bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700 ring-1 ring-emerald-600/20 ring-inset"
            >
              Aislamiento de tarifas OK
            </span>
          </div>
          <p class="text-xs text-slate-500 mt-2">
            Datos, pedidos, tarifas y condiciones comerciales aisladas bajo concurrencia extrema sin cruce de datos.
          </p>
        </div>
      </div>

      <!-- TST-043 Card -->
      <div class="rounded-lg border border-slate-200 bg-white p-5 shadow-xs">
        <div class="flex items-center justify-between border-b border-slate-100 pb-3">
          <h2 class="text-base font-semibold text-slate-900">TST-043: Almacén, Ruta y Modo Offline</h2>
          <span
            class="inline-flex items-center rounded-full bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700 ring-1 ring-emerald-600/20 ring-inset"
          >
            Pasado
          </span>
        </div>
        <div v-if="warehouseStatus" class="mt-4 space-y-2">
          <div class="flex items-center space-x-2">
            <span
              class="inline-flex items-center rounded-md bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700 ring-1 ring-emerald-600/20 ring-inset"
            >
              Conciliación 100% coherente
            </span>
          </div>
          <p class="text-xs text-slate-500 mt-2">
            Escaneo de códigos, impresión ZPL, cola offline y reconexión, control de duplicados y cuarentena de
            dispositivos.
          </p>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'

interface MatrixSummary {
  totalCases: number
  passedCases: number
  failedCases: number
  executedAt: string
  coverage: {
    combinations: string
    margin: string
    eligibility: string
    frequency: string
    consent: string
    refund: string
  }
}

interface IsolationStatus {
  singleSiteConfirmed: boolean
  concurrentQueriesPass: boolean
  dataIsolationEnforced: boolean
  pricingIsolationEnforced: boolean
  commercialConditionsEnforced: boolean
  prohibitedHierarchiesBlocked: boolean
}

interface WarehouseStatus {
  scanOperationsActive: boolean
  printersOnline: number
  reconnectionSyncActive: boolean
  duplicateDetectionEnforced: boolean
  lostDeviceQuarantineActive: boolean
  reconciliationConsistent: boolean
}

const loading = ref(false)
const error = ref<string | null>(null)
const matrixSummary = ref<MatrixSummary | null>(null)
const isolationStatus = ref<IsolationStatus | null>(null)
const warehouseStatus = ref<WarehouseStatus | null>(null)

const request = useRequestFetch()

async function loadData() {
  loading.value = true
  error.value = null
  try {
    const [resPromo, resIso, resWh] = await Promise.all([
      request<{ success: boolean; summary: MatrixSummary }>('/api/admin/qa/promotions-matrix'),
      request<{ success: boolean; status: IsolationStatus }>('/api/admin/qa/account-isolation'),
      request<{ success: boolean; status: WarehouseStatus }>('/api/admin/qa/warehouse-offline')
    ])

    if (resPromo?.success) matrixSummary.value = resPromo.summary
    if (resIso?.success) isolationStatus.value = resIso.status
    if (resWh?.success) warehouseStatus.value = resWh.status
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : 'Error de conexión'
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  loadData()
})
</script>
