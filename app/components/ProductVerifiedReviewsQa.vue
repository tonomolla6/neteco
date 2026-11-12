<script setup lang="ts">
import { ref, onMounted } from 'vue'
import type { PublicProductReview, PublicProductQuestion } from '~~/shared/product-reviews-qa'

const props = withDefaults(
  defineProps<{
    productId: string | number
    productName?: string
  }>(),
  {
    productName: 'Producto'
  }
)

const request = useRequestFetch()
const { loggedIn, user } = useUserSession()

const activeTab = ref<'reviews' | 'questions'>('reviews')
const loading = ref(false)
const errorMessage = ref('')
const loadNotice = ref('')
const showReviewForm = ref(false)
const showQuestionForm = ref(false)
const successMessage = ref('')
// Un módulo de opiniones a cero resta: sin nada publicado solo se ofrece una invitación de una
// línea, y el módulo completo aparece cuando hay algo que leer o alguien quiere escribir.
const loaded = ref(false)
const expanded = ref(false)

const reviews = ref<PublicProductReview[]>([])
const reviewsTotal = ref(0)
const averageRating = ref(0)

const questions = ref<PublicProductQuestion[]>([])
const questionsTotal = ref(0)

// Form states
const newRating = ref(5)
const newTitle = ref('')
const newContent = ref('')
const newOrderId = ref('')
const newConsent = ref(false)
const submitting = ref(false)

async function loadReviews() {
  try {
    loading.value = true
    errorMessage.value = ''
    const res = await request<{ items: PublicProductReview[]; total: number; averageRating: number }>(
      `/api/products/${props.productId}/reviews`
    )
    reviews.value = res.items || []
    reviewsTotal.value = res.total || 0
    averageRating.value = res.averageRating || 0
  } catch {
    loadNotice.value = 'Las opiniones no están disponibles en este momento.'
  } finally {
    loading.value = false
  }
}

async function loadQuestions() {
  try {
    loading.value = true
    errorMessage.value = ''
    const res = await request<{ items: PublicProductQuestion[]; total: number }>(
      `/api/products/${props.productId}/questions`
    )
    questions.value = res.items || []
    questionsTotal.value = res.total || 0
  } catch {
    loadNotice.value = 'Las preguntas no están disponibles en este momento.'
  } finally {
    loading.value = false
  }
}

async function handleReviewSubmit() {
  if (!newTitle.value.trim() || !newContent.value.trim() || !newConsent.value) return
  try {
    submitting.value = true
    errorMessage.value = ''
    successMessage.value = ''
    await request<unknown, string>(`/api/products/${props.productId}/reviews`, {
      method: 'POST',
      body: {
        rating: Number(newRating.value),
        title: newTitle.value.trim(),
        content: newContent.value.trim(),
        orderId: newOrderId.value.trim() || undefined,
        displayName: user.value?.name || user.value?.email?.split('@')[0] || 'Cliente',
        consentAccepted: true,
        commandId: crypto.randomUUID()
      }
    })
    successMessage.value = 'Reseña enviada correctamente. Será publicada tras la moderación.'
    newTitle.value = ''
    newContent.value = ''
    newOrderId.value = ''
    await loadReviews()
  } catch {
    errorMessage.value = 'Error al enviar la reseña. Verifique los datos o inténtelo de nuevo.'
  } finally {
    submitting.value = false
  }
}

async function handleQuestionSubmit() {
  if (!newTitle.value.trim() || !newContent.value.trim() || !newConsent.value) return
  try {
    submitting.value = true
    errorMessage.value = ''
    successMessage.value = ''
    await request<unknown, string>(`/api/products/${props.productId}/questions`, {
      method: 'POST',
      body: {
        title: newTitle.value.trim(),
        content: newContent.value.trim(),
        displayName: user.value?.name || user.value?.email?.split('@')[0] || 'Cliente',
        consentAccepted: true,
        commandId: crypto.randomUUID()
      }
    })
    successMessage.value = 'Pregunta enviada correctamente. Recibirá respuesta oficial en breve.'
    newTitle.value = ''
    newContent.value = ''
    await loadQuestions()
  } catch {
    errorMessage.value = 'Error al enviar la pregunta. Verifique los datos o inténtelo de nuevo.'
  } finally {
    submitting.value = false
  }
}

onMounted(async () => {
  await Promise.all([loadReviews(), loadQuestions()])
  loaded.value = true
})
const empty = computed(() => reviewsTotal.value === 0 && questionsTotal.value === 0)
</script>

<template>
  <p
    v-if="loaded && empty && !expanded"
    data-reviews-invite
    class="flex flex-wrap items-center gap-x-3 gap-y-2 text-[15px] text-[var(--text)]"
  >
    ¿Lo usas? Cuéntanos qué tal o pregúntanos lo que necesites.
    <button type="button" class="font-semibold text-[var(--link)] underline" @click="expanded = true">
      Opinar o preguntar
    </button>
  </p>
  <section
    v-else-if="loaded"
    class="rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--surface)] p-6"
    aria-label="Opiniones y preguntas de clientes"
  >
    <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-200 pb-4">
      <div>
        <h2 class="text-xl font-bold text-slate-900">Opiniones y preguntas</h2>
        <p class="text-sm text-slate-600">Experiencias y soporte técnico sobre {{ productName }}</p>
      </div>

      <!-- Tab Buttons -->
      <div role="tablist" class="flex gap-2 bg-slate-100 p-1 rounded-lg">
        <button
          type="button"
          role="tab"
          data-testid="tab-reviews"
          :aria-selected="activeTab === 'reviews'"
          class="px-4 py-2 rounded-md text-sm font-medium transition-colors"
          :class="activeTab === 'reviews' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'"
          @click="activeTab = 'reviews'"
        >
          Opiniones ({{ reviewsTotal }})
        </button>
        <button
          type="button"
          role="tab"
          data-testid="tab-questions"
          :aria-selected="activeTab === 'questions'"
          class="px-4 py-2 rounded-md text-sm font-medium transition-colors"
          :class="
            activeTab === 'questions' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
          "
          @click="activeTab = 'questions'"
        >
          Preguntas y respuestas ({{ questionsTotal }})
        </button>
      </div>
    </div>

    <!-- Error/Success Alerts -->
    <p v-if="loadNotice" class="mt-4 text-sm text-slate-500">{{ loadNotice }}</p>
    <div v-if="errorMessage" role="alert" class="mt-4 p-3 rounded-lg bg-red-50 text-red-700 text-sm">
      {{ errorMessage }}
    </div>
    <div v-if="successMessage" role="status" class="mt-4 p-3 rounded-lg bg-emerald-50 text-emerald-800 text-sm">
      {{ successMessage }}
    </div>

    <!-- Tab 1: Reviews Panel -->
    <div v-if="activeTab === 'reviews'" role="tabpanel" class="mt-6 space-y-6">
      <div v-if="reviews.length === 0 && !loading" class="text-center py-8 text-slate-500">
        Aún no hay opiniones publicadas para este producto. Sé el primero en opinar.
      </div>

      <div v-for="review in reviews" :key="review.id" class="border-b border-slate-100 pb-5 space-y-2">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <span class="font-semibold text-slate-900">{{ review.displayName }}</span>
            <span
              v-if="review.isVerifiedBuyer"
              data-testid="verified-buyer-badge"
              class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-emerald-100 text-emerald-800"
            >
              ✓ Comprador verificado
            </span>
          </div>
          <div class="flex items-center gap-1 text-amber-500 text-sm" aria-label="Valoración">
            ★ {{ review.rating }}/5
          </div>
        </div>

        <h3 class="font-medium text-slate-900">{{ review.title }}</h3>
        <p class="text-slate-700 text-sm leading-relaxed">{{ review.content }}</p>

        <!-- Official Merchant Response -->
        <div
          v-if="review.merchantResponse"
          class="mt-3 pl-4 border-l-2 border-primary-500 bg-slate-50 p-3 rounded-r-lg space-y-1"
        >
          <div class="flex items-center gap-2 text-xs font-semibold text-primary-900">
            <span>Respuesta oficial de Neteco</span>
          </div>
          <p class="text-sm text-slate-700">{{ review.merchantResponse }}</p>
        </div>
      </div>

      <!-- Add Review Form -->
      <div v-if="loggedIn" class="mt-8 pt-6 border-t border-slate-200">
        <button
          v-if="!showReviewForm"
          type="button"
          data-testid="open-review-form"
          class="rounded-md border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-50"
          @click="showReviewForm = true"
        >
          Escribir una opinión
        </button>
        <h3 v-if="showReviewForm" class="font-bold text-slate-900 mb-4">Escribir una opinión</h3>
        <form v-if="showReviewForm" class="space-y-4" @submit.prevent="handleReviewSubmit">
          <div class="flex items-center gap-4">
            <label class="text-sm font-medium text-slate-700">Valoración:</label>
            <select
              v-model="newRating"
              class="rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-primary-500"
            >
              <option :value="5">5 estrellas - Excelente</option>
              <option :value="4">4 estrellas - Muy bueno</option>
              <option :value="3">3 estrellas - Aceptable</option>
              <option :value="2">2 estrellas - Mejorable</option>
              <option :value="1">1 estrella - Deficiente</option>
            </select>
          </div>

          <div>
            <label class="block text-sm font-medium text-slate-700 mb-1">Título de la reseña</label>
            <input
              v-model="newTitle"
              type="text"
              required
              minlength="3"
              maxlength="160"
              placeholder="Resumen de tu experiencia..."
              class="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-primary-500"
            />
          </div>

          <div>
            <label class="block text-sm font-medium text-slate-700 mb-1">Contenido de la opinión</label>
            <textarea
              v-model="newContent"
              rows="3"
              required
              minlength="10"
              maxlength="3000"
              placeholder="Explica detalladamente cómo utilizaste el producto y qué resultados obtuviste..."
              class="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-primary-500"
            ></textarea>
          </div>

          <div>
            <label class="block text-sm font-medium text-slate-700 mb-1"
              >Nº de pedido (opcional, para verificación)</label
            >
            <input
              v-model="newOrderId"
              type="text"
              placeholder="Ej. ord-12345"
              class="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-primary-500"
            />
          </div>

          <div class="flex items-center gap-2">
            <input
              id="consent-rev"
              v-model="newConsent"
              type="checkbox"
              required
              class="rounded text-primary-600 focus:ring-primary-500"
            />
            <label for="consent-rev" class="text-xs text-slate-600">
              Acepto la publicación de mi valoración y el tratamiento de datos conforme a la política de privacidad.
            </label>
          </div>

          <button
            type="submit"
            :disabled="submitting || !newConsent"
            class="px-5 py-2.5 bg-primary-600 text-white font-medium rounded-lg hover:bg-primary-700 disabled:opacity-50 text-sm"
          >
            {{ submitting ? 'Enviando...' : 'Publicar reseña' }}
          </button>
        </form>
      </div>
      <div v-else class="mt-6 p-4 bg-slate-50 rounded-lg text-sm text-slate-600 text-center">
        Para publicar una reseña contrastada o verificada, por favor
        <NuxtLink to="/login" class="text-primary-600 font-semibold underline">inicia sesión</NuxtLink>.
      </div>
    </div>

    <!-- Tab 2: Q&A Panel -->
    <div v-else role="tabpanel" class="mt-6 space-y-6">
      <div v-if="questions.length === 0 && !loading" class="text-center py-8 text-slate-500">
        No hay preguntas formuladas sobre este producto todavía.
      </div>

      <div v-for="q in questions" :key="q.id" class="border-b border-slate-100 pb-5 space-y-2">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <span class="font-semibold text-slate-900">{{ q.displayName }}</span>
            <span
              v-if="q.isVerifiedBuyer"
              data-testid="verified-buyer-badge"
              class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-emerald-100 text-emerald-800"
            >
              ✓ Comprador verificado
            </span>
          </div>
        </div>

        <h3 class="font-medium text-slate-900">{{ q.title }}</h3>
        <p class="text-slate-700 text-sm leading-relaxed">{{ q.content }}</p>

        <!-- Official Merchant Answer -->
        <div
          v-if="q.officialAnswer"
          class="mt-3 pl-4 border-l-2 border-primary-500 bg-slate-50 p-3 rounded-r-lg space-y-1"
        >
          <div class="flex items-center gap-2 text-xs font-semibold text-primary-900">
            <span>Respuesta oficial de Neteco</span>
          </div>
          <p class="text-sm text-slate-700">{{ q.officialAnswer }}</p>
        </div>
      </div>

      <!-- Add Question Form -->
      <div v-if="loggedIn" class="mt-8 pt-6 border-t border-slate-200">
        <button
          v-if="!showQuestionForm"
          type="button"
          data-testid="open-question-form"
          class="rounded-md border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-50"
          @click="showQuestionForm = true"
        >
          Hacer una pregunta
        </button>
        <h3 v-if="showQuestionForm" class="font-bold text-slate-900 mb-4">Hacer una pregunta sobre este producto</h3>
        <form v-if="showQuestionForm" class="space-y-4" @submit.prevent="handleQuestionSubmit">
          <div>
            <label class="block text-sm font-medium text-slate-700 mb-1">Título de la consulta</label>
            <input
              v-model="newTitle"
              type="text"
              required
              minlength="3"
              maxlength="160"
              placeholder="¿Se puede aplicar sobre...?"
              class="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-primary-500"
            />
          </div>

          <div>
            <label class="block text-sm font-medium text-slate-700 mb-1">Detalle de la consulta</label>
            <textarea
              v-model="newContent"
              rows="3"
              required
              minlength="10"
              maxlength="3000"
              placeholder="Describe tu duda sobre compatibilidad de materiales, dilución o precauciones de seguridad..."
              class="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-primary-500"
            ></textarea>
          </div>

          <div class="flex items-center gap-2">
            <input
              id="consent-q"
              v-model="newConsent"
              type="checkbox"
              required
              class="rounded text-primary-600 focus:ring-primary-500"
            />
            <label for="consent-q" class="text-xs text-slate-600">
              Acepto la publicación de mi pregunta para asistencia a otros usuarios.
            </label>
          </div>

          <button
            type="submit"
            :disabled="submitting || !newConsent"
            class="px-5 py-2.5 bg-primary-600 text-white font-medium rounded-lg hover:bg-primary-700 disabled:opacity-50 text-sm"
          >
            {{ submitting ? 'Enviando...' : 'Enviar pregunta' }}
          </button>
        </form>
      </div>
      <div v-else class="mt-6 p-4 bg-slate-50 rounded-lg text-sm text-slate-600 text-center">
        Para hacer una pregunta técnica sobre este producto, por favor
        <NuxtLink to="/login" class="text-primary-600 font-semibold underline">inicia sesión</NuxtLink>.
      </div>
    </div>
  </section>
</template>
