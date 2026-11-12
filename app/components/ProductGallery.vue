<script setup lang="ts">
import { DialogContent, DialogDescription, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui'

/**
 * Galería de la ficha, al estilo de las grandes tiendas: miniaturas siempre visibles (nunca
 * puntos que escondan fotos), la foto cambia al pasar el ratón o al pulsar, lupa al pasar sobre
 * la imagen en escritorio y visor a pantalla completa con deslizamiento, doble toque y
 * pellizco en el móvil.
 *
 * Las fuentes llegan ya filtradas por la ficha (publicación gobernada o foto local en
 * desarrollo). Una foto que falla al cargar desaparece de la galería; si no queda ninguna, se
 * enseña el contenido de la ranura `empty`.
 */
export interface GalleryImage {
  src: string
  alt: string
}

const props = defineProps<{
  images: GalleryImage[]
  name: string
  /** Cambia al elegir otro formato: la galería vuelve a la primera foto. */
  contextKey?: string | number
}>()

const imgApi = useImage()
const runtime = useRuntimeConfig()
const governed = Boolean(runtime.public.mediaGoverned)

const failed = ref(new Set<string>())
const shown = computed(() => props.images.filter((image) => !failed.value.has(image.src)))
const active = ref(0)
const current = computed(() => shown.value[Math.min(active.value, shown.value.length - 1)] ?? null)
const loaded = ref(false)

watch(
  () => [props.contextKey, props.images.map((image) => image.src).join('|')],
  () => {
    active.value = 0
    failed.value = new Set()
  }
)
watch(current, () => (loaded.value = false))

function sized(src: string, width: 128 | 800 | 1200 | 1600) {
  return (
    publishedImageUrl(src, width, 'jpeg') ??
    (governed ? '' : imgApi(src, { format: 'webp', quality: width > 800 ? 85 : 80, width }))
  )
}
function fail(src: string) {
  failed.value = new Set([...failed.value, src])
}
function select(index: number) {
  if (index >= 0 && index < shown.value.length) active.value = index
}
function step(delta: number) {
  if (!shown.value.length) return
  active.value = (active.value + delta + shown.value.length) % shown.value.length
}

// --- Lupa de escritorio: la foto se amplía dentro de su marco siguiendo al ratón.
const lens = reactive({ on: false, x: 50, y: 50 })
function lensMove(event: PointerEvent) {
  if (event.pointerType !== 'mouse' || !(event.currentTarget instanceof HTMLElement)) return
  const rect = event.currentTarget.getBoundingClientRect()
  lens.on = true
  lens.x = Math.min(100, Math.max(0, ((event.clientX - rect.left) / rect.width) * 100))
  lens.y = Math.min(100, Math.max(0, ((event.clientY - rect.top) / rect.height) * 100))
}

// --- Carrusel móvil: desplazamiento nativo con «scroll-snap»; el índice sigue al scroll.
const track = useTemplateRef<HTMLElement>('track')
function trackScroll() {
  const element = track.value
  if (!element || !element.clientWidth) return
  const index = Math.round(element.scrollLeft / element.clientWidth)
  if (index !== active.value) active.value = index
}
watch(active, (index) => {
  const element = track.value
  if (!element || !element.clientWidth) return
  const target = index * element.clientWidth
  if (Math.abs(element.scrollLeft - target) > 4) element.scrollTo({ left: target, behavior: 'smooth' })
})

// --- Miniaturas: teclado con flechas, Inicio y Fin (patrón de lista de opciones).
function thumbKeydown(event: KeyboardEvent, index: number) {
  const keys: Record<string, number> = {
    ArrowDown: index + 1,
    ArrowRight: index + 1,
    ArrowUp: index - 1,
    ArrowLeft: index - 1,
    Home: 0,
    End: shown.value.length - 1
  }
  const next = keys[event.key]
  if (next === undefined) return
  event.preventDefault()
  const target = (next + shown.value.length) % shown.value.length
  select(target)
  const list = (event.currentTarget as HTMLElement).parentElement
  ;(list?.children[target] as HTMLElement | undefined)?.focus()
}

// --- Visor a pantalla completa.
const viewer = ref(false)
const zoom = ref(1)
const offset = reactive({ x: 0, y: 0 })
function resetZoom() {
  zoom.value = 1
  offset.x = 0
  offset.y = 0
}
function open(index = active.value) {
  select(index)
  resetZoom()
  viewer.value = true
}
watch(viewer, (value) => {
  if (!value) resetZoom()
})
watch(active, resetZoom)

const pointers = new Map<number, { x: number; y: number }>()
let gesture: { distance: number; zoom: number; x: number; y: number; ox: number; oy: number; t: number } | null = null
let lastTap = 0
function clampOffset() {
  const limit = (zoom.value - 1) * 50
  offset.x = Math.max(-limit, Math.min(limit, offset.x))
  offset.y = Math.max(-limit, Math.min(limit, offset.y))
}
function distance() {
  const [a, b] = [...pointers.values()]
  return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0
}
function pointerDown(event: PointerEvent) {
  ;(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
  gesture = {
    distance: distance(),
    zoom: zoom.value,
    x: event.clientX,
    y: event.clientY,
    ox: offset.x,
    oy: offset.y,
    t: Date.now()
  }
}
function pointerMove(event: PointerEvent) {
  if (!pointers.has(event.pointerId) || !gesture) return
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
  if (pointers.size === 2 && gesture.distance) {
    zoom.value = Math.max(1, Math.min(4, (gesture.zoom * distance()) / gesture.distance))
    clampOffset()
  } else if (pointers.size === 1 && zoom.value > 1) {
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect()
    offset.x = gesture.ox + ((event.clientX - gesture.x) / box.width) * 100
    offset.y = gesture.oy + ((event.clientY - gesture.y) / box.height) * 100
    clampOffset()
  }
}
function pointerUp(event: PointerEvent) {
  const start = gesture
  pointers.delete(event.pointerId)
  if (pointers.size) {
    // Queda un dedo tras el pellizco: el arrastre sigue desde aquí.
    const [rest] = [...pointers.values()]
    gesture = rest
      ? { distance: 0, zoom: zoom.value, x: rest.x, y: rest.y, ox: offset.x, oy: offset.y, t: Date.now() }
      : null
    return
  }
  gesture = null
  if (!start || zoom.value > 1.05) {
    if (zoom.value <= 1.05) resetZoom()
    return
  }
  const dx = event.clientX - start.x
  const dy = event.clientY - start.y
  // Deslizar a los lados cambia de foto; un toque doble amplía.
  if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
    step(dx < 0 ? 1 : -1)
    return
  }
  if (Math.abs(dx) < 10 && Math.abs(dy) < 10 && Date.now() - start.t < 300) {
    const now = Date.now()
    if (now - lastTap < 320) {
      zoom.value = 2.5
      const box = (event.currentTarget as HTMLElement).getBoundingClientRect()
      offset.x = (0.5 - (event.clientX - box.left) / box.width) * 100
      offset.y = (0.5 - (event.clientY - box.top) / box.height) * 100
      clampOffset()
      lastTap = 0
    } else lastTap = now
  }
}
function viewerKeydown(event: KeyboardEvent) {
  if (event.altKey || event.ctrlKey || event.metaKey) return
  const actions: Record<string, () => void> = {
    ArrowRight: () => step(1),
    ArrowLeft: () => step(-1),
    '+': () => (zoom.value = Math.min(4, zoom.value + 0.5)),
    '=': () => (zoom.value = Math.min(4, zoom.value + 0.5)),
    '-': () => {
      zoom.value = Math.max(1, zoom.value - 0.5)
      clampOffset()
    },
    '0': resetZoom
  }
  const action = actions[event.key]
  if (action) {
    event.preventDefault()
    action()
  }
}
function wheel(event: WheelEvent) {
  if (!event.ctrlKey && Math.abs(event.deltaY) < 1) return
  event.preventDefault()
  zoom.value = Math.max(1, Math.min(4, zoom.value - event.deltaY * 0.0025))
  clampOffset()
}
const viewerStyle = computed(() => ({
  transform: `translate(${offset.x}%, ${offset.y}%) scale(${zoom.value})`
}))
</script>

<template>
  <div data-product-gallery class="min-w-0">
    <slot v-if="!shown.length" name="empty" />
    <div v-else class="flex flex-col gap-3 lg:flex-row-reverse lg:items-start">
      <!-- Imagen principal -->
      <div class="relative min-w-0 flex-1">
        <!-- Escritorio: una foto con lupa; pulsar abre el visor -->
        <button
          type="button"
          class="group relative hidden aspect-square w-full cursor-zoom-in overflow-hidden rounded-[var(--radius-surface)] bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--action)] focus-visible:ring-offset-2 lg:block"
          :aria-label="`Ampliar la imagen ${active + 1} de ${shown.length} a pantalla completa`"
          @pointermove="lensMove"
          @pointerleave="lens.on = false"
          @click="open()"
        >
          <span v-if="!loaded" class="absolute inset-0 animate-pulse bg-slate-100" aria-hidden="true" />
          <img
            v-if="current"
            :key="current.src"
            :src="sized(current.src, 1200)"
            :alt="current.alt"
            width="1200"
            height="1200"
            loading="eager"
            decoding="async"
            draggable="false"
            class="relative size-full object-contain transition-transform duration-150 ease-out motion-reduce:transition-none"
            :style="
              lens.on
                ? { transform: 'scale(2.2)', transformOrigin: `${lens.x}% ${lens.y}%` }
                : { transform: 'scale(1)', transformOrigin: '50% 50%' }
            "
            @load="loaded = true"
            @error="fail(current.src)"
          />
          <span
            class="pointer-events-none absolute bottom-3 right-3 inline-flex items-center gap-1.5 rounded-full bg-white/95 px-3 py-1.5 text-[13px] font-medium text-[var(--text)] shadow-[var(--shadow-raised)] transition-opacity group-hover:opacity-0"
            aria-hidden="true"
          >
            <UIcon name="i-lucide-zoom-in" class="size-4" /> Pasa el ratón para ampliar
          </span>
        </button>

        <!-- Móvil: carrusel deslizable; tocar abre el visor -->
        <div class="relative lg:hidden">
          <div
            ref="track"
            class="flex snap-x snap-mandatory overflow-x-auto overscroll-x-contain rounded-[var(--radius-surface)] bg-white [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            role="group"
            aria-roledescription="carrusel"
            :aria-label="`Fotos de ${name}`"
            @scroll.passive="trackScroll"
          >
            <button
              v-for="(image, index) in shown"
              :key="image.src"
              type="button"
              class="aspect-square w-full shrink-0 snap-center"
              :aria-label="`Ver la imagen ${index + 1} de ${shown.length} a pantalla completa`"
              @click="open(index)"
            >
              <img
                :src="sized(image.src, index === 0 ? 1200 : 800)"
                :alt="image.alt"
                width="800"
                height="800"
                :loading="index === 0 ? 'eager' : 'lazy'"
                decoding="async"
                draggable="false"
                class="size-full object-contain"
                @error="fail(image.src)"
              />
            </button>
          </div>
          <span
            v-if="shown.length > 1"
            class="tabular pointer-events-none absolute right-3 top-3 rounded-full bg-slate-900/70 px-2.5 py-1 text-[13px] font-medium text-white"
            aria-hidden="true"
          >
            {{ active + 1 }}/{{ shown.length }}
          </span>
        </div>
        <slot name="overlay" />
      </div>

      <!-- Miniaturas: columna a la izquierda en escritorio, fila debajo en móvil -->
      <div
        v-if="shown.length > 1"
        role="listbox"
        :aria-label="`Fotos de ${name}`"
        aria-orientation="vertical"
        class="flex gap-2 overflow-x-auto pb-1 lg:max-h-[560px] lg:w-[72px] lg:shrink-0 lg:flex-col lg:overflow-y-auto lg:overflow-x-visible lg:pb-0"
      >
        <button
          v-for="(image, index) in shown"
          :key="image.src"
          type="button"
          role="option"
          :aria-selected="index === active"
          :aria-label="`Imagen ${index + 1} de ${shown.length}`"
          :tabindex="index === active ? 0 : -1"
          class="size-14 shrink-0 overflow-hidden rounded-[var(--radius-control)] border-2 bg-white p-0.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--action)] lg:size-[68px]"
          :class="
            index === active ? 'border-[var(--action)]' : 'border-[var(--border)] hover:border-[var(--border-strong)]'
          "
          @mouseenter="select(index)"
          @focus="select(index)"
          @click="select(index)"
          @keydown="thumbKeydown($event, index)"
        >
          <img
            :src="sized(image.src, 128)"
            alt=""
            width="128"
            height="128"
            loading="lazy"
            decoding="async"
            class="size-full object-contain"
            @error="fail(image.src)"
          />
        </button>
      </div>
    </div>

    <DialogRoot v-model:open="viewer">
      <DialogPortal>
        <div v-if="viewer" class="fixed inset-0 z-[60] bg-slate-950/95" aria-hidden="true" />
        <DialogContent
          v-if="viewer && current"
          data-gallery-viewer
          class="fixed inset-0 z-[61] flex flex-col text-white outline-none"
          @keydown="viewerKeydown"
        >
          <div class="flex items-center justify-between gap-3 px-4 pb-2 pt-[calc(0.75rem+env(safe-area-inset-top))]">
            <DialogTitle class="min-w-0 truncate text-[15px] font-semibold">
              {{ name }}
              <span v-if="shown.length > 1" class="tabular font-normal text-white/70">
                · {{ active + 1 }}/{{ shown.length }}</span
              >
            </DialogTitle>
            <button
              type="button"
              data-gallery-close
              class="inline-flex size-11 shrink-0 items-center justify-center rounded-full bg-white/10 hover:bg-white/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
              aria-label="Cerrar"
              @click="viewer = false"
            >
              <UIcon name="i-lucide-x" class="size-6" />
            </button>
          </div>
          <DialogDescription class="sr-only">
            Desliza o usa las flechas para cambiar de foto. Pellizca, toca dos veces o usa + y − para ampliar.
          </DialogDescription>

          <div
            class="relative flex min-h-0 flex-1 touch-none select-none items-center justify-center overflow-hidden"
            @pointerdown="pointerDown"
            @pointermove="pointerMove"
            @pointerup="pointerUp"
            @pointercancel="pointerUp"
            @wheel="wheel"
          >
            <img
              :key="current.src"
              :src="sized(current.src, 1600)"
              :alt="current.alt"
              width="1600"
              height="1600"
              decoding="async"
              draggable="false"
              class="max-h-full max-w-full bg-white object-contain transition-transform duration-100 motion-reduce:transition-none"
              :style="viewerStyle"
              @error="fail(current.src)"
            />
            <template v-if="shown.length > 1">
              <button
                type="button"
                class="absolute left-2 top-1/2 hidden size-12 -translate-y-1/2 items-center justify-center rounded-full bg-white/90 text-slate-900 shadow-[var(--shadow-overlay)] sm:flex"
                aria-label="Foto anterior"
                @pointerdown.stop
                @click="step(-1)"
              >
                <UIcon name="i-lucide-chevron-left" class="size-6" />
              </button>
              <button
                type="button"
                class="absolute right-2 top-1/2 hidden size-12 -translate-y-1/2 items-center justify-center rounded-full bg-white/90 text-slate-900 shadow-[var(--shadow-overlay)] sm:flex"
                aria-label="Foto siguiente"
                @pointerdown.stop
                @click="step(1)"
              >
                <UIcon name="i-lucide-chevron-right" class="size-6" />
              </button>
            </template>
          </div>

          <div class="flex items-center justify-center gap-2 px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-2">
            <template v-if="shown.length > 1">
              <button
                v-for="(image, index) in shown"
                :key="image.src"
                type="button"
                class="size-12 shrink-0 overflow-hidden rounded-[var(--radius-control)] border-2 bg-white"
                :class="index === active ? 'border-white' : 'border-transparent opacity-60'"
                :aria-label="`Ver la imagen ${index + 1}`"
                :aria-current="index === active ? 'true' : undefined"
                @click="select(index)"
              >
                <img :src="sized(image.src, 128)" alt="" class="size-full object-contain" />
              </button>
            </template>
            <button
              v-if="zoom > 1"
              type="button"
              class="ml-2 h-11 rounded-full bg-white/10 px-4 text-[13px] font-medium hover:bg-white/20"
              @click="resetZoom"
            >
              Quitar zoom
            </button>
          </div>
        </DialogContent>
      </DialogPortal>
    </DialogRoot>
  </div>
</template>
