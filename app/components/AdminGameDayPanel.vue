<script setup lang="ts">
import { ref, onMounted } from 'vue'
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
  beply_outage: 'Caída Beply ERP',
  carrier_outage: 'Caída Transportista',
  d1_outage: 'Caída Base Datos D1',
  durable_object_outage: 'Caída Durable Object',
  queue_outage: 'Saturación Colas Queue',
  r2_outage: 'Caída Almacenamiento R2',
  worker_deployment_failure: 'Fallo Despliegue Worker'
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
    errorMessage.value = 'Error al cargar la información de Game Day y Resiliencia'
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

onMounted(() => {
  loadData()
})
</script>

<template>
  <div class="space-y-6">
    <!-- Header -->
    <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
      <div>
        <h2 class="text-xl font-bold text-neutral-900">Game Day y Puerta de Tráfico (OBS-024)</h2>
        <p class="text-sm text-neutral-600 mt-0.5">
          Verificación exhaustiva de resiliencia ante cortes de ERP, transportistas, base de datos D1, Durable Objects,
          colas y despliegues antes de escalar campañas.
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
      <p>Cargando estado de Game Day y puerta de tráfico...</p>
    </div>

    <div v-else class="space-y-6">
      <!-- Traffic Expansion Gate Banner -->
      <div
        class="rounded-xl border p-5 transition-all"
        :class="{
          'border-emerald-200 bg-emerald-50 text-emerald-950': gate?.status === 'approved',
          'border-red-200 bg-red-50 text-red-950': gate?.status === 'blocked',
          'border-amber-200 bg-amber-50 text-amber-950': gate?.status === 'conditional' || gate?.status === 'pending'
        }"
      >
        <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div class="space-y-1">
            <div class="flex items-center gap-2">
              <span
                class="inline-flex items-center rounded-md px-2 py-0.5 text-xs font-bold uppercase tracking-wider"
                :class="{
                  'bg-emerald-600 text-white': gate?.status === 'approved',
                  'bg-red-600 text-white': gate?.status === 'blocked',
                  'bg-amber-600 text-white': gate?.status === 'conditional' || gate?.status === 'pending'
                }"
              >
                {{
                  gate?.status === 'approved'
                    ? 'AMPLIACIÓN AUTORIZADA'
                    : gate?.status === 'conditional'
                      ? 'AMPLIACIÓN CONDICIONAL'
                      : 'AMPLIACIÓN BLOQUEADA'
                }}
              </span>
              <span v-if="gate?.freshnessDays !== null" class="text-xs text-neutral-600">
                Frescura: hace {{ gate?.freshnessDays }} días (máximo 30 días)
              </span>
            </div>
            <p class="text-sm font-medium">
              {{
                gate?.status === 'approved'
                  ? 'Todos los 7 escenarios de fallo controlado fueron validados con éxito dentro del SLO objetivo.'
                  : gate?.status === 'conditional'
                    ? 'Existen advertencias en la coordinación o tiempos límite que requieren autorización manual.'
                    : 'La puerta de tráfico bloquea el escalado por simulacros incompletos, fallidos o vencidos (> 30 días).'
              }}
            </p>
          </div>
          <div class="flex items-center gap-4 text-xs font-semibold">
            <div class="rounded-lg bg-white/70 px-3 py-2 border border-black/5 shadow-sm text-center">
              <div class="text-neutral-500 text-[10px] uppercase">Escenarios OK</div>
              <div class="text-base font-bold text-neutral-900">
                {{ gate?.scenariosPassed ?? 0 }} de {{ gate?.scenariosTotal ?? 7 }}
              </div>
            </div>
          </div>
        </div>

        <!-- Blocking reasons list -->
        <div v-if="gate && gate.reasons.length > 0" class="mt-4 pt-3 border-t border-black/10 space-y-1 text-xs">
          <div class="font-semibold text-neutral-800">Motivos de restricción:</div>
          <ul class="list-disc list-inside space-y-0.5 text-neutral-700">
            <li v-for="reason in gate.reasons" :key="reason">{{ reason }}</li>
          </ul>
        </div>
      </div>

      <!-- Empty state -->
      <div
        v-if="drills.length === 0"
        class="rounded-xl border border-neutral-200 bg-white p-8 text-center text-sm text-neutral-600"
      >
        <span class="i-lucide-shield-alert mx-auto mb-3 block h-8 w-8 text-neutral-400" />
        <h3 class="font-semibold text-neutral-900 mb-1">No se han registrado simulacros de Game Day.</h3>
        <p class="text-neutral-500 max-w-md mx-auto">
          Para autorizar la ampliación de tráfico, ejecute un simulacro gobernado cubriendo los 7 escenarios de fallo
          antes de iniciar campañas.
        </p>
      </div>

      <!-- Drills List and Detail -->
      <div v-else class="grid grid-cols-1 lg:grid-cols-4 gap-6">
        <!-- Sidebar Drills List -->
        <div class="space-y-3">
          <h3 class="text-xs font-semibold uppercase tracking-wider text-neutral-500 px-1">Simulacros Ejecutados</h3>
          <div class="space-y-2">
            <button
              v-for="drill in drills"
              :key="drill.id"
              type="button"
              class="w-full text-left rounded-lg p-3 border transition-colors text-xs space-y-1"
              :class="
                selectedDrill?.id === drill.id
                  ? 'border-neutral-900 bg-neutral-900 text-white shadow-sm'
                  : 'border-neutral-200 bg-white text-neutral-700 hover:border-neutral-300'
              "
              @click="selectDrill(drill)"
            >
              <div class="font-bold truncate">{{ drill.cohort }}</div>
              <div
                class="flex items-center justify-between text-[11px]"
                :class="selectedDrill?.id === drill.id ? 'text-neutral-300' : 'text-neutral-500'"
              >
                <span>{{ drill.startedAt.slice(0, 10) }}</span>
                <span
                  class="font-semibold uppercase"
                  :class="{
                    'text-emerald-400': drill.status === 'passed' && selectedDrill?.id === drill.id,
                    'text-emerald-600': drill.status === 'passed' && selectedDrill?.id !== drill.id,
                    'text-red-400': drill.status === 'failed' && selectedDrill?.id === drill.id,
                    'text-red-600': drill.status === 'failed' && selectedDrill?.id !== drill.id
                  }"
                >
                  {{ drill.status }}
                </span>
              </div>
            </button>
          </div>
        </div>

        <!-- Main Detail: 7 Scenarios Table -->
        <div class="lg:col-span-3 space-y-4">
          <div v-if="selectedDrill" class="rounded-xl border border-neutral-200 bg-white shadow-sm overflow-hidden">
            <!-- Drill Header -->
            <div
              class="p-5 border-b border-neutral-200 bg-neutral-50 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
            >
              <div>
                <h3 class="font-bold text-base text-neutral-900">{{ selectedDrill.cohort }}</h3>
                <p v-if="selectedDrill.notes" class="text-xs text-neutral-600 mt-0.5">
                  {{ selectedDrill.notes }}
                </p>
              </div>
              <div class="flex items-center gap-2">
                <span
                  class="rounded-md px-2 py-0.5 text-xs font-bold uppercase tracking-wider"
                  :class="
                    selectedDrill.status === 'passed'
                      ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                      : 'bg-red-100 text-red-800 border border-red-300'
                  "
                >
                  {{ selectedDrill.status }}
                </span>
                <span class="text-xs text-neutral-500">
                  {{ selectedDrill.scenariosPassed }} / {{ selectedDrill.scenariosTotal }} superados
                </span>
              </div>
            </div>

            <!-- Scenarios Table -->
            <div class="overflow-x-auto">
              <table class="w-full text-left text-xs border-collapse">
                <thead class="bg-neutral-100 text-neutral-700 font-semibold border-b border-neutral-200">
                  <tr>
                    <th scope="col" class="py-3 px-4">Escenario de Fallo</th>
                    <th scope="col" class="py-3 px-3">Detección (Obj/Real)</th>
                    <th scope="col" class="py-3 px-3">Recuperación RTO</th>
                    <th scope="col" class="py-3 px-3">Alerta</th>
                    <th scope="col" class="py-3 px-3">Rollback / Restore</th>
                    <th scope="col" class="py-3 px-3">Runbook</th>
                    <th scope="col" class="py-3 px-4 text-right">Resultado</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-neutral-200 text-neutral-800">
                  <tr
                    v-for="scen in selectedDrill.scenarios ?? []"
                    :key="scen.id"
                    class="hover:bg-neutral-50 transition-colors"
                  >
                    <td class="py-3 px-4 font-semibold text-neutral-900">
                      <div>{{ SCENARIO_LABELS[scen.scenarioId] ?? scen.scenarioId }}</div>
                      <div class="text-[11px] text-neutral-500 font-mono">{{ scen.scenarioId }}</div>
                    </td>
                    <td class="py-3 px-3 font-mono">
                      <span
                        :class="
                          scen.actualDetectionSeconds <= scen.targetDetectionSeconds
                            ? 'text-emerald-700 font-bold'
                            : 'text-red-600 font-bold'
                        "
                      >
                        {{ scen.actualDetectionSeconds }}s
                      </span>
                      <span class="text-neutral-400"> / {{ scen.targetDetectionSeconds }}s</span>
                    </td>
                    <td class="py-3 px-3 font-mono">
                      <span
                        :class="
                          scen.actualRecoverySeconds <= scen.targetRecoverySeconds
                            ? 'text-emerald-700 font-bold'
                            : 'text-red-600 font-bold'
                        "
                      >
                        {{ scen.actualRecoverySeconds }}s
                      </span>
                      <span class="text-neutral-400"> / {{ scen.targetRecoverySeconds }}s</span>
                    </td>
                    <td class="py-3 px-3">
                      <div class="flex items-center gap-1.5">
                        <span
                          class="h-2 w-2 rounded-full"
                          :class="scen.alertTriggered ? 'bg-emerald-500' : 'bg-red-500'"
                        />
                        <span class="capitalize font-medium">{{ scen.alertChannel }}</span>
                      </div>
                      <span class="text-[10px] text-neutral-500 font-mono">{{ scen.alertSeverity }}</span>
                    </td>
                    <td class="py-3 px-3 font-mono text-[11px]">
                      {{ scen.rollbackRestoreStatus }}
                    </td>
                    <td class="py-3 px-3">
                      <button
                        type="button"
                        class="text-neutral-900 underline font-mono text-xs hover:text-blue-600 focus:outline-none"
                        @click="openRunbook(scen.scenarioId)"
                      >
                        {{ scen.runbookReference }}
                      </button>
                    </td>
                    <td class="py-3 px-4 text-right">
                      <span
                        class="inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide"
                        :class="
                          scen.status === 'passed'
                            ? 'bg-emerald-100 text-emerald-800'
                            : scen.status === 'warning'
                              ? 'bg-amber-100 text-amber-800'
                              : 'bg-red-100 text-red-800'
                        "
                      >
                        {{ scen.status }}
                      </span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Runbook Modal / Drawer -->
    <div
      v-if="selectedRunbook"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      @keydown.esc="closeRunbook"
    >
      <div
        class="w-full max-w-xl rounded-xl bg-white p-6 shadow-[var(--shadow-overlay)] border border-neutral-200 space-y-4"
      >
        <div class="flex items-center justify-between border-b border-neutral-200 pb-3">
          <div>
            <span class="text-xs font-mono font-bold text-neutral-500">{{ selectedRunbook.id }}</span>
            <h4 class="text-base font-bold text-neutral-900">{{ selectedRunbook.title }}</h4>
          </div>
          <button
            type="button"
            class="rounded-md p-1.5 text-neutral-400 hover:text-neutral-600 focus:outline-none"
            aria-label="Cerrar modal"
            @click="closeRunbook"
          >
            <span class="i-lucide-x h-5 w-5" />
          </button>
        </div>

        <p class="text-xs text-neutral-600">{{ selectedRunbook.description }}</p>

        <div class="space-y-2">
          <div class="text-xs font-bold uppercase text-neutral-700">Pasos Operativos:</div>
          <ol
            class="list-decimal list-inside space-y-1 text-xs text-neutral-800 bg-neutral-50 p-3 rounded-lg border border-neutral-200"
          >
            <li v-for="step in selectedRunbook.steps" :key="step">{{ step }}</li>
          </ol>
        </div>

        <div class="space-y-2">
          <div class="text-xs font-bold uppercase text-neutral-700">Acciones de Mitigación:</div>
          <ul class="list-disc list-inside space-y-1 text-xs text-neutral-800">
            <li v-for="action in selectedRunbook.mitigationActions" :key="action">{{ action }}</li>
          </ul>
        </div>

        <div class="pt-2 text-xs text-neutral-500 flex justify-between items-center border-t border-neutral-100">
          <span
            >Equipo de escalado: <strong>{{ selectedRunbook.escalationTeam }}</strong></span
          >
          <button
            type="button"
            class="rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-neutral-800"
            @click="closeRunbook"
          >
            Entendido
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
