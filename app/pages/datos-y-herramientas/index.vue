<script setup lang="ts">
const runtime = useRuntimeConfig()
useSeoMeta({
  title: 'Datos y herramientas · Neteco',
  description: 'Calculadoras, comparativas, guías, checklists y estudios con metodología y fecha transparentes.',
  robots: 'index, follow'
})
useHead(() => ({ link: [{ rel: 'canonical', href: `${runtime.public.baseUrl}/datos-y-herramientas` }] }))
</script>

<template>
  <main><ContentAssetsPanel /></main>
</template>
