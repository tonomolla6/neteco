<script setup lang="ts">
import type { ContentBlock } from '~~/server/utils/content-schema'

interface ContentPage {
  title: string
  slug: string
  blocks: ContentBlock[]
  seo: { title: string; description: string; noindex: boolean }
  version: number
  preview: boolean
  previewDevice: string | null
  previewSegment: string | null
}

const route = useRoute()
const { data, error } = await useFetch<ContentPage>(`/api/content/${route.params.slug}`, {
  query: { preview: route.query.preview }
})
if (error.value || !data.value)
  throw createError({ statusCode: 404, statusMessage: 'Contenido no encontrado', fatal: true })
const page = computed(() => data.value!)
useSeoMeta({
  title: () => page.value.seo.title,
  description: () => page.value.seo.description,
  robots: () => (page.value.preview || page.value.seo.noindex ? 'noindex, nofollow, noarchive' : 'index, follow')
})

function calloutClass(tone: 'info' | 'success' | 'warning') {
  if (tone === 'success') return 'border-emerald-200 bg-emerald-50 text-emerald-950'
  if (tone === 'warning') return 'border-amber-200 bg-amber-50 text-amber-950'
  return 'border-sky-200 bg-sky-50 text-sky-950'
}
</script>

<template>
  <article class="mx-auto max-w-4xl px-4 py-10">
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
    <div class="mt-8 space-y-6">
      <template v-for="block in page.blocks" :key="block.id">
        <component
          :is="block.level"
          v-if="block.type === 'heading'"
          class="font-display font-bold text-slate-900"
          :class="block.level === 'h2' ? 'pt-4 text-2xl' : 'text-xl'"
        >
          {{ block.text }}
        </component>
        <p v-else-if="block.type === 'paragraph'" class="whitespace-pre-line leading-7 text-slate-700">
          {{ block.text }}
        </p>
        <ul v-else-if="block.type === 'list'" class="list-disc space-y-2 pl-6 text-slate-700">
          <li v-for="item in block.items" :key="item">{{ item }}</li>
        </ul>
        <figure v-else-if="block.type === 'image'">
          <NuxtImg
            :src="`/media/${block.assetId}`"
            :alt="block.alt"
            width="1200"
            height="675"
            format="webp"
            class="w-full rounded-2xl border border-slate-200 bg-slate-50"
          />
          <figcaption v-if="block.caption" class="mt-2 text-center text-sm text-slate-500">
            {{ block.caption }}
          </figcaption>
        </figure>
        <aside v-else-if="block.type === 'callout'" class="rounded-2xl border p-5" :class="calloutClass(block.tone)">
          <h2 class="font-bold">{{ block.title }}</h2>
          <p class="mt-1 whitespace-pre-line text-sm leading-6">{{ block.text }}</p>
        </aside>
        <p v-else-if="block.type === 'cta'">
          <UButton :to="block.href" size="lg" icon="i-lucide-arrow-right">{{ block.label }}</UButton>
        </p>
      </template>
    </div>
  </article>
</template>
