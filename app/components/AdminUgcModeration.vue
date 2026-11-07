<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useUgcReviews } from '../composables/useUgcReviews'

const { adminReviews: rawAdminReviews, loading, submitting, error, fetchAdminReviews, moderateReview } = useUgcReviews()

const activeTab = ref<'pending' | 'pii' | 'incentive' | 'all'>('pending')
const notice = ref<string | null>(null)
const moderationReason = ref('Verificación técnica completada por moderación')

const loadReviews = async () => {
  notice.value = null
  if (activeTab.value === 'pending') {
    await fetchAdminReviews({ status: 'pending' })
  } else if (activeTab.value === 'pii') {
    await fetchAdminReviews({ pii: true })
  } else if (activeTab.value === 'incentive') {
    await fetchAdminReviews({ incentive: true })
  } else {
    await fetchAdminReviews({})
  }
}

onMounted(() => {
  loadReviews()
})

const handleTabChange = (tab: typeof activeTab.value) => {
  activeTab.value = tab
  loadReviews()
}

interface ModerationPhoto {
  id: string
  photoUrl: string
  antivirusStatus: string
  moderationStatus: string
}

interface ModerationItem {
  id: string
  version: number
  rating?: number
  title?: string
  moderationStatus?: string
  displayName?: string
  productId?: string
  createdAt?: string
  isVerifiedBuyer?: boolean
  piiDetected?: boolean
  piiRedactedContent?: string | null
  hiddenIncentiveSuspected?: boolean
  content?: string
  photos?: ModerationPhoto[]
  [key: string]: unknown
}

function isModerationItem(r: Record<string, unknown>): r is ModerationItem {
  return typeof r.id === 'string' && typeof r.version === 'number'
}

const adminReviews = computed<ModerationItem[]>(() => rawAdminReviews.value.filter(isModerationItem))

const handleModerate = async (review: ModerationItem, action: 'approve' | 'reject' | 'quarantine') => {
  try {
    await moderateReview({
      reviewId: review.id,
      action,
      reason: moderationReason.value,
      expectedVersion: review.version,
      commandId: `cmd-admin-mod-${review.id}-${Date.now()}`
    })
    await loadReviews()
    notice.value = `Reseña ${review.id} procesada con acción "${action}".`
  } catch (e: unknown) {
    alert('Error al moderar reseña: ' + (e instanceof Error ? e.message : 'error desconocido'))
  }
}

const handleRedactPii = async (review: ModerationItem) => {
  if (!review.piiRedactedContent) return
  try {
    const res = await fetch(`/api/admin/ugc-reviews/${review.id}/redact-pii`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        redactedContent: review.piiRedactedContent,
        expectedVersion: review.version,
        commandId: `cmd-pii-${review.id}-${Date.now()}`
      })
    })
    if (!res.ok) throw new Error('Error al redactar PII')
    await loadReviews()
    notice.value = `Contenido de la reseña ${review.id} redactado sin datos personales.`
  } catch (e: unknown) {
    alert('Error al redactar PII: ' + (e instanceof Error ? e.message : 'error desconocido'))
  }
}
</script>

<template>
  <div class="space-y-6">
    <div class="flex flex-wrap items-center justify-between gap-4 border-b border-gray-200 pb-4 dark:border-gray-800">
      <div>
        <h1 class="text-2xl font-bold tracking-tight text-gray-900 dark:text-gray-100">
          Moderación de UGC y Reseñas con Fotos (MED-018)
        </h1>
        <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Control editorial de fotografías, escaneo antivirus, redacción de PII y detección de incentivos no
          comunicados.
        </p>
      </div>

      <button
        type="button"
        class="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200"
        @click="loadReviews"
      >
        Actualizar cola
      </button>
    </div>

    <!-- Filtros de pestañas -->
    <div class="flex gap-2 border-b border-gray-200 dark:border-gray-800">
      <button
        type="button"
        class="border-b-2 px-4 py-2 text-sm font-semibold transition"
        :class="
          activeTab === 'pending'
            ? 'border-emerald-600 text-emerald-600'
            : 'border-transparent text-gray-500 hover:text-gray-700'
        "
        @click="handleTabChange('pending')"
      >
        Pendientes de moderación
      </button>
      <button
        type="button"
        class="border-b-2 px-4 py-2 text-sm font-semibold transition"
        :class="
          activeTab === 'pii'
            ? 'border-amber-600 text-amber-600'
            : 'border-transparent text-gray-500 hover:text-gray-700'
        "
        @click="handleTabChange('pii')"
      >
        PII detectado (Tel/Email/DNI)
      </button>
      <button
        type="button"
        class="border-b-2 px-4 py-2 text-sm font-semibold transition"
        :class="
          activeTab === 'incentive'
            ? 'border-purple-600 text-purple-600'
            : 'border-transparent text-gray-500 hover:text-gray-700'
        "
        @click="handleTabChange('incentive')"
      >
        Incentivos no declarados
      </button>
      <button
        type="button"
        class="border-b-2 px-4 py-2 text-sm font-semibold transition"
        :class="
          activeTab === 'all'
            ? 'border-emerald-600 text-emerald-600'
            : 'border-transparent text-gray-500 hover:text-gray-700'
        "
        @click="handleTabChange('all')"
      >
        Todas las reseñas
      </button>
    </div>

    <div
      v-if="notice"
      role="status"
      class="rounded-lg bg-emerald-50 p-4 text-sm font-medium text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300"
    >
      {{ notice }}
    </div>
    <div
      v-if="error"
      role="alert"
      class="rounded-lg bg-rose-50 p-4 text-sm font-medium text-rose-800 dark:bg-rose-950/40 dark:text-rose-300"
    >
      {{ error }}
    </div>

    <div v-if="loading" role="status" class="py-12 text-center text-sm text-gray-500">Cargando cola de moderación…</div>

    <div
      v-else-if="adminReviews.length === 0"
      class="rounded-xl border border-dashed border-gray-300 py-12 text-center dark:border-gray-800"
    >
      <p class="text-sm font-medium text-gray-600 dark:text-gray-400">
        No hay reseñas que requieran atención en este filtro.
      </p>
    </div>

    <div v-else class="space-y-6">
      <article
        v-for="rev in adminReviews"
        :key="rev.id"
        class="rounded-xl border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-800 dark:bg-gray-900"
      >
        <div class="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div class="flex items-center gap-3">
              <span class="rounded bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-800"
                >★ {{ rev.rating }}/5</span
              >
              <h3 class="text-lg font-bold text-gray-900 dark:text-gray-100">{{ rev.title }}</h3>
              <span
                class="rounded-full px-2.5 py-0.5 text-xs font-semibold capitalize"
                :class="{
                  'bg-yellow-100 text-yellow-800': rev.moderationStatus === 'pending',
                  'bg-emerald-100 text-emerald-800': rev.moderationStatus === 'approved',
                  'bg-rose-100 text-rose-800': rev.moderationStatus === 'rejected',
                  'bg-purple-100 text-purple-800': rev.moderationStatus === 'quarantined',
                  'bg-gray-100 text-gray-800': rev.moderationStatus === 'withdrawn'
                }"
              >
                {{ rev.moderationStatus }}
              </span>
            </div>
            <div class="mt-1 flex flex-wrap gap-4 text-xs text-gray-500">
              <span
                >Autor: <strong>{{ rev.displayName }}</strong></span
              >
              <span
                >Producto: <code>{{ rev.productId }}</code></span
              >
              <span
                >Fecha: <time>{{ rev.createdAt }}</time></span
              >
              <span v-if="rev.isVerifiedBuyer" class="text-emerald-600 font-semibold">✓ Comprador verificado</span>
            </div>
          </div>

          <div class="flex items-center gap-2">
            <button
              type="button"
              :disabled="submitting"
              class="rounded bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white shadow hover:bg-emerald-700 disabled:opacity-50"
              @click="handleModerate(rev, 'approve')"
            >
              Aprobar
            </button>
            <button
              type="button"
              :disabled="submitting"
              class="rounded bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white shadow hover:bg-rose-700 disabled:opacity-50"
              @click="handleModerate(rev, 'reject')"
            >
              Rechazar
            </button>
            <button
              type="button"
              :disabled="submitting"
              class="rounded bg-purple-600 px-3 py-1.5 text-xs font-semibold text-white shadow hover:bg-purple-700 disabled:opacity-50"
              @click="handleModerate(rev, 'quarantine')"
            >
              Cuarentena
            </button>
          </div>
        </div>

        <!-- Alerta de PII -->
        <div
          v-if="rev.piiDetected"
          class="mt-4 rounded-lg bg-amber-50 p-4 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-300"
        >
          <div class="flex items-center justify-between">
            <span class="font-bold">Datos de identificación personal detectados en el texto (PII):</span>
            <button
              type="button"
              class="rounded bg-amber-200 px-2 py-1 font-semibold text-amber-900 hover:bg-amber-300 dark:bg-amber-800 dark:text-amber-100"
              @click="handleRedactPii(rev)"
            >
              Aplicar redacción automática
            </button>
          </div>
          <p class="mt-2 text-gray-800 dark:text-gray-200">
            Texto sugerido redactado: <em>"{{ rev.piiRedactedContent }}"</em>
          </p>
        </div>

        <!-- Alerta de incentivos ocultos sospechosos -->
        <div
          v-if="rev.hiddenIncentiveSuspected"
          class="mt-4 rounded-lg bg-rose-50 p-3 text-xs text-rose-900 dark:bg-rose-950/40 dark:text-rose-300"
        >
          <span class="font-bold">Sospecha de incentivo u obsequio no declarado:</span> El cliente declaró que no
          tenía incentivos, pero el texto incluye términos de regalo, sorteo o muestra gratuita. Requiere revisión
          previa según política de competencia desleal.
        </div>

        <p class="mt-3 text-sm text-gray-800 dark:text-gray-200">
          {{ rev.content }}
        </p>

        <!-- Galería de fotos con antivirus status -->
        <div v-if="rev.photos && rev.photos.length > 0" class="mt-4 border-t border-gray-100 pt-3 dark:border-gray-800">
          <h4 class="text-xs font-semibold uppercase text-gray-500">Fotografías adjuntas (Escaneo antivirus)</h4>
          <div class="mt-2 flex flex-wrap gap-4">
            <div
              v-for="photo in rev.photos"
              :key="photo.id"
              class="relative rounded-lg border p-2"
              :class="{
                'border-emerald-300 bg-emerald-50/30': photo.antivirusStatus === 'clean',
                'border-rose-400 bg-rose-50/50': photo.antivirusStatus === 'infected',
                'border-yellow-300 bg-yellow-50/30': photo.antivirusStatus === 'quarantined'
              }"
            >
              <img :src="photo.photoUrl" alt="Foto UGC" class="h-24 w-24 rounded object-cover" />
              <div class="mt-1 text-[11px]">
                <span
                  class="font-semibold block"
                  :class="{
                    'text-emerald-700': photo.antivirusStatus === 'clean',
                    'text-rose-700': photo.antivirusStatus === 'infected',
                    'text-yellow-700': photo.antivirusStatus === 'quarantined'
                  }"
                >
                  Antivirus: {{ photo.antivirusStatus }}
                </span>
                <span class="text-gray-500">Estado: {{ photo.moderationStatus }}</span>
              </div>
            </div>
          </div>
        </div>
      </article>
    </div>
  </div>
</template>
