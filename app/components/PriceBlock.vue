<script setup lang="ts">
/**
 * El precio, dicho siempre igual en toda la tienda.
 *
 * Cifra principal según el conmutador (sin IVA o con IVA), la otra al lado y, si la unidad
 * de venta tiene contenido conocido, el precio por unidad de medida (€/L, €/kg, €/ud), que
 * es el dato que permite comparar una garrafa de 5 L con una de 20 L.
 */
const props = withDefaults(
  defineProps<{
    grossCents: number
    netCents: number
    /** «desde»: el producto tiene varios formatos y este es el más barato. */
    from?: boolean
    /** Contenido de la unidad de venta y su etiqueta, para el precio por unidad de medida. */
    units?: number | null
    unitLabel?: string | null
    /** Precio anterior real; solo se muestra si es mayor que el actual. */
    compareAtCents?: number | null
    size?: 'listing' | 'detail'
  }>(),
  { from: false, units: null, unitLabel: null, compareAtCents: null, size: 'listing' }
)
const { net } = usePriceDisplay()

const main = computed(() => (net.value ? props.netCents : props.grossCents))
const other = computed(() => (net.value ? props.grossCents : props.netCents))
const offer = computed(() => !!props.compareAtCents && props.compareAtCents > props.grossCents)
const perUnit = computed(() => {
  if (!props.units || !props.unitLabel || props.units <= 0) return ''
  const value = main.value / 100 / props.units
  const digits = value < 0.1 ? 3 : 2
  return `${value.toLocaleString('es-ES', { minimumFractionDigits: digits, maximumFractionDigits: digits })} €/${props.unitLabel}`
})
</script>

<template>
  <div data-product-price>
    <p
      class="tabular font-display font-bold leading-tight"
      :class="[
        size === 'detail' ? 'text-[1.625rem] sm:text-3xl' : 'text-lg',
        offer ? 'text-[var(--price-offer)]' : 'text-[var(--text-strong)]'
      ]"
    >
      <span v-if="from" class="font-sans text-[13px] font-medium text-[var(--text-muted)]">desde </span>
      {{ formatPrice(main) }}
      <span class="font-sans text-[13px] font-medium text-[var(--text-muted)]">
        {{ net ? 'sin IVA' : 'IVA incluido' }}
      </span>
    </p>
    <p class="tabular text-[13px] leading-snug text-[var(--text-muted)]">
      <template v-if="offer">
        <s>{{ formatPrice(compareAtCents!) }}</s> ·
      </template>
      {{ formatPrice(other) }} {{ net ? 'con IVA' : 'sin IVA' }}
      <template v-if="perUnit"> · {{ perUnit }}</template>
    </p>
  </div>
</template>
