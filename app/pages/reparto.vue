<script setup lang="ts">
import DeliveryDriverApp from '../components/DeliveryDriverApp.vue'

definePageMeta({ layout: false })
useHead({
  link: [
    { rel: 'manifest', href: '/reparto.webmanifest' },
    { rel: 'icon', type: 'image/svg+xml', href: '/reparto-icon.svg' }
  ],
  meta: [{ name: 'theme-color', content: '#0f172a' }]
})
useSeoMeta({ title: 'Reparto', robots: 'noindex, nofollow, noarchive' })
</script>

<template>
  <main id="contenido-principal" class="min-h-screen bg-slate-50" tabindex="-1">
    <DeliveryDriverApp />
  </main>
</template>
