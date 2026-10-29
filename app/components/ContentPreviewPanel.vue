<script setup lang="ts">
import { cmsPublicPageSchema } from '~~/shared/cms-publication'
import PromotionalBlocks from './PromotionalBlocks.vue'
const props = defineProps<{ url: string }>()
const snapshot = shallowRef<ReturnType<typeof cmsPublicPageSchema.parse> | null>(null),
  failed = ref(false),
  loading = ref(false)
const requestFetch = useRequestFetch()
let active = true,
  generation = 0
async function read() {
  const epoch = ++generation
  snapshot.value = null
  failed.value = false
  loading.value = true
  try {
    const target = new URL(props.url, 'https://cms.neteco.invalid'),
      match = /^\/contenido\/([a-z0-9][a-z0-9-]{0,159})$/.exec(target.pathname)
    if (
      target.origin !== 'https://cms.neteco.invalid' ||
      !match ||
      target.searchParams.getAll('preview').length !== 1 ||
      [...target.searchParams.keys()].some((k) => k !== 'preview')
    )
      throw new Error('preview_url_unconfirmed')
    const raw: unknown = await requestFetch(`/api/content/${match[1]}`, {
      query: { preview: target.searchParams.get('preview') },
      retry: 0,
      cache: 'no-store'
    })
    if (!active || epoch !== generation) return
    const parsed = cmsPublicPageSchema.safeParse(raw)
    if (!parsed.success || !parsed.data.preview || parsed.data.slug !== match[1])
      throw new Error('preview_snapshot_unconfirmed')
    snapshot.value = parsed.data
  } catch {
    if (active && epoch === generation) failed.value = true
  } finally {
    if (active && epoch === generation) loading.value = false
  }
}
watch(
  () => props.url,
  () => {
    void read()
  },
  { immediate: true }
)
onBeforeUnmount(() => {
  active = false
  generation++
  snapshot.value = null
})
const viewport = computed(() =>
  snapshot.value?.previewDevice === 'mobile' ? '375px' : snapshot.value?.previewDevice === 'desktop' ? '1024px' : '100%'
)
</script>
<template>
  <section aria-label="Vista previa confirmada" class="space-y-3">
    <p v-if="loading" role="status">Confirmando vista previa privada…</p>
    <p v-else-if="failed" role="alert">La vista previa no está confirmada, ha caducado o se ha revocado.</p>
    <template v-if="snapshot">
      <p role="status">Versión {{ snapshot.version }} · {{ snapshot.previewDevice }} · segmento predeterminado</p>
      <div class="overflow-x-auto border border-slate-300 bg-slate-100 p-3">
        <article data-testid="cms-preview-viewport" :style="{ width: viewport }" class="mx-auto min-h-64 bg-white p-6">
          <PromotionalBlocks v-if="snapshot.promotional" :preview-page="snapshot" />
          <template v-else>
            <h1 class="text-3xl font-bold">{{ snapshot.title }}</h1>
            <div v-for="block in snapshot.blocks" :key="block.id" class="my-5">
              <component :is="block.level" v-if="block.type === 'heading'" class="text-xl font-bold">{{
                block.text
              }}</component>
              <p v-else-if="block.type === 'paragraph'" class="whitespace-pre-line">{{ block.text }}</p>
              <ul v-else-if="block.type === 'list'" class="list-disc pl-6">
                <li v-for="(item, index) in block.items" :key="index">{{ item }}</li>
              </ul>
              <figure v-else-if="block.type === 'image'">
                <img :src="snapshot.media[block.id]" :alt="block.alt" referrerpolicy="no-referrer" class="w-full" />
                <figcaption>{{ block.caption }}</figcaption>
              </figure>
              <aside v-else-if="block.type === 'callout'" class="border p-4">
                <h2>{{ block.title }}</h2>
                <p class="whitespace-pre-line">{{ block.text }}</p>
              </aside>
              <p v-else-if="block.type === 'cta'">
                <span class="font-semibold underline">{{ block.label }}</span>
                <span class="text-xs">{{ block.href }}</span>
              </p>
            </div>
          </template>
        </article>
      </div>
    </template>
  </section>
</template>
