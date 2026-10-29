<script setup lang="ts">
import type { ContentBlock } from '~~/server/utils/content-schema'
import { cmsPublicPageSchema } from '~~/shared/cms-publication'
import CmsContentBlocks from '~/components/CmsContentBlocks.vue'
import type { ResourceHubMetadata } from '~~/shared/resource-hub'

interface ContentPage {
  title: string
  slug: string
  blocks: ContentBlock[]
  seo: { title: string; description: string; noindex: boolean }
  version: number
  preview: boolean
  previewDevice: string | null
  previewSegment: string | null
  media?: Record<string, string>
  resourceHub?: ResourceHubMetadata | null
}

const route = useRoute()
const runtimeConfig = useRuntimeConfig().public,
  runtime = runtimeConfig.serverRuntime
const { data, error } = await useFetch<ContentPage>(() => `/api/content/${route.params.slug}`, {
  query: { preview: route.query.preview }
})
if (error.value || !data.value)
  throw createError({ statusCode: 404, statusMessage: 'Contenido no encontrado', fatal: true })
const page = computed(() => data.value!)
if (runtime === 'cloudflare') {
  const confirmed = cmsPublicPageSchema.safeParse(data.value)
  if (!confirmed.success) throw createError({ statusCode: 503, statusMessage: 'Contenido no confirmado', fatal: true })
  data.value = confirmed.data
}
useSeoMeta({
  title: () => page.value.seo.title,
  description: () => page.value.seo.description,
  robots: () => (page.value.preview || page.value.seo.noindex ? 'noindex, nofollow, noarchive' : 'index, follow')
})
const canonical = computed(
  () => `${runtimeConfig.baseUrl}/${page.value.resourceHub ? 'recursos' : 'contenido'}/${page.value.slug}`
)
useHead(() => ({
  link: page.value.preview ? [] : [{ rel: 'canonical', href: canonical.value }],
  meta: page.value.preview ? [{ name: 'referrer', content: 'no-referrer' }] : []
}))
const previewWidth = computed(() =>
  page.value.previewDevice === 'mobile' ? '375px' : page.value.previewDevice === 'desktop' ? '1024px' : undefined
)
</script>

<template>
  <article
    class="mx-auto max-w-4xl px-4 py-10"
    :style="page.preview ? { width: previewWidth, maxWidth: 'none' } : undefined"
  >
    <UAlert
      v-if="page.preview"
      class="mb-6"
      color="warning"
      variant="subtle"
      icon="i-lucide-eye"
      title="Vista previa privada"
      :description="`Versión ${page.version} · segmento ${page.previewSegment} · dispositivo ${page.previewDevice}`"
    />
    <h1 class="font-display text-3xl font-bold text-slate-950 sm:text-4xl">{{ page.title }}</h1>
    <CmsContentBlocks :blocks="page.blocks" :media="page.media" :runtime="runtime" />
  </article>
</template>
