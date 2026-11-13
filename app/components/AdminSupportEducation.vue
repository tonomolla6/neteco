<script setup lang="ts">
import { randomId } from '../utils/uuid'
import { SLA_LABELS, formatBp } from '../utils/support-insights-labels'

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
          ? 'Esa página o producto no está publicado en la tienda. Revisa el dato.'
          : 'No se ha podido completar la acción. Vuelve a intentarlo.'
    if (code === 'concurrency_conflict') await load()
  } finally {
    busy.value = false
  }
}
const detect = () =>
  post(
    '/api/admin/support/education/detect',
    { from: day(-30), to: day(1), minOccurrences: 3 },
    'Búsqueda de preguntas repetidas terminada.'
  )
const candidateCommand = (c: Candidate, body: Record<string, unknown>) =>
  post(
    `/api/admin/support/education/candidates/${c.id}/commands`,
    { ...body, expectedVersion: c.version },
    'Pregunta actualizada.'
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
    notice.value = 'No se ha podido calcular el resultado.'
  }
}
const handoffCommand = (h: Handoff, action: 'claim' | 'resolve') =>
  post(
    `/api/admin/support/assistant/handoffs/${h.id}/commands`,
    { action, expectedVersion: h.version },
    'Consulta actualizada.'
  )
const statusTones: Record<string, 'neutral' | 'success' | 'warning' | 'danger' | 'info'> = {
  detected: 'warning',
  in_review: 'info',
  approved: 'success',
  published: 'success',
  rejected: 'danger'
}
const slaTones: Record<string, 'neutral' | 'success' | 'warning' | 'danger'> = {
  on_track: 'success',
  at_risk: 'warning',
  met: 'neutral',
  breached: 'danger'
}
const approvable = (c: Candidate) => formOf(c.id).notes.trim().length >= 10 && formOf(c.id).safety
onMounted(load)
</script>

<template>
  <section class="adm-stack">
    <AdminPageActions>
      <button type="button" data-test="detect" :disabled="busy" class="adm-btn adm-btn--primary" @click="detect">
        Buscar preguntas repetidas
      </button>
    </AdminPageActions>

    <UAlert
      v-if="state === 'error'"
      role="alert"
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      title="No hemos podido cargar las respuestas y guías"
    >
      <template #actions>
        <AdminButton size="sm" icon="i-lucide-rotate-cw" @click="load">Reintentar</AdminButton>
      </template>
    </UAlert>
    <UAlert v-else-if="notice" role="status" color="neutral" variant="subtle" icon="i-lucide-info" :title="notice" />
    <div v-if="state === 'loading'" class="adm-card">
      <div class="adm-table-skeleton" aria-busy="true">
        <span class="sr-only">Cargando…</span>
        <div v-for="row in 4" :key="row"><i /><i /><i /></div>
      </div>
    </div>

    <template v-if="state === 'ready'">
      <div v-if="stats" class="grid grid-cols-2 gap-5 lg:grid-cols-4">
        <AdminStat label="Preguntas al asistente" :value="stats.turns" hint="Últimos 30 días" />
        <AdminStat label="Respondidas" :value="formatBp(stats.answeredRateBp)" hint="Con información aprobada" />
        <AdminStat label="Sin respuesta" :value="stats.uncertain" hint="Faltaba información aprobada" />
        <AdminStat label="Pasadas a una persona" :value="formatBp(stats.handoffRateBp)" />
      </div>

      <AdminCard
        title="Preguntas repetidas"
        description="Lo que más preguntan los clientes: revísalo y publícalo como respuesta, guía o en la ficha del producto."
        flush
      >
        <AdminEmptyState
          v-if="candidates.length === 0"
          compact
          icon="i-lucide-message-circle-question"
          title="No hay preguntas repetidas pendientes de revisar"
          description="Pulsa «Buscar preguntas repetidas» para analizar los últimos 30 días."
        />
        <ul v-else class="adm-list">
          <li v-for="c in candidates" :key="c.id">
            <div class="min-w-0 flex-1 space-y-3">
              <div>
                <p class="adm-list__title">
                  {{ c.sampleQuestion }}
                  <AdminBadge :tone="statusTones[c.status] ?? 'neutral'">{{ statusLabels[c.status] }}</AdminBadge>
                </p>
                <p class="adm-help">{{ c.occurrences }} veces</p>
              </div>

              <div v-if="c.status === 'detected'">
                <button
                  type="button"
                  data-test="candidate-start-review"
                  :disabled="busy"
                  class="adm-btn adm-btn--secondary adm-btn--sm"
                  @click="candidateCommand(c, { action: 'start_review' })"
                >
                  Empezar revisión
                </button>
              </div>

              <div v-if="c.status === 'in_review'" class="adm-stack max-w-2xl">
                <AdminFormField
                  v-slot="{ id }"
                  label="Notas de la revisión"
                  help="Mínimo 10 caracteres: qué respuesta es la correcta y quién la ha validado."
                  required
                >
                  <textarea :id="id" v-model="formOf(c.id).notes" name="reviewNotes" rows="2" class="adm-input" />
                </AdminFormField>
                <AdminFormField v-slot="{ id }" label="Dónde se publicará">
                  <select :id="id" v-model="formOf(c.id).kind" class="adm-input w-auto">
                    <option value="faq">Preguntas frecuentes</option>
                    <option value="guide">Guía</option>
                    <option value="pdp">Ficha de producto</option>
                  </select>
                </AdminFormField>
                <label class="adm-check"
                  ><input v-model="formOf(c.id).safety" name="safetyReviewed" type="checkbox" /> He revisado que no
                  contiene indicaciones químicas sin validar</label
                >
                <div class="flex flex-wrap gap-2">
                  <button
                    type="button"
                    data-test="candidate-approve"
                    :disabled="busy || !approvable(c)"
                    class="adm-btn adm-btn--secondary adm-btn--sm"
                    @click="approve(c)"
                  >
                    Aprobar
                  </button>
                  <button
                    type="button"
                    data-test="candidate-reject"
                    :disabled="busy || formOf(c.id).notes.trim().length < 10"
                    class="adm-btn adm-btn--ghost adm-btn--sm"
                    @click="candidateCommand(c, { action: 'reject', reviewNotes: formOf(c.id).notes.trim() })"
                  >
                    Rechazar
                  </button>
                </div>
              </div>

              <div v-if="c.status === 'approved'" class="flex max-w-2xl flex-wrap items-end gap-2">
                <AdminFormField
                  v-slot="{ id }"
                  class="min-w-0 flex-1"
                  :label="
                    c.targetKind === 'pdp' ? 'Producto donde se ha publicado' : 'Página de ayuda donde se ha publicado'
                  "
                  :help="
                    c.targetKind === 'pdp'
                      ? 'El nombre del producto tal como aparece en su dirección web.'
                      : 'El identificador de la página de ayuda ya publicada.'
                  "
                >
                  <input :id="id" v-model="formOf(c.id).target" name="target" type="text" class="adm-input" />
                </AdminFormField>
                <button
                  type="button"
                  data-test="candidate-publish"
                  :disabled="busy || !formOf(c.id).target.trim()"
                  class="adm-btn adm-btn--secondary"
                  @click="publish(c)"
                >
                  Marcar como publicada
                </button>
              </div>

              <div v-if="c.status === 'published'" class="space-y-2">
                <button
                  type="button"
                  data-test="candidate-deflection"
                  class="adm-btn adm-btn--secondary adm-btn--sm"
                  @click="measure(c)"
                >
                  Ver resultado
                </button>
                <template v-if="deflections[c.id]">
                  <p v-if="deflections[c.id]!.status === 'insufficient_data'" class="adm-help">
                    Todavía no hay datos suficientes: {{ deflections[c.id]!.observedDays }} días observados (mínimo 7) o
                    pocas preguntas previas.
                  </p>
                  <p v-else>
                    Consultas evitadas: <strong>{{ formatBp(deflections[c.id]!.deflectionBp) }}</strong>
                  </p>
                  <p class="adm-help">
                    Preguntas antes de publicar: {{ deflections[c.id]!.before.turns }} ({{
                      formatBp(deflections[c.id]!.before.rateBp)
                    }}
                    necesitaron a una persona)
                  </p>
                  <p class="adm-help">
                    Preguntas después: {{ deflections[c.id]!.after.turns }} ({{
                      formatBp(deflections[c.id]!.after.rateBp)
                    }}
                    necesitaron a una persona)
                  </p>
                </template>
              </div>
            </div>
          </li>
        </ul>
      </AdminCard>

      <AdminCard
        title="Preguntas que necesitan a una persona"
        description="El asistente no pudo responderlas y el cliente espera contestación."
        flush
      >
        <AdminEmptyState
          v-if="handoffs.length === 0"
          compact
          icon="i-lucide-user-check"
          title="No hay preguntas esperando a una persona"
        />
        <ul v-else class="adm-list">
          <li v-for="h in handoffs" :key="h.id">
            <div class="min-w-0 flex-1">
              <p class="adm-list__title">
                <span class="break-words">{{ h.question }}</span>
                <AdminBadge :tone="slaTones[h.slaState] ?? 'neutral'">
                  {{ SLA_LABELS[h.slaState] ?? 'Sin plazo' }}
                </AdminBadge>
              </p>
              <p class="adm-help break-words">
                Responder antes del {{ adminDate(h.slaDueAt, true) }} ·
                {{ h.status === 'open' ? 'Sin asignar' : 'En curso' }}
                <template v-if="h.contactEmail"> · {{ h.contactEmail }}</template>
              </p>
            </div>
            <button
              v-if="h.status === 'open'"
              type="button"
              data-test="handoff-claim"
              :disabled="busy"
              class="adm-btn adm-btn--secondary adm-btn--sm"
              @click="handoffCommand(h, 'claim')"
            >
              Me encargo yo
            </button>
            <button
              v-if="h.status === 'claimed'"
              type="button"
              data-test="handoff-resolve"
              :disabled="busy"
              class="adm-btn adm-btn--secondary adm-btn--sm"
              @click="handoffCommand(h, 'resolve')"
            >
              Marcar como resuelta
            </button>
          </li>
        </ul>
      </AdminCard>
    </template>
  </section>
</template>
