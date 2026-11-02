<script setup lang="ts">
import { ref, onMounted } from 'vue'
import type { RecommendationEnginePolicy, RecommendationMetrics } from '~~/shared/recommendation-engine'

const requestFetch = useRequestFetch()

const loading = ref(false)
const saving = ref(false)
const errorMessage = ref('')
const successMessage = ref('')

const policy = ref<RecommendationEnginePolicy>({
  id: 'global',
  version: 1,
  weightCompatibility: 40,
  weightSector: 25,
  weightCopurchase: 25,
  weightMargin: 10,
  marginFloorBasisPoints: 1500,
  maxPerCategory: 2,
  manualFallbackProductIds: [],
  updatedAt: '2026-01-01T00:00:00Z',
  updatedBy: '00000000-0000-4000-8000-000000000000'
})

const manualFallbackText = ref('')
const metrics = ref<RecommendationMetrics | null>(null)

async function loadData() {
  loading.value = true
  errorMessage.value = ''
  try {
    const policyRes = await requestFetch<{ policy?: RecommendationEnginePolicy }>('/api/admin/recommendations/policy')
    if (policyRes?.policy) {
      policy.value = { ...policyRes.policy }
      manualFallbackText.value = (policyRes.policy.manualFallbackProductIds ?? []).join(', ')
    }
    const metricsRes = await requestFetch<{ metrics?: RecommendationMetrics }>('/api/admin/recommendations/metrics')
    if (metricsRes?.metrics) {
      metrics.value = metricsRes.metrics
    }
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : 'Error al cargar el motor de recomendaciones'
  } finally {
    loading.value = false
  }
}

async function savePolicy() {
  saving.value = true
  errorMessage.value = ''
  successMessage.value = ''
  try {
    const fallbacks = manualFallbackText.value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)

    const res = await requestFetch<{ policy?: RecommendationEnginePolicy }>('/api/admin/recommendations/policy', {
      method: 'PUT',
      body: {
        expectedVersion: policy.value.version,
        weightCompatibility: Number(policy.value.weightCompatibility),
        weightSector: Number(policy.value.weightSector),
        weightCopurchase: Number(policy.value.weightCopurchase),
        weightMargin: Number(policy.value.weightMargin),
        marginFloorBasisPoints: Number(policy.value.marginFloorBasisPoints),
        maxPerCategory: Number(policy.value.maxPerCategory),
        manualFallbackProductIds: fallbacks
      }
    })
    if (res?.policy) {
      policy.value = { ...res.policy }
      successMessage.value =
        'Configuración del motor de recomendaciones guardada con éxito (v' + res.policy.version + ')'
    }
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : 'Error al guardar la política'
  } finally {
    saving.value = false
  }
}

onMounted(() => {
  loadData()
})
</script>

<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between">
      <div>
        <h2 class="text-lg font-bold text-neutral-900">Motor de Recomendaciones por Reglas (MKT-020)</h2>
        <p class="text-xs text-neutral-500">
          Ponderación multicriterio (compatibilidad química, sector profesional, co-compra y margen), diversidad por
          categoría y fallback manual.
        </p>
      </div>
      <button
        type="button"
        class="rounded-md bg-neutral-100 px-3 py-1.5 text-xs font-semibold text-neutral-700 hover:bg-neutral-200"
        :disabled="loading"
        @click="loadData"
      >
        Recargar
      </button>
    </div>

    <!-- Messages -->
    <div v-if="loading" role="status" class="rounded-lg bg-neutral-100 p-4 text-sm text-neutral-600">
      Cargando motor de recomendaciones y métricas...
    </div>

    <div v-if="errorMessage" role="alert" class="rounded-lg bg-red-50 p-4 text-sm text-red-800">
      {{ errorMessage }}
    </div>

    <div v-if="successMessage" role="status" class="rounded-lg bg-green-50 p-4 text-sm text-green-800">
      {{ successMessage }}
    </div>

    <!-- Policy Weights Form -->
    <div class="rounded-lg border border-neutral-200 bg-white p-6 shadow-sm space-y-4">
      <h3 class="text-sm font-semibold text-neutral-900">Ponderaciones de Señales (0 a 100)</h3>

      <div class="grid grid-cols-1 md:grid-cols-4 gap-4 text-sm">
        <div>
          <label class="block text-xs font-medium text-neutral-600 mb-1"> Compatibilidad de Catálogo </label>
          <input
            v-model.number="policy.weightCompatibility"
            type="number"
            min="0"
            max="100"
            class="w-full rounded-md border border-neutral-300 px-3 py-1.5 text-sm"
            data-testid="weight-compatibility-input"
          />
        </div>

        <div>
          <label class="block text-xs font-medium text-neutral-600 mb-1"> Afinidad por Sector </label>
          <input
            v-model.number="policy.weightSector"
            type="number"
            min="0"
            max="100"
            class="w-full rounded-md border border-neutral-300 px-3 py-1.5 text-sm"
            data-testid="weight-sector-input"
          />
        </div>

        <div>
          <label class="block text-xs font-medium text-neutral-600 mb-1"> Matriz de Co-compra </label>
          <input
            v-model.number="policy.weightCopurchase"
            type="number"
            min="0"
            max="100"
            class="w-full rounded-md border border-neutral-300 px-3 py-1.5 text-sm"
            data-testid="weight-copurchase-input"
          />
        </div>

        <div>
          <label class="block text-xs font-medium text-neutral-600 mb-1"> Margen Bruto </label>
          <input
            v-model.number="policy.weightMargin"
            type="number"
            min="0"
            max="100"
            class="w-full rounded-md border border-neutral-300 px-3 py-1.5 text-sm"
            data-testid="weight-margin-input"
          />
        </div>
      </div>

      <h3 class="text-sm font-semibold text-neutral-900 pt-2">Gobernanza y Diversidad</h3>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
        <div>
          <label class="block text-xs font-medium text-neutral-600 mb-1">
            Suelo de Margen Bruto (bps, ej: 1500 = 15%)
          </label>
          <input
            v-model.number="policy.marginFloorBasisPoints"
            type="number"
            min="0"
            max="5000"
            class="w-full rounded-md border border-neutral-300 px-3 py-1.5 text-sm"
            data-testid="margin-floor-input"
          />
          <span class="text-xs text-neutral-500">Productos con margen inferior son excluidos.</span>
        </div>

        <div>
          <label class="block text-xs font-medium text-neutral-600 mb-1"> Máximo por categoría (Diversidad) </label>
          <input
            v-model.number="policy.maxPerCategory"
            type="number"
            min="1"
            max="10"
            class="w-full rounded-md border border-neutral-300 px-3 py-1.5 text-sm"
            data-testid="max-per-category-input"
          />
          <span class="text-xs text-neutral-500">Garantiza variedad de soluciones en las sugerencias.</span>
        </div>

        <div class="md:col-span-2">
          <label class="block text-xs font-medium text-neutral-600 mb-1">
            Productos de fallback manual (IDs separados por coma)
          </label>
          <input
            v-model="manualFallbackText"
            type="text"
            class="w-full rounded-md border border-neutral-300 px-3 py-1.5 text-sm"
            placeholder="prod-bayetas, prod-guantes"
            data-testid="manual-fallback-input"
          />
          <span class="text-xs text-neutral-500"
            >Se usan ordenadamente cuando las reglas generan menos recomendaciones del límite solicitado.</span
          >
        </div>

        <div class="md:col-span-2 flex justify-end">
          <button
            type="button"
            class="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
            :disabled="saving"
            data-testid="save-recommendation-policy-button"
            @click="savePolicy"
          >
            {{ saving ? 'Guardando...' : 'Guardar Configuración' }}
          </button>
        </div>
      </div>
    </div>

    <!-- Metrics Card -->
    <div v-if="metrics" class="rounded-lg border border-neutral-200 bg-white p-6 shadow-sm space-y-4">
      <h3 class="text-sm font-semibold text-neutral-900">
        Rendimiento y Medición (Últimos {{ metrics.periodDays }} días)
      </h3>

      <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div class="rounded-md border border-neutral-100 bg-neutral-50 p-4">
          <p class="text-xs font-medium text-neutral-500">Impresiones</p>
          <p class="text-xl font-bold text-neutral-900" data-testid="metric-impressions">{{ metrics.impressions }}</p>
        </div>

        <div class="rounded-md border border-neutral-100 bg-neutral-50 p-4">
          <p class="text-xs font-medium text-neutral-500">Clics (CTR)</p>
          <p class="text-xl font-bold text-neutral-900" data-testid="metric-clicks">
            {{ metrics.clicks }}
            <span class="text-xs font-normal text-neutral-500"
              >({{ (metrics.clickThroughRate * 100).toFixed(2) }}%)</span
            >
          </p>
        </div>

        <div class="rounded-md border border-neutral-100 bg-neutral-50 p-4">
          <p class="text-xs font-medium text-neutral-500">Conversiones (CVR)</p>
          <p class="text-xl font-bold text-neutral-900" data-testid="metric-conversions">
            {{ metrics.conversions }}
            <span class="text-xs font-normal text-neutral-500">({{ (metrics.conversionRate * 100).toFixed(2) }}%)</span>
          </p>
        </div>

        <div class="rounded-md border border-neutral-100 bg-neutral-50 p-4">
          <p class="text-xs font-medium text-neutral-500">Ingresos Atribuidos</p>
          <p class="text-xl font-bold text-neutral-900" data-testid="metric-revenue">
            {{ (metrics.attributedRevenueGrossCents / 100).toFixed(2) }} €
          </p>
        </div>
      </div>

      <div class="rounded-md border border-neutral-200 p-4 text-xs text-neutral-600 flex justify-around">
        <div>
          <span class="font-semibold text-neutral-800">Por Reglas:</span>
          {{ metrics.byOrigin.rule.clicks }} clics · {{ metrics.byOrigin.rule.conversions }} ventas
        </div>
        <div>
          <span class="font-semibold text-neutral-800">Por Fallback Manual:</span>
          {{ metrics.byOrigin.manualFallback.clicks }} clics · {{ metrics.byOrigin.manualFallback.conversions }} ventas
        </div>
      </div>
    </div>
  </div>
</template>
