<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import { type GameDayScenarioId, type GameDayRunbook, GAME_DAY_RUNBOOKS } from '~~/shared/game-day-resilience'

interface ScenarioResult {
  id: string
  scenarioId: GameDayScenarioId
  targetDetectionSeconds: number
  actualDetectionSeconds: number
  targetRecoverySeconds: number
  actualRecoverySeconds: number
  targetDataLossSeconds: number
  actualDataLossSeconds: number
  alertTriggered: boolean
  alertSeverity: 'warning' | 'critical'
  alertChannel: 'slack_sre' | 'pagerduty' | 'email_ops'
  rollbackRestoreStatus: 'not_needed' | 'rollback_executed' | 'restore_completed' | 'failed'
  coordinationStatus: 'completed' | 'delayed' | 'failed'
  runbookReference: string
  status: 'passed' | 'warning' | 'failed'
  evaluatedAt: string
}

interface Drill {
  id: string
  cohort: string
  status: 'in_progress' | 'passed' | 'warning' | 'failed' | 'aborted'
  expansionGate: 'pending' | 'approved' | 'blocked' | 'conditional'
  leadEngineerId: string
  scenariosTotal: number
  scenariosPassed: number
  scenariosFailed: number
  version: number
  notes: string
  startedAt: string
  completedAt: string | null
  scenarios?: ScenarioResult[]
}

interface GateStatus {
  status: 'pending' | 'approved' | 'blocked' | 'conditional'
  approved: boolean
  latestDrillId: string | null
  completedAt: string | null
  freshnessDays: number | null
  scenariosTotal: number
  scenariosPassed: number
  scenariosFailed: number
  reasons: string[]
}

const SCENARIO_LABELS: Record<GameDayScenarioId, string> = {
  beply_outage: 'Caída del ERP (Beply)',
  carrier_outage: 'Caída del transportista',
  d1_outage: 'Caída de la base de datos',
  durable_object_outage: 'Caída de las conexiones en directo',
  queue_outage: 'Saturación de las tareas en espera',
  r2_outage: 'Caída del almacén de archivos',
  worker_deployment_failure: 'Fallo al publicar una versión'
}
const RESULT_LABELS: Record<string, string> = {
  in_progress: 'En curso',
  passed: 'Superado',
  warning: 'Con avisos',
  failed: 'No superado',
  aborted: 'Interrumpido'
}
const RESULT_TONES: Record<string, 'info' | 'success' | 'warning' | 'danger' | 'neutral'> = {
  in_progress: 'info',
  passed: 'success',
  warning: 'warning',
  failed: 'danger',
  aborted: 'neutral'
}
const CHANNEL_LABELS: Record<ScenarioResult['alertChannel'], string> = {
  slack_sre: 'Chat del equipo técnico',
  pagerduty: 'Aviso de guardia',
  email_ops: 'Correo de operaciones'
}
const RESTORE_LABELS: Record<ScenarioResult['rollbackRestoreStatus'], string> = {
  not_needed: 'No hizo falta',
  rollback_executed: 'Se volvió a la versión anterior',
  restore_completed: 'Datos restaurados',
  failed: 'Falló'
}

const request = useRequestFetch()
const loading = ref(true)
const errorMessage = ref<string | null>(null)
const gate = ref<GateStatus | null>(null)
const drills = ref<Drill[]>([])
const selectedDrill = ref<Drill | null>(null)
const selectedRunbook = ref<GameDayRunbook | null>(null)

async function loadData() {
  loading.value = true
  errorMessage.value = null
  try {
    const [gateRes, drillsRes] = await Promise.all([
      request<GateStatus>('/api/admin/observability/game-day/gate'),
      request<{ drills: Drill[] }>('/api/admin/observability/game-day/drills')
    ])
    gate.value = gateRes
    drills.value = drillsRes.drills ?? []

    if (drills.value.length > 0) {
      const active = drills.value[0]!
      if (active.scenarios && active.scenarios.length > 0) {
        selectedDrill.value = active
      } else {
        const detailRes = await request<{ drill: Drill }>(`/api/admin/observability/game-day/drills/${active.id}`)
        selectedDrill.value = detailRes.drill
      }
    } else {
      selectedDrill.value = null
    }
  } catch {
    errorMessage.value = 'Comprueba la conexión y vuelve a intentarlo.'
  } finally {
    loading.value = false
  }
}

async function selectDrill(drill: Drill) {
  if (drill.scenarios && drill.scenarios.length > 0) {
    selectedDrill.value = drill
    return
  }
  try {
    const detail = await request<{ drill: Drill }>(`/api/admin/observability/game-day/drills/${drill.id}`)
    selectedDrill.value = detail.drill
  } catch {
    selectedDrill.value = drill
  }
}

function openRunbook(scenarioId: GameDayScenarioId) {
  selectedRunbook.value = GAME_DAY_RUNBOOKS[scenarioId] ?? null
}

function closeRunbook() {
  selectedRunbook.value = null
}
const runbookOpen = computed({
  get: () => selectedRunbook.value !== null,
  set: (open: boolean) => {
    if (!open) closeRunbook()
  }
})

onMounted(() => {
  loadData()
})
</script>

<template>
  <div class="adm-stack">
    <AdminPageActions>
      <AdminButton icon="i-lucide-rotate-cw" :loading="loading" @click="loadData">Actualizar</AdminButton>
    </AdminPageActions>

    <AdminEmptyState
      v-if="errorMessage"
      role="alert"
      variant="error"
      title="No se han podido cargar los simulacros"
      :description="errorMessage"
    >
      <AdminButton icon="i-lucide-rotate-cw" @click="loadData">Reintentar</AdminButton>
    </AdminEmptyState>

    <div v-else-if="loading" class="adm-table-skeleton" aria-busy="true">
      <span class="sr-only">Cargando simulacros…</span>
      <div v-for="row in 4" :key="row"><i /><i /><i /><i /></div>
    </div>

    <template v-else>
      <AdminCard>
        <div class="flex flex-wrap items-start justify-between gap-4">
          <div class="min-w-0 space-y-2">
            <div class="flex flex-wrap items-center gap-2">
              <AdminBadge
                :tone="gate?.status === 'approved' ? 'success' : gate?.status === 'blocked' ? 'danger' : 'warning'"
              >
                {{
                  gate?.status === 'approved'
                    ? 'Se puede ampliar el tráfico'
                    : gate?.status === 'conditional'
                      ? 'Ampliación con condiciones'
                      : 'Ampliación bloqueada'
                }}
              </AdminBadge>
              <span v-if="gate && gate.freshnessDays !== null" class="adm-help">
                Último simulacro hace {{ gate.freshnessDays }} días (caduca a los 30)
              </span>
            </div>
            <p class="text-sm">
              {{
                gate?.status === 'approved'
                  ? 'Los 7 simulacros de avería se han superado dentro del tiempo objetivo.'
                  : gate?.status === 'conditional'
                    ? 'Hay avisos en la coordinación o en los tiempos; hace falta una autorización manual.'
                    : 'No conviene lanzar campañas grandes: hay simulacros sin hacer, fallidos o de hace más de 30 días.'
              }}
            </p>
            <div v-if="gate && gate.reasons.length > 0">
              <p class="adm-label">Motivos</p>
              <ul class="mt-1 list-disc space-y-0.5 pl-5 text-sm">
                <li v-for="reason in gate.reasons" :key="reason">{{ reason }}</li>
              </ul>
            </div>
          </div>
          <div class="text-right">
            <p class="adm-help">Simulacros superados</p>
            <p class="text-lg font-semibold tabular-nums text-[var(--text-strong)]">
              {{ gate?.scenariosPassed ?? 0 }} de {{ gate?.scenariosTotal ?? 7 }}
            </p>
          </div>
        </div>
      </AdminCard>

      <AdminEmptyState
        v-if="drills.length === 0"
        title="Todavía no se ha hecho ningún simulacro"
        description="Antes de una campaña grande conviene ensayar las 7 averías posibles para saber que la tienda se recupera."
        icon="i-lucide-shield-alert"
      />

      <template v-else>
        <div class="flex flex-wrap items-center gap-2" role="group" aria-label="Simulacros realizados">
          <button
            v-for="drill in drills"
            :key="drill.id"
            type="button"
            class="adm-chip"
            :aria-pressed="selectedDrill?.id === drill.id"
            @click="selectDrill(drill)"
          >
            {{ drill.cohort }} · {{ adminDate(drill.startedAt) }} ·
            {{ RESULT_LABELS[drill.status] ?? adminHumanize(drill.status) }}
          </button>
        </div>

        <AdminCard
          v-if="selectedDrill"
          :title="selectedDrill.cohort"
          :description="selectedDrill.notes || undefined"
          flush
        >
          <template #actions>
            <AdminBadge :tone="RESULT_TONES[selectedDrill.status] ?? 'neutral'">
              {{ RESULT_LABELS[selectedDrill.status] ?? adminHumanize(selectedDrill.status) }}
            </AdminBadge>
            <span class="adm-help">
              {{ selectedDrill.scenariosPassed }} de {{ selectedDrill.scenariosTotal }} superados
            </span>
          </template>
          <div class="adm-table-wrap">
            <table class="adm-table">
              <thead>
                <tr>
                  <th scope="col">Avería ensayada</th>
                  <th scope="col" data-numeric>Detección (real / objetivo)</th>
                  <th scope="col" data-numeric>Recuperación (real / objetivo)</th>
                  <th scope="col">Aviso</th>
                  <th scope="col">Vuelta atrás</th>
                  <th scope="col">Procedimiento</th>
                  <th scope="col">Resultado</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="scen in selectedDrill.scenarios ?? []" :key="scen.id">
                  <td class="font-semibold text-[var(--text-strong)]">
                    {{ SCENARIO_LABELS[scen.scenarioId] ?? adminHumanize(scen.scenarioId) }}
                  </td>
                  <td data-numeric>
                    <span
                      class="font-semibold"
                      :class="scen.actualDetectionSeconds > scen.targetDetectionSeconds && 'text-red-700'"
                    >
                      {{ scen.actualDetectionSeconds }} s
                    </span>
                    <span class="text-[var(--text-muted)]"> / {{ scen.targetDetectionSeconds }} s</span>
                  </td>
                  <td data-numeric>
                    <span
                      class="font-semibold"
                      :class="scen.actualRecoverySeconds > scen.targetRecoverySeconds && 'text-red-700'"
                    >
                      {{ scen.actualRecoverySeconds }} s
                    </span>
                    <span class="text-[var(--text-muted)]"> / {{ scen.targetRecoverySeconds }} s</span>
                  </td>
                  <td>
                    <AdminBadge :tone="scen.alertTriggered ? 'success' : 'danger'" plain>
                      {{ scen.alertTriggered ? 'Avisó' : 'No avisó' }}
                    </AdminBadge>
                    <div class="adm-help">
                      {{ CHANNEL_LABELS[scen.alertChannel] }} ·
                      {{ scen.alertSeverity === 'critical' ? 'crítico' : 'aviso' }}
                    </div>
                  </td>
                  <td>{{ RESTORE_LABELS[scen.rollbackRestoreStatus] }}</td>
                  <td>
                    <button
                      type="button"
                      class="adm-btn adm-btn--ghost adm-btn--sm"
                      @click="openRunbook(scen.scenarioId)"
                    >
                      Ver pasos
                    </button>
                  </td>
                  <td>
                    <AdminBadge :tone="RESULT_TONES[scen.status] ?? 'neutral'">
                      {{ RESULT_LABELS[scen.status] ?? adminHumanize(scen.status) }}
                    </AdminBadge>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </AdminCard>
      </template>
    </template>

    <AdminDrawer
      v-model:open="runbookOpen"
      :title="selectedRunbook?.title ?? 'Procedimiento'"
      :description="selectedRunbook?.description"
    >
      <div v-if="selectedRunbook" class="adm-stack">
        <section>
          <h3>Pasos</h3>
          <ol class="mt-1 list-decimal space-y-1 pl-5 text-sm">
            <li v-for="step in selectedRunbook.steps" :key="step">{{ step }}</li>
          </ol>
        </section>
        <section>
          <h3>Cómo reducir el daño</h3>
          <ul class="mt-1 list-disc space-y-1 pl-5 text-sm">
            <li v-for="action in selectedRunbook.mitigationActions" :key="action">{{ action }}</li>
          </ul>
        </section>
        <p class="adm-help">
          A quién avisar: <strong>{{ selectedRunbook.escalationTeam }}</strong>
        </p>
      </div>
      <template #footer>
        <button type="button" class="adm-btn adm-btn--primary" @click="closeRunbook">Entendido</button>
      </template>
    </AdminDrawer>
  </div>
</template>
