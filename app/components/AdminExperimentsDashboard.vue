<template>
  <div class="admin-experiments-dashboard adm-stack">
    <AdminPageActions>
      <AdminButton icon="i-lucide-rotate-cw" :loading="loading" @click="fetchExperiments">Actualizar</AdminButton>
    </AdminPageActions>

    <UAlert
      v-if="errorMessage && experiments.length > 0"
      role="alert"
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      title="No se ha podido completar la operación"
      :description="errorMessage"
    />

    <div class="adm-grid">
      <AdminStat label="Pruebas" :value="experiments.length" icon="i-lucide-flask-conical" />
      <AdminStat label="En curso" :value="countByStatus('running')" />
      <AdminStat label="Borradores" :value="countByStatus('draft')" />
      <AdminStat label="Archivadas" :value="countByStatus('archived')" />
    </div>

    <AdminTable
      :rows="filteredExperiments"
      :columns="columns"
      :row-key="(row) => row.id"
      :status="errorMessage && !experiments.length ? 'error' : loading && !experiments.length ? 'pending' : 'success'"
      :filtered="searchQuery !== '' || statusFilter !== '' || surfaceFilter !== ''"
      :error-message="errorMessage ?? undefined"
      caption="Pruebas A/B"
      empty-title="Todavía no hay pruebas A/B"
      empty-description="Cuando se cree una prueba, aquí verás su estado y sus resultados."
      empty-icon="i-lucide-flask-conical"
      @row-click="openExperiment"
      @retry="fetchExperiments"
      @clear-filters="clearFilters"
    >
      <template #toolbar>
        <AdminToolbar
          v-model:search="searchQuery"
          placeholder="Buscar por nombre o responsable…"
          search-label="Buscar experimentos"
        >
          <AdminFilters v-model="statusFilter" :options="STATUS_OPTIONS" label="Filtrar por estado" />
          <select v-model="surfaceFilter" aria-label="Filtrar por superficie" class="adm-input w-auto">
            <option value="">Cualquier lugar de la tienda</option>
            <option value="homepage_hero">Portada</option>
            <option value="product_detail">Ficha de producto</option>
            <option value="cart_offer">Oferta en el carrito</option>
            <option value="checkout_incentive">Proceso de compra</option>
            <option value="category_banner">Página de categoría</option>
          </select>
        </AdminToolbar>
      </template>
      <template #cell-name="{ row }">
        <p class="font-semibold text-[var(--text-strong)]">{{ row.name }}</p>
        <p class="adm-help line-clamp-1">{{ row.hypothesis }}</p>
      </template>
      <template #cell-status="{ row }">
        <AdminBadge :tone="statusTone(row.status)">{{ statusLabel(row.status) }}</AdminBadge>
      </template>
      <template #actions="{ row }">
        <AdminButton size="sm" @click="openExperiment(row)">Ver resultados</AdminButton>
      </template>
    </AdminTable>

    <AdminDrawer
      v-model:open="detailOpen"
      wide
      :title="selectedExperiment?.name ?? 'Prueba A/B'"
      :description="
        selectedExperiment
          ? `${surfaceLabel(selectedExperiment.targetSurface)} · ${statusLabel(selectedExperiment.status)}`
          : undefined
      "
    >
      <div v-if="selectedExperiment" class="adm-stack">
        <UAlert
          v-if="errorMessage"
          role="alert"
          color="error"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          :title="errorMessage"
        />

        <AdminCard title="Qué se quiere comprobar">
          <p>{{ selectedExperiment.hypothesis }}</p>
          <p v-if="selectedExperiment.changesDescription" class="adm-help mt-2">
            Cambios que se prueban: {{ selectedExperiment.changesDescription }}
          </p>
          <dl class="mt-4 grid grid-cols-2 gap-x-4 gap-y-3">
            <div>
              <dt class="adm-help">Responsable</dt>
              <dd class="break-all font-medium text-[var(--text-strong)]">{{ selectedExperiment.ownerEmail }}</dd>
            </div>
            <div>
              <dt class="adm-help">Visitantes</dt>
              <dd class="font-medium text-[var(--text-strong)]">
                {{ segmentLabel(selectedExperiment.targetSegment) }}
              </dd>
            </div>
            <div>
              <dt class="adm-help">Qué se mide</dt>
              <dd class="font-medium text-[var(--text-strong)]">
                {{ metricLabel(selectedExperiment.primaryMetric) }}
              </dd>
            </div>
            <div>
              <dt class="adm-help">Grupo de control</dt>
              <dd class="font-medium text-[var(--text-strong)]">
                {{ selectedExperiment.holdoutPercent }} % de las visitas
              </dd>
            </div>
          </dl>
        </AdminCard>

        <template v-if="currentReport">
          <div class="adm-grid">
            <AdminStat
              label="Visitas necesarias"
              :value="`${totalObservedExposures} / ${currentReport.minSampleSize}`"
              :hint="currentReport.hasMetMinSampleSize ? 'Alcanzadas' : 'Aún faltan visitas'"
            />
            <AdminStat
              label="Duración mínima"
              :value="`${currentReport.daysRunning} / ${currentReport.minDurationDays} días`"
              :hint="currentReport.hasMetMinDuration ? 'Alcanzada' : 'Aún en plazo'"
            />
            <AdminStat
              v-if="currentReport.liftVsControlPercent !== undefined"
              label="Mejora frente a la versión actual"
              :value="`${currentReport.liftVsControlPercent > 0 ? '+' : ''}${percent(currentReport.liftVsControlPercent)}`"
              hint="Estimación"
            />
          </div>

          <AdminSection title="Resultados por variante">
            <AdminTable
              :rows="currentReport.variantsMetrics"
              :columns="variantColumns"
              :row-key="(row) => row.variantKey"
              caption="Resultados por variante"
            />
          </AdminSection>

          <AdminCard title="Reparto de las visitas" :description="SPLIT[currentReport.srm.status]?.[2]">
            <template #actions>
              <AdminBadge :tone="SPLIT[currentReport.srm.status]?.[1] ?? 'neutral'">
                {{ SPLIT[currentReport.srm.status]?.[0] ?? adminHumanize(currentReport.srm.status) }}
              </AdminBadge>
            </template>
            <p class="adm-help">
              Datos de la comprobación estadística: valor p
              {{ currentReport.srm.pValue.toLocaleString('es-ES', { maximumFractionDigits: 4 }) }}, chi-cuadrado
              {{ currentReport.srm.chiSquare.toLocaleString('es-ES', { maximumFractionDigits: 2 }) }}.
            </p>
          </AdminCard>

          <AdminCard title="Límites" description="Si se supera alguno, la prueba debe detenerse.">
            <template #actions>
              <AdminBadge :tone="currentReport.guardrailsStatus.status === 'healthy' ? 'success' : 'danger'">
                {{ currentReport.guardrailsStatus.status === 'healthy' ? 'Dentro de los límites' : 'Límite superado' }}
              </AdminBadge>
            </template>
            <dl class="grid gap-x-4 gap-y-3 sm:grid-cols-3">
              <div>
                <dt class="adm-help">Margen mínimo</dt>
                <dd class="font-medium text-[var(--text-strong)]">
                  {{ percent((selectedExperiment.guardrails?.marginFloorBasisPoints ?? 0) / 100) }}
                </dd>
              </div>
              <div>
                <dt class="adm-help">Bajas y quejas máximas</dt>
                <dd class="font-medium text-[var(--text-strong)]">
                  {{ percent((selectedExperiment.guardrails?.maxUnsubscribeRateBasisPoints ?? 0) / 100) }} de bajas ·
                  {{ percent((selectedExperiment.guardrails?.maxComplaintRateBasisPoints ?? 0) / 100) }} de quejas
                </dd>
              </div>
              <div>
                <dt class="adm-help">Velocidad de la página</dt>
                <dd class="font-medium text-[var(--text-strong)]">
                  Carga en menos de {{ selectedExperiment.guardrails?.cwvLcpMaxMs ?? 2500 }} ms · saltos de diseño por
                  debajo de {{ selectedExperiment.guardrails?.cwvClsMax ?? 0.1 }}
                </dd>
              </div>
            </dl>
            <UAlert
              v-if="currentReport.guardrailsStatus.breaches.length > 0"
              class="mt-4"
              color="error"
              variant="subtle"
              icon="i-lucide-triangle-alert"
              title="Límites superados"
            >
              <template #description>
                <ul class="list-disc pl-4">
                  <li v-for="(b, idx) in currentReport.guardrailsStatus.breaches" :key="idx">{{ b.message }}</li>
                </ul>
              </template>
            </UAlert>
          </AdminCard>

          <AdminCard
            v-if="selectedExperiment.status === 'running'"
            title="Cerrar la prueba"
            description="Al cerrarla se guardan los resultados tal como están y la prueba queda archivada."
          >
            <div class="adm-form-grid">
              <AdminFormField v-slot="{ id }" label="Decisión">
                <select :id="id" v-model="decisionForm.decision" class="adm-input">
                  <option value="variant_a_winner">Gana la variante A</option>
                  <option value="variant_b_winner">Gana la variante B</option>
                  <option value="no_winner_inconclusive">Sin ganadora clara</option>
                  <option value="stopped_guardrail_breach">Detenida por superar un límite</option>
                </select>
              </AdminFormField>
              <AdminFormField v-slot="{ id }" label="Motivo" required>
                <input
                  :id="id"
                  v-model="decisionForm.rationale"
                  type="text"
                  placeholder="Explica la decisión con los datos"
                  class="adm-input"
                />
              </AdminFormField>
            </div>
            <template #footer>
              <AdminButton
                variant="primary"
                :loading="actionLoading"
                :disabled="!decisionForm.rationale"
                @click="confirmDecision = true"
              >
                Cerrar y archivar
              </AdminButton>
            </template>
          </AdminCard>

          <UAlert
            v-else-if="selectedExperiment.status === 'archived'"
            color="neutral"
            variant="subtle"
            icon="i-lucide-archive"
            :title="`Prueba archivada: ${decisionLabel(selectedExperiment.decision).toLowerCase()}`"
            :description="selectedExperiment.decisionRationale ?? undefined"
          />
        </template>
        <AdminEmptyState
          v-else
          compact
          icon="i-lucide-chart-no-axes-column"
          title="Todavía no hay resultados"
          description="Los resultados aparecerán cuando la prueba reciba visitas."
        />
      </div>
      <template #footer>
        <AdminButton @click="detailOpen = false">Cerrar</AdminButton>
      </template>
    </AdminDrawer>

    <AdminConfirm
      v-model:open="confirmDecision"
      title="Cerrar y archivar la prueba"
      :description="`Se guardará la decisión «${decisionLabel(decisionForm.decision)}» y la prueba dejará de mostrarse a los visitantes. No se puede deshacer.`"
      confirm-label="Cerrar y archivar"
      :loading="actionLoading"
      @confirm="confirmRecordDecision"
    />
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
  rationale: 'La variante ganadora mejora el resultado con datos suficientes'
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
    errorMessage.value = err instanceof Error ? err.message : 'No se ha podido conectar. Vuelve a intentarlo.'
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
    errorMessage.value = err instanceof Error ? err.message : 'No se ha podido guardar la decisión.'
  } finally {
    actionLoading.value = false
  }
}

// Estado de interfaz y nombres legibles.
const detailOpen = ref(false)
const confirmDecision = ref(false)
function openExperiment(exp: ExperimentItem) {
  detailOpen.value = true
  void selectExperiment(exp)
}
async function confirmRecordDecision() {
  confirmDecision.value = false
  await recordDecision()
}
function clearFilters() {
  searchQuery.value = ''
  statusFilter.value = ''
  surfaceFilter.value = ''
}

type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info'
const STATUS: Record<string, [string, Tone]> = {
  draft: ['Borrador', 'neutral'],
  running: ['En curso', 'success'],
  paused: ['En pausa', 'warning'],
  archived: ['Archivada', 'neutral']
}
const statusLabel = (code: string) => STATUS[code]?.[0] ?? adminHumanize(code)
const statusTone = (code: string): Tone => STATUS[code]?.[1] ?? 'neutral'
const STATUS_OPTIONS = computed(() => [
  { value: '', label: 'Todas', count: experiments.value.length },
  ...['running', 'draft', 'paused', 'archived'].map((code) => ({ value: code, label: statusLabel(code) }))
])
const SURFACES: Record<string, string> = {
  homepage_hero: 'Portada',
  product_detail: 'Ficha de producto',
  cart_offer: 'Oferta en el carrito',
  checkout_incentive: 'Proceso de compra',
  category_banner: 'Página de categoría'
}
const surfaceLabel = (code: string) => SURFACES[code] ?? adminHumanize(code)
const SEGMENTS: Record<string, string> = {
  all: 'Todos los visitantes',
  all_users: 'Todos los visitantes',
  b2b: 'Empresas',
  b2c: 'Particulares',
  new_visitors: 'Visitantes nuevos',
  returning_customers: 'Clientes que repiten'
}
const segmentLabel = (code: string) => SEGMENTS[code] ?? adminHumanize(code)
const METRICS: Record<string, string> = {
  conversion_rate: 'Tasa de conversión',
  add_to_cart_rate: 'Productos añadidos al carrito',
  revenue_per_visitor: 'Ingresos por visitante',
  average_order_value: 'Importe medio del pedido',
  click_through_rate: 'Clics',
  checkout_completion_rate: 'Compras terminadas'
}
const metricLabel = (code: string) => METRICS[code] ?? adminHumanize(code)
const DECISIONS: Record<string, string> = {
  variant_a_winner: 'Gana la variante A',
  variant_b_winner: 'Gana la variante B',
  no_winner_inconclusive: 'Sin ganadora clara',
  stopped_guardrail_breach: 'Detenida por superar un límite'
}
const decisionLabel = (code: string | null | undefined) => (code ? (DECISIONS[code] ?? adminHumanize(code)) : '—')
const SPLIT: Record<string, [string, Tone, string]> = {
  pass: ['Correcto', 'success', 'Cada variante recibe la parte de visitas prevista.'],
  warning: ['Revisar', 'warning', 'El reparto de visitas se desvía un poco de lo previsto.'],
  mismatch_detected: [
    'Descompensado',
    'danger',
    'Las variantes no reciben las visitas previstas. Los resultados no son fiables hasta corregirlo.'
  ],
  insufficient_data: ['Faltan datos', 'neutral', 'Todavía no hay visitas suficientes para comprobarlo.']
}
const VARIANTS: Record<string, string> = {
  control: 'Versión actual',
  holdout: 'Grupo de control',
  variant_a: 'Variante A',
  variant_b: 'Variante B',
  a: 'Variante A',
  b: 'Variante B'
}
const variantLabel = (code: string) => VARIANTS[code.toLowerCase()] ?? adminHumanize(code)
const percent = (value: number, digits = 2) => `${value.toLocaleString('es-ES', { maximumFractionDigits: digits })} %`
const countByStatus = (code: string) => experiments.value.filter((exp) => exp.status === code).length
const columns = [
  { key: 'name', label: 'Prueba', sortable: true },
  { key: 'targetSurface', label: 'Dónde', value: (row: ExperimentItem) => surfaceLabel(row.targetSurface) },
  {
    key: 'targetSegment',
    label: 'Visitantes',
    hideOnMobile: true,
    value: (row: ExperimentItem) => segmentLabel(row.targetSegment)
  },
  { key: 'ownerEmail', label: 'Responsable', hideOnMobile: true },
  { key: 'status', label: 'Estado' }
]
type VariantRow = ExperimentReportData['variantsMetrics'][number]
const variantColumns = [
  { key: 'variantKey', label: 'Variante', value: (row: VariantRow) => variantLabel(row.variantKey) },
  { key: 'exposures', label: 'Visitas', numeric: true },
  { key: 'conversions', label: 'Conversiones', numeric: true },
  {
    key: 'conversionRate',
    label: 'Tasa',
    numeric: true,
    value: (row: VariantRow) => percent(row.conversionRate * 100)
  },
  {
    key: 'averageMarginBasisPoints',
    label: 'Margen medio',
    numeric: true,
    hideOnMobile: true,
    value: (row: VariantRow) => (row.averageMarginBasisPoints ? percent(row.averageMarginBasisPoints / 100, 1) : '—')
  },
  {
    key: 'p75LcpMs',
    label: 'Carga de la página',
    numeric: true,
    hideOnMobile: true,
    value: (row: VariantRow) => (row.p75LcpMs ? `${row.p75LcpMs} ms` : '—')
  }
]

onMounted(() => {
  fetchExperiments()
})
</script>
