<script setup lang="ts">
import type { ProductCardData } from '~~/shared/types/catalog'

/**
 * Acción de un producto en los listados (catálogo, categoría y búsqueda), como en las
 * grandes tiendas: un botón ancho y redondeado «Añadir a la cesta» que mete la cantidad
 * mínima en el carrito sin navegar ni abrirlo, y confirma en el propio botón. Con varios
 * formatos o precio a consultar no adivina: «Ver opciones» lleva a la ficha.
 */
const props = defineProps<{ product: ProductCardData }>()
const order = useListingOrder(() => props.product)
const { onRequest, single, state, announcement, error, canAdd } = order
const direct = computed(() => !onRequest.value && !!single.value)
</script>

<template>
  <div data-listing-action>
    <button
      v-if="direct"
      type="button"
      data-product-add
      :disabled="!canAdd"
      class="inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-full px-4 text-sm font-semibold text-white transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neteco-600 disabled:cursor-not-allowed"
      :class="[
        state === 'added'
          ? 'bg-[var(--stock-ok)]'
          : 'bg-[var(--action)] hover:bg-[var(--action-hover)] disabled:opacity-60'
      ]"
      @click="order.add"
    >
      <UIcon v-if="state === 'added'" name="i-lucide-check" class="size-4 shrink-0" />
      <span class="truncate">{{ state === 'added' ? 'Añadido a la cesta' : 'Añadir a la cesta' }}</span>
    </button>
    <NuxtLink
      v-else
      :to="`/producto/${product.slug}`"
      data-product-options
      class="inline-flex h-10 w-full items-center justify-center rounded-full border border-[var(--border-strong)] bg-[var(--surface)] px-4 text-sm font-semibold text-[var(--text-strong)] transition-colors hover:border-[var(--action)] hover:text-[var(--action)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neteco-600"
    >
      Ver opciones
    </NuxtLink>
    <p aria-live="polite" class="sr-only">{{ announcement }}</p>
    <p v-if="error" role="alert" class="mt-1 text-[13px] text-[var(--ui-error)]">{{ error }}</p>
  </div>
</template>
