<script setup lang="ts">
import CartRecoverySection from '~/components/CartRecoverySection.vue'
import { useCartStore } from '~/stores/cart'
import CartReadFeedback from '~/components/CartReadFeedback.vue'
import { submitHostedPayment } from '~/utils/hosted-payment'
import { NEWSLETTER_CONFIRMATION_NOTICE, NEWSLETTER_CONSENT_TEXT } from '~~/shared/newsletter'
import { promotionCodeSchema, promotionReasonSchema, type PromotionReason } from '~~/shared/promotions'

useSeoMeta({ title: 'Tramitar pedido' })

const cart = useCartStore()
const runtime = useRuntimeConfig()
const showNetPrices = computed(() => runtime.public.priceDisplayMode === 'net-and-gross')
const { loggedIn, user } = useUserSession()
const toast = useToast()
const { track } = useAnalytics()
const cartMutationNotice = 'Comprueba la adición en el carrito antes de continuar con el pedido.'
const recoveryError = ref('')
const recovering = ref(true)
const retryingRead = ref(false)
let readPending = false
const cartReadLoading = computed(
  () => recovering.value || retryingRead.value || cart.loading || (!cart.ready && !cart.error)
)
const cartReadable = computed(
  () => !recovering.value && cart.ready && !cart.loading && !cart.error && !retryingRead.value
)
async function retryCartRead() {
  if (readPending || recovering.value || recoveryError.value || cart.loading) return
  readPending = true
  retryingRead.value = true
  try {
    await cart.load({ restoreCachedItems: false })
  } finally {
    readPending = false
    retryingRead.value = false
  }
}

onMounted(async () => {
  try {
    const recovery = await $fetch<{ orderId: string | null }>('/api/checkout/recover')
    if (recovery.orderId) {
      cart.resetLocal()
      await navigateTo(`/pedido/${recovery.orderId}`, { replace: true })
      return
    }
  } catch (error) {
    const failure = error && typeof error === 'object' ? (error as { status?: unknown; statusCode?: unknown }) : null
    const status = Number(failure?.statusCode ?? failure?.status)
    // The PostgreSQL deployment has no recovery route; its checkout contract
    // remains unchanged until the Nuxt Worker cutover.
    if (status !== 404 && status !== 401) {
      recoveryError.value = 'No hemos podido comprobar si ya se creó un pedido. Recarga antes de volver a pagar.'
      recovering.value = false
      return
    }
  }
  await cart.load()
  recovering.value = false
  void track('checkout_started', { itemCount: cart.count, totalCents: cart.subtotal })
})

const form = reactive({
  name: '',
  company: '',
  nif: '',
  email: '',
  phone: ''
})
const purchaseOrderReference = ref('')
const shippingAddress = reactive({
  recipientName: '',
  companyName: '',
  taxId: '',
  line1: '',
  line2: '',
  postalCode: '',
  city: '',
  region: 'Valencia',
  countryCode: 'ES' as const,
  phone: '',
  instructions: ''
})
const billingAddress = reactive({
  recipientName: '',
  companyName: '',
  taxId: '',
  line1: '',
  line2: '',
  postalCode: '',
  city: '',
  region: 'Valencia',
  countryCode: 'ES' as const,
  phone: '',
  instructions: ''
})
const billingSameAsShipping = ref(true)

watch(
  user,
  (u) => {
    if (!u) return
    form.name ||= u.name ?? ''
    form.email ||= u.email ?? ''
    form.phone ||= u.phone ?? ''
    form.company ||= u.company ?? ''
    shippingAddress.recipientName ||= u.name ?? ''
    shippingAddress.companyName ||= u.company ?? ''
    shippingAddress.phone ||= u.phone ?? ''
  },
  { immediate: true }
)

watch(
  () => form.name,
  (value, previous) => {
    if (!shippingAddress.recipientName || shippingAddress.recipientName === previous)
      shippingAddress.recipientName = value
  }
)
watch(
  () => form.company,
  (value, previous) => {
    if (!shippingAddress.companyName || shippingAddress.companyName === previous) shippingAddress.companyName = value
  }
)
watch(
  () => form.nif,
  (value, previous) => {
    if (!shippingAddress.taxId || shippingAddress.taxId === previous) shippingAddress.taxId = value
  }
)
watch(
  () => form.phone,
  (value, previous) => {
    if (!shippingAddress.phone || shippingAddress.phone === previous) shippingAddress.phone = value
  }
)

const shippingMethod = ref<'reparto' | 'envio' | 'recogida'>('reparto')
const paymentMethod = ref<'tarjeta' | 'bizum' | 'transferencia'>('tarjeta')
const acceptTerms = ref(false)
const marketingConsent = ref(false)

interface ShippingRate {
  serviceCode: string
  label: string
  netCents: number
  taxRateBasisPoints: number
  estimatedDeliveryFrom: string | null
  estimatedDeliveryTo: string | null
  etaStatus?: 'estimated' | 'unknown'
  etaReason?: 'calendar_not_configured' | 'lead_time_unknown' | 'no_operating_window' | 'estimated_not_guaranteed'
  profile: 'parcel' | 'multi_parcel' | 'pallet' | 'own_delivery' | 'adr' | 'pickup'
  pricingVersion: string
  subtotalNetCents: number
  taxCents: number
  totalGrossCents: number
  expiresAt?: string
  quoteId?: string
  shippingQuoteId?: string
  optionIndex?: number
  optionHash?: string
}

function isCloudflareRate(rate: ShippingRate): rate is ShippingRate & {
  quoteId: string
  shippingQuoteId: string
  optionIndex: number
  optionHash: string
} {
  return !!rate.quoteId && !!rate.shippingQuoteId && Number.isSafeInteger(rate.optionIndex) && !!rate.optionHash
}

const shippingRates = ref<ShippingRate[]>([])
const shippingRateLoading = ref(false)
const shippingRateError = ref('')
const shippingRateExpiresAt = ref('')
let shippingRateRequestId = 0
let shippingRateIdempotencyKey = randomId()
let rateTimer: ReturnType<typeof setTimeout> | undefined

const shippingRateReady = computed(
  () =>
    /^\d{5}$/.test(shippingAddress.postalCode.trim()) &&
    shippingAddress.recipientName.trim().length >= 2 &&
    shippingAddress.line1.trim().length >= 4 &&
    shippingAddress.city.trim().length >= 2 &&
    shippingAddress.city.trim().length <= 80 &&
    shippingAddress.region.trim().length >= 2 &&
    shippingAddress.phone.trim().length >= 6
)

function invalidateShippingRates() {
  shippingRateRequestId++
  shippingRates.value = []
  shippingRateExpiresAt.value = ''
  shippingRateError.value = ''
  shippingRateLoading.value = false
  shippingRateIdempotencyKey = randomId()
  promotion.value = null
}

function methodForRate(rate: ShippingRate) {
  if (rate.profile === 'own_delivery') return 'reparto'
  if (rate.profile === 'pickup') return 'recogida'
  return 'envio'
}

function methodRate(method: string) {
  return shippingRates.value.find((rate) => methodForRate(rate) === method)
}

const eligibleShippingMethods = computed(() =>
  shippingRates.value.length ? SHIPPING_METHODS.filter((method) => methodRate(method.value)) : SHIPPING_METHODS
)
const selectedShippingRate = computed(() => methodRate(shippingMethod.value))
const cloudflareCheckout = computed(() => !!selectedShippingRate.value && isCloudflareRate(selectedShippingRate.value))
watch(cloudflareCheckout, (enabled) => {
  if (!enabled) return
  if (paymentMethod.value === 'transferencia') paymentMethod.value = 'tarjeta'
  marketingConsent.value = false
})
const quotedShippingGross = computed(() => {
  const rate = selectedShippingRate.value
  if (!rate) return 0
  return rate.netCents + Math.round((rate.netCents * rate.taxRateBasisPoints) / 10_000)
})
const shippingCost = computed(() => quotedShippingGross.value)
const freeShipping = useFreeShipping()
const total = computed(() => selectedShippingRate.value?.totalGrossCents ?? cart.subtotal + shippingCost.value)
const tax = computed(() => selectedShippingRate.value?.taxCents ?? cart.tax)

const submitting = ref(false)
const errorMsg = ref('')
const errors = reactive<Record<string, string>>({})
// si el pago con tarjeta/Bizum falla, reutilizamos el pedido creado para reintentar
const pendingOrder = ref<{ id: string; token?: string; cloudflare: boolean } | null>(null)
const checkoutAttempt = reactive({ idempotencyKey: randomId(), guestToken: randomId(), paymentKey: randomId() })
// Once sent, this command belongs to the original intent, not to the editable form.
const checkoutCommand = shallowRef<{
  body: Record<string, unknown>
  headers?: Record<string, string>
  cloudflare: boolean
  paymentMethod: typeof paymentMethod.value
  paymentKey: string
} | null>(null)
const uncertainOrder = computed(() => !!checkoutCommand.value && !pendingOrder.value)
const checkingOrder = ref(false)
const couponRuntime = computed(() => runtime.public.serverRuntime === 'cloudflare')
const couponDraft = ref('')
const couponCode = ref('')
const couponError = ref('')
interface CheckoutPromotion {
  code: string
  applied: boolean
  reason: PromotionReason | null
  discountGrossCents: number
}
const promotion = ref<CheckoutPromotion | null>(null)
const couponLocked = computed(
  () =>
    !cartReadable.value ||
    !!pendingOrder.value ||
    uncertainOrder.value ||
    submitting.value ||
    checkingOrder.value ||
    cart.pendingMutation ||
    shippingRateLoading.value
)
const couponNeedsApply = computed(() => {
  if (!couponRuntime.value) return false
  if (!couponDraft.value.trim()) return !!couponCode.value
  const parsed = promotionCodeSchema.safeParse(couponDraft.value)
  return !parsed.success || parsed.data !== couponCode.value
})
const couponFeedback = computed(() => {
  if (couponError.value) return couponError.value
  if (!promotion.value) return ''
  if (promotion.value.applied) return 'Cupón aplicado. El descuento ya está incluido en el total.'
  const reason = promotion.value.reason
  if (reason === 'customer_required' || reason === 'segment_not_eligible')
    return 'Este código no se puede aplicar a esta compra. Comprueba si requiere tu cuenta.'
  return 'Este código no se puede aplicar a esta compra.'
})
function resetUnsubmittedCheckoutKeys() {
  checkoutAttempt.idempotencyKey = randomId()
  checkoutAttempt.guestToken = randomId()
  checkoutAttempt.paymentKey = randomId()
}
watch(
  couponDraft,
  () => {
    if (!couponRuntime.value) return
    if (pendingOrder.value || uncertainOrder.value || submitting.value || cart.pendingMutation) {
      return
    }
    clearTimeout(rateTimer)
    invalidateShippingRates()
    couponError.value = ''
    resetUnsubmittedCheckoutKeys()
  },
  { flush: 'sync' }
)
async function applyCoupon() {
  if (!couponRuntime.value || couponLocked.value) return
  const parsed = promotionCodeSchema.safeParse(couponDraft.value)
  if (!parsed.success) {
    couponError.value = 'Revisa el código de descuento: usa letras sin acentos, números, guiones o guion bajo.'
    return
  }
  couponCode.value = parsed.data
  couponError.value = ''
  await refreshShippingRates()
}
async function removeCoupon() {
  if (!couponRuntime.value || couponLocked.value) return
  couponCode.value = ''
  couponDraft.value = ''
  couponError.value = ''
  await refreshShippingRates()
}
function readCheckoutPromotion(raw: unknown, expectedCode: string): CheckoutPromotion | null {
  if (!expectedCode && raw === undefined) return null
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('No se ha podido verificar el cupón.')
  const value = raw as Record<string, unknown>
  if (
    Object.keys(value).some((key) => !['code', 'applied', 'reason', 'discountGrossCents'].includes(key)) ||
    value.code !== expectedCode ||
    typeof value.applied !== 'boolean' ||
    typeof value.discountGrossCents !== 'number' ||
    !Number.isSafeInteger(value.discountGrossCents) ||
    value.discountGrossCents < 0 ||
    (value.applied
      ? value.reason !== null || value.discountGrossCents <= 0
      : !promotionReasonSchema.safeParse(value.reason).success || value.discountGrossCents !== 0)
  )
    throw new Error('No se ha podido verificar el cupón.')
  return {
    code: expectedCode,
    applied: value.applied,
    reason: value.reason === null ? null : promotionReasonSchema.parse(value.reason),
    discountGrossCents: value.discountGrossCents
  }
}

async function recoverSubmittedOrder() {
  if (submitting.value || checkingOrder.value || !uncertainOrder.value) return
  checkingOrder.value = true
  try {
    const recovery = await $fetch<{ orderId: string | null }>('/api/checkout/recover')
    if (!recovery.orderId) {
      errorMsg.value =
        'No se ha confirmado si se creó el pedido. No enviaremos otro. Vuelve a comprobarlo o llámanos al 600 861 334.'
      return
    }
    cart.resetLocal()
    await navigateTo(`/pedido/${recovery.orderId}`, { replace: true })
  } catch {
    errorMsg.value =
      'No hemos podido comprobar si se creó el pedido. No enviaremos otro. Vuelve a comprobarlo o llámanos al 600 861 334.'
  } finally {
    checkingOrder.value = false
  }
}

onBeforeUnmount(() => {
  clearTimeout(rateTimer)
  shippingRateRequestId++
})

async function refreshShippingRates() {
  clearTimeout(rateTimer)
  const requestId = ++shippingRateRequestId
  shippingRates.value = []
  promotion.value = null
  shippingRateError.value = ''
  if (!shippingRateReady.value || cart.pendingMutation) {
    if (cart.pendingMutation) shippingRateError.value = cartMutationNotice
    shippingRateLoading.value = false
    return false
  }
  if (shippingRateExpiresAt.value && Date.parse(shippingRateExpiresAt.value) <= Date.now()) {
    shippingRateIdempotencyKey = randomId()
  }
  shippingRateLoading.value = true
  const requestKey = shippingRateIdempotencyKey
  const requestedCode = couponRuntime.value ? couponCode.value : ''
  const requestBody = {
    name: shippingAddress.recipientName.trim(),
    line1: shippingAddress.line1.trim(),
    postalCode: shippingAddress.postalCode.trim(),
    city: shippingAddress.city.trim(),
    region: shippingAddress.region.trim(),
    phone: shippingAddress.phone.trim(),
    ...(requestedCode ? { couponCode: requestedCode } : {})
  }
  try {
    await cart.ensureLoaded()
    if (cart.pendingMutation) {
      shippingRateError.value = cartMutationNotice
      return false
    }
    const quote = await $fetch<{ cartVersion: number; rates: ShippingRate[]; promotion?: unknown }>(
      '/api/shipping/rates',
      {
        method: 'POST',
        headers: { 'Idempotency-Key': requestKey },
        body: requestBody
      }
    )
    if (requestId !== shippingRateRequestId || cart.pendingMutation) return false
    if (quote.cartVersion !== cart.version || !quote.rates.length) {
      shippingRateError.value = 'El carrito ha cambiado. Vuelve a calcular la entrega.'
      return false
    }
    const confirmedPromotion = couponRuntime.value ? readCheckoutPromotion(quote.promotion, requestedCode) : null
    shippingRates.value = quote.rates
    promotion.value = confirmedPromotion
    shippingRateExpiresAt.value = quote.rates[0]?.expiresAt ?? ''
    if (!methodRate(shippingMethod.value)) {
      shippingMethod.value = methodForRate(quote.rates[0]!)
    }
    return true
  } catch (error) {
    if (requestId === shippingRateRequestId) {
      shippingRateError.value = apiErrorMessage(error, 'No se han podido calcular los métodos de entrega.')
      if (requestedCode) couponError.value = 'No se ha podido comprobar el cupón. Vuelve a calcularlo.'
    }
    return false
  } finally {
    if (requestId === shippingRateRequestId) shippingRateLoading.value = false
  }
}

watch(
  () => [
    shippingRateReady.value,
    shippingAddress.postalCode.trim(),
    shippingAddress.city.trim(),
    shippingAddress.region.trim(),
    cart.version,
    cart.pendingMutation
  ],
  () => {
    if (cart.pendingMutation) {
      clearTimeout(rateTimer)
      invalidateShippingRates()
      shippingRateError.value = cartMutationNotice
      return
    }
    if (checkoutCommand.value || submitting.value) return
    clearTimeout(rateTimer)
    invalidateShippingRates()
    if (shippingRateReady.value) rateTimer = setTimeout(() => void refreshShippingRates(), 350)
  }
)

// Edits may start a new intent only before any order command has been sent.
watch(
  [
    paymentMethod,
    shippingMethod,
    form,
    shippingAddress,
    billingAddress,
    billingSameAsShipping,
    marketingConsent,
    purchaseOrderReference
  ],
  () => {
    if (checkoutCommand.value || pendingOrder.value || submitting.value) return
    pendingOrder.value = null
    checkoutAttempt.idempotencyKey = randomId()
    checkoutAttempt.guestToken = randomId()
    checkoutAttempt.paymentKey = randomId()
  },
  { deep: true }
)

function normalizedPurchaseOrderReference() {
  const raw = purchaseOrderReference.value
  // Validate before trimming: leading controls are not an empty reference.
  if (
    [...raw].some((character) => {
      const code = character.charCodeAt(0)
      return code <= 31 || (code >= 127 && code <= 159) || code === 0x2028 || code === 0x2029
    })
  ) {
    throw new Error('La referencia debe tener como máximo 120 caracteres y una sola línea sin controles.')
  }
  const normalized = raw.trim().normalize('NFC')
  if (normalized.length > 120) {
    throw new Error('La referencia debe tener como máximo 120 caracteres y una sola línea sin controles.')
  }
  return normalized || undefined
}

function validate() {
  Object.assign(errors, {
    name: '',
    email: '',
    phone: '',
    shippingRecipientName: '',
    shippingPhone: '',
    shippingLine1: '',
    shippingPostalCode: '',
    shippingCity: '',
    billingRecipientName: '',
    billingLine1: '',
    billingPostalCode: '',
    billingCity: '',
    billingTaxId: '',
    nif: '',
    terms: '',
    purchaseOrderReference: ''
  })
  if (runtime.public.serverRuntime === 'cloudflare') {
    try {
      normalizedPurchaseOrderReference()
    } catch {
      errors.purchaseOrderReference =
        'La referencia debe tener como máximo 120 caracteres y una sola línea sin controles.'
    }
  }
  if (!form.name.trim()) errors.name = 'Indica el nombre completo'
  if (!form.email.trim()) errors.email = 'Indica el email'
  else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email.trim())) errors.email = 'El email no parece válido'
  if (!form.phone.trim()) errors.phone = 'Indica un teléfono de contacto'
  if (form.nif.trim() && !isValidTaxId(form.nif)) errors.nif = 'Revisa el NIF, NIE o CIF'
  if (!shippingAddress.recipientName.trim()) errors.shippingRecipientName = 'Indica el destinatario'
  if (!shippingAddress.phone.trim()) errors.shippingPhone = 'Indica el teléfono de entrega'
  if (!shippingAddress.line1.trim()) errors.shippingLine1 = 'Indica la dirección'
  if (!shippingAddress.postalCode.trim()) errors.shippingPostalCode = 'Indica el código postal'
  else if (!/^\d{5}$/.test(shippingAddress.postalCode.trim()))
    errors.shippingPostalCode = 'El código postal debe tener 5 cifras'
  if (!shippingAddress.city.trim()) errors.shippingCity = 'Indica la población'
  if (!billingSameAsShipping.value) {
    if (!billingAddress.recipientName.trim()) errors.billingRecipientName = 'Indica el titular de facturación'
    if (!billingAddress.line1.trim()) errors.billingLine1 = 'Indica la dirección fiscal'
    if (!billingAddress.postalCode.trim()) errors.billingPostalCode = 'Indica el código postal fiscal'
    else if (!/^\d{5}$/.test(billingAddress.postalCode.trim()))
      errors.billingPostalCode = 'El código postal debe tener 5 cifras'
    if (!billingAddress.city.trim()) errors.billingCity = 'Indica la población fiscal'
    if (billingAddress.taxId.trim() && !isValidTaxId(billingAddress.taxId))
      errors.billingTaxId = 'Revisa el NIF, NIE o CIF'
  }
  if (!acceptTerms.value) errors.terms = 'Debes aceptar las condiciones para continuar'
  return !Object.values(errors).some(Boolean)
}

function isValidTaxId(value: string) {
  const normalized = value.toUpperCase().replace(/[\s-]/g, '')
  if (/^\d{8}[A-Z]$/.test(normalized)) {
    return 'TRWAGMYFPDXBNJZSQVHLCKE'[Number(normalized.slice(0, 8)) % 23] === normalized[8]
  }
  return /^[A-Z][0-9A-Z]{8}$/.test(normalized)
}

function effectiveBillingAddress() {
  return billingSameAsShipping.value ? { ...shippingAddress, instructions: '' } : { ...billingAddress }
}

function scrollTo(id: string, block: ScrollLogicalPosition = 'start') {
  nextTick(() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block }))
}

function scrollToFirstError() {
  if (Object.entries(errors).some(([key, value]) => key !== 'terms' && value)) scrollTo('sec-datos')
  else scrollTo('checkout-alert', 'center')
}

async function submit() {
  if (submitting.value || checkingOrder.value || uncertainOrder.value) return
  if (!pendingOrder.value && couponNeedsApply.value) {
    couponError.value = 'Aplica o quita el código antes de continuar con el pedido.'
    return
  }
  if (cart.pendingMutation) {
    errorMsg.value = cartMutationNotice
    return
  }
  submitting.value = true
  errorMsg.value = ''
  try {
    if (!pendingOrder.value && !validate()) {
      errorMsg.value = 'Revisa los campos marcados.'
      scrollToFirstError()
      return
    }
    if (!pendingOrder.value && (!(await refreshShippingRates()) || !selectedShippingRate.value)) {
      errorMsg.value = shippingRateError.value || 'Selecciona un método de entrega elegible.'
      scrollTo('checkout-alert', 'center')
      return
    }

    let order = pendingOrder.value
    if (!order) {
      const rate = selectedShippingRate.value
      if (!rate) throw new Error('Selecciona un método de entrega elegible.')
      await cart.ensureLoaded()
      if (cart.pendingMutation) throw new Error(cartMutationNotice)
      if (!cart.id) throw new Error('El carrito no está disponible')
      const common = {
        customer: { ...form },
        shippingAddress: { ...shippingAddress },
        billingAddress: effectiveBillingAddress(),
        expectedTotalGrossCents: rate.totalGrossCents,
        paymentMethod: paymentMethod.value,
        cartId: cart.id,
        cartVersion: cart.version,
        termsAccepted: true,
        marketingConsent: marketingConsent.value
      }
      const cloudflare = isCloudflareRate(rate)
      const reference = cloudflare ? normalizedPurchaseOrderReference() : undefined
      checkoutCommand.value = {
        cloudflare,
        paymentMethod: paymentMethod.value,
        paymentKey: checkoutAttempt.paymentKey,
        ...(cloudflare ? { headers: { 'Idempotency-Key': checkoutAttempt.idempotencyKey } } : {}),
        body: cloudflare
          ? {
              ...common,
              ...(reference ? { purchaseOrderReference: reference } : {}),
              quoteId: rate.quoteId,
              shippingQuoteId: rate.shippingQuoteId,
              optionIndex: rate.optionIndex,
              optionHash: rate.optionHash,
              privacyNoticePresented: true
            }
          : {
              ...common,
              shippingMethod: shippingMethod.value,
              shippingServiceCode: rate.serviceCode,
              expectedPricingVersion: rate.pricingVersion,
              idempotencyKey: checkoutAttempt.idempotencyKey,
              guestToken: checkoutAttempt.guestToken
            }
      }
      clearTimeout(rateTimer)
      const created = await $fetch<{ id: string; token?: string }>('/api/orders', {
        method: 'POST',
        headers: checkoutCommand.value.headers,
        body: checkoutCommand.value.body
      })
      order = { ...created, cloudflare }
      pendingOrder.value = order
    }

    if (cart.pendingMutation) throw new Error(cartMutationNotice)
    const originalPaymentMethod = checkoutCommand.value!.paymentMethod
    if (originalPaymentMethod === 'transferencia') {
      await finish(order)
      return
    }

    const pay = await $fetch<{
      ok: boolean
      redirect: { actionUrl: string; method: 'POST'; fields: Record<string, string> } | null
    }>('/api/checkout/pay', {
      method: 'POST',
      ...(order.cloudflare ? { headers: { 'Idempotency-Key': checkoutCommand.value!.paymentKey } } : {}),
      body: order.cloudflare
        ? { orderId: order.id, method: originalPaymentMethod }
        : { orderId: order.id, token: order.token, method: originalPaymentMethod }
    })
    if (pay.redirect) {
      pendingOrder.value = order
      cart.resetLocal()
      submitHostedPayment(pay.redirect)
    } else {
      await finish(order)
    }
  } catch (error) {
    const responseData =
      error && typeof error === 'object' && 'data' in error
        ? (error as { data?: { data?: { code?: string }; code?: string; error?: { code?: string } } }).data
        : undefined
    const quoteChanged =
      responseData?.code === 'CHECKOUT_QUOTE_CHANGED' ||
      responseData?.data?.code === 'CHECKOUT_QUOTE_CHANGED' ||
      responseData?.error?.code === 'CHECKOUT_QUOTE_CHANGED'
    const failure = error && typeof error === 'object' ? (error as { status?: unknown; statusCode?: unknown }) : null
    const status = Number(failure?.statusCode ?? failure?.status)
    const code = responseData?.error?.code
    // These exact Cloudflare rejections occur before order/reservation writes.
    // Other failures (including 401 after commit) must retain the original intent.
    const definitiveRejection =
      checkoutCommand.value?.cloudflare &&
      ((status === 400 && code === 'invalid_input') ||
        (status === 422 &&
          (code === 'method_unavailable' || code === 'marketing_unavailable' || code === 'payment_total_non_positive')))
    if (definitiveRejection && !pendingOrder.value) checkoutCommand.value = null
    if (quoteChanged && !pendingOrder.value) {
      checkoutCommand.value = null
      await refreshShippingRates()
    }
    errorMsg.value =
      definitiveRejection && code === 'payment_total_non_positive' && !pendingOrder.value
        ? 'El total a pagar debe ser mayor que cero. Quita o ajusta el cupón antes de continuar.'
        : uncertainOrder.value
          ? 'No hemos podido confirmar si se creó el pedido. Comprueba el pedido antes de volver a pagar; conservamos el intento original.'
          : apiErrorMessage(error, 'No se ha podido crear el pedido. Vuelve a intentarlo o llámanos al 600 861 334.')
    scrollTo('checkout-alert', 'center')
  } finally {
    submitting.value = false
  }
}

async function finish(order: { id: string; token?: string }) {
  cart.resetLocal()
  toast.add({ title: 'Pedido realizado', icon: 'i-lucide-check-circle-2', color: 'success' })
  navigateTo(`/pedido/${order.id}`)
}
</script>

<template>
  <div class="mx-auto max-w-[1600px] px-4 py-8">
    <h1 class="text-2xl font-bold text-slate-900 sm:text-3xl">Tramitar pedido</h1>

    <ClientOnly>
      <CartRecoverySection stage="checkout" />
      <UAlert
        v-if="recoveryError"
        class="mt-6"
        color="error"
        variant="subtle"
        icon="i-lucide-alert-circle"
        :title="recoveryError"
      />
      <CartReadFeedback v-else-if="!cartReadable" :loading="cartReadLoading" @retry="retryCartRead" />
      <form
        v-else-if="cart.items.length"
        class="mt-6 grid grid-cols-1 items-start gap-8 lg:grid-cols-3"
        @submit.prevent="submit"
      >
        <div class="min-w-0 space-y-6 lg:col-span-2">
          <div v-if="cart.pendingMutation" role="alert" class="rounded-2xl border border-amber-300 bg-amber-50 p-5">
            <p>{{ cartMutationNotice }}</p>
            <NuxtLink to="/carrito" class="mt-2 inline-block font-semibold underline">Revisar el carrito</NuxtLink>
          </div>
          <!-- identificación -->
          <section v-if="!loggedIn" class="rounded-2xl border border-neteco-200 bg-neteco-50 p-5">
            <p class="flex items-center gap-2 font-medium text-neteco-900">
              <UIcon name="i-lucide-circle-user-round" class="size-5 text-neteco-600" />
              Estás comprando como invitado
            </p>
            <p class="mt-1 text-sm text-neteco-800">
              No necesitas cuenta para terminar el pedido. Si ya tienes una,
              <NuxtLink to="/login?redirect=/checkout" class="font-semibold underline">inicia sesión</NuxtLink>
              para rellenar tus datos automáticamente y ver tu historial.
            </p>
          </section>
          <section v-else class="rounded-2xl border border-emerald-200 bg-emerald-50 p-5">
            <p class="flex min-w-0 items-center gap-2 text-sm font-medium text-emerald-800">
              <UIcon name="i-lucide-check-circle-2" class="size-5 shrink-0" />
              <span class="min-w-0"
                >Comprando con tu cuenta: <span class="break-all">{{ user?.email }}</span></span
              >
            </p>
          </section>

          <!-- datos -->
          <section id="sec-datos" class="scroll-mt-40 rounded-2xl border border-slate-200 bg-white p-6">
            <h2 class="flex items-center gap-2 text-lg font-bold text-slate-900">
              <span
                class="flex size-7 items-center justify-center rounded-full bg-neteco-600 text-sm font-bold text-white"
                >1</span
              >
              Contacto, entrega y facturación
            </h2>
            <h3 class="mt-5 text-sm font-bold uppercase tracking-wide text-slate-500">Datos de contacto</h3>
            <div class="mt-5 grid gap-4 grid-cols-1 sm:grid-cols-2">
              <UFormField label="Nombre y apellidos" required :error="errors.name">
                <UInput v-model="form.name" class="w-full" autocomplete="name" />
              </UFormField>
              <UFormField label="Empresa" hint="opcional">
                <UInput v-model="form.company" class="w-full" autocomplete="organization" />
              </UFormField>
              <UFormField label="NIF / NIE / CIF" hint="opcional" :error="errors.nif">
                <UInput v-model="form.nif" class="w-full" />
              </UFormField>
              <UFormField label="Teléfono" required :error="errors.phone">
                <UInput v-model="form.phone" type="tel" inputmode="tel" class="w-full" autocomplete="tel" />
              </UFormField>
              <UFormField label="Email" required class="sm:col-span-2" :error="errors.email">
                <UInput v-model="form.email" type="email" class="w-full" autocomplete="email" />
              </UFormField>
            </div>

            <div v-if="runtime.public.serverRuntime === 'cloudflare'" class="mt-4">
              <label for="purchase-order-reference" class="block text-sm font-medium"
                >Referencia interna / PO (opcional)</label
              >
              <input
                id="purchase-order-reference"
                v-model="purchaseOrderReference"
                type="text"
                maxlength="120"
                aria-describedby="purchase-order-reference-help"
                :aria-invalid="Boolean(errors.purchaseOrderReference)"
                class="mt-2 w-full rounded-md border border-slate-300 px-3 py-2"
              />
              <p id="purchase-order-reference-help" class="mt-1 text-sm text-slate-600">
                Referencia de compra de tu organización. Es independiente del NIF y de las notas de entrega.
              </p>
              <p v-if="errors.purchaseOrderReference" role="alert" class="mt-1 text-sm text-red-700">
                {{ errors.purchaseOrderReference }}
              </p>
            </div>

            <h3 class="mt-8 text-sm font-bold uppercase tracking-wide text-slate-500">Dirección de entrega</h3>
            <div class="mt-4 grid gap-4 grid-cols-1 sm:grid-cols-2">
              <UFormField label="Destinatario" required :error="errors.shippingRecipientName">
                <UInput v-model="shippingAddress.recipientName" class="w-full" autocomplete="shipping name" />
              </UFormField>
              <UFormField label="Empresa" hint="opcional">
                <UInput v-model="shippingAddress.companyName" class="w-full" autocomplete="shipping organization" />
              </UFormField>
              <UFormField label="Teléfono de entrega" required :error="errors.shippingPhone">
                <UInput
                  v-model="shippingAddress.phone"
                  type="tel"
                  inputmode="tel"
                  class="w-full"
                  autocomplete="shipping tel"
                />
              </UFormField>
              <UFormField label="Dirección" required :error="errors.shippingLine1">
                <UInput v-model="shippingAddress.line1" class="w-full" autocomplete="shipping address-line1" />
              </UFormField>
              <UFormField label="Piso, puerta, nave…" hint="opcional" class="sm:col-span-2">
                <UInput v-model="shippingAddress.line2" class="w-full" autocomplete="shipping address-line2" />
              </UFormField>
              <UFormField label="Código postal" required :error="errors.shippingPostalCode">
                <UInput
                  v-model="shippingAddress.postalCode"
                  inputmode="numeric"
                  class="w-full"
                  autocomplete="shipping postal-code"
                />
              </UFormField>
              <UFormField label="Población" required :error="errors.shippingCity">
                <UInput v-model="shippingAddress.city" class="w-full" autocomplete="shipping address-level2" />
              </UFormField>
              <UFormField label="Provincia">
                <UInput v-model="shippingAddress.region" class="w-full" autocomplete="shipping address-level1" />
              </UFormField>
              <UFormField label="Notas para el reparto" hint="opcional">
                <UInput v-model="shippingAddress.instructions" placeholder="Horario, muelle de carga…" class="w-full" />
              </UFormField>
            </div>

            <label class="mt-7 flex items-center gap-2 text-sm font-medium text-slate-700">
              <input v-model="billingSameAsShipping" type="checkbox" class="accent-neteco-600" />
              Usar esta dirección también para facturación
            </label>
            <div v-if="!billingSameAsShipping" class="mt-5 border-t border-slate-100 pt-5">
              <h3 class="text-sm font-bold uppercase tracking-wide text-slate-500">Dirección de facturación</h3>
              <div class="mt-4 grid gap-4 grid-cols-1 sm:grid-cols-2">
                <UFormField label="Titular / razón social" required :error="errors.billingRecipientName">
                  <UInput v-model="billingAddress.recipientName" class="w-full" autocomplete="billing name" />
                </UFormField>
                <UFormField label="Empresa" hint="opcional">
                  <UInput v-model="billingAddress.companyName" class="w-full" autocomplete="billing organization" />
                </UFormField>
                <UFormField label="NIF / NIE / CIF" hint="opcional" :error="errors.billingTaxId">
                  <UInput v-model="billingAddress.taxId" class="w-full" />
                </UFormField>
                <UFormField label="Dirección fiscal" required :error="errors.billingLine1">
                  <UInput v-model="billingAddress.line1" class="w-full" autocomplete="billing address-line1" />
                </UFormField>
                <UFormField label="Dirección adicional" hint="opcional" class="sm:col-span-2">
                  <UInput v-model="billingAddress.line2" class="w-full" autocomplete="billing address-line2" />
                </UFormField>
                <UFormField label="Código postal" required :error="errors.billingPostalCode">
                  <UInput
                    v-model="billingAddress.postalCode"
                    inputmode="numeric"
                    class="w-full"
                    autocomplete="billing postal-code"
                  />
                </UFormField>
                <UFormField label="Población" required :error="errors.billingCity">
                  <UInput v-model="billingAddress.city" class="w-full" autocomplete="billing address-level2" />
                </UFormField>
                <UFormField label="Provincia">
                  <UInput v-model="billingAddress.region" class="w-full" autocomplete="billing address-level1" />
                </UFormField>
                <UFormField label="Teléfono" hint="opcional">
                  <UInput v-model="billingAddress.phone" type="tel" class="w-full" autocomplete="billing tel" />
                </UFormField>
              </div>
            </div>
          </section>

          <!-- entrega -->
          <section class="rounded-2xl border border-slate-200 bg-white p-6">
            <h2 class="flex items-center gap-2 text-lg font-bold text-slate-900">
              <span
                class="flex size-7 items-center justify-center rounded-full bg-neteco-600 text-sm font-bold text-white"
                >2</span
              >
              Método de entrega
            </h2>
            <fieldset class="mt-5 space-y-2">
              <legend class="sr-only">Selecciona el método de entrega</legend>
              <label
                v-for="m in eligibleShippingMethods"
                :key="m.value"
                class="flex cursor-pointer items-center justify-between gap-3 rounded-xl border-2 px-4 py-3 transition"
                :class="
                  shippingMethod === m.value
                    ? 'border-neteco-500 ring-1 ring-neteco-500'
                    : 'border-slate-200 hover:border-neteco-300'
                "
              >
                <span class="flex items-center gap-3">
                  <input v-model="shippingMethod" type="radio" :value="m.value" class="accent-neteco-500" />
                  <span>
                    <span class="block font-medium text-slate-800">{{ m.label }}</span>
                    <span class="block text-xs text-slate-500">
                      {{ methodRate(m.value)?.label ?? m.desc }}
                      <template v-if="!methodRate(m.value) && m.value === 'envio' && freeShipping.label.value">
                        · {{ freeShipping.label.value.toLowerCase() }}
                      </template>
                      <template v-if="methodRate(m.value)?.estimatedDeliveryTo">
                        <template v-if="methodRate(m.value)!.etaStatus === 'estimated'"
                          >· estimado {{ methodRate(m.value)!.estimatedDeliveryTo!.split('-').reverse().join('/') }} (no
                          garantizado)</template
                        >
                        <template v-else
                          >· antes del
                          {{
                            new Date(methodRate(m.value)!.estimatedDeliveryTo!).toLocaleDateString('es-ES')
                          }}</template
                        >
                      </template>
                      <template v-else-if="runtime.public.serverRuntime === 'cloudflare' && methodRate(m.value)">
                        <template v-if="methodRate(m.value)!.etaReason === 'lead_time_unknown'"
                          >· plazo de disponibilidad pendiente</template
                        >
                        <template v-else-if="methodRate(m.value)!.etaReason === 'no_operating_window'"
                          >· sin ventana operativa estimable</template
                        >
                        <template v-else>· pendiente de calendario operativo</template>
                      </template>
                    </span>
                  </span>
                </span>
                <span class="font-semibold text-slate-800">
                  <template v-if="methodRate(m.value)">
                    {{
                      methodRate(m.value)!.netCents
                        ? formatPrice(
                            methodRate(m.value)!.netCents +
                              Math.round(
                                (methodRate(m.value)!.netCents * methodRate(m.value)!.taxRateBasisPoints) / 10_000
                              )
                          )
                        : 'Gratis'
                    }}
                  </template>
                  <template v-else>Por calcular</template>
                </span>
              </label>
            </fieldset>
            <p v-if="shippingRateLoading" role="status" aria-live="polite" class="mt-3 text-sm text-slate-500">
              Calculando disponibilidad y fecha…
            </p>
            <p v-if="shippingRateError" role="alert" class="mt-3 text-sm text-red-700">{{ shippingRateError }}</p>
          </section>

          <!-- pago -->
          <section id="sec-pago" class="scroll-mt-40 rounded-2xl border border-slate-200 bg-white p-6">
            <h2 class="flex items-center gap-2 text-lg font-bold text-slate-900">
              <span
                class="flex size-7 items-center justify-center rounded-full bg-neteco-600 text-sm font-bold text-white"
                >3</span
              >
              Pago
            </h2>
            <fieldset class="mt-5 space-y-2">
              <legend class="sr-only">Selecciona el método de pago</legend>
              <label
                class="flex cursor-pointer items-center gap-3 rounded-xl border-2 px-4 py-3 transition"
                :class="
                  paymentMethod === 'tarjeta'
                    ? 'border-neteco-500 ring-1 ring-neteco-500'
                    : 'border-slate-200 hover:border-neteco-300'
                "
              >
                <input v-model="paymentMethod" type="radio" value="tarjeta" class="accent-neteco-500" />
                <UIcon name="i-lucide-credit-card" class="size-5 text-slate-500" />
                <span class="font-medium text-slate-800">Tarjeta de crédito / débito</span>
              </label>
              <div v-if="paymentMethod === 'tarjeta'" class="ml-2 rounded-xl bg-slate-50 p-4 text-sm text-slate-600">
                <UIcon name="i-lucide-shield-check" class="mr-1 inline size-4 text-emerald-600" />
                Introducirás la tarjeta y completarás la autenticación bancaria en la página segura de Redsys. NETECO no
                recibe ni almacena el número de tarjeta ni el CVC.
              </div>

              <label
                class="flex cursor-pointer items-center gap-3 rounded-xl border-2 px-4 py-3 transition"
                :class="
                  paymentMethod === 'bizum'
                    ? 'border-neteco-500 ring-1 ring-neteco-500'
                    : 'border-slate-200 hover:border-neteco-300'
                "
              >
                <input v-model="paymentMethod" type="radio" value="bizum" class="accent-neteco-500" />
                <UIcon name="i-lucide-smartphone" class="size-5 text-slate-500" />
                <span class="font-medium text-slate-800">Bizum</span>
              </label>
              <div v-if="paymentMethod === 'bizum'" class="ml-2 rounded-xl bg-slate-50 p-4 text-sm text-slate-600">
                Te enviaremos a Redsys para autorizar el pago con Bizum de forma segura.
              </div>

              <label
                v-if="runtime.public.bankTransferEnabled && !cloudflareCheckout"
                class="flex cursor-pointer items-center gap-3 rounded-xl border-2 px-4 py-3 transition"
                :class="
                  paymentMethod === 'transferencia'
                    ? 'border-neteco-500 ring-1 ring-neteco-500'
                    : 'border-slate-200 hover:border-neteco-300'
                "
              >
                <input v-model="paymentMethod" type="radio" value="transferencia" class="accent-neteco-500" />
                <UIcon name="i-lucide-landmark" class="size-5 text-slate-500" />
                <span>
                  <span class="block font-medium text-slate-800">Transferencia bancaria</span>
                  <span class="block text-xs text-slate-500">El pedido se prepara al recibir el ingreso</span>
                </span>
              </label>
            </fieldset>
          </section>
        </div>

        <!-- resumen lateral -->
        <aside class="sticky top-40 rounded-2xl border border-slate-200 bg-white p-6">
          <div class="flex items-baseline justify-between">
            <h2 class="text-lg font-bold text-slate-900">Tu pedido</h2>
            <NuxtLink to="/carrito" class="text-sm font-medium text-neteco-600 hover:text-neteco-500">Editar</NuxtLink>
          </div>
          <ul class="mt-4 max-h-64 space-y-3 overflow-y-auto pr-1">
            <li v-for="item in cart.items" :key="item.variantId" class="flex items-center gap-3">
              <div class="w-10 shrink-0"><ProductImage :product="item" /></div>
              <div class="min-w-0 flex-1">
                <p class="truncate text-sm text-slate-700">{{ item.name }}</p>
                <p class="text-xs text-slate-500">{{ item.format }} × {{ item.qty }}</p>
              </div>
              <p class="text-right text-sm font-semibold">
                {{ formatPrice(showNetPrices ? (item.lineNet ?? item.netPrice * item.qty) : item.price * item.qty) }}
                <span v-if="showNetPrices" class="block text-xs font-normal text-slate-500">
                  {{ formatPrice(item.price * item.qty) }} con IVA
                </span>
              </p>
            </li>
          </ul>
          <section
            v-if="couponRuntime"
            class="mt-4 border-t border-slate-100 pt-4"
            aria-labelledby="checkout-coupon-label"
          >
            <label
              id="checkout-coupon-label"
              for="checkout-coupon-code"
              class="block text-sm font-medium text-slate-700"
              >Código de descuento</label
            >
            <input
              id="checkout-coupon-code"
              v-model="couponDraft"
              data-testid="checkout-coupon-code"
              type="text"
              maxlength="64"
              autocomplete="off"
              :disabled="couponLocked"
              class="mt-2 w-full min-w-0 rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:opacity-60"
              @keydown.enter.prevent="applyCoupon"
            />
            <div class="mt-2 flex flex-wrap gap-2">
              <UButton
                type="button"
                data-testid="checkout-coupon-apply"
                :disabled="couponLocked || !couponDraft.trim()"
                @click="applyCoupon"
                >Aplicar</UButton
              >
              <UButton
                type="button"
                data-testid="checkout-coupon-remove"
                variant="outline"
                :disabled="couponLocked || (!couponCode && !couponDraft.trim())"
                @click="removeCoupon"
                >Quitar</UButton
              >
            </div>
            <p
              v-if="couponFeedback"
              data-testid="checkout-coupon-feedback"
              :role="couponError ? 'alert' : 'status'"
              class="mt-2 text-sm text-slate-700"
            >
              {{ couponFeedback }}
            </p>
          </section>
          <dl class="mt-4 space-y-2 border-t border-slate-100 pt-4 text-sm">
            <div class="flex justify-between">
              <dt class="text-slate-500">
                {{
                  promotion?.applied
                    ? showNetPrices
                      ? 'Subtotal neto (descuento incluido)'
                      : 'Productos (descuento incluido)'
                    : showNetPrices
                      ? 'Subtotal neto'
                      : 'Subtotal'
                }}
              </dt>
              <dd data-testid="checkout-subtotal">
                {{
                  formatPrice(
                    showNetPrices
                      ? (selectedShippingRate?.subtotalNetCents ?? cart.subtotalNet)
                      : promotion?.applied && selectedShippingRate
                        ? selectedShippingRate.totalGrossCents - shippingCost
                        : cart.subtotal
                  )
                }}
              </dd>
            </div>
            <div
              v-if="promotion?.applied"
              class="flex justify-between gap-3 text-sm"
              data-testid="checkout-coupon-discount"
            >
              <dt>
                Descuento aplicado (IVA incluido)<span class="block text-xs text-slate-500"
                  >Ya incluido en el total</span
                >
              </dt>
              <dd class="shrink-0">{{ formatPrice(promotion.discountGrossCents) }}</dd>
            </div>
            <div class="flex justify-between gap-3">
              <dt class="min-w-0 truncate text-slate-500">
                Envío · {{ SHIPPING_METHODS.find((m) => m.value === shippingMethod)?.label }}
              </dt>
              <dd class="shrink-0">
                {{ selectedShippingRate ? (shippingCost ? formatPrice(shippingCost) : 'Gratis') : 'Por calcular' }}
              </dd>
            </div>
            <div class="flex justify-between text-xs text-slate-500">
              <dt>IVA incluido según producto y servicio</dt>
              <dd>{{ formatPrice(tax) }}</dd>
            </div>
            <div class="flex justify-between border-t border-slate-100 pt-3">
              <dt class="text-base font-semibold">Total</dt>
              <dd data-testid="checkout-total" class="text-xl font-bold">{{ formatPrice(total) }}</dd>
            </div>
          </dl>

          <label class="mt-4 flex items-start gap-2 text-xs text-slate-600">
            <input v-model="acceptTerms" type="checkbox" class="mt-0.5 accent-neteco-600" />
            <span>
              Acepto las
              <a
                :href="runtime.public.legalTermsUrl"
                target="_blank"
                rel="noopener"
                class="underline hover:text-neteco-600"
                >condiciones de compra</a
              >. La
              <a
                :href="runtime.public.privacyUrl"
                target="_blank"
                rel="noopener"
                class="underline hover:text-neteco-600"
                >información de privacidad</a
              >
              explica cómo tratamos los datos necesarios para tramitar el pedido.
            </span>
          </label>
          <p v-if="errors.terms" class="mt-1.5 text-xs font-medium text-red-600">{{ errors.terms }}</p>

          <label v-if="!cloudflareCheckout" class="mt-3 flex items-start gap-2 text-xs text-slate-500">
            <input v-model="marketingConsent" type="checkbox" class="mt-0.5 accent-neteco-600" />
            <span>{{ NEWSLETTER_CONSENT_TEXT }} {{ NEWSLETTER_CONFIRMATION_NOTICE }}</span>
          </label>
          <p v-else class="mt-3 text-xs text-slate-500">
            La suscripción a la newsletter no está disponible en este proceso de pago.
          </p>

          <div v-if="errorMsg" id="checkout-alert" role="alert" class="mt-4 scroll-mt-40">
            <UAlert color="error" variant="subtle" icon="i-lucide-alert-circle" :title="errorMsg" />
          </div>

          <p v-if="checkoutCommand" class="mt-4 text-sm text-slate-600">
            Conservamos los datos y el método de pago del intento original. Los cambios del formulario no lo sustituyen.
          </p>
          <UButton
            v-if="uncertainOrder"
            type="button"
            size="xl"
            block
            class="mt-4"
            :loading="checkingOrder"
            :disabled="submitting"
            @click="recoverSubmittedOrder"
          >
            Comprobar pedido
          </UButton>
          <UButton
            type="submit"
            size="xl"
            block
            class="mt-4"
            :loading="submitting"
            :disabled="uncertainOrder || checkingOrder || cart.pendingMutation"
            icon="i-lucide-lock"
          >
            {{
              pendingOrder
                ? 'Reintentar el pago del pedido original'
                : paymentMethod === 'transferencia'
                  ? 'Confirmar pedido'
                  : `Pagar ${formatPrice(total)}`
            }}
          </UButton>
          <!-- La confianza se pone donde está la duda: el momento anterior a introducir la
               tarjeta. Tres hechos verificables, no adornos: quién cobra, qué documento
               recibe y con quién habla si algo va mal. -->
          <ul class="mt-4 space-y-2 border-t border-[var(--border)] pt-4 text-xs text-[var(--text-muted)]">
            <li class="flex items-start gap-2">
              <UIcon name="i-lucide-shield-check" class="mt-px size-4 shrink-0 text-neteco-600" />
              El pago se hace en la pasarela del banco. NETECO no ve ni guarda tu tarjeta.
            </li>
            <li class="flex items-start gap-2">
              <UIcon name="i-lucide-file-text" class="mt-px size-4 shrink-0 text-neteco-600" />
              Recibirás la factura con tus datos fiscales por email.
            </li>
            <li class="flex items-start gap-2">
              <UIcon name="i-lucide-phone" class="mt-px size-4 shrink-0 text-neteco-600" />
              600 861 334 · atención directa de lunes a viernes.
            </li>
          </ul>
        </aside>
      </form>

      <div v-else class="py-20 text-center">
        <UIcon name="i-lucide-shopping-cart" class="mx-auto size-14 text-slate-300" />
        <p class="mt-4 text-lg font-medium text-slate-600">Tu carrito está vacío</p>
        <p class="mt-1 text-sm text-slate-500">Añade productos del catálogo para tramitar tu pedido.</p>
        <UButton to="/catalogo" size="lg" class="mt-6" icon="i-lucide-layout-grid">Ver el catálogo</UButton>
      </div>

      <template #fallback>
        <div class="mt-6 grid grid-cols-1 items-start gap-8 lg:grid-cols-3">
          <div class="min-w-0 space-y-6 lg:col-span-2">
            <div
              v-for="n in 3"
              :key="n"
              class="h-40 animate-pulse rounded-[var(--radius-panel)] bg-[var(--surface-sunken)]"
            />
          </div>
          <div class="h-96 animate-pulse rounded-[var(--radius-panel)] bg-[var(--surface-sunken)]" />
        </div>
      </template>
    </ClientOnly>
  </div>
</template>
