<script setup lang="ts">
// Imagen de producto: foto real si existe, ilustración SVG por familia si no.
defineProps<{
  product: {
    image?: string | null
    visual?: { type: string; color: string } | null
    name?: string
  }
}>()
</script>

<template>
  <img
    v-if="product.image"
    :src="product.image"
    :alt="product.name ?? ''"
    loading="lazy"
    class="block aspect-square w-full rounded-2xl border border-slate-100 bg-white object-contain"
  >
  <ProductVisual v-else :visual="product.visual" />
</template>
