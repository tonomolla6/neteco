<script setup lang="ts">
import LeadMagnetPanel from '~/components/LeadMagnetPanel.vue'
import { findLeadMagnet } from '~~/shared/lead-magnets'

const route = useRoute()
const runtime = useRuntimeConfig()
const slug = computed(() => (typeof route.params.slug === 'string' ? route.params.slug : ''))
const magnet = computed(() => findLeadMagnet(slug.value))
if (!magnet.value) throw createError({ statusCode: 404, statusMessage: 'Recurso no encontrado' })

useSeoMeta({
  title: () => `${magnet.value?.title ?? 'Recurso profesional'} · Neteco`,
  description: () => magnet.value?.description ?? '',
  robots: 'index, follow'
})
useHead(() => ({
  link: [{ rel: 'canonical', href: `${runtime.public.baseUrl}/herramientas/${slug.value}` }]
}))
</script>

<template>
  <main><LeadMagnetPanel :slug="slug" /></main>
</template>
