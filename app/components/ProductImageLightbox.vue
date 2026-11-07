<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { DialogRoot, DialogPortal, DialogContent, DialogTitle, DialogDescription } from 'reka-ui'

const props = defineProps<{
  open: boolean
  src: string | null
  alt: string
  name: string
  trigger: HTMLElement | null
  contextKey?: string | number
}>()
const emit = defineEmits<{ 'update:open': [boolean] }>()
// Sources remain selected by the PDP's governed-publication/legacy resolver.
// This additional boundary never expands that resolver to remote URLs.
const safeSource = computed(() => {
  const value = props.src
  if (
    !value ||
    value.length > 4096 ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    [...value].some(
      (character) => character === '\\' || character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    )
  )
    return null
  return value
})
const invalidated = ref(false),
  failed = ref(false),
  retries = ref(0),
  imageEpoch = ref(0)
const zoom = ref(1),
  panX = ref(0),
  panY = ref(0),
  closeButton = ref<HTMLButtonElement | null>(null)
const visible = computed(() => props.open && !!safeSource.value && !invalidated.value)
const imageStyle = computed(() => ({
  transform: `translate(${panX.value}%, ${panY.value}%) scale(${zoom.value})`,
  transformOrigin: '50% 50%'
}))
let mounted = false,
  locked = false,
  previousOverflow = '',
  previousOverflowPriority = '',
  openingTrigger: HTMLElement | null = null
let openingContext: string | number | undefined
function resetZoom() {
  zoom.value = 1
  panX.value = 0
  panY.value = 0
}
function changeZoom(delta: number) {
  zoom.value = Math.max(1, Math.min(3, zoom.value + delta))
  if (zoom.value === 1) resetZoom()
}
function pan(dx: number, dy: number) {
  if (zoom.value === 1) return
  const limit = Math.min(40, (zoom.value - 1) * 40)
  panX.value = Math.max(-limit, Math.min(limit, panX.value + dx))
  panY.value = Math.max(-limit, Math.min(limit, panY.value + dy))
}
function lock() {
  if (!mounted || locked) return
  previousOverflow = document.body.style.overflow
  previousOverflowPriority = document.body.style.getPropertyPriority('overflow')
  document.body.style.setProperty('overflow', 'hidden')
  locked = true
  openingTrigger = props.trigger
  openingContext = props.contextKey
}
function unlock() {
  if (!locked) return
  // A different overlay may have taken ownership while this viewer was open.
  if (document.body.style.overflow === 'hidden' && !document.body.style.getPropertyPriority('overflow'))
    document.body.style.setProperty('overflow', previousOverflow, previousOverflowPriority)
  locked = false
}
function close() {
  invalidated.value = true
  emit('update:open', false)
}
function openAutoFocus(event: Event) {
  event.preventDefault()
  void nextTick(() => {
    if (visible.value) closeButton.value?.focus()
  })
}
function closeAutoFocus(event: Event) {
  event.preventDefault()
  if (openingTrigger?.isConnected && props.trigger === openingTrigger && props.contextKey === openingContext)
    openingTrigger.focus()
}
function keydown(event: KeyboardEvent) {
  if (event.altKey || event.ctrlKey || event.metaKey) return
  const action: Record<string, () => void> = {
    '+': () => changeZoom(0.5),
    '=': () => changeZoom(0.5),
    '-': () => changeZoom(-0.5),
    '0': resetZoom,
    ArrowLeft: () => pan(10, 0),
    ArrowRight: () => pan(-10, 0),
    ArrowUp: () => pan(0, 10),
    ArrowDown: () => pan(0, -10)
  }
  if (action[event.key]) {
    event.preventDefault()
    action[event.key]!()
  }
}
function pointerMove(event: MouseEvent) {
  if (zoom.value === 1 || !(event.currentTarget instanceof HTMLElement)) return
  const rect = event.currentTarget.getBoundingClientRect()
  if (!rect.width || !rect.height) return
  const limit = Math.min(40, (zoom.value - 1) * 40)
  panX.value = Math.max(-limit, Math.min(limit, (0.5 - (event.clientX - rect.left) / rect.width) * limit * 2))
  panY.value = Math.max(-limit, Math.min(limit, (0.5 - (event.clientY - rect.top) / rect.height) * limit * 2))
}
function retry() {
  if (!failed.value || retries.value >= 1) return
  retries.value++
  imageEpoch.value++
  failed.value = false
  resetZoom()
}
watch(
  () => props.open,
  (open) => {
    if (open) {
      invalidated.value = false
      failed.value = false
      retries.value = 0
      imageEpoch.value++
      resetZoom()
    }
  },
  { immediate: true, flush: 'sync' }
)
// A compiled parent updates open and its deferred high-resolution src in the
// same patch. Read them together after that patch, never as partial sync props.
watch(
  () => [props.open, props.src, props.contextKey] as const,
  ([open, source, context], previous) => {
    if (
      open &&
      (!safeSource.value || (previous && (context !== previous[2] || (previous[0] && source !== previous[1]))))
    )
      close()
    if (previous && (source !== previous[1] || context !== previous[2])) {
      resetZoom()
      failed.value = false
    }
  },
  { immediate: true }
)
watch(
  visible,
  (open) => {
    if (open) lock()
    else {
      unlock()
      resetZoom()
    }
  },
  { flush: 'sync' }
)
onMounted(() => {
  mounted = true
  if (visible.value) lock()
})
onBeforeUnmount(() => {
  unlock()
  mounted = false
})
</script>

<template>
  <DialogRoot
    :open="visible"
    @update:open="
      (value) => {
        if (!value) close()
      }
    "
  >
    <DialogPortal>
      <div
        v-if="visible"
        data-lightbox-backdrop
        class="pointer-events-auto fixed inset-0 z-[60] flex items-center justify-center overflow-hidden bg-slate-950/90 p-2 sm:p-4"
        @click.self="close"
      >
        <DialogContent
          aria-modal="true"
          class="relative flex max-h-[96dvh] w-full min-w-0 max-w-6xl flex-col gap-3 overflow-hidden rounded-xl bg-slate-950 p-3 text-white shadow-[var(--shadow-overlay)] sm:p-4"
          @open-auto-focus="openAutoFocus"
          @close-auto-focus="closeAutoFocus"
          @pointer-down-outside.prevent
          @keydown="keydown"
        >
          <div class="flex min-w-0 items-center justify-between gap-3">
            <DialogTitle class="min-w-0 break-words font-semibold">Imagen de {{ name }}</DialogTitle>
            <button
              ref="closeButton"
              data-lightbox-close
              type="button"
              aria-label="Cerrar la imagen"
              class="min-h-11 shrink-0 rounded border border-white/60 px-3 focus-visible:outline focus-visible:outline-2"
              @click="close"
            >
              Cerrar
            </button>
          </div>
          <div
            class="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-lg bg-white"
            @mousemove="pointerMove"
          >
            <img
              v-if="!failed"
              :key="imageEpoch"
              data-lightbox-image
              :src="safeSource!"
              :alt="alt"
              loading="lazy"
              decoding="async"
              referrerpolicy="no-referrer"
              draggable="false"
              class="max-h-[65dvh] max-w-full select-none object-contain transition-transform duration-150 motion-reduce:transition-none"
              :style="imageStyle"
              @error="failed = true"
              @click="zoom === 1 ? changeZoom(1) : resetZoom()"
            />
            <div v-else class="space-y-3 p-6 text-center text-slate-900">
              <p role="alert">No se ha podido cargar esta imagen.</p>
              <button
                v-if="retries < 1"
                data-lightbox-retry
                type="button"
                aria-label="Reintentar la carga de la imagen una vez"
                class="min-h-11 rounded border px-3"
                @click="retry"
              >
                Reintentar una vez
              </button>
              <p v-else>Puedes cerrar y volver a consultar la ficha; no se repetirán cargas automáticamente.</p>
            </div>
          </div>
          <div class="flex flex-wrap justify-center gap-2">
            <button
              data-lightbox-zoom-in
              type="button"
              aria-label="Ampliar imagen"
              :disabled="zoom >= 3 || failed"
              class="min-h-11 min-w-11 rounded border px-3 disabled:opacity-40"
              @click="changeZoom(0.5)"
            >
              +
            </button>
            <button
              data-lightbox-zoom-out
              type="button"
              aria-label="Reducir imagen"
              :disabled="zoom <= 1 || failed"
              class="min-h-11 min-w-11 rounded border px-3 disabled:opacity-40"
              @click="changeZoom(-0.5)"
            >
              −
            </button>
            <button
              data-lightbox-reset
              type="button"
              aria-label="Restablecer zoom y posición"
              :disabled="failed"
              class="min-h-11 rounded border px-3 disabled:opacity-40"
              @click="resetZoom"
            >
              Restablecer
            </button>
            <button
              data-lightbox-pan-left
              type="button"
              aria-label="Recorrer imagen hacia la izquierda"
              :disabled="zoom <= 1 || failed"
              class="min-h-11 min-w-11 rounded border px-3 disabled:opacity-40"
              @click="pan(10, 0)"
            >
              ←
            </button>
            <button
              type="button"
              aria-label="Recorrer imagen hacia la derecha"
              :disabled="zoom <= 1 || failed"
              class="min-h-11 min-w-11 rounded border px-3 disabled:opacity-40"
              @click="pan(-10, 0)"
            >
              →
            </button>
            <button
              type="button"
              aria-label="Recorrer imagen hacia arriba"
              :disabled="zoom <= 1 || failed"
              class="min-h-11 min-w-11 rounded border px-3 disabled:opacity-40"
              @click="pan(0, 10)"
            >
              ↑
            </button>
            <button
              type="button"
              aria-label="Recorrer imagen hacia abajo"
              :disabled="zoom <= 1 || failed"
              class="min-h-11 min-w-11 rounded border px-3 disabled:opacity-40"
              @click="pan(0, -10)"
            >
              ↓
            </button>
          </div>
          <DialogDescription class="text-center text-sm"
            >Toca los botones o usa el teclado: + y − para ampliar/reducir, flechas para recorrer y 0 para restablecer.
            Escape cierra. También puedes pulsar la imagen para ampliar desde el centro.</DialogDescription
          >
        </DialogContent>
      </div>
    </DialogPortal>
  </DialogRoot>
</template>
