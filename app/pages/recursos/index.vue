<script setup lang="ts">
import ResourceHubPanel from '~/components/ResourceHubPanel.vue'
import { resourceHubListSchema, resourceHubQuerySchema, type ResourceHubList } from '~~/shared/resource-hub'
const runtime = useRuntimeConfig(),
  route = useRoute(),
  snapshot = shallowRef<ResourceHubList | null>(null)
const enabled = computed(() => runtime.public.serverRuntime === 'cloudflare')
useSeoMeta({
  title: 'Recursos profesionales',
  description: 'Guías y recursos conectados al catálogo publicado.',
  robots: () =>
    !enabled.value
      ? isIndexableCatalogQuery(route.query)
        ? 'index, follow'
        : 'noindex, follow'
      : snapshot.value && !snapshot.value.noindex
        ? 'index, follow'
        : 'noindex, follow'
})
const canonicalPath = computed(() => {
  const result = resourceHubQuerySchema.safeParse({
    q: route.query.q,
    category: route.query.category,
    kind: route.query.kind,
    page: route.query.page
  })
  if (result.success && !result.data.q && !result.data.category && !result.data.kind && result.data.page > 1)
    return `/recursos?page=${result.data.page}`
  return '/recursos'
})
useHead(() => ({ link: [{ rel: 'canonical', href: `${runtime.public.baseUrl}${canonicalPath.value}` }] }))
function confirmed(value: unknown) {
  const result = resourceHubListSchema.safeParse(value)
  snapshot.value = result.success ? result.data : null
}
</script>
<template>
  <main>
    <h1 class="mx-auto max-w-5xl px-4 pt-8 text-3xl font-bold">Recursos profesionales</h1>
    <ResourceHubPanel :enabled="enabled" @confirmed="confirmed" />
  </main>
</template>
