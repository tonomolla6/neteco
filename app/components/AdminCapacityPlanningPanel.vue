<script setup lang="ts">
import { ref, onMounted } from 'vue'

const requestFetch = useRequestFetch()

interface CapacityMetric {
  resourceKey: string
  quotaLimit: number
  currentBaseline: number
  unit: string
  costPerMillionUnits: number
  headroomPercent: number
  updatedAt: string
}

interface CapacityBottleneck {
  resourceKey: string
  unit: string
  baseline: number
  projectedPeak: number
  quotaLimit: number
  headroomPercent: number
  status: 'healthy' | 'warning' | 'critical'
  recommendedMitigation?: string
}

interface CampaignPlanRecord {
  id: string
  campaignName: string
  startTime: string
  endTime: string
  projectedPeakMultiplier: number
  projectedVisitorsPeak: number
  projectedOrdersHour: number
  status: string
  headroomVerdict: string
  minHeadroomPercent: number
  minHeadroomResource: string
  estimatedCloudflareCostEur: number
  bottlenecks: CapacityBottleneck[]
  mitigations: string[]
  version: number
  createdAt: string
}

const loading = ref(false)
const simulating = ref(false)
const approving = ref(false)
const errorMessage = ref('')
const successMessage = ref('')

const metrics = ref<CapacityMetric[]>([])
const plans = ref<CampaignPlanRecord[]>([])
const activeSimulation = ref<CampaignPlanRecord | null>(null)

const simForm = ref({
  campaignName: '',
  startTime: '2026-11-27T00:00:00Z',
  endTime: '2026-11-29T23:59:59Z',
  projectedPeakMultiplier: 3.0,
  projectedVisitorsPeak: 10000,
  projectedOrdersHour: 300
})

const metricLabels: Record<string, string> = {
  worker_cpu_ms: 'Workers: CPU ms / Solicitud',
  worker_subrequests: 'Workers: Subrequests por Solicitud',
  d1_rows_read_daily: 'D1: Filas Leídas al Día',
  d1_rows_written_daily: 'D1: Filas Escritas al Día',
  d1_storage_bytes: 'D1: Almacenamiento Base de Datos',
  do_connections_hotspot: 'Durable Objects: Conexiones Hotspot',
  r2_class_a_operations_monthly: 'R2: Operaciones Clase A (Escrituras)',
  r2_class_b_operations_monthly: 'R2: Operaciones Clase B (Lecturas)',
  r2_storage_bytes: 'R2: Almacenamiento de Objetos',
  queues_backlog_messages: 'Queues: Mensajes en Backlog',
  workflows_active_instances: 'Workflows: Instancias Concurrentes',
  cdn_edge_bandwidth_gb: 'CDN: Ancho de Banda Edge (GB)',
  provider_redsys_tps: 'Pasarela Redsys: TPS Máximo',
  provider_beply_rate_limit: 'ERP Beply: Rate Limit Peticiones/min'
}

function formatResourceValue(key: string, val: number): string {
  if (key.includes('bytes')) {
    return (val / (1024 * 1024 * 1024)).toFixed(2) + ' GB'
  }
  if (val >= 1000000) {
    return (val / 1000000).toFixed(1) + 'M'
  }
  if (val >= 1000) {
    return (val / 1000).toFixed(1) + 'k'
  }
  return val.toString()
}

async function loadData() {
  loading.value = true
  errorMessage.value = ''
  try {
    const resMetrics = (await requestFetch('/api/admin/observability/capacity/metrics')) as {
      metrics: CapacityMetric[]
    }
    metrics.value = resMetrics?.metrics ?? []

    const resPlans = (await requestFetch('/api/admin/observability/capacity/plans')) as { plans: CampaignPlanRecord[] }
    plans.value = resPlans?.plans ?? []
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : 'Error al cargar capacidad Cloudflare'
  } finally {
    loading.value = false
  }
}

async function handleSimulate() {
  if (!simForm.value.campaignName.trim()) {
    errorMessage.value = 'El nombre de la campaña es obligatorio'
    return
  }
  simulating.value = true
  errorMessage.value = ''
  successMessage.value = ''
  try {
    const res = (await requestFetch('/api/admin/observability/capacity/simulate', {
      method: 'POST',
      body: {
        commandId: crypto.randomUUID(),
        idempotencyKey: `sim-${Date.now()}-${simForm.value.campaignName}`,
        campaignName: simForm.value.campaignName.trim(),
        startTime: simForm.value.startTime,
        endTime: simForm.value.endTime,
        projectedPeakMultiplier: Number(simForm.value.projectedPeakMultiplier),
        projectedVisitorsPeak: Number(simForm.value.projectedVisitorsPeak),
        projectedOrdersHour: Number(simForm.value.projectedOrdersHour)
      }
    })) as { plan: CampaignPlanRecord }

    activeSimulation.value = res.plan
    if (res.plan.status === 'simulated_passed') {
      successMessage.value = `Simulación superada: Headroom seguro (mínimo ${res.plan.minHeadroomPercent}%).`
    } else if (res.plan.status === 'simulated_warning') {
      errorMessage.value = `Advertencia de capacidad: Margen bajo en ${metricLabels[res.plan.minHeadroomResource] || res.plan.minHeadroomResource} (${res.plan.minHeadroomPercent}%). Revise mitigaciones.`
    } else {
      errorMessage.value = `Simulación FALLIDA: Cuota agotada en ${metricLabels[res.plan.minHeadroomResource] || res.plan.minHeadroomResource}. La campaña superará límites operativos.`
    }
    await loadData()
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : 'Error al ejecutar simulación de capacidad'
  } finally {
    simulating.value = false
  }
}

async function handleApprove(plan: CampaignPlanRecord) {
  approving.value = true
  errorMessage.value = ''
  successMessage.value = ''
  try {
    await requestFetch('/api/admin/observability/capacity/plans/approve', {
      method: 'POST',
      body: {
        commandId: crypto.randomUUID(),
        idempotencyKey: `approve-${Date.now()}-${plan.id}`,
        planId: plan.id,
        expectedVersion: plan.version
      }
    })
    successMessage.value = `Plan de campaña "${plan.campaignName}" aprobado formalmente.`
    await loadData()
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : 'Error al aprobar plan de capacidad'
  } finally {
    approving.value = false
  }
}

onMounted(() => {
  loadData()
})
</script>

<template>
  <div class="space-y-6">
    <!-- Messages -->
    <div v-if="errorMessage" role="alert" class="rounded bg-red-100 p-3 text-sm text-red-700">
      {{ errorMessage }}
    </div>
    <div v-if="successMessage" role="status" class="rounded bg-emerald-100 p-3 text-sm text-emerald-700">
      {{ successMessage }}
    </div>

    <!-- Cloudflare & Provider Quotas Matrix -->
    <div class="rounded-lg border border-neutral-200 bg-white p-5 shadow-sm">
      <div class="flex items-center justify-between mb-4">
        <div>
          <h3 class="text-base font-semibold text-neutral-900">
            Cuotas y Headroom de Infraestructura Cloudflare & Proveedores
          </h3>
          <p class="text-xs text-neutral-600">
            Supervisión continua de límites de Workers, D1, Durable Objects, R2, Queues y pasarelas externas.
          </p>
        </div>
        <button class="text-xs text-blue-600 hover:text-blue-800 underline" @click="loadData">Actualizar</button>
      </div>

      <div v-if="loading" class="text-sm text-neutral-500 py-4 text-center">Cargando cuotas y baselines...</div>
      <div v-else class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div
          v-for="m in metrics"
          :key="m.resourceKey"
          class="rounded border border-neutral-200 bg-neutral-50/50 p-3 text-xs"
        >
          <div class="flex justify-between font-medium text-neutral-800 mb-1">
            <span>{{ metricLabels[m.resourceKey] || m.resourceKey }}</span>
            <span class="font-semibold" :class="m.headroomPercent < 20 ? 'text-amber-700' : 'text-emerald-700'">
              {{ m.headroomPercent.toFixed(1) }}% margen
            </span>
          </div>

          <div class="text-neutral-500 flex justify-between">
            <span>Línea base: {{ formatResourceValue(m.resourceKey, m.currentBaseline) }}</span>
            <span>Cuota: {{ formatResourceValue(m.resourceKey, m.quotaLimit) }}</span>
          </div>

          <div class="mt-2 h-1.5 w-full bg-neutral-200 rounded-full overflow-hidden">
            <div
              class="h-full rounded-full transition-all duration-300"
              :class="m.headroomPercent < 20 ? 'bg-amber-500' : 'bg-emerald-600'"
              :style="{ width: `${Math.min(100, Math.max(0, m.headroomPercent))}%` }"
            />
          </div>
        </div>
      </div>
    </div>

    <!-- Pre-campaign Simulation Form (Prueba antes de campañas) -->
    <div class="rounded-lg border border-neutral-200 bg-white p-5 shadow-sm">
      <h3 class="text-base font-semibold text-neutral-900 mb-1">
        Prueba de Capacidad Pre-Campaña (Simulación de Carga Pico)
      </h3>
      <p class="text-xs text-neutral-600 mb-4">
        Modela el tráfico proyectado (multiplicador, visitantes pico, pedidos/hora) para verificar cuotas antes de
        lanzar promociones o campañas masivas.
      </p>

      <form class="grid gap-4 sm:grid-cols-3" @submit.prevent="handleSimulate">
        <div>
          <label class="block text-xs font-medium text-neutral-700 mb-1" for="campaign-name">
            Nombre de la Campaña
          </label>
          <input
            id="campaign-name"
            v-model="simForm.campaignName"
            type="text"
            placeholder="Ej. Black Friday 2026 / Campaña Piscinas"
            class="w-full rounded border border-neutral-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
          />
        </div>

        <div>
          <label class="block text-xs font-medium text-neutral-700 mb-1" for="sim-multiplier">
            Multiplicador sobre Baseline
          </label>
          <input
            id="sim-multiplier"
            v-model.number="simForm.projectedPeakMultiplier"
            type="number"
            step="0.5"
            min="1.0"
            max="30.0"
            class="w-full rounded border border-neutral-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
          />
        </div>

        <div>
          <label class="block text-xs font-medium text-neutral-700 mb-1" for="sim-visitors">
            Visitantes Concurrentes Pico
          </label>
          <input
            id="sim-visitors"
            v-model.number="simForm.projectedVisitorsPeak"
            type="number"
            min="100"
            step="500"
            class="w-full rounded border border-neutral-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
          />
        </div>

        <div>
          <label class="block text-xs font-medium text-neutral-700 mb-1" for="sim-orders">
            Pedidos Proyectados / Hora
          </label>
          <input
            id="sim-orders"
            v-model.number="simForm.projectedOrdersHour"
            type="number"
            min="0"
            step="20"
            class="w-full rounded border border-neutral-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
          />
        </div>

        <div class="sm:col-span-2 flex items-end justify-end">
          <button
            type="submit"
            :disabled="simulating"
            class="rounded bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {{ simulating ? 'Simulando...' : 'Ejecutar Prueba de Capacidad' }}
          </button>
        </div>
      </form>
    </div>

    <!-- Active Simulation Results -->
    <div
      v-if="activeSimulation"
      class="rounded-lg border p-5 shadow-sm"
      :class="{
        'border-emerald-300 bg-emerald-50/40': activeSimulation.headroomVerdict === 'healthy',
        'border-amber-300 bg-amber-50/40': activeSimulation.headroomVerdict === 'warning_headroom_low',
        'border-red-300 bg-red-50/40': activeSimulation.headroomVerdict === 'critical_quota_exhausted'
      }"
    >
      <div class="flex items-start justify-between">
        <div>
          <h4 class="text-base font-semibold text-neutral-900">
            Resultado de Prueba: {{ activeSimulation.campaignName }}
          </h4>
          <p class="text-xs text-neutral-600 mt-0.5">
            Veredicto:
            <strong
              :class="{
                'text-emerald-700': activeSimulation.headroomVerdict === 'healthy',
                'text-amber-700': activeSimulation.headroomVerdict === 'warning_headroom_low',
                'text-red-700': activeSimulation.headroomVerdict === 'critical_quota_exhausted'
              }"
            >
              {{
                activeSimulation.headroomVerdict === 'healthy'
                  ? 'Apto para Lanzamiento (Healthy)'
                  : activeSimulation.headroomVerdict === 'warning_headroom_low'
                    ? 'Advertencia de Margen Reducido'
                    : 'Crítico: Excede Cuotas Operativas'
              }}
            </strong>
            | Coste estimado Cloudflare: <strong>{{ activeSimulation.estimatedCloudflareCostEur }} €/mes</strong>
          </p>
        </div>

        <button
          v-if="activeSimulation.status !== 'approved' && activeSimulation.status !== 'simulated_failed'"
          :disabled="approving"
          class="rounded bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
          @click="handleApprove(activeSimulation)"
        >
          {{ approving ? 'Aprobando...' : 'Aprobar Plan de Capacidad' }}
        </button>
      </div>

      <!-- Actionable Mitigations if any -->
      <div v-if="activeSimulation.mitigations.length > 0" class="mt-4 rounded border border-amber-200 bg-amber-50 p-3">
        <h5 class="text-xs font-semibold text-amber-900 mb-1">
          Mitigaciones Operativas Recomendadas Antes del Lanzamiento:
        </h5>
        <ul class="list-disc list-inside text-xs text-amber-800 space-y-1">
          <li v-for="(mit, idx) in activeSimulation.mitigations" :key="idx">
            {{ mit }}
          </li>
        </ul>
      </div>
    </div>

    <!-- Plans History -->
    <div class="rounded-lg border border-neutral-200 bg-white p-5 shadow-sm">
      <h3 class="text-base font-semibold text-neutral-900 mb-4">Planes de Capacidad y Pruebas Registradas</h3>
      <div v-if="plans.length === 0" class="text-sm text-neutral-500 text-center py-4">
        No hay planes de capacidad previos registrados.
      </div>
      <div v-else class="overflow-x-auto">
        <table class="min-w-full divide-y divide-neutral-200 text-left text-xs">
          <thead>
            <tr class="bg-neutral-50 text-neutral-600 font-medium">
              <th class="px-3 py-2">Campaña</th>
              <th class="px-3 py-2">Multiplicador</th>
              <th class="px-3 py-2">Visitantes Pico</th>
              <th class="px-3 py-2">Veredicto Headroom</th>
              <th class="px-3 py-2">Mín. Margen</th>
              <th class="px-3 py-2">Coste Proyectado</th>
              <th class="px-3 py-2">Estado</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-neutral-100">
            <tr v-for="p in plans" :key="p.id" class="hover:bg-neutral-50/50">
              <td class="px-3 py-2 font-medium text-neutral-900">{{ p.campaignName }}</td>
              <td class="px-3 py-2 font-semibold">{{ p.projectedPeakMultiplier }}x</td>
              <td class="px-3 py-2">{{ p.projectedVisitorsPeak.toLocaleString() }}</td>
              <td class="px-3 py-2">
                <span
                  class="px-2 py-0.5 rounded text-xs font-semibold"
                  :class="{
                    'bg-emerald-100 text-emerald-800': p.headroomVerdict === 'healthy',
                    'bg-amber-100 text-amber-800': p.headroomVerdict === 'warning_headroom_low',
                    'bg-red-100 text-red-800': p.headroomVerdict === 'critical_quota_exhausted'
                  }"
                >
                  {{
                    p.headroomVerdict === 'healthy'
                      ? 'Saludable'
                      : p.headroomVerdict === 'warning_headroom_low'
                        ? 'Margen Ajustado'
                        : 'Cuota Superada'
                  }}
                </span>
              </td>
              <td class="px-3 py-2 font-mono">{{ p.minHeadroomPercent }}%</td>
              <td class="px-3 py-2">{{ p.estimatedCloudflareCostEur }} €</td>
              <td class="px-3 py-2 capitalize font-semibold text-neutral-700">
                {{ p.status === 'approved' ? 'Aprobado' : p.status.replace('_', ' ') }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
