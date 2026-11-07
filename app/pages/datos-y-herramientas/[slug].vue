<script setup lang="ts">
const route = useRoute()
const runtime = useRuntimeConfig()
const slug = computed(() => (typeof route.params.slug === 'string' ? route.params.slug : ''))
useSeoMeta({
  title: () => formatSeoTitle(`Datos y herramientas: ${slug.value.replace(/-/g, ' ')}`),
  description: () =>
    truncateSeoDescription(
      `Datos técnicos verificados, estudio y metodología sobre ${slug.value.replace(/-/g, ' ')} en NETECO.`
    ),
  robots: 'index, follow'
})
useHead(() => ({
  link: [{ rel: 'canonical', href: `${runtime.public.baseUrl}/datos-y-herramientas/${slug.value}` }]
}))
</script>

<template>
  <main><ContentAssetsPanel :slug="slug" /></main>
</template>
