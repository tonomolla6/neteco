<script setup lang="ts">
import {
  CART_RECOVERY_POLICY_VERSION as POLICY,
  CART_RECOVERY_NOTICE_TEXT as NOTICE,
  cartRecoveryPreferenceInputSchema,
  cartRecoveryAssociationInputSchema,
  cartRecoveryResolveInputSchema,
  cartRecoveryResumeInputSchema,
  cartRecoveryPreferenceSchema,
  cartRecoveryResolvedSchema,
  cartRecoveryReceiptSchema,
  cartRecoveryCommandSchema,
  cartRecoveryIntentHash,
  type CartRecoveryPreference,
  type CartRecoveryResolved,
  type CartRecoveryReceipt
} from '~~/shared/cart-recovery'
import { catalogPolicyUuidSchema } from '~~/shared/catalog-publication-policy'
import { randomId } from '../utils/uuid'
const props = defineProps<{
  scopeKey: string
  enabled: boolean
  pending?: boolean
  cartId?: string
  cartVersion?: number
  stage?: 'cart' | 'checkout'
  recovery?: { id: string; token: string } | null
}>()
const emit = defineEmits<{ pending: [boolean]; confirmed: [action: 'preferences' | 'associate' | 'resume'] }>()
const auth = useUserSession(),
  request = useRequestFetch(),
  runtime = useRuntimeConfig(),
  prefix = useId()
const owner = computed(() => {
  const id = auth.user.value?.id,
    sid = auth.session.value?.sessionId,
    version = auth.session.value?.sessionVersion
  if (
    !props.enabled ||
    props.pending ||
    runtime.public.serverRuntime !== 'cloudflare' ||
    !props.scopeKey ||
    props.scopeKey.length > 1000 ||
    !auth.ready.value ||
    !auth.loggedIn.value ||
    auth.user.value?.emailVerified !== true ||
    !catalogPolicyUuidSchema.safeParse(id).success ||
    !catalogPolicyUuidSchema.safeParse(sid).success ||
    !Number.isSafeInteger(version) ||
    Number(version) < 1
  )
    return null
  return JSON.stringify([props.scopeKey, id, sid, version])
})
type Action = 'preferences' | 'associate' | 'resume'
type Body =
  | ReturnType<typeof cartRecoveryPreferenceInputSchema.parse>
  | ReturnType<typeof cartRecoveryAssociationInputSchema.parse>
  | ReturnType<typeof cartRecoveryResumeInputSchema.parse>
type Intent = Readonly<{
  owner: string
  key: string
  hash: string
  action: Action
  body: Readonly<Body>
  cartId: string | null
  resolved: CartRecoveryResolved | null
}>
const snapshot = shallowRef<CartRecoveryPreference | null>(null),
  resolved = shallowRef<CartRecoveryResolved | null>(null),
  intent = shallowRef<Intent | null>(null)
const initialCredential = cartRecoveryResolveInputSchema.safeParse(props.recovery)
const capability = shallowRef<{ id: string; token: string } | null>(
  owner.value && initialCredential.success ? initialCredential.data : null
)
const consent = ref(false),
  busy = ref(false),
  uncertain = ref(false),
  message = ref(''),
  blockedOwner = ref<string | null>(null)
let alive = true,
  epoch = 0,
  commandPending = false,
  controller: AbortController | null = null
const allowed = computed(() => !!owner.value && blockedOwner.value !== owner.value)
const associationAvailable = computed(
  () =>
    snapshot.value?.recoveryEnabled === true &&
    catalogPolicyUuidSchema.safeParse(props.cartId).success &&
    Number.isSafeInteger(props.cartVersion) &&
    Number(props.cartVersion) > 0 &&
    !!props.stage
)
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
  resolved.value = null
  intent.value = null
  capability.value = null
  consent.value = false
  busy.value = false
  uncertain.value = false
  message.value = ''
  setPending(false)
}
function live(turn: number, actor: string) {
  return alive && allowed.value && epoch === turn && owner.value === actor
}
function failure(cause: unknown, actor: string) {
  const error = cause as { statusCode?: number; status?: number; response?: { status?: number } } | null
  if ([401, 403].includes(Number(error?.statusCode ?? error?.status ?? error?.response?.status))) {
    reset()
    blockedOwner.value = actor
    message.value = 'La sesión ya no permite consultar esta recuperación.'
    return
  }
  message.value = intent.value
    ? 'No se conoce el resultado. Consulta el recibo antes de realizar otra operación.'
    : 'No se ha podido verificar la recuperación. Vuelve a consultar.'
}
function begin() {
  const actor = owner.value
  if (!actor || !allowed.value || busy.value) return null
  const turn = ++epoch
  controller?.abort()
  controller = new AbortController()
  busy.value = true
  message.value = ''
  return { actor, turn, signal: controller.signal }
}
async function load() {
  if (intent.value) return
  const job = begin()
  if (!job) return
  try {
    const value = cartRecoveryPreferenceSchema.parse(
      await request('/api/account/cart-recovery/preferences', { signal: job.signal })
    )
    if (!live(job.turn, job.actor)) return
    snapshot.value = value
    consent.value = value.recoveryEnabled
  } catch (cause) {
    if (live(job.turn, job.actor)) failure(cause, job.actor)
  } finally {
    if (live(job.turn, job.actor)) busy.value = false
  }
}
async function resolve() {
  if (intent.value) return
  const credentials = cartRecoveryResolveInputSchema.safeParse(capability.value)
  if (!credentials.success) return
  const job = begin()
  if (!job) return
  try {
    const value = cartRecoveryResolvedSchema.parse(
      await request<unknown>('/api/account/cart-recovery/resolve', {
        method: 'POST',
        body: credentials.data,
        signal: job.signal
      })
    )
    if (!live(job.turn, job.actor)) return
    if (value.associationId !== credentials.data.id) throw new Error('unconfirmed_association')
    resolved.value = value
  } catch (cause) {
    if (live(job.turn, job.actor)) failure(cause, job.actor)
  } finally {
    if (live(job.turn, job.actor)) busy.value = false
  }
}
async function review(action: Action) {
  if (intent.value) return
  let body: Body
  if (action === 'preferences') {
    if (!snapshot.value) return
    body = cartRecoveryPreferenceInputSchema.parse({
      expectedVersion: snapshot.value.version,
      recoveryEnabled: consent.value,
      policyVersion: POLICY
    })
  } else if (action === 'associate') {
    if (!associationAvailable.value) return
    body = cartRecoveryAssociationInputSchema.parse({
      expectedCartVersion: props.cartVersion,
      stage: props.stage,
      policyVersion: POLICY
    })
  } else {
    if (!resolved.value || !capability.value) return
    body = cartRecoveryResumeInputSchema.parse({ ...capability.value, expectedCartVersion: resolved.value.cartVersion })
  }
  const job = begin()
  if (!job) return
  try {
    const hash = await cartRecoveryIntentHash(action, body)
    if (!live(job.turn, job.actor)) return
    intent.value = Object.freeze({
      owner: job.actor,
      key: randomId(),
      hash,
      action,
      body: Object.freeze(body),
      cartId: action === 'associate' ? props.cartId! : null,
      resolved: action === 'resume' ? resolved.value : null
    })
    setPending(true)
  } catch (cause) {
    if (live(job.turn, job.actor)) failure(cause, job.actor)
  } finally {
    if (live(job.turn, job.actor)) busy.value = false
  }
}
function correlate(value: unknown, current: Intent): CartRecoveryReceipt {
  const receipt = cartRecoveryReceiptSchema.parse(value)
  if (receipt.commandId !== current.key || receipt.payloadHash !== current.hash || receipt.action !== current.action)
    throw new Error('unconfirmed_receipt')
  if (current.action === 'preferences') {
    const body = cartRecoveryPreferenceInputSchema.parse(current.body)
    if (
      receipt.version !== body.expectedVersion + 1 ||
      receipt.recoveryEnabled !== body.recoveryEnabled ||
      receipt.associationId !== null ||
      receipt.cartVersion !== null
    )
      throw new Error('unconfirmed_preferences')
  } else if (current.action === 'associate') {
    if (
      !receipt.associationId ||
      receipt.cartVersion !== cartRecoveryAssociationInputSchema.parse(current.body).expectedCartVersion
    )
      throw new Error('unconfirmed_association')
  } else {
    const body = cartRecoveryResumeInputSchema.parse(current.body)
    if (receipt.associationId !== body.id || receipt.cartVersion !== body.expectedCartVersion + 1)
      throw new Error('unconfirmed_resume')
  }
  return receipt
}
async function prove(receipt: CartRecoveryReceipt, current: Intent, signal: AbortSignal) {
  if (current.action === 'preferences') {
    const fresh = cartRecoveryPreferenceSchema.parse(
      await request('/api/account/cart-recovery/preferences', { signal })
    )
    if (
      fresh.version !== receipt.version ||
      fresh.recoveryEnabled !== receipt.recoveryEnabled ||
      fresh.updatedAt !== receipt.recordedAt
    )
      throw new Error('unconfirmed_preferences_projection')
    return fresh
  }
  if (current.action === 'associate') {
    const fresh = cartRecoveryCommandSchema.parse(
      await request('/api/account/cart-recovery/commands/' + current.key, {
        headers: { 'X-Neteco-Command-Payload-Hash': current.hash },
        signal
      })
    )
    if (fresh.outcome !== 'applied' || JSON.stringify(correlate(fresh.receipt, current)) !== JSON.stringify(receipt))
      throw new Error('unconfirmed_association_projection')
    return null
  }
  const fresh = (await request('/api/cart', { signal })) as {
    id?: unknown
    version?: unknown
    status?: unknown
    items?: unknown
  }
  if (
    !catalogPolicyUuidSchema.safeParse(fresh?.id).success ||
    fresh.id !== current.resolved?.cartId ||
    fresh.version !== receipt.cartVersion ||
    fresh.status !== 'active' ||
    !Array.isArray(fresh.items) ||
    fresh.items.length !== current.resolved?.lines.length
  )
    throw new Error('unconfirmed_cart_projection')
  const seen = new Set<number>()
  for (const raw of fresh.items) {
    const line = raw as { variantId?: unknown; qty?: unknown }
    if (
      typeof line.variantId !== 'number' ||
      seen.has(line.variantId) ||
      !current.resolved?.lines.some(
        (expected) => expected.variantId === line.variantId && expected.quantity === line.qty
      )
    )
      throw new Error('unconfirmed_cart_lines')
    seen.add(line.variantId)
  }
  return null
}
async function finish(receipt: CartRecoveryReceipt, current: Intent, job: NonNullable<ReturnType<typeof begin>>) {
  const fresh = await prove(receipt, current, job.signal)
  if (!live(job.turn, job.actor) || intent.value !== current) return
  if (fresh) {
    snapshot.value = fresh
    consent.value = fresh.recoveryEnabled
  }
  intent.value = null
  resolved.value = null
  uncertain.value = false
  setPending(false)
  message.value =
    current.action === 'resume'
      ? 'El carrito se ha retomado y comprobado. Revisa el envío antes de realizar un pedido.'
      : 'La operación está confirmada.'
  emit('confirmed', current.action)
}
async function confirm() {
  const current = intent.value
  if (!current || uncertain.value || current.owner !== owner.value) return
  const job = begin()
  if (!job) return
  // Set before dispatch: any transport or projection failure remains ambiguous.
  uncertain.value = true
  try {
    const path =
      current.action === 'preferences' ? 'preferences' : current.action === 'associate' ? 'associations' : 'resume'
    const receipt = correlate(
      await request('/api/account/cart-recovery/' + path, {
        method: current.action === 'preferences' ? 'PUT' : 'POST',
        body: current.body,
        headers: { 'Idempotency-Key': current.key, ...(current.cartId ? { 'X-Neteco-Cart-Id': current.cartId } : {}) },
        signal: job.signal
      }),
      current
    )
    if (!live(job.turn, job.actor)) return
    await finish(receipt, current, job)
  } catch (cause) {
    if (live(job.turn, job.actor)) failure(cause, job.actor)
  } finally {
    if (live(job.turn, job.actor)) busy.value = false
  }
}
async function check() {
  const current = intent.value
  if (!current || !uncertain.value || current.owner !== owner.value) return
  const job = begin()
  if (!job) return
  try {
    const result = cartRecoveryCommandSchema.parse(
      await request('/api/account/cart-recovery/commands/' + current.key, {
        headers: { 'X-Neteco-Command-Payload-Hash': current.hash },
        signal: job.signal
      })
    )
    if (!live(job.turn, job.actor)) return
    if (result.outcome === 'unknown') {
      message.value = 'No hay recibo confirmado. No se ha repetido la operación.'
      return
    }
    await finish(correlate(result.receipt, current), current, job)
  } catch (cause) {
    if (live(job.turn, job.actor)) failure(cause, job.actor)
  } finally {
    if (live(job.turn, job.actor)) busy.value = false
  }
}
function cancelReview() {
  if (!busy.value && !uncertain.value) {
    intent.value = null
    setPending(false)
  }
}
watch(owner, reset, { flush: 'sync' })
watch(() => [props.cartId, props.cartVersion, props.stage], reset, { flush: 'sync' })
watch(
  () => props.recovery,
  (value) => {
    reset()
    const credential = cartRecoveryResolveInputSchema.safeParse(value)
    if (owner.value && credential.success) capability.value = credential.data
  },
  { flush: 'sync' }
)
onBeforeUnmount(() => {
  alive = false
  reset()
})
const money = (cents: number) => (cents / 100).toLocaleString('es-ES', { style: 'currency', currency: 'EUR' })
</script>
<template>
  <section aria-label="Recuperación de carrito" class="space-y-4">
    <h2 class="text-lg font-semibold">Recuperación de carrito</h2>
    <p>{{ NOTICE }}</p>
    <p>
      También se respetan las preferencias generales de
      <a href="/cuenta/comunicaciones" class="underline">Comunicaciones</a>. Activar esta opción no reactiva los avisos
      generales ni envía recordatorios anteriores.
    </p>
    <p v-if="!allowed">
      Necesitas una cuenta con correo verificado y una sesión vigente. No se ha enviado ninguna solicitud.
    </p>
    <p v-if="message" role="status">{{ message }}</p>
    <fieldset v-if="allowed" :disabled="busy" class="space-y-3">
      <legend class="sr-only">Gestionar recuperación</legend>
      <template v-if="!intent">
        <button data-recovery-load type="button" @click="load">Consultar preferencias</button>
        <template v-if="snapshot">
          <label :for="prefix + '-consent'"
            ><input :id="prefix + '-consent'" v-model="consent" data-recovery-consent type="checkbox" /> Solicito
            recordatorios de recuperación por email</label
          >
          <button data-recovery-review-preferences type="button" @click="review('preferences')">
            Revisar cambio de preferencia
          </button>
          <button
            v-if="associationAvailable"
            data-recovery-review-association
            type="button"
            @click="review('associate')"
          >
            Revisar asociación de este carrito
          </button>
        </template>
        <button v-if="capability" data-recovery-resolve type="button" @click="resolve">
          Revisar el carrito del enlace
        </button>
        <div v-if="resolved">
          <p>Contenido y precios actuales. Sin reserva de stock ni aceptación de pago.</p>
          <ul>
            <li v-for="line in resolved.lines" :key="line.variantId">
              {{ line.name }} · {{ line.sku }} · {{ line.quantity }} unidades · {{ money(line.grossCents) }} IVA
              incluido
            </li>
          </ul>
          <button data-recovery-review-resume type="button" @click="review('resume')">
            Revisar y retomar este carrito
          </button>
        </div>
      </template>
      <div v-else>
        <p v-if="intent.action === 'preferences'">Confirma el cambio de tu preferencia de recuperación.</p>
        <p v-else-if="intent.action === 'associate'">
          Confirma la asociación de la versión revisada del carrito. No reserva stock.
        </p>
        <p v-else>
          Confirma retomar el carrito revisado. Sustituye su credencial de acceso, no crea un pedido ni acepta un pago.
        </p>
        <template v-if="!uncertain"
          ><button data-recovery-confirm type="button" @click="confirm">Confirmar operación</button
          ><button type="button" @click="cancelReview">Volver sin enviar</button></template
        >
        <button v-else data-recovery-check type="button" @click="check">Consultar recibo de esta operación</button>
      </div>
    </fieldset>
  </section>
</template>
