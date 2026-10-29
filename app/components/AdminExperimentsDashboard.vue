<template>
  <div class="admin-experiments-dashboard p-6 max-w-7xl mx-auto space-y-6">
    <!-- Header -->
    <div class="flex flex-col md:flex-row md:items-center md:justify-between gap-4 border-b border-gray-200 pb-4">
      <div>
        <h1 class="text-2xl font-bold text-gray-900">Registro de Experimentos & A/B Testing</h1>
        <p class="text-sm text-gray-600 mt-1">
          DAT-017 (Asignación server-side, SRM, archivo), DAT-018 (Registro sin solapamientos), MKT-011
          (Mensajes/ofertas, holdout y guardrails).
        </p>
      </div>
      <div class="flex items-center gap-3">
        <button
          type="button"
          class="inline-flex items-center px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
          :disabled="loading"
          @click="fetchExperiments"
        >
          <span v-if="loading">Actualizando...</span>
          <span v-else>Recargar</span>
        </button>
      </div>
    </div>

    <!-- Error State -->
    <div
      v-if="errorMessage"
      role="alert"
      class="p-4 bg-red-50 border border-red-200 rounded-lg text-red-800 text-sm flex items-center justify-between"
    >
      <div><strong>Error al cargar experimentos:</strong> {{ errorMessage }}</div>
      <button
        type="button"
        class="text-sm underline font-semibold text-red-900 hover:text-red-700"
        @click="fetchExperiments"
      >
        Reintentar
      </button>
    </div>

    <!-- Loading State -->
    <div v-if="loading && !selectedExperiment && experiments.length === 0" class="py-12 text-center text-gray-500">
      <div class="inline-block animate-spin rounded-full h-8 w-8 border-4 border-gray-300 border-t-blue-600 mb-2"></div>
      <p class="text-sm">Cargando registro de experimentos...</p>
    </div>

    <!-- Empty State -->
    <div
      v-else-if="!loading && experiments.length === 0 && !errorMessage"
      class="text-center py-12 bg-gray-50 rounded-lg border border-dashed border-gray-300"
    >
      <p class="text-gray-700 font-medium">No hay experimentos registrados</p>
      <p class="text-sm text-gray-500 mt-1">
        Crea un experimento para comenzar el A/B testing con asignación server-side.
      </p>
    </div>

    <!-- Main Content -->
    <div v-else class="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <!-- Left Column: Experiment Registry (DAT-018) -->
      <div class="lg:col-span-1 space-y-4">
        <div class="bg-white p-4 rounded-lg border border-gray-200 shadow-sm space-y-3">
          <div class="flex items-center justify-between">
            <h2 class="text-lg font-semibold text-gray-900">Experimentos ({{ filteredExperiments.length }})</h2>
            <span class="text-xs text-gray-500">Registro oficial</span>
          </div>

          <!-- Filters -->
          <div class="space-y-2">
            <input
              v-model="searchQuery"
              type="text"
              placeholder="Buscar por nombre, clave u owner..."
              aria-label="Buscar experimentos"
              class="w-full px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
            />
            <div class="flex gap-2">
              <select
                v-model="statusFilter"
                aria-label="Filtrar por estado"
                class="w-1/2 px-2 py-1.5 text-xs border border-gray-300 rounded-md bg-white"
              >
                <option value="">Todos los estados</option>
                <option value="draft">Borrador</option>
                <option value="running">En ejecución</option>
                <option value="paused">Pausado</option>
                <option value="archived">Archivado</option>
              </select>
              <select
                v-model="surfaceFilter"
                aria-label="Filtrar por superficie"
                class="w-1/2 px-2 py-1.5 text-xs border border-gray-300 rounded-md bg-white"
              >
                <option value="">Todas las superficies</option>
                <option value="homepage_hero">Hero Portada</option>
                <option value="product_detail">Ficha Producto</option>
                <option value="cart_offer">Oferta Carrito</option>
                <option value="checkout_incentive">Checkout</option>
                <option value="category_banner">Categoría</option>
              </select>
            </div>
          </div>

          <!-- Experiment List -->
          <ul class="divide-y divide-gray-100 max-h-[600px] overflow-y-auto" role="list">
            <li
              v-for="exp in filteredExperiments"
              :key="exp.id"
              class="py-3 px-2 rounded-lg cursor-pointer transition-colors"
              :class="selectedExperiment?.id === exp.id ? 'bg-blue-50 border border-blue-200' : 'hover:bg-gray-50'"
              @click="selectExperiment(exp)"
            >
              <div class="flex items-start justify-between gap-2">
                <span class="font-medium text-sm text-gray-900 line-clamp-1">{{ exp.name }}</span>
                <span
                  class="px-2 py-0.5 text-xs font-semibold rounded-full uppercase"
                  :class="{
                    'bg-green-100 text-green-800': exp.status === 'running',
                    'bg-yellow-100 text-yellow-800': exp.status === 'draft',
                    'bg-gray-100 text-gray-800': exp.status === 'paused',
                    'bg-purple-100 text-purple-800': exp.status === 'archived'
                  }"
                >
                  {{ exp.status }}
                </span>
              </div>
              <p class="text-xs text-gray-500 mt-1">
                Owner: <strong class="font-medium text-gray-700">{{ exp.ownerEmail }}</strong>
              </p>
              <div class="flex items-center gap-2 mt-1 text-xs text-gray-500">
                <span
                  >Segmento: <strong>{{ exp.targetSegment }}</strong></span
                >
                <span>•</span>
                <span
                  >Superficie: <strong>{{ exp.targetSurface }}</strong></span
                >
              </div>
            </li>
          </ul>
        </div>
      </div>

      <!-- Right Column: Detail, Live Stats, SRM, Guardrails (DAT-017 & MKT-011) -->
      <div class="lg:col-span-2 space-y-6">
        <div v-if="selectedExperiment" class="bg-white p-6 rounded-lg border border-gray-200 shadow-sm space-y-6">
          <!-- Experiment Header Info -->
          <div class="border-b border-gray-100 pb-4">
            <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
              <div>
                <span class="text-xs font-mono bg-gray-100 text-gray-700 px-2 py-0.5 rounded">{{
                  selectedExperiment.key
                }}</span>
                <h2 class="text-xl font-bold text-gray-900 mt-1">{{ selectedExperiment.name }}</h2>
              </div>
              <div class="flex items-center gap-2">
                <span
                  class="px-2.5 py-1 text-xs font-bold rounded-full uppercase"
                  :class="{
                    'bg-green-100 text-green-800': selectedExperiment.status === 'running',
                    'bg-yellow-100 text-yellow-800': selectedExperiment.status === 'draft',
                    'bg-purple-100 text-purple-800': selectedExperiment.status === 'archived'
                  }"
                >
                  {{ selectedExperiment.status }}
                </span>
              </div>
            </div>

            <!-- Hypothesis (DAT-017 / MKT-011 Acceptance) -->
            <div class="mt-3 p-3 bg-blue-50 rounded-md border border-blue-100 text-sm text-blue-900">
              <strong class="font-semibold block mb-0.5">Hipótesis de experimentación:</strong>
              {{ selectedExperiment.hypothesis }}
            </div>

            <!-- Metadata details -->
            <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4 text-xs text-gray-600">
              <div>
                <span class="text-gray-400 block">Owner</span>
                <span class="font-medium text-gray-800">{{ selectedExperiment.ownerEmail }}</span>
              </div>
              <div>
                <span class="text-gray-400 block">Segmento</span>
                <span class="font-medium text-gray-800">{{ selectedExperiment.targetSegment }}</span>
              </div>
              <div>
                <span class="text-gray-400 block">Métrica Primaria</span>
                <span class="font-medium text-gray-800">{{ selectedExperiment.primaryMetric }}</span>
              </div>
              <div>
                <span class="text-gray-400 block">Holdout (MKT-011)</span>
                <span class="font-medium text-gray-800">{{ selectedExperiment.holdoutPercent }}% de tráfico</span>
              </div>
            </div>

            <!-- Changes description (DAT-018) -->
            <div v-if="selectedExperiment.changesDescription" class="mt-3 text-xs text-gray-600">
              <span class="text-gray-400 block">Cambios implementados:</span>
              <p class="text-gray-800 mt-0.5">{{ selectedExperiment.changesDescription }}</p>
            </div>
          </div>

          <!-- Statistical Report (DAT-017 & MKT-011) -->
          <div v-if="currentReport" class="space-y-6">
            <!-- Sample Size & Duration Gating (DAT-017) -->
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div class="p-3 bg-gray-50 rounded-lg border border-gray-200">
                <div class="flex justify-between items-center text-xs">
                  <span class="font-medium text-gray-700">Muestra mínima requerida</span>
                  <span
                    class="font-semibold"
                    :class="currentReport.hasMetMinSampleSize ? 'text-green-700' : 'text-amber-700'"
                  >
                    {{ currentReport.hasMetMinSampleSize ? 'Alcanzada' : 'En progreso' }}
                  </span>
                </div>
                <div class="mt-1 text-sm font-bold text-gray-900">
                  {{ totalObservedExposures }} / {{ currentReport.minSampleSize }} exposiciones
                </div>
              </div>

              <div class="p-3 bg-gray-50 rounded-lg border border-gray-200">
                <div class="flex justify-between items-center text-xs">
                  <span class="font-medium text-gray-700">Duración mínima</span>
                  <span
                    class="font-semibold"
                    :class="currentReport.hasMetMinDuration ? 'text-green-700' : 'text-amber-700'"
                  >
                    {{ currentReport.hasMetMinDuration ? 'Alcanzada' : 'En progreso' }}
                  </span>
                </div>
                <div class="mt-1 text-sm font-bold text-gray-900">
                  {{ currentReport.daysRunning }} / {{ currentReport.minDurationDays }} días
                </div>
              </div>
            </div>

            <!-- Sample Ratio Mismatch (SRM) Check (DAT-017) -->
            <div
              class="p-4 rounded-lg border flex items-start justify-between"
              :class="{
                'bg-green-50 border-green-200 text-green-900': currentReport.srm.status === 'pass',
                'bg-yellow-50 border-yellow-200 text-yellow-900': currentReport.srm.status === 'warning',
                'bg-red-50 border-red-200 text-red-900': currentReport.srm.status === 'mismatch_detected',
                'bg-gray-50 border-gray-200 text-gray-800': currentReport.srm.status === 'insufficient_data'
              }"
            >
              <div>
                <div class="flex items-center gap-2">
                  <span class="font-bold text-sm">Validación SRM (Sample Ratio Mismatch):</span>
                  <span class="px-2 py-0.5 text-xs font-semibold rounded uppercase">
                    {{ currentReport.srm.status === 'pass' ? 'SRM OK' : currentReport.srm.status }}
                  </span>
                </div>
                <p class="text-xs mt-1">
                  Chi-cuadrado: <strong>{{ currentReport.srm.chiSquare }}</strong> | p-value:
                  <strong>{{ currentReport.srm.pValue }}</strong> (gl: {{ currentReport.srm.degreesOfFreedom }})
                </p>
                <p v-if="currentReport.srm.status === 'mismatch_detected'" class="text-xs font-bold mt-1 text-red-700">
                  ¡Atención! Desviación significativa de asignación de tráfico detectada. Los resultados no son válidos
                  sin corregir el sesgo.
                </p>
              </div>
            </div>

            <!-- Guardrails Status (MKT-011) -->
            <div class="space-y-3">
              <div class="flex items-center justify-between">
                <h3 class="text-sm font-bold text-gray-900">Guardrails Operacionales & de Negocio (MKT-011)</h3>
                <span
                  class="px-2 py-0.5 text-xs font-semibold rounded"
                  :class="
                    currentReport.guardrailsStatus.status === 'healthy'
                      ? 'bg-green-100 text-green-800'
                      : 'bg-red-100 text-red-800'
                  "
                >
                  {{
                    currentReport.guardrailsStatus.status === 'healthy'
                      ? 'Guardrails Saludables'
                      : 'Brecha en Guardrails'
                  }}
                </span>
              </div>

              <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <!-- Margen mínimo (MKT-011) -->
                <div class="p-3 bg-gray-50 rounded border border-gray-200 text-xs">
                  <span class="text-gray-500 font-medium block">Margen mínimo</span>
                  <span class="text-sm font-bold text-gray-900">
                    {{ (selectedExperiment.guardrails?.marginFloorBasisPoints ?? 0) / 100 }}% floor
                  </span>
                </div>

                <!-- Bajas / Quejas (MKT-011) -->
                <div class="p-3 bg-gray-50 rounded border border-gray-200 text-xs">
                  <span class="text-gray-500 font-medium block">Bajas & Quejas máx.</span>
                  <span class="text-sm font-bold text-gray-900">
                    Bajas: {{ (selectedExperiment.guardrails?.maxUnsubscribeRateBasisPoints ?? 0) / 100 }}% | Quejas:
                    {{ (selectedExperiment.guardrails?.maxComplaintRateBasisPoints ?? 0) / 100 }}%
                  </span>
                </div>

                <!-- Core Web Vitals (MKT-011) -->
                <div class="p-3 bg-gray-50 rounded border border-gray-200 text-xs">
                  <span class="text-gray-500 font-medium block">Core Web Vitals</span>
                  <span class="text-sm font-bold text-gray-900">
                    LCP &lt; {{ selectedExperiment.guardrails?.cwvLcpMaxMs ?? 2500 }}ms | CLS &lt;
                    {{ selectedExperiment.guardrails?.cwvClsMax ?? 0.1 }}
                  </span>
                </div>
              </div>

              <!-- Breaches list -->
              <div
                v-if="currentReport.guardrailsStatus.breaches.length > 0"
                class="p-3 bg-red-50 border border-red-200 rounded text-xs text-red-800 space-y-1"
              >
                <div v-for="(b, idx) in currentReport.guardrailsStatus.breaches" :key="idx">• {{ b.message }}</div>
              </div>
            </div>

            <!-- Variants Table -->
            <div class="space-y-3">
              <h3 class="text-sm font-bold text-gray-900">Variantes y Desempeño</h3>
              <div class="overflow-x-auto border border-gray-200 rounded-lg">
                <table class="min-w-full divide-y divide-gray-200 text-xs">
                  <thead class="bg-gray-50 text-gray-600 font-semibold">
                    <tr>
                      <th class="px-3 py-2 text-left">Variante</th>
                      <th class="px-3 py-2 text-right">Exposiciones</th>
                      <th class="px-3 py-2 text-right">Conversiones</th>
                      <th class="px-3 py-2 text-right">Tasa Conversión</th>
                      <th class="px-3 py-2 text-right">Margen Medio</th>
                      <th class="px-3 py-2 text-right">CWV (LCP/CLS)</th>
                    </tr>
                  </thead>
                  <tbody class="divide-y divide-gray-200 text-gray-800">
                    <tr v-for="vm in currentReport.variantsMetrics" :key="vm.variantKey">
                      <td class="px-3 py-2 font-medium">
                        {{ vm.variantKey }}
                        <span v-if="vm.variantKey === 'control'" class="text-gray-400 font-normal">(Control)</span>
                        <span v-else-if="vm.variantKey === 'holdout'" class="text-blue-500 font-normal">(Holdout)</span>
                      </td>
                      <td class="px-3 py-2 text-right">{{ vm.exposures }}</td>
                      <td class="px-3 py-2 text-right">{{ vm.conversions }}</td>
                      <td class="px-3 py-2 text-right font-semibold">{{ (vm.conversionRate * 100).toFixed(2) }}%</td>
                      <td class="px-3 py-2 text-right">
                        {{ vm.averageMarginBasisPoints ? `${(vm.averageMarginBasisPoints / 100).toFixed(1)}%` : '-' }}
                      </td>
                      <td class="px-3 py-2 text-right">
                        {{ vm.p75LcpMs ? `${vm.p75LcpMs}ms` : '-' }} / {{ vm.p75Cls !== undefined ? vm.p75Cls : '-' }}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div v-if="currentReport.liftVsControlPercent !== undefined" class="text-xs text-right text-gray-600">
                Lift estimado vs Control:
                <strong :class="currentReport.liftVsControlPercent >= 0 ? 'text-green-700' : 'text-red-700'">
                  {{ currentReport.liftVsControlPercent > 0 ? '+' : '' }}{{ currentReport.liftVsControlPercent }}%
                </strong>
              </div>
            </div>

            <!-- Decision & Archive Form (DAT-017) -->
            <div
              v-if="selectedExperiment.status === 'running'"
              class="p-4 bg-gray-50 border border-gray-200 rounded-lg space-y-3"
            >
              <h3 class="text-sm font-bold text-gray-900">Tomar Decisión y Archivar Resultados (DAT-017)</h3>
              <p class="text-xs text-gray-600">
                Al tomar la decisión final se guardará un snapshot inmutable de todas las métricas, SRM y guardrails.
              </p>
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label class="block text-xs font-medium text-gray-700 mb-1">Decisión</label>
                  <select
                    v-model="decisionForm.decision"
                    class="w-full px-2 py-1.5 text-xs border border-gray-300 rounded bg-white"
                  >
                    <option value="variant_a_winner">Variante A Ganadora</option>
                    <option value="variant_b_winner">Variante B Ganadora</option>
                    <option value="no_winner_inconclusive">No Conclusivo (Sin ganador)</option>
                    <option value="stopped_guardrail_breach">Detenido por Violación de Guardrail</option>
                  </select>
                </div>
                <div>
                  <label class="block text-xs font-medium text-gray-700 mb-1">Justificación / Rationale</label>
                  <input
                    v-model="decisionForm.rationale"
                    type="text"
                    placeholder="Explicación fundamentada en los datos..."
                    class="w-full px-2 py-1.5 text-xs border border-gray-300 rounded"
                  />
                </div>
              </div>
              <div class="flex justify-end pt-2">
                <button
                  type="button"
                  class="px-3 py-1.5 bg-green-600 text-white text-xs font-semibold rounded hover:bg-green-700 disabled:opacity-50"
                  :disabled="actionLoading || !decisionForm.rationale"
                  @click="recordDecision"
                >
                  <span v-if="actionLoading">Archivando...</span>
                  <span v-else>Confirmar y Archivar Resultados</span>
                </button>
              </div>
            </div>

            <!-- Archived Results Notice -->
            <div
              v-else-if="selectedExperiment.status === 'archived'"
              class="p-3 bg-purple-50 border border-purple-200 rounded text-xs text-purple-900"
            >
              <strong class="font-bold">Resultados Archivados:</strong> Decisión:
              <em>{{ selectedExperiment.decision }}</em>
              <p v-if="selectedExperiment.decisionRationale" class="mt-1 text-purple-800">
                {{ selectedExperiment.decisionRationale }}
              </p>
            </div>
          </div>
        </div>
        <div v-else class="text-center py-12 text-gray-400 bg-white rounded-lg border border-gray-200">
          Selecciona un experimento del registro para consultar detalles y métricas.
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

export interface ExperimentItem {
  id: string
  key: string
  name: string
  hypothesis: string
  experimentType: string
  status: string
  ownerEmail: string
  targetSurface: string
  targetSegment: string
  exclusiveGroup?: string | null
  primaryMetric: string
  guardrails?: {
    marginFloorBasisPoints?: number
    maxUnsubscribeRateBasisPoints?: number
    maxComplaintRateBasisPoints?: number
    cwvLcpMaxMs?: number
    cwvClsMax?: number
    cwvInpMaxMs?: number
  }
  trafficAllocationPercent: number
  minSampleSize: number
  minDurationDays: number
  startDate?: string | null
  holdoutPercent: number
  changesDescription?: string
  decision?: string | null
  decisionRationale?: string | null
  version: number
  createdAt: string
  updatedAt: string
}

export interface ExperimentReportData {
  experimentId: string
  key: string
  name: string
  hypothesis: string
  status: string
  primaryMetric: string
  minSampleSize: number
  minDurationDays: number
  daysRunning: number
  hasMetMinDuration: boolean
  hasMetMinSampleSize: boolean
  srm: {
    status: 'pass' | 'warning' | 'mismatch_detected' | 'insufficient_data'
    chiSquare: number
    pValue: number
    degreesOfFreedom: number
  }
  guardrailsStatus: {
    status: 'healthy' | 'warning' | 'breached'
    breaches: Array<{ guardrail: string; message: string }>
  }
  variantsMetrics: Array<{
    variantKey: string
    exposures: number
    conversions: number
    conversionRate: number
    averageMarginBasisPoints?: number
    p75LcpMs?: number
    p75Cls?: number
    p75InpMs?: number
  }>
  liftVsControlPercent?: number
}

const request = useRequestFetch()

const loading = ref(false)
const actionLoading = ref(false)
const errorMessage = ref<string | null>(null)
const experiments = ref<ExperimentItem[]>([])
const selectedExperiment = ref<ExperimentItem | null>(null)
const currentReport = ref<ExperimentReportData | null>(null)

const searchQuery = ref('')
const statusFilter = ref('')
const surfaceFilter = ref('')

const decisionForm = ref({
  decision: 'variant_b_winner',
  rationale: 'Variante ganadora demostrada estadísticamente'
})

const filteredExperiments = computed(() => {
  return experiments.value.filter((exp) => {
    if (statusFilter.value && exp.status !== statusFilter.value) return false
    if (surfaceFilter.value && exp.targetSurface !== surfaceFilter.value) return false
    if (searchQuery.value) {
      const q = searchQuery.value.toLowerCase()
      const matchName = exp.name.toLowerCase().includes(q)
      const matchKey = exp.key.toLowerCase().includes(q)
      const matchOwner = exp.ownerEmail.toLowerCase().includes(q)
      if (!matchName && !matchKey && !matchOwner) return false
    }
    return true
  })
})

const totalObservedExposures = computed(() => {
  if (!currentReport.value?.variantsMetrics) return 0
  return currentReport.value.variantsMetrics.reduce((sum, vm) => sum + vm.exposures, 0)
})

async function fetchExperiments() {
  loading.value = true
  errorMessage.value = null
  try {
    const data = await request<{ experiments: ExperimentItem[]; total: number }>('/api/admin/experiments')
    experiments.value = data.experiments || []
    if (experiments.value.length > 0 && !selectedExperiment.value) {
      await selectExperiment(experiments.value[0]!)
    }
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : 'Error al conectar con la API de experimentos'
  } finally {
    loading.value = false
  }
}

async function selectExperiment(exp: ExperimentItem) {
  selectedExperiment.value = exp
  try {
    const res = await request<{ experiment: ExperimentItem; report: ExperimentReportData }>(
      `/api/admin/experiments/${exp.id}`
    )
    selectedExperiment.value = res.experiment
    currentReport.value = res.report
  } catch {
    currentReport.value = null
  }
}

async function recordDecision() {
  if (!selectedExperiment.value) return
  actionLoading.value = true
  try {
    await request(`/api/admin/experiments/${selectedExperiment.value.id}/decision`, {
      method: 'POST',
      body: {
        expectedVersion: selectedExperiment.value.version,
        decision: decisionForm.value.decision,
        decisionRationale: decisionForm.value.rationale
      }
    })
    await fetchExperiments()
    if (selectedExperiment.value) {
      await selectExperiment(selectedExperiment.value)
    }
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : 'Error al registrar la decisión'
  } finally {
    actionLoading.value = false
  }
}

onMounted(() => {
  fetchExperiments()
})
</script>
