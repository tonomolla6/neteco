<script setup lang="ts">
/**
 * Cabecera única de página. Antes cada pantalla inventaba su propio bloque de título
 * con tamaños distintos (`text-2xl`, `text-3xl`, `text-lg`), lo que hacía que dos
 * pantallas contiguas del panel no parecieran del mismo producto.
 *
 * `count` va junto al título, no en una tarjeta aparte: el operario necesita saber
 * cuántas cosas está mirando antes de decidir si filtra.
 */
defineProps<{
  title: string
  description?: string
  count?: number | string
  countLabel?: string
}>()
</script>

<template>
  <div class="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 pb-5">
    <div class="min-w-0">
      <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 class="text-2xl font-bold text-[var(--text-strong)] sm:text-[1.75rem]">{{ title }}</h1>
        <span v-if="count !== undefined" class="tabular text-sm font-medium text-[var(--text-muted)]">
          {{ countLabel ? `${count} ${countLabel}` : count }}
        </span>
      </div>
      <p v-if="description" class="mt-1.5 max-w-2xl text-[var(--text-muted)]">{{ description }}</p>
    </div>
    <div v-if="$slots.actions" class="flex shrink-0 flex-wrap items-center gap-2">
      <slot name="actions" />
    </div>
  </div>
</template>
