<script setup lang="ts">
const props = defineProps<{
  product: {
    slug: string
    name: string
    brand: string
    badges: string[]
    visual: { type: string; color: string }
    image?: string | null
    shortDesc?: string | null
    minPrice: number
    formats: number
  }
}>()

// con títulos del ERP tipo «NETTION MC», el eyebrow de marca sería redundante
const showBrand = computed(
  () => !!props.product.brand && !props.product.name.toUpperCase().startsWith(props.product.brand.toUpperCase())
)
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
        <UBadge
          v-for="b in product.badges"
          :key="b"
          :color="BADGES[b]?.color ?? 'neutral'"
          :icon="BADGES[b]?.icon"
          variant="subtle"
          size="sm"
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
        <p class="text-[11px] text-slate-400">
          {{ product.formats > 1 ? `${product.formats} formatos · desde` : 'IVA incluido' }}
        </p>
        <p class="font-display text-lg font-bold text-slate-900">{{ formatPrice(product.minPrice) }}</p>
      </div>
      <span
        class="rounded-full bg-neteco-50 p-2 text-neteco-600 transition group-hover:bg-neteco-500 group-hover:text-white"
      >
        <UIcon name="i-lucide-arrow-right" class="block size-4" />
      </span>
    </div>
  </NuxtLink>
</template>
