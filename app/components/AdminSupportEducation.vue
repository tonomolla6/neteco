<script setup lang="ts">
import { randomId } from '../utils/uuid'
import { SLA_CLASSES, SLA_LABELS, formatBp, formatInstant } from '../utils/support-insights-labels'

/**
 * SUP-015: repeated questions -> expert review -> guide/FAQ/PDP -> measured deflection.
 * SUP-012: the assistant's human handoff queue and statistics.
 */
interface Candidate {
  id: string
  sampleQuestion: string
  occurrences: number
  status: 'detected' | 'in_review' | 'approved' | 'published' | 'rejected'
  targetKind: string | null
  publishedAt: string | null
  version: number
}
interface Handoff {
  id: string
  status: 'open' | 'claimed' | 'resolved'
  contactEmail: string | null
  question: string
  reason: string
  slaState: string
  slaDueAt: string
  version: number
}
interface Stats {
  turns: number
  answered: number
  uncertain: number
  handoffRequired: number
  handoffRequested: number
  answeredRateBp: number
  handoffRateBp: number
}
interface Window {
  turns: number
  escalated: number
  rateBp: number
  helpfulRateBp: number | null
}
interface Deflection {
  status: 'measured' | 'insufficient_data'
  observedDays: number
  before: Window
  after: Window
  deflectionBp: number | null
}
const request = useRequestFetch()
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
const state = ref<'loading' | 'ready' | 'error'>('loading'),
  notice = ref(''),
  busy = ref(false)
const candidates = ref<Candidate[]>([]),
  handoffs = ref<Handoff[]>([]),
  stats = ref<Stats | null>(null)
const statusLabels: Record<string, string> = {
  detected: 'Detectada',
  in_review: 'En revisión',
  approved: 'Aprobada',
  published: 'Publicada',
  rejected: 'Rechazada'
}
const forms = reactive<Record<string, { notes: string; safety: boolean; kind: string; target: string }>>({})
const deflections = reactive<Record<string, Deflection>>({})
const formOf = (id: string) => (forms[id] ??= { notes: '', safety: false, kind: 'faq', target: '' })

async function load() {
  state.value = 'loading'
  try {
    const [c, h, s] = await Promise.all([
      request('/api/admin/support/education/candidates') as Promise<{ items: Candidate[] }>,
      request('/api/admin/support/assistant/handoffs?limit=50') as Promise<{ items: Handoff[] }>,
      request(`/api/admin/support/assistant/stats?from=${day(-30)}&to=${day(1)}`) as Promise<Stats>
    ])
    candidates.value = c.items.filter((item) => item.status !== 'rejected')
    handoffs.value = h.items.filter((item) => item.status !== 'resolved')
    stats.value = s
    state.value = 'ready'
  } catch {
    state.value = 'error'
  }
}
async function post(url: string, body: Record<string, unknown>, done: string) {
  busy.value = true
  notice.value = ''
  try {
    await request(url, { method: 'POST', headers: { 'idempotency-key': randomId() }, body })
    notice.value = done
    await load()
  } catch (error) {
    const code = (error as { data?: { error?: { code?: string } } })?.data?.error?.code
    notice.value =
      code === 'concurrency_conflict'
        ? 'Otra persona ha modificado este elemento. Se ha recargado la lista.'
        : code === 'target_unavailable'
          ? 'El destino no está publicado como contenido aprobado.'
          : 'No se pudo completar la acción.'
    if (code === 'concurrency_conflict') await load()
  } finally {
    busy.value = false
  }
}
const detect = () =>
  post(
    '/api/admin/support/education/detect',
    { from: day(-30), to: day(1), minOccurrences: 3 },
    'Detección completada.'
  )
const candidateCommand = (c: Candidate, body: Record<string, unknown>) =>
  post(
    `/api/admin/support/education/candidates/${c.id}/commands`,
    { ...body, expectedVersion: c.version },
    'Candidato actualizado.'
  )
function approve(c: Candidate) {
  const f = formOf(c.id)
  return candidateCommand(c, {
    action: 'approve',
    reviewNotes: f.notes.trim(),
    targetKind: f.kind,
    safetyReviewed: true
  })
}
function publish(c: Candidate) {
  const f = formOf(c.id),
    target = f.target.trim()
  return candidateCommand(c, {
    action: 'publish',
    ...(c.targetKind === 'pdp' ? { targetProductSlug: target } : { targetPageId: target })
  })
}
async function measure(c: Candidate) {
  notice.value = ''
  try {
    deflections[c.id] = (await request(`/api/admin/support/education/candidates/${c.id}/deflection`)) as Deflection
  } catch {
    notice.value = 'No se pudo medir la deflexión.'
  }
}
const handoffCommand = (h: Handoff, action: 'claim' | 'resolve') =>
  post(
    `/api/admin/support/assistant/handoffs/${h.id}/commands`,
    { action, expectedVersion: h.version },
    'Derivación actualizada.'
  )
const approvable = (c: Candidate) => formOf(c.id).notes.trim().length >= 10 && formOf(c.id).safety
onMounted(load)
</script>

<template>
  <section class="space-y-8">
    <div>
      <h2 class="text-xl font-bold text-slate-900">Asistente y educación de soporte</h2>
      <p class="text-sm text-slate-500">SUP-012 / SUP-015: preguntas repetidas, revisión experta y deflexión medida.</p>
    </div>
    <p v-if="state === 'error'" role="alert" class="rounded-lg bg-red-50 p-4 text-sm text-red-700">
      No hemos podido cargar los datos del asistente.
    </p>
    <p v-else-if="notice" role="status" class="rounded-lg bg-slate-50 p-3 text-sm">{{ notice }}</p>
    <p v-if="state === 'loading'" class="text-sm text-slate-500">Cargando…</p>

    <template v-if="state === 'ready'">
      <dl v-if="stats" class="grid grid-cols-2 gap-3 md:grid-cols-4">
        <div class="rounded-xl border bg-white p-4">
          <dt class="text-xs uppercase text-slate-500">Consultas (30 días)</dt>
          <dd class="text-2xl font-bold">{{ stats.turns }}</dd>
        </div>
        <div class="rounded-xl border bg-white p-4">
          <dt class="text-xs uppercase text-slate-500">Respondidas con fuente</dt>
          <dd class="text-2xl font-bold">{{ formatBp(stats.answeredRateBp) }}</dd>
        </div>
        <div class="rounded-xl border bg-white p-4">
          <dt class="text-xs uppercase text-slate-500">Sin información aprobada</dt>
          <dd class="text-2xl font-bold">{{ stats.uncertain }}</dd>
        </div>
        <div class="rounded-xl border bg-white p-4">
          <dt class="text-xs uppercase text-slate-500">Derivadas a una persona</dt>
          <dd class="text-2xl font-bold">{{ formatBp(stats.handoffRateBp) }}</dd>
        </div>
      </dl>

      <div class="space-y-3">
        <div class="flex items-center justify-between">
          <h3 class="text-lg font-semibold">Preguntas repetidas</h3>
          <button
            type="button"
            data-test="detect"
            :disabled="busy"
            class="rounded-lg bg-neteco-600 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
            @click="detect"
          >
            Detectar preguntas repetidas
          </button>
        </div>
        <p
          v-if="candidates.length === 0"
          class="rounded-xl border border-dashed p-6 text-center text-sm text-slate-600"
        >
          No hay preguntas repetidas pendientes de revisar.
        </p>
        <article v-for="c in candidates" :key="c.id" class="rounded-xl border bg-white p-4">
          <div class="flex flex-wrap items-center gap-2 text-xs">
            <span class="rounded-full bg-blue-50 px-2 py-0.5 font-semibold text-blue-700">{{
              statusLabels[c.status]
            }}</span>
            <span>{{ c.occurrences }} veces</span>
          </div>
          <p class="mt-2 font-medium">{{ c.sampleQuestion }}</p>

          <button
            v-if="c.status === 'detected'"
            type="button"
            data-test="candidate-start-review"
            :disabled="busy"
            class="mt-3 rounded border px-3 py-1 text-sm"
            @click="candidateCommand(c, { action: 'start_review' })"
          >
            Iniciar revisión experta
          </button>

          <div v-if="c.status === 'in_review'" class="mt-3 space-y-2">
            <label class="block text-xs font-semibold uppercase text-slate-500"
              >Notas de la revisión experta
              <textarea
                v-model="formOf(c.id).notes"
                name="reviewNotes"
                rows="2"
                class="mt-1 block w-full rounded border border-slate-300 px-2 py-1 text-sm normal-case"
              />
            </label>
            <label class="block text-xs font-semibold uppercase text-slate-500"
              >Destino
              <select
                v-model="formOf(c.id).kind"
                class="mt-1 block rounded border border-slate-300 px-2 py-1 text-sm normal-case"
              >
                <option value="faq">FAQ</option>
                <option value="guide">Guía</option>
                <option value="pdp">Ficha de producto</option>
              </select>
            </label>
            <label class="flex items-center gap-2 text-sm"
              ><input v-model="formOf(c.id).safety" name="safetyReviewed" type="checkbox" /> He revisado que no contiene
              indicaciones químicas sin validar</label
            >
            <div class="flex gap-2">
              <button
                type="button"
                data-test="candidate-approve"
                :disabled="busy || !approvable(c)"
                class="rounded bg-emerald-600 px-3 py-1 text-sm font-semibold text-white disabled:opacity-50"
                @click="approve(c)"
              >
                Aprobar
              </button>
              <button
                type="button"
                data-test="candidate-reject"
                :disabled="busy || formOf(c.id).notes.trim().length < 10"
                class="rounded border px-3 py-1 text-sm disabled:opacity-50"
                @click="candidateCommand(c, { action: 'reject', reviewNotes: formOf(c.id).notes.trim() })"
              >
                Rechazar
              </button>
            </div>
          </div>

          <div v-if="c.status === 'approved'" class="mt-3 flex flex-wrap items-end gap-2">
            <label class="text-xs font-semibold uppercase text-slate-500"
              >{{ c.targetKind === 'pdp' ? 'Slug del producto publicado' : 'Id de la página de ayuda publicada' }}
              <input
                v-model="formOf(c.id).target"
                name="target"
                type="text"
                class="mt-1 block rounded border border-slate-300 px-2 py-1 text-sm normal-case"
              />
            </label>
            <button
              type="button"
              data-test="candidate-publish"
              :disabled="busy || !formOf(c.id).target.trim()"
              class="rounded bg-neteco-600 px-3 py-1 text-sm font-semibold text-white disabled:opacity-50"
              @click="publish(c)"
            >
              Registrar publicación
            </button>
          </div>

          <div v-if="c.status === 'published'" class="mt-3 space-y-2 text-sm">
            <button type="button" data-test="candidate-deflection" class="rounded border px-3 py-1" @click="measure(c)">
              Medir deflexión
            </button>
            <template v-if="deflections[c.id]">
              <p v-if="deflections[c.id]!.status === 'insufficient_data'">
                Datos insuficientes: {{ deflections[c.id]!.observedDays }} días observados (mínimo 7) o pocas consultas
                previas.
              </p>
              <p v-else>
                Deflexión real: <strong>{{ formatBp(deflections[c.id]!.deflectionBp) }}</strong>
              </p>
              <p>
                Consultas antes de publicar: {{ deflections[c.id]!.before.turns }} ({{
                  formatBp(deflections[c.id]!.before.rateBp)
                }}
                necesitaron a una persona)
              </p>
              <p>
                Consultas después: {{ deflections[c.id]!.after.turns }} ({{ formatBp(deflections[c.id]!.after.rateBp) }}
                necesitaron a una persona)
              </p>
            </template>
          </div>
        </article>
      </div>

      <div class="space-y-3">
        <h3 class="text-lg font-semibold">Derivaciones a una persona</h3>
        <p v-if="handoffs.length === 0" class="text-sm text-slate-500">No hay derivaciones pendientes.</p>
        <article v-for="h in handoffs" :key="h.id" class="rounded-xl border bg-white p-4 text-sm">
          <div class="flex flex-wrap items-center gap-2 text-xs">
            <span class="rounded-full px-2 py-0.5 font-semibold" :class="SLA_CLASSES[h.slaState]"
              >{{ SLA_LABELS[h.slaState] }} · {{ formatInstant(h.slaDueAt) }}</span
            >
            <span>{{ h.status === 'open' ? 'Sin asignar' : 'En curso' }}</span>
            <span v-if="h.contactEmail">{{ h.contactEmail }}</span>
          </div>
          <p class="mt-2">{{ h.question }}</p>
          <button
            v-if="h.status === 'open'"
            type="button"
            data-test="handoff-claim"
            :disabled="busy"
            class="mt-2 rounded border px-3 py-1"
            @click="handoffCommand(h, 'claim')"
          >
            Asignármela
          </button>
          <button
            v-if="h.status === 'claimed'"
            type="button"
            data-test="handoff-resolve"
            :disabled="busy"
            class="mt-2 rounded border px-3 py-1"
            @click="handoffCommand(h, 'resolve')"
          >
            Marcar resuelta
          </button>
        </article>
      </div>
    </template>
  </section>
</template>
