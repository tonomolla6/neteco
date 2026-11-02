<script setup lang="ts">
import { z } from 'zod'
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
const { ready, loggedIn, user, session } = useUserSession()
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
const CHECKOUT_COUNTRIES = [
  { code: 'ES', label: 'España (ES)' },
  { code: 'PT', label: 'Portugal (PT)' },
  { code: 'FR', label: 'Francia (FR)' },
  { code: 'DE', label: 'Alemania (DE)' },
  { code: 'IT', label: 'Italia (IT)' },
  { code: 'GB', label: 'Reino Unido (GB)' },
  { code: 'CH', label: 'Suiza (CH)' }
] as const

const shippingAddress = reactive({
  recipientName: '',
  companyName: '',
  taxId: '',
  line1: '',
  line2: '',
  postalCode: '',
  city: '',
  region: 'Valencia',
  countryCode: 'ES' as string,
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
  countryCode: 'ES' as string,
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

function isValidPostalCode(value: string, countryCode: string) {
  const trimmed = value.trim()
  if (countryCode === 'ES') return /^\d{5}$/.test(trimmed)
  return /^[A-Za-z0-9][A-Za-z0-9 -]{1,14}$/.test(trimmed)
}

const shippingRateReady = computed(
  () =>
    isValidPostalCode(shippingAddress.postalCode, shippingAddress.countryCode) &&
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

// CHK-023: Market / destination country checkout profile & presentment calculation
const checkoutMarketProfileSchema = z
  .object({
    market: z.string().regex(/^[A-Z]{2}$/),
    currency: z.string().regex(/^[A-Z]{3}$/),
    version: z.number().int().positive(),
    exchangeNumerator: z.number().int().positive(),
    exchangeDenominator: z.number().int().positive(),
    goodsTaxBps: z.number().int().min(0).max(5000),
    shippingNetMinor: z.number().int().nonnegative(),
    shippingTaxBps: z.number().int().min(0).max(5000),
    termsVersion: z.string().min(1).max(64),
    paymentMethods: z.array(z.enum(['card', 'credit', 'bank_transfer'])).min(1)
  })
  .strict()
type CheckoutMarketProfile = z.infer<typeof checkoutMarketProfileSchema>
const marketProfile = ref<CheckoutMarketProfile | null>(null)
const marketProfileLoading = ref(false)
const marketProfileError = ref('')
let marketProfileReadGeneration = 0
const isInternationalMarket = computed(() => shippingAddress.countryCode !== 'ES')

function roundMarketMinor(amount: bigint, num: number, den: number): bigint {
  return (amount * BigInt(num) + BigInt(Math.floor(den / 2))) / BigInt(den)
}

const marketPresentment = computed(() => {
  const profile = marketProfile.value
  if (!isInternationalMarket.value || !profile) return null
  const goodsNetEurMinor = selectedShippingRate.value?.subtotalNetCents ?? cart.subtotalNet
  const goodsNetMinor = roundMarketMinor(
    BigInt(goodsNetEurMinor),
    profile.exchangeNumerator,
    profile.exchangeDenominator
  )
  const goodsTaxMinor = roundMarketMinor(goodsNetMinor, profile.goodsTaxBps, 10_000)
  const shippingNetMinor = BigInt(profile.shippingNetMinor)
  const shippingTaxMinor = roundMarketMinor(shippingNetMinor, profile.shippingTaxBps, 10_000)
  const shippingGrossMinor = Number(shippingNetMinor + shippingTaxMinor)
  const taxMinor = Number(goodsTaxMinor + shippingTaxMinor)
  const totalMinor = Number(goodsNetMinor + goodsTaxMinor + shippingNetMinor + shippingTaxMinor)
  return {
    currency: profile.currency,
    goodsNetMinor: Number(goodsNetMinor),
    goodsTaxMinor: Number(goodsTaxMinor),
    shippingNetMinor: Number(shippingNetMinor),
    shippingTaxMinor: Number(shippingTaxMinor),
    shippingGrossMinor,
    taxMinor,
    totalMinor
  }
})

function formatMarketCurrency(cents: number, currency: string) {
  return new Intl.NumberFormat('es-ES', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2
  }).format(cents / 100)
}

async function loadMarketProfile(countryCode: string) {
  const generation = ++marketProfileReadGeneration
  marketProfile.value = null
  marketProfileError.value = ''
  if (countryCode === 'ES' || runtime.public.serverRuntime !== 'cloudflare') {
    marketProfileLoading.value = false
    return
  }
  marketProfileLoading.value = true
  try {
    const raw = await $fetch(`/api/checkout-markets/${encodeURIComponent(countryCode)}`, {
      method: 'GET',
      retry: 0,
      cache: 'no-store'
    })
    const parsed = checkoutMarketProfileSchema.parse(raw)
    if (generation !== marketProfileReadGeneration) return
    marketProfile.value = parsed
    if (
      paymentMethod.value === 'transferencia' &&
      !parsed.paymentMethods.includes('credit') &&
      !parsed.paymentMethods.includes('bank_transfer')
    ) {
      paymentMethod.value = 'tarjeta'
    }
  } catch {
    if (generation !== marketProfileReadGeneration) return
    marketProfile.value = null
    marketProfileError.value =
      'No hemos podido cargar las condiciones fiscales y de envío para este país de destino. Selecciona España o inténtalo más tarde.'
  } finally {
    if (generation === marketProfileReadGeneration) marketProfileLoading.value = false
  }
}

watch(
  () => shippingAddress.countryCode,
  (countryCode) => {
    if (billingSameAsShipping.value) billingAddress.countryCode = countryCode
    if (countryCode !== 'ES' && paymentMethod.value === 'bizum' && !checkoutCommand.value) {
      paymentMethod.value = 'tarjeta'
    }
    void loadMarketProfile(countryCode)
  },
  { flush: 'sync' }
)

// PAY-019: Apple Pay / Google Pay capabilities & state
const walletCapabilitiesSchema = z
  .object({
    wallets: z
      .object({
        apple_pay: z.boolean(),
        google_pay: z.boolean()
      })
      .strict(),
    fallback: z.literal('redirect')
  })
  .strict()
const walletCapabilities = ref<{ apple_pay: boolean; google_pay: boolean }>({
  apple_pay: false,
  google_pay: false
})
const walletDeviceAvailable = ref(true)
const selectedWallet = ref<'apple_pay' | 'google_pay' | null>(null)
const walletFallbackNotice = ref('')
let walletCapabilitiesGeneration = 0

async function loadWalletCapabilities() {
  const generation = ++walletCapabilitiesGeneration
  walletCapabilities.value = { apple_pay: false, google_pay: false }
  if (runtime.public.serverRuntime !== 'cloudflare') return
  try {
    const raw = await $fetch('/api/payments/wallet-capabilities', {
      method: 'GET',
      retry: 0,
      cache: 'no-store'
    })
    const parsed = walletCapabilitiesSchema.parse(raw)
    if (generation === walletCapabilitiesGeneration) {
      walletCapabilities.value = parsed.wallets
    }
  } catch {
    if (generation === walletCapabilitiesGeneration) {
      walletCapabilities.value = { apple_pay: false, google_pay: false }
    }
  }
}

watch(
  () => runtime.public.serverRuntime,
  () => {
    void loadWalletCapabilities()
  },
  { immediate: true, flush: 'sync' }
)

// PAY-022: Explicit card saving consent, one-click tokens & revocation link
const savedCardsAvailabilitySchema = z
  .object({
    available: z.boolean(),
    consentVersion: z.string().min(1)
  })
  .strict()
const savedPaymentTokenSchema = z
  .object({
    id: z.string().uuid(),
    status: z.enum(['active', 'revoked']),
    version: z.number().int().positive(),
    createdAt: z.string()
  })
  .strict()
const savedPaymentTokensResponseSchema = z
  .object({
    tokens: z.array(savedPaymentTokenSchema),
    pending: z.array(z.unknown())
  })
  .strict()
const oneClickResponseSchema = z
  .object({
    orderId: z.string().uuid(),
    paymentIntentId: z.string(),
    amountCents: z.number().int().positive(),
    outcome: z.enum(['paid', 'declined', 'pending', 'review'])
  })
  .strict()
type SavedPaymentToken = z.infer<typeof savedPaymentTokenSchema>
const savedCardsAvailable = ref(false)
const savedCardsConsentVersion = ref('')
const savedCardsLoading = ref(false)
const savedCardsError = ref('')
const savedPaymentTokens = ref<SavedPaymentToken[]>([])
const saveCardConsent = ref(false)
const selectedSavedTokenId = ref<string | null>(null)
let savedCardsGeneration = 0

async function loadSavedCards() {
  const generation = ++savedCardsGeneration
  savedCardsAvailable.value = false
  savedCardsConsentVersion.value = ''
  savedPaymentTokens.value = []
  saveCardConsent.value = false
  selectedSavedTokenId.value = null
  savedCardsError.value = ''
  if (
    runtime.public.serverRuntime !== 'cloudflare' ||
    ready?.value !== true ||
    loggedIn.value !== true ||
    user.value?.emailVerified !== true ||
    !z.string().uuid().safeParse(user.value?.id).success ||
    !z.string().uuid().safeParse(session?.value?.sessionId).success ||
    !Number.isSafeInteger(session?.value?.sessionVersion) ||
    Number(session?.value?.sessionVersion) < 1
  ) {
    savedCardsLoading.value = false
    return
  }
  savedCardsLoading.value = true
  try {
    const availRaw = await $fetch('/api/account/saved-cards/availability', {
      method: 'GET',
      retry: 0,
      cache: 'no-store'
    })
    const avail = savedCardsAvailabilitySchema.parse(availRaw)
    if (generation !== savedCardsGeneration) return
    savedCardsAvailable.value = avail.available
    savedCardsConsentVersion.value = avail.consentVersion
    if (!avail.available) return
    const tokensRaw = await $fetch('/api/account/payment-tokens', {
      method: 'GET',
      retry: 0,
      cache: 'no-store'
    })
    const parsedTokens = savedPaymentTokensResponseSchema.parse(tokensRaw)
    if (generation !== savedCardsGeneration) return
    savedPaymentTokens.value = parsedTokens.tokens.filter((token) => token.status === 'active')
  } catch {
    if (generation !== savedCardsGeneration) return
    savedCardsAvailable.value = false
    savedPaymentTokens.value = []
  } finally {
    if (generation === savedCardsGeneration) savedCardsLoading.value = false
  }
}

const creditTermsSchema = z
  .object({
    terms: z
      .object({
        companyStatus: z.string(),
        paymentDays: z.number().int().nullable(),
        blocked: z.boolean(),
        availableCents: z.number().int().safe().nonnegative()
      })
      .passthrough()
      .nullable()
  })
  .strict()
const creditTerms = ref<z.infer<typeof creditTermsSchema>['terms']>(null)
let creditReadGeneration = 0
const creditEligible = computed(
  () =>
    !!creditTerms.value &&
    creditTerms.value.companyStatus === 'approved' &&
    !creditTerms.value.blocked &&
    [15, 30, 60].includes(creditTerms.value.paymentDays ?? 0) &&
    creditTerms.value.availableCents > 0
)
watch(
  () => [
    runtime.public.serverRuntime,
    ready?.value,
    loggedIn.value,
    user.value?.id,
    user.value?.emailVerified,
    session?.value?.sessionId,
    session?.value?.sessionVersion
  ],
  async () => {
    void loadSavedCards()
    const generation = ++creditReadGeneration
    creditTerms.value = null
    if (
      runtime.public.serverRuntime !== 'cloudflare' ||
      ready?.value !== true ||
      loggedIn.value !== true ||
      user.value?.emailVerified !== true ||
      !z.string().uuid().safeParse(user.value?.id).success ||
      !z.string().uuid().safeParse(session?.value?.sessionId).success ||
      !Number.isSafeInteger(session?.value?.sessionVersion) ||
      Number(session?.value?.sessionVersion) < 1
    )
      return
    try {
      const parsed = creditTermsSchema.parse(
        await $fetch('/api/account/b2b', { method: 'GET', retry: 0, cache: 'no-store' })
      )
      if (generation === creditReadGeneration) creditTerms.value = parsed.terms
    } catch {
      if (generation === creditReadGeneration) creditTerms.value = null
    }
  },
  { immediate: true, flush: 'sync' }
)
watch(cloudflareCheckout, (enabled) => {
  if (!enabled) return
  if (paymentMethod.value === 'transferencia' && !creditEligible.value) paymentMethod.value = 'tarjeta'
  marketingConsent.value = false
})
watch(creditEligible, (eligible) => {
  if (!eligible && cloudflareCheckout.value && paymentMethod.value === 'transferencia' && !checkoutCommand.value)
    paymentMethod.value = 'tarjeta'
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
  walletMethod?: 'apple_pay' | 'google_pay' | null
  walletDeviceAvailable?: boolean
  saveCardConsent?: boolean
  savedToken?: { id: string; version: number } | null
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
  creditReadGeneration++
  marketProfileReadGeneration++
  walletCapabilitiesGeneration++
  savedCardsGeneration++
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
    purchaseOrderReference,
    saveCardConsent,
    selectedSavedTokenId,
    selectedWallet
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
  if (form.nif.trim() && shippingAddress.countryCode === 'ES' && !isValidTaxId(form.nif))
    errors.nif = 'Revisa el NIF, NIE o CIF'
  if (!shippingAddress.recipientName.trim()) errors.shippingRecipientName = 'Indica el destinatario'
  if (!shippingAddress.phone.trim()) errors.shippingPhone = 'Indica el teléfono de entrega'
  if (!shippingAddress.line1.trim()) errors.shippingLine1 = 'Indica la dirección'
  if (!shippingAddress.postalCode.trim()) errors.shippingPostalCode = 'Indica el código postal'
  else if (!isValidPostalCode(shippingAddress.postalCode, shippingAddress.countryCode))
    errors.shippingPostalCode =
      shippingAddress.countryCode === 'ES'
        ? 'El código postal debe tener 5 cifras'
        : 'Revisa el código postal del país seleccionado'
  if (!shippingAddress.city.trim()) errors.shippingCity = 'Indica la población'
  if (!billingSameAsShipping.value) {
    if (!billingAddress.recipientName.trim()) errors.billingRecipientName = 'Indica el titular de facturación'
    if (!billingAddress.line1.trim()) errors.billingLine1 = 'Indica la dirección fiscal'
    if (!billingAddress.postalCode.trim()) errors.billingPostalCode = 'Indica el código postal fiscal'
    else if (!isValidPostalCode(billingAddress.postalCode, billingAddress.countryCode))
      errors.billingPostalCode =
        billingAddress.countryCode === 'ES' ? 'El código postal debe tener 5 cifras' : 'Revisa el código postal fiscal'
    if (!billingAddress.city.trim()) errors.billingCity = 'Indica la población fiscal'
    if (billingAddress.taxId.trim() && billingAddress.countryCode === 'ES' && !isValidTaxId(billingAddress.taxId))
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

async function submitWithWallet(method: 'apple_pay' | 'google_pay') {
  if (submitting.value || checkingOrder.value || uncertainOrder.value) return
  if (!walletCapabilities.value[method]) return
  paymentMethod.value = 'tarjeta'
  selectedWallet.value = method
  selectedSavedTokenId.value = null
  await submit()
}

async function payWithOneClick(token: SavedPaymentToken) {
  if (submitting.value || checkingOrder.value || uncertainOrder.value) return
  paymentMethod.value = 'tarjeta'
  selectedSavedTokenId.value = token.id
  selectedWallet.value = null
  saveCardConsent.value = false
  await submit()
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
  if (!pendingOrder.value && isInternationalMarket.value && (marketProfileLoading.value || !marketProfile.value)) {
    errorMsg.value =
      marketProfileError.value ||
      'No hemos podido verificar el perfil de checkout del país seleccionado. Espera o selecciona otro destino.'
    scrollTo('checkout-alert', 'center')
    return
  }
  submitting.value = true
  errorMsg.value = ''
  walletFallbackNotice.value = ''
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
      const cloudflare = isCloudflareRate(rate)
      const activeMarket = isInternationalMarket.value && marketProfile.value ? marketProfile.value : null
      const expectedTotal = marketPresentment.value ? marketPresentment.value.totalMinor : rate.totalGrossCents
      const activeSavedToken = selectedSavedTokenId.value
        ? (savedPaymentTokens.value.find((t) => t.id === selectedSavedTokenId.value) ?? null)
        : null
      const common = {
        customer: { ...form },
        shippingAddress: { ...shippingAddress },
        billingAddress: effectiveBillingAddress(),
        expectedTotalGrossCents: expectedTotal,
        paymentMethod: paymentMethod.value,
        cartId: cart.id,
        cartVersion: cart.version,
        termsAccepted: true,
        marketingConsent: marketingConsent.value
      }
      const reference = cloudflare ? normalizedPurchaseOrderReference() : undefined
      checkoutCommand.value = {
        cloudflare,
        paymentMethod: paymentMethod.value,
        paymentKey: checkoutAttempt.paymentKey,
        walletMethod: selectedWallet.value,
        walletDeviceAvailable: walletDeviceAvailable.value,
        saveCardConsent: saveCardConsent.value,
        savedToken: activeSavedToken ? { id: activeSavedToken.id, version: activeSavedToken.version } : null,
        ...(cloudflare ? { headers: { 'Idempotency-Key': checkoutAttempt.idempotencyKey } } : {}),
        body: cloudflare
          ? {
              ...common,
              ...(reference ? { purchaseOrderReference: reference } : {}),
              ...(activeMarket
                ? {
                    marketCheckout: {
                      market: activeMarket.market,
                      version: activeMarket.version,
                      termsVersion: activeMarket.termsVersion
                    }
                  }
                : {}),
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
    const command = checkoutCommand.value!
    const originalPaymentMethod = command.paymentMethod
    if (originalPaymentMethod === 'transferencia') {
      await finish(order)
      return
    }

    const orderAuthHeaders = (idempotencyKey: string): Record<string, string> => ({
      'Idempotency-Key': idempotencyKey,
      ...(order.token ? { Authorization: `Order ${order.token}` } : {})
    })

    // PAY-019: Apple Pay / Google Pay payment intent with automatic fallback to Redirect
    if (order.cloudflare && command.walletMethod) {
      const walletRes = await $fetch<{
        paymentIntentId: string
        status: string
        redirect: { actionUrl: string; method: 'POST'; fields: Record<string, string> }
        wallet: {
          requested: 'apple_pay' | 'google_pay'
          resolved: 'apple_pay' | 'google_pay' | 'redirect'
          fallback: 'redirect'
        }
      }>(`/api/orders/${encodeURIComponent(order.id)}/wallet-payment-intents`, {
        method: 'POST',
        headers: orderAuthHeaders(command.paymentKey),
        body: {
          method: command.walletMethod,
          deviceAvailable: command.walletDeviceAvailable !== false
        }
      })
      if (walletRes.wallet.resolved === 'redirect') {
        walletFallbackNotice.value =
          'El pago con wallet no está disponible en este momento; continuamos en la pasarela segura de redirección.'
      }
      pendingOrder.value = order
      cart.resetLocal()
      submitHostedPayment(walletRes.redirect)
      return
    }

    // PAY-022: One-click payment with an active saved card token
    if (order.cloudflare && command.savedToken) {
      const oneClickRaw = await $fetch<unknown, string>('/api/account/saved-cards/one-click', {
        method: 'POST',
        headers: orderAuthHeaders(command.paymentKey),
        body: {
          tokenId: command.savedToken.id,
          orderId: order.id,
          commandId: command.paymentKey,
          expectedVersion: command.savedToken.version
        }
      })
      const oneClick = oneClickResponseSchema.parse(oneClickRaw)
      if (oneClick.outcome === 'paid') {
        await finish(order)
        return
      }
      if (oneClick.outcome === 'declined') {
        checkoutCommand.value = {
          ...command,
          savedToken: null,
          paymentKey: randomId()
        }
        selectedSavedTokenId.value = null
        errorMsg.value =
          'El cobro con tarjeta guardada ha sido denegado. Puedes reintentar el pago del pedido mediante redirección segura.'
        scrollTo('checkout-alert', 'center')
        return
      }
      errorMsg.value =
        'El pago con tarjeta guardada está en revisión o pendiente de confirmación. Comprueba el estado de tu pedido.'
      await finish(order)
      return
    }

    // PAY-022: Explicit consent to save card during Redirect payment
    if (
      order.cloudflare &&
      originalPaymentMethod === 'tarjeta' &&
      command.saveCardConsent &&
      savedCardsAvailable.value &&
      savedCardsConsentVersion.value
    ) {
      const consentPay = await $fetch<{
        paymentIntentId: string
        status: string
        expiresAt: string
        consentVersion: string
        redirect: { actionUrl: string; method: 'POST'; fields: Record<string, string> }
      }>('/api/account/saved-cards/consent-payments', {
        method: 'POST',
        headers: orderAuthHeaders(command.paymentKey),
        body: {
          orderId: order.id,
          commandId: command.paymentKey,
          consent: true,
          consentVersion: savedCardsConsentVersion.value
        }
      })
      pendingOrder.value = order
      cart.resetLocal()
      submitHostedPayment(consentPay.redirect)
      return
    }

    const pay = await $fetch<{
      ok: boolean
      redirect: { actionUrl: string; method: 'POST'; fields: Record<string, string> } | null
    }>('/api/checkout/pay', {
      method: 'POST',
      ...(order.cloudflare ? { headers: { 'Idempotency-Key': command.paymentKey } } : {}),
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
        ? (
            error as {
              data?: {
                data?: { code?: string; reason?: string }
                code?: string
                reason?: string
                outcome?: string
                error?: { code?: string; message?: string }
              }
            }
          ).data
        : undefined
    const reason = responseData?.reason ?? responseData?.data?.reason
    const quoteChanged =
      responseData?.code === 'CHECKOUT_QUOTE_CHANGED' ||
      responseData?.data?.code === 'CHECKOUT_QUOTE_CHANGED' ||
      responseData?.error?.code === 'CHECKOUT_QUOTE_CHANGED' ||
      responseData?.outcome === 'revalidation_required' ||
      reason === 'market_changed' ||
      reason === 'terms_changed' ||
      reason === 'display_total_changed'
    const failure = error && typeof error === 'object' ? (error as { status?: unknown; statusCode?: unknown }) : null
    const status = Number(failure?.statusCode ?? failure?.status)
    const code = responseData?.error?.code
    // If a saved-card token was revoked or stale after order creation, allow fallback to standard Redirect on retry
    if (
      pendingOrder.value &&
      checkoutCommand.value?.savedToken &&
      (status === 404 || status === 409 || status === 422 || status === 503)
    ) {
      checkoutCommand.value = {
        ...checkoutCommand.value,
        savedToken: null,
        paymentKey: randomId()
      }
      selectedSavedTokenId.value = null
      void loadSavedCards()
      errorMsg.value =
        'La tarjeta guardada ya no está disponible. Puedes completar el pago del pedido mediante redirección segura.'
      scrollTo('checkout-alert', 'center')
      return
    }
    // These exact Cloudflare rejections occur before order/reservation writes.
    // Other failures (including 401 after commit) must retain the original intent.
    const definitiveRejection =
      checkoutCommand.value?.cloudflare &&
      ((status === 409 && (code === 'credit_unavailable' || code === 'credit_limit_exceeded')) ||
        (status === 400 && code === 'invalid_input') ||
        (status === 422 &&
          (code === 'method_unavailable' || code === 'marketing_unavailable' || code === 'payment_total_non_positive')))
    if (definitiveRejection && !pendingOrder.value) {
      checkoutCommand.value = null
      resetUnsubmittedCheckoutKeys()
    }
    if (quoteChanged && !pendingOrder.value) {
      checkoutCommand.value = null
      resetUnsubmittedCheckoutKeys()
      if (isInternationalMarket.value) {
        await loadMarketProfile(shippingAddress.countryCode)
      }
      if (reason === 'terms_changed') {
        acceptTerms.value = false
      }
      await refreshShippingRates()
    }
    errorMsg.value =
      reason === 'terms_changed' && !pendingOrder.value
        ? 'Las condiciones del mercado seleccionado se han actualizado. Revisa y vuelve a aceptar los términos antes de continuar.'
        : (reason === 'market_changed' || reason === 'display_total_changed') && !pendingOrder.value
          ? 'El perfil fiscal o el importe del mercado seleccionado ha cambiado. Revisa el nuevo total antes de confirmar.'
          : definitiveRejection && code === 'credit_limit_exceeded' && !pendingOrder.value
            ? 'El pedido supera tu límite de crédito disponible. Elige otro método de pago o contacta con nosotros.'
            : definitiveRejection && code === 'credit_unavailable' && !pendingOrder.value
              ? 'Tu crédito no está disponible. Elige otro método de pago o contacta con nosotros.'
              : definitiveRejection && code === 'payment_total_non_positive' && !pendingOrder.value
                ? 'El total a pagar debe ser mayor que cero. Quita o ajusta el cupón antes de continuar.'
                : uncertainOrder.value
                  ? 'No hemos podido confirmar si se creó el pedido. Comprueba el pedido antes de volver a pagar; conservamos el intento original.'
                  : apiErrorMessage(
                      error,
                      'No se ha podido crear el pedido. Vuelve a intentarlo o llámanos al 600 861 334.'
                    )
    scrollTo('checkout-alert', 'center')
  } finally {
    submitting.value = false
    if (!checkoutCommand.value) {
      selectedWallet.value = null
      selectedSavedTokenId.value = null
    }
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
      <p
        v-if="walletFallbackNotice"
        data-testid="wallet-fallback-notice"
        role="status"
        aria-live="polite"
        class="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm font-medium text-amber-800"
      >
        {{ walletFallbackNotice }}
      </p>
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
              <div v-if="runtime.public.serverRuntime === 'cloudflare'" class="sm:col-span-2">
                <label for="shipping-country" class="block text-sm font-medium text-slate-700"
                  >País / mercado de destino</label
                >
                <select
                  id="shipping-country"
                  v-model="shippingAddress.countryCode"
                  data-testid="checkout-market-select"
                  :disabled="Boolean(checkoutCommand || pendingOrder || submitting)"
                  class="mt-1.5 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 disabled:opacity-60"
                >
                  <option v-for="c in CHECKOUT_COUNTRIES" :key="c.code" :value="c.code">{{ c.label }}</option>
                </select>
                <p
                  v-if="marketProfileLoading"
                  data-testid="checkout-market-loading"
                  role="status"
                  aria-live="polite"
                  class="mt-2 text-sm text-slate-600"
                >
                  Cargando perfil fiscal y de envío del mercado…
                </p>
                <p
                  v-if="marketProfileError"
                  data-testid="checkout-market-error"
                  role="alert"
                  class="mt-2 text-sm text-red-700"
                >
                  {{ marketProfileError }}
                </p>
                <div
                  v-if="marketProfile && marketPresentment"
                  data-testid="checkout-market-summary"
                  role="region"
                  aria-label="Condiciones del mercado de destino"
                  class="mt-2 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700"
                >
                  <p class="font-semibold text-slate-900">
                    Mercado {{ marketProfile.market }} · Divisa {{ marketProfile.currency }} · Versión v{{
                      marketProfile.version
                    }}
                  </p>
                  <p class="mt-1" data-testid="checkout-market-tax">
                    Impuestos aplicables ({{ (marketProfile.goodsTaxBps / 100).toFixed(2) }}%):
                    {{ formatMarketCurrency(marketPresentment.goodsTaxMinor, marketPresentment.currency) }}
                  </p>
                  <p class="mt-0.5" data-testid="checkout-market-shipping">
                    Envío internacional ({{ (marketProfile.shippingTaxBps / 100).toFixed(2) }}% imp. incl.):
                    {{ formatMarketCurrency(marketPresentment.shippingGrossMinor, marketPresentment.currency) }}
                  </p>
                  <p class="mt-0.5" data-testid="checkout-market-terms">
                    Versión de términos del mercado: <span class="font-mono">{{ marketProfile.termsVersion }}</span>
                  </p>
                  <p class="mt-1 font-semibold text-slate-900" data-testid="checkout-market-total">
                    Total en divisa de destino:
                    {{ formatMarketCurrency(marketPresentment.totalMinor, marketPresentment.currency) }}
                  </p>
                </div>
              </div>
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
              <div
                v-if="paymentMethod === 'tarjeta'"
                class="ml-2 space-y-3 rounded-xl bg-slate-50 p-4 text-sm text-slate-600"
              >
                <p>
                  <UIcon name="i-lucide-shield-check" class="mr-1 inline size-4 text-emerald-600" />
                  Introducirás la tarjeta y completarás la autenticación bancaria en la página segura de Redsys. NETECO
                  no recibe ni almacena el número de tarjeta ni el CVC.
                </p>

                <!-- PAY-022: Tarjetas guardadas elegibles para pago en un clic y consentimiento explícito -->
                <div
                  v-if="savedCardsAvailable"
                  class="space-y-3 border-t border-slate-200 pt-3"
                  data-testid="saved-cards-section"
                >
                  <div v-if="savedPaymentTokens.length" class="space-y-2" data-testid="saved-cards-list">
                    <p class="text-xs font-semibold uppercase tracking-wide text-slate-700">
                      Tarjetas guardadas para pago rápido
                    </p>
                    <div
                      v-for="token in savedPaymentTokens"
                      :key="token.id"
                      class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-800"
                    >
                      <span>
                        Referencia guardada <span class="font-mono">{{ token.id.slice(0, 8) }}</span> (v{{
                          token.version
                        }})
                      </span>
                      <UButton
                        type="button"
                        size="xs"
                        :data-testid="`one-click-pay-${token.id}`"
                        :loading="submitting && selectedSavedTokenId === token.id"
                        :disabled="submitting || uncertainOrder || checkingOrder || cart.pendingMutation"
                        @click="payWithOneClick(token)"
                      >
                        Pagar en 1 clic
                      </UButton>
                    </div>
                  </div>

                  <label class="flex items-start gap-2 text-xs text-slate-700">
                    <input
                      v-model="saveCardConsent"
                      type="checkbox"
                      data-testid="save-card-consent"
                      :disabled="Boolean(checkoutCommand || pendingOrder || submitting)"
                      class="mt-0.5 accent-neteco-600"
                    />
                    <span>
                      Autorizo guardar una referencia tokenizada de mi tarjeta tras este pago para futuras compras en un
                      clic (versión <span class="font-mono">{{ savedCardsConsentVersion }}</span
                      >). No almacenamos PAN ni CVV.
                    </span>
                  </label>

                  <p class="text-xs text-slate-600">
                    Puedes consultar o revocar tus tarjetas guardadas en cualquier momento desde
                    <a
                      href="/cuenta/metodos-de-pago"
                      data-testid="revoke-saved-card-link"
                      class="font-medium text-neteco-700 underline hover:text-neteco-600"
                      >Mis métodos de pago</a
                    >.
                  </p>
                </div>

                <!-- PAY-019: Apple Pay / Google Pay solo cuando capabilities lo habilitan -->
                <div
                  v-if="walletCapabilities.apple_pay || walletCapabilities.google_pay"
                  class="space-y-2 border-t border-slate-200 pt-3"
                  data-testid="wallet-payment-options"
                >
                  <p class="text-xs font-semibold uppercase tracking-wide text-slate-700">Pago rápido con wallet</p>
                  <div class="flex flex-wrap gap-2">
                    <UButton
                      v-if="walletCapabilities.apple_pay"
                      type="button"
                      variant="outline"
                      data-testid="wallet-pay-apple_pay"
                      :loading="submitting && selectedWallet === 'apple_pay'"
                      :disabled="submitting || uncertainOrder || checkingOrder || cart.pendingMutation"
                      @click="submitWithWallet('apple_pay')"
                    >
                      Pagar con Apple Pay
                    </UButton>
                    <UButton
                      v-if="walletCapabilities.google_pay"
                      type="button"
                      variant="outline"
                      data-testid="wallet-pay-google_pay"
                      :loading="submitting && selectedWallet === 'google_pay'"
                      :disabled="submitting || uncertainOrder || checkingOrder || cart.pendingMutation"
                      @click="submitWithWallet('google_pay')"
                    >
                      Pagar con Google Pay
                    </UButton>
                  </div>
                </div>
              </div>

              <label
                v-if="!isInternationalMarket"
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
              <div
                v-if="!isInternationalMarket && paymentMethod === 'bizum'"
                class="ml-2 rounded-xl bg-slate-50 p-4 text-sm text-slate-600"
              >
                Te enviaremos a Redsys para autorizar el pago con Bizum de forma segura.
              </div>

              <label
                v-if="
                  ((runtime.public.bankTransferEnabled && !cloudflareCheckout) ||
                    (cloudflareCheckout && creditEligible)) &&
                  (!isInternationalMarket ||
                    marketProfile?.paymentMethods.includes('credit') ||
                    marketProfile?.paymentMethods.includes('bank_transfer'))
                "
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
                  <span class="block text-xs text-slate-500">{{
                    cloudflareCheckout
                      ? `Transferencia a ${creditTerms?.paymentDays} días`
                      : 'El pedido se prepara al recibir el ingreso'
                  }}</span>
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
                <template v-if="marketPresentment">
                  {{ formatMarketCurrency(marketPresentment.shippingGrossMinor, marketPresentment.currency) }}
                </template>
                <template v-else>
                  {{ selectedShippingRate ? (shippingCost ? formatPrice(shippingCost) : 'Gratis') : 'Por calcular' }}
                </template>
              </dd>
            </div>
            <div class="flex justify-between text-xs text-slate-500">
              <dt>IVA incluido según producto y servicio</dt>
              <dd>
                <template v-if="marketPresentment">
                  {{ formatMarketCurrency(marketPresentment.taxMinor, marketPresentment.currency) }}
                </template>
                <template v-else>{{ formatPrice(tax) }}</template>
              </dd>
            </div>
            <div class="flex justify-between border-t border-slate-100 pt-3">
              <dt class="text-base font-semibold">Total</dt>
              <dd data-testid="checkout-total" class="text-xl font-bold">
                <template v-if="marketPresentment">
                  {{ formatMarketCurrency(marketPresentment.totalMinor, marketPresentment.currency) }}
                </template>
                <template v-else>{{ formatPrice(total) }}</template>
              </dd>
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
            :disabled="
              uncertainOrder ||
              checkingOrder ||
              cart.pendingMutation ||
              (isInternationalMarket && (marketProfileLoading || !marketProfile))
            "
            icon="i-lucide-lock"
          >
            {{
              pendingOrder
                ? 'Reintentar el pago del pedido original'
                : paymentMethod === 'transferencia'
                  ? 'Confirmar pedido'
                  : marketPresentment
                    ? `Pagar ${formatMarketCurrency(marketPresentment.totalMinor, marketPresentment.currency)}`
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
