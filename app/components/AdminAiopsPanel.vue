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
  return code ? `${fallback} (${code})` : fallback
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
    errorMessage.value = errorText(error, 'No se pudieron cargar las recomendaciones')
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

const correlate = () => mutate('correlate', {}, 'Correlación ejecutada.')
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
    decision === 'approve'
      ? 'Recomendación aprobada. La acción debe ejecutarla una persona.'
      : 'Recomendación rechazada.'
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
  <section class="space-y-4" aria-labelledby="aiops-title" data-aiops-panel>
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 id="aiops-title" class="text-lg font-semibold text-neutral-900">AIOps: recomendaciones de incidentes</h2>
        <p class="text-xs text-neutral-600">
          Solo recomienda. Nunca ejecuta acciones: las acciones destructivas requieren aprobación humana explícita.
        </p>
      </div>
      <button
        type="button"
        class="rounded bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
        :disabled="busy || loading"
        data-correlate
        @click="correlate"
      >
        Correlacionar señales
      </button>
    </div>

    <div v-if="errorMessage" role="alert" class="rounded bg-red-100 p-3 text-sm text-red-700" data-error>
      {{ errorMessage }}
      <button type="button" class="ml-2 underline" data-retry @click="load">Reintentar</button>
    </div>
    <div v-if="notice" role="status" class="rounded bg-emerald-100 p-3 text-sm text-emerald-700">{{ notice }}</div>

    <div v-if="precision" class="rounded border border-neutral-200 bg-white p-3 text-sm" data-precision>
      <strong>Precisión medida:</strong>
      <span v-if="precision.precision === null">sin recomendaciones revisadas todavía</span>
      <span v-else>
        {{ (precision.precision * 100).toFixed(0) }}% ({{ precision.truePositives }} acertadas /
        {{ precision.reviewed }} revisadas)
      </span>
      <span v-if="precision.reviewed > 0 && !precision.sampleSufficient" class="text-amber-700">
        · muestra insuficiente (mínimo 10)
      </span>
    </div>

    <p v-if="loading" class="py-4 text-center text-sm text-neutral-500" data-loading>Cargando recomendaciones...</p>
    <p
      v-else-if="!recommendations.length && !errorMessage"
      class="py-4 text-center text-sm text-neutral-500"
      data-empty
    >
      No hay recomendaciones. Ejecute la correlación cuando haya señales.
    </p>

    <ul v-else class="space-y-3">
      <li
        v-for="rec in recommendations"
        :key="rec.id"
        class="rounded-lg border bg-white p-4 shadow-sm"
        :class="rec.destructive ? 'border-red-300' : 'border-neutral-200'"
        data-recommendation
      >
        <div class="flex flex-wrap items-center gap-2">
          <span class="font-medium text-neutral-900">{{ rec.summary }}</span>
          <span
            v-if="rec.destructive"
            class="rounded bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-800"
            data-destructive-badge
          >
            Acción destructiva
          </span>
          <span class="text-xs text-neutral-500">confianza {{ Math.round(rec.confidence * 100) }}%</span>
          <span class="text-xs font-semibold" data-status>{{ rec.status }}</span>
        </div>
        <p class="mt-1 text-xs text-neutral-600">Runbook: {{ rec.runbookId }}</p>
        <ol class="mt-2 list-decimal space-y-0.5 pl-5 text-xs text-neutral-700">
          <li v-for="(step, index) in rec.steps" :key="index">{{ step }}</li>
        </ol>

        <div v-if="rec.status === 'proposed'" class="mt-3 space-y-2">
          <label class="block text-xs font-medium text-neutral-700" :for="`reason-${rec.id}`">
            Motivo de la decisión (mín. 10 caracteres)
          </label>
          <input
            :id="`reason-${rec.id}`"
            v-model="reasons[rec.id]"
            type="text"
            maxlength="500"
            class="w-full rounded border border-neutral-300 px-2 py-1 text-sm"
          />
          <label v-if="rec.destructive" class="flex items-center gap-2 text-xs text-red-800">
            <input v-model="confirmed[rec.id]" type="checkbox" data-confirm-destructive />
            Confirmo que entiendo que es una acción destructiva y que la ejecutará una persona.
          </label>
          <div class="flex gap-2">
            <button
              type="button"
              class="rounded bg-emerald-600 px-3 py-1 text-xs font-semibold text-white disabled:opacity-50"
              :disabled="busy || !canDecide(rec) || (rec.destructive && !confirmed[rec.id])"
              data-approve
              @click="decide(rec, 'approve')"
            >
              Aprobar
            </button>
            <button
              type="button"
              class="rounded border border-neutral-300 px-3 py-1 text-xs font-semibold disabled:opacity-50"
              :disabled="busy || !canDecide(rec)"
              data-reject
              @click="decide(rec, 'reject')"
            >
              Rechazar
            </button>
          </div>
        </div>

        <div v-else class="mt-3 flex flex-wrap items-center gap-2 text-xs text-neutral-600">
          <span v-if="rec.decisionReason">Motivo: {{ rec.decisionReason }}</span>
          <template v-if="rec.outcome === 'pending'">
            <button
              type="button"
              class="rounded border border-emerald-300 px-2 py-1 text-emerald-800 disabled:opacity-50"
              :disabled="busy"
              data-label-true
              @click="label(rec, 'true_positive')"
            >
              Fue acertada
            </button>
            <button
              type="button"
              class="rounded border border-amber-300 px-2 py-1 text-amber-800 disabled:opacity-50"
              :disabled="busy"
              data-label-false
              @click="label(rec, 'false_positive')"
            >
              Falsa alarma
            </button>
          </template>
          <span v-else data-outcome>Resultado: {{ rec.outcome }}</span>
        </div>
      </li>
    </ul>
  </section>
</template>
