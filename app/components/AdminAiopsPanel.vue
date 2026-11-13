<script setup lang="ts">
import { onMounted, ref } from 'vue'

interface Recommendation {
  id: string
  summary: string
  runbookId: string
  steps: string[]
  destructive: boolean
  confidence: number
  status: 'proposed' | 'approved' | 'rejected'
  decisionReason: string | null
  outcome: 'pending' | 'true_positive' | 'false_positive'
  version: number
  createdAt: string
}
interface Precision {
  total: number
  reviewed: number
  truePositives: number
  falsePositives: number
  pending: number
  precision: number | null
  sampleSufficient: boolean
}

const requestFetch = useRequestFetch()
const loading = ref(true)
const busy = ref(false)
const errorMessage = ref('')
const notice = ref('')
const recommendations = ref<Recommendation[]>([])
const precision = ref<Precision | null>(null)
const reasons = ref<Record<string, string>>({})
const confirmed = ref<Record<string, boolean>>({})

function errorText(error: unknown, fallback: string): string {
  const code = (error as { data?: { error?: { code?: string } } })?.data?.error?.code
  return code ? `${fallback}. Vuelve a intentarlo.` : fallback
}
const statusLabels: Record<Recommendation['status'], string> = {
  proposed: 'Pendiente de decisión',
  approved: 'Aprobada',
  rejected: 'Rechazada'
}
const statusTones: Record<Recommendation['status'], 'warning' | 'success' | 'neutral'> = {
  proposed: 'warning',
  approved: 'success',
  rejected: 'neutral'
}

async function load() {
  loading.value = true
  errorMessage.value = ''
  try {
    const [list, stats] = await Promise.all([
      requestFetch('/api/admin/observability/aiops/recommendations') as Promise<{ recommendations: Recommendation[] }>,
      requestFetch('/api/admin/observability/aiops/precision') as Promise<{ precision: Precision }>
    ])
    recommendations.value = list?.recommendations ?? []
    precision.value = stats?.precision ?? null
  } catch (error) {
    errorMessage.value = errorText(error, 'No se han podido cargar las propuestas')
  } finally {
    loading.value = false
  }
}

async function mutate(path: string, body: Record<string, unknown>, success: string) {
  busy.value = true
  errorMessage.value = ''
  notice.value = ''
  try {
    await requestFetch(`/api/admin/observability/aiops/${path}`, {
      method: 'POST',
      body: { commandId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(), ...body }
    })
    notice.value = success
    await load()
  } catch (error) {
    errorMessage.value = errorText(error, 'La operación no se pudo completar')
  } finally {
    busy.value = false
  }
}

const correlate = () => mutate('correlate', {}, 'Análisis completado.')
const decide = (rec: Recommendation, decision: 'approve' | 'reject') =>
  mutate(
    'recommendations/decide',
    {
      recommendationId: rec.id,
      expectedVersion: rec.version,
      decision,
      reason: (reasons.value[rec.id] ?? '').trim(),
      ...(rec.destructive && decision === 'approve' ? { confirmDestructive: confirmed.value[rec.id] === true } : {})
    },
    decision === 'approve' ? 'Propuesta aprobada. La acción debe ejecutarla una persona.' : 'Propuesta rechazada.'
  )
const label = (rec: Recommendation, outcome: 'true_positive' | 'false_positive') =>
  mutate(
    'recommendations/outcome',
    { recommendationId: rec.id, expectedVersion: rec.version, outcome },
    'Resultado registrado.'
  )

function canDecide(rec: Recommendation): boolean {
  if ((reasons.value[rec.id] ?? '').trim().length < 10) return false
  return true
}

onMounted(load)
</script>

<template>
  <section class="adm-stack" aria-label="Diagnóstico asistido de incidencias" data-aiops-panel>
    <AdminPageActions>
      <button
        type="button"
        class="adm-btn adm-btn--primary"
        :disabled="busy || loading"
        data-correlate
        @click="correlate"
      >
        Analizar señales
      </button>
    </AdminPageActions>

    <UAlert
      v-if="errorMessage"
      role="alert"
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="errorMessage"
      data-error
    >
      <template #description>
        <button type="button" class="underline" data-retry @click="load">Reintentar</button>
      </template>
    </UAlert>
    <UAlert v-if="notice" role="status" color="success" variant="subtle" icon="i-lucide-circle-check" :title="notice" />

    <p class="adm-help">
      Aquí solo se proponen acciones; nunca se ejecutan solas. Las que pueden borrar o detener algo necesitan la
      aprobación expresa de una persona.
    </p>

    <div v-if="precision" class="adm-grid" data-precision>
      <AdminStat
        label="Acierto de las propuestas"
        :value="precision.precision === null ? '—' : `${(precision.precision * 100).toFixed(0)} %`"
        :hint="
          precision.precision === null
            ? 'Todavía no se ha revisado ninguna propuesta'
            : `${precision.truePositives} acertadas de ${precision.reviewed} revisadas${
                precision.reviewed > 0 && !precision.sampleSufficient ? ' · pocas revisiones (mínimo 10)' : ''
              }`
        "
      />
      <AdminStat label="Propuestas" :value="precision.total" :hint="`${precision.pending} sin valorar`" />
    </div>

    <div v-if="loading" class="adm-table-skeleton" aria-busy="true" data-loading>
      <span class="sr-only">Cargando propuestas…</span>
      <div v-for="row in 3" :key="row"><i /><i /><i /></div>
    </div>
    <div v-else-if="!recommendations.length && !errorMessage" data-empty>
      <AdminEmptyState
        title="No hay propuestas"
        description="Pulsa «Analizar señales» cuando haya incidencias que revisar."
        icon="i-lucide-lightbulb"
      />
    </div>

    <ul v-else class="adm-stack">
      <li v-for="rec in recommendations" :key="rec.id" class="adm-card" data-recommendation>
        <div class="adm-card__body adm-stack">
          <div class="flex flex-wrap items-center gap-2">
            <span class="font-semibold text-[var(--text-strong)]">{{ rec.summary }}</span>
            <AdminBadge v-if="rec.destructive" tone="danger" data-destructive-badge>Acción delicada</AdminBadge>
            <AdminBadge :tone="statusTones[rec.status]" data-status>{{ statusLabels[rec.status] }}</AdminBadge>
            <span class="adm-help">Confianza {{ Math.round(rec.confidence * 100) }} %</span>
          </div>
          <div>
            <p class="adm-help">Procedimiento: {{ adminHumanize(rec.runbookId) }}</p>
            <ol class="mt-1 list-decimal space-y-0.5 pl-5 text-sm">
              <li v-for="(step, index) in rec.steps" :key="index">{{ step }}</li>
            </ol>
          </div>

          <div v-if="rec.status === 'proposed'" class="adm-stack">
            <div class="adm-field">
              <label class="adm-label" :for="`reason-${rec.id}`">Motivo de la decisión (mínimo 10 caracteres)</label>
              <input :id="`reason-${rec.id}`" v-model="reasons[rec.id]" type="text" maxlength="500" class="w-full" />
            </div>
            <label v-if="rec.destructive" class="adm-check">
              <input v-model="confirmed[rec.id]" type="checkbox" data-confirm-destructive />
              Entiendo que es una acción delicada y que la ejecutará una persona.
            </label>
            <div class="flex flex-wrap gap-2">
              <button
                type="button"
                class="adm-btn adm-btn--secondary adm-btn--sm"
                :disabled="busy || !canDecide(rec) || (rec.destructive && !confirmed[rec.id])"
                data-approve
                @click="decide(rec, 'approve')"
              >
                Aprobar
              </button>
              <button
                type="button"
                class="adm-btn adm-btn--secondary adm-btn--sm"
                :disabled="busy || !canDecide(rec)"
                data-reject
                @click="decide(rec, 'reject')"
              >
                Rechazar
              </button>
            </div>
          </div>

          <div v-else class="flex flex-wrap items-center gap-2 text-sm">
            <span v-if="rec.decisionReason">Motivo: {{ rec.decisionReason }}</span>
            <template v-if="rec.outcome === 'pending'">
              <button
                type="button"
                class="adm-btn adm-btn--secondary adm-btn--sm"
                :disabled="busy"
                data-label-true
                @click="label(rec, 'true_positive')"
              >
                Fue acertada
              </button>
              <button
                type="button"
                class="adm-btn adm-btn--secondary adm-btn--sm"
                :disabled="busy"
                data-label-false
                @click="label(rec, 'false_positive')"
              >
                Falsa alarma
              </button>
            </template>
            <span v-else data-outcome>
              Resultado: {{ rec.outcome === 'true_positive' ? 'acertada' : 'falsa alarma' }}
            </span>
          </div>
        </div>
      </li>
    </ul>
  </section>
</template>
