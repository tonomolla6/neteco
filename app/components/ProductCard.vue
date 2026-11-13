<script setup lang="ts">
import type { ProductCardData } from '~~/shared/types/catalog'

/**
 * Tarjeta de producto, como en las grandes tiendas: foto libre, nombre, precio y cuándo
 * llega. Toda la tarjeta es un único enlace a la ficha: ahí se elige formato y cantidad.
 *
 * No lleva cantidad, referencia ni disponibilidad. Lo que no se puede servir no se enseña
 * en los listados, y el plazo se dice con la fecha de entrega.
 *
 * Solo en los listados (`listingAction`) añade debajo «Añadir a la cesta» / «Ver opciones».
 * En portada y franjas la tarjeta va sin botones.
 */
const props = withDefaults(
  defineProps<{
    product: ProductCardData
    /** Solo cuando el listado mezcla marcas; si todo es de la misma, es ruido. */
    showBrand?: boolean
    /** Botón «Añadir a la cesta» bajo la fecha de entrega; solo en los listados. */
    listingAction?: boolean
  }>(),
  { showBrand: false, listingAction: false }
)

const single = computed(() => props.product.single ?? null)
const { label: delivery } = useListingDelivery(() => props.product)

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
    data-product-card
    class="group relative flex flex-col rounded-[var(--radius-surface)] bg-[var(--surface)] p-3 transition-shadow hover:shadow-[var(--shadow-overlay)] has-[:focus-visible]:shadow-[var(--shadow-overlay)] sm:p-4"
  >
    <div class="relative">
      <ProductImage
        :product="product"
        bare
        class="transition-transform duration-300 group-hover:scale-[1.03]"
        sizes="(max-width: 640px) 45vw, (max-width: 1280px) 30vw, 280px"
      />
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

    <div class="mt-3 flex min-w-0 flex-1 flex-col">
      <p v-if="showBrand && product.brand" class="text-[13px] font-medium text-[var(--text-muted)]">
        {{ product.brand }}
      </p>
      <h3 class="font-sans text-[15px] font-medium leading-snug tracking-normal">
        <!-- El enlace se estira a toda la tarjeta: un clic en cualquier punto abre la ficha. -->
        <NuxtLink
          :to="`/producto/${product.slug}`"
          class="line-clamp-2 text-[var(--text-strong)] after:absolute after:inset-0 after:rounded-[var(--radius-surface)] after:content-[''] focus-visible:outline-none focus-visible:after:outline focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-neteco-600 group-hover:text-[var(--link)]"
        >
          {{ product.name }}
        </NuxtLink>
      </h3>

      <div class="mt-auto pt-2">
        <PriceBlock
          :gross-cents="product.minPrice"
          :net-cents="product.minNetPrice"
          :from="product.formats > 1"
          :units="single?.units"
          :unit-label="single?.unitLabel"
          :compare-at-cents="discount?.before"
        />
        <!-- Reserva su línea: la fecha llega tras montar y la tarjeta no debe saltar. -->
        <p
          data-product-delivery
          class="mt-1.5 min-h-[2.4em] text-[13px] font-semibold leading-tight text-[var(--stock-ok)] sm:min-h-[1.2em]"
        >
          {{ delivery }}
        </p>
        <!-- Por encima del enlace estirado de la tarjeta, para que el clic sea del botón. -->
        <ProductListingAction v-if="listingAction" :product="product" class="relative z-10 mt-2.5" />
      </div>
    </div>
  </article>
</template>
