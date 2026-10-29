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
          ? 'Comando confirmado. El estado actual incluye cambios posteriores; revisa las preferencias mostradas.'
          : intent.body.action === 'unsubscribe'
            ? 'Baja confirmada y permanente. No puedes reactivarla guardando preferencias.'
            : 'Preferencias guardadas y confirmadas. No sustituyen el doble opt-in.'
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
      error.value = 'No hay una lectura confirmada de tus preferencias. No se ha activado ningún consentimiento.'
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
        error.value =
          'El servidor ha rechazado el comando antes de guardarlo. Actualiza el estado confirmado antes de preparar otro intento.'
      } else
        error.value =
          'Resultado no confirmado. Conservamos la misma petición y clave; comprueba el estado o reintenta manualmente.'
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
    error.value = 'Elige explícitamente frecuencia y un horario válido, sin temas duplicados.'
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
  <section aria-label="Preferencias newsletter" class="space-y-4">
    <p>
      Personalización únicamente mediante los temas y la frecuencia que elijas. No usa compras, seguimiento ni perfiles
      inferidos.
    </p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <button type="button" :disabled="busy || !allowed()" @click="load">Actualizar estado confirmado</button>
    <div v-if="pending" class="rounded border p-3">
      <p>Hay una petición pendiente de confirmar. El reintento conserva exactamente su contenido y clave.</p>
      <button v-if="!pending.receipt" type="button" :disabled="busy || !allowed()" @click="send">
        Reintentar misma petición
      </button>
    </div>
    <template v-if="snapshot">
      <p>
        Estado confirmado: {{ snapshot.status }} · Revisión {{ snapshot.revision }}.
        {{ snapshot.externalDelivery ? 'Entrega externa configurada por el servidor.' : 'Envío externo desactivado.' }}
      </p>
      <p v-if="!snapshot.canSave">
        Para recibir campañas necesitas una suscripción confirmada por doble opt-in. Guardar preferencias no crea
        consentimiento; una baja no se reactiva aquí.
      </p>
      <form v-if="snapshot.canSave" class="space-y-3" @submit.prevent="stage('save')">
        <fieldset :disabled="busy || !!pending || !allowed()" class="space-y-3">
          <label
            >Frecuencia
            <select v-model="form.frequency" aria-label="Frecuencia newsletter" required>
              <option value="" disabled>Elige una frecuencia</option>
              <option value="immediate">Al publicarse, con el límite aprobado</option>
              <option value="weekly">Como máximo semanal</option>
              <option value="monthly">Como máximo cada 31 días</option>
            </select></label
          >
          <fieldset>
            <legend>Temas explícitos</legend>
            <label v-for="topic in snapshot.topics" :key="topic.id" class="mr-4"
              ><input v-model="form.topics" type="checkbox" :value="topic.code" :disabled="!topic.active" />
              {{ topic.label }}{{ topic.active ? '' : ' (retirado)' }}</label
            >
          </fieldset>
          <p class="text-sm">
            Sin seleccionar temas eliges expresamente contenidos generales y todos los temas; la selección no se deduce
            de tu historial.
          </p>
          <label><input v-model="form.quiet" type="checkbox" /> Elegir horas de silencio adicionales (Madrid)</label>
          <div v-if="form.quiet">
            <label>Desde <input v-model="form.start" type="time" required /></label
            ><label>Hasta <input v-model="form.end" type="time" required /></label>
          </div>
          <button type="submit">Guardar preferencias explícitas</button>
        </fieldset>
      </form>
      <div v-if="snapshot.canUnsubscribe">
        <button v-if="!confirming" type="button" :disabled="busy || !!pending || !allowed()" @click="confirming = true">
          Darme de baja
        </button>
        <div v-else>
          <p>
            La baja retira el consentimiento y mantiene la supresión. No se podrá reactivar desde estas preferencias.
          </p>
          <button type="button" :disabled="busy || !!pending || !allowed()" @click="stage('unsubscribe')">
            Confirmar baja permanente</button
          ><button type="button" @click="confirming = false">Volver</button>
        </div>
      </div>
    </template>
  </section>
</template>
