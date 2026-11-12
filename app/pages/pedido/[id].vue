<script setup lang="ts">
import type { OrderDetailView } from '~~/shared/types/orders'
import type { OrderDetailLines, OrderLine } from '~/composables/useAccount'
import { submitHostedPayment, type HostedPaymentRedirect } from '~/utils/hosted-payment'
import OrderFiscalSection from '~/components/OrderFiscalSection.vue'
import OrderRefundPanel from '~/components/refunds/OrderRefundPanel.vue'
import CustomerSatisfactionPanel from '~/components/CustomerSatisfactionPanel.vue'
import OrderTrackingPanel from '~/components/OrderTrackingPanel.vue'
import BeplyOrderPanel from '~/components/BeplyOrderPanel.vue'
import { readOrderDetail } from '~/utils/orderDetail'
import { supportUuid } from '~~/shared/support-operations'

/**
 * Ficha del pedido para el cliente.
 *
 * Esta página hace dos trabajos que se parecen poco: es el acuse de recibo justo
 * después de pagar, y es la página a la que se vuelve tres días después para
 * preguntar «¿dónde está?». La versión anterior las trataba igual y saludaba con
 * «¡Gracias por tu pedido!» un mes más tarde, sin decir en ningún sitio cuándo
 * llega ni por dónde va.
 *
 * Ahora el encabezado responde a la pregunta que trae al cliente: si acaba de
 * pagar, confirma; si vuelve después, dice en qué punto está y qué falta. Debajo,
 * una barra de progreso con los cuatro hitos reales del pedido, distinta para
 * reparto y para recogida en almacén, porque «en reparto» no significa nada si
 * has elegido pasar a recogerlo.
 *
 * Las miniaturas y el seguimiento salen de `/api/orders/[id]/lines`, que exige
 * sesión. Un invitado con enlace de acceso ve la ficha completa menos eso: es una
 * mejora progresiva, no un requisito, y así el enlace del correo sigue sirviendo
 * sin obligar a crear cuenta.
 */
const route = useRoute()
const { loggedIn, ready, user, session } = useUserSession()

const { data: orderData, error } = await useFetch<OrderDetailView>(`/api/orders/${route.params.id}`, {
  params: { token: route.query.token }
})
if (error.value || !orderData.value) {
  throw createError({
    statusCode: error.value?.statusCode ?? 404,
    statusMessage: error.value?.statusMessage ?? 'Pedido no encontrado',
    fatal: true
  })
}
const order = computed(() => orderData.value!)
const isCloudflare = computed(() => order.value.source === 'cloudflare')
const isViewOnly = computed(() => isCloudflare.value && order.value.accessMode === 'view_only')
const trackingScope = computed(() =>
  JSON.stringify([
    route.params.id,
    orderData.value?.accessMode,
    loggedIn.value,
    user?.value?.id,
    session?.value?.sessionId,
    session?.value?.sessionVersion,
    user?.value?.emailVerified
  ])
)
const originalTrackingScope = trackingScope.value
const trackingScopeRevoked = ref(false)
watch(
  trackingScope,
  () => {
    trackingScopeRevoked.value = true
  },
  { flush: 'sync' }
)
const trackingReady = computed(
  () =>
    isCloudflare.value &&
    !error.value &&
    !trackingScopeRevoked.value &&
    trackingScope.value === originalTrackingScope &&
    supportUuid.safeParse(route.params.id).success &&
    orderData.value?.id === route.params.id &&
    (isViewOnly.value ||
      (ready?.value === true &&
        loggedIn.value === true &&
        user?.value?.emailVerified === true &&
        supportUuid.safeParse(user.value.id).success &&
        supportUuid.safeParse(session?.value?.sessionId).success &&
        Number.isSafeInteger(session?.value?.sessionVersion) &&
        Number(session?.value?.sessionVersion) >= 1))
)
const canRetryCloudflarePayment = computed(() => isCloudflare.value && paymentOrderEligible())

/** El pedido acaba de pagarse si venimos de la pasarela o si tiene minutos de vida. */
const justPlaced = computed(() => {
  if (route.query.token) return true
  return Date.now() - new Date(order.value.createdAt).getTime() < 30 * 60 * 1000
})
const wasJustPlaced = ref(justPlaced.value)

if (route.query.token) {
  await navigateTo({ path: route.path, query: {} }, { replace: true })
}

useSeoMeta({ title: () => `Pedido ${order.value.id}`, robots: 'noindex, nofollow' })

const status = computed(() => ORDER_STATUS[order.value.status] ?? ORDER_STATUS.pendiente_pago!)
const shipping = computed(() => SHIPPING_METHODS.find((method) => method.value === order.value.shippingMethod))
const isPickup = computed(() => order.value.shippingMethod === 'recogida')

/** Contenido enriquecido: miniaturas y estado del transportista. Solo con sesión. */
const { data: detail } = await useFetch<OrderDetailLines>(`/api/orders/${route.params.id}/lines`, {
  immediate: loggedIn.value
})
const linesBySku = computed(() => {
  const index = new Map<string, OrderLine>()
  for (const line of detail.value?.lines ?? []) index.set(line.sku, line)
  return index
})
const shipment = computed(() => detail.value?.shipment ?? null)
const satisfactionScope = computed(() =>
  JSON.stringify([user.value?.id, session?.value?.sessionId, session?.value?.sessionVersion])
)
const satisfactionAuthorized = () =>
  isCloudflare.value &&
  !isViewOnly.value &&
  ready?.value === true &&
  loggedIn.value === true &&
  user?.value?.emailVerified === true &&
  supportUuid.safeParse(user.value.id).success &&
  supportUuid.safeParse(session?.value?.sessionId).success &&
  Number.isSafeInteger(session?.value?.sessionVersion) &&
  Number(session?.value?.sessionVersion) >= 1 &&
  order.value.id === route.params.id &&
  order.value.fulfillmentStatus === 'delivered' &&
  readOrderDetail(detail.value, order.value.id)?.fulfillmentStatus === 'delivered'

/**
 * Los cuatro hitos que el cliente reconoce. No son las máquinas de estado internas:
 * de esas hay cinco y ninguna se llama como lo que la gente pregunta por teléfono.
 */
const steps = computed(() => {
  const paid = ['authorized', 'captured', 'partially_refunded', 'refunded'].includes(order.value.paymentStatus)
  const preparing = ['picking', 'packed', 'ready_for_pickup', 'in_transit', 'delivered'].includes(
    order.value.fulfillmentStatus
  )
  const moving = isPickup.value
    ? ['ready_for_pickup', 'delivered'].includes(order.value.fulfillmentStatus)
    : ['in_transit', 'delivered'].includes(order.value.fulfillmentStatus)
  const done = order.value.fulfillmentStatus === 'delivered'

  return [
    { label: 'Pedido recibido', done: true },
    { label: order.value.paymentMethod === 'transferencia' ? 'Ingreso confirmado' : 'Pago confirmado', done: paid },
    { label: 'Preparando en almacén', done: preparing },
    isPickup.value
      ? { label: done ? 'Recogido' : 'Listo para recoger', done: moving }
      : { label: done ? 'Entregado' : 'En reparto', done: moving }
  ]
})
const currentStep = computed(() => {
  const index = steps.value.findIndex((step) => !step.done)
  return index === -1 ? steps.value.length - 1 : Math.max(0, index - 1)
})

/** El encabezado responde a lo que ha traído al cliente hasta aquí. */
const headline = computed(() => {
  if (isCloudflare.value) {
    if (order.value.status === 'cancelado')
      return { title: 'Pedido cancelado', lead: 'Consulta el detalle del pago con NETECO si necesitas ayuda.' }
    if (order.value.status === 'incidencia_stock')
      return {
        title: 'Incidencia con tu pedido',
        lead: 'Contacta con NETECO para confirmar la disponibilidad y el pago.'
      }
    if (order.value.paymentStatus === 'captured') {
      if (order.value.fulfillmentStatus === 'delivered')
        return {
          title: isPickup.value ? 'Pedido recogido' : 'Pedido entregado',
          lead: 'Gracias por comprar en NETECO.'
        }
      if (order.value.fulfillmentStatus === 'ready_for_pickup')
        return { title: 'Listo para recoger', lead: 'El pedido está preparado para su recogida.' }
      if (order.value.fulfillmentStatus === 'in_transit')
        return { title: 'Tu pedido va de camino', lead: 'Ya ha salido del almacén.' }
      if (['picking', 'packed'].includes(order.value.fulfillmentStatus))
        return { title: 'Lo estamos preparando', lead: 'La preparación del pedido está en curso.' }
      return {
        title: 'Pago confirmado',
        lead: 'El pedido está registrado. El seguimiento de preparación aún no está disponible aquí.'
      }
    }
    if (order.value.paymentStatus === 'authorized')
      return {
        title: 'Pago autorizado',
        lead: 'Estamos terminando la confirmación del pedido; consulta de nuevo en unos minutos.'
      }
    if (order.value.paymentStatus === 'failed' || order.value.paymentStatus === 'cancelled')
      return {
        title: 'Pago no confirmado',
        lead: isViewOnly.value
          ? 'Este enlace permite solo consulta; contacta con NETECO si necesitas gestionar el pago.'
          : canRetryCloudflarePayment.value
            ? 'Puedes reintentarlo mientras la reserva siga vigente.'
            : 'La reserva ya no está vigente; contacta con NETECO antes de volver a pagar.'
      }
    if (order.value.status === 'procesando_pago')
      return { title: 'Comprobando el pago', lead: 'El banco todavía no ha confirmado el resultado.' }
    return {
      title: 'Pedido pendiente de pago',
      lead: 'El pedido está registrado, pero aún no consta un pago confirmado.'
    }
  }
  if (order.value.status === 'cancelado') {
    return { title: 'Pedido cancelado', lead: 'Si el pago llegó a cobrarse, el importe vuelve a tu cuenta.' }
  }
  if (order.value.paymentStatus === 'failed') {
    return { title: 'El pago no se completó', lead: 'El pedido sigue guardado y puedes reintentarlo ahora mismo.' }
  }
  if (order.value.status === 'pendiente_transferencia') {
    return {
      title: 'Pedido registrado, falta el ingreso',
      lead: 'Lo preparamos en cuanto veamos la transferencia en la cuenta.'
    }
  }
  if (order.value.fulfillmentStatus === 'delivered') {
    return { title: isPickup.value ? 'Pedido recogido' : 'Pedido entregado', lead: 'Gracias por comprar en NETECO.' }
  }
  if (order.value.fulfillmentStatus === 'ready_for_pickup') {
    return { title: 'Listo para recoger', lead: 'Te esperamos en el almacén de Ontinyent en horario comercial.' }
  }
  if (order.value.fulfillmentStatus === 'in_transit') {
    return { title: 'Tu pedido va de camino', lead: 'Ya ha salido del almacén.' }
  }
  if (['picking', 'packed'].includes(order.value.fulfillmentStatus)) {
    return { title: 'Lo estamos preparando', lead: 'Te avisamos por email en cuanto salga del almacén.' }
  }
  // Sin cobro confirmado no se prepara nada, y decirle «confirmado» sería mentirle.
  if (!['authorized', 'captured', 'partially_refunded', 'refunded'].includes(order.value.paymentStatus)) {
    return {
      title: 'Pedido pendiente de pago',
      lead: 'Lo tenemos guardado. Empezamos a prepararlo en cuanto el banco confirme el cobro.'
    }
  }
  if (wasJustPlaced.value) {
    return { title: '¡Gracias por tu pedido!', lead: 'Lo hemos recibido y ya está en cola de preparación.' }
  }
  return { title: 'Pedido confirmado', lead: 'Está en cola de preparación en el almacén.' }
})

/* --- Reintento de pago --------------------------------------------------- */
const retryingPayment = ref(false)
const paymentRetryError = ref('')
const paymentReadPending = ref(false)
const paymentNeedsRead = ref(false)
const paymentMethods = [
  { value: 'tarjeta', label: 'Tarjeta' },
  { value: 'bizum', label: 'Bizum' }
] as const
type PaymentMethod = (typeof paymentMethods)[number]['value']
const paymentSelection = ref<PaymentMethod | ''>(
  order.value.paymentMethod === 'tarjeta' || order.value.paymentMethod === 'bizum' ? order.value.paymentMethod : ''
)
const paymentIntent = shallowRef<Readonly<{
  key: string
  body: Readonly<{ orderId: string; method: PaymentMethod }>
}> | null>(null)
let paymentAlive = true
let paymentAccessVersion = 0
watch(
  isViewOnly,
  (viewOnly) => {
    paymentAccessVersion++
    if (!viewOnly) return
    // This is loss of payment authority, not proof of a previous command's
    // outcome. Discard only the local intent; never resend or claim no effect.
    paymentIntent.value = null
    paymentSelection.value = ''
    paymentNeedsRead.value = false
    paymentRetryError.value = ''
  },
  { immediate: true, flush: 'sync' }
)
onBeforeUnmount(() => {
  paymentAlive = false
})

function paymentOrderEligible() {
  return (
    isCloudflare.value &&
    !isViewOnly.value &&
    order.value.id === route.params.id &&
    (!paymentIntent.value || paymentIntent.value.body.orderId === order.value.id) &&
    order.value.orderStatus === 'awaiting_payment' &&
    order.value.inventoryStatus === 'reserved' &&
    typeof order.value.reservationExpiresAt === 'string' &&
    Date.parse(order.value.reservationExpiresAt) > Date.now() &&
    (['awaiting_payment', 'failed', 'cancelled'].includes(order.value.paymentStatus) ||
      (paymentIntent.value?.body.orderId === order.value.id && order.value.paymentStatus === 'processing'))
  )
}
const showPaymentRecovery = computed(() =>
  isCloudflare.value
    ? !isViewOnly.value &&
      order.value.orderStatus === 'awaiting_payment' &&
      (['awaiting_payment', 'failed', 'cancelled'].includes(order.value.paymentStatus) ||
        (Boolean(paymentIntent.value) && order.value.paymentStatus === 'processing'))
    : order.value.paymentStatus === 'failed'
)

function validPaymentRedirect(raw: unknown): raw is HostedPaymentRedirect {
  if (!raw || typeof raw !== 'object') return false
  const value = raw as Partial<HostedPaymentRedirect>
  if (
    value.method !== 'POST' ||
    typeof value.actionUrl !== 'string' ||
    !value.fields ||
    typeof value.fields !== 'object' ||
    Array.isArray(value.fields)
  )
    return false
  if (Object.values(value.fields).some((field) => typeof field !== 'string')) return false
  // The existing CSP permits only these hosted Redsys form endpoints.
  return ['https://sis.redsys.es/sis/realizarPago', 'https://sis-t.redsys.es:25443/sis/realizarPago'].includes(
    value.actionUrl
  )
}

async function refreshPaymentOrder() {
  if (!paymentAlive || retryingPayment.value || paymentReadPending.value || !isCloudflare.value) return
  const id = String(route.params.id)
  const accessVersion = paymentAccessVersion
  paymentReadPending.value = true
  paymentNeedsRead.value = true
  try {
    const fresh = await $fetch<OrderDetailView>(`/api/orders/${id}`, { method: 'GET', retry: 0, cache: 'no-store' })
    if (!paymentAlive || route.params.id !== id || accessVersion !== paymentAccessVersion) return
    if (
      !fresh ||
      fresh.source !== 'cloudflare' ||
      (fresh.accessMode !== undefined && fresh.accessMode !== 'view_only') ||
      fresh.id !== id ||
      !['awaiting_payment', 'paid', 'cancelled', 'stock_exception'].includes(fresh.orderStatus) ||
      typeof fresh.paymentStatus !== 'string' ||
      typeof fresh.inventoryStatus !== 'string' ||
      typeof fresh.status !== 'string' ||
      !Array.isArray(fresh.items)
    )
      throw new Error('invalid_order')
    orderData.value = fresh
    paymentNeedsRead.value = false
    paymentRetryError.value = ''
    // A fresh read never repeats a write or replaces a frozen body/key.
  } catch {
    if (paymentAlive && route.params.id === id && accessVersion === paymentAccessVersion)
      paymentRetryError.value = 'No hemos podido consultar el pedido. Comprueba su estado antes de volver a pagar.'
  } finally {
    if (paymentAlive) paymentReadPending.value = false
  }
}

async function retryPayment() {
  if (!paymentAlive || retryingPayment.value || paymentReadPending.value) return
  if (isCloudflare.value && (paymentNeedsRead.value || !paymentOrderEligible())) return
  const method = paymentIntent.value?.body.method ?? paymentSelection.value
  const cloudflare = isCloudflare.value
  const id = order.value.id
  const accessVersion = paymentAccessVersion
  if (cloudflare && !paymentIntent.value) {
    if (method !== 'tarjeta' && method !== 'bizum') return
    paymentIntent.value = Object.freeze({
      key: randomId(),
      body: Object.freeze({ orderId: id, method })
    })
  }
  const intent = paymentIntent.value
  paymentRetryError.value = ''
  retryingPayment.value = true
  try {
    const result = await $fetch<{ ok?: boolean; redirect: HostedPaymentRedirect | null }>('/api/checkout/pay', {
      method: 'POST',
      retry: 0,
      ...(cloudflare && intent ? { headers: { 'Idempotency-Key': intent.key } } : {}),
      body: cloudflare && intent ? intent.body : { orderId: id, method: order.value.paymentMethod }
    })
    if (!paymentAlive || order.value.id !== id || route.params.id !== id || accessVersion !== paymentAccessVersion)
      return
    if (cloudflare && (!paymentOrderEligible() || result?.ok !== true || !validPaymentRedirect(result.redirect)))
      throw new Error('unconfirmed_payment')
    if (result.redirect) submitHostedPayment(result.redirect)
    else await refreshNuxtData()
  } catch (paymentError) {
    if (!paymentAlive || order.value.id !== id || route.params.id !== id || accessVersion !== paymentAccessVersion)
      return
    if (cloudflare) {
      const failure = paymentError as { statusCode?: unknown; status?: unknown; data?: { error?: { code?: unknown } } }
      if (
        Number(failure?.statusCode ?? failure?.status) === 422 &&
        failure?.data?.error?.code === 'method_unavailable'
      ) {
        // Definitive no-write rejection: the buyer can choose another method.
        paymentIntent.value = null
        paymentRetryError.value =
          'Este método no está disponible. Elige tarjeta o consulta con NETECO si necesitas Bizum.'
      } else {
        paymentNeedsRead.value = true
        paymentRetryError.value =
          'No hemos podido confirmar el inicio del pago. Consulta el estado del pedido antes de reintentarlo.'
      }
    } else paymentRetryError.value = apiErrorMessage(paymentError, 'No se ha podido reintentar el pago.')
  } finally {
    if (paymentAlive) retryingPayment.value = false
  }
}

/* --- Volver a pedir ------------------------------------------------------- */
const dialog = useTemplateRef('dialog')
const reorderNotice = ref('')

function onReordered(count: number) {
  reorderNotice.value = `${count} ${count === 1 ? 'referencia añadida' : 'referencias añadidas'} al carrito.`
}

const copied = ref(false)
async function copyReference(value: string) {
  try {
    await navigator.clipboard.writeText(value)
    copied.value = true
    setTimeout(() => (copied.value = false), 2000)
  } catch {
    copied.value = false
  }
}
</script>

<template>
  <div class="mx-auto max-w-5xl px-4 py-8">
    <!-- Encabezado: responde a la pregunta que trae al cliente -->
    <UiSurface
      as="header"
      padding="lg"
      :tone="
        order.status === 'cancelado' || ['failed', 'cancelled'].includes(order.paymentStatus) ? 'default' : 'accent'
      "
    >
      <div class="flex items-start gap-4">
        <span
          class="grid size-12 shrink-0 place-items-center rounded-full text-white"
          :class="
            order.status === 'cancelado'
              ? 'bg-[var(--ui-error)]'
              : ['failed', 'cancelled'].includes(order.paymentStatus)
                ? 'bg-[var(--ui-warning)]'
                : order.fulfillmentStatus === 'delivered'
                  ? 'bg-[var(--ui-success)]'
                  : 'bg-neteco-600'
          "
        >
          <UIcon :name="status.icon" class="block size-6" />
        </span>
        <div class="min-w-0 flex-1">
          <h1 class="text-xl font-bold text-[var(--text-strong)] sm:text-2xl">{{ headline.title }}</h1>
          <p class="mt-1 text-[var(--text)]">{{ headline.lead }}</p>
          <p class="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-[var(--text-muted)]">
            <span class="tabular font-semibold text-[var(--text-strong)]">{{ order.id }}</span>
            <UButton
              size="xs"
              color="neutral"
              variant="ghost"
              :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'"
              :aria-label="`Copiar el número de pedido ${order.id}`"
              @click="copyReference(order.id)"
            />
            <span>·</span>
            <span>{{ formatDate(order.createdAt) }}</span>
            <span>·</span>
            <span class="tabular">{{ formatPrice(order.total) }}</span>
          </p>
        </div>
      </div>

      <!-- Cuándo llega: la pregunta que nadie contestaba -->
      <p
        v-if="!['cancelado'].includes(order.status) && order.fulfillmentStatus !== 'delivered' && shipping"
        class="mt-5 flex items-start gap-2 rounded-[var(--radius-surface)] bg-[var(--surface)] p-3 text-sm text-[var(--text)]"
      >
        <UIcon :name="isPickup ? 'i-lucide-store' : 'i-lucide-truck'" class="mt-0.5 size-4 shrink-0 text-neteco-700" />
        <span
          ><b class="font-semibold text-[var(--text-strong)]">{{ shipping.label }}</b> · {{ shipping.desc }}</span
        >
      </p>

      <div
        v-if="order.status === 'pendiente_transferencia' && order.transferInstructions"
        class="mt-4 rounded-[var(--radius-surface)] bg-[var(--surface)] p-4 text-sm"
      >
        <p class="font-semibold text-[var(--text-strong)]">Datos para la transferencia</p>
        <dl class="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-[auto_1fr]">
          <dt class="text-[var(--text-muted)]">Importe</dt>
          <dd class="tabular font-semibold">{{ formatPrice(order.total) }}</dd>
          <dt class="text-[var(--text-muted)]">Beneficiario</dt>
          <dd>{{ order.transferInstructions.beneficiary }}</dd>
          <dt class="text-[var(--text-muted)]">IBAN</dt>
          <dd class="tabular">{{ order.transferInstructions.iban }}</dd>
          <dt class="text-[var(--text-muted)]">Concepto</dt>
          <dd class="tabular font-semibold">{{ order.transferInstructions.reference }}</dd>
        </dl>
        <p class="mt-3 text-[var(--text-muted)]">
          Pon el concepto tal cual: es lo que nos permite reconocer tu ingreso el mismo día.
        </p>
      </div>

      <p v-if="isViewOnly" role="status" class="mt-4 text-sm text-[var(--text-muted)]">
        Este enlace permite solo consulta. No permite iniciar ni reintentar pagos. Si necesitas gestionar el pago,
        contacta con NETECO.
      </p>
      <div v-if="showPaymentRecovery" class="mt-4 rounded-[var(--radius-surface)] bg-[var(--surface)] p-4">
        <p class="text-sm text-[var(--text)]">
          {{
            isCloudflare
              ? 'No consta un pago confirmado. Si ves un cargo en el banco, contacta con NETECO antes de reintentarlo.'
              : 'El banco no confirmó el cobro. No se te ha cargado nada y el pedido sigue reservado.'
          }}
        </p>
        <p v-if="isCloudflare && !canRetryCloudflarePayment" class="mt-2 text-sm text-[var(--text-muted)]">
          La reserva ya no está vigente. Contacta con NETECO para confirmar el pedido antes de intentar otro pago.
        </p>
        <fieldset
          v-if="isCloudflare && order.paymentMethod === 'pendiente'"
          class="mt-3"
          :disabled="retryingPayment || paymentReadPending || Boolean(paymentIntent) || paymentNeedsRead"
        >
          <legend class="text-sm font-semibold text-[var(--text-strong)]">Elige cómo pagar</legend>
          <div class="mt-2 flex flex-wrap gap-4">
            <label v-for="method in paymentMethods" :key="method.value" class="flex items-center gap-2 text-sm">
              <input
                v-model="paymentSelection"
                type="radio"
                name="order-payment-method"
                :value="method.value"
                :disabled="retryingPayment || paymentReadPending || Boolean(paymentIntent) || paymentNeedsRead"
              />
              {{ method.label }}
            </label>
          </div>
          <p class="mt-2 text-xs text-[var(--text-muted)]">
            La disponibilidad se confirma al iniciar el pago. No se realiza ningún cobro al elegir.
          </p>
        </fieldset>
        <UButton
          v-if="!isCloudflare || canRetryCloudflarePayment"
          data-order-payment-submit
          class="mt-3"
          :loading="retryingPayment"
          :disabled="paymentReadPending || paymentNeedsRead || (isCloudflare && !paymentSelection && !paymentIntent)"
          icon="i-lucide-refresh-cw"
          @click="retryPayment"
        >
          {{ isCloudflare && order.paymentMethod === 'pendiente' ? 'Iniciar el pago' : 'Reintentar el pago' }}
        </UButton>
        <UButton
          v-if="isCloudflare && paymentNeedsRead"
          data-order-payment-refresh
          class="mt-3"
          variant="outline"
          :loading="paymentReadPending"
          :disabled="retryingPayment"
          @click="refreshPaymentOrder"
        >
          Consultar estado del pedido
        </UButton>
        <p v-if="paymentRetryError" role="alert" class="mt-2 text-sm text-[var(--ui-error)]">
          {{ paymentRetryError }}
        </p>
      </div>
    </UiSurface>

    <!-- Barra de progreso: cuatro hitos que el cliente reconoce -->
    <UiSurface v-if="order.status !== 'cancelado' && !isCloudflare" class="mt-4" padding="sm">
      <ol class="grid gap-3 grid-cols-1 sm:grid-cols-4">
        <li v-for="(step, index) in steps" :key="step.label" class="flex items-start gap-2.5 sm:block">
          <span
            class="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full text-white sm:mb-2 sm:mt-0"
            :class="step.done ? 'bg-neteco-600' : 'bg-[var(--border-strong)]'"
          >
            <UIcon v-if="step.done" name="i-lucide-check" class="size-3" />
            <span v-else class="size-1.5 rounded-full bg-white" />
          </span>
          <span
            class="text-sm"
            :class="
              index === currentStep
                ? 'font-semibold text-[var(--text-strong)]'
                : step.done
                  ? 'text-[var(--text)]'
                  : 'text-[var(--text-muted)]'
            "
          >
            {{ step.label }}
          </span>
        </li>
      </ol>

      <div
        v-if="shipment?.trackingNumber"
        class="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border)] pt-3 text-sm"
      >
        <p class="text-[var(--text-muted)]">
          Seguimiento
          <span class="tabular ml-1 font-semibold text-[var(--text-strong)]">{{ shipment.trackingNumber }}</span>
          <span class="ml-1">· {{ shipment.provider }}</span>
        </p>
        <p class="text-[var(--text-muted)]">
          {{ FULFILLMENT_STATUS[shipment.status]?.label ?? shipment.status }} ·
          {{ formatDate(shipment.updatedAt) }}
        </p>
      </div>
    </UiSurface>

    <p
      v-if="reorderNotice"
      role="status"
      class="mt-4 rounded-[var(--radius-surface)] bg-neteco-50 p-3 text-sm text-neteco-900"
    >
      {{ reorderNotice }}
      <NuxtLink to="/carrito" class="ml-1 font-semibold underline">Ir al carrito</NuxtLink>
    </p>

    <OrderGuestAccount v-if="!loggedIn && !isCloudflare" class="mt-4" :order="order" />

    <div class="mt-4 grid min-w-0 items-start gap-4 grid-cols-1 lg:grid-cols-3">
      <UiSurface class="min-w-0 overflow-hidden lg:col-span-2" padding="none">
        <h2 class="border-b border-[var(--border)] p-5 font-semibold text-[var(--text-strong)]">
          Contenido
          <span class="ml-1 font-normal text-[var(--text-muted)]">
            {{ order.items.length }} {{ order.items.length === 1 ? 'referencia' : 'referencias' }}
          </span>
        </h2>

        <ul class="divide-y divide-[var(--border)]">
          <li v-for="item in order.items" :key="item.id" class="flex items-start gap-3 p-5">
            <OrderLineThumb
              v-if="linesBySku.get(item.sku)"
              :line="linesBySku.get(item.sku)!"
              size="sm"
              class="mt-0.5"
            />
            <div class="min-w-0 flex-1">
              <component
                :is="linesBySku.get(item.sku)?.slug ? 'NuxtLink' : 'p'"
                :to="linesBySku.get(item.sku)?.slug ? `/producto/${linesBySku.get(item.sku)!.slug}` : undefined"
                class="text-sm font-medium text-[var(--text-strong)]"
                :class="linesBySku.get(item.sku)?.slug && 'hover:text-neteco-700 hover:underline'"
              >
                {{ item.name }}
              </component>
              <p class="mt-0.5 text-xs text-[var(--text-muted)]">
                {{ item.format }} · Ref. <span class="tabular">{{ item.sku }}</span>
              </p>
              <p class="tabular mt-0.5 text-xs text-[var(--text-muted)]">
                {{ item.qty }} × {{ formatPrice(item.price) }}
              </p>
              <p
                v-if="isCloudflare && item.discountGrossCents"
                :data-order-line-discount="item.lineIndex"
                class="tabular mt-0.5 text-xs text-[var(--text-muted)]"
              >
                Descuento incluido: {{ formatPrice(item.discountGrossCents) }} (IVA incluido)
              </p>
            </div>
            <p :data-order-line-gross="item.lineIndex" class="tabular shrink-0 text-sm font-semibold">
              {{ formatPrice(isCloudflare ? item.lineGrossCents! : item.price * item.qty) }}
            </p>
          </li>
        </ul>

        <dl class="space-y-1.5 border-t border-[var(--border)] p-5 text-sm">
          <div
            v-if="isCloudflare && order.discountGrossCents"
            data-order-subtotal-base
            class="flex justify-between gap-4"
          >
            <dt class="text-[var(--text-muted)]">Productos antes del descuento (IVA incluido)</dt>
            <dd class="tabular">{{ formatPrice(order.subtotalBaseGrossCents!) }}</dd>
          </div>
          <div v-if="isCloudflare && order.discountGrossCents" data-order-discount class="flex justify-between gap-4">
            <dt class="text-[var(--text-muted)]">Descuento ya incluido (IVA incluido)</dt>
            <dd class="tabular">−{{ formatPrice(order.discountGrossCents) }}</dd>
          </div>
          <div class="flex justify-between gap-4">
            <dt class="text-[var(--text-muted)]">Subtotal</dt>
            <dd class="tabular">{{ formatPrice(order.subtotal) }}</dd>
          </div>
          <div class="flex justify-between gap-4">
            <dt class="text-[var(--text-muted)]">Envío · {{ shipping?.label ?? order.shippingMethod }}</dt>
            <dd class="tabular">{{ order.shippingCost ? formatPrice(order.shippingCost) : 'Gratis' }}</dd>
          </div>
          <div
            class="flex justify-between gap-4 border-t border-[var(--border)] pt-2 text-base font-semibold text-[var(--text-strong)]"
          >
            <dt>Total</dt>
            <dd data-order-total class="tabular">{{ formatPrice(order.total) }}</dd>
          </div>
          <div class="flex justify-between gap-4 text-xs text-[var(--text-muted)]">
            <dt>IVA incluido</dt>
            <dd class="tabular">{{ formatPrice(order.tax) }}</dd>
          </div>
        </dl>

        <OrderRefundPanel
          v-if="isCloudflare"
          :key="String(route.params.id)"
          :order-id="String(route.params.id)"
          runtime="cloudflare"
          audience="customer"
          :order-access-confirmed="order.id === route.params.id"
          class="m-5"
        />

        <div class="flex flex-wrap items-center gap-2 border-t border-[var(--border)] p-5">
          <OrderFiscalSection
            v-if="isCloudflare"
            class="w-full"
            :order-id="String(route.params.id)"
            runtime="cloudflare"
            audience="customer"
            :order-access-confirmed="order.id === route.params.id"
          />
          <UButton
            v-else-if="['issued', 'fiscal_pending'].includes(order.invoiceStatus)"
            :to="`/api/orders/${order.id}/invoice`"
            external
            variant="outline"
            color="neutral"
            icon="i-lucide-file-down"
          >
            Descargar factura
          </UButton>
          <!-- `break-all` en el correo: los locales largos no tienen punto de corte y ensanchaban la rejilla -->
          <p v-else class="min-w-0 text-sm text-[var(--text-muted)]">
            <template v-if="isCloudflare">La factura todavía no está disponible para descargar.</template>
            <template v-else>
              Te enviamos la factura a
              <span class="font-medium break-all text-[var(--text)]">{{ order.email }}</span> en cuanto se emita.
            </template>
          </p>
        </div>
      </UiSurface>

      <div class="min-w-0 space-y-4">
        <UiSurface class="min-w-0">
          <h2 class="font-semibold text-[var(--text-strong)]">{{ isPickup ? 'Recogida' : 'Entrega' }}</h2>
          <div v-if="order.purchaseOrderReference" data-testid="order-purchase-reference" class="mt-3 min-w-0 text-sm">
            <p class="font-semibold">Referencia interna / PO</p>
            <p class="[overflow-wrap:anywhere]">{{ order.purchaseOrderReference }}</p>
          </div>
          <p v-if="isPickup" class="mt-2 text-sm text-[var(--text)]">
            Almacén NETECO, Ontinyent. Trae el número de pedido.
          </p>
          <address v-else class="mt-2 text-sm not-italic text-[var(--text)]">
            <p class="font-medium">{{ order.name }}</p>
            <p v-if="order.company" class="text-[var(--text-muted)]">
              {{ order.company }}<template v-if="order.nif"> · {{ order.nif }}</template>
            </p>
            <p>{{ order.address }}</p>
            <p>
              {{ order.zip }} {{ formatPlace(order.city)
              }}<template v-if="order.province"> ({{ formatPlace(order.province) }})</template>
            </p>
          </address>

          <div class="mt-3 space-y-1 border-t border-[var(--border)] pt-3 text-sm text-[var(--text-muted)]">
            <p class="flex items-center gap-1.5">
              <UIcon name="i-lucide-phone" class="size-3.5 shrink-0" />{{ order.phone }}
            </p>
            <p class="flex min-w-0 items-center gap-1.5">
              <UIcon name="i-lucide-mail" class="size-3.5 shrink-0" />
              <span class="min-w-0 truncate">{{ order.email }}</span>
            </p>
          </div>

          <p
            v-if="order.notes"
            class="mt-3 rounded-[var(--radius-control)] bg-[var(--surface-sunken)] p-2.5 text-sm text-[var(--text)]"
          >
            «{{ order.notes }}»
          </p>
        </UiSurface>

        <UiSurface padding="sm">
          <h2 class="font-semibold text-[var(--text-strong)]">¿Necesitas algo?</h2>
          <div class="mt-3 space-y-2">
            <UButton v-if="loggedIn" block variant="soft" icon="i-lucide-repeat-2" @click="dialog?.start(order.id)">
              Volver a pedir esto
            </UButton>
            <OrderSaveAsList
              v-if="loggedIn && detail?.lines?.length"
              :order-id="order.id"
              :lines="detail.lines"
              :cloudflare="isCloudflare"
            />
            <UButton
              v-if="order.fulfillmentStatus === 'delivered'"
              :to="`/devoluciones?pedido=${encodeURIComponent(order.id)}`"
              block
              color="neutral"
              variant="outline"
              icon="i-lucide-rotate-ccw"
            >
              Solicitar devolución
            </UButton>
            <UButton to="/contacto" block color="neutral" variant="ghost" icon="i-lucide-message-circle">
              Escribirnos sobre este pedido
            </UButton>
          </div>
        </UiSurface>
      </div>
    </div>

    <div class="mt-6 text-center">
      <UButton to="/catalogo" variant="link" color="neutral" icon="i-lucide-arrow-left">Seguir comprando</UButton>
    </div>

    <BeplyOrderPanel
      v-if="trackingReady && !isViewOnly"
      :order-id="order.id"
      audience="customer"
      :scope-key="originalTrackingScope"
      :enabled="trackingReady && !isViewOnly"
    />
    <OrderTrackingPanel
      v-if="trackingReady"
      :order-id="order.id"
      :audience="isViewOnly ? 'guest' : 'customer'"
      :scope-key="originalTrackingScope"
      :enabled="trackingReady"
    />
    <CustomerSatisfactionPanel
      v-if="satisfactionAuthorized()"
      kind="delivery"
      :target-id="order.id"
      :scope-key="satisfactionScope"
      :enabled="satisfactionAuthorized()"
      :pending="false"
    />
    <ReorderDialog ref="dialog" @added="onReordered" />
  </div>
</template>
