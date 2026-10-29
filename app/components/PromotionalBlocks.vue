<script setup lang="ts">
import {
  promotionalContextSchema,
  promotionalContentSchema,
  type PromotionalContext,
  type PromotionalContent,
  type PromotionalItem
} from '~~/shared/promotional-content'
import { cmsPublicPageSchema, type CmsPublicPage } from '~~/shared/cms-publication'
const props = defineProps<{ context?: PromotionalContext; previewPage?: CmsPublicPage }>()
const runtime = useRuntimeConfig(),
  request = useRequestFetch(),
  { track } = useAnalytics(),
  { preferences } = useConsent()
const snapshot = shallowRef<PromotionalContent | null>(null),
  preview = shallowRef<CmsPublicPage | null>(null),
  failed = ref(false)
const container = ref<HTMLElement | null>(null)
let alive = true,
  generation = 0,
  observationGeneration = 0,
  observer: IntersectionObserver | null = null,
  mounted = false
const visible = new Set<string>(),
  measured = new Set<string>()
const items = computed(() =>
  preview.value?.promotional
    ? [
        {
          pageId: preview.value.pageId,
          version: preview.value.version,
          title: preview.value.title,
          format: preview.value.promotional.format,
          blocks: preview.value.blocks,
          media: preview.value.media,
          publicationId: null
        }
      ]
    : (snapshot.value?.items ?? [])
)
function emitMetric(
  name: 'promotional_impression' | 'promotional_click',
  item: PromotionalItem,
  blockId: string | null
) {
  if (
    !alive ||
    props.previewPage ||
    preferences.value?.analytics !== true ||
    !props.context ||
    runtime.public.serverRuntime !== 'cloudflare'
  )
    return
  void track(name, {
    pageId: item.pageId,
    publicationId: item.publicationId,
    version: item.version,
    placement: props.context.placement,
    blockId
  })
}
function impressions() {
  if (preferences.value?.analytics !== true || props.previewPage || !props.context) return
  for (const item of snapshot.value?.items ?? []) {
    const key = `${item.publicationId}:${item.version}:${props.context.placement}`
    if (!visible.has(item.pageId) || measured.has(key)) continue
    measured.add(key)
    emitMetric('promotional_impression', item, null)
  }
}
function click(pageId: string, blockId: string) {
  const item = snapshot.value?.items.find((row) => row.pageId === pageId)
  if (item?.blocks.some((block) => block.id === blockId && block.type === 'cta'))
    emitMetric('promotional_click', item, blockId)
}
async function observe() {
  const observation = ++observationGeneration
  observer?.disconnect()
  observer = null
  visible.clear()
  await nextTick()
  if (
    !alive ||
    observation !== observationGeneration ||
    !mounted ||
    props.previewPage ||
    !snapshot.value ||
    typeof IntersectionObserver === 'undefined'
  )
    return
  observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const id = entry.target.getAttribute('data-promotional-item')
      if (!id) continue
      if (entry.isIntersecting) visible.add(id)
      else visible.delete(id)
    }
    impressions()
  })
  container.value?.querySelectorAll('[data-promotional-item]').forEach((element) => observer?.observe(element))
}
async function read() {
  const epoch = ++generation
  observationGeneration++
  snapshot.value = null
  preview.value = null
  failed.value = false
  observer?.disconnect()
  visible.clear()
  if (runtime.public.serverRuntime !== 'cloudflare') return
  if (props.previewPage) {
    const parsed = cmsPublicPageSchema.safeParse(props.previewPage)
    if (parsed.success && parsed.data.preview && parsed.data.promotional) preview.value = parsed.data
    else failed.value = true
    return
  }
  const context = promotionalContextSchema.safeParse(props.context)
  if (!context.success) return
  try {
    const raw: unknown = await request('/api/promotional-content', { query: context.data, retry: 0, cache: 'no-store' })
    if (!alive || generation !== epoch) return
    const parsed = promotionalContentSchema.safeParse(raw)
    if (!parsed.success || parsed.data.placement !== context.data.placement) throw Error('content_unconfirmed')
    snapshot.value = parsed.data
    await observe()
  } catch {
    if (alive && generation === epoch) {
      failed.value = true
      snapshot.value = null
    }
  }
}
watch(
  [() => props.context, () => props.previewPage, () => runtime.public.serverRuntime],
  () => {
    void read()
  },
  { deep: true, immediate: true }
)
watch(() => preferences.value?.analytics, impressions)
onMounted(() => {
  mounted = true
  void observe()
})
onBeforeUnmount(() => {
  alive = false
  generation++
  observationGeneration++
  observer?.disconnect()
  snapshot.value = null
  preview.value = null
  visible.clear()
  measured.clear()
})
</script>
<template>
  <section ref="container" aria-label="Información editorial" class="space-y-4">
    <p v-if="failed" data-promotional-unavailable role="status" class="text-sm text-slate-600">
      El contenido editorial no está disponible en este momento.
    </p>
    <article
      v-for="item in items"
      :key="item.pageId"
      :data-promotional-item="item.pageId"
      :data-format="item.format"
      :aria-label="item.title"
      class="min-w-0 break-words rounded-xl border border-slate-200 p-4"
      :class="
        item.format === 'bar'
          ? 'flex flex-wrap items-center gap-4 bg-slate-50'
          : item.format === 'banner'
            ? 'bg-white p-6'
            : 'max-w-xl bg-white'
      "
    >
      <template v-for="block in item.blocks" :key="block.id">
        <component :is="block.level" v-if="block.type === 'heading'" class="text-xl font-semibold">{{
          block.text
        }}</component>
        <p v-else-if="block.type === 'paragraph'" class="whitespace-pre-line">{{ block.text }}</p>
        <ul v-else-if="block.type === 'list'" class="list-disc pl-5">
          <li v-for="(text, index) in block.items" :key="index">{{ text }}</li>
        </ul>
        <figure v-else-if="block.type === 'image'" class="min-w-0">
          <img
            :src="item.media[block.id]"
            :alt="block.alt"
            loading="lazy"
            referrerpolicy="no-referrer"
            class="h-auto max-w-full rounded-lg"
          />
          <figcaption>{{ block.caption }}</figcaption>
        </figure>
        <aside v-else-if="block.type === 'callout'" class="rounded border p-3">
          <h3 class="font-semibold">{{ block.title }}</h3>
          <p class="whitespace-pre-line">{{ block.text }}</p>
        </aside>
        <a
          v-else-if="block.type === 'cta'"
          :href="block.href"
          rel="noreferrer noopener"
          class="inline-flex max-w-full rounded px-3 py-2 font-semibold underline focus-visible:outline-2 focus-visible:outline-offset-2"
          @click="click(item.pageId, block.id)"
          >{{ block.label }}</a
        >
      </template>
    </article>
  </section>
</template>
