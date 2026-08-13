<script setup lang="ts">
import { useCartStore } from '~/stores/cart'
import { submitHostedPayment } from '~/utils/hosted-payment'
import { NEWSLETTER_CONFIRMATION_NOTICE, NEWSLETTER_CONSENT_TEXT } from '~~/shared/newsletter'

useSeoMeta({ title: 'Tramitar pedido' })

const cart = useCartStore()
const runtime = useRuntimeConfig()
const showNetPrices = computed(() => runtime.public.priceDisplayMode === 'net-and-gross')
const { loggedIn, user } = useUserSession()
const toast = useToast()
const { track } = useAnalytics()

onMounted(async () => {
  await cart.load()
  void track('checkout_started', { itemCount: cart.count, totalCents: cart.subtotal })
})

const form = reactive({
  name: '',
  company: '',
  nif: '',
  email: '',
  phone: ''
})
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
  estimatedDeliveryFrom: string
  estimatedDeliveryTo: string
  profile: 'parcel' | 'multi_parcel' | 'pallet' | 'own_delivery' | 'adr' | 'pickup'
  pricingVersion: string
  subtotalNetCents: number
  taxCents: number
  totalGrossCents: number
}

const shippingRates = ref<ShippingRate[]>([])
const shippingRateLoading = ref(false)
const shippingRateError = ref('')

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
const quotedShippingGross = computed(() => {
  const rate = selectedShippingRate.value
  if (!rate) return 0
  return rate.netCents + Math.round((rate.netCents * rate.taxRateBasisPoints) / 10_000)
})
const shippingCost = computed(() => quotedShippingGross.value)
const total = computed(() => selectedShippingRate.value?.totalGrossCents ?? cart.subtotal + shippingCost.value)
const tax = computed(() => selectedShippingRate.value?.taxCents ?? 0)

const submitting = ref(false)
const errorMsg = ref('')
const errors = reactive<Record<string, string>>({})
// si el pago con tarjeta/Bizum falla, reutilizamos el pedido creado para reintentar
const pendingOrder = ref<{ id: string; token: string } | null>(null)
const checkoutAttempt = reactive({ idempotencyKey: crypto.randomUUID(), guestToken: crypto.randomUUID() })

async function refreshShippingRates() {
  if (
    !/^\d{5}$/.test(shippingAddress.postalCode.trim()) ||
    !shippingAddress.recipientName.trim() ||
    !shippingAddress.line1.trim() ||
    !shippingAddress.city.trim()
  )
    return false
  await cart.ensureLoaded()
  shippingRateLoading.value = true
  shippingRateError.value = ''
  try {
    const quote = await $fetch<{ cartVersion: number; rates: ShippingRate[] }>('/api/shipping/rates', {
      method: 'POST',
      body: {
        name: shippingAddress.recipientName,
        line1: shippingAddress.line1,
        postalCode: shippingAddress.postalCode,
        city: shippingAddress.city,
        region: shippingAddress.region,
        phone: shippingAddress.phone
      }
    })
    shippingRates.value = quote.rates
    if (!methodRate(shippingMethod.value)) {
      shippingMethod.value = methodForRate(quote.rates[0]!)
    }
    return true
  } catch (error) {
    shippingRateError.value = apiErrorMessage(error, 'No se han podido calcular los métodos de entrega.')
    return false
  } finally {
    shippingRateLoading.value = false
  }
}

let rateTimer: ReturnType<typeof setTimeout> | undefined
watch(
  () => [
    shippingAddress.recipientName,
    shippingAddress.line1,
    shippingAddress.postalCode,
    shippingAddress.city,
    shippingAddress.region,
    shippingAddress.phone,
    cart.version
  ],
  () => {
    clearTimeout(rateTimer)
    rateTimer = setTimeout(() => void refreshShippingRates(), 350)
  }
)

// cambiar el método de pago, el envío o los datos invalida el pedido pendiente:
// el siguiente intento crea un pedido nuevo con la información correcta
watch(
  [paymentMethod, shippingMethod, form, shippingAddress, billingAddress, billingSameAsShipping, marketingConsent],
  () => {
    pendingOrder.value = null
    checkoutAttempt.idempotencyKey = crypto.randomUUID()
    checkoutAttempt.guestToken = crypto.randomUUID()
  },
  { deep: true }
)

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
    terms: ''
  })
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
  errorMsg.value = ''
  if (!validate()) {
    errorMsg.value = 'Revisa los campos marcados.'
    scrollToFirstError()
    return
  }
  if (!(await refreshShippingRates()) || !selectedShippingRate.value) {
    errorMsg.value = shippingRateError.value || 'Selecciona un método de entrega elegible.'
    scrollTo('checkout-alert', 'center')
    return
  }

  submitting.value = true
  try {
    let order = pendingOrder.value
    if (!order) {
      await cart.ensureLoaded()
      if (!cart.id) throw new Error('El carrito no está disponible')
      order = await $fetch<{ id: string; token: string }>('/api/orders', {
        method: 'POST',
        body: {
          customer: { ...form },
          shippingAddress: { ...shippingAddress },
          billingAddress: effectiveBillingAddress(),
          shippingMethod: shippingMethod.value,
          shippingServiceCode: selectedShippingRate.value.serviceCode,
          expectedPricingVersion: selectedShippingRate.value.pricingVersion,
          expectedTotalGrossCents: selectedShippingRate.value.totalGrossCents,
          paymentMethod: paymentMethod.value,
          cartId: cart.id,
          cartVersion: cart.version,
          idempotencyKey: checkoutAttempt.idempotencyKey,
          guestToken: checkoutAttempt.guestToken,
          termsAccepted: true,
          marketingConsent: marketingConsent.value
        }
      })
    }

    if (paymentMethod.value === 'transferencia') {
      await finish(order)
      return
    }

    const pay = await $fetch<{
      ok: boolean
      redirect: { actionUrl: string; method: 'POST'; fields: Record<string, string> } | null
    }>('/api/checkout/pay', {
      method: 'POST',
      body: {
        orderId: order.id,
        token: order.token,
        method: paymentMethod.value
      }
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
        ? (error as { data?: { data?: { code?: string }; code?: string } }).data
        : undefined
    const quoteChanged =
      responseData?.code === 'CHECKOUT_QUOTE_CHANGED' || responseData?.data?.code === 'CHECKOUT_QUOTE_CHANGED'
    if (quoteChanged) await refreshShippingRates()
    errorMsg.value = apiErrorMessage(
      error,
      'No se ha podido crear el pedido. Vuelve a intentarlo o llámanos al 600 861 334.'
    )
    scrollTo('checkout-alert', 'center')
  } finally {
    submitting.value = false
  }
}

async function finish(order: { id: string; token: string }) {
  cart.resetLocal()
  toast.add({ title: 'Pedido realizado', icon: 'i-lucide-check-circle-2', color: 'success' })
  navigateTo(`/pedido/${order.id}`)
}
</script>

<template>
  <div class="mx-auto max-w-[1600px] px-4 py-8">
    <h1 class="text-2xl font-bold text-slate-900 sm:text-3xl">Tramitar pedido</h1>

    <ClientOnly>
      <form v-if="cart.items.length" class="mt-6 grid items-start gap-8 lg:grid-cols-3" @submit.prevent="submit">
        <div class="space-y-6 lg:col-span-2">
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
            <p class="flex items-center gap-2 text-sm font-medium text-emerald-800">
              <UIcon name="i-lucide-check-circle-2" class="size-5" />
              Comprando con tu cuenta: {{ user?.email }}
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
            <div class="mt-5 grid gap-4 sm:grid-cols-2">
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

            <h3 class="mt-8 text-sm font-bold uppercase tracking-wide text-slate-500">Dirección de entrega</h3>
            <div class="mt-4 grid gap-4 sm:grid-cols-2">
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
              <div class="mt-4 grid gap-4 sm:grid-cols-2">
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
                      <template v-if="methodRate(m.value)?.estimatedDeliveryTo">
                        · antes del {{ new Date(methodRate(m.value)!.estimatedDeliveryTo).toLocaleDateString('es-ES') }}
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
                v-if="runtime.public.bankTransferEnabled"
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
                {{ formatPrice((showNetPrices ? item.netPrice : item.price) * item.qty) }}
                <span v-if="showNetPrices" class="block text-xs font-normal text-slate-500">
                  {{ formatPrice(item.price * item.qty) }} con IVA
                </span>
              </p>
            </li>
          </ul>
          <dl class="mt-4 space-y-2 border-t border-slate-100 pt-4 text-sm">
            <div class="flex justify-between">
              <dt class="text-slate-500">{{ showNetPrices ? 'Subtotal neto' : 'Subtotal' }}</dt>
              <dd>
                {{
                  formatPrice(
                    showNetPrices ? (selectedShippingRate?.subtotalNetCents ?? cart.subtotalNet) : cart.subtotal
                  )
                }}
              </dd>
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
              <dd class="text-xl font-bold">{{ formatPrice(total) }}</dd>
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

          <label class="mt-3 flex items-start gap-2 text-xs text-slate-500">
            <input v-model="marketingConsent" type="checkbox" class="mt-0.5 accent-neteco-600" />
            <span>{{ NEWSLETTER_CONSENT_TEXT }} {{ NEWSLETTER_CONFIRMATION_NOTICE }}</span>
          </label>

          <div v-if="errorMsg" id="checkout-alert" role="alert" class="mt-4 scroll-mt-40">
            <UAlert color="error" variant="subtle" icon="i-lucide-alert-circle" :title="errorMsg" />
          </div>

          <UButton type="submit" size="xl" block class="mt-4" :loading="submitting" icon="i-lucide-lock">
            {{ paymentMethod === 'transferencia' ? 'Confirmar pedido' : `Pagar ${formatPrice(total)}` }}
          </UButton>
          <p class="mt-3 flex items-center justify-center gap-1.5 text-xs text-slate-500">
            <UIcon name="i-lucide-shield-check" class="size-3.5" /> Pago protegido mediante redirección bancaria
          </p>
        </aside>
      </form>

      <div v-else class="py-20 text-center">
        <UIcon name="i-lucide-shopping-cart" class="mx-auto size-14 text-slate-300" />
        <p class="mt-4 text-lg font-medium text-slate-600">Tu carrito está vacío</p>
        <p class="mt-1 text-sm text-slate-500">Añade productos del catálogo para tramitar tu pedido.</p>
        <UButton to="/catalogo" size="lg" class="mt-6" icon="i-lucide-layout-grid">Ver el catálogo</UButton>
      </div>

      <template #fallback>
        <div class="py-20 text-center text-slate-400">Cargando…</div>
      </template>
    </ClientOnly>
  </div>
</template>
