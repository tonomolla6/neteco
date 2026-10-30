<script setup lang="ts">
import { z } from 'zod'

// SEC-036. Review queue for promotional / referral fraud. The server is the only authority: this
// panel just lists, shows the audit trail and submits versioned decisions with a mandatory note.
const runtime = useRuntimeConfig().public.serverRuntime
const { ready, loggedIn, user, session } = useUserSession()
const request = useRequestFetch()

const caseSchema = z.object({
  id: z.string().uuid(),
  context: z.enum(['referral', 'promotion']),
  refId: z.string(),
  decision: z.enum(['clear', 'review', 'hold']),
  score: z.number().int(),
  exceededKinds: z.array(z.enum(['identity', 'address', 'device', 'payment'])),
  status: z.string(),
  version: z.number().int().min(1),
  decidedAt: z.string().nullable(),
  createdAt: z.string(),
  appealStatus: z.enum(['pending', 'accepted', 'rejected']).nullable()
})
const listSchema = z.object({ items: z.array(caseSchema).max(200) })
const detailSchema = z.object({
  case: caseSchema,
  events: z.array(z.object({ action: z.string(), createdAt: z.string() })),
  appeal: z.object({ id: z.string(), status: z.string(), statement: z.string(), createdAt: z.string() }).nullable()
})
type CaseItem = z.infer<typeof caseSchema>
type Detail = z.infer<typeof detailSchema>

const items = shallowRef<CaseItem[]>([])
const detail = shallowRef<Detail | null>(null)
const loading = ref(false)
const loadError = ref('')
const actionError = ref('')
const notice = ref('')
const note = ref('')
const submitting = ref(false)
let generation = 0 // bumped only when the session scope changes
let loadSeq = 0 // bumped by every list reload
let disposed = false

const scope = computed(() =>
  JSON.stringify([ready.value, loggedIn.value, user.value?.id, session.value?.sessionId, session.value?.sessionVersion])
)
const allowed = computed(
  () => runtime === 'cloudflare' && ready.value && loggedIn.value && user.value?.emailVerified === true
)
const noteValid = computed(() => note.value.trim().length >= 3 && note.value.trim().length <= 1000)

const kindLabels = { identity: 'identidad', address: 'dirección', device: 'dispositivo', payment: 'pago' } as const
const decisionLabels = { clear: 'Sin señales', review: 'En revisión', hold: 'Retenida' } as const
const statusLabels: Record<string, string> = {
  closed: 'Cerrado',
  open: 'Pendiente de revisión',
  released: 'Liberado',
  upheld: 'Abuso confirmado',
  appealed: 'Apelación pendiente',
  appeal_accepted: 'Apelación aceptada',
  appeal_rejected: 'Apelación rechazada'
}
function describe(failure: unknown) {
  const code = (failure as { data?: { error?: { code?: string } } })?.data?.error?.code
  const messages: Record<string, string> = {
    forbidden: 'No tienes permiso para revisar casos de fraude.',
    mfa_required: 'Verifica el segundo factor para revisar casos.',
    unauthenticated: 'Tu sesión ha caducado.',
    version_conflict: 'El caso cambió mientras lo revisabas; se ha recargado.',
    invalid_transition: 'El caso ya no admite esta decisión; se ha recargado.',
    same_reviewer: 'Otra persona debe resolver la apelación de una decisión tuya.',
    self_review: 'No puedes revisar un caso de tu propia cuenta.',
    rate_limited: 'Demasiadas acciones seguidas. Espera un momento.',
    invalid_input: 'Revisa la nota (3 a 1000 caracteres).'
  }
  return (code && messages[code]) || 'No se pudo completar la operación. Inténtalo de nuevo.'
}

async function load() {
  if (!allowed.value) return
  const epoch = generation
  const seq = ++loadSeq
  loading.value = true
  loadError.value = ''
  try {
    const value = listSchema.parse(
      await request('/api/admin/promo-fraud/cases', { query: { filter: 'pending' }, cache: 'no-store', retry: 0 })
    )
    if (!disposed && epoch === generation && seq === loadSeq) items.value = value.items
  } catch (failure) {
    if (!disposed && epoch === generation && seq === loadSeq) {
      items.value = []
      loadError.value = failure instanceof z.ZodError ? 'Respuesta no válida del servidor.' : describe(failure)
    }
  } finally {
    if (epoch === generation && seq === loadSeq) loading.value = false
  }
}
async function open(id: string) {
  if (!allowed.value) return
  const epoch = generation
  actionError.value = ''
  notice.value = ''
  note.value = ''
  try {
    const value = detailSchema.parse(
      await request(`/api/admin/promo-fraud/cases/${id}`, { cache: 'no-store', retry: 0 })
    )
    if (!disposed && epoch === generation) detail.value = value
  } catch (failure) {
    if (!disposed && epoch === generation) actionError.value = describe(failure)
  }
}
async function submit(kind: 'decision' | 'appeal-resolution', outcome: string, success: string) {
  const current = detail.value
  if (!allowed.value || !current || submitting.value || !noteValid.value) return
  const epoch = generation
  submitting.value = true
  actionError.value = ''
  notice.value = ''
  const id = current.case.id
  try {
    await request(`/api/admin/promo-fraud/cases/${id}/${kind}`, {
      method: 'POST',
      body: { expectedVersion: current.case.version, outcome, note: note.value.trim() },
      cache: 'no-store',
      retry: 0
    })
    if (disposed || epoch !== generation) return
    detail.value = null
    note.value = ''
    await load()
    notice.value = success
  } catch (failure) {
    if (disposed || epoch !== generation) return
    await load()
    await open(id)
    actionError.value = describe(failure)
  } finally {
    if (epoch === generation) submitting.value = false
  }
}
function purge() {
  generation++
  items.value = []
  detail.value = null
  loadError.value = ''
  actionError.value = ''
  notice.value = ''
  note.value = ''
  submitting.value = false
  loading.value = false
}
watch(
  scope,
  () => {
    purge()
    void load()
  },
  { flush: 'sync' }
)
onMounted(() => void load())
onBeforeUnmount(() => {
  disposed = true
  purge()
})
const date = (value: string) => new Date(value).toLocaleString('es-ES', { timeZone: 'Europe/Madrid' })
</script>

<template>
  <section class="mx-auto w-full min-w-0 max-w-5xl space-y-5 px-4 py-6" aria-labelledby="pf-title">
    <h1 id="pf-title" class="text-2xl font-semibold">Fraude promocional y referidos</h1>
    <p class="text-sm">
      Una única señal solo pide revisión y no bloquea la ventaja; la retención exige al menos dos señales
      independientes. Toda decisión queda registrada y el cliente puede apelar.
    </p>
    <p v-if="runtime !== 'cloudflare'" role="status">Esta función requiere el catálogo Cloudflare.</p>
    <p v-else-if="!allowed" role="status">Inicia sesión con una cuenta de administración verificada.</p>
    <template v-else>
      <p v-if="loading" data-pf-loading role="status">Cargando casos…</p>
      <div v-if="loadError" data-pf-error role="alert" class="space-y-2">
        <p>{{ loadError }}</p>
        <button type="button" data-pf-retry class="rounded border px-3 py-1" @click="load">Reintentar</button>
      </div>
      <p v-else-if="!loading && !items.length" data-pf-empty>No hay casos pendientes de revisión.</p>
      <ul v-if="items.length" data-pf-list class="space-y-3">
        <li v-for="item in items" :key="item.id" :data-pf-case="item.id" class="min-w-0 break-words rounded border p-4">
          <p class="font-medium">
            {{ decisionLabels[item.decision] }} · puntuación {{ item.score }} ·
            {{ statusLabels[item.status] ?? item.status }}
          </p>
          <p class="text-sm">
            {{ item.context === 'referral' ? 'Referido' : 'Promoción' }} {{ item.refId }} · {{ date(item.createdAt) }}
          </p>
          <p class="text-sm">
            Señales superadas:
            <template v-if="item.exceededKinds.length">{{
              item.exceededKinds.map((k) => kindLabels[k]).join(', ')
            }}</template>
            <template v-else>ninguna</template>
          </p>
          <button type="button" :data-pf-open="item.id" class="mt-2 rounded border px-3 py-1" @click="open(item.id)">
            Revisar<span class="sr-only"> {{ item.refId }}</span>
          </button>
        </li>
      </ul>
      <p v-if="notice" data-pf-notice role="status">{{ notice }}</p>
      <p v-if="actionError" data-pf-error role="alert" class="break-words">{{ actionError }}</p>

      <section v-if="detail" data-pf-detail class="space-y-3 rounded border p-4" aria-label="Detalle del caso">
        <h2 class="font-medium">Caso {{ detail.case.refId }} · versión {{ detail.case.version }}</h2>
        <ol class="space-y-1 text-sm">
          <li v-for="(event, i) in detail.events" :key="i">{{ date(event.createdAt) }} — {{ event.action }}</li>
        </ol>
        <div v-if="detail.appeal" data-pf-appeal class="rounded border p-3">
          <p class="font-medium">Apelación del cliente</p>
          <p class="break-words">{{ detail.appeal.statement }}</p>
        </div>
        <label for="pf-note" class="block font-medium">Nota de la decisión (obligatoria)</label>
        <textarea
          id="pf-note"
          v-model="note"
          data-pf-note
          rows="3"
          maxlength="1000"
          class="block w-full rounded border p-2"
        />
        <div class="flex flex-wrap gap-2">
          <template v-if="detail.case.status === 'open'">
            <button
              type="button"
              data-pf-release
              class="rounded border px-4 py-2"
              :disabled="submitting || !noteValid"
              @click="submit('decision', 'release', 'Decisión registrada: promoción liberada.')"
            >
              Liberar
            </button>
            <button
              type="button"
              data-pf-uphold
              class="rounded border px-4 py-2"
              :disabled="submitting || !noteValid"
              @click="submit('decision', 'uphold', 'Decisión registrada: abuso confirmado.')"
            >
              Confirmar abuso
            </button>
          </template>
          <template v-else-if="detail.case.status === 'appealed'">
            <button
              type="button"
              data-pf-accept
              class="rounded border px-4 py-2"
              :disabled="submitting || !noteValid"
              @click="submit('appeal-resolution', 'accept', 'Apelación aceptada: ventaja liberada.')"
            >
              Aceptar apelación
            </button>
            <button
              type="button"
              data-pf-reject
              class="rounded border px-4 py-2"
              :disabled="submitting || !noteValid"
              @click="submit('appeal-resolution', 'reject', 'Apelación rechazada: decisión definitiva.')"
            >
              Rechazar apelación
            </button>
          </template>
          <p v-else>Este caso ya no admite decisiones.</p>
        </div>
      </section>
    </template>
  </section>
</template>
