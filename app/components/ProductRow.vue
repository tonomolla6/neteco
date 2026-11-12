<script setup lang="ts">
import type { ProductCardData } from '~~/shared/types/catalog'
import { hasPublicPrice } from '~~/shared/price-on-request'

/**
 * Fila de pedido: la vista del profesional que repone. Referencia, formato,
 * disponibilidad, precio —el mismo bloque que la tarjeta— y cantidad con «Añadir».
 */
const props = withDefaults(defineProps<{ product: ProductCardData; showBrand?: boolean }>(), { showBrand: false })

const single = computed(() => props.product.single ?? null)
// Sin precio público el stock no se interpreta: un producto que se pide por teléfono no está «agotado».
const availability = computed(() =>
  single.value && hasPublicPrice(props.product.minPrice) ? variantAvailability(single.value) : null
)
const discount = computed(() => {
  const before = props.product.compareAtPrice
  return before && before > props.product.minPrice ? before : null
})
</script>

<template>
  <article
    class="grid grid-cols-[4rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2 rounded-[var(--radius-surface)] border border-[var(--border)] bg-[var(--surface)] p-3 transition-colors hover:border-[var(--border-strong)] md:grid-cols-[5rem_minmax(0,1fr)_9rem_18rem] md:gap-x-4"
  >
    <NuxtLink :to="`/producto/${product.slug}`" tabindex="-1" aria-hidden="true" class="row-span-2 block md:row-span-1">
      <ProductImage :product="product" />
    </NuxtLink>

    <div class="min-w-0">
      <p v-if="showBrand && product.brand" class="text-[13px] font-medium text-[var(--text-muted)]">
        {{ product.brand }}
      </p>
      <h3 class="font-sans text-[15px] font-semibold leading-snug tracking-normal">
        <NuxtLink
          :to="`/producto/${product.slug}`"
          class="line-clamp-2 text-[var(--text-strong)] hover:text-[var(--link)] hover:underline"
        >
          {{ product.name }}
        </NuxtLink>
      </h3>
      <p v-if="single" class="tabular mt-0.5 text-[13px] font-medium text-[var(--text-muted)]">
        <span data-product-reference>Ref. {{ single.sku }}</span>
        <span aria-hidden="true"> · </span>
        <span data-product-format>{{ single.format }}</span>
      </p>
      <p v-else class="mt-0.5 text-[13px] font-medium text-[var(--text-muted)]">{{ product.formats }} formatos</p>
      <div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
        <p
          v-if="availability"
          data-product-availability
          class="flex items-center gap-1 text-[13px] font-medium"
          :class="availability.tone"
        >
          <UIcon :name="availability.icon" class="size-3.5 shrink-0" />{{ availability.label }}
        </p>
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

    <PriceBlock
      class="col-start-2 md:col-start-auto md:text-right"
      :gross-cents="product.minPrice"
      :net-cents="product.minNetPrice"
      :from="product.formats > 1"
      :units="single?.units"
      :unit-label="single?.unitLabel"
      :compare-at-cents="discount"
    />

    <div class="col-span-2 flex items-center gap-2 md:col-span-1">
      <ProductOrderControls :product="product" class="min-w-0 flex-1" />
      <CompareToggle :slug="product.slug" :name="product.name" class="hidden shrink-0 md:inline-flex" />
    </div>
  </article>
</template>
