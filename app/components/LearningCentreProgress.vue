<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  LEGAL_NON_OFFICIAL_ACCREDITATION_DISCLAIMER,
  type Certificate,
  type Course,
  type Lesson
} from '../../shared/learning-centre'

const props = defineProps<{
  courseSlug: string
}>()

const requestFetch = useRequestFetch()
const loading = ref(true)
const errorMessage = ref('')
const course = ref<(Course & { lessons: Lesson[] }) | null>(null)
const activeLessonId = ref<string | null>(null)

// Quiz form state
const selectedAnswers = ref<Record<string, string>>({})
const quizSubmitting = ref(false)
const quizFeedback = ref<{ passed: boolean; scorePercent: number } | null>(null)

// Certificate issuance state
const recipientName = ref('')
const companyName = ref('')
const issuingCert = ref(false)
const issuedCertificate = ref<Certificate | null>(null)

function errorText(error: unknown, fallback: string): string {
  const code = (error as { data?: { error?: { code?: string } } })?.data?.error?.code
  return code ? `${fallback} (${code})` : fallback
}

async function loadCourse() {
  loading.value = true
  errorMessage.value = ''
  try {
    const res = (await requestFetch(`/api/learning/courses/${props.courseSlug}`)) as {
      course: Course & { lessons: Lesson[] }
    }
    course.value = res?.course ?? null
    const firstLesson = course.value?.lessons[0]
    if (firstLesson && !activeLessonId.value) {
      activeLessonId.value = firstLesson.id
    }
  } catch (error) {
    errorMessage.value = errorText(error, 'Error al cargar el curso formativo')
  } finally {
    loading.value = false
  }
}

const activeLesson = computed(() => {
  return course.value?.lessons.find((l) => l.id === activeLessonId.value) ?? null
})

const allLessonsPassed = computed(() => {
  if (!course.value?.lessons?.length) return false
  return course.value.lessons.every((l) => l.progress?.passed)
})

async function submitQuiz(lessonId: string) {
  quizSubmitting.value = true
  try {
    const res = (await requestFetch(`/api/learning/lessons/${lessonId}/quiz`, {
      method: 'POST',
      body: { answers: selectedAnswers.value }
    })) as { passed: boolean; scorePercent: number }
    quizFeedback.value = res
    await loadCourse()
  } catch (error) {
    errorMessage.value = errorText(error, 'Error al enviar las respuestas del cuestionario')
  } finally {
    quizSubmitting.value = false
  }
}

async function issueCertificate() {
  if (!course.value || !recipientName.value.trim()) return
  issuingCert.value = true
  try {
    const res = (await requestFetch(`/api/learning/courses/${course.value.id}/certificate`, {
      method: 'POST',
      body: {
        recipientName: recipientName.value.trim(),
        companyName: companyName.value.trim() || undefined
      }
    })) as { certificate: Certificate }
    issuedCertificate.value = res?.certificate ?? null
  } catch (error) {
    errorMessage.value = errorText(error, 'Error al emitir el certificado')
  } finally {
    issuingCert.value = false
  }
}

onMounted(() => {
  loadCourse()
})
</script>

<template>
  <div class="learning-centre-progress p-6 max-w-5xl mx-auto space-y-6">
    <!-- Legal Non-official Disclaimer Banner (Mandatory Acceptance Criterion MKT-033) -->
    <div class="bg-amber-50 border-l-4 border-amber-500 p-4 rounded text-sm text-amber-900 shadow-sm" role="alert">
      <div class="flex items-start gap-3">
        <span class="font-semibold text-amber-800">Aviso informativo:</span>
        <p>{{ LEGAL_NON_OFFICIAL_ACCREDITATION_DISCLAIMER }}</p>
      </div>
    </div>

    <!-- Loading State -->
    <div v-if="loading" class="p-8 text-center text-slate-500 animate-pulse">
      Cargando contenidos formativos y progreso del alumno...
    </div>

    <!-- Error State -->
    <div
      v-else-if="errorMessage"
      class="p-6 bg-red-50 border border-red-200 rounded text-red-700 flex flex-col items-center gap-3"
    >
      <p>{{ errorMessage }}</p>
      <button
        data-test="retry-btn"
        class="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded text-sm font-medium transition"
        @click="loadCourse"
      >
        Reintentar
      </button>
    </div>

    <!-- Course Content -->
    <div v-else-if="course" class="space-y-6">
      <header class="border-b pb-4">
        <div class="flex items-center justify-between">
          <span class="text-xs uppercase tracking-wider font-semibold px-2 py-1 bg-blue-100 text-blue-800 rounded">
            {{ course.category }}
          </span>
          <span class="text-xs text-slate-500">
            Aprobado mínimo: {{ course.passingScorePercent }}% | Duración: {{ course.estimatedDurationMinutes }} min
          </span>
        </div>
        <h1 class="text-2xl font-bold text-slate-900 mt-2">{{ course.title }}</h1>
        <p class="text-slate-600 text-sm mt-1">{{ course.description }}</p>
      </header>

      <!-- Layout: Lessons List & Active Lesson Content -->
      <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
        <!-- Sidebar: Lessons List -->
        <nav aria-label="Lecciones del curso" class="space-y-2">
          <h2 class="text-sm font-bold text-slate-700 uppercase tracking-wide mb-3">Módulos del Curso</h2>
          <button
            v-for="lesson in course.lessons"
            :key="lesson.id"
            :class="[
              'w-full text-left p-3 rounded border text-sm transition flex items-center justify-between',
              activeLessonId === lesson.id
                ? 'border-blue-600 bg-blue-50 text-blue-900 font-medium'
                : 'border-slate-200 hover:bg-slate-50 text-slate-700'
            ]"
            @click="activeLessonId = lesson.id"
          >
            <div class="truncate pr-2">
              <span class="text-xs text-slate-500 block">Lección {{ lesson.sortOrder }}</span>
              <span class="truncate">{{ lesson.title }}</span>
            </div>
            <span
              v-if="lesson.progress?.passed"
              class="text-xs font-semibold px-2 py-0.5 bg-green-100 text-green-800 rounded shrink-0"
            >
              Superada
            </span>
            <span
              v-else-if="lesson.progress?.quizScorePercent !== null && lesson.progress?.quizScorePercent !== undefined"
              class="text-xs font-semibold px-2 py-0.5 bg-red-100 text-red-800 rounded shrink-0"
            >
              {{ lesson.progress.quizScorePercent }}%
            </span>
          </button>
        </nav>

        <!-- Main Content: Active Lesson Detail -->
        <main class="md:col-span-2 space-y-6">
          <article v-if="activeLesson" class="bg-white border rounded p-6 shadow-sm space-y-4">
            <h2 class="text-xl font-bold text-slate-900">{{ activeLesson.title }}</h2>
            <p class="text-sm text-slate-600">{{ activeLesson.summary }}</p>

            <div class="prose prose-sm max-w-none text-slate-800 bg-slate-50 p-4 rounded border">
              {{ activeLesson.contentMarkdown }}
            </div>

            <!-- Product and Technical Support Links (Acceptance Criterion MKT-033) -->
            <div class="bg-indigo-50 border border-indigo-100 p-4 rounded space-y-3">
              <h3 class="text-xs font-bold text-indigo-900 uppercase tracking-wide">
                Productos recomendados y soporte técnico especializado
              </h3>
              <div v-if="activeLesson.linkedProductIds.length" class="flex flex-wrap gap-2">
                <span
                  v-for="pid in activeLesson.linkedProductIds"
                  :key="pid"
                  class="text-xs px-2.5 py-1 bg-white border border-indigo-200 text-indigo-700 rounded font-medium"
                >
                  Producto: {{ pid }}
                </span>
              </div>
              <div class="pt-2 border-t border-indigo-100 flex items-center justify-between text-xs">
                <span class="text-slate-600">Tema de asistencia: {{ activeLesson.supportTopic }}</span>
                <a
                  :href="activeLesson.supportActionUrl"
                  class="font-medium text-indigo-700 hover:text-indigo-900 underline"
                >
                  {{ activeLesson.supportActionLabel }} &rarr;
                </a>
              </div>
            </div>

            <!-- Quiz Section -->
            <div v-if="activeLesson.quizQuestions.length" class="border-t pt-4 space-y-4">
              <h3 class="text-base font-bold text-slate-900">Cuestionario de aprovechamiento</h3>
              <div v-for="q in activeLesson.quizQuestions" :key="q.id" class="space-y-2 p-3 bg-slate-50 rounded border">
                <p class="text-sm font-medium text-slate-800">{{ q.question }}</p>
                <div class="space-y-1">
                  <label
                    v-for="opt in q.options"
                    :key="opt.id"
                    class="flex items-center gap-2 text-sm text-slate-700 cursor-pointer p-1 rounded hover:bg-white"
                  >
                    <input
                      v-model="selectedAnswers[q.id]"
                      type="radio"
                      :name="`question-${q.id}`"
                      :value="opt.id"
                      class="text-blue-600"
                    />
                    <span>{{ opt.text }}</span>
                  </label>
                </div>
              </div>

              <div class="flex items-center justify-between pt-2">
                <button
                  :disabled="quizSubmitting"
                  class="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded text-sm font-medium transition"
                  @click="submitQuiz(activeLesson.id)"
                >
                  {{ quizSubmitting ? 'Evaluando...' : 'Enviar respuestas del test' }}
                </button>
                <span
                  v-if="quizFeedback"
                  :class="[
                    'text-xs font-semibold px-2.5 py-1 rounded',
                    quizFeedback.passed ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
                  ]"
                >
                  Nota: {{ quizFeedback.scorePercent }}% ({{ quizFeedback.passed ? 'Aprobado' : 'No superado' }})
                </span>
              </div>
            </div>
          </article>
        </main>
      </div>

      <!-- Certificate Section -->
      <section class="border-t pt-6 bg-slate-50 p-6 rounded border space-y-4">
        <h2 class="text-lg font-bold text-slate-900">Certificado de aprovechamiento interno</h2>
        <div v-if="issuedCertificate" class="bg-white p-6 border-2 border-green-500 rounded space-y-3">
          <div class="flex items-center justify-between">
            <span class="text-xs font-bold text-green-800 uppercase px-2 py-0.5 bg-green-100 rounded">
              Certificado emitido con éxito
            </span>
            <span class="text-xs font-mono text-slate-500">Ref: {{ issuedCertificate.certificateCode }}</span>
          </div>
          <h3 class="text-xl font-bold text-slate-900">{{ issuedCertificate.courseTitle }}</h3>
          <p class="text-sm text-slate-700">
            Otorgado a: <strong>{{ issuedCertificate.recipientName }}</strong>
            <span v-if="issuedCertificate.companyName"> ({{ issuedCertificate.companyName }})</span>
          </p>
          <p class="text-xs text-slate-500 font-mono">
            Hash verificación SHA-256: {{ issuedCertificate.verificationHash }}
          </p>
          <p class="text-xs italic text-slate-500">{{ issuedCertificate.legalDisclaimer }}</p>
        </div>

        <div v-else-if="allLessonsPassed" class="space-y-4">
          <p class="text-sm text-slate-700">
            ¡Enhorabuena! Has superado todas las lecciones del curso con éxito. Introduce los datos para generar tu
            certificado interno:
          </p>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <input
              v-model="recipientName"
              type="text"
              placeholder="Nombre y apellidos del alumno"
              class="border rounded px-3 py-2 text-sm"
            />
            <input
              v-model="companyName"
              type="text"
              placeholder="Empresa (opcional)"
              class="border rounded px-3 py-2 text-sm"
            />
          </div>
          <button
            :disabled="issuingCert || !recipientName.trim()"
            class="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded text-sm font-medium transition"
            @click="issueCertificate"
          >
            {{ issuingCert ? 'Generando certificado...' : 'Obtener certificado interno' }}
          </button>
        </div>

        <div v-else class="text-sm text-slate-500">
          Debes completar y aprobar los tests de todas las lecciones del curso para poder solicitar el certificado
          interno de aprovechamiento.
        </div>
      </section>
    </div>
  </div>
</template>
