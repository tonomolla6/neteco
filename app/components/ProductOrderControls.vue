<script setup lang="ts">
import type { ProductCardData } from '~~/shared/types/catalog'

/**
 * Cantidad y «Añadir» de un producto en un listado. Con varios formatos no adivina una
 * variante: lleva a la tabla de formatos de la ficha, donde se piden todos de una vez.
 */
const props = withDefaults(defineProps<{ product: ProductCardData; compact?: boolean }>(), { compact: false })
const order = useListingOrder(() => props.product)
const { single, quantity, maximum, state, announcement, error, canAdd } = order
</script>

<template>
  <div>
    <div v-if="single" class="flex items-center gap-2">
      <QuantityStepper
        v-model="quantity"
        :minimum="single.minimumQuantity"
        :maximum="maximum"
        :step="single.quantityIncrement"
        :label="product.name"
        :compact="compact"
      />
      <button
        type="button"
        data-product-add
        :disabled="!canAdd"
        class="inline-flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-[var(--radius-control)] px-3 text-[15px] font-semibold text-white transition-colors disabled:cursor-not-allowed disabled:opacity-50"
        :class="[
          compact ? 'h-9' : 'h-11',
          state === 'added' ? 'bg-[var(--stock-ok)]' : 'bg-[var(--action)] hover:bg-[var(--action-hover)]'
        ]"
        @click="order.add"
      >
        <UIcon v-if="state === 'added'" name="i-lucide-check" class="size-4 shrink-0" />
        <span>{{ state === 'added' ? 'Añadido' : 'Añadir' }}</span>
      </button>
    </div>
    <NuxtLink
      v-else
      :to="`/producto/${product.slug}`"
      data-product-formats
      class="inline-flex w-full items-center justify-center gap-1.5 rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--surface)] px-3 text-[15px] font-semibold text-[var(--text-strong)] transition-colors hover:border-[var(--action)] hover:text-[var(--action)]"
      :class="compact ? 'h-9' : 'h-11'"
    >
      Elegir entre {{ product.formats }} formatos
    </NuxtLink>
    <p aria-live="polite" class="sr-only">{{ announcement }}</p>
    <p v-if="error" role="alert" class="mt-1 text-[13px] text-[var(--ui-error)]">{{ error }}</p>
  </div>
</template>
