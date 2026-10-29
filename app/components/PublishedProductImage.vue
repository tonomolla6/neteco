<script setup lang="ts">
import { publishedImageSources } from '~/utils/publishedMedia'

const props = withDefaults(
  defineProps<{
    src: string
    alt: string
    sizes: string
    imageClass?: string
    loading?: 'lazy' | 'eager'
  }>(),
  { imageClass: '', loading: 'lazy' }
)
const emit = defineEmits<{ load: []; error: [] }>()
const sources = computed(() => publishedImageSources(props.src))
const image = ref<HTMLImageElement | null>(null)
onMounted(() => {
  // Cached images may finish before Vue attaches the native listeners.
  if (image.value?.complete) {
    if (image.value.naturalWidth > 0) emit('load')
    else emit('error')
  }
})
</script>

<template>
  <picture v-if="sources">
    <source type="image/avif" :srcset="sources.avifSrcset" :sizes="sizes" />
    <source type="image/webp" :srcset="sources.webpSrcset" :sizes="sizes" />
    <img
      ref="image"
      :src="sources.jpeg"
      :srcset="sources.jpegSrcset"
      :sizes="sizes"
      :alt="alt"
      :class="imageClass"
      :loading="loading"
      decoding="async"
      @load="emit('load')"
      @error="emit('error')"
    />
  </picture>
</template>
