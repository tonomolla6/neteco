<script setup lang="ts">
import {
  accountPreferencesInputSchema,
  accountPreferencesSnapshotSchema,
  accountPreferencesReceiptSchema,
  accountPreferencesCommandSchema,
  type AccountPreferencesInput,
  type AccountPreferencesSnapshot,
  type AccountPreferencesReceipt
} from '~~/shared/account-preferences'
import { catalogPolicyOwnJson, catalogPolicyUuidSchema } from '~~/shared/catalog-publication-policy'
import { randomId } from '../utils/uuid'
const props = defineProps<{ runtime: unknown; scopeKey: string; enabled: boolean; pending: boolean }>()
const emit = defineEmits<{ pending: [boolean]; confirmed: [AccountPreferencesReceipt] }>()
const session = useUserSession(),
  request = useRequestFetch(),
  prefix = useId()
const actor = computed(() => {
  const id = session.user.value?.id,
    sid = session.session.value?.sessionId,
    version = session.session.value?.sessionVersion
  if (
    props.runtime !== 'cloudflare' ||
    !props.enabled ||
    props.pending ||
    !props.scopeKey ||
    props.scopeKey.length > 500 ||
    !session.ready.value ||
    !session.loggedIn.value ||
    session.user.value?.emailVerified !== true ||
    !catalogPolicyUuidSchema.safeParse(id).success ||
    !catalogPolicyUuidSchema.safeParse(sid).success ||
    !Number.isSafeInteger(version) ||
    Number(version) < 1
  )
    return null
  return `${props.scopeKey}:${id}:${sid}:${version}:${session.user.value?.mfaVerified === true}`
})
type Intent = Readonly<{ owner: string; key: string; body: Readonly<AccountPreferencesInput> }>
const snapshot = shallowRef<AccountPreferencesSnapshot | null>(null),
  intent = shallowRef<Intent | null>(null),
  receipt = shallowRef<AccountPreferencesReceipt | null>(null)
const productUpdates = ref(false),
  replenishment = ref(false),
  acknowledged = ref(false),
  retryReady = ref(false),
  canRestart = ref(false),
  message = ref(''),
  blockedOwner = ref<string | null>(null)
const phase = ref<'idle' | 'loading' | 'ready' | 'error' | 'saving' | 'unknown' | 'confirmed'>('idle'),
  busy = ref<'read' | 'put' | 'lookup' | null>(null)
let alive = true,
  epoch = 0,
  controller: AbortController | null = null,
  commandPending = false
const allowed = computed(() => actor.value !== null && blockedOwner.value !== actor.value)
function setPending(value: boolean) {
  if (commandPending !== value) {
    commandPending = value
    emit('pending', value)
  }
}
function reset() {
  epoch++
  controller?.abort()
  controller = null
  snapshot.value = null
  intent.value = null
  receipt.value = null
  productUpdates.value = false
  replenishment.value = false
  acknowledged.value = false
  retryReady.value = false
  canRestart.value = false
  message.value = ''
  busy.value = null
  phase.value = 'idle'
  setPending(false)
}
function live(turn: number, owner: string) {
  return alive && allowed.value && epoch === turn && actor.value === owner
}
function currentForm(value: AccountPreferencesSnapshot) {
  productUpdates.value = value.preferences.product_updates
  replenishment.value = value.preferences.replenishment
  acknowledged.value = false
}
function failureInfo(cause: unknown) {
  const value = cause as {
    statusCode?: unknown
    status?: unknown
    response?: { status?: unknown }
    data?: { error?: { code?: unknown } }
  } | null
  return {
    status: Number(value?.statusCode ?? value?.status ?? value?.response?.status),
    code: value?.data?.error?.code
  }
}
function authorityLost(cause: unknown) {
  const { status, code } = failureInfo(cause)
  return status === 401 || (status === 403 && code !== 'csrf_rejected')
}
function revoke(owner: string) {
  reset()
  blockedOwner.value = owner
  message.value =
    'La autorización de tu cuenta ha cambiado. Los datos privados se han borrado; vuelve a verificar la sesión.'
}
async function load() {
  const owner = actor.value
  if (!owner || !allowed.value || !alive || busy.value || intent.value) return
  const turn = epoch,
    abort = new AbortController()
  controller = abort
  busy.value = 'read'
  phase.value = 'loading'
  snapshot.value = null
  productUpdates.value = false
  replenishment.value = false
  acknowledged.value = false
  message.value = ''
  try {
    const raw = await request<unknown>('/api/account/preferences', {
      method: 'GET',
      retry: 0,
      cache: 'no-store',
      signal: abort.signal,
      onRequest: () => {
        if (!live(turn, owner)) throw new Error('authority_changed')
      }
    })
    if (!live(turn, owner)) return
    const value = accountPreferencesSnapshotSchema.parse(catalogPolicyOwnJson(raw))
    snapshot.value = value
    currentForm(value)
    phase.value = 'ready'
  } catch (cause) {
    if (live(turn, owner)) {
      if (authorityLost(cause)) revoke(owner)
      else {
        phase.value = 'error'
        snapshot.value = null
      }
    }
  } finally {
    if (live(turn, owner)) {
      busy.value = null
      controller = null
    }
  }
}
function sameChoices(a: AccountPreferencesInput['preferences'], b: AccountPreferencesInput['preferences']) {
  return a.product_updates === b.product_updates && a.replenishment === b.replenishment
}
function verifyReceipt(raw: unknown, frozen: Intent) {
  const saved = accountPreferencesReceiptSchema.parse(catalogPolicyOwnJson(raw))
  if (
    saved.commandId !== frozen.key ||
    saved.expectedVersion !== frozen.body.expectedVersion ||
    !sameChoices(saved.preferences, frozen.body.preferences) ||
    saved.policyVersion !== frozen.body.policyVersion
  )
    throw new Error('unconfirmed_receipt')
  return saved
}
async function accept(raw: unknown, frozen: Intent, turn: number, abort: AbortController) {
  const saved = verifyReceipt(raw, frozen)
  receipt.value = saved
  const rawCurrent = await request<unknown>('/api/account/preferences', {
    method: 'GET',
    retry: 0,
    cache: 'no-store',
    signal: abort.signal,
    onRequest: () => {
      if (!live(turn, frozen.owner) || intent.value !== frozen) throw new Error('authority_changed')
    }
  })
  if (!live(turn, frozen.owner) || intent.value !== frozen) return
  const fresh = accountPreferencesSnapshotSchema.parse(catalogPolicyOwnJson(rawCurrent))
  if (
    fresh.version < saved.version ||
    (fresh.version === saved.version && !sameChoices(fresh.preferences, saved.preferences))
  )
    throw new Error('unconfirmed_current_preferences')
  snapshot.value = fresh
  currentForm(fresh)
  intent.value = null
  retryReady.value = false
  canRestart.value = false
  phase.value = 'confirmed'
  message.value =
    fresh.version > saved.version
      ? 'Cambio registrado. El estado actual incluye cambios posteriores; revisa las preferencias mostradas.'
      : 'Preferencias guardadas y estado actual confirmado. No se ha enviado ningún mensaje.'
  setPending(false)
  emit('confirmed', saved)
}
function commandFailure(cause: unknown, frozen: Intent, turn: number, wasUncertain: boolean) {
  if (!live(turn, frozen.owner) || intent.value !== frozen) return
  if (authorityLost(cause)) {
    revoke(frozen.owner)
    return
  }
  const { status, code } = failureInfo(cause)
  if (
    !wasUncertain &&
    ((code === 'invalid_input' && (status === 400 || status === 413)) ||
      (code === 'csrf_rejected' && status === 403) ||
      (code === 'rate_limited' && status === 429))
  ) {
    intent.value = null
    receipt.value = null
    acknowledged.value = false
    phase.value = 'ready'
    setPending(false)
    message.value =
      'Esta petición se ha rechazado antes de registrar el cambio. Revisa las preferencias y confirma de nuevo.'
    return
  }
  phase.value = 'unknown'
  message.value =
    'No hay confirmación completa del cambio. Consulta el recibo manualmente; no se reenviará de forma automática.'
}
async function send(frozen: Intent, wasUncertain = false) {
  if (!allowed.value || !alive || busy.value || intent.value !== frozen || actor.value !== frozen.owner) return
  const turn = epoch,
    abort = new AbortController()
  controller = abort
  busy.value = 'put'
  phase.value = 'saving'
  retryReady.value = false
  canRestart.value = false
  message.value = ''
  setPending(true)
  try {
    const raw = await request<unknown>('/api/account/preferences', {
      method: 'PUT',
      body: frozen.body,
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': frozen.key },
      retry: 0,
      signal: abort.signal,
      onRequest: () => {
        if (!live(turn, frozen.owner) || intent.value !== frozen) throw new Error('authority_changed')
      }
    })
    if (!live(turn, frozen.owner) || intent.value !== frozen) return
    await accept(raw, frozen, turn, abort)
  } catch (cause) {
    commandFailure(cause, frozen, turn, wasUncertain)
  } finally {
    if (live(turn, frozen.owner)) {
      busy.value = null
      controller = null
    }
  }
}
function submit() {
  const owner = actor.value
  if (!owner || !allowed.value || !alive || busy.value || intent.value || !snapshot.value || !acknowledged.value) return
  const parsed = accountPreferencesInputSchema.safeParse({
    expectedVersion: snapshot.value.version,
    policyVersion: snapshot.value.policyVersion,
    preferences: { product_updates: productUpdates.value, replenishment: replenishment.value }
  })
  if (!parsed.success) return
  const frozen = Object.freeze({
    owner,
    key: randomId(),
    body: Object.freeze({ ...parsed.data, preferences: Object.freeze({ ...parsed.data.preferences }) })
  })
  intent.value = frozen
  receipt.value = null
  void send(frozen)
}
async function check() {
  const frozen = intent.value
  if (!frozen || !allowed.value || !alive || busy.value || actor.value !== frozen.owner) return
  const turn = epoch,
    abort = new AbortController()
  controller = abort
  busy.value = 'lookup'
  retryReady.value = false
  canRestart.value = false
  message.value = ''
  try {
    const raw = await request<unknown>(`/api/account/preferences/commands/${frozen.key}`, {
      method: 'GET',
      retry: 0,
      cache: 'no-store',
      signal: abort.signal,
      onRequest: () => {
        if (!live(turn, frozen.owner) || intent.value !== frozen) throw new Error('authority_changed')
      }
    })
    if (!live(turn, frozen.owner) || intent.value !== frozen) return
    const command = accountPreferencesCommandSchema.parse(catalogPolicyOwnJson(raw))
    if (command.commandId !== frozen.key) throw new Error('unconfirmed_command')
    if (command.receipt) {
      await accept(command.receipt, frozen, turn, abort)
      return
    }
    if (receipt.value) throw new Error('previously_confirmed_command_missing')
    const rawCurrent = await request<unknown>('/api/account/preferences', {
      method: 'GET',
      retry: 0,
      cache: 'no-store',
      signal: abort.signal,
      onRequest: () => {
        if (!live(turn, frozen.owner) || intent.value !== frozen) throw new Error('authority_changed')
      }
    })
    if (!live(turn, frozen.owner) || intent.value !== frozen) return
    const fresh = accountPreferencesSnapshotSchema.parse(catalogPolicyOwnJson(rawCurrent))
    snapshot.value = fresh
    retryReady.value = fresh.version === frozen.body.expectedVersion
    canRestart.value = true
    phase.value = 'unknown'
    message.value =
      'Un recibo desconocido no demuestra que el cambio no se haya aplicado. Puedes consultar de nuevo o descartar sólo la intención local; no deshace ningún cambio.'
  } catch (cause) {
    commandFailure(cause, frozen, turn, true)
  } finally {
    if (live(turn, frozen.owner)) {
      busy.value = null
      controller = null
    }
  }
}
function replay() {
  if (retryReady.value && intent.value) void send(intent.value, true)
}
function restart() {
  if (!canRestart.value || busy.value || !snapshot.value || !allowed.value) return
  intent.value = null
  receipt.value = null
  retryReady.value = false
  canRestart.value = false
  currentForm(snapshot.value)
  phase.value = 'ready'
  message.value = 'Intención local descartada. Esto no cancela ni deshace un cambio registrado.'
  setPending(false)
}
watch(
  actor,
  () => {
    reset()
    blockedOwner.value = null
    if (actor.value) void load()
  },
  { immediate: true, flush: 'sync' }
)
onBeforeUnmount(() => {
  alive = false
  reset()
})
</script>
<template>
  <section class="min-w-0 space-y-4 break-words" aria-labelledby="preferences-title">
    <h2 id="preferences-title" class="text-lg font-bold">Avisos por email</h2>
    <p>Estas opciones guardan tus preferencias comerciales. No activan envíos, automatizaciones, SMS ni WhatsApp.</p>
    <a href="/cuenta/newsletter" class="inline-block underline">Gestionar la newsletter por separado (doble opt-in)</a>
    <p v-if="!allowed">Necesitas una sesión de cuenta vigente y el email verificado para gestionar estos avisos.</p>
    <p v-if="message" role="status">{{ message }}</p>
    <p v-if="busy" role="status">Comprobando preferencias…</p>
    <div v-if="allowed && phase === 'error'" role="alert">
      No se ha confirmado la lectura de tus preferencias. Esto no significa que estén desactivadas.
      <button data-preferences-retry type="button" class="underline" :disabled="!!busy" @click="load">
        Volver a consultar
      </button>
    </div>
    <p v-if="allowed && phase === 'unknown'" data-preferences-unknown role="alert">
      El resultado sigue sin confirmarse por completo.
    </p>
    <p v-if="allowed && phase === 'confirmed'" data-preferences-confirmed role="status">
      Cambio confirmado y preferencias actuales leídas.
    </p>
    <form v-if="allowed && snapshot" class="space-y-4" @submit.prevent="submit">
      <fieldset class="space-y-3" :disabled="!!busy || !!intent">
        <legend>Elige cada aviso por separado</legend>
        <label :for="`${prefix}-product`" class="flex items-start gap-3"
          ><input :id="`${prefix}-product`" v-model="productUpdates" data-preferences-product type="checkbox" /><span
            >Novedades de producto por email</span
          ></label
        >
        <label :for="`${prefix}-replenishment`" class="flex items-start gap-3"
          ><input
            :id="`${prefix}-replenishment`"
            v-model="replenishment"
            data-preferences-replenishment
            type="checkbox"
          /><span>Avisos comerciales de reposición por email</span></label
        >
        <p class="text-sm">{{ snapshot.consentText }}</p>
        <label :for="`${prefix}-ack`" class="flex items-start gap-3"
          ><input :id="`${prefix}-ack`" v-model="acknowledged" data-preferences-ack type="checkbox" /><span
            >Confirmo que quiero guardar estas elecciones (incluidas las opciones desactivadas).</span
          ></label
        >
      </fieldset>
      <button
        data-preferences-submit
        type="submit"
        :disabled="!acknowledged || !!busy || !!intent"
        class="rounded border px-4 py-2"
      >
        Guardar preferencias
      </button>
    </form>
    <div v-if="allowed && intent" class="flex flex-wrap gap-3">
      <button data-preferences-check type="button" class="rounded border px-4 py-2" :disabled="!!busy" @click="check">
        Consultar recibo y estado actual
      </button>
      <button
        v-if="retryReady"
        data-preferences-replay
        type="button"
        class="rounded border px-4 py-2"
        :disabled="!!busy"
        @click="replay"
      >
        Reenviar exactamente la misma petición
      </button>
      <button
        v-if="canRestart"
        data-preferences-restart
        type="button"
        class="underline"
        :disabled="!!busy"
        @click="restart"
      >
        Descartar sólo la intención local
      </button>
    </div>
  </section>
</template>
