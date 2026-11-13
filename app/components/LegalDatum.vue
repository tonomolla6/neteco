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
    class="rounded-full bg-amber-50 px-2 py-0.5 text-[0.8125em] font-medium text-amber-800 ring-1 ring-inset ring-amber-200"
    >Pendiente: {{ label }}</mark
  >
  <slot v-else />
</template>
