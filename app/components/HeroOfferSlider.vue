<script setup lang="ts">
import type { ProductCardData } from '~~/shared/types/catalog'

/**
 * Carrusel de ofertas del hero, a sangre.
 *
 * Sustituye a la ilustración decorativa de envases con el pie «Cada familia, con su color.
 * Como en tu almacén.»: era bonita, pero no llevaba a ningún sitio ni vendía nada, y
 * ocupaba la mitad del espacio más caro de la tienda. Los tres mayoristas del sector con
 * los que se comparó —Shalbaida, Muñoz Bosch y Plasticosur— usan ese hueco para un
 * carrusel promocional, porque es lo primero que mira quien repone cada mes.
 *
 * El hero es partido: el mensaje sobre el azul de marca y la oferta sobre un panel claro
 * que llega al borde. Las fotos de producto vienen con fondo blanco de estudio, así que
 * sobre el degradado se leerían siempre como un recorte pegado.
 *
 * Avanza solo cada 6 s, se detiene al pasar el ratón o al enfocar con teclado, y no se
 * mueve si el sistema pide movimiento reducido.
 */
const props = defineProps<{ items: ProductCardData[] }>()

const index = ref(0)
const paused = ref(false)
const failed = ref<Record<number, boolean>>({})
let timer: ReturnType<typeof setInterval> | undefined

const current = computed(() => props.items[index.value])
const governedMedia = useRuntimeConfig().public.mediaGoverned
const publishedSources = computed(() => publishedImageSources(current.value?.image))
const displayImage = computed(() => (governedMedia && !publishedSources.value ? null : current.value?.image))
watch(
  () => props.items.map((item) => [item.id, item.image]),
  (next, previous) => {
    next.forEach(([id, image], position) => {
      if (previous?.[position]?.[0] !== id || previous?.[position]?.[1] !== image) failed.value[position] = false
    })
    if (index.value >= props.items.length) index.value = 0
  }
)

function discount(item: ProductCardData) {
  const before = item.compareAtPrice
  if (!before || before <= item.minPrice) return null
  return Math.round(((before - item.minPrice) / before) * 100)
}

function go(next: number) {
  if (!props.items.length) return
  index.value = (next + props.items.length) % props.items.length
}

onMounted(() => {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  timer = setInterval(() => {
    if (!paused.value && props.items.length > 1) go(index.value + 1)
  }, 6000)
})
onBeforeUnmount(() => clearInterval(timer))
</script>

<template>
  <div
    v-if="current"
    class="relative"
    @mouseenter="paused = true"
    @mouseleave="paused = false"
    @focusin="paused = true"
    @focusout="paused = false"
  >
    <NuxtLink :to="`/producto/${current.slug}`" class="block">
      <!-- La imagen manda: sin marco ni tarjeta, sobre el panel claro del hero -->
      <div class="relative flex h-72 items-center justify-center">
        <PublishedProductImage
          v-if="displayImage && publishedSources && !failed[index]"
          :key="current.id"
          :src="displayImage"
          :alt="current.imageAlt || current.name"
          sizes="(min-width: 1024px) 400px, 90vw"
          loading="eager"
          image-class="max-h-72 max-w-full object-contain"
          @error="failed[index] = true"
        />
        <img
          v-else-if="displayImage && !failed[index]"
          :key="current.id"
          :src="displayImage"
          :alt="current.imageAlt || current.name"
          width="400"
          height="288"
          class="max-h-full max-w-full object-contain"
          @error="failed[index] = true"
        />
        <div v-else class="w-56"><ProductVisual :visual="current.visual" /></div>

        <span
          v-if="discount(current)"
          class="absolute left-0 top-0 rounded-[var(--radius-control)] bg-red-600 px-3 py-1.5 text-sm font-bold text-white shadow-lg"
        >
          −{{ discount(current) }} %
        </span>
      </div>

      <div class="mt-4">
        <p class="text-xs font-semibold uppercase tracking-wider text-neteco-700">
          Oferta<template v-if="current.brand"> · {{ current.brand }}</template>
        </p>
        <p class="mt-1 line-clamp-2 text-lg font-semibold leading-snug text-[var(--text-strong)]">{{ current.name }}</p>
        <div class="mt-2 flex items-baseline gap-2">
          <span
            class="tabular font-display text-3xl font-bold"
            :class="discount(current) ? 'text-red-700' : 'text-[var(--text-strong)]'"
          >
            <span v-if="current.formats > 1" class="font-sans text-sm font-medium text-[var(--text-muted)]"
              >desde
            </span>
            {{ formatPrice(current.minPrice) }}
          </span>
          <s v-if="discount(current)" class="tabular text-base text-[var(--text-muted)]">
            {{ formatPrice(current.compareAtPrice!) }}
          </s>
        </div>
      </div>
    </NuxtLink>

    <div v-if="items.length > 1" class="mt-4 flex items-center justify-between">
      <div class="flex">
        <button
          v-for="(item, position) in items"
          :key="item.id"
          type="button"
          class="grid size-6 place-items-center px-1"
          :aria-label="`Ver oferta ${position + 1} de ${items.length}`"
          :aria-current="position === index"
          @click="go(position)"
        >
          <!-- El punto es de 6 px pero el botón mide 24: WCAG 2.2 exige ese tamaño mínimo
               de destino táctil, y con 6 px era imposible acertar en un móvil. -->
          <span
            class="block h-1.5 w-full rounded-full transition-colors"
            :class="position === index ? 'bg-neteco-600' : 'bg-slate-300 group-hover:bg-slate-400'"
          />
        </button>
      </div>
      <div class="flex gap-1">
        <button
          type="button"
          class="rounded-[var(--radius-control)] border border-[var(--border-strong)] p-1.5 text-[var(--text-muted)] transition hover:bg-[var(--canvas)]"
          aria-label="Oferta anterior"
          @click="go(index - 1)"
        >
          <UIcon name="i-lucide-chevron-left" class="block size-4" />
        </button>
        <button
          type="button"
          class="rounded-[var(--radius-control)] border border-[var(--border-strong)] p-1.5 text-[var(--text-muted)] transition hover:bg-[var(--canvas)]"
          aria-label="Oferta siguiente"
          @click="go(index + 1)"
        >
          <UIcon name="i-lucide-chevron-right" class="block size-4" />
        </button>
      </div>
    </div>
  </div>
</template>
