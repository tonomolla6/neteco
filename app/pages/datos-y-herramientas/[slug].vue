<script setup lang="ts">
const route = useRoute()
const runtime = useRuntimeConfig()
const slug = computed(() => (typeof route.params.slug === 'string' ? route.params.slug : ''))
useSeoMeta({ title: 'Datos y herramientas · Neteco', robots: 'index, follow' })
useHead(() => ({
  link: [{ rel: 'canonical', href: `${runtime.public.baseUrl}/datos-y-herramientas/${slug.value}` }]
}))
</script>

<template>
  <main><ContentAssetsPanel :slug="slug" /></main>
</template>
