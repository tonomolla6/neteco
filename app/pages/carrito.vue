<script setup lang="ts">
import { useCartStore } from '~/stores/cart'

useSeoMeta({ title: 'Carrito' })
const cart = useCartStore()
const toast = useToast()
const runtime = useRuntimeConfig()
const showNetPrices = computed(() => runtime.public.priceDisplayMode === 'net-and-gross')

const tax = computed(() => cart.tax)
const lineErrors = reactive<Record<number, string>>({})

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
</script>

<template>
  <div class="mx-auto max-w-[1600px] px-4 py-8">
    <h1 class="text-2xl font-bold text-slate-900 sm:text-3xl">Tu carrito</h1>

    <ClientOnly>
      <div v-if="cart.items.length" class="mt-6 grid gap-8 lg:grid-cols-3">
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
              <p class="w-28 text-right font-semibold text-slate-800">
                {{ formatPrice((showNetPrices ? item.netPrice : item.price) * item.qty) }}
                <span v-if="showNetPrices" class="block text-xs font-normal text-slate-500">
                  {{ formatPrice(item.price * item.qty) }} con IVA
                </span>
              </p>
            </div>
          </div>

          <div class="flex justify-between pt-2">
            <UButton to="/catalogo" variant="ghost" icon="i-lucide-arrow-left">Seguir comprando</UButton>
            <UButton color="neutral" variant="ghost" icon="i-lucide-trash-2" @click="confirmClear">
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
              <dt class="text-slate-500">IVA según producto</dt>
              <dd class="text-slate-500">{{ formatPrice(tax) }}</dd>
            </div>
            <div class="flex justify-between">
              <dt class="text-slate-500">Envío</dt>
              <dd class="text-slate-500">Se calcula al tramitar</dd>
            </div>
            <div class="flex justify-between border-t border-slate-100 pt-3 text-base">
              <dt class="font-semibold text-slate-900">Total</dt>
              <dd class="text-xl font-bold text-slate-900">{{ formatPrice(cart.subtotal) }}</dd>
            </div>
          </dl>
          <UButton to="/checkout" size="xl" block class="mt-5" trailing-icon="i-lucide-arrow-right">
            Tramitar pedido
          </UButton>
          <p class="mt-3 text-center text-xs text-slate-500">
            Los métodos elegibles, el coste y la fecha se calculan con el código postal y el perfil real de la
            mercancía.
          </p>
        </div>
      </div>

      <!-- vacío -->
      <div v-else class="py-20 text-center">
        <UIcon name="i-lucide-shopping-cart" class="mx-auto size-14 text-slate-300" />
        <p class="mt-4 text-lg font-medium text-slate-600">Tu carrito está vacío</p>
        <p class="mt-1 text-sm text-slate-500">Explora el catálogo y añade lo que necesite tu negocio.</p>
        <UButton to="/catalogo" size="lg" class="mt-6" icon="i-lucide-layout-grid">Ver catálogo</UButton>
      </div>

      <template #fallback>
        <div class="py-20 text-center text-slate-400">Cargando carrito…</div>
      </template>
    </ClientOnly>
  </div>
</template>
