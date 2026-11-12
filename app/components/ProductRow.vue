<script setup lang="ts">
import type { ProductCardData } from '~~/shared/types/catalog'

/**
 * Fila de la vista de lista: la misma foto grande que la cuadrícula, con nombre, precio y
 * fecha de entrega al lado, y el pedido directo a la derecha para quien repone y ya sabe
 * lo que quiere. La foto y el nombre llevan a la ficha.
 */
const props = withDefaults(defineProps<{ product: ProductCardData; showBrand?: boolean }>(), { showBrand: false })

const single = computed(() => props.product.single ?? null)
const { label: delivery } = useListingDelivery(() => props.product)
const discount = computed(() => {
  const before = props.product.compareAtPrice
  return before && before > props.product.minPrice ? before : null
})
</script>

<template>
  <article
    data-product-row
    class="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-x-4 gap-y-3 rounded-[var(--radius-surface)] bg-[var(--surface)] p-3 transition-shadow hover:shadow-[var(--shadow-raised)] sm:grid-cols-[11rem_minmax(0,1fr)] sm:p-4 lg:grid-cols-[14rem_minmax(0,1fr)_17rem] lg:items-center lg:gap-x-6"
  >
    <NuxtLink :to="`/producto/${product.slug}`" tabindex="-1" aria-hidden="true" class="block self-start">
      <ProductImage :product="product" bare sizes="(max-width: 640px) 120px, 224px" />
    </NuxtLink>

    <div class="min-w-0">
      <p v-if="showBrand && product.brand" class="text-[13px] font-medium text-[var(--text-muted)]">
        {{ product.brand }}
      </p>
      <h3 class="font-sans text-base font-medium leading-snug tracking-normal sm:text-lg">
        <NuxtLink
          :to="`/producto/${product.slug}`"
          class="line-clamp-3 text-[var(--text-strong)] hover:text-[var(--link)] hover:underline"
        >
          {{ product.name }}
        </NuxtLink>
      </h3>
      <div v-if="product.badges.length" class="mt-1.5 flex flex-wrap items-center gap-1.5">
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
      <PriceBlock
        class="mt-2"
        :gross-cents="product.minPrice"
        :net-cents="product.minNetPrice"
        :from="product.formats > 1"
        :units="single?.units"
        :unit-label="single?.unitLabel"
        :compare-at-cents="discount"
      />
      <p
        data-product-delivery
        class="mt-1.5 min-h-[1.2em] text-[13px] font-semibold leading-tight text-[var(--stock-ok)]"
      >
        {{ delivery }}
      </p>
    </div>

    <div class="col-span-2 flex flex-col gap-2 lg:col-span-1">
      <ProductOrderControls :product="product" />
      <CompareToggle :slug="product.slug" :name="product.name" with-label class="self-start" />
    </div>
  </article>
</template>
