<script setup lang="ts">
import type { Address } from '~/composables/useAccount'
import { z } from 'zod'
import CartRecoverySection from '~/components/CartRecoverySection.vue'
import { useCartStore } from '~/stores/cart'
import CartReadFeedback from '~/components/CartReadFeedback.vue'
import CheckoutAddressFields from '~/components/checkout/CheckoutAddressFields.vue'
import CheckoutBillingAddress from '~/components/checkout/CheckoutBillingAddress.vue'
import CheckoutContactFields from '~/components/checkout/CheckoutContactFields.vue'
import CheckoutCoupon from '~/components/checkout/CheckoutCoupon.vue'
import CheckoutDeliveryMethods from '~/components/checkout/CheckoutDeliveryMethods.vue'
import CheckoutInvoiceChoice from '~/components/checkout/CheckoutInvoiceChoice.vue'
import CheckoutMarketSummary from '~/components/checkout/CheckoutMarketSummary.vue'
import CheckoutPaymentMethods from '~/components/checkout/CheckoutPaymentMethods.vue'
import CheckoutReview from '~/components/checkout/CheckoutReview.vue'
import CheckoutStep from '~/components/checkout/CheckoutStep.vue'
import CheckoutTotals from '~/components/checkout/CheckoutTotals.vue'
import CheckoutTrust from '~/components/checkout/CheckoutTrust.vue'
import { submitHostedPayment } from '~/utils/hosted-payment'
import { NEWSLETTER_CONFIRMATION_NOTICE, NEWSLETTER_CONSENT_TEXT } from '~~/shared/newsletter'
import { promotionCodeSchema, promotionReasonSchema, type PromotionReason } from '~~/shared/promotions'

definePageMeta({ layout: 'checkout' })
useSeoMeta({ title: 'Tramitar pedido', robots: 'noindex, nofollow' })

const cart = useCartStore()
const runtime = useRuntimeConfig()
const { contact, phone: contactPhone, email: contactEmail, terms: commercialTerms } = useCommercialTerms()
const { net: showNetPrices } = usePriceDisplay()
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
  // Sin nada que pagar no hay pago: de vuelta al carrito, que es quien sabe ofrecer repetir
  // el último pedido o pedir por referencia.
  if (cart.ready && !cart.error && !cart.items.length) {
    await navigateTo('/carrito', { replace: true })
    return
  }
  void track('checkout_started', { itemCount: cart.count, totalCents: cart.subtotal })
  void prefillSavedAddress()
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
/**
 * «¿Ticket o factura de empresa?». Antes el NIF era «opcional» y aun así se prometía la
 * factura con datos fiscales. Con factura, razón social y NIF son obligatorios; con ticket,
 * no se pide ninguno y no se envía lo que se hubiera escrito.
 */
const invoice = ref<'ticket' | 'company'>('ticket')
watch(invoice, (value) => {
  if (value !== 'ticket') return
  form.company = ''
  form.nif = ''
})

/**
 * Quien tiene cuenta no vuelve a teclear lo que ya sabemos: la entrega se rellena con su
 * dirección predeterminada. Solo si aún no ha escrito nada, y siempre a la vista para poder
 * cambiarla.
 */
const prefilledAddress = ref('')
async function prefillSavedAddress() {
  if (!loggedIn.value) return
  let saved: Address[]
  try {
    saved = (await $fetch<{ addresses: Address[] }>('/api/account/addresses')).addresses ?? []
  } catch {
    return
  }
  const candidates = saved.filter((address) => address.kind !== 'billing' && address.countryCode === 'ES')
  const address = candidates.find((candidate) => candidate.isDefault) ?? candidates[0]
  if (!address || shippingAddress.line1 || shippingAddress.postalCode || shippingAddress.city) return
  Object.assign(shippingAddress, {
    recipientName: shippingAddress.recipientName || address.recipientName,
    companyName: shippingAddress.companyName || (address.companyName ?? ''),
    line1: address.line1,
    line2: address.line2 ?? '',
    postalCode: address.postalCode,
    city: address.city,
    region: address.region || shippingAddress.region,
    phone: shippingAddress.phone || (address.phone ?? ''),
    instructions: shippingAddress.instructions || (address.instructions ?? '')
  })
  prefilledAddress.value = `${address.line1}, ${address.postalCode} ${address.city}`
  // Con contacto y entrega completos no hay nada que teclear: se revisa en una pantalla.
  reviewing.value = [form.name, form.email, form.phone, shippingAddress.recipientName, shippingAddress.phone].every(
    (value) => value.trim()
  )
}

/**
 * Pantalla de revisión: el cliente con cuenta y dirección guardada ve contacto y entrega
 * resumidos, con «Cambiar», y va directo al pago. Los campos siguen montados (se validan y
 * se envían igual); solo se ocultan. Cualquier error los vuelve a enseñar.
 */
const reviewing = ref(false)
const reviewContact = computed(() => [form.name, form.email, form.phone].map((value) => value.trim()).join(' · '))
const reviewDelivery = computed(() =>
  [shippingAddress.line1, shippingAddress.line2, `${shippingAddress.postalCode} ${shippingAddress.city}`.trim()]
    .map((value) => value.trim())
    .filter(Boolean)
    .join(', ')
)

watch(
  user,
  (u) => {
    if (!u) return
    form.name ||= u.name ?? ''
    form.email ||= u.email ?? ''
    form.phone ||= u.phone ?? ''
    form.company ||= u.company ?? ''
    if (form.company) invoice.value = 'company'
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
const transferAvailable = computed(() =>
  Boolean(
    ((runtime.public.bankTransferEnabled && !cloudflareCheckout.value) ||
      (cloudflareCheckout.value && creditEligible.value)) &&
    (!isInternationalMarket.value ||
      marketProfile.value?.paymentMethods.includes('credit') ||
      marketProfile.value?.paymentMethods.includes('bank_transfer'))
  )
)
const transferHint = computed(() =>
  cloudflareCheckout.value
    ? `Transferencia a ${creditTerms.value?.paymentDays} días`
    : 'El pedido se prepara al recibir el ingreso'
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
const subtotalLabel = computed(() =>
  promotion.value?.applied
    ? showNetPrices.value
      ? 'Subtotal neto (descuento incluido)'
      : 'Productos (descuento incluido)'
    : showNetPrices.value
      ? 'Subtotal neto'
      : 'Subtotal'
)
const subtotalCents = computed(() =>
  showNetPrices.value
    ? (selectedShippingRate.value?.subtotalNetCents ?? cart.subtotalNet)
    : promotion.value?.applied && selectedShippingRate.value
      ? selectedShippingRate.value.totalGrossCents - shippingCost.value
      : cart.subtotal
)
const shippingText = computed(() => {
  const market = marketPresentment.value
  if (market) return formatMarketCurrency(market.shippingGrossMinor, market.currency)
  if (!selectedShippingRate.value) return 'Por calcular'
  return shippingCost.value ? formatPrice(shippingCost.value) : 'Gratis'
})
const taxText = computed(() => {
  const market = marketPresentment.value
  return market ? formatMarketCurrency(market.taxMinor, market.currency) : formatPrice(tax.value)
})
const totalText = computed(() => {
  const market = marketPresentment.value
  return market ? formatMarketCurrency(market.totalMinor, market.currency) : formatPrice(total.value)
})

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
      errorMsg.value = `No se ha confirmado si se creó el pedido. No enviaremos otro. Vuelve a comprobarlo o ${contact.value}.`
      return
    }
    cart.resetLocal()
    await navigateTo(`/pedido/${recovery.orderId}`, { replace: true })
  } catch {
    errorMsg.value = `No hemos podido comprobar si se creó el pedido. No enviaremos otro. Vuelve a comprobarlo o ${contact.value}.`
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
    company: '',
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
  if (invoice.value === 'company') {
    if (!form.company.trim()) errors.company = 'Indica la razón social'
    if (!form.nif.trim()) errors.nif = 'Indica el NIF o CIF para la factura'
  }
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
  if (Object.entries(errors).some(([key, value]) => key !== 'terms' && value)) {
    reviewing.value = false
    const step = STEP_FIELDS.entrega.some((key) => errors[key]) ? 'entrega' : 'facturacion'
    if (guided.value) openStep.value = step
    scrollTo(STEP_ANCHORS[step])
  } else scrollTo('checkout-alert', 'center')
}

/**
 * Invitado: tres pasos en acordeón (entrega, facturación, pago), uno abierto cada vez.
 * «Continuar» valida solo lo pedido hasta ese paso; las condiciones se piden al pagar.
 * Con cuenta todos los pasos quedan abiertos (y, con datos guardados, en revisión).
 */
type CheckoutStepId = 'entrega' | 'facturacion' | 'pago'
const STEP_ORDER: CheckoutStepId[] = ['entrega', 'facturacion', 'pago']
const STEP_ANCHORS: Record<CheckoutStepId, string> = {
  entrega: 'sec-datos',
  facturacion: 'sec-facturacion',
  pago: 'sec-pago'
}
const STEP_FIELDS: Record<'entrega' | 'facturacion', string[]> = {
  entrega: [
    'name',
    'email',
    'phone',
    'shippingRecipientName',
    'shippingPhone',
    'shippingLine1',
    'shippingPostalCode',
    'shippingCity'
  ],
  facturacion: [
    'company',
    'nif',
    'purchaseOrderReference',
    'billingRecipientName',
    'billingLine1',
    'billingPostalCode',
    'billingCity',
    'billingTaxId'
  ]
}
const guided = computed(() => !loggedIn.value)
const openStep = ref<CheckoutStepId>('entrega')
const stepOpen = (step: CheckoutStepId) => !guided.value || openStep.value === step
const stepDone = (step: CheckoutStepId) => guided.value && STEP_ORDER.indexOf(openStep.value) > STEP_ORDER.indexOf(step)

function continueFrom(step: 'entrega' | 'facturacion') {
  validate()
  const checked = step === 'entrega' ? STEP_FIELDS.entrega : [...STEP_FIELDS.entrega, ...STEP_FIELDS.facturacion]
  for (const key of Object.keys(errors)) if (!checked.includes(key)) errors[key] = ''
  if (checked.some((key) => errors[key])) {
    scrollToFirstError()
    return
  }
  openStep.value = step === 'entrega' ? 'facturacion' : 'pago'
  scrollTo(STEP_ANCHORS[openStep.value])
}

const deliverySummary = computed(() => {
  const method = SHIPPING_METHODS.find((entry) => entry.value === shippingMethod.value)?.label
  return [form.email.trim(), form.phone.trim(), reviewDelivery.value, method].filter(Boolean).join(' · ')
})
const billingSummary = computed(() => {
  const document =
    invoice.value === 'company'
      ? ['Factura de empresa', form.company.trim(), form.nif.trim()].filter(Boolean).join(' · ')
      : 'Ticket a mi nombre'
  if (billingSameAsShipping.value) return document
  const address = [billingAddress.line1, `${billingAddress.postalCode} ${billingAddress.city}`.trim()]
    .map((value) => value.trim())
    .filter(Boolean)
    .join(', ')
  return [document, address].filter(Boolean).join(' · ')
})

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
                  : apiErrorMessage(error, `No se ha podido crear el pedido. Vuelve a intentarlo o ${contact.value}.`)
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
          <!-- En móvil el resumen queda al final: el total se enseña ya en el primer pliegue. -->
          <a
            href="#resumen-pedido"
            data-checkout-total-mobile
            class="flex items-center justify-between gap-3 rounded-[var(--radius-surface)] border border-[var(--border)] bg-[var(--surface)] px-4 py-3 lg:hidden"
          >
            <span class="text-[15px] text-[var(--text)]">
              Tu pedido · {{ cart.items.length }} {{ cart.items.length === 1 ? 'referencia' : 'referencias' }}
              <span class="block text-[13px] text-[var(--link)] underline">Ver el detalle</span>
            </span>
            <span class="tabular font-display text-xl font-bold text-[var(--text-strong)]">
              {{ formatPrice(total) }}
            </span>
          </a>
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

          <CheckoutStep
            step="entrega"
            :number="1"
            title="Entrega"
            anchor="sec-datos"
            :open="stepOpen('entrega')"
            :done="stepDone('entrega')"
            :current="guided && openStep === 'entrega'"
            :continue-label="guided ? 'Continuar con la facturación' : undefined"
            @continue="continueFrom('entrega')"
            @change="openStep = 'entrega'"
          >
            <template #summary>{{ deliverySummary }}</template>
            <CheckoutReview
              v-if="reviewing"
              :contact="reviewContact"
              :recipient="shippingAddress.recipientName"
              :delivery="reviewDelivery"
              :instructions="shippingAddress.instructions"
              @change="reviewing = false"
            />
            <h3
              v-show="!reviewing"
              class="mt-5 font-sans text-[15px] font-semibold tracking-normal text-[var(--text-strong)]"
            >
              Datos de contacto
            </h3>
            <CheckoutContactFields v-show="!reviewing" v-model:contact="form" :errors="errors" />
            <h3
              v-show="!reviewing"
              class="mt-8 font-sans text-[15px] font-semibold tracking-normal text-[var(--text-strong)]"
            >
              Dirección de entrega
            </h3>
            <p
              v-if="prefilledAddress"
              v-show="!reviewing"
              data-checkout-prefilled
              class="mt-2 rounded-[var(--radius-control)] bg-[var(--surface-sunken)] px-3 py-2 text-[13px] text-[var(--text)]"
            >
              Hemos rellenado tu dirección guardada: {{ prefilledAddress }}. Puedes cambiarla aquí mismo.
            </p>
            <CheckoutAddressFields v-show="!reviewing" v-model:address="shippingAddress" :errors="errors">
              <template #market>
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
                  <CheckoutMarketSummary
                    v-if="marketProfile && marketPresentment"
                    :profile="marketProfile"
                    :presentment="marketPresentment"
                    :format="formatMarketCurrency"
                  />
                </div>
              </template>
            </CheckoutAddressFields>
            <h3 class="mt-8 font-sans text-[15px] font-semibold tracking-normal text-[var(--text-strong)]">
              Método de entrega
            </h3>
            <CheckoutDeliveryMethods
              v-model="shippingMethod"
              :methods="eligibleShippingMethods"
              :rate-for="methodRate"
              :free-shipping-label="freeShipping.label.value"
              :cloudflare="runtime.public.serverRuntime === 'cloudflare'"
              :loading="shippingRateLoading"
              :error="shippingRateError"
            />
          </CheckoutStep>

          <CheckoutStep
            step="facturacion"
            :number="2"
            title="Facturación"
            anchor="sec-facturacion"
            :open="stepOpen('facturacion')"
            :done="stepDone('facturacion')"
            :current="guided && openStep === 'facturacion'"
            :continue-label="guided ? 'Continuar al pago' : undefined"
            @continue="continueFrom('facturacion')"
            @change="openStep = 'facturacion'"
          >
            <template #summary>{{ billingSummary }}</template>
            <CheckoutInvoiceChoice v-model="invoice" v-model:contact="form" :errors="errors" />

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

            <label class="mt-7 flex items-center gap-2 text-sm font-medium text-slate-700">
              <input v-model="billingSameAsShipping" type="checkbox" class="accent-neteco-600" />
              Usar la dirección de entrega también para facturación
            </label>
            <CheckoutBillingAddress v-if="!billingSameAsShipping" v-model:address="billingAddress" :errors="errors" />
          </CheckoutStep>

          <CheckoutStep
            step="pago"
            :number="3"
            title="Pago"
            anchor="sec-pago"
            :open="stepOpen('pago')"
            :done="false"
            :current="guided && openStep === 'pago'"
          >
            <CheckoutPaymentMethods
              v-model="paymentMethod"
              v-model:save-card="saveCardConsent"
              :saved-cards-available="savedCardsAvailable"
              :saved-tokens="savedPaymentTokens"
              :consent-version="savedCardsConsentVersion"
              :consent-locked="Boolean(checkoutCommand || pendingOrder || submitting)"
              :wallets="walletCapabilities"
              :submitting="submitting"
              :actions-disabled="submitting || uncertainOrder || checkingOrder || cart.pendingMutation"
              :selected-token-id="selectedSavedTokenId"
              :selected-wallet="selectedWallet"
              :bizum-available="!isInternationalMarket"
              :transfer-available="transferAvailable"
              :transfer-hint="transferHint"
              @one-click="payWithOneClick"
              @wallet="submitWithWallet"
            />
          </CheckoutStep>
        </div>

        <!-- resumen lateral -->
        <aside
          id="resumen-pedido"
          class="scroll-mt-4 rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--surface)] p-6 lg:sticky lg:top-6"
        >
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
          <CheckoutCoupon
            v-if="couponRuntime"
            v-model="couponDraft"
            :locked="couponLocked"
            :applied="Boolean(couponCode)"
            :feedback="couponFeedback"
            :is-error="Boolean(couponError)"
            @apply="applyCoupon"
            @remove="removeCoupon"
          />
          <CheckoutTotals
            :subtotal-label="subtotalLabel"
            :subtotal-cents="subtotalCents"
            :discount-cents="promotion?.applied ? promotion.discountGrossCents : null"
            :shipping-label="SHIPPING_METHODS.find((m) => m.value === shippingMethod)?.label ?? ''"
            :shipping-text="shippingText"
            :tax-text="taxText"
            :total-text="totalText"
          />

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
                  : `Pagar ${totalText}`
            }}
          </UButton>
          <CheckoutTrust
            :phone="contactPhone?.display ?? ''"
            :email="contactEmail"
            :hours="commercialTerms.supportHours ?? ''"
          />
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
