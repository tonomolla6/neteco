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
  worker_cpu_ms: 'Tiempo de cálculo por visita',
  worker_subrequests: 'Consultas internas por visita',
  d1_rows_read_daily: 'Lecturas diarias de la base de datos',
  d1_rows_written_daily: 'Escrituras diarias de la base de datos',
  d1_storage_bytes: 'Espacio de la base de datos',
  do_connections_hotspot: 'Conexiones simultáneas',
  r2_class_a_operations_monthly: 'Subidas de archivos al mes',
  r2_class_b_operations_monthly: 'Descargas de archivos al mes',
  r2_storage_bytes: 'Espacio de archivos e imágenes',
  queues_backlog_messages: 'Tareas en espera',
  workflows_active_instances: 'Procesos simultáneos',
  cdn_edge_bandwidth_gb: 'Tráfico de datos (GB)',
  provider_redsys_tps: 'Pagos por segundo (Redsys)',
  provider_beply_rate_limit: 'Peticiones por minuto al ERP (Beply)'
}
const verdictLabels: Record<string, string> = {
  healthy: 'Lista para lanzar',
  warning_headroom_low: 'Margen ajustado',
  critical_quota_exhausted: 'Supera los límites'
}
const verdictTones: Record<string, 'success' | 'warning' | 'danger'> = {
  healthy: 'success',
  warning_headroom_low: 'warning',
  critical_quota_exhausted: 'danger'
}
const planStatusLabels: Record<string, string> = {
  approved: 'Aprobado',
  simulated_passed: 'Prueba superada',
  simulated_warning: 'Prueba con avisos',
  simulated_failed: 'Prueba no superada'
}

function formatResourceValue(key: string, val: number): string {
  if (key.includes('bytes')) {
    return (val / (1024 * 1024 * 1024)).toFixed(2) + ' GB'
  }
  if (val >= 1000000) {
    return (val / 1000000).toFixed(1) + ' M'
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
    errorMessage.value =
      err instanceof Error ? err.message : 'No se ha podido cargar el uso de los recursos. Vuelve a intentarlo.'
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
      successMessage.value = `Prueba superada: queda margen suficiente (mínimo ${res.plan.minHeadroomPercent} %).`
    } else if (res.plan.status === 'simulated_warning') {
      errorMessage.value = `Margen ajustado en «${metricLabels[res.plan.minHeadroomResource] || adminHumanize(res.plan.minHeadroomResource)}» (${res.plan.minHeadroomPercent} %). Revisa las recomendaciones.`
    } else {
      errorMessage.value = `Prueba no superada: la campaña agotaría «${metricLabels[res.plan.minHeadroomResource] || adminHumanize(res.plan.minHeadroomResource)}».`
    }
    await loadData()
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : 'No se ha podido hacer la prueba. Vuelve a intentarlo.'
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
    successMessage.value = `Plan de la campaña «${plan.campaignName}» aprobado.`
    await loadData()
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : 'No se ha podido aprobar el plan. Vuelve a intentarlo.'
  } finally {
    approving.value = false
  }
}

onMounted(() => {
  loadData()
})
</script>

<template>
  <div class="adm-stack">
    <UAlert
      v-if="errorMessage"
      role="alert"
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="errorMessage"
    />
    <UAlert
      v-if="successMessage"
      role="status"
      color="success"
      variant="subtle"
      icon="i-lucide-circle-check"
      :title="successMessage"
    />

    <AdminSection
      title="Uso de los recursos"
      description="Cuánto margen queda en cada recurso de la tienda y de los proveedores externos."
    >
      <template #actions>
        <AdminButton size="sm" icon="i-lucide-rotate-cw" :loading="loading" @click="loadData">Actualizar</AdminButton>
      </template>
      <div v-if="loading && !metrics.length" class="adm-table-skeleton" aria-busy="true">
        <span class="sr-only">Cargando…</span>
        <div v-for="row in 3" :key="row"><i /><i /><i /></div>
      </div>
      <AdminEmptyState
        v-else-if="!metrics.length && errorMessage"
        variant="error"
        title="No se ha podido cargar el uso de los recursos"
        description="Comprueba la conexión y vuelve a intentarlo."
      >
        <AdminButton icon="i-lucide-rotate-cw" @click="loadData">Reintentar</AdminButton>
      </AdminEmptyState>
      <AdminEmptyState v-else-if="!metrics.length" title="Todavía no hay mediciones" icon="i-lucide-gauge" />
      <div v-else class="adm-grid">
        <AdminCard v-for="m in metrics" :key="m.resourceKey" as="article">
          <div class="flex items-start justify-between gap-2">
            <span class="font-semibold text-[var(--text-strong)]">
              {{ metricLabels[m.resourceKey] || adminHumanize(m.resourceKey) }}
            </span>
            <AdminBadge :tone="m.headroomPercent < 20 ? 'warning' : 'success'">
              {{ m.headroomPercent.toFixed(1) }} % libre
            </AdminBadge>
          </div>
          <div class="mt-2 flex justify-between gap-3 text-xs text-[var(--text-muted)]">
            <span>Uso habitual: {{ formatResourceValue(m.resourceKey, m.currentBaseline) }}</span>
            <span>Límite: {{ formatResourceValue(m.resourceKey, m.quotaLimit) }}</span>
          </div>
          <div class="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface-sunken)]">
            <div
              class="h-full rounded-full bg-neteco-600"
              :style="{ width: `${Math.min(100, Math.max(0, m.headroomPercent))}%` }"
            />
          </div>
        </AdminCard>
      </div>
    </AdminSection>

    <AdminCard
      title="Probar una campaña antes de lanzarla"
      description="Indica el tráfico que esperas y comprueba si la tienda lo aguanta antes de una promoción grande."
    >
      <form class="adm-form-grid" @submit.prevent="handleSimulate">
        <div class="adm-field">
          <label class="adm-label" for="campaign-name">Nombre de la campaña</label>
          <input
            id="campaign-name"
            v-model="simForm.campaignName"
            type="text"
            placeholder="Por ejemplo: Black Friday 2026"
          />
        </div>
        <div class="adm-field">
          <label class="adm-label" for="sim-multiplier">Veces el tráfico habitual</label>
          <input
            id="sim-multiplier"
            v-model.number="simForm.projectedPeakMultiplier"
            type="number"
            step="0.5"
            min="1.0"
            max="30.0"
          />
        </div>
        <div class="adm-field">
          <label class="adm-label" for="sim-visitors">Visitantes a la vez en el pico</label>
          <input id="sim-visitors" v-model.number="simForm.projectedVisitorsPeak" type="number" min="100" step="500" />
        </div>
        <div class="adm-field">
          <label class="adm-label" for="sim-orders">Pedidos previstos por hora</label>
          <input id="sim-orders" v-model.number="simForm.projectedOrdersHour" type="number" min="0" step="20" />
        </div>
        <div class="flex items-end">
          <button type="submit" :disabled="simulating" class="adm-btn adm-btn--primary">
            {{ simulating ? 'Probando…' : 'Probar campaña' }}
          </button>
        </div>
      </form>
    </AdminCard>

    <AdminCard v-if="activeSimulation" :title="`Resultado de la prueba: ${activeSimulation.campaignName}`">
      <template #actions>
        <button
          v-if="activeSimulation.status !== 'approved' && activeSimulation.status !== 'simulated_failed'"
          type="button"
          :disabled="approving"
          class="adm-btn adm-btn--secondary adm-btn--sm"
          @click="handleApprove(activeSimulation)"
        >
          {{ approving ? 'Aprobando…' : 'Aprobar plan' }}
        </button>
      </template>
      <div class="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <AdminBadge :tone="verdictTones[activeSimulation.headroomVerdict] ?? 'neutral'">
          {{ verdictLabels[activeSimulation.headroomVerdict] ?? adminHumanize(activeSimulation.headroomVerdict) }}
        </AdminBadge>
        <span>
          Coste estimado: <strong>{{ activeSimulation.estimatedCloudflareCostEur }} €/mes</strong>
        </span>
      </div>
      <div v-if="activeSimulation.mitigations.length > 0" class="mt-4">
        <h3>Qué conviene hacer antes del lanzamiento</h3>
        <ul class="mt-1 list-disc space-y-1 pl-5 text-sm">
          <li v-for="(mit, idx) in activeSimulation.mitigations" :key="idx">{{ mit }}</li>
        </ul>
      </div>
    </AdminCard>

    <AdminCard title="Pruebas anteriores" flush>
      <AdminEmptyState
        v-if="plans.length === 0"
        compact
        title="Todavía no se ha probado ninguna campaña"
        icon="i-lucide-history"
      />
      <div v-else class="adm-table-wrap">
        <table class="adm-table">
          <thead>
            <tr>
              <th scope="col">Campaña</th>
              <th scope="col" data-numeric>Tráfico</th>
              <th scope="col" data-numeric>Visitantes en el pico</th>
              <th scope="col">Resultado</th>
              <th scope="col" data-numeric>Margen mínimo</th>
              <th scope="col" data-numeric>Coste previsto</th>
              <th scope="col">Estado</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in plans" :key="p.id">
              <td class="font-semibold text-[var(--text-strong)]">{{ p.campaignName }}</td>
              <td data-numeric>×{{ p.projectedPeakMultiplier }}</td>
              <td data-numeric>{{ p.projectedVisitorsPeak.toLocaleString('es-ES') }}</td>
              <td>
                <AdminBadge :tone="verdictTones[p.headroomVerdict] ?? 'neutral'">
                  {{ verdictLabels[p.headroomVerdict] ?? adminHumanize(p.headroomVerdict) }}
                </AdminBadge>
              </td>
              <td data-numeric>{{ p.minHeadroomPercent }} %</td>
              <td data-numeric>{{ p.estimatedCloudflareCostEur }} €</td>
              <td>{{ planStatusLabels[p.status] ?? adminHumanize(p.status) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </AdminCard>
  </div>
</template>
