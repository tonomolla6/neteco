<script setup lang="ts">
// Imagen de producto: foto real si existe, ilustración SVG por familia si no.
// Si la foto falla al cargar (fichero pendiente de subir, ruta rota…), cae también a la ilustración.
// Mientras la foto baja, un esqueleto pulsante ocupa su hueco (sin saltos de maquetación).
// Sirve tamaños responsivos y WebP generados automáticamente a partir de la foto master (@nuxt/image).
const props = withDefaults(
  defineProps<{
    product: {
      image?: string | null
      visual?: { type: string; color: string } | null
      name?: string
    }
    sizes?: string
  }>(),
  { sizes: '(max-width: 640px) 45vw, 320px' }
)

const failed = ref(false)
const loaded = ref(false)
watch(
  () => props.product.image,
  () => {
    failed.value = false
    loaded.value = false
  }
)
// los eventos load/error pueden dispararse antes de la hidratación: comprobar al montar
const el = ref<any>(null)
onMounted(() => {
  const img = el.value?.$el as HTMLImageElement | undefined
  if (img?.complete) {
    if (img.naturalWidth === 0) failed.value = true
    else loaded.value = true
  }
})
</script>

<template>
  <div v-if="product.image && !failed" class="relative">
    <div v-if="!loaded" class="absolute inset-0 animate-pulse rounded-2xl bg-slate-100" aria-hidden="true" />
    <NuxtImg
      ref="el"
      :src="product.image"
      :alt="product.name ?? ''"
      :sizes="sizes"
      format="webp"
      loading="lazy"
      class="block aspect-square w-full rounded-2xl border border-slate-100 bg-white object-contain"
      @load="loaded = true"
      @error="failed = true"
    />
  </div>
  <ProductVisual v-else :visual="product.visual" />
</template>
