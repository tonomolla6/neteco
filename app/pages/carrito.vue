<script setup lang="ts">
import { useCartStore } from '~/stores/cart'
import CartReadFeedback from '~/components/CartReadFeedback.vue'
import CartSnapshotsPanel from '~/components/CartSnapshotsPanel.vue'
import CartRecoverySection from '~/components/CartRecoverySection.vue'
import FreeShippingProgressBar from '~/components/FreeShippingProgressBar.vue'
import type { OrderSummary } from '~/composables/useAccount'
import { provinceForPostalCode } from '~~/shared/delivery-estimate'
import { formatDeliveryDate } from '~~/shared/delivery-promise'

useSeoMeta({ title: 'Carrito', robots: 'noindex, nofollow' })
const cart = useCartStore()
const toast = useToast()
const runtime = useRuntimeConfig()
const { net: showNetPrices } = usePriceDisplay()

const tax = computed(() => cart.tax)
const shipping = useCartShippingEstimate()
const destinationForm = reactive({ postalCode: '' })
const editingDestination = ref(false)
const destinationError = ref('')
function editDestination() {
  destinationForm.postalCode = shipping.destination.value?.postalCode ?? ''
  editingDestination.value = true
}
/** Solo el código postal: la población se conserva si ya la sabíamos y, si no, vale la provincia. */
async function submitDestination() {
  destinationError.value = ''
  const postalCode = destinationForm.postalCode.trim()
  const province = provinceForPostalCode(postalCode)
  if (!province) {
    destinationError.value = 'Escribe un código postal de 5 cifras.'
    return
  }
  const known = shipping.destination.value
  await shipping.calculate({ postalCode, city: known?.postalCode === postalCode ? known.city : province })
  if (shipping.rate.value) editingDestination.value = false
}
/**
 * Fecha de entrega concreta, escrita entera («miércoles, 18 de noviembre»). Con cotización del
 * servidor manda su último día estimado; sin ella, la previsión con las condiciones
 * comerciales y el código postal recordado (`DeliveryPromiseLine`).
 */
const serverDeliveryDate = computed(() => {
  const rate = shipping.rate.value
  const day = rate?.estimatedDeliveryTo ?? rate?.estimatedDeliveryFrom
  if (!rate || shipping.stale.value || !day) return ''
  return formatDeliveryDate(day.slice(0, 10))
})

// Una franja de sugerencias: «Comprados juntos» si hay co-compra y, si no, «Recomendado para ti».
// Son tarjetas que llevan a la ficha: sin cantidades, casillas ni botones de añadir.
const cartSlugs = computed(() => cart.items.map((item) => item.slug))
const recommendations = useProductRecommendations({
  cart: cartSlugs,
  strips: ['bought_together', 'for_you'],
  limit: 8
})
const cartSuggestions = computed(() => {
  const strips = recommendations.strips.value
  const together = strips.filter((strip) => strip.kind === 'bought_together')
  return together.length ? together : strips.filter((strip) => strip.kind === 'for_you')
})

// Sin fecha del servidor, el código postal se cambia en `DeliveryPromiseLine`: se recotiza al cambiar.
watch(
  () => shipping.destination.value?.postalCode,
  (postalCode, previous) => {
    if (postalCode && previous && postalCode !== previous && !shipping.loading.value) void shipping.calculate()
  }
)

const totalWithShipping = computed(() =>
  shipping.rate.value && !shipping.stale.value ? shipping.rate.value.totalGrossCents : cart.subtotal
)

/** El siguiente tramo de volumen que la línea puede alcanzar, dicho como ganancia concreta. */
function nextTier(item: (typeof cart.items)[number]) {
  const tier = [...(item.priceTiers ?? [])]
    .sort((left, right) => left.minimumQuantity - right.minimumQuantity)
    .find((candidate) => candidate.minimumQuantity > item.qty && candidate.unitGrossCents < item.price)
  if (!tier) return null
  const unit = showNetPrices.value
    ? Math.round((tier.unitGrossCents * 10000) / (10000 + (item.taxRateBasisPoints ?? 2100)))
    : tier.unitGrossCents
  return { more: tier.minimumQuantity - item.qty, unit }
}
const lineErrors = reactive<Record<number, string>>({})

// The shared threshold is informational; only a shipping quote confirms eligibility.
const freeShipping = useFreeShipping()
const freeShippingThreshold = freeShipping.thresholdCents
const freeShippingEvaluation = computed(() => {
  return freeShipping.evaluateProgress({
    items: cart.items.map((i) => ({
      variantId: String(i.variantId),
      quantity: i.qty,
      unitGrossCents: i.price,
      unitNetCents: i.netPrice
    })),
    subtotalCents: cart.subtotal
  })
})
const retryingRead = ref(false)
let readPending = false
const cartReadLoading = computed(() => retryingRead.value || cart.loading || (!cart.ready && !cart.error))
const cartReadable = computed(() => cart.ready && !cart.loading && !cart.error && !retryingRead.value)
async function retryCartRead() {
  if (readPending || cart.loading) return
  readPending = true
  retryingRead.value = true
  try {
    await cart.load({ restoreCachedItems: false })
  } finally {
    readPending = false
    retryingRead.value = false
  }
}

/**
 * Carrito vacío para un cliente identificado.
 *
 * Un mensaje de «explora el catálogo» sirve para un consumidor que descubre. Aquí el cliente
 * repone: si ya ha pedido antes, lo que necesita es repetir, no explorar. Se ofrece su último
 * pedido directamente.
 */
const { loggedIn } = useUserSession()
const { data: orderData } = await useLazyFetch<{ orders: OrderSummary[] }>('/api/orders', {
  immediate: loggedIn.value,
  default: () => ({ orders: [] })
})
const lastOrder = computed(() => orderData.value?.orders?.[0])
const dialog = useTemplateRef('dialog')

async function updateQuantity(item: (typeof cart.items)[number], quantity: number) {
  lineErrors[item.variantId] = ''
  try {
    await cart.setQty(item.variantId, quantity)
  } catch (error) {
    const message = apiErrorMessage(error, 'No se ha podido actualizar la cantidad')
    lineErrors[item.variantId] = message
    toast.add({ title: message, color: 'error' })
  }
}

async function removeItem(item: (typeof cart.items)[number]) {
  lineErrors[item.variantId] = ''
  try {
    await cart.remove(item.variantId)
  } catch (error) {
    const message = apiErrorMessage(error, 'No se ha podido quitar el producto')
    lineErrors[item.variantId] = message
    toast.add({ title: message, color: 'error' })
  }
}

async function confirmClear() {
  if (!window.confirm('¿Vaciar todo el carrito?')) return
  try {
    await cart.clear()
  } catch (error) {
    toast.add({ title: apiErrorMessage(error, 'No se ha podido vaciar el carrito'), color: 'error' })
  }
}
async function retryOriginalAdd() {
  try {
    await cart.retryAdd()
  } catch {
    /* The original intention and its visible recovery notice remain. */
  }
}
</script>

<template>
  <div class="mx-auto max-w-[1600px] px-4 py-8 pb-28 sm:px-6 lg:pb-8">
    <h1 class="text-2xl font-bold text-slate-900 sm:text-3xl">Tu carrito</h1>

    <ClientOnly>
      <section
        v-if="cart.addRecoveryMessage || cart.checkingAddJournal"
        role="alert"
        class="mt-6 rounded-[var(--radius-surface)] border border-amber-300 bg-amber-50 p-4"
      >
        <p>
          {{
            cart.addRecoveryMessage ||
            'Comprobando la recuperación del carrito. No se enviará ninguna adición automáticamente.'
          }}
        </p>
        <div v-if="cart.addRecovery" class="mt-3 flex flex-wrap gap-3">
          <UButton v-if="cart.addReceiptAvailable" :disabled="!cart.canRecoverAdd" @click="cart.recoverAdd()"
            >Comprobar adición</UButton
          >
          <UButton
            v-if="!cart.addRecoveryConfirmed"
            :disabled="!cart.canRetryAdd"
            variant="outline"
            @click="retryOriginalAdd"
            >Reintentar la misma adición</UButton
          >
        </div>
        <p class="mt-2 text-sm">
          El reintento conserva el producto y la cantidad originales. No enviamos otra adición automáticamente.
        </p>
      </section>
      <CartReadFeedback v-if="!cartReadable" :loading="cartReadLoading" @retry="retryCartRead" />
      <div v-else-if="cart.items.length" class="mt-6 grid gap-8 grid-cols-1 lg:grid-cols-3">
        <!-- líneas: lo primero tras el título es añadir por referencia y las propias líneas -->
        <div class="space-y-3 lg:col-span-2">
          <CartAddByReference />
          <div
            v-for="item in cart.items"
            :key="item.variantId"
            data-cart-line
            class="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-[var(--radius-surface)] border border-[var(--border)] bg-[var(--surface)] p-4"
          >
            <NuxtLink
              :to="`/producto/${item.slug}?sku=${item.sku}`"
              tabindex="-1"
              aria-hidden="true"
              class="w-14 shrink-0 sm:w-20"
            >
              <ProductImage :product="item" />
            </NuxtLink>
            <div class="min-w-0 flex-1 basis-40">
              <NuxtLink
                :to="`/producto/${item.slug}?sku=${item.sku}`"
                class="line-clamp-2 text-[15px] font-semibold text-[var(--text-strong)] hover:underline"
              >
                {{ item.name }}
              </NuxtLink>
              <p class="tabular mt-0.5 text-[13px] text-[var(--text-muted)]">Ref. {{ item.sku }} · {{ item.format }}</p>
              <p class="tabular mt-0.5 text-[13px] text-[var(--text)]">
                {{ formatPrice(showNetPrices ? item.netPrice : item.price) }}/ud
                <span class="text-[var(--text-muted)]">{{ showNetPrices ? 'sin IVA' : 'IVA incluido' }}</span>
              </p>
              <p v-if="nextTier(item)" class="tabular mt-0.5 text-[13px] font-medium text-[var(--stock-ok)]">
                Con {{ nextTier(item)!.more }} más: {{ formatPrice(nextTier(item)!.unit) }}/ud
              </p>
            </div>
            <div class="flex w-full items-center justify-between gap-3 sm:w-auto">
              <fieldset :disabled="cart.blockedMutations">
                <CartLineControls
                  :quantity="item.qty"
                  :minimum="item.minimumQuantity ?? 1"
                  :maximum="item.maximumQuantity"
                  :step="item.quantityIncrement ?? 1"
                  :label="item.name"
                  :error="lineErrors[item.variantId]"
                  @quantity="updateQuantity(item, $event)"
                  @remove="removeItem(item)"
                />
              </fieldset>
              <p class="tabular w-28 text-right font-semibold text-[var(--text-strong)]">
                {{ formatPrice(showNetPrices ? (item.lineNet ?? item.netPrice * item.qty) : item.price * item.qty) }}
                <span v-if="showNetPrices" class="block text-[13px] font-normal text-[var(--text-muted)]">
                  {{ formatPrice(item.price * item.qty) }} con IVA
                </span>
              </p>
            </div>
          </div>

          <div class="flex justify-between pt-2">
            <UButton to="/catalogo" variant="ghost" icon="i-lucide-arrow-left">Seguir comprando</UButton>
            <UButton
              color="neutral"
              variant="ghost"
              icon="i-lucide-trash-2"
              :disabled="cart.blockedMutations"
              @click="confirmClear"
            >
              Vaciar carrito
            </UButton>
          </div>

          <!-- Venta cruzada y carritos guardados van debajo de las líneas, nunca antes. -->
          <RecommendationStrips
            v-if="cartSuggestions.length"
            data-cart-suggestions
            :strips="cartSuggestions"
            :mobile-count="1"
            class="pt-6"
          />
          <CartSnapshotsPanel v-if="runtime.public.serverRuntime === 'cloudflare'" />
        </div>

        <!-- resumen: base imponible, IVA, envío y total, en ese orden -->
        <div
          data-cart-summary
          class="h-fit rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--surface)] p-6 lg:sticky lg:top-24"
        >
          <h2 class="text-lg font-bold text-[var(--text-strong)]">Resumen</h2>
          <!-- La fecha de entrega, lo primero y en su propio bloque: es lo que decide si se pide hoy -->
          <div data-cart-delivery-date class="mt-3 border-b border-[var(--border)] pb-4">
            <template v-if="serverDeliveryDate">
              <p class="text-[15px] leading-snug text-[var(--text)]">
                Entrega
                <strong v-if="shipping.shippingGross.value === 0" class="font-semibold text-[var(--stock-ok)]"
                  >GRATIS</strong
                >
                el
                <strong data-delivery-date class="font-semibold text-[var(--text-strong)]">{{
                  serverDeliveryDate
                }}</strong>
              </p>
              <p class="mt-1 text-[13px] text-[var(--text-muted)]">
                Si lo pides ahora · {{ shipping.rate.value?.label }}
              </p>
            </template>
            <template v-else-if="shipping.rate.value && !shipping.stale.value">
              <p class="text-[15px] text-[var(--text)]">Te confirmamos la fecha de entrega al pedirlo.</p>
              <p class="mt-1 text-[13px] text-[var(--text-muted)]">{{ shipping.rate.value.label }}</p>
            </template>
            <DeliveryPromiseLine v-else earliest :free="freeShippingEvaluation.status === 'reached'" />
            <!-- Código postal, compacto: una línea para verlo o cambiarlo -->
            <div v-if="shipping.available.value" data-shipping-estimate class="text-[13px]">
              <p
                v-if="shipping.rate.value && shipping.destination.value && !editingDestination"
                class="mt-1.5 flex items-start gap-1.5 text-[var(--text-muted)]"
              >
                <UIcon name="i-lucide-map-pin" class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                <span>
                  Enviar a {{ shipping.destination.value.postalCode }} {{ shipping.destination.value.city }} ·
                  <button
                    type="button"
                    data-shipping-change
                    class="font-semibold text-[var(--link)] underline underline-offset-2"
                    @click="editDestination"
                  >
                    Cambiar
                  </button>
                </span>
              </p>
              <form
                v-else-if="shipping.rate.value && editingDestination"
                class="mt-2 flex items-center gap-2"
                @submit.prevent="submitDestination"
              >
                <label for="cart-postal-code" class="shrink-0 text-[var(--text)]">Código postal</label>
                <input
                  id="cart-postal-code"
                  v-model="destinationForm.postalCode"
                  inputmode="numeric"
                  autocomplete="postal-code"
                  maxlength="5"
                  class="tabular h-9 w-20 rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--surface)] px-2 text-[15px]"
                />
                <button
                  type="submit"
                  :disabled="shipping.loading.value"
                  class="h-9 rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--surface)] px-3 font-semibold text-[var(--text-strong)] hover:border-[var(--action)] disabled:opacity-50"
                >
                  {{ shipping.loading.value ? 'Calculando…' : 'Calcular' }}
                </button>
              </form>
              <p v-if="shipping.stale.value" class="mt-1.5 text-[var(--text)]">
                El carrito ha cambiado.
                <button
                  type="button"
                  class="font-semibold text-[var(--link)] underline"
                  :disabled="shipping.loading.value"
                  @click="shipping.calculate()"
                >
                  Recalcular el envío
                </button>
              </p>
              <p v-if="destinationError" role="alert" class="mt-1 text-[var(--ui-error)]">{{ destinationError }}</p>
              <p v-if="shipping.error.value" role="status" class="mt-1 text-[var(--text)]">
                {{ shipping.error.value }}
              </p>
            </div>
            <FreeShippingProgressBar v-if="freeShippingThreshold" class="mt-3" :evaluation="freeShippingEvaluation" />
          </div>
          <dl class="tabular mt-4 space-y-2 text-[15px]">
            <div class="flex justify-between gap-3">
              <dt class="text-[var(--text-muted)]">Base imponible ({{ cart.count }} uds.)</dt>
              <dd class="font-medium text-[var(--text-strong)]">{{ formatPrice(cart.subtotalNet) }}</dd>
            </div>
            <div class="flex justify-between gap-3">
              <dt class="text-[var(--text-muted)]">IVA</dt>
              <dd class="font-medium text-[var(--text-strong)]">{{ formatPrice(tax) }}</dd>
            </div>
            <div class="flex justify-between gap-3">
              <dt class="text-[var(--text-muted)]">
                Envío<template v-if="shipping.rate.value && shipping.destination.value">
                  a {{ shipping.destination.value.postalCode }}</template
                >
              </dt>
              <dd v-if="shipping.rate.value && !shipping.stale.value" class="font-medium text-[var(--text-strong)]">
                {{ shipping.shippingGross.value ? formatPrice(shipping.shippingGross.value) : 'gratis' }}
              </dd>
              <dd v-else-if="!shipping.available.value" class="max-w-[12rem] text-right text-[var(--text-muted)]">
                Lo ves en el siguiente paso, antes de pagar
              </dd>
              <dd v-else class="text-[var(--text-muted)]">Según código postal</dd>
            </div>
            <div class="flex items-baseline justify-between gap-3 border-t border-[var(--border)] pt-3">
              <dt class="font-semibold text-[var(--text-strong)]">Total</dt>
              <dd class="font-display text-[1.625rem] font-bold text-[var(--text-strong)]">
                {{ formatPrice(totalWithShipping) }}
              </dd>
            </div>
          </dl>
          <p
            v-if="!shipping.rate.value || shipping.stale.value"
            class="mt-1 text-right text-[13px] text-[var(--text-muted)]"
          >
            IVA incluido, sin envío
          </p>

          <!-- En móvil la acción vive en la barra fija; aquí solo desde `lg`. Una acción por vista. -->
          <NuxtLink
            v-if="!cart.blockedMutations"
            to="/checkout"
            class="mt-5 hidden h-12 w-full items-center justify-center gap-2 rounded-[var(--radius-control)] bg-[var(--action)] px-5 font-semibold text-white transition-colors hover:bg-[var(--action-hover)] lg:flex"
          >
            Tramitar pedido <UIcon name="i-lucide-arrow-right" class="size-4" />
          </NuxtLink>
          <p v-else role="status" class="mt-5 text-sm text-amber-900">
            Comprueba la adición pendiente antes de tramitar el pedido.
          </p>

          <!-- Las señales de confianza van donde aparece la duda: justo antes del clic, no
               repartidas por la página. -->
          <ul class="mt-5 space-y-2 border-t border-[var(--border)] pt-4 text-xs text-[var(--text-muted)]">
            <li class="flex items-start gap-2">
              <UIcon name="i-lucide-shield-check" class="mt-px size-4 shrink-0" />
              Pago seguro con Redsys. No guardamos los datos de tu tarjeta.
            </li>
            <li class="flex items-start gap-2">
              <UIcon name="i-lucide-file-text" class="mt-px size-4 shrink-0" />
              Factura con tus datos fiscales en cada pedido.
            </li>
            <li class="flex items-start gap-2">
              <UIcon name="i-lucide-phone" class="mt-px size-4 shrink-0" />
              <span>¿Dudas antes de pedir? <ContactAction link-class="underline" />.</span>
            </li>
          </ul>
        </div>
      </div>

      <!-- vacío -->
      <div v-else class="py-16 text-center">
        <UIcon name="i-lucide-shopping-cart" class="mx-auto size-12 text-slate-300" />
        <p class="mt-4 text-lg font-semibold text-[var(--text-strong)]">Tu carrito está vacío</p>

        <template v-if="lastOrder">
          <p class="mx-auto mt-1.5 max-w-md text-sm text-[var(--text-muted)]">
            Tu último pedido fue el {{ formatAccountDate(lastOrder.createdAt) }}, con {{ lastOrder.lines }}
            {{ lastOrder.lines === 1 ? 'referencia' : 'referencias' }}.
          </p>
          <div class="mt-6 flex flex-wrap justify-center gap-2">
            <UButton size="lg" icon="i-lucide-rotate-cw" @click="dialog?.start(lastOrder.id)">
              Repetir ese pedido
            </UButton>
            <UButton to="/pedido-rapido" size="lg" color="neutral" variant="outline" icon="i-lucide-list-plus">
              Pedir por referencia
            </UButton>
            <UButton to="/catalogo" size="lg" color="neutral" variant="outline" icon="i-lucide-layout-grid">
              Ver catálogo
            </UButton>
          </div>
        </template>

        <template v-else>
          <p class="mt-1.5 text-sm text-[var(--text-muted)]">
            Pide con el albarán delante o explora el catálogo y añade lo que necesite tu negocio.
          </p>
          <div class="mt-6 flex flex-wrap justify-center gap-2">
            <UButton to="/pedido-rapido" size="lg" icon="i-lucide-list-plus">Pedir por referencia</UButton>
            <UButton to="/catalogo" size="lg" color="neutral" variant="outline" icon="i-lucide-layout-grid">
              Ver catálogo
            </UButton>
          </div>
        </template>
      </div>

      <template #fallback>
        <div class="mt-6 grid gap-8 grid-cols-1 lg:grid-cols-3">
          <div class="space-y-3 lg:col-span-2">
            <div
              v-for="n in 2"
              :key="n"
              class="h-24 animate-pulse rounded-[var(--radius-surface)] bg-[var(--surface-sunken)]"
            />
          </div>
          <div class="h-64 animate-pulse rounded-[var(--radius-panel)] bg-[var(--surface-sunken)]" />
        </div>
      </template>
    </ClientOnly>

    <ClientOnly>
      <!-- La recuperación de un pedido anterior solo ocupa sitio si hay algo que recuperar. -->
      <CartRecoverySection stage="cart" />
      <div
        v-if="cartReadable && cart.items.length && !cart.blockedMutations"
        data-cart-mobile-bar
        class="fixed inset-x-0 bottom-0 z-30 flex items-center gap-3 border-t border-[var(--border)] bg-[var(--surface)] px-4 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] shadow-[var(--shadow-overlay)] lg:hidden"
      >
        <div class="min-w-0">
          <p class="text-[13px] text-[var(--text-muted)]">
            Total{{ shipping.rate.value && !shipping.stale.value ? ' con envío' : ' sin envío' }}
          </p>
          <p class="tabular font-display text-lg font-bold text-[var(--text-strong)]">
            {{ formatPrice(totalWithShipping) }}
          </p>
        </div>
        <NuxtLink
          to="/checkout"
          class="inline-flex h-12 flex-1 items-center justify-center gap-2 rounded-[var(--radius-control)] bg-[var(--action)] px-4 font-semibold text-white transition-colors hover:bg-[var(--action-hover)]"
        >
          Tramitar pedido <UIcon name="i-lucide-arrow-right" class="size-4" />
        </NuxtLink>
      </div>
    </ClientOnly>

    <ReorderDialog ref="dialog" />
  </div>
</template>
