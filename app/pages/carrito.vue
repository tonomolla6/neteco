<script setup lang="ts">
import { useCartStore } from '~/stores/cart'
import CartReadFeedback from '~/components/CartReadFeedback.vue'
import CartSnapshotsPanel from '~/components/CartSnapshotsPanel.vue'
import CartRecoverySection from '~/components/CartRecoverySection.vue'
import PublishedProductRelations from '~/components/PublishedProductRelations.vue'
import FreeShippingProgressBar from '~/components/FreeShippingProgressBar.vue'
import type { OrderSummary } from '~/composables/useAccount'

useSeoMeta({ title: 'Carrito', robots: 'noindex, nofollow' })
const cart = useCartStore()
const toast = useToast()
const runtime = useRuntimeConfig()
const { net: showNetPrices } = usePriceDisplay()

const tax = computed(() => cart.tax)
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
  <div class="mx-auto max-w-[1600px] px-4 py-8">
    <h1 class="text-2xl font-bold text-slate-900 sm:text-3xl">Tu carrito</h1>
    <ClientOnly>
      <CartRecoverySection stage="cart" />
      <CartSnapshotsPanel v-if="runtime.public.serverRuntime === 'cloudflare'" />
    </ClientOnly>

    <PublishedProductRelations
      v-if="runtime.public.serverRuntime === 'cloudflare' && cartReadable"
      :product-slugs="cart.items.map((item) => item.slug)"
      class="mt-6"
    />

    <ClientOnly>
      <section
        v-if="cart.addRecoveryMessage || cart.checkingAddJournal"
        role="alert"
        class="mt-6 rounded-xl border border-amber-300 bg-amber-50 p-4"
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
        <!-- líneas -->
        <div class="space-y-3 lg:col-span-2">
          <div
            v-for="item in cart.items"
            :key="item.variantId"
            class="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-xl border border-slate-200 bg-white p-4"
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
                class="line-clamp-2 text-sm font-medium text-slate-800 hover:text-neteco-700"
              >
                {{ item.name }}
              </NuxtLink>
              <p class="mt-0.5 text-xs text-slate-500">
                {{ item.format }} · <span class="font-mono">{{ item.sku }}</span>
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
              <p class="w-28 text-right font-semibold text-slate-800">
                {{ formatPrice(showNetPrices ? (item.lineNet ?? item.netPrice * item.qty) : item.price * item.qty) }}
                <span v-if="showNetPrices" class="block text-xs font-normal text-slate-500">
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
        </div>

        <!-- resumen -->
        <div class="h-fit rounded-2xl border border-slate-200 bg-white p-6">
          <h2 class="text-lg font-bold text-slate-900">Resumen</h2>
          <dl class="mt-4 space-y-2 text-sm">
            <div class="flex justify-between">
              <dt class="text-slate-500">{{ showNetPrices ? 'Subtotal neto' : 'Subtotal' }} ({{ cart.count }} uds.)</dt>
              <dd class="font-medium">{{ formatPrice(showNetPrices ? cart.subtotalNet : cart.subtotal) }}</dd>
            </div>
            <div class="flex justify-between">
              <dt class="text-slate-500">Envío</dt>
              <dd class="text-slate-500">Lo ves en el siguiente paso, antes de pagar</dd>
            </div>
            <div class="flex justify-between border-t border-slate-100 pt-3 text-base">
              <dt class="font-semibold text-slate-900">Total</dt>
              <dd class="text-xl font-bold text-slate-900">{{ formatPrice(cart.subtotal) }}</dd>
            </div>
            <div class="flex justify-between text-xs">
              <dt class="text-slate-500">IVA incluido</dt>
              <dd class="text-slate-500">{{ formatPrice(tax) }}</dd>
            </div>
          </dl>
          <FreeShippingProgressBar v-if="freeShippingThreshold" class="mt-4" :evaluation="freeShippingEvaluation" />

          <UButton
            v-if="!cart.blockedMutations"
            to="/checkout"
            size="xl"
            block
            class="mt-5"
            trailing-icon="i-lucide-arrow-right"
          >
            Tramitar pedido
          </UButton>
          <p v-else role="status" class="mt-5 text-sm text-amber-900">
            Comprueba la adición pendiente antes de tramitar el pedido.
          </p>

          <!-- Las señales de confianza van donde aparece la duda: justo antes del clic, no
               repartidas por la página. -->
          <ul class="mt-5 space-y-2 border-t border-[var(--border)] pt-4 text-xs text-[var(--text-muted)]">
            <li class="flex items-start gap-2">
              <UIcon name="i-lucide-shield-check" class="mt-px size-4 shrink-0 text-neteco-600" />
              Pago seguro con Redsys. No guardamos los datos de tu tarjeta.
            </li>
            <li class="flex items-start gap-2">
              <UIcon name="i-lucide-file-text" class="mt-px size-4 shrink-0 text-neteco-600" />
              Factura con tus datos fiscales en cada pedido.
            </li>
            <li class="flex items-start gap-2">
              <UIcon name="i-lucide-phone" class="mt-px size-4 shrink-0 text-neteco-600" />
              ¿Dudas antes de pedir? 600 861 334, hablas con una persona.
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
            <UButton to="/catalogo" size="lg" color="neutral" variant="outline" icon="i-lucide-layout-grid">
              Ver catálogo
            </UButton>
          </div>
        </template>

        <template v-else>
          <p class="mt-1.5 text-sm text-[var(--text-muted)]">Explora el catálogo y añade lo que necesite tu negocio.</p>
          <UButton to="/catalogo" size="lg" class="mt-6" icon="i-lucide-layout-grid">Ver catálogo</UButton>
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

    <ReorderDialog ref="dialog" />
  </div>
</template>
