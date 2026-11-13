<script setup lang="ts">
import {
  newsletterPreferenceSnapshotSchema,
  newsletterPreferenceInputSchema,
  newsletterCommandReceiptSchema,
  newsletterPrecommitRejectionSchema,
  newsletterHttpAuthorityLossSchema,
  type NewsletterPreference
} from '~~/shared/newsletter-editorial'
import type { z } from 'zod'
const props = defineProps<{
  endpoint: '/api/account/newsletter/preferences' | '/api/newsletter/preferences'
  bearer?: string
  actorId: string
  authorize: () => boolean
}>()
const fetch = useRequestFetch(),
  snapshot = ref<z.infer<typeof newsletterPreferenceSnapshotSchema> | null>(null),
  busy = ref(false),
  notice = ref(''),
  error = ref(''),
  confirming = ref(false)
const form = reactive({
  frequency: '' as '' | NewsletterPreference['frequency'],
  topics: [] as string[],
  quiet: false,
  start: '',
  end: ''
})
let epoch = 0,
  disposed = false,
  controller: AbortController | null = null
type Input = z.infer<typeof newsletterPreferenceInputSchema>
type Receipt = z.infer<typeof newsletterCommandReceiptSchema>
const pending = ref<{ body: Input; key: string; actor: string; resourceId: string; receipt: Receipt | null } | null>(
  null
)
const headers = (): Record<string, string> => (props.bearer ? { Authorization: `Bearer ${props.bearer}` } : {})
function allowed() {
  return !disposed && props.authorize() && props.actorId.length > 0
}
function clearPrivate() {
  controller?.abort()
  snapshot.value = null
  pending.value = null
  form.frequency = ''
  form.topics = []
  form.quiet = false
  form.start = ''
  form.end = ''
  confirming.value = false
  notice.value = ''
  busy.value = false
}
function clock(value: string) {
  const parts = /^(\d{2}):(\d{2})$/.exec(value)
  return parts ? Number(parts[1]) * 60 + Number(parts[2]) : -1
}
function time(value: number) {
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`
}
async function load() {
  if (busy.value) return
  const turn = ++epoch,
    actor = props.actorId
  if (!allowed()) {
    snapshot.value = null
    return
  }
  busy.value = true
  error.value = ''
  notice.value = ''
  controller = new AbortController()
  try {
    const parsed = newsletterPreferenceSnapshotSchema.parse(
      await fetch<unknown>(props.endpoint, {
        headers: headers(),
        retry: 0,
        signal: controller.signal,
        onRequest: () => {
          if (turn !== epoch || !allowed() || actor !== props.actorId) throw new Error('authority_changed')
        }
      })
    )
    if (turn !== epoch || actor !== props.actorId || !allowed()) return
    const intent = pending.value
    if (intent?.receipt) {
      if (parsed.subscriptionId !== intent.resourceId || parsed.revision < intent.receipt.revision)
        throw new Error('unconfirmed_snapshot')
      if (
        parsed.revision === intent.receipt.revision &&
        (intent.body.action === 'save'
          ? parsed.status !== 'confirmed' ||
            JSON.stringify(parsed.preference) !== JSON.stringify(intent.body.preference)
          : parsed.status !== 'unsubscribed')
      )
        throw new Error('unconfirmed_snapshot')
      pending.value = null
      confirming.value = false
      notice.value =
        parsed.revision > intent.receipt.revision
          ? 'Cambio guardado. Revisa las preferencias que ves ahora, porque incluyen cambios posteriores.'
          : intent.body.action === 'unsubscribe'
            ? 'Te hemos dado de baja del boletín.'
            : 'Preferencias guardadas.'
    }
    snapshot.value = parsed
    if (!pending.value) {
      const pref = parsed.preference
      form.frequency = pref?.frequency ?? ''
      form.topics = [...(pref?.topics ?? [])]
      form.quiet = !!pref?.quietHours
      form.start = pref?.quietHours ? time(pref.quietHours.startMinute) : ''
      form.end = pref?.quietHours ? time(pref.quietHours.endMinute) : ''
    }
  } catch (failure) {
    if (turn === epoch) {
      if (newsletterHttpAuthorityLossSchema.safeParse(failure).success || !allowed()) clearPrivate()
      snapshot.value = null
      error.value =
        'Ahora mismo no podemos mostrar tus preferencias del boletín. No se ha cambiado nada; prueba de nuevo en unos minutos.'
    }
  } finally {
    if (turn === epoch) busy.value = false
  }
}
async function send() {
  const intent = pending.value
  if (!intent || intent.receipt || !allowed() || intent.actor !== props.actorId || busy.value) return
  const turn = ++epoch
  busy.value = true
  error.value = ''
  notice.value = ''
  controller = new AbortController()
  try {
    const receipt = newsletterCommandReceiptSchema.parse(
      await fetch<unknown>(props.endpoint, {
        method: 'PUT',
        body: intent.body,
        headers: { ...headers(), 'Idempotency-Key': intent.key },
        retry: 0,
        signal: controller.signal,
        onRequest: () => {
          if (turn !== epoch || !allowed() || intent.actor !== props.actorId) throw new Error('authority_changed')
        }
      })
    )
    if (turn !== epoch || !allowed() || intent.actor !== props.actorId) return
    if (
      receipt.action !== intent.body.action ||
      receipt.revision !== intent.body.expectedRevision + 1 ||
      receipt.resourceId !== intent.resourceId
    )
      throw new Error('unconfirmed_receipt')
    pending.value = { ...intent, receipt }
    busy.value = false
    await load()
  } catch (failure) {
    if (turn === epoch) {
      if (newsletterHttpAuthorityLossSchema.safeParse(failure).success || !allowed()) {
        clearPrivate()
        error.value =
          'La sesión no autoriza esta lectura. Hemos retirado los datos privados; actualiza el estado tras verificar tu acceso.'
      } else if (newsletterPrecommitRejectionSchema.safeParse(failure).success) {
        pending.value = null
        snapshot.value = null
        error.value = 'No se ha podido guardar el cambio. Vuelve a cargar tus preferencias e inténtalo de nuevo.'
      } else error.value = 'No hemos podido confirmar que se haya guardado. Puedes reintentarlo sin miedo a duplicarlo.'
    }
  } finally {
    if (turn === epoch) busy.value = false
  }
}
function stage(action: 'save' | 'unsubscribe') {
  if (!snapshot.value?.subscriptionId || pending.value || busy.value || !allowed()) return
  const body =
    action === 'unsubscribe'
      ? { action, expectedRevision: snapshot.value.revision }
      : {
          action,
          expectedRevision: snapshot.value.revision,
          preference: {
            frequency: form.frequency,
            topics: [...form.topics],
            locale: 'es',
            quietHours: form.quiet
              ? { startMinute: clock(form.start), endMinute: clock(form.end), timezone: 'Europe/Madrid' }
              : null
          }
        }
  const parsed = newsletterPreferenceInputSchema.safeParse(body)
  if (!parsed.success) {
    error.value = 'Elige una frecuencia y, si activas las horas de silencio, un horario válido.'
    return
  }
  if (parsed.data.action === 'save') {
    Object.freeze(parsed.data.preference.topics)
    if (parsed.data.preference.quietHours) Object.freeze(parsed.data.preference.quietHours)
    Object.freeze(parsed.data.preference)
  }
  Object.freeze(parsed.data)
  pending.value = {
    body: parsed.data,
    key: crypto.randomUUID(),
    actor: props.actorId,
    resourceId: snapshot.value.subscriptionId,
    receipt: null
  }
  void send()
}
watch(
  () => [props.actorId, props.authorize(), props.bearer, props.endpoint],
  () => {
    epoch++
    clearPrivate()
    error.value = ''
    busy.value = false
    if (allowed()) void load()
  },
  { immediate: true }
)
onBeforeUnmount(() => {
  disposed = true
  epoch++
  clearPrivate()
})
</script>
<template>
  <section aria-label="Preferencias del boletín" class="space-y-5">
    <p
      v-if="notice"
      role="status"
      class="rounded-[var(--radius-control)] border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900"
    >
      {{ notice }}
    </p>
    <div
      v-if="error"
      role="alert"
      class="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-control)] border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
    >
      <span>{{ error }}</span>
      <button type="button" :disabled="busy || !allowed()" @click="load">Volver a cargar</button>
    </div>
    <div
      v-if="pending"
      class="rounded-[var(--radius-control)] border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
    >
      <p>Hay un cambio que todavía no se ha confirmado.</p>
      <button v-if="!pending.receipt" type="button" class="mt-2" :disabled="busy || !allowed()" @click="send">
        Reintentar el mismo cambio
      </button>
    </div>
    <p v-if="busy && !snapshot" role="status" class="text-sm text-[var(--text-muted)]">Cargando tus preferencias…</p>

    <template v-if="snapshot">
      <!-- 1 · Estado de la suscripción, en una frase -->
      <div class="rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--surface)] p-5 sm:p-6">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div class="min-w-0">
            <h2>Tu suscripción al boletín</h2>
            <p class="mt-1 text-sm text-[var(--text-muted)]">
              {{
                snapshot.status === 'confirmed'
                  ? 'Estás suscrito. Aquí decides de qué te escribimos y cada cuánto.'
                  : snapshot.status === 'pending'
                    ? 'Te falta confirmar la suscripción desde el correo que te enviamos.'
                    : snapshot.status === 'unsubscribed' || snapshot.status === 'suppressed'
                      ? 'Estás dado de baja: no te enviamos el boletín.'
                      : 'Todavía no estás suscrito al boletín.'
              }}
            </p>
          </div>
          <span
            class="shrink-0 rounded-full px-3 py-1 text-xs font-semibold"
            :class="
              snapshot.status === 'confirmed'
                ? 'bg-emerald-100 text-emerald-800'
                : snapshot.status === 'pending'
                  ? 'bg-amber-100 text-amber-800'
                  : 'bg-slate-100 text-slate-700'
            "
          >
            {{
              snapshot.status === 'confirmed'
                ? 'Suscrito'
                : snapshot.status === 'pending'
                  ? 'Pendiente de confirmar'
                  : snapshot.status === 'unsubscribed' || snapshot.status === 'suppressed'
                    ? 'De baja'
                    : 'Sin suscripción'
            }}
          </span>
        </div>
        <p v-if="!snapshot.canSave" class="mt-3 text-sm text-[var(--text)]">
          Para elegir temas y frecuencia primero tienes que suscribirte al boletín con el formulario del pie de página y
          confirmar el correo que recibirás.
        </p>
      </div>

      <form v-if="snapshot.canSave" class="space-y-5" @submit.prevent="stage('save')">
        <fieldset :disabled="busy || !!pending || !allowed()" class="space-y-5">
          <!-- 2 · Cada cuánto -->
          <div class="rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--surface)] p-5 sm:p-6">
            <h2>¿Cada cuánto quieres recibirlo?</h2>
            <p class="mt-1 text-sm text-[var(--text-muted)]">Nunca te escribiremos más a menudo de lo que elijas.</p>
            <div class="mt-4 grid gap-3 sm:grid-cols-3" role="radiogroup" aria-label="Frecuencia del boletín">
              <label
                v-for="option in [
                  { value: 'immediate', title: 'Cuando haya novedades', hint: 'En cuanto publiquemos algo nuevo.' },
                  { value: 'weekly', title: 'Una vez por semana', hint: 'Un resumen semanal como máximo.' },
                  { value: 'monthly', title: 'Una vez al mes', hint: 'Solo lo más importante del mes.' }
                ]"
                :key="option.value"
                class="flex cursor-pointer items-start gap-3 rounded-[var(--radius-surface)] border p-4 transition-colors"
                :class="
                  form.frequency === option.value
                    ? 'border-[var(--action)] bg-neteco-50'
                    : 'border-[var(--border)] hover:bg-[var(--surface-sunken)]'
                "
              >
                <input
                  v-model="form.frequency"
                  type="radio"
                  name="newsletter-frequency"
                  :value="option.value"
                  required
                  class="mt-0.5"
                />
                <span>
                  <span class="block text-sm font-semibold text-[var(--text-strong)]">{{ option.title }}</span>
                  <span class="mt-0.5 block text-xs text-[var(--text-muted)]">{{ option.hint }}</span>
                </span>
              </label>
            </div>
          </div>

          <!-- 3 · De qué -->
          <div class="rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--surface)] p-5 sm:p-6">
            <h2>¿Qué temas te interesan?</h2>
            <p class="mt-1 text-sm text-[var(--text-muted)]">
              Marca los que quieras. Si no marcas ninguno, recibirás el boletín general con todos los temas.
            </p>
            <div class="mt-4 grid gap-2 sm:grid-cols-2">
              <label
                v-for="topic in snapshot.topics"
                :key="topic.id"
                class="flex items-center gap-3 rounded-[var(--radius-control)] border border-[var(--border)] px-3 py-2.5 text-sm"
                :class="topic.active ? 'cursor-pointer hover:bg-[var(--surface-sunken)]' : 'opacity-60'"
              >
                <input v-model="form.topics" type="checkbox" :value="topic.code" :disabled="!topic.active" />
                <span class="font-medium text-[var(--text-strong)]"
                  >{{ topic.label }}{{ topic.active ? '' : ' (ya no disponible)' }}</span
                >
              </label>
            </div>
          </div>

          <!-- 4 · Cuándo no -->
          <div class="rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--surface)] p-5 sm:p-6">
            <h2>Horas de silencio</h2>
            <p class="mt-1 text-sm text-[var(--text-muted)]">
              Si lo activas, no te enviamos el boletín dentro de esa franja (hora peninsular).
            </p>
            <label class="mt-4 flex items-center gap-3 text-sm font-medium text-[var(--text-strong)]">
              <input v-model="form.quiet" type="checkbox" /> No enviarme el boletín en una franja horaria
            </label>
            <div v-if="form.quiet" class="mt-3 flex flex-wrap gap-4">
              <label>Desde <input v-model="form.start" type="time" required /></label>
              <label>Hasta <input v-model="form.end" type="time" required /></label>
            </div>
          </div>

          <div class="flex flex-wrap items-center gap-3">
            <button type="submit">Guardar preferencias</button>
            <p class="text-xs text-[var(--text-muted)]">
              Solo usamos lo que eliges aquí: no deducimos tus intereses de tus compras.
            </p>
          </div>
        </fieldset>
      </form>

      <div
        v-if="snapshot.canUnsubscribe"
        class="rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--surface)] p-5 sm:p-6"
      >
        <h2>Darte de baja</h2>
        <p class="mt-1 text-sm text-[var(--text-muted)]">
          Dejarás de recibir el boletín. Los avisos de tus pedidos y facturas no cambian.
        </p>
        <div class="mt-4">
          <button
            v-if="!confirming"
            type="button"
            :disabled="busy || !!pending || !allowed()"
            @click="confirming = true"
          >
            Darme de baja
          </button>
          <div v-else class="space-y-3">
            <p class="text-sm text-[var(--text)]">
              ¿Seguro? Para volver a recibirlo tendrás que suscribirte de nuevo y confirmar tu correo.
            </p>
            <button type="button" :disabled="busy || !!pending || !allowed()" @click="stage('unsubscribe')">
              Sí, darme de baja</button
            ><button type="button" @click="confirming = false">Cancelar</button>
          </div>
        </div>
      </div>
    </template>
  </section>
</template>
