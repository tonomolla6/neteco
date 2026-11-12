<script setup lang="ts">
import type { ProductCardData } from '~~/shared/types/catalog'

/**
 * Tarjeta de producto: una superficie de pedido, no un enlace.
 *
 * Quien repone reconoce la referencia del albarán antes que el nombre comercial y quiere
 * añadir sin entrar en la ficha. Por eso solo la imagen y el nombre navegan; la cantidad y
 * «Añadir» son controles propios. El formato va en su línea para que el nombre no lo corte.
 */
const props = withDefaults(
  defineProps<{
    product: ProductCardData
    /** Solo cuando el listado mezcla marcas; si todo es de la misma, es ruido. */
    showBrand?: boolean
  }>(),
  { showBrand: false }
)

const single = computed(() => props.product.single ?? null)
const availability = computed(() => (single.value ? variantAvailability(single.value) : null))

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
  <article
    class="flex flex-col gap-3 rounded-[var(--radius-surface)] border border-[var(--border)] bg-[var(--surface)] p-3 transition-colors hover:border-[var(--border-strong)] sm:p-4"
  >
    <div class="relative">
      <NuxtLink :to="`/producto/${product.slug}`" tabindex="-1" aria-hidden="true" class="mx-auto block max-w-[190px]">
        <ProductImage :product="product" />
      </NuxtLink>
      <div class="pointer-events-none absolute left-0 top-0 flex flex-col items-start gap-1">
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

    <div class="min-w-0">
      <p v-if="showBrand && product.brand" class="text-[13px] font-medium text-[var(--text-muted)]">
        {{ product.brand }}
      </p>
      <h3 class="font-sans text-[15px] font-semibold leading-snug tracking-normal">
        <NuxtLink
          :to="`/producto/${product.slug}`"
          class="line-clamp-3 text-[var(--text-strong)] hover:text-[var(--link)] hover:underline"
        >
          {{ product.name }}
        </NuxtLink>
      </h3>
      <p v-if="single" class="tabular mt-1 text-[13px] font-medium text-[var(--text-muted)]">
        <span data-product-reference>Ref. {{ single.sku }}</span>
        <span aria-hidden="true"> · </span>
        <span data-product-format>{{ single.format }}</span>
      </p>
      <p v-else class="mt-1 text-[13px] font-medium text-[var(--text-muted)]">{{ product.formats }} formatos</p>
      <p
        v-if="availability"
        data-product-availability
        class="mt-1 flex items-center gap-1 text-[13px] font-medium"
        :class="availability.tone"
      >
        <UIcon :name="availability.icon" class="size-3.5 shrink-0" />{{ availability.label }}
      </p>
    </div>

    <div class="mt-auto space-y-3">
      <PriceBlock
        :gross-cents="product.minPrice"
        :net-cents="product.minNetPrice"
        :from="product.formats > 1"
        :units="single?.units"
        :unit-label="single?.unitLabel"
        :compare-at-cents="discount?.before"
      />
      <ProductOrderControls :product="product" />
    </div>
  </article>
</template>
