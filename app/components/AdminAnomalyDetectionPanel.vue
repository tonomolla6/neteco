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
} from '~~/shared/anomaly-detection'

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
  return code ? `${fallback}. Vuelve a intentarlo.` : fallback
}

const dimensionLabels: Record<string, string> = {
  conversion: 'Ventas',
  payment: 'Pagos',
  stock: 'Stock',
  tracking: 'Medición de visitas',
  data: 'Sincronización de datos'
}
const severityLabels: Record<string, string> = { critical: 'Crítica', warning: 'Aviso', info: 'Informativa' }
const statusLabels: Record<string, string> = {
  open: 'Abierta',
  acknowledged: 'Vista',
  under_investigation: 'En investigación',
  resolved: 'Resuelta',
  dismissed_false_positive: 'Descartada (falsa alarma)'
}

function severityTone(sev: AnomalySeverity): 'danger' | 'warning' | 'info' {
  if (sev === 'critical') return 'danger'
  if (sev === 'warning') return 'warning'
  return 'info'
}

function statusTone(status: AnomalyStatus): 'danger' | 'info' | 'warning' | 'success' | 'neutral' {
  if (status === 'open') return 'danger'
  if (status === 'acknowledged') return 'info'
  if (status === 'under_investigation') return 'warning'
  if (status === 'resolved') return 'success'
  return 'neutral'
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
    errorMessage.value = errorText(err, 'No se han podido cargar las anomalías')
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
    errorMessage.value = errorText(err, 'No se ha podido abrir la anomalía')
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

    notice.value = `Anomalía actualizada: ${statusLabels[res.alert.status] ?? adminHumanize(res.alert.status)}.`
    showDetailModal.value = false
    await loadData()
  } catch (err: unknown) {
    errorMessage.value = errorText(err, 'No se ha podido guardar la revisión')
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

    notice.value = `Avisos de «${dimensionLabels[selectedPolicyDimension.value] ?? selectedPolicyDimension.value}» actualizados.`
    await loadData()
  } catch (err: unknown) {
    errorMessage.value = errorText(err, 'No se han podido guardar los cambios')
  } finally {
    busy.value = false
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
    <UAlert v-if="notice" role="status" color="success" variant="subtle" icon="i-lucide-circle-check" :title="notice" />

    <div class="adm-card adm-tablecard">
      <div class="adm-tablecard__bar">
        <AdminToolbar :searchable="false">
          <label class="sr-only" for="anomaly-filter-dimension">Área</label>
          <select id="anomaly-filter-dimension" v-model="filterDimension" @change="loadData">
            <option value="">Todas las áreas</option>
            <option value="conversion">Ventas</option>
            <option value="payment">Pagos</option>
            <option value="stock">Stock</option>
            <option value="tracking">Medición de visitas</option>
            <option value="data">Sincronización de datos</option>
          </select>
          <label class="sr-only" for="anomaly-filter-severity">Gravedad</label>
          <select id="anomaly-filter-severity" v-model="filterSeverity" @change="loadData">
            <option value="">Cualquier gravedad</option>
            <option value="critical">Crítica</option>
            <option value="warning">Aviso</option>
            <option value="info">Informativa</option>
          </select>
          <label class="sr-only" for="anomaly-filter-status">Estado</label>
          <select id="anomaly-filter-status" v-model="filterStatus" @change="loadData">
            <option value="">Todos los estados</option>
            <option value="open">Abierta</option>
            <option value="acknowledged">Vista</option>
            <option value="under_investigation">En investigación</option>
            <option value="resolved">Resuelta</option>
            <option value="dismissed_false_positive">Descartada (falsa alarma)</option>
          </select>
          <template #actions>
            <AdminButton size="sm" icon="i-lucide-rotate-cw" :loading="loading" :disabled="busy" @click="loadData">
              Actualizar
            </AdminButton>
          </template>
        </AdminToolbar>
      </div>

      <div v-if="loading && alerts.length === 0" class="adm-table-skeleton" aria-busy="true">
        <span class="sr-only">Cargando…</span>
        <div v-for="row in 4" :key="row"><i /><i /><i /><i /></div>
      </div>
      <AdminEmptyState
        v-else-if="alerts.length === 0 && errorMessage"
        variant="error"
        title="No se han podido cargar las anomalías"
        description="Comprueba la conexión y vuelve a intentarlo."
      >
        <AdminButton icon="i-lucide-rotate-cw" @click="loadData">Reintentar</AdminButton>
      </AdminEmptyState>
      <AdminEmptyState
        v-else-if="alerts.length === 0"
        :variant="filterDimension || filterSeverity || filterStatus ? 'filtered' : 'empty'"
        :title="
          filterDimension || filterSeverity || filterStatus
            ? 'Ninguna anomalía con estos filtros'
            : 'No se ha detectado ninguna anomalía'
        "
        description="Avisaremos aquí si caen de golpe las ventas, los pagos, el stock o los datos."
        icon="i-lucide-shield-check"
      />
      <template v-else>
        <div class="adm-table-wrap">
          <table class="adm-table">
            <thead>
              <tr>
                <th scope="col">Área</th>
                <th scope="col">Qué ha pasado</th>
                <th scope="col">Gravedad</th>
                <th scope="col" data-numeric>Caída</th>
                <th scope="col">Estado</th>
                <th scope="col"><span class="sr-only">Acciones</span></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="a in alerts" :key="a.id">
                <td>{{ dimensionLabels[a.dimension] ?? adminHumanize(a.dimension) }}</td>
                <td>
                  <div class="font-semibold text-[var(--text-strong)]">{{ adminHumanize(a.metricName) }}</div>
                  <div class="adm-help">{{ a.summary }}</div>
                </td>
                <td>
                  <AdminBadge :tone="severityTone(a.severity)">
                    {{ severityLabels[a.severity] ?? adminHumanize(a.severity) }}
                  </AdminBadge>
                </td>
                <td data-numeric>
                  <div class="font-semibold text-red-700">−{{ a.deviationPercent }} %</div>
                  <div class="adm-help">Habitual {{ a.baselineValue }} · ahora {{ a.observedValue }}</div>
                </td>
                <td>
                  <AdminBadge :tone="statusTone(a.status)">
                    {{ statusLabels[a.status] ?? adminHumanize(a.status) }}
                  </AdminBadge>
                </td>
                <td class="adm-table__actions">
                  <button
                    type="button"
                    class="adm-btn adm-btn--secondary adm-btn--sm"
                    :disabled="busy"
                    @click="openAlertDetail(a)"
                  >
                    Revisar
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="adm-pagination">
          <p>{{ totalAlerts }} {{ totalAlerts === 1 ? 'anomalía' : 'anomalías' }}</p>
        </div>
      </template>
    </div>

    <AdminCard
      title="Cuándo avisar"
      description="Ajusta la sensibilidad de cada área para no recibir avisos repetidos ni falsas alarmas."
    >
      <div class="adm-form-grid">
        <div class="adm-field">
          <label class="adm-label" for="anomaly-policy-dimension">Área</label>
          <select id="anomaly-policy-dimension" v-model="selectedPolicyDimension" @change="syncPolicyForm">
            <option value="conversion">Ventas</option>
            <option value="payment">Pagos</option>
            <option value="stock">Stock</option>
            <option value="tracking">Medición de visitas</option>
            <option value="data">Sincronización de datos</option>
          </select>
        </div>
        <div class="adm-field">
          <label class="adm-label" for="anomaly-policy-warning">Caída para avisar (%)</label>
          <input id="anomaly-policy-warning" v-model.number="editWarningDrop" type="number" min="1" max="100" />
        </div>
        <div class="adm-field">
          <label class="adm-label" for="anomaly-policy-critical">Caída crítica (%)</label>
          <input id="anomaly-policy-critical" v-model.number="editCriticalDrop" type="number" min="1" max="100" />
        </div>
        <div class="adm-field">
          <label class="adm-label" for="anomaly-policy-sample">Mínimo de operaciones</label>
          <input id="anomaly-policy-sample" v-model.number="editMinSampleSize" type="number" min="1" />
          <p class="adm-help">Con menos actividad no se avisa.</p>
        </div>
        <div class="adm-field">
          <label class="adm-label" for="anomaly-policy-cooldown">Espera entre avisos (min)</label>
          <input id="anomaly-policy-cooldown" v-model.number="editCooldownMinutes" type="number" min="0" />
        </div>
      </div>
      <template #footer>
        <label class="adm-check mr-auto">
          <input v-model="editEnabled" type="checkbox" />
          <span>Vigilar esta área</span>
        </label>
        <button type="button" class="adm-btn adm-btn--primary" :disabled="busy" @click="saveThresholdPolicy">
          Guardar cambios
        </button>
      </template>
    </AdminCard>

    <AdminDrawer v-model:open="showDetailModal" :title="activeRunbook?.title ?? 'Revisar anomalía'" wide>
      <div v-if="activeAlert && activeRunbook" class="adm-stack">
        <div>
          <p class="font-semibold text-[var(--text-strong)]">{{ activeAlert.summary }}</p>
          <p class="adm-help mt-1 flex flex-wrap items-center gap-2">
            Detectada el {{ adminDate(activeAlert.detectedAt, true) }}
            <AdminBadge :tone="severityTone(activeAlert.severity)">
              {{ severityLabels[activeAlert.severity] ?? adminHumanize(activeAlert.severity) }}
            </AdminBadge>
            <AdminBadge :tone="statusTone(activeAlert.status)">
              {{ statusLabels[activeAlert.status] ?? adminHumanize(activeAlert.status) }}
            </AdminBadge>
          </p>
        </div>

        <section>
          <h3>Qué hacer ahora</h3>
          <ul class="mt-1 list-disc space-y-1 pl-5 text-sm">
            <li v-for="(act, idx) in activeRunbook.immediateActions" :key="idx">{{ act }}</li>
          </ul>
        </section>
        <section>
          <h3>Qué comprobar</h3>
          <ul class="mt-1 list-disc space-y-1 pl-5 text-sm">
            <li v-for="(step, idx) in activeRunbook.diagnosticSteps" :key="idx">{{ step }}</li>
          </ul>
        </section>
        <section>
          <h3>Cómo reducir el daño y a quién avisar</h3>
          <ul class="mt-1 list-disc space-y-1 pl-5 text-sm">
            <li v-for="(mit, idx) in activeRunbook.mitigationSteps" :key="idx">{{ mit }}</li>
          </ul>
          <p class="adm-help mt-2">
            Persona de guardia: <strong>{{ activeRunbook.escalationContact }}</strong>
          </p>
        </section>

        <section v-if="activeReviews.length > 0">
          <h3>Revisiones anteriores</h3>
          <ul class="adm-list mt-2">
            <li v-for="rev in activeReviews" :key="rev.id">
              <div class="min-w-0 flex-1">
                <p class="adm-list__title">
                  {{ statusLabels[rev.previousStatus] ?? adminHumanize(rev.previousStatus) }} →
                  {{ statusLabels[rev.newStatus] ?? adminHumanize(rev.newStatus) }}
                </p>
                <p class="text-sm">{{ rev.notes }}</p>
                <p v-if="rev.resolutionAction" class="adm-help">Solución aplicada: {{ rev.resolutionAction }}</p>
              </div>
              <span class="adm-help shrink-0">{{ adminDate(rev.reviewedAt, true) }}</span>
            </li>
          </ul>
        </section>

        <section class="adm-stack">
          <h3>Anotar tu revisión</h3>
          <AdminFormField v-slot="{ id }" label="Qué quieres hacer">
            <select :id="id" v-model="reviewAction" class="w-full">
              <option value="acknowledge">Marcar como vista</option>
              <option value="investigate">Pasar a investigación</option>
              <option value="resolve">Dar por resuelta</option>
              <option value="dismiss">Descartar como falsa alarma</option>
            </select>
          </AdminFormField>
          <AdminFormField v-slot="{ id }" label="Notas" required>
            <textarea
              :id="id"
              v-model="reviewNotes"
              rows="3"
              placeholder="Qué has comprobado, cuál era la causa o por qué la descartas"
              class="w-full"
            ></textarea>
          </AdminFormField>
          <AdminFormField v-if="reviewAction === 'resolve'" v-slot="{ id }" label="Solución aplicada">
            <input
              :id="id"
              v-model="resolutionAction"
              type="text"
              placeholder="Por ejemplo: se cambió a la pasarela de reserva"
              class="w-full"
            />
          </AdminFormField>
        </section>
      </div>
      <template #footer>
        <button type="button" class="adm-btn adm-btn--secondary" @click="showDetailModal = false">Cancelar</button>
        <button type="button" class="adm-btn adm-btn--primary" :disabled="busy || !reviewNotes" @click="submitReview">
          Guardar revisión
        </button>
      </template>
    </AdminDrawer>
  </div>
</template>
