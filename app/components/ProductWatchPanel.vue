<script setup lang="ts">
import {
  PRODUCT_WATCH_POLICY_VERSION,
  PRODUCT_WATCH_NOTICE_TEXT,
  productWatchCreateInputSchema,
  productWatchConfirmInputSchema,
  productWatchCancelInputSchema,
  productWatchListSchema,
  productWatchDetailSchema,
  productWatchReceiptSchema,
  productWatchCommandSchema,
  productWatchIntentHash,
  type ProductWatchItem,
  type ProductWatchList,
  type ProductWatchReceipt
} from '~~/shared/product-watch'
import { catalogPolicyUuidSchema } from '~~/shared/catalog-publication-policy'
import { randomId } from '../utils/uuid'
const props = defineProps<{
  variantId?: number
  scopeKey: string
  enabled: boolean
  pending?: boolean
  confirmation?: { watchId: string; token: string } | null
}>()
const emit = defineEmits<{ pending: [boolean]; confirmed: [ProductWatchReceipt] }>()
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
  return JSON.stringify([props.scopeKey, id, sid, version, props.variantId ?? null])
})
type Action = 'create' | 'confirm' | 'cancel'
type Body =
  | ReturnType<typeof productWatchCreateInputSchema.parse>
  | ReturnType<typeof productWatchConfirmInputSchema.parse>
  | ReturnType<typeof productWatchCancelInputSchema.parse>
type Intent = Readonly<{
  owner: string
  key: string
  action: Action
  targetId: string | null
  body: Readonly<Body>
  hash: string
  variantId: number
  kind: ProductWatchItem['kind']
}>
const snapshot = shallowRef<ProductWatchList | null>(null),
  confirmationItem = shallowRef<ProductWatchItem | null>(null),
  intent = shallowRef<Intent | null>(null)
const consent = ref(false),
  kind = ref<'price_drop' | 'back_in_stock'>('back_in_stock'),
  busy = ref(false),
  uncertain = ref(false),
  message = ref(''),
  blockedOwner = ref<string | null>(null)
let alive = true,
  epoch = 0,
  controller: AbortController | null = null,
  commandPending = false
const allowed = computed(() => !!owner.value && blockedOwner.value !== owner.value)
const listed = computed(
  () =>
    snapshot.value?.items.filter((item) => props.variantId === undefined || item.variantId === props.variantId) ?? []
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
  confirmationItem.value = null
  intent.value = null
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
    message.value = 'La sesión ya no permite consultar estos avisos.'
    return
  }
  message.value = intent.value
    ? 'No se conoce el resultado. Consulta el recibo antes de realizar otra operación.'
    : 'No se han podido verificar los avisos. Vuelve a consultar.'
}
async function load(page = 1) {
  const actor = owner.value
  if (!actor || !allowed.value || busy.value || intent.value) return
  const turn = ++epoch
  controller?.abort()
  controller = new AbortController()
  busy.value = true
  message.value = ''
  try {
    const value = productWatchListSchema.parse(
      await request(
        page === 1 ? '/api/account/product-watches' : `/api/account/product-watches?page=${page}&perPage=25`,
        { signal: controller.signal }
      )
    )
    if (!live(turn, actor)) return
    snapshot.value = value
    if (props.confirmation && catalogPolicyUuidSchema.safeParse(props.confirmation.watchId).success) {
      const detail = productWatchDetailSchema.parse(
        await request(`/api/account/product-watches/${props.confirmation.watchId}`, { signal: controller.signal })
      )
      if (!live(turn, actor)) return
      if (detail.item.id !== props.confirmation.watchId) throw Error('uncorrelated_watch')
      confirmationItem.value = detail.item
    }
  } catch (cause) {
    if (live(turn, actor)) {
      snapshot.value = null
      failure(cause, actor)
    }
  } finally {
    if (live(turn, actor)) busy.value = false
  }
}
async function review(action: Action, item?: ProductWatchItem) {
  const actor = owner.value
  if (!actor || !allowed.value || busy.value || intent.value || !snapshot.value) return
  let body: Body,
    targetId: string | null = null,
    variantId: number,
    watchKind: ProductWatchItem['kind']
  if (action === 'create') {
    const parsed = productWatchCreateInputSchema.safeParse({
      variantId: props.variantId,
      kind: kind.value,
      consent: consent.value,
      policyVersion: PRODUCT_WATCH_POLICY_VERSION
    })
    if (!parsed.success) {
      message.value = 'Elige el aviso y acepta expresamente sus condiciones.'
      return
    }
    body = parsed.data
    variantId = parsed.data.variantId
    watchKind = parsed.data.kind
  } else {
    if (!item || item.status === 'cancelled') return
    targetId = item.id
    variantId = item.variantId
    watchKind = item.kind
    if (action === 'confirm') {
      if (item.status !== 'pending' || props.confirmation?.watchId !== item.id) return
      const parsed = productWatchConfirmInputSchema.safeParse({
        expectedVersion: item.version,
        token: props.confirmation.token
      })
      if (!parsed.success) {
        message.value = 'El enlace de confirmación no es válido.'
        return
      }
      body = parsed.data
    } else body = productWatchCancelInputSchema.parse({ expectedVersion: item.version })
  }
  const turn = epoch
  busy.value = true
  message.value = ''
  try {
    const hash = await productWatchIntentHash(action, targetId, body)
    if (!live(turn, actor)) return
    intent.value = Object.freeze({
      owner: actor,
      key: randomId(),
      action,
      targetId,
      body: Object.freeze(body),
      hash,
      variantId,
      kind: watchKind
    })
    setPending(true)
  } catch (cause) {
    if (live(turn, actor)) failure(cause, actor)
  } finally {
    if (live(turn, actor)) busy.value = false
  }
}
function matching(raw: unknown, current: Intent) {
  const parsed = productWatchReceiptSchema.safeParse(raw)
  if (!parsed.success) throw Error('unconfirmed_receipt')
  const value = parsed.data,
    expectedVersion = 'expectedVersion' in current.body ? current.body.expectedVersion + 1 : 1
  if (
    value.commandId !== current.key ||
    value.payloadHash !== current.hash ||
    value.action !== current.action ||
    (current.targetId !== null && value.watchId !== current.targetId) ||
    value.version !== expectedVersion ||
    value.status !==
      (current.action === 'create' ? 'pending' : current.action === 'confirm' ? 'confirmed' : 'cancelled')
  )
    throw Error('uncorrelated_receipt')
  return value
}
async function prove(receipt: ProductWatchReceipt, current: Intent, turn: number) {
  const result = productWatchDetailSchema.parse(
    await request(`/api/account/product-watches/${receipt.watchId}`, { signal: controller?.signal })
  )
  if (!live(turn, current.owner) || intent.value !== current) return
  const item = result.item
  if (
    item.id !== receipt.watchId ||
    item.version !== receipt.version ||
    item.status !== receipt.status ||
    item.variantId !== current.variantId ||
    item.kind !== current.kind ||
    (current.action === 'create' && item.createdAt !== receipt.recordedAt) ||
    (current.action === 'confirm' && item.confirmedAt !== receipt.recordedAt) ||
    (current.action === 'cancel' && item.cancelledAt !== receipt.recordedAt)
  )
    throw Error('unconfirmed_current_watch')
  if (snapshot.value) {
    const existing = snapshot.value.items.some((row) => row.id === item.id)
    snapshot.value = {
      ...snapshot.value,
      total: snapshot.value.total + (existing ? 0 : 1),
      items: [item, ...snapshot.value.items.filter((row) => row.id !== item.id)].slice(0, 25)
    }
  }
  if (confirmationItem.value?.id === item.id) confirmationItem.value = item
  intent.value = null
  uncertain.value = false
  consent.value = false
  setPending(false)
  message.value =
    current.action === 'create'
      ? 'Solicitud pendiente de confirmar por correo'
      : current.action === 'confirm'
        ? 'Aviso confirmado. Su entrega depende de tus preferencias comerciales.'
        : 'Aviso cancelado'
  emit('confirmed', receipt)
}
async function send() {
  const current = intent.value
  if (!current || !allowed.value || busy.value || uncertain.value || current.owner !== owner.value) return
  const turn = epoch
  busy.value = true
  controller?.abort()
  controller = new AbortController()
  uncertain.value = true
  try {
    const path =
      current.action === 'create'
        ? '/api/account/product-watches'
        : `/api/account/product-watches/${current.targetId}/${current.action}`
    const receipt = matching(
      await request(path, {
        method: 'POST',
        body: current.body,
        headers: { 'Idempotency-Key': current.key },
        signal: controller.signal
      }),
      current
    )
    if (live(turn, current.owner)) await prove(receipt, current, turn)
  } catch (cause) {
    if (live(turn, current.owner)) failure(cause, current.owner)
  } finally {
    if (live(turn, current.owner)) busy.value = false
  }
}
async function recover() {
  const current = intent.value
  if (!current || !uncertain.value || !allowed.value || busy.value || current.owner !== owner.value) return
  const turn = epoch
  busy.value = true
  controller?.abort()
  controller = new AbortController()
  try {
    const result = productWatchCommandSchema.parse(
      await request(`/api/account/product-watches/commands/${current.key}`, {
        headers: { 'X-Neteco-Command-Payload-Hash': current.hash },
        signal: controller.signal
      })
    )
    if (!live(turn, current.owner)) return
    if (result.outcome === 'unknown') {
      message.value = 'El comando todavía no está confirmado. No se ha reenviado la solicitud.'
      return
    }
    await prove(matching(result.receipt, current), current, turn)
  } catch (cause) {
    if (live(turn, current.owner)) failure(cause, current.owner)
  } finally {
    if (live(turn, current.owner)) busy.value = false
  }
}
function abandonReview() {
  if (intent.value && !uncertain.value && !busy.value) {
    intent.value = null
    setPending(false)
  }
}
watch(
  [owner, () => props.confirmation?.watchId, () => props.confirmation?.token],
  () => {
    reset()
    if (allowed.value) void load()
  },
  { immediate: true, flush: 'sync' }
)
onBeforeUnmount(() => {
  alive = false
  reset()
})
</script>
<template>
  <section aria-label="Avisos de variantes" class="space-y-4 rounded-xl border p-4">
    <h2 class="text-lg font-semibold">Avisos de reposición y precio</h2>
    <p class="text-sm">{{ PRODUCT_WATCH_NOTICE_TEXT }}</p>
    <p class="text-sm">
      Son distintos de los avisos de pago, factura y entrega.
      <a href="/cuenta/comunicaciones" class="underline">Revisar mis preferencias comerciales</a>.
    </p>
    <p v-if="!allowed" role="status">Accede con tu cuenta y correo verificado para gestionar tus avisos.</p>
    <p v-if="message" role="status" aria-live="polite">{{ message }}</p>
    <p v-if="busy" role="status">Verificando…</p>
    <template v-if="allowed">
      <button v-if="!snapshot && !busy" type="button" class="underline" @click="load()">Consultar avisos</button>
      <fieldset v-if="snapshot && variantId !== undefined && !intent" :disabled="busy" class="space-y-3">
        <legend class="font-medium">Solicitar un aviso para esta variante</legend>
        <label :for="`${prefix}-kind`">Tipo de aviso</label>
        <select :id="`${prefix}-kind`" v-model="kind" data-watch-kind class="block w-full rounded border p-2">
          <option value="back_in_stock">Cuando vuelva a estar disponible</option>
          <option value="price_drop">Cuando baje de precio</option>
        </select>
        <label class="flex items-start gap-2"
          ><input v-model="consent" type="checkbox" data-watch-consent />
          <span>Acepto las condiciones del aviso y la confirmación por correo.</span></label
        >
        <button type="button" data-watch-review class="rounded border px-3 py-2" @click="review('create')">
          Revisar solicitud
        </button>
      </fieldset>
      <div v-if="intent && !uncertain" class="space-y-3 rounded border p-3" aria-label="Revisar aviso">
        <p>
          {{
            intent.action === 'create'
              ? 'Se registrará una solicitud pendiente; debes confirmarla por correo.'
              : intent.action === 'confirm'
                ? 'Se confirmará el aviso de la variante indicada.'
                : 'Se cancelará este aviso, incluso si está pendiente de confirmación.'
          }}
        </p>
        <button type="button" data-watch-confirm :disabled="busy" class="rounded border px-3 py-2" @click="send">
          Confirmar {{ intent.action === 'cancel' ? 'cancelación' : 'solicitud' }}
        </button>
        <button type="button" :disabled="busy" class="px-3 py-2 underline" @click="abandonReview">
          Volver sin enviar
        </button>
      </div>
      <div v-if="intent && uncertain" class="space-y-2 rounded border p-3">
        <p>Operación sin confirmar. No vuelvas a enviarla ni registres otro aviso hasta comprobar el resultado.</p>
        <button type="button" data-watch-recover :disabled="busy" class="rounded border px-3 py-2" @click="recover">
          Consultar recibo y estado
        </button>
      </div>
      <div v-if="confirmationItem?.status === 'pending' && confirmation && !intent" class="rounded border p-3">
        <p>Enlace recibido para la variante {{ confirmationItem.variantId }}. La confirmación es voluntaria.</p>
        <button type="button" :disabled="busy" data-watch-email-confirm @click="review('confirm', confirmationItem)">
          Revisar confirmación del enlace
        </button>
      </div>
      <ul v-if="snapshot" class="space-y-3">
        <li v-for="item in listed" :key="item.id" class="space-y-2 rounded border p-3">
          <p>
            Variante {{ item.variantId }} · {{ item.kind === 'price_drop' ? 'Bajada de precio' : 'Reposición' }} ·
            {{
              item.status === 'pending'
                ? 'Pendiente de confirmar'
                : item.status === 'confirmed'
                  ? 'Confirmado'
                  : 'Cancelado'
            }}
          </p>
          <p v-if="item.suppressedByPreferences && item.status !== 'cancelled'" class="text-sm">
            Tus preferencias comerciales no permiten entregar este aviso. No se modificarán automáticamente.
          </p>
          <p v-if="item.status === 'pending'" class="text-sm">
            Enlace de confirmación válido hasta {{ item.confirmationExpiresAt }}. No se afirma que el correo haya sido
            entregado.
          </p>
          <button
            v-if="item.status !== 'cancelled'"
            type="button"
            :data-watch-cancel="item.id"
            :disabled="busy || !!intent"
            class="underline"
            @click="review('cancel', item)"
          >
            Cancelar aviso
          </button>
        </li>
      </ul>
      <p v-if="snapshot && !listed.length">No hay avisos registrados en esta página.</p>
      <nav
        v-if="snapshot && snapshot.total > snapshot.perPage"
        aria-label="Páginas de avisos"
        class="flex flex-wrap gap-3"
      >
        <button type="button" :disabled="busy || !!intent || snapshot.page <= 1" @click="load(snapshot.page - 1)">
          Anterior</button
        ><span>Página {{ snapshot.page }}</span
        ><button
          type="button"
          :disabled="busy || !!intent || snapshot.page * snapshot.perPage >= snapshot.total"
          @click="load(snapshot.page + 1)"
        >
          Siguiente
        </button>
      </nav>
    </template>
  </section>
</template>
