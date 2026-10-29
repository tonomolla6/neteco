<script setup lang="ts">
import type { ProductCardData } from '~~/shared/types/catalog'

const props = defineProps<{
  product: ProductCardData
}>()

const showBrand = computed(
  () => !!props.product.brand && !props.product.name.toUpperCase().startsWith(props.product.brand.toUpperCase())
)
</script>

<template>
  <NuxtLink
    :to="`/producto/${product.slug}`"
    class="group flex items-center gap-4 rounded-xl border border-slate-200 bg-white p-3 transition hover:border-neteco-300 hover:shadow-md"
  >
    <div class="w-16 shrink-0 sm:w-20">
      <ProductImage :product="product" />
    </div>

    <div class="min-w-0 flex-1">
      <p v-if="showBrand" class="text-[11px] font-semibold uppercase tracking-wider text-neteco-600">
        {{ product.brand }}
      </p>
      <p class="truncate text-sm font-semibold text-slate-800 group-hover:text-neteco-700">
        {{ product.name }}
      </p>
      <div v-if="product.badges.length" class="mt-1 flex flex-wrap gap-1">
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

    <div class="shrink-0 text-right">
      <p class="text-[11px] text-slate-500">
        {{ product.formats > 1 ? `${product.formats} formatos · desde` : 'IVA incluido' }}
      </p>
      <p class="font-display text-lg font-bold text-slate-900">{{ formatPrice(product.minPrice) }}</p>
    </div>
    <UIcon
      name="i-lucide-chevron-right"
      class="size-4 shrink-0 text-slate-300 transition group-hover:text-neteco-500"
    />
  </NuxtLink>
</template>
