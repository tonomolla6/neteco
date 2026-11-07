<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import { useUgcReviews } from '../composables/useUgcReviews'
import type { PublicUgcReview } from '~~/shared/ugc-reviews'

const props = defineProps<{
  productId: string
  productName?: string
  currentUserId?: string
}>()

const { reviews, total, loading, submitting, error, fetchPublicReviews, submitReview, withdrawReview } = useUgcReviews()

const showForm = ref(false)
const selectedPhoto = ref<string | null>(null)
const successMessage = ref<string | null>(null)

// Form fields
const rating = ref(5)
const title = ref('')
const content = ref('')
const displayName = ref('')
const consentAccepted = ref(true)
const rightsConfirmed = ref(true)
const hasIncentive = ref(false)
const incentiveType = ref<'none' | 'free_sample' | 'discount_coupon' | 'monetary_reward' | 'loyalty_points'>('none')
const incentiveDescription = ref('')
const selectedFiles = ref<
  Array<{
    name: string
    base64: string
    mimeType: 'image/png' | 'image/jpeg' | 'image/webp'
    size: number
    sha256: string
    width: number
    height: number
  }>
>([])
const uploadError = ref<string | null>(null)

onMounted(() => {
  if (props.productId) {
    fetchPublicReviews(props.productId)
  }
})

const averageRating = computed(() => {
  if (!reviews.value.length) return 0
  const sum = reviews.value.reduce((acc, r) => acc + r.rating, 0)
  return (sum / reviews.value.length).toFixed(1)
})

const handleFileChange = async (event: Event) => {
  uploadError.value = null
  const input = event.target as HTMLInputElement
  if (!input.files || input.files.length === 0) return

  if (input.files.length > 5) {
    uploadError.value = 'Máximo 5 fotografías por reseña'
    return
  }

  const filesArray: typeof selectedFiles.value = []

  for (let i = 0; i < input.files.length; i++) {
    const file = input.files[i]!
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      uploadError.value = `Formato no soportado en ${file.name}. Solo PNG, JPEG o WebP.`
      return
    }
    if (file.size > 10 * 1024 * 1024) {
      uploadError.value = `El archivo ${file.name} excede el límite de 10 MB.`
      return
    }

    const buffer = await file.arrayBuffer()
    const bytes = new Uint8Array(buffer)
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer)
    const sha256 = Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')

    // Read base64
    const base64 = btoa(
      Array.from(bytes)
        .map((b) => String.fromCharCode(b))
        .join('')
    )

    filesArray.push({
      name: file.name,
      base64,
      mimeType: file.type as 'image/png' | 'image/jpeg' | 'image/webp',
      size: file.size,
      sha256,
      width: 800,
      height: 600
    })
  }

  selectedFiles.value = filesArray
}

const handleSubmit = async () => {
  uploadError.value = null
  successMessage.value = null

  if (!consentAccepted.value || !rightsConfirmed.value) {
    uploadError.value = 'Debes aceptar el consentimiento y confirmar los derechos del contenido.'
    return
  }

  if (hasIncentive.value && (!incentiveDescription.value.trim() || incentiveType.value === 'none')) {
    uploadError.value = 'Debes especificar el tipo y descripción de la compensación o muestra recibida.'
    return
  }

  try {
    const photos = selectedFiles.value.map((f, i) => ({
      storageKey: `ugc/reviews/${props.productId}/${Date.now()}_${i}.${f.mimeType === 'image/png' ? 'png' : f.mimeType === 'image/webp' ? 'webp' : 'jpg'}`,
      photoUrl: `https://media.neteco.es/ugc/reviews/${props.productId}/${Date.now()}_${i}.${f.mimeType === 'image/png' ? 'png' : f.mimeType === 'image/webp' ? 'webp' : 'jpg'}`,
      mimeType: f.mimeType,
      fileSizeBytes: f.size,
      sha256: f.sha256,
      width: f.width,
      height: f.height,
      base64Data: f.base64
    }))

    await submitReview({
      productId: props.productId,
      rating: rating.value,
      title: title.value,
      content: content.value,
      displayName: displayName.value,
      consentAccepted: true,
      consentVersion: '2026-ugc-v1',
      licenseTerms: 'royalty_free_commercial_display',
      rightsConfirmed: true,
      hasIncentive: hasIncentive.value,
      incentiveType: hasIncentive.value ? incentiveType.value : 'none',
      incentiveDescription: hasIncentive.value ? incentiveDescription.value : undefined,
      photos,
      commandId: `cmd-ugc-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`
    })

    successMessage.value =
      '¡Gracias por tu opinión! Tu reseña y fotos están siendo procesadas por el escáner antivirus y el equipo de moderación.'
    showForm.value = false
    // Reset fields
    title.value = ''
    content.value = ''
    selectedFiles.value = []
  } catch (e: unknown) {
    uploadError.value = e instanceof Error ? e.message : 'No se pudo enviar la reseña.'
  }
}

const handleWithdraw = async (review: PublicUgcReview) => {
  if (!confirm('¿Estás seguro de que deseas retirar tu reseña? Será eliminada inmediatamente de la tienda online.'))
    return
  try {
    await withdrawReview(review.id, 'customer_revocation', 1)
    await fetchPublicReviews(props.productId)
  } catch (e: unknown) {
    alert('Error al retirar la reseña: ' + (e instanceof Error ? e.message : 'error desconocido'))
  }
}
</script>

<template>
  <section
    class="mt-8 rounded-xl border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-800 dark:bg-gray-900"
    aria-labelledby="ugc-reviews-heading"
  >
    <div class="flex flex-wrap items-center justify-between gap-4 border-b border-gray-100 pb-5 dark:border-gray-800">
      <div>
        <h2 id="ugc-reviews-heading" class="text-xl font-bold tracking-tight text-gray-900 dark:text-gray-100">
          Opiniones de clientes con fotografías
        </h2>
        <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Experiencias reales con evidencia fotográfica verificada y política de transparencia de incentivos.
        </p>
      </div>

      <div class="flex items-center gap-4">
        <div v-if="reviews.length > 0" class="flex items-baseline gap-2">
          <span class="text-2xl font-extrabold text-amber-500" data-testid="average-rating">{{ averageRating }}</span>
          <span class="text-sm font-medium text-gray-500">/ 5 ({{ total }} opiniones)</span>
        </div>
        <button
          type="button"
          class="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2"
          @click="showForm = !showForm"
        >
          <span v-if="!showForm">Compartir opinión con fotos</span>
          <span v-else>Cerrar formulario</span>
        </button>
      </div>
    </div>

    <!-- Alert / Success / Error feedback -->
    <div
      v-if="successMessage"
      role="status"
      class="mt-4 rounded-lg bg-emerald-50 p-4 text-sm font-medium text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300"
    >
      {{ successMessage }}
    </div>
    <div
      v-if="error"
      role="alert"
      class="mt-4 rounded-lg bg-rose-50 p-4 text-sm font-medium text-rose-800 dark:bg-rose-950/40 dark:text-rose-300"
    >
      {{ error }}
    </div>

    <!-- Form Section -->
    <div
      v-if="showForm"
      class="mt-6 rounded-lg border border-gray-100 bg-gray-50 p-6 dark:border-gray-800 dark:bg-gray-800/40"
    >
      <h3 class="text-lg font-semibold text-gray-900 dark:text-gray-100">Nueva opinión con fotos</h3>
      <form class="mt-4 space-y-4" @submit.prevent="handleSubmit">
        <div>
          <label for="review-rating" class="block text-sm font-medium text-gray-700 dark:text-gray-300"
            >Puntuación</label
          >
          <select
            id="review-rating"
            v-model.number="rating"
            required
            class="mt-1 block w-32 rounded-md border border-gray-300 bg-white p-2 text-sm shadow-sm focus:border-emerald-500 focus:ring-emerald-500 dark:border-gray-700 dark:bg-gray-800"
          >
            <option :value="5">5 estrellas</option>
            <option :value="4">4 estrellas</option>
            <option :value="3">3 estrellas</option>
            <option :value="2">2 estrellas</option>
            <option :value="1">1 estrella</option>
          </select>
        </div>

        <div>
          <label for="review-title" class="block text-sm font-medium text-gray-700 dark:text-gray-300"
            >Título resumen</label
          >
          <input
            id="review-title"
            v-model="title"
            type="text"
            required
            minlength="3"
            maxlength="160"
            placeholder="Ej: Excelente desengrase en piezas de motor"
            class="mt-1 block w-full rounded-md border border-gray-300 bg-white p-2 text-sm shadow-sm focus:border-emerald-500 focus:ring-emerald-500 dark:border-gray-700 dark:bg-gray-800"
          />
        </div>

        <div>
          <label for="review-content" class="block text-sm font-medium text-gray-700 dark:text-gray-300"
            >Detalles de tu experiencia</label
          >
          <textarea
            id="review-content"
            v-model="content"
            required
            minlength="10"
            maxlength="3000"
            rows="4"
            placeholder="Explica cómo aplicaste el producto, dosis, resultado y precauciones. Evita incluir datos personales directos (teléfono, correo, DNI)."
            class="mt-1 block w-full rounded-md border border-gray-300 bg-white p-2 text-sm shadow-sm focus:border-emerald-500 focus:ring-emerald-500 dark:border-gray-700 dark:bg-gray-800"
          ></textarea>
        </div>

        <div>
          <label for="review-author" class="block text-sm font-medium text-gray-700 dark:text-gray-300"
            >Nombre público o empresa</label
          >
          <input
            id="review-author"
            v-model="displayName"
            type="text"
            required
            minlength="1"
            maxlength="100"
            placeholder="Ej: Talleres Mecánicos Valencia"
            class="mt-1 block w-full rounded-md border border-gray-300 bg-white p-2 text-sm shadow-sm focus:border-emerald-500 focus:ring-emerald-500 dark:border-gray-700 dark:bg-gray-800"
          />
        </div>

        <!-- Transparencia de incentivos (No incentivos ocultos) -->
        <fieldset class="rounded-md border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
          <legend class="px-2 text-xs font-semibold uppercase tracking-wider text-gray-600 dark:text-gray-400">
            Transparencia e incentivos (Normativa Omnibus UE / Ley Consumidores)
          </legend>
          <div class="mt-2 space-y-2">
            <label class="flex items-center gap-2 text-sm font-medium text-gray-800 dark:text-gray-200">
              <input
                v-model="hasIncentive"
                type="checkbox"
                class="h-4 w-4 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500"
              />
              ¿Has recibido alguna compensación, muestra gratuita o cupón por esta reseña?
            </label>
            <div v-if="hasIncentive" class="mt-3 space-y-3 pl-6">
              <div>
                <label for="incentive-type" class="block text-xs font-medium text-gray-600 dark:text-gray-400"
                  >Tipo de incentivo recibido</label
                >
                <select
                  id="incentive-type"
                  v-model="incentiveType"
                  class="mt-1 block w-full rounded-md border border-gray-300 p-2 text-sm dark:border-gray-700 dark:bg-gray-800"
                >
                  <option value="free_sample">Muestra comercial gratuita</option>
                  <option value="discount_coupon">Cupón o descuento para futuras compras</option>
                  <option value="loyalty_points">Puntos de fidelidad</option>
                  <option value="monetary_reward">Compensación directa acordada</option>
                </select>
              </div>
              <div>
                <label for="incentive-desc" class="block text-xs font-medium text-gray-600 dark:text-gray-400"
                  >Descripción detallada</label
                >
                <input
                  id="incentive-desc"
                  v-model="incentiveDescription"
                  type="text"
                  placeholder="Ej: Muestra comercial de 500ml facilitada para test de desengrase en taller"
                  class="mt-1 block w-full rounded-md border border-gray-300 p-2 text-sm dark:border-gray-700 dark:bg-gray-800"
                />
              </div>
            </div>
          </div>
        </fieldset>

        <!-- Subida de fotos -->
        <div>
          <label class="block text-sm font-medium text-gray-700 dark:text-gray-300"
            >Fotografías del producto en uso (máximo 5 fotos, PNG/JPG/WebP &le; 10 MB)</label
          >
          <input
            type="file"
            multiple
            accept="image/png,image/jpeg,image/webp"
            class="mt-1 block w-full text-sm text-gray-500 file:mr-4 file:rounded-md file:border-0 file:bg-emerald-50 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-emerald-700 hover:file:bg-emerald-100 dark:file:bg-emerald-950 dark:file:text-emerald-300"
            @change="handleFileChange"
          />
          <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Escaneo antivirus automático en subida. Se redactarán matrículas o rostros antes de la publicación
            definitiva.
          </p>
          <div v-if="selectedFiles.length > 0" class="mt-2 flex flex-wrap gap-2">
            <span
              v-for="f in selectedFiles"
              :key="f.name"
              class="inline-flex items-center gap-1 rounded bg-gray-200 px-2 py-1 text-xs dark:bg-gray-700"
            >
              {{ f.name }} ({{ Math.round(f.size / 1024) }} KB)
            </span>
          </div>
        </div>

        <!-- Consentimiento y Licencia -->
        <div class="space-y-2 border-t border-gray-200 pt-3 dark:border-gray-700">
          <label class="flex items-start gap-2 text-xs text-gray-700 dark:text-gray-300">
            <input
              v-model="consentAccepted"
              type="checkbox"
              required
              class="mt-0.5 h-4 w-4 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500"
            />
            <span
              >Acepto las condiciones de publicación y tratamiento de opiniones (consentimiento '2026-ugc-v1').</span
            >
          </label>
          <label class="flex items-start gap-2 text-xs text-gray-700 dark:text-gray-300">
            <input
              v-model="rightsConfirmed"
              type="checkbox"
              required
              class="mt-0.5 h-4 w-4 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500"
            />
            <span
              >Confirmo que tengo todos los derechos de autor sobre las fotografías aportadas y concedo licencia de
              exhibición comercial no exclusiva a Neteco.</span
            >
          </label>
        </div>

        <div v-if="uploadError" role="alert" class="text-sm font-semibold text-rose-600">
          {{ uploadError }}
        </div>

        <div class="flex justify-end gap-3 pt-2">
          <button
            type="button"
            class="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300"
            @click="showForm = false"
          >
            Cancelar
          </button>
          <button
            type="submit"
            :disabled="submitting"
            class="inline-flex items-center gap-2 rounded-md bg-emerald-600 px-5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-50"
          >
            <span v-if="submitting">Enviando y escaneando…</span>
            <span v-else>Enviar opinión</span>
          </button>
        </div>
      </form>
    </div>

    <!-- Loading state -->
    <div v-if="loading" role="status" class="py-8 text-center text-sm text-gray-500">
      Cargando opiniones verificadas…
    </div>

    <!-- Empty state -->
    <div v-else-if="reviews.length === 0" class="py-10 text-center">      <p class="mt-2 text-sm font-medium text-gray-700 dark:text-gray-300">
        Aún no hay opiniones con fotografías para este producto.
      </p>
      <p class="text-xs text-gray-500">Sé el primero en compartir tu experiencia técnica de aplicación.</p>
    </div>

    <!-- Reviews list -->
    <div v-else class="mt-6 divide-y divide-gray-100 dark:divide-gray-800">
      <article v-for="rev in reviews" :key="rev.id" class="py-6 first:pt-0 last:pb-0">
        <div class="flex flex-wrap items-start justify-between gap-2">
          <div>
            <div class="flex items-center gap-2">
              <span class="font-bold text-amber-500">★ {{ rev.rating }}/5</span>
              <h4 class="font-semibold text-gray-900 dark:text-gray-100">{{ rev.title }}</h4>
            </div>
            <div class="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-500">
              <span class="font-medium text-gray-700 dark:text-gray-300">{{ rev.displayName }}</span>
              <span>&bull;</span>
              <time :datetime="rev.createdAt">{{ rev.createdAt.split('T')[0] }}</time>
              <span>&bull;</span>
              <!-- Badges de compra y compensación -->
              <span
                class="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
              >
                ✓ {{ rev.incentiveBadge }}
              </span>
            </div>
          </div>

          <div v-if="props.currentUserId" class="text-right">
            <button
              type="button"
              class="text-xs text-gray-500 underline hover:text-rose-600"
              @click="handleWithdraw(rev)"
            >
              Retirar mi opinión
            </button>
          </div>
        </div>

        <p class="mt-3 text-sm leading-relaxed text-gray-700 dark:text-gray-300">
          {{ rev.content }}
        </p>

        <!-- Incentive disclosure note if present -->
        <div
          v-if="rev.incentiveDisclosure"
          class="mt-2 rounded bg-amber-50/70 p-2 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-200"
        >
          <span class="font-semibold">Transparencia:</span> {{ rev.incentiveDisclosure }}
        </div>

        <!-- Photos thumbnails -->
        <div v-if="rev.photos && rev.photos.length > 0" class="mt-4 flex flex-wrap gap-3">
          <button
            v-for="photo in rev.photos"
            :key="photo.id"
            type="button"
            class="group relative h-20 w-20 overflow-hidden rounded-lg border border-gray-200 transition hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-emerald-500 dark:border-gray-700"
            @click="selectedPhoto = photo.photoUrl"
          >
            <img :src="photo.photoUrl" :alt="rev.title" class="h-full w-full object-cover" />
            <span
              class="absolute inset-0 flex items-center justify-center bg-black/30 opacity-0 transition group-hover:opacity-100"
            >
              <span class="text-xs text-white">Ver</span>
            </span>
          </button>
        </div>
      </article>
    </div>

    <!-- Lightbox Modal -->
    <div
      v-if="selectedPhoto"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
      role="dialog"
      aria-modal="true"
      @click="selectedPhoto = null"
    >
      <div class="relative max-h-full max-w-4xl" @click.stop>
        <img
          :src="selectedPhoto"
          alt="Fotografía ampliada de opinión"
          class="max-h-[85vh] max-w-full rounded-lg object-contain shadow-2xl"
        />
        <button
          type="button"
          class="absolute -top-3 -right-3 rounded-full bg-white p-2 text-gray-700 shadow-lg hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-200"
          aria-label="Cerrar fotografía"
          @click="selectedPhoto = null"
        >
          ✕
        </button>
      </div>
    </div>
  </section>
</template>
