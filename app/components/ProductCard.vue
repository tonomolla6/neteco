<script setup lang="ts">
import type { ProductCardData } from '~~/shared/types/catalog'

const props = defineProps<{
  product: ProductCardData
}>()
const runtime = useRuntimeConfig()
const showNetPrices = computed(() => runtime.public.priceDisplayMode === 'net-and-gross')

// con títulos del ERP tipo «NETTION MC», el eyebrow de marca sería redundante
const showBrand = computed(
  () => !!props.product.brand && !props.product.name.toUpperCase().startsWith(props.product.brand.toUpperCase())
)

/**
 * Ahorro sobre el precio anterior. Se muestra solo si es real y significativo: por debajo
 * del 5 % un «−3 %» resta credibilidad en lugar de sumarla.
 */
const discount = computed(() => {
  const before = props.product.compareAtPrice
  const now = props.product.minPrice
  if (!before || before <= now) return null
  const percent = Math.round(((before - now) / before) * 100)
  return percent >= 5 ? { before, percent } : null
})
</script>

<template>
  <NuxtLink
    :to="`/producto/${product.slug}`"
    class="group flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4 transition hover:border-neteco-300 hover:shadow-lg hover:shadow-neteco-500/10"
  >
    <div class="relative">
      <div class="mx-auto w-full max-w-[190px]">
        <ProductImage :product="product" />
      </div>
      <div class="absolute left-2 top-2 flex flex-col items-start gap-1">
        <UBadge v-if="discount" color="error" variant="solid" class="font-bold"> −{{ discount.percent }} % </UBadge>
        <UBadge
          v-for="b in product.badges"
          :key="b"
          :color="BADGES[b]?.color ?? 'neutral'"
          :icon="BADGES[b]?.icon"
          variant="subtle"
        >
          {{ BADGES[b]?.label ?? b }}
        </UBadge>
      </div>
    </div>

    <div>
      <p v-if="showBrand" class="text-[11px] font-semibold uppercase tracking-wider text-neteco-600">
        {{ product.brand }}
      </p>
      <p class="line-clamp-2 text-sm font-semibold leading-snug text-slate-800 group-hover:text-neteco-700">
        {{ product.name }}
      </p>
    </div>

    <div class="mt-auto flex items-end justify-between">
      <div>
        <!-- La base fiscal se dice SIEMPRE igual en todas las tarjetas y el «desde» va pegado
             al importe. Antes un ternario producía tres cualificadores distintos según el
             producto («5 formatos · desde», «IVA incluido», «sin IVA»), de modo que en la misma
             rejilla una tarjeta hablaba de formatos y la de al lado de impuestos, y no se podían
             comparar de un vistazo. -->
        <p
          class="tabular font-display text-lg font-bold"
          :class="discount ? 'text-red-700' : 'text-[var(--text-strong)]'"
        >
          <span v-if="product.formats > 1" class="font-sans text-xs font-medium text-[var(--text-muted)]">desde </span>
          {{ formatPrice(showNetPrices ? product.minNetPrice : product.minPrice) }}
        </p>
        <p class="text-[11px] text-[var(--text-muted)]">
          <template v-if="discount">
            <s class="tabular">{{ formatPrice(discount.before) }}</s> ·
          </template>
          {{ showNetPrices ? 'sin IVA' : 'IVA incluido' }}
          <template v-if="product.formats > 1"> · {{ product.formats }} formatos</template>
        </p>
      </div>
      <span
        class="rounded-full bg-neteco-50 p-2 text-neteco-600 transition group-hover:bg-neteco-500 group-hover:text-white"
      >
        <UIcon name="i-lucide-arrow-right" class="block size-4" />
      </span>
    </div>
  </NuxtLink>
</template>
