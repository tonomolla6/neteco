<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type {
  AnomalyAlert,
  AnomalyDimension,
  AnomalyPolicy,
  AnomalyReview,
  AnomalyRunbook,
  AnomalySeverity,
  AnomalyStatus
} from '../../shared/anomaly-detection'

const requestFetch = useRequestFetch()

const loading = ref(true)
const busy = ref(false)
const errorMessage = ref('')
const notice = ref('')

const alerts = ref<AnomalyAlert[]>([])
const totalAlerts = ref(0)
const policies = ref<AnomalyPolicy[]>([])
const runbooks = ref<AnomalyRunbook[]>([])

// Filters
const filterDimension = ref<string>('')
const filterSeverity = ref<string>('')
const filterStatus = ref<string>('')

// Active alert detail & review modal
const activeAlert = ref<AnomalyAlert | null>(null)
const activeReviews = ref<AnomalyReview[]>([])
const activeRunbook = ref<AnomalyRunbook | null>(null)
const showDetailModal = ref(false)

// Review form
const reviewAction = ref<'acknowledge' | 'investigate' | 'resolve' | 'dismiss'>('acknowledge')
const reviewNotes = ref('')
const resolutionAction = ref('')

// Threshold policy edit form
const selectedPolicyDimension = ref<AnomalyDimension>('conversion')
const editWarningDrop = ref<number>(25)
const editCriticalDrop = ref<number>(50)
const editMinSampleSize = ref<number>(20)
const editCooldownMinutes = ref<number>(60)
const editEnabled = ref<boolean>(true)

function errorText(error: unknown, fallback: string): string {
  const code = (error as { data?: { error?: { code?: string } } })?.data?.error?.code
  return code ? `${fallback} (${code})` : fallback
}

function severityClass(sev: AnomalySeverity): string {
  if (sev === 'critical') return 'bg-red-100 text-red-800 border-red-200'
  if (sev === 'warning') return 'bg-amber-100 text-amber-800 border-amber-200'
  return 'bg-blue-100 text-blue-800 border-blue-200'
}

function statusClass(status: AnomalyStatus): string {
  if (status === 'open') return 'bg-rose-100 text-rose-800'
  if (status === 'acknowledged') return 'bg-blue-100 text-blue-800'
  if (status === 'under_investigation') return 'bg-purple-100 text-purple-800'
  if (status === 'resolved') return 'bg-emerald-100 text-emerald-800'
  return 'bg-neutral-100 text-neutral-700'
}

async function loadData() {
  loading.value = true
  errorMessage.value = ''
  try {
    const params = new URLSearchParams()
    if (filterDimension.value) params.set('dimension', filterDimension.value)
    if (filterSeverity.value) params.set('severity', filterSeverity.value)
    if (filterStatus.value) params.set('status', filterStatus.value)

    const [alertsRes, polRes, rbRes] = await Promise.all([
      requestFetch(`/api/admin/observability/anomalies/alerts?${params.toString()}`) as Promise<{
        items: AnomalyAlert[]
        total: number
      }>,
      requestFetch('/api/admin/observability/anomalies/policies') as Promise<{ policies: AnomalyPolicy[] }>,
      requestFetch('/api/admin/observability/anomalies/runbooks') as Promise<{ runbooks: AnomalyRunbook[] }>
    ])

    alerts.value = alertsRes?.items ?? []
    totalAlerts.value = alertsRes?.total ?? 0
    policies.value = polRes?.policies ?? []
    runbooks.value = rbRes?.runbooks ?? []

    syncPolicyForm()
  } catch (err: unknown) {
    errorMessage.value = errorText(err, 'Error al cargar alertas de anomalías y políticas')
  } finally {
    loading.value = false
  }
}

function syncPolicyForm() {
  const p = policies.value.find((item) => item.dimension === selectedPolicyDimension.value)
  if (p) {
    editWarningDrop.value = p.warningDropPercent
    editCriticalDrop.value = p.criticalDropPercent
    editMinSampleSize.value = p.minSampleSize
    editCooldownMinutes.value = p.cooldownMinutes
    editEnabled.value = p.enabled
  }
}

async function openAlertDetail(alert: AnomalyAlert) {
  busy.value = true
  errorMessage.value = ''
  try {
    const detail = (await requestFetch(`/api/admin/observability/anomalies/alerts/${alert.id}`)) as {
      alert: AnomalyAlert
      reviews: AnomalyReview[]
      runbook: AnomalyRunbook
    }
    activeAlert.value = detail.alert
    activeReviews.value = detail.reviews
    activeRunbook.value = detail.runbook
    reviewNotes.value = ''
    resolutionAction.value = ''
    reviewAction.value = 'acknowledge'
    showDetailModal.value = true
  } catch (err: unknown) {
    errorMessage.value = errorText(err, 'Error al cargar detalle de la alerta')
  } finally {
    busy.value = false
  }
}

async function submitReview() {
  if (!activeAlert.value || !reviewNotes.value) return
  busy.value = true
  errorMessage.value = ''
  try {
    const body = {
      action: reviewAction.value,
      notes: reviewNotes.value,
      resolutionAction: resolutionAction.value || undefined,
      expectedVersion: activeAlert.value.version,
      idempotencyKey: crypto.randomUUID()
    }

    const res = (await requestFetch(`/api/admin/observability/anomalies/alerts/${activeAlert.value.id}/review`, {
      method: 'POST',
      body
    })) as { alert: AnomalyAlert }

    notice.value = `Alerta ${activeAlert.value.id} actualizada a estado: ${res.alert.status}`
    showDetailModal.value = false
    await loadData()
  } catch (err: unknown) {
    errorMessage.value = errorText(err, 'Error al procesar la revisión de la alerta')
  } finally {
    busy.value = false
  }
}

async function saveThresholdPolicy() {
  const current = policies.value.find((p) => p.dimension === selectedPolicyDimension.value)
  if (!current) return

  busy.value = true
  errorMessage.value = ''
  try {
    const body = {
      warningDropPercent: Number(editWarningDrop.value),
      criticalDropPercent: Number(editCriticalDrop.value),
      minSampleSize: Number(editMinSampleSize.value),
      evaluationWindowMinutes: current.evaluationWindowMinutes,
      cooldownMinutes: Number(editCooldownMinutes.value),
      enabled: Boolean(editEnabled.value),
      expectedVersion: current.version,
      idempotencyKey: crypto.randomUUID()
    }

    await requestFetch(`/api/admin/observability/anomalies/policies/${selectedPolicyDimension.value}`, {
      method: 'PUT',
      body
    })

    notice.value = `Umbrales anti-ruido de ${selectedPolicyDimension.value} actualizados con éxito.`
    await loadData()
  } catch (err: unknown) {
    errorMessage.value = errorText(err, 'Error al guardar política de umbrales')
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
        <h2 class="text-xl font-bold tracking-tight text-neutral-900">
          Detección de Anomalías y Revisión Operativa (DAT-024)
        </h2>
        <p class="text-sm text-neutral-600 mt-1">
          Monitorización de caídas en conversión, pagos, stock, tracking o datos con umbrales anti-ruido y runbooks
          asociados.
        </p>
      </div>
      <button
        type="button"
        class="inline-flex items-center gap-2 rounded-md bg-neutral-900 px-3 py-2 text-xs font-semibold text-white shadow-sm hover:bg-neutral-800 disabled:opacity-50"
        :disabled="loading || busy"
        @click="loadData"
      >
        <span v-if="loading">Actualizando...</span>
        <span v-else>Recargar alertas</span>
      </button>
    </div>

    <!-- Alerts messages -->
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

    <!-- Filters row -->
    <div class="flex flex-wrap gap-4 rounded-lg bg-neutral-50 p-4 border border-neutral-200">
      <div>
        <label class="block text-xs font-medium text-neutral-700 mb-1">Dimensión</label>
        <select
          v-model="filterDimension"
          class="rounded-md border-neutral-300 text-xs shadow-sm focus:border-neutral-900 focus:ring-neutral-900"
          @change="loadData"
        >
          <option value="">Todas las dimensiones</option>
          <option value="conversion">Conversión (checkout/funnel)</option>
          <option value="payment">Pagos (pasarela/denegación)</option>
          <option value="stock">Stock (rotura/descuadre)</option>
          <option value="tracking">Tracking (telemetría/eventos)</option>
          <option value="data">Datos (sincronización/lag)</option>
        </select>
      </div>

      <div>
        <label class="block text-xs font-medium text-neutral-700 mb-1">Severidad</label>
        <select
          v-model="filterSeverity"
          class="rounded-md border-neutral-300 text-xs shadow-sm focus:border-neutral-900 focus:ring-neutral-900"
          @change="loadData"
        >
          <option value="">Todas las severidades</option>
          <option value="critical">Crítica</option>
          <option value="warning">Advertencia</option>
          <option value="info">Informativa</option>
        </select>
      </div>

      <div>
        <label class="block text-xs font-medium text-neutral-700 mb-1">Estado</label>
        <select
          v-model="filterStatus"
          class="rounded-md border-neutral-300 text-xs shadow-sm focus:border-neutral-900 focus:ring-neutral-900"
          @change="loadData"
        >
          <option value="">Todos los estados</option>
          <option value="open">Abierta</option>
          <option value="acknowledged">Reconocida</option>
          <option value="under_investigation">En investigación</option>
          <option value="resolved">Resuelta</option>
          <option value="dismissed_false_positive">Descartada (falso positivo)</option>
        </select>
      </div>
    </div>

    <!-- Alerts Table -->
    <div
      v-if="!loading && alerts.length === 0"
      class="rounded-lg border border-neutral-200 bg-neutral-50 p-8 text-center text-neutral-600"
    >
      No se detectaron alertas de anomalías con los filtros seleccionados.
    </div>

    <div v-if="alerts.length > 0" class="overflow-x-auto rounded-lg border border-neutral-200 shadow-sm bg-white">
      <table class="min-w-full divide-y divide-neutral-200 text-left text-sm">
        <thead class="bg-neutral-50 font-semibold text-neutral-900">
          <tr>
            <th class="px-4 py-3">Dimensión</th>
            <th class="px-4 py-3">Métrica / Resumen</th>
            <th class="px-4 py-3">Severidad</th>
            <th class="px-4 py-3">Desviación</th>
            <th class="px-4 py-3">Runbook</th>
            <th class="px-4 py-3">Estado</th>
            <th class="px-4 py-3 text-right">Acción</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-neutral-200">
          <tr v-for="a in alerts" :key="a.id" class="hover:bg-neutral-50">
            <td class="px-4 py-3 font-semibold uppercase text-xs tracking-wider text-neutral-700">
              {{ a.dimension }}
            </td>
            <td class="px-4 py-3">
              <div class="font-medium text-neutral-900">{{ a.metricName }}</div>
              <div class="text-xs text-neutral-500">{{ a.summary }}</div>
            </td>
            <td class="px-4 py-3">
              <span
                class="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium border"
                :class="severityClass(a.severity)"
              >
                {{ a.severity }}
              </span>
            </td>
            <td class="px-4 py-3 text-neutral-700">
              <div class="font-semibold text-red-700">-{{ a.deviationPercent }}%</div>
              <div class="text-xs text-neutral-500">Base: {{ a.baselineValue }} | Obs: {{ a.observedValue }}</div>
            </td>
            <td class="px-4 py-3">
              <span class="font-mono text-xs text-neutral-700 bg-neutral-100 px-2 py-0.5 rounded">
                {{ a.runbookId }}
              </span>
            </td>
            <td class="px-4 py-3">
              <span
                class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium"
                :class="statusClass(a.status)"
              >
                {{ a.status }}
              </span>
            </td>
            <td class="px-4 py-3 text-right">
              <button
                type="button"
                class="rounded bg-neutral-100 hover:bg-neutral-200 px-2.5 py-1 text-xs font-semibold text-neutral-800 transition"
                @click="openAlertDetail(a)"
              >
                Revisar / Runbook
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Threshold Noise Avoidance Editor -->
    <div class="rounded-lg border border-neutral-200 bg-white p-5 shadow-sm space-y-4">
      <h3 class="text-base font-semibold text-neutral-900">Configuración de Umbrales Anti-Ruido por Dimensión</h3>
      <p class="text-xs text-neutral-600">
        Evita falsos positivos mediante tamaño de muestra mínimo y ventana de cooldown para que no se generen alertas
        repetitivas.
      </p>

      <div class="grid grid-cols-1 sm:grid-cols-5 gap-4">
        <div>
          <label class="block text-xs font-medium text-neutral-700 mb-1">Dimensión</label>
          <select
            v-model="selectedPolicyDimension"
            class="w-full rounded-md border-neutral-300 text-sm shadow-sm focus:border-neutral-900 focus:ring-neutral-900"
            @change="syncPolicyForm"
          >
            <option value="conversion">Conversión</option>
            <option value="payment">Pagos</option>
            <option value="stock">Stock</option>
            <option value="tracking">Tracking</option>
            <option value="data">Datos</option>
          </select>
        </div>

        <div>
          <label class="block text-xs font-medium text-neutral-700 mb-1">Caída Aviso (%)</label>
          <input
            v-model.number="editWarningDrop"
            type="number"
            min="1"
            max="100"
            class="w-full rounded-md border-neutral-300 text-sm shadow-sm"
          />
        </div>

        <div>
          <label class="block text-xs font-medium text-neutral-700 mb-1">Caída Crítica (%)</label>
          <input
            v-model.number="editCriticalDrop"
            type="number"
            min="1"
            max="100"
            class="w-full rounded-md border-neutral-300 text-sm shadow-sm"
          />
        </div>

        <div>
          <label class="block text-xs font-medium text-neutral-700 mb-1">Muestra Mínima</label>
          <input
            v-model.number="editMinSampleSize"
            type="number"
            min="1"
            class="w-full rounded-md border-neutral-300 text-sm shadow-sm"
          />
        </div>

        <div>
          <label class="block text-xs font-medium text-neutral-700 mb-1">Cooldown (min)</label>
          <input
            v-model.number="editCooldownMinutes"
            type="number"
            min="0"
            class="w-full rounded-md border-neutral-300 text-sm shadow-sm"
          />
        </div>
      </div>

      <div class="flex items-center justify-between pt-2">
        <label class="inline-flex items-center gap-2 text-sm text-neutral-700">
          <input v-model="editEnabled" type="checkbox" class="rounded border-neutral-300 text-neutral-900" />
          <span>Detección activada en esta dimensión</span>
        </label>

        <button
          type="button"
          class="rounded-md bg-neutral-900 px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-neutral-800 disabled:opacity-50"
          :disabled="busy"
          @click="saveThresholdPolicy"
        >
          Guardar umbrales anti-ruido
        </button>
      </div>
    </div>

    <!-- Modal Detail & Review Panel -->
    <div
      v-if="showDetailModal && activeAlert && activeRunbook"
      class="fixed inset-0 z-50 flex items-center justify-center bg-neutral-900/50 p-4"
    >
      <div class="max-w-2xl w-full bg-white rounded-xl shadow-xl overflow-hidden flex flex-col max-h-[90vh]">
        <!-- Modal Header -->
        <div class="border-b border-neutral-200 px-6 py-4 flex items-center justify-between bg-neutral-50">
          <div>
            <h3 class="font-bold text-neutral-900 text-lg">
              {{ activeRunbook.title }}
            </h3>
            <span class="text-xs text-neutral-500 font-mono">{{ activeAlert.id }}</span>
          </div>
          <button
            type="button"
            class="text-neutral-400 hover:text-neutral-600 font-bold text-lg"
            @click="showDetailModal = false"
          >
            ✕
          </button>
        </div>

        <!-- Modal Body -->
        <div class="p-6 overflow-y-auto space-y-6 text-sm">
          <!-- Summary info -->
          <div class="rounded-lg bg-neutral-50 p-4 border border-neutral-200 space-y-1">
            <div class="font-semibold text-neutral-900">{{ activeAlert.summary }}</div>
            <div class="text-xs text-neutral-600">
              Detectada: {{ activeAlert.detectedAt }} | Severidad:
              <span class="font-semibold uppercase">{{ activeAlert.severity }}</span> | Estado:
              <span class="font-semibold uppercase">{{ activeAlert.status }}</span>
            </div>
          </div>

          <!-- Runbook Guidance -->
          <div class="space-y-3">
            <h4 class="font-bold text-neutral-900 text-xs uppercase tracking-wider text-emerald-800">
              Instrucciones Inmediatas del Runbook ({{ activeRunbook.runbookId }})
            </h4>
            <ul class="list-disc pl-5 space-y-1 text-xs text-neutral-700">
              <li v-for="(act, idx) in activeRunbook.immediateActions" :key="idx">
                {{ act }}
              </li>
            </ul>

            <h4 class="font-bold text-neutral-900 text-xs uppercase tracking-wider text-purple-800 pt-2">
              Verificaciones de Diagnóstico
            </h4>
            <ul class="list-disc pl-5 space-y-1 text-xs text-neutral-700">
              <li v-for="(step, idx) in activeRunbook.diagnosticSteps" :key="idx">
                {{ step }}
              </li>
            </ul>

            <h4 class="font-bold text-neutral-900 text-xs uppercase tracking-wider text-blue-800 pt-2">
              Protocolo de Mitigación y Escalado
            </h4>
            <ul class="list-disc pl-5 space-y-1 text-xs text-neutral-700">
              <li v-for="(mit, idx) in activeRunbook.mitigationSteps" :key="idx">
                {{ mit }}
              </li>
            </ul>
            <div class="text-xs text-neutral-500 pt-1">
              Contacto de guardia: <span class="font-mono text-neutral-800">{{ activeRunbook.escalationContact }}</span>
            </div>
          </div>

          <!-- Review History -->
          <div v-if="activeReviews.length > 0" class="space-y-2 border-t border-neutral-200 pt-4">
            <h4 class="font-bold text-xs uppercase tracking-wider text-neutral-700">
              Historial de Revisiones Realizadas
            </h4>
            <div class="space-y-2">
              <div
                v-for="rev in activeReviews"
                :key="rev.id"
                class="rounded bg-neutral-50 p-2.5 text-xs border border-neutral-200 space-y-1"
              >
                <div class="flex justify-between font-semibold text-neutral-800">
                  <span>Acción: {{ rev.action }} ({{ rev.previousStatus }} → {{ rev.newStatus }})</span>
                  <span class="text-neutral-500 font-mono">{{ rev.reviewedAt }}</span>
                </div>
                <div class="text-neutral-700">{{ rev.notes }}</div>
                <div v-if="rev.resolutionAction" class="text-emerald-700 font-medium">
                  Acción técnica: {{ rev.resolutionAction }}
                </div>
              </div>
            </div>
          </div>

          <!-- Operator Review Action Form -->
          <div class="border-t border-neutral-200 pt-4 space-y-3">
            <h4 class="font-bold text-xs uppercase tracking-wider text-neutral-900">
              Registrar Acción de Revisión Operativa
            </h4>

            <div>
              <label class="block text-xs font-medium text-neutral-700 mb-1">Acción</label>
              <select v-model="reviewAction" class="w-full rounded-md border-neutral-300 text-sm shadow-sm">
                <option value="acknowledge">Reconocer alerta (Acknowledge)</option>
                <option value="investigate">Poner en investigación (Investigate)</option>
                <option value="resolve">Resolver incidencia (Resolve)</option>
                <option value="dismiss">Descartar como falso positivo (Dismiss)</option>
              </select>
            </div>

            <div>
              <label class="block text-xs font-medium text-neutral-700 mb-1">Notas de la Revisión *</label>
              <textarea
                v-model="reviewNotes"
                rows="3"
                placeholder="Explica las comprobaciones realizadas, causa raíz o motivo del descarte..."
                class="w-full rounded-md border-neutral-300 text-sm shadow-sm"
              ></textarea>
            </div>

            <div v-if="reviewAction === 'resolve'">
              <label class="block text-xs font-medium text-neutral-700 mb-1">Acción Técnica de Resolución</label>
              <input
                v-model="resolutionAction"
                type="text"
                placeholder="ej: failover_gateway_activated, cache_flushed, etc."
                class="w-full rounded-md border-neutral-300 text-sm shadow-sm"
              />
            </div>
          </div>
        </div>

        <!-- Modal Footer -->
        <div class="border-t border-neutral-200 px-6 py-4 flex justify-end gap-3 bg-neutral-50">
          <button
            type="button"
            class="rounded-md border border-neutral-300 bg-white px-4 py-2 text-xs font-semibold text-neutral-700 hover:bg-neutral-50"
            @click="showDetailModal = false"
          >
            Cerrar
          </button>
          <button
            type="button"
            class="rounded-md bg-neutral-900 px-4 py-2 text-xs font-semibold text-white hover:bg-neutral-800 disabled:opacity-50"
            :disabled="busy || !reviewNotes"
            @click="submitReview"
          >
            Guardar revisión
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
