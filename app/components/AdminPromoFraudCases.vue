<script setup lang="ts">
import { z } from 'zod'

// Review queue for promotional / referral fraud. The server is the only authority: this
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
const date = (value: string) => adminDate(value, true)
const eventLabels: Record<string, string> = {
  assessed: 'Caso detectado automáticamente',
  released: 'Promoción liberada',
  release: 'Promoción liberada',
  upheld: 'Abuso confirmado',
  uphold: 'Abuso confirmado',
  appeal_submitted: 'El cliente presentó una apelación',
  appeal_accepted: 'Apelación aceptada',
  appeal_rejected: 'Apelación rechazada'
}
const decisionTones = { clear: 'success', review: 'warning', hold: 'danger' } as const
const statusTones: Record<string, 'neutral' | 'success' | 'warning' | 'danger' | 'info'> = {
  open: 'warning',
  appealed: 'info',
  released: 'success',
  appeal_accepted: 'success',
  upheld: 'danger',
  appeal_rejected: 'danger'
}
/** Las referencias largas (UUID) se abrevian; los códigos de promoción se muestran tal cual. */
const shortRef = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value) ? `#${value.slice(0, 8).toUpperCase()}` : value
</script>

<template>
  <section class="adm-stack min-w-0" aria-labelledby="pf-title">
    <h2 id="pf-title" class="sr-only">Casos de fraude promocional</h2>
    <UAlert
      v-if="runtime !== 'cloudflare'"
      role="status"
      color="warning"
      variant="subtle"
      icon="i-lucide-info"
      title="Esta función no está disponible en este entorno."
    />
    <UAlert
      v-else-if="!allowed"
      role="status"
      color="warning"
      variant="subtle"
      icon="i-lucide-lock"
      title="Inicia sesión con una cuenta de administración verificada."
    />
    <template v-else>
      <AdminPageActions>
        <AdminButton icon="i-lucide-rotate-cw" :loading="loading" @click="load">Actualizar</AdminButton>
      </AdminPageActions>

      <UAlert
        v-if="notice"
        data-pf-notice
        role="status"
        color="success"
        variant="subtle"
        icon="i-lucide-circle-check"
        :title="notice"
      />

      <div class="grid items-start gap-5" :class="detail && 'lg:grid-cols-2'">
        <AdminCard
          title="Casos pendientes de revisión"
          description="Usos de promociones o referidos que el sistema ha retenido por parecer abuso."
          flush
        >
          <template #actions>
            <AdminBadge v-if="items.length" tone="warning">{{ items.length }}</AdminBadge>
          </template>
          <div v-if="loading" data-pf-loading role="status" class="adm-table-skeleton" aria-busy="true">
            <span class="sr-only">Cargando casos…</span>
            <div v-for="row in 3" :key="row"><i /><i /><i /></div>
          </div>
          <div v-if="loadError" data-pf-error role="alert">
            <AdminEmptyState variant="error" compact title="No se han podido cargar los casos" :description="loadError">
              <button type="button" data-pf-retry class="adm-btn adm-btn--secondary" @click="load">Reintentar</button>
            </AdminEmptyState>
          </div>
          <div v-else-if="!loading && !items.length" data-pf-empty>
            <AdminEmptyState
              compact
              icon="i-lucide-shield-check"
              title="No hay casos pendientes de revisión"
              description="Cuando el sistema retenga una promoción sospechosa aparecerá aquí."
            />
          </div>
          <ul v-if="items.length" data-pf-list class="adm-list">
            <li
              v-for="item in items"
              :key="item.id"
              :data-pf-case="item.id"
              class="min-w-0 break-words"
              :class="detail?.case.id === item.id && 'bg-[var(--surface-sunken)]'"
            >
              <div class="min-w-0 flex-1">
                <p class="adm-list__title">
                  {{ item.context === 'referral' ? 'Referido' : 'Promoción' }} {{ shortRef(item.refId) }}
                  <AdminBadge :tone="decisionTones[item.decision]">{{ decisionLabels[item.decision] }}</AdminBadge>
                  <AdminBadge :tone="statusTones[item.status] ?? 'neutral'" plain>
                    {{ statusLabels[item.status] ?? adminHumanize(item.status) }}
                  </AdminBadge>
                </p>
                <p class="adm-help">
                  {{ date(item.createdAt) }} · puntuación de riesgo {{ item.score }} · señales:
                  <template v-if="item.exceededKinds.length">{{
                    item.exceededKinds.map((k) => kindLabels[k]).join(', ')
                  }}</template>
                  <template v-else>ninguna</template>
                </p>
              </div>
              <button
                type="button"
                :data-pf-open="item.id"
                class="adm-btn adm-btn--secondary adm-btn--sm"
                @click="open(item.id)"
              >
                Revisar<span class="sr-only"> {{ item.refId }}</span>
              </button>
            </li>
          </ul>
        </AdminCard>

        <div v-if="actionError || detail" class="adm-stack min-w-0">
          <UAlert
            v-if="actionError"
            data-pf-error
            role="alert"
            color="error"
            variant="subtle"
            icon="i-lucide-triangle-alert"
            :title="actionError"
            class="break-words"
          />

          <section v-if="detail" data-pf-detail class="adm-card" aria-label="Detalle del caso">
            <div class="adm-card__head">
              <div class="min-w-0">
                <h2 class="adm-card__title">
                  {{ detail.case.context === 'referral' ? 'Referido' : 'Promoción' }}
                  {{ shortRef(detail.case.refId) }}
                </h2>
                <p class="adm-card__hint">
                  {{ statusLabels[detail.case.status] ?? adminHumanize(detail.case.status) }} · puntuación de riesgo
                  {{ detail.case.score }}
                </p>
              </div>
              <AdminButton variant="ghost" size="sm" icon="i-lucide-x" label="Cerrar detalle" @click="detail = null" />
            </div>
            <div class="adm-card__body adm-stack">
              <div>
                <h3 class="adm-label">Historial</h3>
                <ol class="mt-1 space-y-1">
                  <li v-for="(event, i) in detail.events" :key="i" class="flex flex-wrap gap-x-2">
                    <span class="text-[var(--text-muted)]">{{ date(event.createdAt) }}</span>
                    <span>{{ eventLabels[event.action] ?? adminHumanize(event.action) }}</span>
                  </li>
                </ol>
              </div>
              <div
                v-if="detail.appeal"
                data-pf-appeal
                class="rounded-[var(--radius-control)] border border-[var(--border)] bg-[var(--surface-sunken)] p-3"
              >
                <p class="adm-label">Apelación del cliente</p>
                <p class="break-words">{{ detail.appeal.statement }}</p>
              </div>
              <div class="adm-field">
                <label for="pf-note" class="adm-label">Nota de la decisión (obligatoria)</label>
                <textarea id="pf-note" v-model="note" data-pf-note rows="3" maxlength="1000" class="adm-input" />
                <p class="adm-help">Entre 3 y 1000 caracteres. Queda guardada en el historial del caso.</p>
              </div>
            </div>
            <div class="adm-card__foot">
              <template v-if="detail.case.status === 'open'">
                <button
                  type="button"
                  data-pf-uphold
                  class="adm-btn adm-btn--danger-soft"
                  :disabled="submitting || !noteValid"
                  @click="submit('decision', 'uphold', 'Decisión registrada: abuso confirmado.')"
                >
                  Confirmar abuso
                </button>
                <button
                  type="button"
                  data-pf-release
                  class="adm-btn adm-btn--primary"
                  :disabled="submitting || !noteValid"
                  @click="submit('decision', 'release', 'Decisión registrada: promoción liberada.')"
                >
                  Liberar
                </button>
              </template>
              <template v-else-if="detail.case.status === 'appealed'">
                <button
                  type="button"
                  data-pf-reject
                  class="adm-btn adm-btn--danger-soft"
                  :disabled="submitting || !noteValid"
                  @click="submit('appeal-resolution', 'reject', 'Apelación rechazada: decisión definitiva.')"
                >
                  Rechazar apelación
                </button>
                <button
                  type="button"
                  data-pf-accept
                  class="adm-btn adm-btn--primary"
                  :disabled="submitting || !noteValid"
                  @click="submit('appeal-resolution', 'accept', 'Apelación aceptada: ventaja liberada.')"
                >
                  Aceptar apelación
                </button>
              </template>
              <p v-else class="adm-help mr-auto">Este caso ya no admite decisiones.</p>
            </div>
          </section>
        </div>
      </div>
    </template>
  </section>
</template>
