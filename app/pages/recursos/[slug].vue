<script setup lang="ts">
import ResourceHubPanel from '~/components/ResourceHubPanel.vue'
import { resourceHubDetailSchema, type ResourceHubDetail } from '~~/shared/resource-hub'
const route = useRoute(),
  runtime = useRuntimeConfig(),
  snapshot = shallowRef<ResourceHubDetail | null>(null)
const enabled = computed(() => runtime.public.serverRuntime === 'cloudflare'),
  slug = computed(() => (typeof route.params.slug === 'string' ? route.params.slug : ''))
function confirmed(value: unknown) {
  const result = resourceHubDetailSchema.safeParse(value)
  snapshot.value = result.success ? result.data : null
}
useSeoMeta({
  title: () => formatSeoTitle(snapshot.value?.title ?? 'Recurso profesional'),
  description: () =>
    truncateSeoDescription(
      snapshot.value?.description || 'Guía técnica y recurso especializado de higiene profesional en NETECO.'
    ),
  robots: () => (snapshot.value && !snapshot.value.noindex ? 'index, follow' : 'noindex, follow')
})
useHead(() => ({
  link: snapshot.value ? [{ rel: 'canonical', href: `${runtime.public.baseUrl}${snapshot.value.canonicalPath}` }] : []
}))
</script>
<template>
  <main>
    <ResourceHubPanel :enabled="enabled" :slug="slug" @confirmed="confirmed" />
    <ContentTrustPanel v-if="enabled && snapshot" :slug="slug" />
  </main>
</template>
