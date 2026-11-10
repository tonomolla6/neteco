<script setup lang="ts">
import { ref, onMounted } from 'vue'

const requestFetch = useRequestFetch()

interface JourneyBudget {
  journey: string
  targetSloRatio: number
  totalEvents: number
  failedEvents: number
  allowedErrorCount: number
  consumedBudgetPercent: number
  remainingBudgetPercent: number
  burnRate: number
  isExhausted: boolean
}

interface ErrorBudgetOverviewData {
  generatedAt: string
  featureFreezeActive: boolean
  blockingJourneys: string[]
  journeys: Record<string, JourneyBudget>
}

interface ReleaseDecisionRecord {
  id: string
  releaseVersion: string
  releaseType: string
  commitHash: string
  status: string
  budgetStatusSummary: {
    freezeActive: boolean
    blockingJourneys: string[]
  }
  justification?: string | null
  overriddenBy?: string | null
  createdAt: string
}

const loading = ref(false)
const evaluating = ref(false)
const overriding = ref(false)
const errorMessage = ref('')
const successMessage = ref('')

const overview = ref<ErrorBudgetOverviewData | null>(null)
const decisions = ref<ReleaseDecisionRecord[]>([])

const evalForm = ref({
  releaseVersion: '',
  releaseType: 'feature' as const,
  commitHash: ''
})

const overrideForm = ref({
  decisionId: '',
  justification: ''
})

const journeyLabels: Record<string, string> = {
  storefront: 'Storefront (Web)',
  checkout_orders: 'Checkout y Pedidos',
  catalog_api: 'API Catálogo',
  critical_mutations: 'Mutaciones Críticas',
  payments_webhooks: 'Webhooks Redsys / Pagos',
  jobs_queues: 'Colas y Procesos Asíncronos'
}

async function loadData() {
  loading.value = true
  errorMessage.value = ''
  try {
    const resOverview = (await requestFetch(
      '/api/admin/observability/error-budget/overview'
    )) as ErrorBudgetOverviewData
    overview.value = resOverview

    const resDecisions = (await requestFetch('/api/admin/observability/error-budget/decisions')) as {
      decisions: ReleaseDecisionRecord[]
    }
    decisions.value = resDecisions?.decisions ?? []
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : 'Error al cargar datos de error budget'
  } finally {
    loading.value = false
  }
}

async function handleEvaluate() {
  if (!evalForm.value.releaseVersion.trim() || !evalForm.value.commitHash.trim()) {
    errorMessage.value = 'Versión de release y hash de commit son obligatorios'
    return
  }
  evaluating.value = true
  errorMessage.value = ''
  successMessage.value = ''
  try {
    const res = (await requestFetch('/api/admin/observability/error-budget/evaluate', {
      method: 'POST',
      body: {
        commandId: crypto.randomUUID(),
        idempotencyKey: `eval-${Date.now()}-${evalForm.value.releaseVersion}`,
        releaseVersion: evalForm.value.releaseVersion.trim(),
        releaseType: evalForm.value.releaseType,
        commitHash: evalForm.value.commitHash.trim()
      }
    })) as { decision: ReleaseDecisionRecord }

    if (res.decision.status === 'approved') {
      successMessage.value = `Release ${res.decision.releaseVersion} APROBADA. Fiabilidad dentro de objetivo.`
    } else {
      errorMessage.value = `Release ${res.decision.releaseVersion} PAUSADA: Error budget agotado. Priorizar fiabilidad sobre nuevas features.`
    }
    await loadData()
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : 'Error al evaluar decisión de release'
  } finally {
    evaluating.value = false
  }
}

async function handleOverride() {
  if (!overrideForm.value.justification.trim() || overrideForm.value.justification.trim().length < 5) {
    errorMessage.value = 'Se requiere una justificación formal de al menos 5 caracteres para bypass de emergencia'
    return
  }
  overriding.value = true
  errorMessage.value = ''
  successMessage.value = ''
  try {
    await requestFetch('/api/admin/observability/error-budget/override', {
      method: 'POST',
      body: {
        commandId: crypto.randomUUID(),
        idempotencyKey: `override-${Date.now()}-${overrideForm.value.decisionId}`,
        decisionId: overrideForm.value.decisionId,
        justification: overrideForm.value.justification.trim()
      }
    })
    successMessage.value = 'Bypass de emergencia registrado y auditado correctamente'
    overrideForm.value.decisionId = ''
    overrideForm.value.justification = ''
    await loadData()
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : 'Error al autorizar bypass de emergencia'
  } finally {
    overriding.value = false
  }
}

onMounted(() => {
  loadData()
})
</script>

<template>
  <div class="space-y-6">
    <!-- Header & Freeze Status Alert -->
    <div
      v-if="overview?.featureFreezeActive"
      role="alert"
      class="rounded-lg border border-red-300 bg-red-50 p-4 text-red-900"
    >
      <div class="flex items-center gap-2 font-semibold">
        <span class="text-xl"></span>
        <span>Feature Freeze Activo — Exceso de Fallos Pausa Nuevas Features</span>
      </div>
      <p class="mt-1 text-sm text-red-800">
        El error budget se ha agotado en los journeys:
        <strong>{{ overview.blockingJourneys.map((j) => journeyLabels[j] || j).join(', ') }}</strong
        >. Solo se autorizan releases de tipo <em>fiabilidad, hotfix o rollback</em> hasta restablecer el margen de
        estabilidad.
      </p>
    </div>

    <div
      v-else-if="overview && !overview.featureFreezeActive"
      class="rounded-lg border border-emerald-300 bg-emerald-50 p-4 text-emerald-900"
    >
      <div class="flex items-center gap-2 font-semibold"><span>Estabilidad Nominal — Error Budget Saludable</span></div>
      <p class="mt-1 text-sm text-emerald-800">
        Todos los journeys operativos cumplen con sus SLOs objetivos. Decisiones de release estándar admitidas.
      </p>
    </div>

    <!-- Feedback messages -->
    <div v-if="errorMessage" role="alert" class="rounded bg-red-100 p-3 text-sm text-red-700">
      {{ errorMessage }}
    </div>
    <div v-if="successMessage" role="status" class="rounded bg-emerald-100 p-3 text-sm text-emerald-700">
      {{ successMessage }}
    </div>

    <!-- Journeys Error Budget Grid -->
    <div class="rounded-lg border border-neutral-200 bg-white p-5 shadow-sm">
      <h3 class="text-base font-semibold text-neutral-900 mb-4">
        Presupuesto de Error por Journey Operativo (SLO Rolling)
      </h3>
      <div v-if="loading" class="text-sm text-neutral-500 py-4 text-center">
        Cargando métricas de observabilidad SRE...
      </div>
      <div
        v-else-if="overview && Object.keys(overview.journeys).length > 0"
        class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
      >
        <div
          v-for="(status, jKey) in overview.journeys"
          :key="jKey"
          class="rounded-md border p-4 transition-colors"
          :class="status.isExhausted ? 'border-red-300 bg-red-50/50' : 'border-neutral-200 bg-neutral-50/50'"
        >
          <div class="flex items-start justify-between">
            <span class="font-medium text-neutral-800 text-sm">{{ journeyLabels[jKey] || jKey }}</span>
            <span
              class="px-2 py-0.5 text-xs font-semibold rounded-full"
              :class="status.isExhausted ? 'bg-red-100 text-red-800' : 'bg-emerald-100 text-emerald-800'"
            >
              {{ status.isExhausted ? 'Agotado' : 'OK' }}
            </span>
          </div>

          <div class="mt-3 space-y-1.5 text-xs text-neutral-600">
            <div class="flex justify-between">
              <span>SLO Objetivo:</span>
              <span class="font-semibold">{{ (status.targetSloRatio * 100).toFixed(2) }}%</span>
            </div>
            <div class="flex justify-between">
              <span>Eventos Totales:</span>
              <span>{{ status.totalEvents.toLocaleString() }}</span>
            </div>
            <div class="flex justify-between">
              <span>Fallos Reales / Permitidos:</span>
              <span
                ><strong>{{ status.failedEvents }}</strong> / {{ status.allowedErrorCount }}</span
              >
            </div>
            <div class="flex justify-between">
              <span>Burn Rate:</span>
              <span :class="status.burnRate > 1.5 ? 'font-bold text-red-700' : ''">
                {{ status.burnRate.toFixed(2) }}x
              </span>
            </div>
          </div>

          <!-- Progress Bar of Budget Remaining -->
          <div class="mt-3">
            <div class="flex justify-between text-xs text-neutral-500 mb-1">
              <span>Presupuesto Restante</span>
              <span
                class="font-bold"
                :class="status.remainingBudgetPercent <= 10 ? 'text-red-700' : 'text-emerald-700'"
              >
                {{ status.remainingBudgetPercent.toFixed(1) }}%
              </span>
            </div>
            <div class="h-2 w-full bg-neutral-200 rounded-full overflow-hidden">
              <div
                class="h-full rounded-full transition-all duration-300"
                :class="
                  status.remainingBudgetPercent <= 10
                    ? 'bg-red-600'
                    : status.remainingBudgetPercent <= 30
                      ? 'bg-amber-500'
                      : 'bg-emerald-600'
                "
                :style="{ width: `${Math.max(0, Math.min(100, status.remainingBudgetPercent))}%` }"
              />
            </div>
          </div>
        </div>
      </div>
      <div v-else class="text-sm text-neutral-500 py-4 text-center">No se han registrado mediciones SLI aún.</div>
    </div>

    <!-- Release Decision Evaluator Form -->
    <div class="rounded-lg border border-neutral-200 bg-white p-5 shadow-sm">
      <h3 class="text-base font-semibold text-neutral-900 mb-2">Evaluador de Release Gate</h3>
      <p class="text-xs text-neutral-600 mb-4">
        Comprueba automáticamente el estado del error budget antes de desplegar. Si hay exceso de fallos, las features
        quedan bloqueadas y solo se permite priorizar la fiabilidad.
      </p>

      <form class="grid gap-4 sm:grid-cols-3" @submit.prevent="handleEvaluate">
        <div>
          <label class="block text-xs font-medium text-neutral-700 mb-1" for="release-version">
            Versión de Release
          </label>
          <input
            id="release-version"
            v-model="evalForm.releaseVersion"
            type="text"
            placeholder="v2026.10.30-feat"
            class="w-full rounded border border-neutral-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
          />
        </div>

        <div>
          <label class="block text-xs font-medium text-neutral-700 mb-1" for="release-type"> Tipo de Despliegue </label>
          <select
            id="release-type"
            v-model="evalForm.releaseType"
            class="w-full rounded border border-neutral-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
          >
            <option value="feature">Feature / Nueva Funcionalidad</option>
            <option value="reliability_fix">Mejora de Fiabilidad / SRE</option>
            <option value="hotfix">Hotfix Urgente</option>
            <option value="rollback">Rollback a Versión Anterior</option>
            <option value="infrastructure">Cambio de Infraestructura</option>
          </select>
        </div>

        <div>
          <label class="block text-xs font-medium text-neutral-700 mb-1" for="commit-hash"> Git Commit Hash </label>
          <input
            id="commit-hash"
            v-model="evalForm.commitHash"
            type="text"
            placeholder="abcdef123"
            class="w-full rounded border border-neutral-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
          />
        </div>

        <div class="sm:col-span-3 flex justify-end">
          <button
            type="submit"
            :disabled="evaluating"
            class="rounded bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {{ evaluating ? 'Evaluando...' : 'Evaluar Decisión de Release' }}
          </button>
        </div>
      </form>
    </div>

    <!-- Decisions History -->
    <div class="rounded-lg border border-neutral-200 bg-white p-5 shadow-sm">
      <h3 class="text-base font-semibold text-neutral-900 mb-4">Histórico de Decisiones de Release</h3>
      <div v-if="decisions.length === 0" class="text-sm text-neutral-500 text-center py-4">
        No hay registros de decisiones de release aún.
      </div>
      <div v-else class="overflow-x-auto">
        <table class="min-w-full divide-y divide-neutral-200 text-left text-xs">
          <thead>
            <tr class="bg-neutral-50 text-neutral-600 font-medium">
              <th class="px-3 py-2">Versión</th>
              <th class="px-3 py-2">Tipo</th>
              <th class="px-3 py-2">Estado Gate</th>
              <th class="px-3 py-2">Commit</th>
              <th class="px-3 py-2">Fecha</th>
              <th class="px-3 py-2">Acción</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-neutral-100">
            <tr v-for="d in decisions" :key="d.id" class="hover:bg-neutral-50/50">
              <td class="px-3 py-2 font-mono font-medium">{{ d.releaseVersion }}</td>
              <td class="px-3 py-2 capitalize">{{ d.releaseType.replace('_', ' ') }}</td>
              <td class="px-3 py-2">
                <span
                  class="px-2 py-0.5 rounded font-semibold text-xs"
                  :class="{
                    'bg-emerald-100 text-emerald-800': d.status === 'approved',
                    'bg-red-100 text-red-800': d.status === 'blocked_budget_exhausted',
                    'bg-amber-100 text-amber-800': d.status === 'overridden_emergency'
                  }"
                >
                  {{
                    d.status === 'approved'
                      ? 'Aprobada'
                      : d.status === 'blocked_budget_exhausted'
                        ? 'Bloqueada (Budget Agotado)'
                        : 'Bypass de Emergencia'
                  }}
                </span>
              </td>
              <td class="px-3 py-2 font-mono text-neutral-600">{{ d.commitHash.slice(0, 8) }}</td>
              <td class="px-3 py-2 text-neutral-500">{{ d.createdAt.slice(0, 19).replace('T', ' ') }}</td>
              <td class="px-3 py-2">
                <button
                  v-if="d.status === 'blocked_budget_exhausted'"
                  class="text-xs text-amber-700 underline hover:text-amber-900"
                  @click="overrideForm.decisionId = d.id"
                >
                  Bypass Emergencia
                </button>
                <span v-else-if="d.justification" class="text-xs text-neutral-500 italic">
                  "{{ d.justification.slice(0, 30) }}..."
                </span>
                <span v-else class="text-neutral-400">-</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Emergency Override Box if selected -->
      <div v-if="overrideForm.decisionId" class="mt-4 p-4 rounded-lg border border-amber-300 bg-amber-50">
        <h4 class="text-sm font-semibold text-amber-900 mb-1">
          Autorizar Bypass de Emergencia para Decisión Bloqueada
        </h4>
        <p class="text-xs text-amber-800 mb-2">
          Esta acción quedará registrada en el log de auditoría inmutable de SRE. Indique la causa justificada.
        </p>
        <div class="flex gap-2">
          <input
            v-model="overrideForm.justification"
            type="text"
            placeholder="Motivo formal del bypass de emergencia..."
            class="flex-1 rounded border border-amber-400 px-3 py-1.5 text-xs bg-white focus:outline-none"
          />
          <button
            :disabled="overriding"
            class="rounded bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700 disabled:opacity-50"
            @click="handleOverride"
          >
            {{ overriding ? 'Registrando...' : 'Confirmar Bypass' }}
          </button>
          <button
            class="rounded border border-neutral-300 px-2 py-1.5 text-xs text-neutral-700 hover:bg-neutral-100"
            @click="overrideForm.decisionId = ''"
          >
            Cancelar
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
