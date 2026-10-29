<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import type { ProductMediaGuide } from '~~/shared/product-media-guides'

const props = defineProps<{
  productId: string | number
}>()

const request = useRequestFetch()

const guides = ref<ProductMediaGuide[]>([])
const selectedIndex = ref(0)
const loading = ref(false)
const facadeActive = ref(false)
const transcriptOpen = ref(false)
const consentGranted = ref(true)

const currentGuide = computed(() => guides.value[selectedIndex.value] || null)

async function loadGuides() {
  try {
    loading.value = true
    const res = await request<{ guides: ProductMediaGuide[] }>(`/api/products/${props.productId}/media-guides`)
    guides.value = res.guides || []
  } catch {
    guides.value = []
  } finally {
    loading.value = false
  }
}

async function sendTelemetry(eventType: string, playPositionSeconds?: number) {
  if (!currentGuide.value) return
  try {
    await request(`/api/media/guides/${currentGuide.value.id}/telemetry`, {
      method: 'POST',
      body: {
        eventType,
        playPositionSeconds: playPositionSeconds ?? 0,
        sessionHash: '0'.repeat(64),
        consentVerified: consentGranted.value
      }
    })
  } catch {
    // telemetry errors are non-blocking
  }
}

function handlePlayClick() {
  facadeActive.value = true
  sendTelemetry('play_start')
}

function selectGuide(idx: number) {
  selectedIndex.value = idx
  facadeActive.value = false
}

function toggleTranscript() {
  transcriptOpen.value = !transcriptOpen.value
  if (transcriptOpen.value) {
    sendTelemetry('transcript_view')
  }
}

function handleTimeUpdate(e: Event) {
  const video = e.target as HTMLVideoElement
  if (!video || !video.duration) return
  const percent = (video.currentTime / video.duration) * 100
  if (percent >= 98) {
    sendTelemetry('complete', video.currentTime)
  }
}

onMounted(() => {
  loadGuides()
})
</script>

<template>
  <div v-if="currentGuide" class="rounded-xl border border-slate-200 bg-white p-6 shadow-sm space-y-6">
    <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-100 pb-4">
      <div>
        <div class="flex items-center gap-2">
          <span
            v-if="currentGuide.guideType === 'expert_demo'"
            class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800"
          >
            Demostración experta
          </span>
          <span
            v-else
            class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-teal-100 text-teal-800"
          >
            Guía de dosificación y montaje
          </span>
          <span class="text-xs text-slate-500">{{ currentGuide.durationSeconds }}s</span>
        </div>
        <h2 class="text-lg font-bold text-slate-900 mt-1">{{ currentGuide.title }}</h2>
      </div>

      <!-- Guide Selector if multiple exist -->
      <div v-if="guides.length > 1" class="flex gap-2">
        <button
          v-for="(g, idx) in guides"
          :key="g.id"
          type="button"
          class="px-3 py-1 text-xs rounded border transition-colors"
          :class="
            selectedIndex === idx
              ? 'border-primary-600 bg-primary-50 text-primary-900 font-semibold'
              : 'border-slate-300 text-slate-600'
          "
          @click="selectGuide(idx)"
        >
          {{ g.guideType === 'expert_demo' ? 'Demo' : 'Dosificación' }}
        </button>
      </div>
    </div>

    <!-- Video Container (Lazy-loaded facade to preserve LCP and avoid CLS) -->
    <div
      class="relative overflow-hidden rounded-lg bg-slate-950 w-full max-w-3xl mx-auto shadow"
      :class="currentGuide.aspectRatio === '9:16' ? 'aspect-[9/16] max-w-xs' : 'aspect-[16/9]'"
    >
      <!-- State A: Lightweight Poster Image (Pre-interaction Facade) -->
      <div v-if="!facadeActive" class="relative w-full h-full flex items-center justify-center">
        <img
          data-testid="video-facade-poster"
          :src="currentGuide.posterUrl"
          :alt="currentGuide.title"
          :width="currentGuide.posterWidth"
          :height="currentGuide.posterHeight"
          loading="lazy"
          fetchpriority="low"
          class="w-full h-full object-cover"
        />

        <!-- Play Button Overlay -->
        <button
          type="button"
          data-testid="play-facade-button"
          aria-label="Reproducir vídeo demostrativo"
          class="absolute z-10 flex items-center justify-center w-16 h-16 rounded-full bg-primary-600/90 text-white shadow-lg hover:bg-primary-500 hover:scale-105 transition-all focus:outline-none focus:ring-4 focus:ring-primary-300"
          @click="handlePlayClick"
        >
          <svg class="w-8 h-8 translate-x-0.5" fill="currentColor" viewBox="0 0 24 24">
            <path d="M8 5v14l11-7z" />
          </svg>
        </button>

        <div
          class="absolute bottom-3 left-3 bg-black/60 backdrop-blur-sm text-white px-2.5 py-1 rounded text-xs font-medium"
        >
          {{ currentGuide.expertPresenter || 'Neteco Técnico' }}
        </div>
      </div>

      <!-- State B: Active Video Player with Subtitles -->
      <video
        v-else
        controls
        autoplay
        preload="none"
        class="w-full h-full object-contain"
        @timeupdate="handleTimeUpdate"
      >
        <source :src="currentGuide.videoUrl" :type="currentGuide.mimeType" />
        <track
          v-if="currentGuide.subtitlesVttUrl"
          kind="subtitles"
          :src="currentGuide.subtitlesVttUrl"
          :srclang="currentGuide.subtitlesLanguage"
          label="Español"
          default
        />
        Tu navegador no soporta reproducción de vídeo HTML5.
      </video>
    </div>

    <!-- Expert Presenter & Description -->
    <div v-if="currentGuide.description || currentGuide.expertPresenter" class="text-sm text-slate-700 space-y-1">
      <p v-if="currentGuide.expertPresenter" class="text-xs text-slate-500">
        Presentado por: <strong class="text-slate-800">{{ currentGuide.expertPresenter }}</strong>
        <span v-if="currentGuide.expertTitle"> ({{ currentGuide.expertTitle }})</span>
      </p>
      <p v-if="currentGuide.description" class="text-slate-600">{{ currentGuide.description }}</p>
    </div>

    <!-- Dosage & Assembly Step-by-Step Guide (MED-016) -->
    <div v-if="currentGuide.steps && currentGuide.steps.length > 0" class="border-t border-slate-100 pt-4 space-y-3">
      <h3 class="text-sm font-bold text-slate-900 flex items-center gap-2">
        <span>🧪 Instrucciones y modo de empleo paso a paso</span>
      </h3>
      <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
        <div
          v-for="step in currentGuide.steps"
          :key="step.stepIndex"
          class="p-3 bg-slate-50 rounded-lg border border-slate-200/60 space-y-1"
        >
          <div class="flex items-center gap-2">
            <span
              class="w-5 h-5 flex items-center justify-center bg-primary-100 text-primary-800 rounded-full text-xs font-bold"
            >
              {{ step.stepIndex }}
            </span>
            <h4 class="text-xs font-bold text-slate-800">{{ step.title }}</h4>
          </div>
          <p class="text-xs text-slate-600 leading-relaxed">{{ step.description }}</p>
        </div>
      </div>
    </div>

    <!-- Accessible Transcription Section (PDP-018 & MED-016) -->
    <div class="border-t border-slate-100 pt-4">
      <button
        type="button"
        data-testid="transcript-toggle"
        :aria-expanded="transcriptOpen ? 'true' : 'false'"
        aria-controls="video-transcript-box"
        class="inline-flex items-center gap-2 text-sm font-semibold text-primary-600 hover:text-primary-700 focus:outline-none"
        @click="toggleTranscript"
      >
        <span>{{ transcriptOpen ? '▲ Ocultar transcripción' : '▼ Ver transcripción completa de la guía' }}</span>
      </button>

      <div
        v-if="transcriptOpen"
        id="video-transcript-box"
        role="region"
        aria-label="Transcripción del vídeo"
        class="mt-3 p-4 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-700 whitespace-pre-line leading-relaxed"
      >
        {{ currentGuide.transcriptText }}
      </div>
    </div>
  </div>
</template>
