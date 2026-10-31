<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import type { MarketingWorkflowMetricsSummary } from '~~/shared/marketing-automation-observability'

const request = useRequestFetch()
const loading = ref(true)
const errorMessage = ref<string | null>(null)
const workflows = ref<MarketingWorkflowMetricsSummary[]>([])
const selectedWorkflow = ref<MarketingWorkflowMetricsSummary | null>(null)

async function loadData() {
  loading.value = true
  errorMessage.value = null
  try {
    const res = await request<{ workflows: MarketingWorkflowMetricsSummary[] }>(
      '/api/admin/marketing/observability/workflows'
    )
    workflows.value = res.workflows ?? []
  } catch {
    errorMessage.value = 'Error al cargar la observabilidad de automatizaciones'
  } finally {
    loading.value = false
  }
}

function formatCents(cents: number): string {
  const eur = cents / 100
  return new Intl.NumberFormat('es-ES', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 2
  }).format(eur)
}

function formatBps(bps: number): string {
  return `${(bps / 100).toFixed(2).replace('.', ',')}%`
}

const totalTriggers = computed(() => workflows.value.reduce((acc, w) => acc + w.triggers, 0))
const totalDeliveries = computed(() => workflows.value.reduce((acc, w) => acc + w.deliveries, 0))
const totalConversions = computed(() => workflows.value.reduce((acc, w) => acc + w.conversions, 0))
const totalNetMargin = computed(() => workflows.value.reduce((acc, w) => acc + w.totalNetMarginCents, 0))

function openBreakdown(workflow: MarketingWorkflowMetricsSummary) {
  selectedWorkflow.value = workflow
}

function closeBreakdown() {
  selectedWorkflow.value = null
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
        <h2 class="text-xl font-bold text-neutral-900">Observabilidad de Automatizaciones y Marketing (OBS-027)</h2>
        <p class="text-sm text-neutral-600 mt-0.5">
          Monitorización continua por flujo: disparos, supresión justificada, entregabilidad, conversión, quejas,
          impacto financiero de descuentos y margen neto.
        </p>
      </div>
      <button
        type="button"
        class="inline-flex items-center gap-1.5 rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-neutral-800 focus:outline-none focus:ring-2 focus:ring-neutral-900 focus:ring-offset-2"
        @click="loadData"
      >
        <span class="i-lucide-refresh-cw h-3.5 w-3.5" />
        Actualizar
      </button>
    </div>

    <!-- Error state -->
    <div v-if="errorMessage" class="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800" role="alert">
      <div class="flex items-center gap-2 font-semibold">
        <span class="i-lucide-alert-circle h-4 w-4 text-red-600" />
        {{ errorMessage }}
      </div>
    </div>

    <!-- Loading state -->
    <div v-else-if="loading" class="py-12 text-center text-sm text-neutral-500">
      <span class="i-lucide-loader-2 inline-block h-6 w-6 animate-spin text-neutral-400 mb-2" />
      <p>Cargando métricas de observabilidad de marketing...</p>
    </div>

    <div v-else class="space-y-6">
      <!-- High-level KPI summary cards -->
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div class="rounded-xl border border-neutral-200 bg-white p-4 shadow-sm">
          <div class="text-xs font-semibold text-neutral-500 uppercase tracking-wider">Disparos Totales</div>
          <div class="mt-1 text-2xl font-bold text-neutral-900">{{ totalTriggers.toLocaleString('es-ES') }}</div>
        </div>

        <div class="rounded-xl border border-neutral-200 bg-white p-4 shadow-sm">
          <div class="text-xs font-semibold text-neutral-500 uppercase tracking-wider">Entregas Efectivas</div>
          <div class="mt-1 text-2xl font-bold text-neutral-900">{{ totalDeliveries.toLocaleString('es-ES') }}</div>
        </div>

        <div class="rounded-xl border border-neutral-200 bg-white p-4 shadow-sm">
          <div class="text-xs font-semibold text-neutral-500 uppercase tracking-wider">Conversiones Atribuidas</div>
          <div class="mt-1 text-2xl font-bold text-emerald-600">{{ totalConversions.toLocaleString('es-ES') }}</div>
        </div>

        <div class="rounded-xl border border-neutral-200 bg-white p-4 shadow-sm">
          <div class="text-xs font-semibold text-neutral-500 uppercase tracking-wider">Margen Neto Acumulado</div>
          <div class="mt-1 text-2xl font-bold" :class="totalNetMargin >= 0 ? 'text-neutral-900' : 'text-red-600'">
            {{ formatCents(totalNetMargin) }}
          </div>
        </div>
      </div>

      <!-- Empty state -->
      <div
        v-if="workflows.length === 0"
        class="rounded-xl border border-neutral-200 bg-white p-8 text-center text-sm text-neutral-600"
      >
        <span class="i-lucide-bar-chart-2 mx-auto mb-3 block h-8 w-8 text-neutral-400" />
        <h3 class="font-semibold text-neutral-900 mb-1">No hay eventos de telemetría de automatización registrados.</h3>
        <p class="text-neutral-500 max-w-md mx-auto">
          Los flujos de ciclo de vida (bienvenida, carritos abandonados, reposición) registrarán eventos automáticamente
          al dispararse.
        </p>
      </div>

      <!-- Workflows Observability Table -->
      <div v-else class="rounded-xl border border-neutral-200 bg-white shadow-sm overflow-hidden">
        <div class="overflow-x-auto">
          <table class="w-full text-left text-xs border-collapse">
            <thead class="bg-neutral-100 text-neutral-700 font-semibold border-b border-neutral-200">
              <tr>
                <th scope="col" class="py-3 px-4">Flujo de Automatización</th>
                <th scope="col" class="py-3 px-3">Disparos</th>
                <th scope="col" class="py-3 px-3">Supresión</th>
                <th scope="col" class="py-3 px-3">Entrega</th>
                <th scope="col" class="py-3 px-3">Conversión</th>
                <th scope="col" class="py-3 px-3">Quejas</th>
                <th scope="col" class="py-3 px-3">Descuento / Margen</th>
                <th scope="col" class="py-3 px-3">Errores</th>
                <th scope="col" class="py-3 px-4 text-right">Detalle</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-neutral-200 text-neutral-800">
              <tr v-for="w in workflows" :key="w.workflowId" class="hover:bg-neutral-50 transition-colors">
                <!-- Workflow name & health badges -->
                <td class="py-3 px-4">
                  <div class="font-bold text-neutral-900">{{ w.workflowName }}</div>
                  <div class="text-[11px] text-neutral-500 font-mono">{{ w.workflowId }}</div>
                  <div class="mt-1 flex flex-wrap gap-1">
                    <span
                      v-if="w.hasHighErrorRate"
                      class="inline-flex items-center rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold text-red-800"
                    >
                      Alerta de Error ({{ w.errorRatePercent }}%)
                    </span>
                    <span
                      v-if="w.hasHighComplaintRate"
                      class="inline-flex items-center rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800"
                    >
                      Alerta de Quejas ({{ w.complaintRatePercent }}%)
                    </span>
                    <span
                      v-if="w.hasNegativeMargin"
                      class="inline-flex items-center rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold text-red-800"
                    >
                      Margen Negativo
                    </span>
                  </div>
                </td>

                <!-- Disparos -->
                <td class="py-3 px-3 font-semibold font-mono text-neutral-900">
                  {{ w.triggers }}
                </td>

                <!-- Supresión -->
                <td class="py-3 px-3">
                  <div class="font-semibold text-neutral-700">{{ w.suppressions }}</div>
                  <div class="text-[11px] text-neutral-500">
                    {{ Object.keys(w.suppressionBreakdown).length }} motivos
                  </div>
                </td>

                <!-- Entrega -->
                <td class="py-3 px-3">
                  <div class="font-semibold text-neutral-900">{{ w.deliveries }}</div>
                  <div class="text-[11px] text-neutral-500 font-mono">{{ w.deliveryRatePercent }}%</div>
                </td>

                <!-- Conversión -->
                <td class="py-3 px-3">
                  <div class="font-semibold text-emerald-700">{{ w.conversions }}</div>
                  <div class="text-[11px] text-neutral-500 font-mono">{{ w.conversionRatePercent }}%</div>
                </td>

                <!-- Quejas -->
                <td class="py-3 px-3">
                  <div class="font-semibold" :class="w.complaints > 0 ? 'text-amber-700' : 'text-neutral-500'">
                    {{ w.complaints }}
                  </div>
                  <div class="text-[11px] text-neutral-500 font-mono">{{ w.complaintRatePercent }}%</div>
                </td>

                <!-- Descuento / Margen -->
                <td class="py-3 px-3">
                  <div class="font-bold" :class="w.totalNetMarginCents >= 0 ? 'text-neutral-900' : 'text-red-600'">
                    {{ formatCents(w.totalNetMarginCents) }}
                  </div>
                  <div class="text-[11px] text-neutral-500 flex items-center gap-1">
                    <span>Dto: {{ formatCents(w.totalDiscountCents) }}</span>
                    <span>·</span>
                    <span class="font-mono font-semibold">{{ formatBps(w.marginBasisPoints) }}</span>
                  </div>
                </td>

                <!-- Errores -->
                <td class="py-3 px-3">
                  <div class="font-semibold" :class="w.errors > 0 ? 'text-red-600' : 'text-neutral-500'">
                    {{ w.errors }}
                  </div>
                  <div class="text-[11px] text-neutral-500 font-mono">{{ w.errorRatePercent }}%</div>
                </td>

                <!-- Detalle button -->
                <td class="py-3 px-4 text-right">
                  <button
                    type="button"
                    class="rounded border border-neutral-300 bg-white px-2 py-1 text-[11px] font-semibold text-neutral-700 hover:bg-neutral-50 focus:outline-none"
                    @click="openBreakdown(w)"
                  >
                    Ver desglose
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- Breakdown modal -->
    <div
      v-if="selectedWorkflow"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      @keydown.esc="closeBreakdown"
    >
      <div class="w-full max-w-lg rounded-xl bg-white p-6 shadow-2xl border border-neutral-200 space-y-4">
        <div class="flex items-center justify-between border-b border-neutral-200 pb-3">
          <div>
            <h4 class="text-base font-bold text-neutral-900">{{ selectedWorkflow.workflowName }}</h4>
            <span class="text-xs font-mono text-neutral-500">{{ selectedWorkflow.workflowId }}</span>
          </div>
          <button
            type="button"
            class="rounded-md p-1.5 text-neutral-400 hover:text-neutral-600 focus:outline-none"
            aria-label="Cerrar modal"
            @click="closeBreakdown"
          >
            <span class="i-lucide-x h-5 w-5" />
          </button>
        </div>

        <!-- Suppression Breakdown -->
        <div class="space-y-2">
          <div class="text-xs font-bold uppercase tracking-wider text-neutral-700">
            Desglose de Supresión (Exclusiones Justificadas):
          </div>
          <div
            v-if="Object.keys(selectedWorkflow.suppressionBreakdown).length === 0"
            class="text-xs text-neutral-500 italic p-2 bg-neutral-50 rounded"
          >
            No hay supresiones registradas en este flujo.
          </div>
          <div v-else class="space-y-1">
            <div
              v-for="(count, reason) in selectedWorkflow.suppressionBreakdown"
              :key="reason"
              class="flex items-center justify-between text-xs p-2 rounded bg-neutral-50 border border-neutral-200"
            >
              <span class="font-mono text-neutral-800">{{ reason }}</span>
              <span class="font-bold text-neutral-900">{{ count }}</span>
            </div>
          </div>
        </div>

        <!-- Error Breakdown -->
        <div class="space-y-2">
          <div class="text-xs font-bold uppercase tracking-wider text-neutral-700">Desglose de Errores Técnicos:</div>
          <div
            v-if="Object.keys(selectedWorkflow.errorBreakdown).length === 0"
            class="text-xs text-neutral-500 italic p-2 bg-neutral-50 rounded"
          >
            No hay errores técnicos registrados en este flujo.
          </div>
          <div v-else class="space-y-1">
            <div
              v-for="(count, code) in selectedWorkflow.errorBreakdown"
              :key="code"
              class="flex items-center justify-between text-xs p-2 rounded bg-red-50 border border-red-200"
            >
              <span class="font-mono text-red-900">{{ code }}</span>
              <span class="font-bold text-red-800">{{ count }}</span>
            </div>
          </div>
        </div>

        <!-- Close button -->
        <div class="pt-3 border-t border-neutral-100 text-right">
          <button
            type="button"
            class="rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-neutral-800"
            @click="closeBreakdown"
          >
            Cerrar
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
