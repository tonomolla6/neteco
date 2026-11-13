<script setup lang="ts">
import type { OrderLine } from '~/composables/useAccount'

/**
 * Miniatura de una línea de pedido.
 *
 * No reutiliza `ProductImage` porque ese componente superpone el cartel «Imagen no
 * disponible», que a 40-56 px es ilegible y convierte la fila en ruido. Aquí la
 * ilustración de familia hace de reserva en silencio.
 */
const props = withDefaults(
  defineProps<{
    line: Pick<OrderLine, 'image' | 'visual' | 'name'> & { imageAlt?: string | null }
    size?: 'sm' | 'md' | 'lg'
  }>(),
  { size: 'md' }
)
const governedMedia = useRuntimeConfig().public.mediaGoverned
const publishedSources = computed(() => publishedImageSources(props.line.image))
const displayImage = computed(() => (governedMedia && !publishedSources.value ? null : props.line.image))

const failed = ref(false)
watch(
  () => props.line.image,
  () => (failed.value = false)
)
const SIZE = { sm: 'size-10', md: 'size-14', lg: 'size-20' }
const PIXELS = { sm: 40, md: 56, lg: 80 }
</script>

<template>
  <div
    class="shrink-0 overflow-hidden rounded-[var(--radius-control)] border border-[var(--border)] bg-white"
    :class="SIZE[size]"
  >
    <PublishedProductImage
      v-if="displayImage && publishedSources && !failed"
      :src="displayImage"
      :alt="line.imageAlt || line.name"
      :sizes="`${PIXELS[size]}px`"
      :width="PIXELS[size]"
      :height="PIXELS[size]"
      image-class="size-full object-contain"
      @error="failed = true"
    />
    <img
      v-else-if="displayImage && !failed"
      :src="displayImage"
      :alt="line.imageAlt || line.name"
      :width="PIXELS[size]"
      :height="PIXELS[size]"
      loading="lazy"
      class="size-full object-contain"
      @error="failed = true"
    />
    <ProductVisual v-else :visual="line.visual" />
  </div>
</template>
