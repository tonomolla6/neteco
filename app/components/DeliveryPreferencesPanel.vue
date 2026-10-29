<script setup lang="ts">
import {
  deliveryPreferencesInputSchema,
  deliveryPreferencesSnapshotSchema,
  deliveryPreferencesReceiptSchema,
  deliveryPreferencesCommandSchema,
  deliveryPreferenceIntentHash,
  type DeliveryPreferencesInput,
  type DeliveryPreferencesSnapshot,
  type DeliveryPreferencesReceipt
} from '~~/shared/delivery-preferences'
import { catalogPolicyOwnJson, catalogPolicyUuidSchema } from '~~/shared/catalog-publication-policy'
import { randomId } from '../utils/uuid'
const props = defineProps<{ scopeKey: string; enabled: boolean; pending: boolean }>()
const emit = defineEmits<{ pending: [boolean]; confirmed: [DeliveryPreferencesReceipt] }>()
const session = useUserSession(),
  request = useRequestFetch(),
  prefix = useId()
const owner = computed(() => {
  const id = session.user.value?.id,
    sid = session.session.value?.sessionId,
    version = session.session.value?.sessionVersion
  if (
    !props.enabled ||
    props.pending ||
    !props.scopeKey ||
    props.scopeKey.length > 1000 ||
    !session.ready.value ||
    !session.loggedIn.value ||
    session.user.value?.emailVerified !== true ||
    !catalogPolicyUuidSchema.safeParse(id).success ||
    !catalogPolicyUuidSchema.safeParse(sid).success ||
    !Number.isSafeInteger(version) ||
    Number(version) < 1
  )
    return null
  return JSON.stringify([props.scopeKey, id, sid, version])
})
type Intent = Readonly<{ owner: string; key: string; body: Readonly<DeliveryPreferencesInput>; hash: string }>
const snapshot = shallowRef<DeliveryPreferencesSnapshot | null>(null),
  intent = shallowRef<Intent | null>(null)
const deliveryUpdates = ref(true),
  canDiscard = ref(false),
  receiptSeen = ref(false),
  acknowledged = ref(false),
  message = ref(''),
  blockedOwner = ref<string | null>(null)
const phase = ref<'idle' | 'loading' | 'ready' | 'error' | 'saving' | 'unknown' | 'confirmed'>('idle'),
  busy = ref(false)
let alive = true,
  epoch = 0,
  controller: AbortController | null = null,
  commandPending = false
const allowed = computed(() => !!owner.value && blockedOwner.value !== owner.value)
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
  canDiscard.value = false
  receiptSeen.value = false
  acknowledged.value = false
  deliveryUpdates.value = true
  message.value = ''
  busy.value = false
  phase.value = 'idle'
  setPending(false)
}
function live(turn: number, actor: string) {
  return alive && allowed.value && epoch === turn && owner.value === actor
}
function status(cause: unknown) {
  const error = cause as { statusCode?: number; status?: number; response?: { status?: number } } | null
  return error?.statusCode ?? error?.status ?? error?.response?.status
}
function failure(cause: unknown, actor: string) {
  if ([401, 403].includes(Number(status(cause)))) {
    reset()
    blockedOwner.value = actor
    message.value = 'La autorización ha cambiado. Los datos de esta cuenta se han borrado; verifica de nuevo la sesión.'
    return true
  }
  return false
}
async function readCurrent(turn: number, actor: string, abort: AbortController) {
  const raw = await request<unknown>('/api/account/delivery-preferences', {
    method: 'GET',
    retry: 0,
    cache: 'no-store',
    signal: abort.signal,
    onRequest: () => {
      if (!live(turn, actor)) throw Error('authority_changed')
    }
  })
  if (!live(turn, actor)) return null
  return deliveryPreferencesSnapshotSchema.parse(catalogPolicyOwnJson(raw))
}
async function load() {
  const actor = owner.value
  if (!actor || !allowed.value || busy.value || intent.value) return
  const turn = epoch,
    abort = new AbortController()
  controller = abort
  busy.value = true
  phase.value = 'loading'
  snapshot.value = null
  message.value = ''
  try {
    const fresh = await readCurrent(turn, actor, abort)
    if (!fresh || !live(turn, actor)) return
    snapshot.value = fresh
    deliveryUpdates.value = fresh.deliveryUpdates
    acknowledged.value = false
    phase.value = 'ready'
  } catch (cause) {
    if (live(turn, actor) && !failure(cause, actor)) phase.value = 'error'
  } finally {
    if (live(turn, actor)) {
      busy.value = false
      controller = null
    }
  }
}
async function accept(raw: unknown, frozen: Intent, turn: number, abort: AbortController) {
  const saved = deliveryPreferencesReceiptSchema.parse(catalogPolicyOwnJson(raw))
  if (
    saved.commandId !== frozen.key ||
    saved.expectedVersion !== frozen.body.expectedVersion ||
    saved.deliveryUpdates !== frozen.body.deliveryUpdates ||
    saved.policyVersion !== frozen.body.policyVersion
  )
    throw Error('receipt_mismatch')
  receiptSeen.value = true
  const fresh = await readCurrent(turn, frozen.owner, abort)
  if (!fresh || !live(turn, frozen.owner) || intent.value !== frozen) return
  if (
    fresh.version < saved.version ||
    (fresh.version === saved.version &&
      (fresh.deliveryUpdates !== saved.deliveryUpdates || fresh.updatedAt !== saved.recordedAt))
  )
    throw Error('current_state_unconfirmed')
  snapshot.value = fresh
  deliveryUpdates.value = fresh.deliveryUpdates
  acknowledged.value = false
  intent.value = null
  phase.value = 'confirmed'
  message.value =
    fresh.version > saved.version
      ? 'Avisos de entrega guardados. Hay cambios posteriores; se muestra el estado actual.'
      : 'Avisos de entrega guardados y estado actual confirmado.'
  setPending(false)
  emit('confirmed', saved)
}
async function submit() {
  const actor = owner.value
  if (!actor || !allowed.value || busy.value || intent.value || !snapshot.value || !acknowledged.value) return
  const body = Object.freeze(
    deliveryPreferencesInputSchema.parse({
      expectedVersion: snapshot.value.version,
      deliveryUpdates: deliveryUpdates.value,
      policyVersion: snapshot.value.policyVersion
    })
  )
  const turn = epoch,
    abort = new AbortController()
  controller = abort
  busy.value = true
  phase.value = 'saving'
  receiptSeen.value = false
  canDiscard.value = false
  setPending(true)
  let responded = false
  try {
    const hash = await deliveryPreferenceIntentHash(body)
    if (!live(turn, actor)) return
    const frozen = Object.freeze({ owner: actor, key: randomId(), body, hash })
    intent.value = frozen
    const raw = await request<unknown>('/api/account/delivery-preferences', {
      method: 'PUT',
      body: frozen.body,
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': frozen.key },
      retry: 0,
      signal: abort.signal,
      onRequest: () => {
        if (!live(turn, actor) || intent.value !== frozen) throw Error('authority_changed')
      }
    })
    if (!live(turn, actor) || intent.value !== frozen) return
    responded = true
    await accept(raw, frozen, turn, abort)
  } catch (cause) {
    if (!live(turn, actor) || failure(cause, actor)) return
    const code = (cause as { data?: { error?: { code?: string } } } | null)?.data?.error?.code
    if (!intent.value || (!responded && status(cause) === 409 && code === 'version_conflict')) {
      intent.value = null
      snapshot.value = null
      phase.value = 'error'
      setPending(false)
      message.value =
        !intent.value && status(cause) !== 409
          ? 'No se ha enviado el cambio. Consulta el estado actual antes de volver a confirmar.'
          : 'La versión ha cambiado. Consulta el estado actual antes de volver a confirmar.'
    } else {
      phase.value = 'unknown'
      message.value = 'No se ha confirmado el resultado. Comprueba el recibo; no se repetirá el cambio automáticamente.'
    }
  } finally {
    if (live(turn, actor)) {
      busy.value = false
      controller = null
    }
  }
}
async function recover() {
  const frozen = intent.value
  if (!frozen || !allowed.value || busy.value || owner.value !== frozen.owner) return
  const turn = epoch,
    abort = new AbortController()
  controller = abort
  busy.value = true
  canDiscard.value = false
  try {
    const raw = await request<unknown>(`/api/account/delivery-preferences/commands/${frozen.key}`, {
      method: 'GET',
      headers: { 'X-Neteco-Command-Payload-Hash': frozen.hash },
      retry: 0,
      cache: 'no-store',
      signal: abort.signal,
      onRequest: () => {
        if (!live(turn, frozen.owner) || intent.value !== frozen) throw Error('authority_changed')
      }
    })
    if (!live(turn, frozen.owner) || intent.value !== frozen) return
    const command = deliveryPreferencesCommandSchema.parse(catalogPolicyOwnJson(raw))
    if (command.commandId !== frozen.key) throw Error('command_mismatch')
    if (command.outcome === 'applied') await accept(command.receipt, frozen, turn, abort)
    else {
      if (receiptSeen.value) throw Error('previously_confirmed_receipt_missing')
      const fresh = await readCurrent(turn, frozen.owner, abort)
      if (!fresh || !live(turn, frozen.owner) || intent.value !== frozen) return
      canDiscard.value = fresh.version > frozen.body.expectedVersion
      phase.value = 'unknown'
      message.value =
        'El recibo sigue desconocido: no demuestra que el cambio no se haya aplicado. Puedes comprobarlo de nuevo.'
    }
  } catch (cause) {
    if (live(turn, frozen.owner) && !failure(cause, frozen.owner)) {
      phase.value = 'unknown'
      message.value =
        'No se ha confirmado el resultado. Conservamos la intención para comprobarla, sin repetir el cambio.'
    }
  } finally {
    if (live(turn, frozen.owner)) {
      busy.value = false
      controller = null
    }
  }
}
function discard() {
  if (!allowed.value || busy.value || !canDiscard.value || !intent.value || receiptSeen.value) return
  intent.value = null
  snapshot.value = null
  acknowledged.value = false
  canDiscard.value = false
  phase.value = 'error'
  message.value =
    'Intención local descartada porque la versión actual ya avanzó. No cancela ni deshace un cambio registrado. Consulta de nuevo antes de confirmar otra elección.'
  setPending(false)
}
watch(
  owner,
  () => {
    reset()
    blockedOwner.value = null
    const turn = epoch
    void nextTick(() => {
      if (alive && turn === epoch && owner.value && allowed.value) void load()
    })
  },
  { immediate: true, flush: 'sync' }
)
onBeforeUnmount(() => {
  alive = false
  reset()
})
</script>
<template>
  <section aria-label="Avisos de entrega" class="min-w-0 space-y-4 break-words">
    <h2 class="text-lg font-bold">Avisos de entrega</h2>
    <p>Preferencia operativa independiente de las comunicaciones comerciales y de la newsletter.</p>
    <p v-if="!allowed">Necesitas una cuenta vigente con email verificado para gestionar estos avisos.</p>
    <p v-if="busy" role="status">Comprobando avisos de entrega…</p>
    <p v-if="message" role="status">{{ message }}</p>
    <div v-if="allowed && phase === 'error'" role="alert">
      No se ha confirmado la lectura; no significa que los avisos estén activados ni desactivados.
      <button data-delivery-retry type="button" :disabled="busy" class="underline" @click="load">
        Consultar avisos de entrega
      </button>
    </div>
    <p v-if="allowed && phase === 'unknown'" data-delivery-unknown role="alert">
      El resultado sigue pendiente de verificar.
    </p>
    <form v-if="allowed && snapshot" class="space-y-4" @submit.prevent="submit">
      <fieldset :disabled="busy || !!intent" class="space-y-3">
        <legend>Preparación y entrega por email</legend>
        <label :for="`${prefix}-updates`" class="flex items-start gap-3"
          ><input :id="`${prefix}-updates`" v-model="deliveryUpdates" data-delivery-updates type="checkbox" /><span
            >Recibir avisos de preparación y entrega</span
          ></label
        >
        <p>{{ snapshot.noticeText }}</p>
        <label :for="`${prefix}-ack`" class="flex items-start gap-3"
          ><input :id="`${prefix}-ack`" v-model="acknowledged" data-delivery-ack type="checkbox" /><span
            >Confirmo que quiero guardar esta elección, también si desactivo los avisos.</span
          ></label
        >
      </fieldset>
      <button
        data-delivery-submit
        type="submit"
        :disabled="!acknowledged || busy || !!intent"
        class="rounded border px-4 py-2"
      >
        Guardar avisos de entrega
      </button>
    </form>
    <button
      v-if="allowed && intent"
      data-delivery-recover
      type="button"
      :disabled="busy"
      class="rounded border px-4 py-2"
      @click="recover"
    >
      Comprobar avisos de entrega
    </button>
    <button
      v-if="allowed && canDiscard && intent"
      data-delivery-discard
      type="button"
      :disabled="busy"
      class="underline"
      @click="discard"
    >
      Descartar sólo la intención local
    </button>
  </section>
</template>
