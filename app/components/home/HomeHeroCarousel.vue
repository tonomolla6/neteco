<script setup lang="ts">
import type { ProductCardData } from '~~/shared/types/catalog'

/**
 * Carrusel de cabecera de la portada.
 *
 * Alterna fotografías de ambiente (cocina, reparto, comercio…) con productos reales del
 * catálogo: ofertas con su ahorro y destacados. La foto cuenta quién hay detrás; el
 * producto, qué se puede comprar ahora mismo. Sin fotografías publicadas, la primera
 * diapositiva es una superficie de marca con los productos destacados.
 *
 * Accesibilidad (patrón de carrusel de WAI-ARIA):
 * - está siempre en reproducción: avanza solo cada 6 s y, tras usar las flechas, los puntos
 *   o el dedo, sigue avanzando desde la diapositiva elegida. Solo se detiene con el botón de
 *   pausa, que siempre está visible (WCAG 2.2.2), o mientras se arrastra con el dedo;
 * - con `prefers-reduced-motion` no avanza solo;
 * - las diapositivas fuera de vista son `inert`, para que el tabulador no se pierda en ellas;
 * - en móvil se desliza con el dedo (scroll-snap nativo), sin librerías.
 */
interface ProductSlide {
  kind: 'product'
  key: string
  product: ProductCardData
  label: string
}
interface BrandSlide {
  kind: 'brand'
  key: string
  image: HomeImage | null
  /**
   * Punto de la foto que nunca debe recortarse (`object-position`). Las fotos son muy
   * apaisadas y las caras quedan arriba: se ancla el borde superior para no cortar cabezas,
   * y en móvil, donde se recorta a lo ancho, se centra en la persona protagonista.
   */
  focus: string
  title: string
  text: string
  to: string
  cta: string
}
type Slide = ProductSlide | BrandSlide

const props = withDefaults(
  defineProps<{
    offers: ProductCardData[]
    featured: ProductCardData[]
    /** Con la portada de recompra encima, el titular de la página ya existe y aquí baja a h2. */
    heading?: 'h1' | 'h2'
  }>(),
  { heading: 'h1' }
)

const { terms, ownDelivery } = useCommercialTerms()

const intro = computed<BrandSlide>(() => ({
  kind: 'brand',
  key: 'intro',
  image: homeImage('hero-cocina'),
  focus: '54% 0%',
  title: 'Limpieza profesional, higiene y menaje para tu negocio',
  text: terms.value.foundedYear
    ? `Desde ${terms.value.foundedYear} en Ontinyent. Químicos, celulosa, guantes y menaje para hostelería, comercio, industria y colectividades.`
    : 'Químicos, celulosa, guantes y menaje para hostelería, comercio, industria y colectividades.',
  to: '/catalogo',
  cta: 'Ver el catálogo'
}))

const brandSlides = computed<BrandSlide[]>(() =>
  [
    {
      kind: 'brand' as const,
      key: 'reparto',
      image: homeImage('hero-reparto-bar'),
      focus: '48% 0%',
      title: 'Te lo llevamos nosotros',
      text: ownDelivery.value.text,
      to: '/envios',
      cta: 'Ver días de reparto'
    },
    {
      kind: 'brand' as const,
      key: 'hotel',
      image: homeImage('hero-hotel'),
      focus: '70% 0%',
      title: 'Para hoteles, residencias y colectividades',
      text: 'Higiene, celulosa y protección con formatos profesionales y precio por volumen.',
      to: '/catalogo',
      cta: 'Ver productos'
    },
    {
      kind: 'brand' as const,
      key: 'pedido',
      image: homeImage('hero-almacen'),
      focus: '27% 0%',
      title: '¿Ya sabes lo que necesitas?',
      text: 'Escribe las referencias o pega tu lista y añádelo todo al carrito en un minuto.',
      to: '/pedido-rapido',
      cta: 'Hacer un pedido rápido'
    },
    {
      kind: 'brand' as const,
      key: 'comercio',
      image: homeImage('hero-comercio'),
      focus: '50% 0%',
      title: 'Tu local, a punto cada mañana',
      text: 'Limpiadores, ambientadores y útiles para comercio y oficina.',
      to: '/catalogo',
      cta: 'Ver el catálogo'
    }
  ].filter((slide) => slide.image)
)

const productSlides = computed<ProductSlide[]>(() => {
  const seen = new Set<number>()
  const picked: ProductSlide[] = []
  for (const product of props.offers) {
    if (seen.has(product.id)) continue
    seen.add(product.id)
    picked.push({ kind: 'product', key: `p-${product.id}`, product, label: 'Oferta' })
  }
  for (const product of props.featured) {
    if (seen.has(product.id)) continue
    seen.add(product.id)
    picked.push({ kind: 'product', key: `p-${product.id}`, product, label: 'Destacado' })
  }
  // Primero los que tienen foto: una diapositiva con la ilustración de reserva no vende.
  return picked.sort((left, right) => Number(!!right.product.image) - Number(!!left.product.image)).slice(0, 5)
})

/** Intro, y después producto y foto de ambiente alternados. */
const slides = computed<Slide[]>(() => {
  const out: Slide[] = [intro.value]
  const brands = [...brandSlides.value]
  const products = [...productSlides.value]
  while ((brands.length || products.length) && out.length < 8) {
    if (products.length) out.push(products.shift()!)
    if (brands.length && out.length < 8) out.push(brands.shift()!)
  }
  return out
})

/** Productos para la composición de la intro cuando no hay foto de cabecera. */
const introProducts = computed(() =>
  [...props.featured, ...props.offers].filter((product) => product.image).slice(0, 3)
)

function discount(product: ProductCardData) {
  const before = product.compareAtPrice
  if (!before || before <= product.minPrice) return null
  const percent = Math.round(((before - product.minPrice) / before) * 100)
  return percent >= 5 ? percent : null
}

const index = ref(0)
const touching = ref(false)
const hovered = ref(false)
const focused = ref(false)
const stopped = ref(false)
const reducedMotion = ref(false)
const track = ref<HTMLElement | null>(null)
let timer: ReturnType<typeof setInterval> | undefined
let frame = 0
/** Mientras dura un desplazamiento pedido por código, el índice ya es el de destino. */
let settleUntil = 0

const playing = computed(
  () => !stopped.value && !reducedMotion.value && !hovered.value && !focused.value && slides.value.length > 1
)

function togglePlaying() {
  stopped.value = !stopped.value
  if (!stopped.value) {
    hovered.value = false
    focused.value = false
    restart()
  }
}

function onFocusOut(event: FocusEvent) {
  focused.value =
    event.relatedTarget instanceof Node && (event.currentTarget as HTMLElement).contains(event.relatedTarget)
}

function go(next: number, behavior: ScrollBehavior = 'smooth') {
  const count = slides.value.length
  if (!count) return
  index.value = (next + count) % count
  settleUntil = Date.now() + 700
  const element = track.value
  if (element) element.scrollTo({ left: index.value * element.clientWidth, behavior })
}

/** Un gesto del visitante no detiene el pase: reinicia la cuenta desde la diapositiva elegida. */
function userGo(next: number) {
  go(next)
  restart()
}

function restart() {
  clearInterval(timer)
  timer = setInterval(() => {
    if (playing.value && !touching.value && document.visibilityState === 'visible') go(index.value + 1)
  }, 6000)
}

function onScroll() {
  if (Date.now() < settleUntil) return
  cancelAnimationFrame(frame)
  frame = requestAnimationFrame(() => {
    const element = track.value
    if (!element || !element.clientWidth) return
    index.value = Math.min(Math.round(element.scrollLeft / element.clientWidth), slides.value.length - 1)
  })
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'ArrowRight') userGo(index.value + 1)
  else if (event.key === 'ArrowLeft') userGo(index.value - 1)
}

onMounted(() => {
  reducedMotion.value = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  restart()
})
onBeforeUnmount(() => {
  clearInterval(timer)
  cancelAnimationFrame(frame)
})
</script>

<template>
  <section
    data-home-hero
    aria-roledescription="carrusel"
    aria-label="Novedades y ofertas"
    class="relative bg-neteco-950"
    @keydown="onKeydown"
    @mouseenter="hovered = true"
    @mouseleave="hovered = false"
    @focusin="focused = true"
    @focusout="onFocusOut"
  >
    <div
      ref="track"
      class="scrollbar-none flex snap-x snap-mandatory overflow-x-auto overscroll-x-contain"
      :aria-live="playing ? 'off' : 'polite'"
      @scroll.passive="onScroll"
      @touchstart.passive="touching = true"
      @touchend.passive="((touching = false), restart())"
      @touchcancel.passive="((touching = false), restart())"
    >
      <div
        v-for="(slide, position) in slides"
        :key="slide.key"
        role="group"
        aria-roledescription="diapositiva"
        :aria-label="`${position + 1} de ${slides.length}`"
        :inert="position !== index || undefined"
        class="relative h-[460px] w-full shrink-0 snap-start overflow-hidden sm:h-[400px] lg:h-[460px]"
      >
        <!-- Foto de ambiente: imagen a sangre y el texto sobre una veladura de marca -->
        <template v-if="slide.kind === 'brand'">
          <img
            v-if="slide.image"
            :src="slide.image.src"
            :alt="slide.image.alt"
            :width="slide.image.width"
            :height="slide.image.height"
            :loading="position === 0 ? 'eager' : 'lazy'"
            :fetchpriority="position === 0 ? 'high' : 'auto'"
            class="absolute inset-0 h-full w-full object-cover"
            :style="{ objectPosition: slide.focus }"
          />
          <div
            v-if="slide.image"
            aria-hidden="true"
            class="absolute inset-0 bg-gradient-to-t from-neteco-950 via-neteco-950/55 to-transparent sm:bg-gradient-to-r sm:from-neteco-950/95 sm:via-neteco-950/70 sm:to-transparent"
          />
          <!-- Sin foto: superficie de marca con los productos destacados a la derecha -->
          <div
            v-else-if="introProducts.length"
            aria-hidden="true"
            class="absolute inset-y-0 right-0 hidden w-[46%] items-center justify-center gap-4 pr-8 md:flex"
          >
            <div
              v-for="(product, n) in introProducts"
              :key="product.id"
              class="w-44 rounded-[var(--radius-panel)] bg-white p-3 shadow-[var(--shadow-overlay)] lg:w-52"
              :class="n === 1 ? '-translate-y-6' : 'translate-y-6'"
            >
              <ProductImage :product="product" sizes="208px" />
            </div>
          </div>
          <div
            class="relative mx-auto flex h-full max-w-[1600px] flex-col justify-end px-4 pb-20 sm:justify-center sm:px-6 sm:pb-12 md:px-20"
          >
            <div class="max-w-xl">
              <component
                :is="position === 0 ? heading : 'p'"
                class="font-display text-[28px] font-bold leading-[1.15] tracking-tight text-white sm:text-4xl lg:text-[44px]"
              >
                {{ slide.title }}
              </component>
              <p class="mt-3 text-base text-neteco-100 sm:text-lg">{{ slide.text }}</p>
              <div class="mt-6 flex flex-wrap gap-3">
                <NuxtLink
                  :to="slide.to"
                  class="inline-flex h-12 items-center gap-2 rounded-[var(--radius-control)] bg-white px-6 text-[15px] font-semibold text-neteco-900 transition-colors hover:bg-neteco-50"
                >
                  {{ slide.cta }} <UIcon name="i-lucide-arrow-right" class="size-4" />
                </NuxtLink>
                <NuxtLink
                  v-if="position === 0"
                  to="/pedido-rapido"
                  class="inline-flex h-12 items-center gap-2 rounded-[var(--radius-control)] border border-white/50 px-5 text-[15px] font-semibold text-white transition-colors hover:bg-white/10"
                >
                  Pedir por referencia
                </NuxtLink>
              </div>
            </div>
          </div>
        </template>

        <!-- Producto real: ficha corta y su foto en grande -->
        <NuxtLink
          v-else
          :to="`/producto/${slide.product.slug}`"
          class="group grid h-full bg-white sm:grid-cols-[1fr_1fr]"
          :aria-label="`${slide.label}: ${slide.product.name}`"
        >
          <div
            class="order-2 flex min-w-0 flex-col justify-start px-4 pb-16 pt-4 sm:order-1 sm:justify-center sm:px-6 sm:pb-12 md:pl-20 2xl:pl-[max(5rem,calc((100vw_-_1600px)/2_+_5rem))]"
          >
            <p class="flex items-center gap-2 text-sm font-semibold">
              <span v-if="discount(slide.product)" class="text-[var(--price-offer)]"
                >Ahorra un {{ discount(slide.product) }} %</span
              >
              <span v-else class="text-[var(--text-muted)]">{{ slide.label }}</span>
              <span v-if="slide.product.brand" class="font-medium text-[var(--text-muted)]"
                >· {{ slide.product.brand }}</span
              >
            </p>
            <p
              class="mt-2 line-clamp-2 font-display text-2xl font-bold leading-tight text-[var(--text-strong)] group-hover:text-[var(--link)] sm:text-3xl lg:text-4xl"
            >
              {{ slide.product.name }}
            </p>
            <p v-if="slide.product.shortDesc" class="mt-2 hidden text-[15px] text-[var(--text)] sm:line-clamp-2">
              {{ slide.product.shortDesc }}
            </p>
            <div class="mt-3">
              <PriceBlock
                :gross-cents="slide.product.minPrice"
                :net-cents="slide.product.minNetPrice"
                :from="slide.product.formats > 1"
                :compare-at-cents="discount(slide.product) ? slide.product.compareAtPrice : null"
                size="detail"
              />
            </div>
            <span
              class="mt-4 hidden h-12 w-fit items-center gap-2 rounded-[var(--radius-control)] bg-[var(--action)] sm:inline-flex px-6 text-[15px] font-semibold text-white transition-colors group-hover:bg-[var(--action-hover)]"
            >
              Ver producto <UIcon name="i-lucide-arrow-right" class="size-4" />
            </span>
          </div>
          <div class="order-1 flex min-h-0 items-center justify-center bg-[var(--canvas)] p-4 sm:order-2 sm:p-8">
            <div class="aspect-square h-full max-h-[180px] sm:max-h-[310px] lg:max-h-[370px]">
              <ProductImage
                :product="slide.product"
                sizes="(min-width: 640px) 340px, 180px"
                class="transition-transform duration-300 group-hover:scale-[1.02]"
              />
            </div>
          </div>
        </NuxtLink>
      </div>
    </div>

    <!-- Controles: flechas a los lados en escritorio; puntos y pausa abajo, al alcance del pulgar -->
    <template v-if="slides.length > 1">
      <button
        type="button"
        class="absolute left-3 top-1/2 hidden size-11 -translate-y-1/2 place-items-center rounded-full bg-white/90 text-[var(--text-strong)] shadow-[var(--shadow-overlay)] transition hover:bg-white md:grid"
        aria-label="Diapositiva anterior"
        @click="userGo(index - 1)"
      >
        <UIcon name="i-lucide-chevron-left" class="size-5" />
      </button>
      <button
        type="button"
        class="absolute right-3 top-1/2 hidden size-11 -translate-y-1/2 place-items-center rounded-full bg-white/90 text-[var(--text-strong)] shadow-[var(--shadow-overlay)] transition hover:bg-white md:grid"
        aria-label="Diapositiva siguiente"
        @click="userGo(index + 1)"
      >
        <UIcon name="i-lucide-chevron-right" class="size-5" />
      </button>
      <div
        class="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full bg-white/95 px-2 py-1 shadow-[var(--shadow-raised)]"
      >
        <button
          v-if="!reducedMotion"
          type="button"
          class="grid size-8 place-items-center rounded-full text-[var(--text-strong)] hover:bg-[var(--surface-sunken)]"
          :aria-label="stopped ? 'Reanudar el pase automático' : 'Pausar el pase automático'"
          @click="togglePlaying"
        >
          <UIcon :name="stopped ? 'i-lucide-play' : 'i-lucide-pause'" class="size-4" />
        </button>
        <button
          v-for="(slide, position) in slides"
          :key="slide.key"
          type="button"
          class="grid h-8 w-6 place-items-center"
          :aria-label="`Ir a la diapositiva ${position + 1}`"
          :aria-current="position === index ? 'true' : undefined"
          @click="userGo(position)"
        >
          <span
            class="block h-2 rounded-full transition-all"
            :class="position === index ? 'w-5 bg-neteco-700' : 'w-2 bg-slate-300'"
          />
        </button>
      </div>
    </template>
  </section>
</template>
