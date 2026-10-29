<script setup lang="ts">
/**
 * Imagen de producto: foto real si existe, ilustración de familia si no.
 *
 * La ilustración no es un hueco: dice el formato —garrafa, caja, spray, guante— con
 * el color de la familia, que es información real y útil en una rejilla.
 *
 * Por eso ya **no** lleva encima el cartel «Imagen no disponible». En este catálogo
 * hay 12 de 20 referencias sin fotografía, y ese cartel se repetía once veces en una
 * sola pantalla: convertía una tienda que funciona en una que parece rota, y anunciaba
 * lo que falta en vez de enseñar lo que hay.
 *
 * En la ficha de producto sí conviene decirlo, porque ahí alguien está decidiendo si
 * compra y necesita saber que no se está perdiendo nada: `context="detail"` añade una
 * línea discreta, y además ofrece la salida útil para un proveedor B2B —pedir la foto—
 * en vez de dejar al cliente con la duda.
 *
 * Si la foto falla al cargar (fichero pendiente, ruta rota), cae también a la ilustración.
 * Mientras baja, un esqueleto ocupa su hueco para que no salte la maquetación.
 * Las publicaciones gobernadas sirven AVIF/WebP/JPEG desde el Worker.
 * Las fotos del perfil Node mantienen su transformación @nuxt/image existente.
 */
const props = withDefaults(
  defineProps<{
    product: {
      image?: string | null
      imageAlt?: string | null
      visual?: { type: string; color: string } | null
      name?: string
    }
    sizes?: string
    context?: 'card' | 'detail'
  }>(),
  { sizes: '(max-width: 640px) 45vw, 320px', context: 'card' }
)
const publishedSources = computed(() => publishedImageSources(props.product.image))
const governedMedia = useRuntimeConfig().public.mediaGoverned
const displayImage = computed(() => (governedMedia && !publishedSources.value ? null : props.product.image))

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
const el = ref<{ $el?: HTMLImageElement } | HTMLImageElement | null>(null)
onMounted(() => {
  const img = el.value instanceof HTMLImageElement ? el.value : el.value?.$el
  if (img?.complete) {
    if (img.naturalWidth === 0) failed.value = true
    else loaded.value = true
  }
})
</script>

<template>
  <div v-if="displayImage && !failed" class="relative">
    <div v-if="!loaded" class="absolute inset-0 animate-pulse rounded-2xl bg-slate-100" aria-hidden="true" />
    <PublishedProductImage
      v-if="publishedSources"
      :src="displayImage"
      :alt="product.imageAlt || product.name || ''"
      :sizes="sizes"
      image-class="block aspect-square w-full rounded-2xl border border-slate-100 bg-white object-contain"
      @load="loaded = true"
      @error="failed = true"
    />
    <NuxtImg
      v-else
      ref="el"
      :src="displayImage"
      :alt="product.imageAlt || product.name || ''"
      :sizes="sizes"
      format="webp"
      loading="lazy"
      class="block aspect-square w-full rounded-2xl border border-slate-100 bg-white object-contain"
      @load="loaded = true"
      @error="failed = true"
    />
  </div>
  <div v-else>
    <ProductVisual :visual="product.visual" />
    <p v-if="context === 'detail'" class="mt-2 text-center text-sm text-[var(--text-muted)]">
      Todavía no tenemos foto de esta referencia.
      <NuxtLink to="/contacto" class="font-medium text-neteco-700 underline underline-offset-2"> Pídenosla </NuxtLink>
      y te la mandamos.
    </p>
  </div>
</template>
