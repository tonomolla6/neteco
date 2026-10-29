<script setup lang="ts">
import {
  PREFERENCE_CENTER_POLICY_VERSION,
  PREFERENCE_CHANNELS,
  PREFERENCE_FREQUENCIES,
  PREFERENCE_SECTORS,
  PREFERENCE_TOPICS,
  preferenceCenterReceiptSchema,
  preferenceCenterSnapshotSchema,
  preferenceCenterValuesSchema,
  type PreferenceCenterSnapshot
} from '~~/shared/preference-center'
import { catalogPolicyOwnJson } from '~~/shared/catalog-publication-policy'
import { randomId } from '../utils/uuid'

const props = defineProps<{ enabled: boolean }>()
const request = useRequestFetch(),
  prefix = useId()
const FREQUENCY: Record<string, string> = {
  weekly: 'Cada semana',
  biweekly: 'Cada dos semanas',
  monthly: 'Cada mes',
  quarterly: 'Cada trimestre',
  never: 'Nunca'
}
const TOPIC: Record<string, string> = {
  product_news: 'Novedades de producto',
  offers: 'Ofertas y promociones',
  usage_tips: 'Consejos de uso y dosificación',
  safety_regulation: 'Seguridad y normativa',
  replenishment: 'Avisos de reposición'
}
const SECTOR: Record<string, string> = {
  hospitality: 'Hostelería',
  healthcare: 'Sanitario',
  industrial: 'Industria',
  cleaning_services: 'Empresas de limpieza',
  food_industry: 'Industria alimentaria',
  education: 'Educación',
  home: 'Hogar',
  other: 'Otro'
}
const CHANNEL: Record<string, string> = { email: 'Email', sms: 'SMS', push: 'Notificaciones push' }
const SYNC: Record<string, string> = {
  pending: 'pendiente de sincronizar',
  synced: 'sincronizado',
  failed: 'con error, se reintentará',
  superseded: 'sustituido por un cambio posterior'
}
const phase = ref<'loading' | 'ready' | 'error' | 'saving'>('loading'),
  snapshot = shallowRef<PreferenceCenterSnapshot | null>(null),
  message = ref(''),
  acknowledged = ref(false),
  frequency = ref<(typeof PREFERENCE_FREQUENCIES)[number]>('never'),
  topics = ref<string[]>([]),
  sectors = ref<string[]>([]),
  channels = reactive({ email: false, sms: false, push: false })
let pendingKey: string | null = null,
  pendingSignature = ''

function fill(value: PreferenceCenterSnapshot) {
  snapshot.value = value
  frequency.value = value.preferences.frequency
  topics.value = [...value.preferences.topics]
  sectors.value = [...value.preferences.sectors]
  Object.assign(channels, value.preferences.channels)
  acknowledged.value = false
}
async function load() {
  if (!props.enabled) return
  phase.value = 'loading'
  message.value = ''
  try {
    fill(
      preferenceCenterSnapshotSchema.parse(
        catalogPolicyOwnJson(
          await request<unknown>('/api/account/preference-center', { method: 'GET', retry: 0, cache: 'no-store' })
        )
      )
    )
    phase.value = 'ready'
  } catch {
    snapshot.value = null
    phase.value = 'error'
  }
}
const draft = computed(() => ({
  frequency: frequency.value,
  topics: [...topics.value],
  sectors: [...sectors.value],
  channels: { ...channels },
  unsubscribeAll: false
}))
const validation = computed(() => preferenceCenterValuesSchema.safeParse(draft.value))
/** Consent is requested only for something newly switched on, never to withdraw. */
const needsAck = computed(() => {
  const before = snapshot.value?.preferences
  if (!before) return false
  return (
    PREFERENCE_CHANNELS.some((c) => channels[c] && !before.channels[c]) ||
    topics.value.some((t) => !(before.topics as string[]).includes(t))
  )
})
const canSave = computed(
  () => phase.value === 'ready' && validation.value.success && (!needsAck.value || acknowledged.value)
)
async function put(preferences: unknown, acknowledgedValue: boolean) {
  if (!snapshot.value || phase.value === 'saving') return
  const body = {
    expectedVersion: snapshot.value.version,
    policyVersion: PREFERENCE_CENTER_POLICY_VERSION,
    acknowledged: acknowledgedValue,
    preferences
  }
  // Re-use the key only for an identical retry, so a lost response replays safely.
  const signature = JSON.stringify(body)
  if (signature !== pendingSignature) {
    pendingKey = randomId()
    pendingSignature = signature
  }
  phase.value = 'saving'
  message.value = ''
  try {
    const receipt = preferenceCenterReceiptSchema.parse(
      catalogPolicyOwnJson(
        await request<unknown>('/api/account/preference-center', {
          method: 'PUT',
          body,
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': pendingKey! },
          retry: 0
        })
      )
    )
    pendingKey = null
    pendingSignature = ''
    await load()
    message.value = `Preferencias guardadas (versión ${receipt.version}). ESP: ${SYNC[receipt.sync.esp ?? 'pending']}. CMP: ${SYNC[receipt.sync.cmp ?? 'pending']}.`
  } catch (cause) {
    const code = (cause as { data?: { error?: { code?: string } } })?.data?.error?.code
    phase.value = 'ready'
    message.value =
      code === 'conflict'
        ? 'Tus preferencias han cambiado en otro lugar. Recarga para ver la versión actual.'
        : code === 'consent_required'
          ? 'Confirma de forma expresa las opciones que acabas de activar.'
          : 'No se ha podido confirmar el guardado. Puedes volver a intentarlo: no se duplicará.'
  }
}
const save = () => canSave.value && put(draft.value, acknowledged.value)
const unsubscribeAll = () =>
  put(
    {
      frequency: 'never',
      topics: [],
      sectors: [],
      channels: { email: false, sms: false, push: false },
      unsubscribeAll: true
    },
    false
  )
watch(() => props.enabled, load, { immediate: true })
</script>

<template>
  <section class="min-w-0 space-y-4 break-words" aria-labelledby="pc-title">
    <h2 id="pc-title" class="text-lg font-bold">Centro de preferencias</h2>
    <p>Elige qué quieres recibir, con qué frecuencia y por qué canal. Todo empieza desactivado.</p>
    <p v-if="!enabled">Necesitas una sesión de cuenta vigente y el email verificado.</p>
    <p v-if="phase === 'loading' && enabled" role="status">Cargando preferencias…</p>
    <div v-if="phase === 'error'" role="alert">
      No se han podido leer tus preferencias. Esto no significa que estén desactivadas.
      <button data-pc-retry type="button" class="underline" @click="load">Volver a consultar</button>
    </div>
    <p v-if="message" data-pc-message role="status">{{ message }}</p>
    <form v-if="snapshot && enabled" class="space-y-5" @submit.prevent="save">
      <fieldset :disabled="phase === 'saving'" class="space-y-2">
        <legend class="font-medium">Frecuencia</legend>
        <label v-for="f in PREFERENCE_FREQUENCIES" :key="f" class="flex items-center gap-2">
          <input v-model="frequency" type="radio" :value="f" :name="`${prefix}-freq`" :data-pc-frequency="f" />
          <span>{{ FREQUENCY[f] }}</span>
        </label>
      </fieldset>
      <fieldset :disabled="phase === 'saving'" class="space-y-2">
        <legend class="font-medium">Temas</legend>
        <label v-for="t in PREFERENCE_TOPICS" :key="t" class="flex items-center gap-2">
          <input v-model="topics" type="checkbox" :value="t" :data-pc-topic="t" />
          <span>{{ TOPIC[t] }}</span>
        </label>
      </fieldset>
      <fieldset :disabled="phase === 'saving'" class="space-y-2">
        <legend class="font-medium">Tu sector (para enviarte sólo lo relevante)</legend>
        <label v-for="s in PREFERENCE_SECTORS" :key="s" class="flex items-center gap-2">
          <input v-model="sectors" type="checkbox" :value="s" :data-pc-sector="s" />
          <span>{{ SECTOR[s] }}</span>
        </label>
      </fieldset>
      <fieldset :disabled="phase === 'saving'" class="space-y-2">
        <legend class="font-medium">Canales</legend>
        <label v-for="c in PREFERENCE_CHANNELS" :key="c" class="flex items-center gap-2">
          <input v-model="channels[c]" type="checkbox" :data-pc-channel="c" />
          <span>{{ CHANNEL[c] }}</span>
        </label>
      </fieldset>
      <p v-if="!validation.success" data-pc-invalid role="alert">
        Para recibir temas necesitas una frecuencia distinta de «Nunca» y al menos un canal.
      </p>
      <p class="text-sm">{{ snapshot.consentText }}</p>
      <label v-if="needsAck" class="flex items-start gap-2">
        <input v-model="acknowledged" type="checkbox" data-pc-ack />
        <span>Confirmo que quiero recibir las opciones que acabo de activar.</span>
      </label>
      <div class="flex flex-wrap gap-3">
        <button data-pc-save type="submit" class="rounded border px-4 py-2" :disabled="!canSave">
          Guardar preferencias
        </button>
        <button
          data-pc-unsubscribe
          type="button"
          class="rounded border px-4 py-2"
          :disabled="phase === 'saving'"
          @click="unsubscribeAll"
        >
          Darme de baja de todo
        </button>
      </div>
      <p v-if="snapshot.version > 0" class="text-sm" data-pc-sync>
        Sincronización con el proveedor de email (ESP): {{ SYNC[snapshot.sync.esp ?? 'pending'] }}. Con el gestor de
        campañas (CMP): {{ SYNC[snapshot.sync.cmp ?? 'pending'] }}.
      </p>
    </form>
  </section>
</template>
