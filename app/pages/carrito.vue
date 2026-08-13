<script setup lang="ts">
import { useCartStore } from '~/stores/cart'

useSeoMeta({ title: 'Carrito' })
const cart = useCartStore()
const toast = useToast()

const tax = computed(() => cart.subtotal - Math.round(cart.subtotal / 1.21))

async function updateQuantity(item: (typeof cart.items)[number], quantity: number) {
  try {
    await cart.setQty(item.variantId, quantity)
  } catch (error) {
    toast.add({ title: apiErrorMessage(error, 'No se ha podido actualizar la cantidad'), color: 'error' })
  }
}

async function removeItem(item: (typeof cart.items)[number]) {
  try {
    await cart.remove(item.variantId)
  } catch (error) {
    toast.add({ title: apiErrorMessage(error, 'No se ha podido quitar el producto'), color: 'error' })
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
              <div class="flex items-center rounded-lg border border-slate-300">
                <button
                  class="rounded-l-lg px-3 py-2.5 text-slate-500 hover:text-neteco-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neteco-500 disabled:opacity-30"
                  :disabled="item.qty <= (item.minimumQuantity ?? 1)"
                  :aria-label="`Menos unidades de ${item.name}`"
                  @click="updateQuantity(item, item.qty - (item.quantityIncrement ?? 1))"
                >
                  <UIcon name="i-lucide-minus" class="block size-4" />
                </button>
                <span role="status" class="w-8 text-center text-sm font-semibold">{{ item.qty }}</span>
                <button
                  class="rounded-r-lg px-3 py-2.5 text-slate-500 hover:text-neteco-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neteco-500"
                  :disabled="
                    item.maximumQuantity != null && item.qty + (item.quantityIncrement ?? 1) > item.maximumQuantity
                  "
                  :aria-label="`Más unidades de ${item.name}`"
                  @click="updateQuantity(item, item.qty + (item.quantityIncrement ?? 1))"
                >
                  <UIcon name="i-lucide-plus" class="block size-4" />
                </button>
              </div>
              <p class="w-24 text-right font-semibold text-slate-800">
                {{ formatPrice(item.price * item.qty) }}
              </p>
              <button
                class="rounded-lg p-2.5 text-slate-400 transition hover:bg-red-50 hover:text-red-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
                :aria-label="`Quitar ${item.name} del carrito`"
                @click="removeItem(item)"
              >
                <UIcon name="i-lucide-trash-2" class="block size-5" />
              </button>
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
              <dt class="text-slate-500">Subtotal ({{ cart.count }} uds.)</dt>
              <dd class="font-medium">{{ formatPrice(cart.subtotal) }}</dd>
            </div>
            <div class="flex justify-between">
              <dt class="text-slate-500">IVA incluido (21 %)</dt>
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
          <div v-if="cart.subtotal < 15000" class="mt-4">
            <p class="text-xs text-slate-500">
              Te faltan <b>{{ formatPrice(15000 - cart.subtotal) }}</b> para el envío por agencia gratis
            </p>
            <div class="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-100">
              <div
                class="h-full rounded-full bg-neteco-500 transition-all"
                :style="{ width: `${Math.min((cart.subtotal / 15000) * 100, 100)}%` }"
              />
            </div>
          </div>
          <p v-else class="mt-3 flex items-center justify-center gap-1.5 text-xs font-medium text-emerald-700">
            <UIcon name="i-lucide-badge-check" class="size-3.5" /> Tienes envío por agencia gratis
          </p>
        </div>
      </div>

      <!-- vacío -->
      <div v-else class="py-20 text-center">
        <UIcon name="i-lucide-shopping-cart" class="mx-auto size-14 text-slate-300" />
        <p class="mt-4 text-lg font-medium text-slate-600">Tu carrito está vacío</p>
        <p class="mt-1 text-sm text-slate-400">Explora el catálogo y añade lo que necesite tu negocio.</p>
        <UButton to="/catalogo" size="lg" class="mt-6" icon="i-lucide-layout-grid">Ver catálogo</UButton>
      </div>

      <template #fallback>
        <div class="py-20 text-center text-slate-400">Cargando carrito…</div>
      </template>
    </ClientOnly>
  </div>
</template>
