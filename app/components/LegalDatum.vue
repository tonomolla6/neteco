<script setup lang="ts">
/**
 * Un dato del titular dentro de un texto legal. Con valor, el valor. Sin valor y fuera de
 * producción, un marcador visible «[pendiente: …]» para que nadie publique el hueco sin
 * verlo. Sin valor en producción, el texto alternativo del slot (o nada): nunca un dato
 * inventado.
 */
defineProps<{ value?: string | number | null; label: string }>()
const production = useRuntimeConfig().public.appEnv === 'production'
</script>

<template>
  <template v-if="value !== undefined && value !== null && value !== ''">{{ value }}</template>
  <mark
    v-else-if="!production"
    data-legal-pending
    class="rounded-[var(--radius-control)] bg-amber-100 px-1 font-medium text-amber-900"
    >[pendiente: {{ label }}]</mark
  >
  <slot v-else />
</template>
