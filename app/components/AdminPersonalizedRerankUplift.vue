<script setup lang="ts">
import { ref, onMounted } from 'vue'
import type { UpliftReport } from '~~/shared/personalized-rerank'

defineProps<{
  runtime?: unknown
}>()

const requestFetch = useRequestFetch()

const loading = ref(true)
const error = ref<string | null>(null)
const report = ref<UpliftReport | null>(null)
const experiments = ref<Array<{ id: string; name: string; status: string }>>([])
const selectedExperimentId = ref('rerank_affinity_v1')

async function loadUplift() {
  loading.value = true
  error.value = null
  try {
    const [expRes, upliftRes] = await Promise.all([
      requestFetch<{ items: Array<{ id: string; name: string; status: string }> }>(
        '/api/admin/search-personalization/experiments'
      ),
      requestFetch<UpliftReport>(`/api/admin/search-personalization/uplift?experimentId=${selectedExperimentId.value}`)
    ])
    experiments.value = expRes.items
    report.value = upliftRes
  } catch {
    error.value = 'No se ha podido cargar el informe de uplift de reordenación personalizada.'
  } finally {
    loading.value = false
  }
}

function formatPercent(val: number | undefined): string {
  if (val === undefined || Number.isNaN(val)) return '0.0%'
  const prefix = val > 0 ? '+' : ''
  return `${prefix}${val.toFixed(1)}%`
}

function formatCurrency(cents: number | undefined): string {
  if (!cents) return '0,00 €'
  return `${(cents / 100).toFixed(2).replace('.', ',')} €`
}

onMounted(() => {
  void loadUplift()
})
</script>

<template>
  <div class="rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
    <div class="mb-6 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h2 class="text-xl font-bold text-slate-900 dark:text-slate-100">
          Reordenación personalizada controlada y medición de uplift incremental (SEA-020)
        </h2>
        <p class="text-sm text-slate-500 dark:text-slate-400">
          Garantía absoluta de orden y filtros explícitos, experimentos A/B controlados y medición honesta de uplift en
          CTR, conversión y facturación.
        </p>
      </div>

      <div class="flex items-center gap-2">
        <select
          v-model="selectedExperimentId"
          class="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
          aria-label="Seleccionar experimento"
          @change="loadUplift"
        >
          <option v-for="exp in experiments" :key="exp.id" :value="exp.id">{{ exp.name }} ({{ exp.status }})</option>
        </select>

        <button
          type="button"
          class="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
          :disabled="loading"
          @click="loadUplift"
        >
          <span v-if="loading">Actualizando…</span>
          <span v-else>Actualizar</span>
        </button>
      </div>
    </div>

    <!-- Error Alert -->
    <div
      v-if="error"
      role="alert"
      class="mb-6 rounded-lg bg-red-50 p-4 text-sm text-red-700 dark:bg-red-950/50 dark:text-red-400"
    >
      {{ error }}
    </div>

    <!-- Explicit Order & Filter Compliance Guarantee Badge -->
    <div
      class="mb-6 flex items-center gap-3 rounded-lg border border-emerald-200 bg-emerald-50/50 p-4 text-sm text-emerald-800 dark:border-emerald-900/50 dark:bg-emerald-950/20 dark:text-emerald-300"
    >
      <div
        class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-600 dark:bg-emerald-900 dark:text-emerald-300"
      >
        <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
        </svg>
      </div>
      <div>
        <div class="font-semibold">Filtros y orden explícitos respetados al 100%</div>
        <div class="text-xs text-emerald-700 dark:text-emerald-400">
          La personalización se omite automáticamente ante criterios explícitos (precio ascendente/descendente, nombre,
          orden alfabético) y nunca evade facetas de filtrado activas.
          <span v-if="report && report.explicitSortBypassHonoredCount > 0" class="font-bold">
            ({{ report.explicitSortBypassHonoredCount }} consultas con orden/filtros explícitos preservados sin
            alteración).
          </span>
        </div>
      </div>
    </div>

    <!-- Side-by-side Uplift Comparison Cards -->
    <div v-if="report" class="mb-8 grid grid-cols-1 gap-5 md:grid-cols-3">
      <!-- Control Group -->
      <div class="rounded-xl border border-slate-200 bg-slate-50/60 p-5 dark:border-slate-800 dark:bg-slate-800/40">
        <div class="flex items-center justify-between border-b border-slate-200 pb-3 dark:border-slate-700">
          <span class="font-semibold text-slate-800 dark:text-slate-200">Grupo Control (A)</span>
          <span class="rounded bg-slate-200 px-2 py-0.5 text-xs text-slate-700 dark:bg-slate-700 dark:text-slate-300"
            >Orden estándar</span
          >
        </div>

        <div class="mt-4 space-y-3">
          <div class="flex justify-between text-sm">
            <span class="text-slate-500 dark:text-slate-400">Impresiones:</span>
            <span class="font-semibold text-slate-900 dark:text-slate-100">{{ report.control.impressions }}</span>
          </div>
          <div class="flex justify-between text-sm">
            <span class="text-slate-500 dark:text-slate-400">Clics (CTR):</span>
            <span class="font-semibold text-slate-900 dark:text-slate-100">
              {{ report.control.clicks }} ({{ (report.control.ctr * 100).toFixed(1) }}%)
            </span>
          </div>
          <div class="flex justify-between text-sm">
            <span class="text-slate-500 dark:text-slate-400">Conversiones (CVR):</span>
            <span class="font-semibold text-slate-900 dark:text-slate-100">
              {{ report.control.conversions }} ({{ (report.control.cvr * 100).toFixed(1) }}%)
            </span>
          </div>
          <div class="flex justify-between text-sm">
            <span class="text-slate-500 dark:text-slate-400">Facturación:</span>
            <span class="font-semibold text-slate-900 dark:text-slate-100">{{
              formatCurrency(report.control.revenueCents)
            }}</span>
          </div>
        </div>
      </div>

      <!-- Personalized Treatment Group -->
      <div
        class="rounded-xl border border-primary-200 bg-primary-50/30 p-5 dark:border-primary-900/50 dark:bg-primary-950/20"
      >
        <div class="flex items-center justify-between border-b border-primary-200 pb-3 dark:border-primary-800">
          <span class="font-semibold text-primary-900 dark:text-primary-200">Grupo Tratamiento (B)</span>
          <span
            class="rounded bg-primary-100 px-2 py-0.5 text-xs font-medium text-primary-800 dark:bg-primary-900 dark:text-primary-300"
            >Reordenado</span
          >
        </div>

        <div class="mt-4 space-y-3">
          <div class="flex justify-between text-sm">
            <span class="text-slate-500 dark:text-slate-400">Impresiones:</span>
            <span class="font-semibold text-slate-900 dark:text-slate-100">{{ report.treatment.impressions }}</span>
          </div>
          <div class="flex justify-between text-sm">
            <span class="text-slate-500 dark:text-slate-400">Clics (CTR):</span>
            <span class="font-semibold text-slate-900 dark:text-slate-100">
              {{ report.treatment.clicks }} ({{ (report.treatment.ctr * 100).toFixed(1) }}%)
            </span>
          </div>
          <div class="flex justify-between text-sm">
            <span class="text-slate-500 dark:text-slate-400">Conversiones (CVR):</span>
            <span class="font-semibold text-slate-900 dark:text-slate-100">
              {{ report.treatment.conversions }} ({{ (report.treatment.cvr * 100).toFixed(1) }}%)
            </span>
          </div>
          <div class="flex justify-between text-sm">
            <span class="text-slate-500 dark:text-slate-400">Facturación:</span>
            <span class="font-semibold text-slate-900 dark:text-slate-100">{{
              formatCurrency(report.treatment.revenueCents)
            }}</span>
          </div>
        </div>
      </div>

      <!-- Incremental Uplift Delta -->
      <div class="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <div class="flex items-center justify-between border-b border-slate-200 pb-3 dark:border-slate-700">
          <span class="font-semibold text-slate-900 dark:text-slate-100">Uplift Incremental</span>
          <span
            class="rounded px-2 py-0.5 text-xs font-semibold"
            :class="
              report.statisticallySignificant
                ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
                : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400'
            "
          >
            {{ report.statisticallySignificant ? 'Significativo' : 'Muestra preliminar' }}
          </span>
        </div>

        <div class="mt-4 space-y-3">
          <div class="flex justify-between text-sm">
            <span class="text-slate-500 dark:text-slate-400">Uplift CTR:</span>
            <span
              class="font-bold"
              :class="
                report.ctrUpliftPercent >= 0
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : 'text-red-600 dark:text-red-400'
              "
            >
              {{ formatPercent(report.ctrUpliftPercent) }}
            </span>
          </div>
          <div class="flex justify-between text-sm">
            <span class="text-slate-500 dark:text-slate-400">Uplift Conversión:</span>
            <span
              class="font-bold"
              :class="
                report.convUpliftPercent >= 0
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : 'text-red-600 dark:text-red-400'
              "
            >
              {{ formatPercent(report.convUpliftPercent) }}
            </span>
          </div>
          <div class="flex justify-between text-sm">
            <span class="text-slate-500 dark:text-slate-400">Uplift Facturación:</span>
            <span
              class="font-bold"
              :class="
                report.revenueUpliftPercent >= 0
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : 'text-red-600 dark:text-red-400'
              "
            >
              {{ formatPercent(report.revenueUpliftPercent) }}
            </span>
          </div>
          <div class="mt-2 border-t border-slate-100 pt-2 text-xs text-slate-400">
            Total eventos evaluados: {{ report.totalEvaluatedEvents }}
          </div>
        </div>
      </div>
    </div>

    <!-- Empty state -->
    <div
      v-else-if="!loading"
      class="rounded-lg border border-dashed border-slate-300 py-12 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400"
    >
      No se han registrado eventos de búsqueda para el experimento seleccionado.
    </div>
  </div>
</template>
