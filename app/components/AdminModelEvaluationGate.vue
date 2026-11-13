<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type {
  AiEvaluationRun,
  ExplainabilityReport,
  MlModelRegistryItem,
  ModelEvaluationRecord
} from '~~/shared/predictive-personalization'

const requestFetch = useRequestFetch()
const loading = ref(true)
const errorMessage = ref('')
const successMessage = ref('')

// Models state
const models = ref<MlModelRegistryItem[]>([])
const selectedModel = ref<MlModelRegistryItem | null>(null)
const modelSummary = ref<{
  offline?: ModelEvaluationRecord
  online?: ModelEvaluationRecord
  healthy: boolean
} | null>(null)

// Golden set run state
const runningGoldenSet = ref(false)
const latestEvaluationRun = ref<AiEvaluationRun | null>(null)

// Explainability demo state
const explainabilityReport = ref<ExplainabilityReport | null>(null)
const loadingExplainability = ref(false)

function errorText(error: unknown, fallback: string): string {
  const c = (error as { data?: { error?: { code?: string } } })?.data?.error?.code
  return c ? `${fallback} (${c})` : fallback
}

function getMetric(record: ModelEvaluationRecord | undefined, key: string, fallback: string | number): string | number {
  if (!record?.metrics) return fallback
  const val = (record.metrics as Record<string, unknown>)[key]
  return typeof val === 'number' || typeof val === 'string' ? val : fallback
}

async function loadModels() {
  loading.value = true
  errorMessage.value = ''
  try {
    const res = (await requestFetch('/api/admin/ai/models')) as {
      models: MlModelRegistryItem[]
    }
    models.value = res?.models ?? []
    if (models.value[0] && !selectedModel.value) {
      await selectModel(models.value[0])
    }
  } catch (error) {
    errorMessage.value = errorText(error, 'No se han podido cargar los modelos de IA')
  } finally {
    loading.value = false
  }
}

async function selectModel(model: MlModelRegistryItem) {
  selectedModel.value = model
  modelSummary.value = null
  latestEvaluationRun.value = null
  explainabilityReport.value = null

  try {
    const res = (await requestFetch(`/api/admin/ai/evaluations/summary?modelId=${model.id}`)) as {
      summary: {
        offline?: ModelEvaluationRecord
        online?: ModelEvaluationRecord
        healthy: boolean
      }
    }
    modelSummary.value = res?.summary ?? null
  } catch {
    // Non critical if summary not yet available
  }
}

async function handleRunGoldenSet() {
  if (!selectedModel.value) return
  runningGoldenSet.value = true
  errorMessage.value = ''
  successMessage.value = ''

  try {
    const res = (await requestFetch('/api/admin/ai/evaluations/golden-set/run', {
      method: 'POST',
      body: {
        modelId: selectedModel.value.id,
        suiteName: 'neteco_chemical_golden_suite_v1'
      }
    })) as { run: AiEvaluationRun }

    latestEvaluationRun.value = res?.run
    if (res?.run?.gateVerdict === 'passed') {
      successMessage.value =
        'Evaluación completada: el modelo ha superado el control de calidad y puede usarse en la tienda.'
      selectedModel.value.status = 'gate_passed'
    } else {
      errorMessage.value = `El modelo no ha superado el control de calidad: ${res?.run?.gateReasons?.join(', ')}`
    }
  } catch (error) {
    errorMessage.value = errorText(error, 'No se ha podido ejecutar la evaluación')
  } finally {
    runningGoldenSet.value = false
  }
}

async function handleRequestExplainability() {
  if (!selectedModel.value) return
  loadingExplainability.value = true
  try {
    const res = (await requestFetch('/api/admin/ai/evaluations/explainability', {
      method: 'POST',
      body: {
        customerId: '20000000-0000-4000-8000-000000000001',
        productId: 'prod-desengrasante-alimentario',
        modelWeights: selectedModel.value.weights,
        features: {
          daysSinceLastOrder: 28,
          expectedReplenishmentCycleDays: 30,
          historicalSectorMarginPercent: 38,
          catalogPopularityScore: 0.82
        }
      }
    })) as { report: ExplainabilityReport }

    explainabilityReport.value = res?.report
  } catch (error) {
    errorMessage.value = errorText(error, 'No se ha podido calcular la explicación')
  } finally {
    loadingExplainability.value = false
  }
}

onMounted(() => {
  loadModels()
})

// ── Presentación ───────────────────────────────────────────────────────────
const MODEL_STATUS: Record<string, [string, 'success' | 'warning' | 'danger' | 'neutral']> = {
  candidate: ['Pendiente de evaluar', 'warning'],
  gate_passed: ['Control superado', 'success'],
  active: ['En uso', 'success'],
  deprecated: ['Retirado', 'neutral'],
  rejected: ['Rechazado', 'danger']
}
const MODEL_TYPES: Record<string, string> = {
  repurchase_propensity: 'Predice quién volverá a comprar',
  margin_recommendation: 'Recomienda productos por margen',
  catalog_copilot_assistant: 'Asistente de catálogo',
  churn_propensity: 'Predice clientes en riesgo de irse'
}
const FALLBACKS: Record<string, string> = {
  static_bestsellers: 'los más vendidos',
  category_margin_top: 'los de mayor margen de la categoría',
  rules_safety_default: 'las reglas de seguridad predeterminadas'
}
const modelStatusLabel = (code: string) => MODEL_STATUS[code]?.[0] ?? adminStatusLabel(code)
const modelStatusTone = (code: string) => MODEL_STATUS[code]?.[1] ?? 'neutral'
const HEALTH: Record<string, [string, 'success' | 'warning' | 'danger' | 'neutral']> = {
  healthy: ['Correcto', 'success'],
  degraded: ['Con incidencias', 'warning'],
  drift_detected: ['Se está desviando', 'warning'],
  bias_detected: ['Trato desequilibrado', 'danger']
}
/** Quita el código interno que acompaña a algunos errores. */
const readableError = computed(() => errorMessage.value.replace(/\s*\([A-Za-z0-9_.:-]+\)$/, ''))
</script>

<template>
  <div class="adm-stack" role="region" aria-label="Evaluación de modelos de IA">
    <AdminPageActions>
      <button
        v-if="selectedModel"
        type="button"
        data-test="run-golden-set-btn"
        :disabled="runningGoldenSet"
        class="adm-btn adm-btn--primary"
        @click="handleRunGoldenSet"
      >
        {{ runningGoldenSet ? 'Evaluando…' : 'Evaluar modelo' }}
      </button>
    </AdminPageActions>

    <UAlert
      v-if="errorMessage"
      data-test="error-alert"
      role="alert"
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="readableError"
    />
    <UAlert
      v-if="successMessage"
      data-test="success-alert"
      role="status"
      color="success"
      variant="subtle"
      icon="i-lucide-circle-check"
      :title="successMessage"
      :close="true"
      @update:open="successMessage = ''"
    />

    <div v-if="loading" data-test="loading-state" class="adm-card" role="status">
      <div class="adm-table-skeleton" aria-busy="true">
        <span class="sr-only">Cargando modelos y resultados…</span>
        <div v-for="row in 4" :key="row"><i /><i /><i /></div>
      </div>
    </div>

    <template v-else>
      <section aria-labelledby="models-heading" class="grid gap-5 lg:grid-cols-3">
        <AdminCard flush>
          <template #title><span id="models-heading">Modelos</span></template>
          <div v-if="models.length === 0" data-test="empty-models">
            <AdminEmptyState
              compact
              icon="i-lucide-brain"
              title="No hay modelos registrados todavía"
              description="Cuando se registre un modelo de recomendaciones aparecerá aquí."
            >
              <button v-if="errorMessage" type="button" class="adm-btn adm-btn--secondary" @click="loadModels">
                Reintentar
              </button>
            </AdminEmptyState>
          </div>
          <ul v-else class="adm-list">
            <li v-for="m in models" :key="m.id" class="!p-0">
              <button
                type="button"
                :data-test="'select-model-' + m.id"
                :aria-pressed="selectedModel?.id === m.id"
                class="flex w-full flex-col gap-1 px-4 py-3 text-left"
                :class="selectedModel?.id === m.id && 'bg-[var(--surface-sunken)]'"
                @click="selectModel(m)"
              >
                <span class="adm-list__title">{{ m.modelName }}</span>
                <span class="flex flex-wrap items-center gap-2">
                  <span class="adm-help">Versión {{ m.modelVersion }}</span>
                  <AdminBadge :tone="modelStatusTone(m.status)" plain>{{ modelStatusLabel(m.status) }}</AdminBadge>
                </span>
              </button>
            </li>
          </ul>
        </AdminCard>

        <div v-if="selectedModel" class="adm-stack lg:col-span-2">
          <AdminCard>
            <template #title>{{ selectedModel.modelName }}</template>
            <template #actions>
              <AdminBadge :tone="modelStatusTone(selectedModel.status)">
                {{ modelStatusLabel(selectedModel.status) }}
              </AdminBadge>
            </template>
            <div class="adm-stack">
              <p class="adm-help">
                {{ MODEL_TYPES[selectedModel.modelType] ?? adminHumanize(selectedModel.modelType) }} · si falla, se
                recomiendan
                {{ FALLBACKS[selectedModel.fallbackStrategy] ?? adminHumanize(selectedModel.fallbackStrategy) }}
              </p>

              <div>
                <h4>Qué prioriza al recomendar</h4>
                <div class="mt-2">
                  <AdminBreakdown
                    :items="[
                      { label: 'Margen comercial', value: Math.round(selectedModel.weights.margin * 100) },
                      {
                        label: 'Que el cliente vuelva a comprar',
                        value: Math.round(selectedModel.weights.retention * 100)
                      },
                      { label: 'Popularidad (clics)', value: Math.round(selectedModel.weights.clicks * 100) }
                    ]"
                    :format="(value: number) => `${value}%`"
                  />
                </div>
              </div>

              <div class="grid gap-4 sm:grid-cols-2">
                <div>
                  <h4>Con datos históricos</h4>
                  <dl class="mt-1 space-y-1">
                    <div class="flex justify-between gap-3">
                      <dt class="adm-help">Capacidad de acierto (de 0 a 1)</dt>
                      <dd class="tabular-nums">{{ getMetric(modelSummary?.offline, 'rocAuc', '—') }}</dd>
                    </div>
                    <div class="flex justify-between gap-3">
                      <dt class="adm-help">Aciertos entre las primeras recomendaciones</dt>
                      <dd class="tabular-nums">{{ getMetric(modelSummary?.offline, 'precisionAtK', '—') }}</dd>
                    </div>
                  </dl>
                </div>
                <div>
                  <h4>En la tienda</h4>
                  <dl class="mt-1 space-y-1">
                    <div class="flex justify-between gap-3">
                      <dt class="adm-help">Desviación respecto al entrenamiento (máx. 0,20)</dt>
                      <dd class="tabular-nums">{{ modelSummary?.online?.driftPsi ?? '—' }}</dd>
                    </div>
                    <div class="flex justify-between gap-3">
                      <dt class="adm-help">Trato equilibrado entre clientes (entre 0,80 y 1,25)</dt>
                      <dd class="tabular-nums">{{ modelSummary?.online?.biasDisparateImpact ?? '—' }}</dd>
                    </div>
                    <div class="flex items-center justify-between gap-3">
                      <dt class="adm-help">Estado</dt>
                      <dd>
                        <AdminBadge
                          v-if="modelSummary?.online?.status"
                          :tone="HEALTH[String(modelSummary.online.status).toLowerCase()]?.[1] ?? 'neutral'"
                        >
                          {{
                            HEALTH[String(modelSummary.online.status).toLowerCase()]?.[0] ??
                            adminStatusLabel(String(modelSummary.online.status))
                          }}
                        </AdminBadge>
                        <template v-else>—</template>
                      </dd>
                    </div>
                  </dl>
                </div>
              </div>
            </div>
          </AdminCard>

          <AdminCard
            title="Por qué recomienda lo que recomienda"
            description="Ejemplo con un cliente y un producto de muestra."
          >
            <template #actions>
              <button
                type="button"
                data-test="explainability-btn"
                class="adm-btn adm-btn--secondary adm-btn--sm"
                :disabled="loadingExplainability"
                @click="handleRequestExplainability"
              >
                {{ loadingExplainability ? 'Calculando…' : 'Ver explicación' }}
              </button>
            </template>
            <div v-if="explainabilityReport" data-test="explainability-report" class="adm-stack">
              <p class="font-semibold text-[var(--text-strong)]">{{ explainabilityReport.recommendedAction }}</p>
              <ul class="space-y-1">
                <li
                  v-for="(f, i) in explainabilityReport.topContributingFactors"
                  :key="i"
                  class="flex justify-between gap-3"
                >
                  <span>{{ f.factor }}</span>
                  <span class="tabular-nums font-semibold">{{ f.impactScore }}</span>
                </li>
              </ul>
            </div>
            <p v-else class="adm-help">Pulsa «Ver explicación» para ver los factores que más pesan.</p>
          </AdminCard>
        </div>
      </section>

      <section
        v-if="latestEvaluationRun"
        data-test="quality-gate-results"
        aria-labelledby="gate-heading"
        class="adm-section"
      >
        <div class="adm-section__head">
          <h2 id="gate-heading" class="adm-section__title">Resultado de la última evaluación</h2>
          <AdminBadge :tone="latestEvaluationRun.gateVerdict === 'passed' ? 'success' : 'danger'">
            {{ latestEvaluationRun.gateVerdict === 'passed' ? 'Superada' : 'No superada' }}
          </AdminBadge>
        </div>
        <div class="adm-grid">
          <AdminStat
            label="Seguridad química"
            :value="`${(latestEvaluationRun.safetyScore * 100).toFixed(0)}%`"
            hint="Nunca recomienda mezclas peligrosas (lejía con ácidos o amoniaco)"
          />
          <AdminStat
            label="Datos correctos"
            :value="`${(latestEvaluationRun.factualityScore * 100).toFixed(1)}%`"
            hint="Fichas de seguridad, pH y dosis comprobados"
          />
          <AdminStat
            label="Tiempo de respuesta"
            :value="`${latestEvaluationRun.latencyP95Ms} ms`"
            hint="Objetivo: 150 ms como máximo"
          />
          <AdminStat
            label="Alternativa si falla"
            :value="latestEvaluationRun.fallbackPassed ? 'Comprobada' : 'Ha fallado'"
            hint="La tienda sigue recomendando aunque el modelo no responda"
          />
        </div>
      </section>
    </template>
  </div>
</template>
