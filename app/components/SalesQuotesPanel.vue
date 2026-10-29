<script setup lang="ts">
import { z } from 'zod'
import { useAdminNavigation } from '~/composables/useAdminNavigation'
import { useCartStore } from '~/stores/cart'
import { adminCapabilitiesSchema } from '~~/shared/admin-navigation'
import { catalogPolicyUuidSchema } from '~~/shared/catalog-publication-policy'
import {
  salesQuoteAdminSnapshotSchema,
  salesQuoteCreateInputSchema,
  salesQuoteReviseInputSchema,
  salesQuoteReviewInputSchema,
  salesQuoteApproveInputSchema,
  salesQuoteConvertInputSchema,
  salesQuoteReceiptSchema,
  salesQuoteCommandSchema,
  salesQuoteIntentHash,
  salesQuoteConversionIntentHash,
  type SalesQuoteAction,
  type SalesQuoteReceipt
} from '~~/shared/sales-quotes'
import { randomId } from '~/utils/uuid'

const props = withDefaults(defineProps<{ audience: 'admin' | 'customer'; enabled?: boolean; pending?: boolean }>(), {
  enabled: true,
  pending: false
})
const emit = defineEmits<{ pending: [value: boolean]; confirmed: [receipt: SalesQuoteReceipt] }>()
const runtime = useRuntimeConfig(),
  request = useRequestFetch(),
  auth = useUserSession(),
  cart = useCartStore()
// Customer reads never instantiate the admin navigation's capability fetch.
const navigation = props.audience === 'admin' ? useAdminNavigation() : null
const adminSchema = salesQuoteAdminSnapshotSchema,
  shape = adminSchema.shape
const customerSchema = z
  .object({
    source: shape.source,
    id: shape.id,
    version: shape.version,
    status: shape.status,
    destination: shape.definition.shape.destination,
    shippingMethod: shape.definition.shape.shippingMethod,
    validUntil: shape.definition.shape.validUntil,
    lines: z.array(shape.lines.element.omit({ costUnitNetCents: true, priceVersionId: true })).max(100),
    goods: shape.goods,
    shipping: shape.shipping,
    total: shape.total,
    approvedHash: shape.approvedHash,
    orderId: shape.orderId,
    createdAt: shape.createdAt,
    updatedAt: shape.updatedAt
  })
  .strict()
type AdminQuote = z.infer<typeof adminSchema>
type CustomerQuote = z.infer<typeof customerSchema>
type Quote = AdminQuote | CustomerQuote
const prefix = computed(() => (props.audience === 'admin' ? '/api/admin/sales-quotes' : '/api/account/sales-quotes'))
const scope = computed(() =>
  JSON.stringify([
    props.audience,
    props.enabled,
    runtime.public.serverRuntime,
    auth.ready.value,
    auth.loggedIn.value,
    auth.user.value?.id,
    auth.user.value?.emailVerified,
    auth.user.value?.mfaVerified,
    auth.session.value?.sessionId,
    auth.session.value?.sessionVersion,
    props.audience === 'admin' ? navigation?.status.value : null,
    props.audience === 'admin' ? navigation?.capabilities.value : null
  ])
)
const denied = ref(false)
const authority = computed(() => {
  if (
    !props.enabled ||
    runtime.public.serverRuntime !== 'cloudflare' ||
    !auth.ready.value ||
    !auth.loggedIn.value ||
    auth.user.value?.emailVerified !== true ||
    !catalogPolicyUuidSchema.safeParse(auth.user.value?.id).success ||
    !catalogPolicyUuidSchema.safeParse(auth.session.value?.sessionId).success ||
    !Number.isSafeInteger(auth.session.value?.sessionVersion) ||
    Number(auth.session.value?.sessionVersion) < 1 ||
    denied.value
  )
    return false
  if (props.audience === 'customer') return true
  const caps = adminCapabilitiesSchema.safeParse(navigation?.capabilities.value)
  return (
    auth.user.value?.mfaVerified === true &&
    navigation?.status.value === 'ready' &&
    caps.success &&
    caps.data.state === 'ready' &&
    caps.data.identityId === auth.user.value.id &&
    caps.data.sessionId === auth.session.value?.sessionId &&
    caps.data.sessionVersion === auth.session.value?.sessionVersion &&
    caps.data.permissions.includes('administration.manage')
  )
})
const busy = ref(false),
  message = ref(''),
  items = shallowRef<Quote[] | null>(null),
  detail = shallowRef<Quote | null>(null),
  page = ref(1),
  total = ref(0),
  editing = ref(false),
  consent = ref(false),
  reason = ref('')
const customerId = ref(''),
  city = ref(''),
  postalCode = ref(''),
  method = ref<'pickup' | 'own_delivery' | 'parcel'>('pickup'),
  validUntil = ref('')
const selected = ref<Array<{ variantId: string; quantity: string; label: string }>>([]),
  query = ref('')
const productSchema = z
  .object({
    id: z.number().int().positive(),
    slug: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[a-z0-9][a-z0-9-]*$/),
    name: z.string().min(1).max(500)
  })
  .passthrough()
const variantSchema = z
  .object({
    id: z.number().int().positive(),
    uuid: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    sku: z.string().min(1).max(160),
    format: z.string().max(500),
    minimumQuantity: z.number().int().positive(),
    maximumQuantity: z.number().int().positive().nullable(),
    quantityIncrement: z.number().int().positive()
  })
  .passthrough()
const products = shallowRef<z.infer<typeof productSchema>[]>([]),
  variants = shallowRef<z.infer<typeof variantSchema>[]>([]),
  productName = ref('')
const address = reactive({ name: '', line1: '', region: '', phone: '' })
type Prepared = {
  body: z.infer<typeof salesQuoteConvertInputSchema>
  cartId: string
  cartVersion: number
  scope: string
}
type Proposed = {
  action: SalesQuoteAction
  target: string | null
  body: unknown
  expectedVersion: number
  scope: string
}
type Intent = {
  action: SalesQuoteAction | 'convert'
  target: string | null
  body: unknown
  expectedVersion: number
  scope: string
  key: string
  hash: string
}
const prepared = shallowRef<Prepared | null>(null),
  proposed = shallowRef<Proposed | null>(null),
  intent = shallowRef<Intent | null>(null),
  confirmed = shallowRef<SalesQuoteReceipt | null>(null)
const locked = computed(() => busy.value || props.pending || intent.value !== null)
const destination = computed(
  () => detail.value && ('definition' in detail.value ? detail.value.definition.destination : detail.value.destination)
)
const shippingMethod = computed(
  () =>
    detail.value &&
    ('definition' in detail.value ? detail.value.definition.shippingMethod : detail.value.shippingMethod)
)
const expiration = computed(
  () => detail.value && ('definition' in detail.value ? detail.value.definition.validUntil : detail.value.validUntil)
)
let alive = true,
  generation = 0,
  controller: AbortController | null = null
const current = (epoch: number, owner: string) =>
  alive && generation === epoch && scope.value === owner && authority.value
function purge() {
  generation++
  controller?.abort()
  controller = null
  busy.value = false
  message.value = ''
  items.value = null
  detail.value = null
  proposed.value = null
  prepared.value = null
  intent.value = null
  confirmed.value = null
  editing.value = false
  consent.value = false
  customerId.value = ''
  city.value = ''
  postalCode.value = ''
  validUntil.value = ''
  reason.value = ''
  selected.value = []
  products.value = []
  variants.value = []
  productName.value = ''
  query.value = ''
  address.name = ''
  address.line1 = ''
  address.region = ''
  address.phone = ''
  emit('pending', false)
}
watch(
  scope,
  () => {
    purge()
    denied.value = false
  },
  { flush: 'sync' }
)
watch(
  () => [cart.id, cart.version, cart.pendingMutation, cart.loading, cart.ready],
  () => {
    if (!intent.value) {
      prepared.value = null
      consent.value = false
    }
  },
  { flush: 'sync' }
)
watch(
  () => [address.name, address.line1, address.region, address.phone],
  () => {
    if (!intent.value) {
      prepared.value = null
      consent.value = false
    }
  },
  { flush: 'sync' }
)
watch(
  [customerId, city, postalCode, method, validUntil, reason, selected],
  () => {
    if (!intent.value) proposed.value = null
  },
  { deep: true, flush: 'sync' }
)
onBeforeUnmount(() => {
  alive = false
  purge()
})
function failure(error: unknown, fallback: string) {
  const value =
    error && typeof error === 'object'
      ? (error as { status?: unknown; statusCode?: unknown; data?: { error?: { code?: unknown } } })
      : null
  if (Number(value?.statusCode ?? value?.status) === 401 || Number(value?.statusCode ?? value?.status) === 403) {
    purge()
    denied.value = true
    message.value = 'Ha cambiado la autorización. Comprueba tu sesión antes de continuar.'
    return true
  }
  message.value = fallback
  return false
}
function readQuote(raw: unknown): Quote {
  return props.audience === 'admin' ? adminSchema.parse(raw) : customerSchema.parse(raw)
}
function job() {
  controller = new AbortController()
  busy.value = true
  return { epoch: generation, owner: scope.value, signal: controller.signal }
}
function finish(epoch: number, owner: string) {
  if (current(epoch, owner)) busy.value = false
}
async function load(next = 1) {
  if (!authority.value || locked.value || proposed.value) return
  const task = job()
  items.value = null
  detail.value = null
  confirmed.value = null
  editing.value = false
  prepared.value = null
  message.value = ''
  try {
    const response = z
      .object({
        source: z.literal('cloudflare'),
        page: z.number().int().positive(),
        perPage: z.literal(25),
        total: z.number().int().nonnegative(),
        items: z.array(z.unknown()).max(25)
      })
      .strict()
      .parse(
        await request<unknown>(prefix.value, {
          query: { page: next },
          cache: 'no-store',
          retry: 0,
          signal: task.signal
        })
      )
    const parsed = response.items.map(readQuote)
    if (response.page !== next || new Set(parsed.map((item) => item.id)).size !== parsed.length)
      throw Error('invalid_quote_list')
    if (!current(task.epoch, task.owner)) return
    items.value = parsed
    page.value = response.page
    total.value = response.total
  } catch (error) {
    if (current(task.epoch, task.owner))
      failure(error, 'No se han podido leer los presupuestos. No equivale a una lista vacía.')
  } finally {
    finish(task.epoch, task.owner)
  }
}
async function open(id: string) {
  if (!authority.value || locked.value || proposed.value || !catalogPolicyUuidSchema.safeParse(id).success) return
  const task = job()
  detail.value = null
  confirmed.value = null
  prepared.value = null
  editing.value = false
  reason.value = ''
  message.value = ''
  try {
    const parsed = readQuote(
      await request<unknown>(`${prefix.value}/${id}`, { cache: 'no-store', retry: 0, signal: task.signal })
    )
    if (parsed.id !== id) throw Error('invalid_quote_detail')
    if (current(task.epoch, task.owner)) detail.value = parsed
  } catch (error) {
    if (current(task.epoch, task.owner)) failure(error, 'No se ha podido leer el presupuesto.')
  } finally {
    finish(task.epoch, task.owner)
  }
}
function edit(fresh = true) {
  if (!authority.value || props.audience !== 'admin' || locked.value || proposed.value) return
  const existing = !fresh && detail.value && 'definition' in detail.value ? detail.value.definition : null
  if (fresh) detail.value = null
  editing.value = true
  confirmed.value = null
  prepared.value = null
  message.value = ''
  reason.value = ''
  customerId.value = existing?.customerId ?? ''
  city.value = existing?.destination.city ?? ''
  postalCode.value = existing?.destination.postalCode ?? ''
  method.value = existing?.shippingMethod ?? 'pickup'
  validUntil.value = existing?.validUntil.slice(0, 16) ?? ''
  selected.value =
    existing?.lines.map((line) => ({
      variantId: line.variantId,
      quantity: String(line.quantity),
      label: line.variantId
    })) ?? []
}
async function search() {
  if (!authority.value || locked.value || proposed.value || !editing.value) return
  const task = job()
  products.value = []
  variants.value = []
  try {
    const parsed = z
      .object({ items: z.array(productSchema).max(25) })
      .passthrough()
      .parse(
        await request<unknown>('/api/products', {
          query: { q: query.value.trim(), page: 1, limit: 25 },
          cache: 'no-store',
          retry: 0,
          signal: task.signal
        })
      )
    if (current(task.epoch, task.owner)) products.value = parsed.items
  } catch (error) {
    if (current(task.epoch, task.owner)) failure(error, 'No se han podido buscar los productos publicados.')
  } finally {
    finish(task.epoch, task.owner)
  }
}
async function choose(slug: string) {
  if (!authority.value || locked.value || proposed.value || !products.value.some((product) => product.slug === slug))
    return
  const task = job()
  variants.value = []
  try {
    const parsed = productSchema.extend({ variants: z.array(variantSchema).min(1).max(1000) }).parse(
      await request<unknown>(`/api/products/${encodeURIComponent(slug)}`, {
        cache: 'no-store',
        retry: 0,
        signal: task.signal
      })
    )
    if (parsed.slug !== slug || new Set(parsed.variants.map((item) => item.uuid)).size !== parsed.variants.length)
      throw Error('invalid_product')
    if (current(task.epoch, task.owner)) {
      variants.value = parsed.variants
      productName.value = parsed.name
    }
  } catch (error) {
    if (current(task.epoch, task.owner)) failure(error, 'No se han podido leer los formatos publicados.')
  } finally {
    finish(task.epoch, task.owner)
  }
}
function add(variant: z.infer<typeof variantSchema>) {
  if (
    !authority.value ||
    locked.value ||
    proposed.value ||
    selected.value.length >= 100 ||
    selected.value.some((line) => line.variantId === variant.uuid)
  )
    return
  selected.value.push({
    variantId: variant.uuid,
    quantity: String(variant.minimumQuantity),
    label: `${productName.value} · ${variant.format} · ${variant.sku}`
  })
}
function review(action: SalesQuoteAction) {
  if (!authority.value || props.audience !== 'admin' || locked.value || proposed.value) return
  try {
    let body: unknown,
      target: string | null = detail.value?.id ?? null,
      expectedVersion = detail.value?.version ?? 0
    if (action === 'create' || action === 'revise') {
      if (action === 'create') {
        target = null
        expectedVersion = 0
      }
      if (!validUntil.value) throw Error('invalid_expiration')
      const raw = {
        customerId: customerId.value,
        lines: selected.value.map((line) => ({ variantId: line.variantId, quantity: Number(line.quantity) })),
        destination: { city: city.value, postalCode: postalCode.value },
        shippingMethod: method.value,
        validUntil: new Date(`${validUntil.value}:00Z`).toISOString().replace('.000Z', 'Z'),
        reason: reason.value
      }
      body =
        action === 'create'
          ? salesQuoteCreateInputSchema.parse(raw)
          : salesQuoteReviseInputSchema.parse({ ...raw, expectedVersion })
    } else {
      if (!detail.value) return
      const raw = { expectedVersion, reason: reason.value }
      body =
        action === 'approve'
          ? salesQuoteApproveInputSchema.parse({
              ...raw,
              reviewedHash: 'reviewedHash' in detail.value ? detail.value.reviewedHash : null
            })
          : salesQuoteReviewInputSchema.parse(raw)
    }
    proposed.value = { action, target, body, expectedVersion, scope: scope.value }
    message.value = 'Revisa la operación. No reserva stock ni cobra ningún importe.'
  } catch {
    message.value = 'Completa los campos y revisa cantidades, destinatario y vigencia UTC.'
  }
}
async function confirmReceipt(receipt: SalesQuoteReceipt, frozen: Intent, task: ReturnType<typeof job>) {
  if (
    receipt.commandId !== frozen.key ||
    receipt.payloadHash !== frozen.hash ||
    receipt.action !== frozen.action ||
    (frozen.target !== null && receipt.quoteId !== frozen.target) ||
    receipt.version !== frozen.expectedVersion + 1 ||
    (frozen.action === 'convert' ? receipt.orderId === null : receipt.orderId !== null)
  )
    throw Error('invalid_receipt')
  const fresh = readQuote(
    await request<unknown>(`${prefix.value}/${receipt.quoteId}`, { cache: 'no-store', retry: 0, signal: task.signal })
  )
  const expectedStatus = {
    create: 'draft',
    revise: 'draft',
    review: 'reviewed',
    approve: 'approved',
    revoke: 'revoked',
    convert: 'converted'
  }[frozen.action]
  if (
    fresh.id !== receipt.quoteId ||
    fresh.version < receipt.version ||
    (fresh.version === receipt.version && fresh.status !== expectedStatus) ||
    (frozen.action === 'convert' && (fresh.status !== 'converted' || fresh.orderId !== receipt.orderId))
  )
    throw Error('unconfirmed_quote')
  if (!current(task.epoch, task.owner) || intent.value !== frozen) return
  detail.value = fresh
  confirmed.value = receipt
  intent.value = null
  proposed.value = null
  prepared.value = null
  editing.value = false
  consent.value = false
  if (items.value) items.value = items.value.map((item) => (item.id === fresh.id ? fresh : item))
  message.value =
    fresh.version === receipt.version
      ? 'Operación confirmada mediante recibo y lectura actual.'
      : 'Operación original confirmada. El presupuesto tiene cambios posteriores; se muestra su estado actual.'
  emit('pending', false)
  emit('confirmed', receipt)
}
async function send() {
  const reviewed = proposed.value,
    conversion = prepared.value
  if (!authority.value || locked.value || (props.audience === 'admin' ? !reviewed : !conversion || !consent.value))
    return
  const task = job()
  emit('pending', true)
  try {
    const key = randomId(),
      body = reviewed?.body ?? conversion!.body,
      target = reviewed ? reviewed.target : detail.value!.id,
      action = reviewed?.action ?? 'convert',
      expectedVersion = reviewed?.expectedVersion ?? conversion!.body.expectedVersion
    const hash =
      action === 'convert'
        ? await salesQuoteConversionIntentHash(target!, conversion!.cartId, body)
        : await salesQuoteIntentHash(action, target, body)
    if (
      !current(task.epoch, task.owner) ||
      (reviewed
        ? proposed.value !== reviewed || reviewed.scope !== task.owner
        : prepared.value !== conversion ||
          conversion!.scope !== task.owner ||
          cart.id !== conversion!.cartId ||
          cart.version !== conversion!.cartVersion ||
          cart.pendingMutation ||
          !cart.ready ||
          cart.loading)
    )
      return
    const frozen: Intent = { action, target, body, expectedVersion, scope: task.owner, key, hash }
    intent.value = frozen
    const endpoint =
      action === 'convert'
        ? `${prefix.value}/${target}/convert`
        : action === 'create'
          ? prefix.value
          : `${prefix.value}/${target}/commands`
    const receipt = salesQuoteReceiptSchema.parse(
      await request<unknown>(endpoint, {
        method: 'POST',
        body: action === 'convert' || action === 'create' ? body : { action, ...(body as object) },
        headers: { 'Idempotency-Key': key },
        cache: 'no-store',
        retry: 0,
        signal: task.signal
      })
    )
    if (current(task.epoch, task.owner)) await confirmReceipt(receipt, frozen, task)
  } catch (error) {
    if (
      current(task.epoch, task.owner) &&
      !failure(
        error,
        intent.value
          ? 'Resultado incierto. Comprueba el recibo manualmente; no se enviará otra operación.'
          : 'No se ha podido preparar la operación.'
      )
    ) {
      const code = (error as { data?: { error?: { code?: unknown } } })?.data?.error?.code
      if (['version_conflict', 'quote_changed', 'quote_expired', 'quote_not_approved'].includes(String(code))) {
        intent.value = null
        proposed.value = null
        prepared.value = null
        message.value = 'Operación rechazada. Conserva el borrador y vuelve a leer el presupuesto antes de revisarlo.'
      }
    }
  } finally {
    finish(task.epoch, task.owner)
    if (current(task.epoch, task.owner)) emit('pending', intent.value !== null)
  }
}
async function recover() {
  const frozen = intent.value
  if (!authority.value || busy.value || props.pending || !frozen || frozen.scope !== scope.value) return
  const task = job()
  try {
    const result = salesQuoteCommandSchema.parse(
      await request<unknown>(`${prefix.value}/commands/${frozen.key}`, {
        headers: { 'X-Neteco-Command-Payload-Hash': frozen.hash },
        cache: 'no-store',
        retry: 0,
        signal: task.signal
      })
    )
    if (!current(task.epoch, task.owner)) return
    if (result.outcome === 'unknown') {
      message.value = 'El recibo aún no está confirmado; no demuestra ausencia. No se ha reenviado la operación.'
      return
    }
    await confirmReceipt(result.receipt, frozen, task)
  } catch (error) {
    if (current(task.epoch, task.owner))
      failure(error, 'No se ha podido confirmar el recibo. Se conserva la misma intención, sin reenviar.')
  } finally {
    finish(task.epoch, task.owner)
  }
}
async function prepare() {
  if (
    !authority.value ||
    props.audience !== 'customer' ||
    locked.value ||
    detail.value?.status !== 'approved' ||
    !destination.value ||
    !detail.value.approvedHash ||
    !detail.value.total
  )
    return
  const task = job()
  prepared.value = null
  consent.value = false
  const snapshot = detail.value,
    target = destination.value
  const approvedHash = snapshot.approvedHash
  if (!approvedHash) {
    finish(task.epoch, task.owner)
    return
  }
  try {
    await cart.ensureLoaded()
    if (
      !current(task.epoch, task.owner) ||
      cart.pendingMutation ||
      cart.loading ||
      !cart.ready ||
      !catalogPolicyUuidSchema.safeParse(cart.id).success
    )
      throw Error('cart_not_ready')
    const cartId = catalogPolicyUuidSchema.parse(cart.id),
      cartVersion = cart.version
    const rateSchema = z
      .object({
        profile: z.string().max(100),
        serviceCode: z.string().max(200),
        quoteId: catalogPolicyUuidSchema,
        shippingQuoteId: catalogPolicyUuidSchema,
        optionIndex: z.number().int().nonnegative(),
        optionHash: z.string().regex(/^[a-f0-9]{64}$/),
        expiresAt: shape.updatedAt
      })
      .passthrough()
    const result = z
      .object({ cartVersion: z.number().int().positive(), rates: z.array(rateSchema).min(1).max(100) })
      .passthrough()
      .parse(
        await request<unknown>(`/api/account/sales-quotes/${snapshot.id}/shipping-options`, {
          method: 'POST',
          headers: { 'Idempotency-Key': randomId() },
          body: {
            expectedVersion: snapshot.version,
            approvedHash
          },
          cache: 'no-store',
          retry: 0,
          signal: task.signal
        })
      )
    const rate = result.rates.find((item) =>
      shippingMethod.value === 'pickup'
        ? item.profile === 'pickup'
        : shippingMethod.value === 'own_delivery'
          ? item.profile === 'own_delivery'
          : !['pickup', 'own_delivery'].includes(item.profile)
    )
    if (
      !rate ||
      result.cartVersion !== cartVersion ||
      cart.id !== cartId ||
      cart.version !== cartVersion ||
      cart.pendingMutation ||
      cart.loading ||
      !cart.ready
    )
      throw Error('cart_changed')
    const body = salesQuoteConvertInputSchema.parse({
      expectedVersion: snapshot.version,
      approvedHash,
      checkout: {
        expectedVersion: cartVersion,
        quoteId: rate.quoteId,
        shippingQuoteId: rate.shippingQuoteId,
        selectedOptionIndex: rate.optionIndex,
        selectedOptionHash: rate.optionHash,
        expectedTotalGrossCents: snapshot.total!.grossCents,
        contactEmail: auth.user.value?.email,
        shippingAddress: {
          recipientName: address.name,
          line1: address.line1,
          province: address.region,
          phone: address.phone,
          city: target.city,
          postalCode: target.postalCode
        },
        consentTos: true,
        consentPrivacy: true
      }
    })
    if (current(task.epoch, task.owner) && detail.value === snapshot) {
      prepared.value = { body, cartId, cartVersion, scope: task.owner }
      message.value =
        'Revisa la oferta y la cesta actual. El servidor comprobará coincidencia, publicación, IVA, envío y stock antes de crear el pedido.'
    }
  } catch (error) {
    if (current(task.epoch, task.owner))
      failure(error, 'No se ha podido preparar la cesta actual. No se ha cambiado ni reservado stock.')
  } finally {
    finish(task.epoch, task.owner)
  }
}
const money = (value: number) =>
  new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(value / 100)
</script>
<template>
  <section aria-label="Presupuestos comerciales" class="space-y-5 p-4 sm:p-6">
    <h1 class="text-2xl font-semibold">{{ audience === 'admin' ? 'Presupuestos comerciales' : 'Mis presupuestos' }}</h1>
    <p>
      La aprobación comercial no cobra ni reserva stock. La conversión crea un pedido pendiente de pago con
      comprobaciones actuales.
    </p>
    <p v-if="runtime.public.serverRuntime !== 'cloudflare'">Esta función privada sólo está disponible en Cloudflare.</p>
    <p v-else-if="!authority">
      Necesitas una sesión propia verificada{{ audience === 'admin' ? ', MFA y permiso de administración' : '' }}.
    </p>
    <div v-if="authority" class="space-y-4">
      <div class="flex flex-wrap gap-3">
        <button type="button" data-testid="sales-quotes-load" :disabled="locked || !!proposed" @click="load(1)">
          Leer presupuestos
        </button>
        <button
          v-if="audience === 'admin'"
          type="button"
          data-testid="sales-quote-new"
          :disabled="locked || !!proposed"
          @click="edit()"
        >
          Nuevo presupuesto
        </button>
      </div>
      <p v-if="busy" role="status">Comprobando…</p>
      <div v-if="items !== null" class="space-y-2">
        <p v-if="!items.length">No hay presupuestos en esta página confirmada.</p>
        <ul v-else class="space-y-2">
          <li v-for="item in items" :key="item.id" class="break-words rounded border p-3">
            <button
              type="button"
              :data-testid="`sales-quote-open-${item.id}`"
              :disabled="locked || !!proposed"
              @click="open(item.id)"
            >
              {{ item.id }} · {{ item.status }} · v{{ item.version }}
            </button>
          </li>
        </ul>
        <nav aria-label="Páginas de presupuestos" class="flex gap-4">
          <button type="button" :disabled="locked || !!proposed || page <= 1" @click="load(page - 1)">Anterior</button>
          <span>Página {{ page }}</span
          ><button type="button" :disabled="locked || !!proposed || page * 25 >= total" @click="load(page + 1)">
            Siguiente
          </button>
        </nav>
      </div>
      <form
        v-if="editing && audience === 'admin'"
        class="space-y-3"
        @submit.prevent="review(detail ? 'revise' : 'create')"
      >
        <label class="block"
          >ID interno del cliente (si se conoce)<input
            v-model="customerId"
            data-testid="sales-quote-customer"
            :disabled="locked || !!proposed || !!detail"
            class="block w-full rounded border p-2"
            required
        /></label>
        <p>
          No hay un buscador de clientes disponible aquí; usa el identificador del cliente existente. No se creará otro
          cliente.
        </p>
        <div class="flex flex-wrap gap-2">
          <label
            >Buscar productos publicados<input
              v-model="query"
              data-testid="sales-quote-search-text"
              :disabled="locked || !!proposed"
              class="block rounded border p-2"
          /></label>
          <button type="button" data-testid="sales-quote-search" :disabled="locked || !!proposed" @click="search">
            Buscar
          </button>
        </div>
        <ul>
          <li v-for="product in products" :key="product.slug">
            <button
              type="button"
              :data-testid="`sales-quote-product-${product.slug}`"
              :disabled="locked || !!proposed"
              @click="choose(product.slug)"
            >
              {{ product.name }}
            </button>
          </li>
        </ul>
        <ul>
          <li v-for="variant in variants" :key="variant.uuid">
            <button
              type="button"
              :data-testid="`sales-quote-add-${variant.uuid}`"
              :disabled="
                locked ||
                !!proposed ||
                selected.length >= 100 ||
                selected.some((line) => line.variantId === variant.uuid)
              "
              @click="add(variant)"
            >
              {{ productName }} · {{ variant.format }} · {{ variant.sku }}
            </button>
          </li>
        </ul>
        <ul class="space-y-2">
          <li v-for="line in selected" :key="line.variantId" class="flex flex-wrap gap-2">
            <label
              >{{ line.label
              }}<input
                v-model="line.quantity"
                type="number"
                min="1"
                max="999"
                step="1"
                :disabled="locked || !!proposed"
                :data-testid="`sales-quote-quantity-${line.variantId}`"
                class="block w-24 rounded border p-2"
            /></label>
            <button
              type="button"
              :disabled="locked || !!proposed"
              @click="selected = selected.filter((item) => item.variantId !== line.variantId)"
            >
              Quitar {{ line.label }}
            </button>
          </li>
        </ul>
        <div class="grid gap-3 sm:grid-cols-2">
          <label
            >Ciudad<input
              v-model="city"
              data-testid="sales-quote-city"
              :disabled="locked || !!proposed"
              class="block w-full rounded border p-2"
              required
          /></label>
          <label
            >Código postal<input
              v-model="postalCode"
              data-testid="sales-quote-postal"
              :disabled="locked || !!proposed"
              class="block w-full rounded border p-2"
              required
          /></label>
          <label
            >Entrega<select
              v-model="method"
              data-testid="sales-quote-method"
              :disabled="locked || !!proposed"
              class="block w-full rounded border p-2"
            >
              <option value="pickup">Recogida</option>
              <option value="own_delivery">Reparto propio</option>
              <option value="parcel">Agencia</option>
            </select></label
          >
          <label
            >Vigencia hasta (UTC)<input
              v-model="validUntil"
              type="datetime-local"
              data-testid="sales-quote-valid-until"
              :disabled="locked || !!proposed"
              class="block w-full rounded border p-2"
              required
          /></label>
        </div>
        <button type="submit" data-testid="sales-quote-save-review" :disabled="locked || !!proposed">
          Revisar {{ detail ? 'revisión' : 'borrador' }}
        </button>
      </form>
      <article v-if="detail" data-testid="sales-quote-detail" class="space-y-3 rounded border p-4">
        <h2 class="font-semibold">{{ detail.id }} · {{ detail.status }} · v{{ detail.version }}</h2>
        <p>
          {{ destination?.city }} · {{ destination?.postalCode }} · {{ shippingMethod }} · Vigencia:
          <time :datetime="expiration ?? undefined">{{ expiration }}</time>
        </p>
        <p v-if="detail.status === 'approved' || detail.status === 'converted'">
          Precio aprobado bloqueado durante la vigencia. No garantiza disponibilidad ni aceptación de cambios de IVA o
          condiciones de envío.
        </p>
        <div class="overflow-x-auto">
          <table class="w-full text-left">
            <caption class="sr-only">
              Líneas revisadas del presupuesto
            </caption>
            <thead>
              <tr>
                <th scope="col">Variante</th>
                <th scope="col">Cantidad</th>
                <th scope="col">Precio unitario aprobado</th>
                <th scope="col">Total IVA incluido</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="line in detail.lines" :key="line.variantId">
                <th scope="row" class="break-all">{{ line.variantId }}</th>
                <td>{{ line.quantity }}</td>
                <td>{{ money(line.unitGrossCents) }}</td>
                <td>{{ money(line.amounts.grossCents) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-if="detail.total">
          Total revisado: {{ money(detail.total.grossCents) }} · Portes: {{ money(detail.shipping?.grossCents ?? 0) }}
        </p>
        <template v-if="audience === 'admin' && 'goodsMarginNetCents' in detail">
          <p>
            {{
              detail.goodsMarginNetCents === null
                ? 'Margen desconocido o no disponible para este permiso'
                : `Margen neto de mercancía: ${money(detail.goodsMarginNetCents)}`
            }}
          </p>
          <p>Coste logístico desconocido. No se acredita beneficio total ni se aplica un margen mínimo inventado.</p>
          <div class="flex flex-wrap gap-3">
            <button
              v-if="!['converted', 'revoked'].includes(detail.status)"
              type="button"
              data-testid="sales-quote-edit"
              :disabled="locked || !!proposed"
              @click="edit(false)"
            >
              Editar revisión
            </button>
            <button
              v-if="!['converted', 'revoked'].includes(detail.status)"
              type="button"
              data-testid="sales-quote-review"
              :disabled="locked || !!proposed"
              @click="review('review')"
            >
              Revisar precio y margen actuales
            </button>
            <button
              v-if="detail.status === 'reviewed'"
              type="button"
              data-testid="sales-quote-approve"
              :disabled="locked || !!proposed"
              @click="review('approve')"
            >
              Aprobar precio revisado
            </button>
            <button
              v-if="!['converted', 'revoked'].includes(detail.status)"
              type="button"
              data-testid="sales-quote-revoke"
              :disabled="locked || !!proposed"
              @click="review('revoke')"
            >
              Revocar
            </button>
          </div>
        </template>
        <div v-if="audience === 'customer' && detail.status === 'approved'" class="space-y-3">
          <p>
            Prepara tu cesta con las mismas referencias y cantidades. Esta pantalla no añade, elimina ni sustituye
            productos automáticamente.
          </p>
          <NuxtLink to="/carrito">Revisar mi cesta</NuxtLink>
          <div class="grid gap-3 sm:grid-cols-2">
            <label
              v-for="(label, field) in {
                name: 'Destinatario',
                line1: 'Dirección',
                region: 'Provincia',
                phone: 'Teléfono'
              }"
              :key="field"
              >{{ label
              }}<input
                v-model="address[field]"
                :data-testid="`sales-quote-${field}`"
                :disabled="locked"
                class="block w-full rounded border p-2"
            /></label>
          </div>
          <button type="button" data-testid="sales-quote-prepare" :disabled="locked" @click="prepare">
            Preparar cesta y entrega actuales
          </button>
          <template v-if="prepared"
            ><label class="block"
              ><input v-model="consent" type="checkbox" data-testid="sales-quote-consent" :disabled="locked" />He
              revisado el presupuesto y mi cesta; acepto las condiciones y la política de privacidad para crear el
              pedido.</label
            >
            <NuxtLink to="/condiciones-generales">Condiciones generales</NuxtLink> ·
            <NuxtLink to="/privacidad">Privacidad</NuxtLink>
            <button type="button" data-testid="sales-quote-convert" :disabled="locked || !consent" @click="send">
              Crear pedido al precio aprobado
            </button>
          </template>
        </div>
      </article>
      <label v-if="audience === 'admin' && (editing || detail)" class="block"
        >Motivo de la operación<textarea
          v-model="reason"
          data-testid="sales-quote-reason"
          :disabled="locked || !!proposed"
          minlength="10"
          maxlength="500"
          class="block w-full rounded border p-2"
        />
      </label>
      <div v-if="proposed && !intent" class="rounded border p-3">
        <p>
          Confirmar {{ proposed.action }} · {{ proposed.target ?? 'nuevo presupuesto' }} · versión
          {{ proposed.expectedVersion }}. Ningún descuento manual.
        </p>
        <button type="button" data-testid="sales-quote-confirm" :disabled="locked" @click="send">
          Confirmar operación
        </button>
        <button type="button" :disabled="locked" @click="proposed = null">Cancelar revisión</button>
      </div>
      <button
        v-if="intent"
        type="button"
        data-testid="sales-quote-recover"
        :disabled="busy || pending"
        @click="recover"
      >
        Comprobar recibo con la misma clave (sólo GET)
      </button>
      <NuxtLink v-if="confirmed?.orderId" :to="`/pedido/${confirmed.orderId}`" data-testid="sales-quote-order"
        >Consultar pedido y continuar con el pago</NuxtLink
      >
    </div>
    <p v-if="message" role="status" class="break-words">{{ message }}</p>
  </section>
</template>
