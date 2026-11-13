<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'

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
  storefront: 'Tienda (web)',
  checkout_orders: 'Compra y pedidos',
  catalog_api: 'Catálogo',
  critical_mutations: 'Cambios importantes',
  payments_webhooks: 'Pagos (Redsys)',
  jobs_queues: 'Procesos en segundo plano'
}
const releaseTypeLabels: Record<string, string> = {
  feature: 'Novedad',
  reliability_fix: 'Mejora de estabilidad',
  hotfix: 'Arreglo urgente',
  rollback: 'Vuelta a una versión anterior',
  infrastructure: 'Cambio de infraestructura'
}
const overrideOpen = computed({
  get: () => overrideForm.value.decisionId !== '',
  set: (open: boolean) => {
    if (!open) overrideForm.value.decisionId = ''
  }
})

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
    errorMessage.value =
      err instanceof Error ? err.message : 'No se han podido cargar las mediciones. Vuelve a intentarlo.'
  } finally {
    loading.value = false
  }
}

async function handleEvaluate() {
  if (!evalForm.value.releaseVersion.trim() || !evalForm.value.commitHash.trim()) {
    errorMessage.value = 'Indica la versión y el identificador del cambio.'
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
      successMessage.value = `La versión ${res.decision.releaseVersion} se puede publicar: la estabilidad está dentro del objetivo.`
    } else {
      errorMessage.value = `La versión ${res.decision.releaseVersion} queda en pausa: se ha agotado el margen de errores. Primero hay que recuperar la estabilidad.`
    }
    await loadData()
  } catch (err: unknown) {
    errorMessage.value =
      err instanceof Error ? err.message : 'No se ha podido comprobar la versión. Vuelve a intentarlo.'
  } finally {
    evaluating.value = false
  }
}

async function handleOverride() {
  if (!overrideForm.value.justification.trim() || overrideForm.value.justification.trim().length < 5) {
    errorMessage.value = 'Escribe un motivo de al menos 5 caracteres para autorizar la versión.'
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
    successMessage.value = 'Versión autorizada por urgencia. Ha quedado anotado en el registro de actividad.'
    overrideForm.value.decisionId = ''
    overrideForm.value.justification = ''
    await loadData()
  } catch (err: unknown) {
    errorMessage.value =
      err instanceof Error ? err.message : 'No se ha podido autorizar la versión. Vuelve a intentarlo.'
  } finally {
    overriding.value = false
  }
}

onMounted(() => {
  loadData()
})
</script>

<template>
  <div class="adm-stack">
    <UAlert
      v-if="overview?.featureFreezeActive"
      role="alert"
      color="error"
      variant="subtle"
      icon="i-lucide-octagon-pause"
      title="Novedades en pausa: se ha superado el margen de errores"
      :description="`Demasiados fallos en: ${overview.blockingJourneys.map((j) => journeyLabels[j] || adminHumanize(j)).join(', ')}. Hasta recuperar la estabilidad solo se pueden publicar correcciones, arreglos urgentes o vueltas a una versión anterior.`"
    />
    <UAlert
      v-else-if="overview && !overview.featureFreezeActive"
      color="success"
      variant="subtle"
      icon="i-lucide-circle-check"
      title="Todo estable"
      description="Todas las áreas cumplen su objetivo de servicio. Se pueden publicar versiones con normalidad."
    />

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
      title="Margen de errores por área"
      description="Cuántos fallos admite cada área de la tienda antes de pausar las novedades."
    >
      <template #actions>
        <AdminButton size="sm" icon="i-lucide-rotate-cw" :loading="loading" @click="loadData">Actualizar</AdminButton>
      </template>
      <div v-if="loading && !overview" class="adm-table-skeleton" aria-busy="true">
        <span class="sr-only">Cargando…</span>
        <div v-for="row in 3" :key="row"><i /><i /><i /></div>
      </div>
      <div v-else-if="overview && Object.keys(overview.journeys).length > 0" class="adm-grid">
        <AdminCard v-for="(status, jKey) in overview.journeys" :key="jKey" as="article">
          <div class="flex items-start justify-between gap-2">
            <span class="font-semibold text-[var(--text-strong)]">{{
              journeyLabels[jKey] || adminHumanize(jKey)
            }}</span>
            <AdminBadge :tone="status.isExhausted ? 'danger' : 'success'">
              {{ status.isExhausted ? 'Agotado' : 'Correcto' }}
            </AdminBadge>
          </div>
          <dl class="mt-3 space-y-1.5 text-sm">
            <div class="flex justify-between gap-3">
              <dt class="text-[var(--text-muted)]">Objetivo de servicio</dt>
              <dd class="font-semibold tabular-nums">{{ (status.targetSloRatio * 100).toFixed(2) }} %</dd>
            </div>
            <div class="flex justify-between gap-3">
              <dt class="text-[var(--text-muted)]">Operaciones medidas</dt>
              <dd class="tabular-nums">{{ status.totalEvents.toLocaleString('es-ES') }}</dd>
            </div>
            <div class="flex justify-between gap-3">
              <dt class="text-[var(--text-muted)]">Fallos / permitidos</dt>
              <dd class="tabular-nums">
                <strong>{{ status.failedEvents }}</strong> / {{ status.allowedErrorCount }}
              </dd>
            </div>
            <div class="flex justify-between gap-3">
              <dt class="text-[var(--text-muted)]">Ritmo de consumo</dt>
              <dd class="tabular-nums" :class="status.burnRate > 1.5 ? 'font-semibold text-red-700' : ''">
                {{ status.burnRate.toFixed(2) }}×
              </dd>
            </div>
          </dl>
          <div class="mt-3">
            <div class="mb-1 flex justify-between text-xs text-[var(--text-muted)]">
              <span>Margen restante</span>
              <span class="font-semibold tabular-nums" :class="status.remainingBudgetPercent <= 10 && 'text-red-700'">
                {{ status.remainingBudgetPercent.toFixed(1) }} %
              </span>
            </div>
            <div class="h-2 w-full overflow-hidden rounded-full bg-[var(--surface-sunken)]">
              <div
                class="h-full rounded-full"
                :class="status.remainingBudgetPercent <= 10 ? 'bg-red-600' : 'bg-neteco-600'"
                :style="{ width: `${Math.max(0, Math.min(100, status.remainingBudgetPercent))}%` }"
              />
            </div>
          </div>
        </AdminCard>
      </div>
      <AdminEmptyState
        v-else-if="!overview && errorMessage"
        variant="error"
        title="No se han podido cargar las mediciones"
        description="Comprueba la conexión y vuelve a intentarlo."
      >
        <AdminButton icon="i-lucide-rotate-cw" @click="loadData">Reintentar</AdminButton>
      </AdminEmptyState>
      <AdminEmptyState
        v-else
        title="Todavía no hay mediciones"
        description="Aparecerán aquí en cuanto la tienda registre actividad."
        icon="i-lucide-activity"
      />
    </AdminSection>

    <AdminCard
      title="Comprobar si se puede publicar una versión"
      description="Revisa el margen de errores antes de publicar. Si hay demasiados fallos, las novedades quedan bloqueadas y solo se admiten correcciones."
    >
      <form class="adm-form-grid" @submit.prevent="handleEvaluate">
        <div class="adm-field">
          <label class="adm-label" for="release-version">Versión</label>
          <input id="release-version" v-model="evalForm.releaseVersion" type="text" placeholder="v2026.10.30" />
        </div>
        <div class="adm-field">
          <label class="adm-label" for="release-type">Tipo de cambio</label>
          <select id="release-type" v-model="evalForm.releaseType">
            <option value="feature">Novedad</option>
            <option value="reliability_fix">Mejora de estabilidad</option>
            <option value="hotfix">Arreglo urgente</option>
            <option value="rollback">Vuelta a una versión anterior</option>
            <option value="infrastructure">Cambio de infraestructura</option>
          </select>
        </div>
        <div class="adm-field">
          <label class="adm-label" for="commit-hash">Identificador del cambio</label>
          <input id="commit-hash" v-model="evalForm.commitHash" type="text" placeholder="abcdef123" />
        </div>
        <div class="flex items-end">
          <button type="submit" :disabled="evaluating" class="adm-btn adm-btn--primary">
            {{ evaluating ? 'Comprobando…' : 'Comprobar versión' }}
          </button>
        </div>
      </form>
    </AdminCard>

    <AdminCard title="Historial de comprobaciones" flush>
      <AdminEmptyState
        v-if="decisions.length === 0"
        compact
        title="Todavía no se ha comprobado ninguna versión"
        icon="i-lucide-history"
      />
      <div v-else class="adm-table-wrap">
        <table class="adm-table">
          <thead>
            <tr>
              <th scope="col">Versión</th>
              <th scope="col">Tipo</th>
              <th scope="col">Resultado</th>
              <th scope="col">Cambio</th>
              <th scope="col">Fecha</th>
              <th scope="col"><span class="sr-only">Acciones</span></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="d in decisions" :key="d.id">
              <td class="font-semibold text-[var(--text-strong)]">{{ d.releaseVersion }}</td>
              <td>{{ releaseTypeLabels[d.releaseType] ?? adminHumanize(d.releaseType) }}</td>
              <td>
                <AdminBadge
                  :tone="
                    d.status === 'approved' ? 'success' : d.status === 'blocked_budget_exhausted' ? 'danger' : 'warning'
                  "
                >
                  {{
                    d.status === 'approved'
                      ? 'Aprobada'
                      : d.status === 'blocked_budget_exhausted'
                        ? 'Bloqueada por exceso de fallos'
                        : 'Autorizada por urgencia'
                  }}
                </AdminBadge>
              </td>
              <td class="tabular-nums">{{ d.commitHash.slice(0, 8) }}</td>
              <td>{{ adminDate(d.createdAt, true) }}</td>
              <td class="adm-table__actions">
                <button
                  v-if="d.status === 'blocked_budget_exhausted'"
                  type="button"
                  class="adm-btn adm-btn--secondary adm-btn--sm"
                  @click="overrideForm.decisionId = d.id"
                >
                  Autorizar por urgencia
                </button>
                <span v-else-if="d.justification" class="adm-help" :title="d.justification">
                  «{{ d.justification.slice(0, 30) }}{{ d.justification.length > 30 ? '…' : '' }}»
                </span>
                <span v-else class="adm-help">—</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </AdminCard>

    <AdminDrawer
      v-model:open="overrideOpen"
      title="Autorizar una versión bloqueada"
      description="Solo para urgencias. Quedará anotado en el registro de actividad con tu nombre."
    >
      <AdminFormField
        v-slot="{ id }"
        label="Motivo"
        help="Explica por qué no puede esperar (mínimo 5 caracteres)."
        required
      >
        <textarea :id="id" v-model="overrideForm.justification" rows="4" class="w-full" />
      </AdminFormField>
      <template #footer>
        <button type="button" class="adm-btn adm-btn--secondary" @click="overrideForm.decisionId = ''">Cancelar</button>
        <button type="button" :disabled="overriding" class="adm-btn adm-btn--primary" @click="handleOverride">
          {{ overriding ? 'Guardando…' : 'Autorizar versión' }}
        </button>
      </template>
    </AdminDrawer>
  </div>
</template>
