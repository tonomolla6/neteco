<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { FlowMetricsSummary, CrmHoldoutPolicy } from '../../shared/crm-automation-metrics'

const requestFetch = useRequestFetch()

const loading = ref(true)
const busy = ref(false)
const errorMessage = ref('')
const notice = ref('')

const flows = ref<FlowMetricsSummary[]>([])
const selectedFlow = ref<string>('welcome_series')
const selectedPolicy = ref<CrmHoldoutPolicy | null>(null)

// Form edit values
const editHoldoutPercentage = ref<number>(10)
const editHoldoutEnabled = ref<boolean>(true)
const editMinSampleSize = ref<number>(20)

function errorText(error: unknown, fallback: string): string {
  const code = (error as { data?: { error?: { code?: string } } })?.data?.error?.code
  return code ? `${fallback} (${code})` : fallback
}

function formatCents(cents: number): string {
  return (cents / 100).toLocaleString('es-ES', { style: 'currency', currency: 'EUR' })
}

function formatBp(bp: number): string {
  return `${(bp / 100).toFixed(2)}%`
}

async function loadData() {
  loading.value = true
  errorMessage.value = ''
  try {
    const res = (await requestFetch('/api/admin/crm/metrics/flows')) as { flows: FlowMetricsSummary[] }
    flows.value = res?.flows ?? []
    syncSelectedPolicy()
  } catch (err: unknown) {
    errorMessage.value = errorText(err, 'Error al cargar métricas de automatizaciones CRM')
  } finally {
    loading.value = false
  }
}

function syncSelectedPolicy() {
  const found = flows.value.find((f) => f.flowId === selectedFlow.value)
  if (found) {
    selectedPolicy.value = found.holdoutPolicy
    editHoldoutPercentage.value = found.holdoutPolicy.holdoutPercentage
    editHoldoutEnabled.value = found.holdoutPolicy.holdoutEnabled
    editMinSampleSize.value = found.holdoutPolicy.minSampleSize
  }
}

async function saveHoldoutPolicy() {
  if (!selectedPolicy.value) return
  busy.value = true
  errorMessage.value = ''
  notice.value = ''

  try {
    const body = {
      flowId: selectedFlow.value,
      holdoutPercentage: Number(editHoldoutPercentage.value),
      holdoutEnabled: Boolean(editHoldoutEnabled.value),
      minSampleSize: Number(editMinSampleSize.value),
      expectedVersion: selectedPolicy.value.version
    }

    await requestFetch('/api/admin/crm/metrics/holdout/policy', {
      method: 'PUT',
      body
    })

    notice.value = `Política de grupo de control (holdout) para ${selectedFlow.value} actualizada correctamente.`
    await loadData()
  } catch (err: unknown) {
    errorMessage.value = errorText(err, 'Error al guardar la política de holdout')
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
    <!-- Header -->
    <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
      <div>
        <h2 class="text-xl font-bold tracking-tight text-neutral-900">Medición de Automatizaciones CRM (DAT-016)</h2>
        <p class="text-sm text-neutral-600 mt-1">
          Monitorización continua de entrega, clics, conversiones, bajas, quejas y margen por flujo, con holdout
          incremental.
        </p>
      </div>
      <button
        type="button"
        class="inline-flex items-center gap-2 rounded-md bg-neutral-900 px-3 py-2 text-xs font-semibold text-white shadow-sm hover:bg-neutral-800 disabled:opacity-50"
        :disabled="loading || busy"
        @click="loadData"
      >
        <span v-if="loading">Cargando...</span>
        <span v-else>Actualizar métricas</span>
      </button>
    </div>

    <!-- Alerts -->
    <div v-if="errorMessage" role="alert" class="rounded-lg bg-red-50 p-4 text-sm text-red-800 border border-red-200">
      {{ errorMessage }}
    </div>
    <div
      v-if="notice"
      role="status"
      class="rounded-lg bg-emerald-50 p-4 text-sm text-emerald-800 border border-emerald-200"
    >
      {{ notice }}
    </div>

    <!-- Empty state -->
    <div
      v-if="!loading && flows.length === 0"
      class="rounded-lg border border-neutral-200 bg-neutral-50 p-8 text-center text-neutral-600"
    >
      No hay flujos de automatización registrados.
    </div>

    <!-- Table of Flow Metrics -->
    <div v-if="flows.length > 0" class="overflow-x-auto rounded-lg border border-neutral-200 shadow-sm bg-white">
      <table class="min-w-full divide-y divide-neutral-200 text-left text-sm">
        <thead class="bg-neutral-50 font-semibold text-neutral-900">
          <tr>
            <th class="px-4 py-3">Flujo CRM</th>
            <th class="px-4 py-3">Entregas</th>
            <th class="px-4 py-3">Clics (CTR)</th>
            <th class="px-4 py-3">Conversión</th>
            <th class="px-4 py-3">Bajas / Quejas</th>
            <th class="px-4 py-3">Ingresos / Margen</th>
            <th class="px-4 py-3">Holdout Incremental</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-neutral-200">
          <tr v-for="flow in flows" :key="flow.flowId" class="hover:bg-neutral-50">
            <td class="px-4 py-3 font-medium text-neutral-900">
              <span class="font-mono text-xs">{{ flow.flowId }}</span>
            </td>
            <td class="px-4 py-3 text-neutral-700">
              {{ flow.treatment.deliveries }}
            </td>
            <td class="px-4 py-3 text-neutral-700">
              {{ flow.treatment.clicks }}
              <span class="text-xs text-neutral-500">({{ flow.treatment.ctrPercent }}%)</span>
            </td>
            <td class="px-4 py-3 text-neutral-700">
              {{ flow.treatment.conversions }}
              <span class="text-xs text-neutral-500">({{ flow.treatment.conversionRatePercent }}%)</span>
            </td>
            <td class="px-4 py-3 text-neutral-700">
              <span class="text-amber-700 font-medium">{{ flow.treatment.unsubscribes }}</span> bajas /
              <span class="text-red-700 font-medium">{{ flow.treatment.complaints }}</span> quejas
            </td>
            <td class="px-4 py-3 text-neutral-700">
              <div class="font-semibold">{{ formatCents(flow.treatment.totalRevenueCents) }}</div>
              <div class="text-xs text-emerald-700">
                Margen: {{ formatCents(flow.treatment.totalMarginCents) }} ({{
                  formatBp(flow.treatment.marginBasisPoints)
                }})
              </div>
            </td>
            <td class="px-4 py-3">
              <div v-if="flow.incremental.holdoutViable" class="space-y-0.5">
                <span
                  class="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800"
                >
                  Viable (+{{ flow.incremental.incrementalLiftPercent }}% lift)
                </span>
                <div class="text-xs text-neutral-600">Conv. inc.: {{ flow.incremental.incrementalConversions }}</div>
                <div class="text-xs font-semibold text-emerald-700">
                  Margen inc.: {{ formatCents(flow.incremental.incrementalMarginCents) }}
                </div>
              </div>
              <div v-else>
                <span
                  class="inline-flex items-center rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-600"
                >
                  Control no viable
                </span>
                <div class="text-xs text-neutral-500 mt-0.5">
                  {{ flow.incremental.viabilityReason || 'Muestra insuficiente' }}
                </div>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Holdout Policy Configuration -->
    <div class="rounded-lg border border-neutral-200 bg-white p-5 shadow-sm space-y-4">
      <h3 class="text-base font-semibold text-neutral-900">Configuración de Grupo de Control (Holdout) por Flujo</h3>

      <div class="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <div>
          <label class="block text-xs font-medium text-neutral-700 mb-1">Flujo</label>
          <select
            v-model="selectedFlow"
            class="w-full rounded-md border-neutral-300 text-sm shadow-sm focus:border-neutral-900 focus:ring-neutral-900"
            @change="syncSelectedPolicy"
          >
            <option v-for="f in flows" :key="f.flowId" :value="f.flowId">
              {{ f.flowId }}
            </option>
          </select>
        </div>

        <div>
          <label class="block text-xs font-medium text-neutral-700 mb-1">Porcentaje Holdout (%)</label>
          <input
            v-model.number="editHoldoutPercentage"
            type="number"
            min="0"
            max="50"
            class="w-full rounded-md border-neutral-300 text-sm shadow-sm focus:border-neutral-900 focus:ring-neutral-900"
          />
        </div>

        <div>
          <label class="block text-xs font-medium text-neutral-700 mb-1">Muestra Mínima</label>
          <input
            v-model.number="editMinSampleSize"
            type="number"
            min="1"
            class="w-full rounded-md border-neutral-300 text-sm shadow-sm focus:border-neutral-900 focus:ring-neutral-900"
          />
        </div>

        <div class="flex items-center pt-5">
          <label class="inline-flex items-center gap-2 text-sm text-neutral-700 cursor-pointer">
            <input
              v-model="editHoldoutEnabled"
              type="checkbox"
              class="rounded border-neutral-300 text-neutral-900 focus:ring-neutral-900"
            />
            <span>Holdout activado</span>
          </label>
        </div>
      </div>

      <div class="flex justify-end pt-2">
        <button
          type="button"
          class="rounded-md bg-neutral-900 px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-neutral-800 disabled:opacity-50"
          :disabled="busy || !selectedPolicy"
          @click="saveHoldoutPolicy"
        >
          Guardar política de holdout
        </button>
      </div>
    </div>
  </div>
</template>
