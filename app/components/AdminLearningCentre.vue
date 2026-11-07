<script setup lang="ts">
import { onMounted, ref } from 'vue'

interface Course {
  id: string
  slug: string
  title: string
  description: string
  passingScorePercent: number
  status: string
  modulesCount?: number
  durationMinutes?: number
}

const requestFetch = useRequestFetch()

const loading = ref(true)
const error = ref<string | null>(null)
const notice = ref<string | null>(null)
const busy = ref(false)

const courses = ref<Course[]>([])

// Create course state
const courseTitle = ref('')
const courseSlug = ref('')
const courseDesc = ref('')
const passingScore = ref(80)
const durationMin = ref(30)
const courseStatus = ref<'published' | 'draft'>('draft')

// Create lesson state
const selectedCourse = ref<Course | null>(null)
const lessonTitle = ref('')
const lessonContent = ref('')
const lessonOrder = ref(1)

function errorMessage(caught: unknown): string {
  const code = (caught as { data?: { error?: { code?: string } } })?.data?.error?.code
  if (code) return code
  return caught instanceof Error ? caught.message : 'error_servidor'
}

async function loadCourses() {
  loading.value = true
  error.value = null
  try {
    const res = await requestFetch<{ courses: Course[] }>('/api/learning/courses')
    courses.value = res.courses ?? []
  } catch (caught) {
    error.value = errorMessage(caught)
  } finally {
    loading.value = false
  }
}

async function createCourse() {
  if (!courseTitle.value.trim() || !courseSlug.value.trim() || !courseDesc.value.trim()) return
  busy.value = true
  error.value = null
  notice.value = null
  try {
    await requestFetch('/api/admin/learning/courses', {
      method: 'POST',
      body: {
        title: courseTitle.value.trim(),
        slug: courseSlug.value.trim(),
        description: courseDesc.value.trim(),
        passingScorePercent: Number(passingScore.value),
        durationMinutes: Number(durationMin.value),
        status: courseStatus.value
      }
    })
    notice.value = `Curso "${courseTitle.value}" creado con éxito.`
    courseTitle.value = ''
    courseSlug.value = ''
    courseDesc.value = ''
    await loadCourses()
  } catch (caught) {
    error.value = errorMessage(caught)
  } finally {
    busy.value = false
  }
}

async function createLesson() {
  if (!selectedCourse.value || !lessonTitle.value.trim() || !lessonContent.value.trim()) return
  busy.value = true
  error.value = null
  notice.value = null
  try {
    await requestFetch('/api/admin/learning/lessons', {
      method: 'POST',
      body: {
        courseId: selectedCourse.value.id,
        title: lessonTitle.value.trim(),
        content: lessonContent.value.trim(),
        sortOrder: Number(lessonOrder.value),
        quizQuestionsJson: '[]'
      }
    })
    notice.value = `Lección "${lessonTitle.value}" añadida a ${selectedCourse.value.title}.`
    lessonTitle.value = ''
    lessonContent.value = ''
    selectedCourse.value = null
    await loadCourses()
  } catch (caught) {
    error.value = errorMessage(caught)
  } finally {
    busy.value = false
  }
}

onMounted(() => {
  loadCourses()
})
</script>

<template>
  <div class="space-y-6">
    <header>
      <h1 class="text-2xl font-bold text-slate-900">Centro de formación y aprendizaje (MKT-033)</h1>
      <p class="text-sm text-slate-600">
        Cursos interactivos, lecciones multimedia y certificación oficial de competencias químicas para clientes
        profesionales.
      </p>
    </header>

    <div
      v-if="notice"
      data-test="notice"
      role="status"
      aria-live="polite"
      class="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800"
    >
      {{ notice }}
    </div>

    <div v-if="error" role="alert" class="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
      Error: {{ error }}
    </div>

    <!-- Create Course Form -->
    <section aria-labelledby="create-course-heading" class="rounded-xl border border-slate-200 bg-white p-5 shadow-xs">
      <h2 id="create-course-heading" class="text-base font-semibold text-slate-900">Crear nuevo curso</h2>
      <form class="mt-4 grid grid-cols-1 md:grid-cols-3 gap-3" @submit.prevent="createCourse">
        <div>
          <label for="course-title" class="block text-xs font-medium text-slate-700">Título del curso</label>
          <input
            id="course-title"
            v-model="courseTitle"
            data-test="course-title"
            type="text"
            required
            placeholder="Manipulación Segura..."
            class="mt-1 w-full rounded border p-1.5 text-sm"
          />
        </div>
        <div>
          <label for="course-slug" class="block text-xs font-medium text-slate-700">Slug identificador</label>
          <input
            id="course-slug"
            v-model="courseSlug"
            data-test="course-slug"
            type="text"
            required
            placeholder="manipulacion-segura"
            class="mt-1 w-full rounded border p-1.5 text-sm font-mono"
          />
        </div>
        <div>
          <label for="course-score" class="block text-xs font-medium text-slate-700">% Mínimo para aprobar</label>
          <input
            id="course-score"
            v-model.number="passingScore"
            type="number"
            min="50"
            max="100"
            class="mt-1 w-full rounded border p-1.5 text-sm"
          />
        </div>

        <div class="md:col-span-2">
          <label for="course-desc" class="block text-xs font-medium text-slate-700">Descripción pedagógica</label>
          <input
            id="course-desc"
            v-model="courseDesc"
            data-test="course-desc"
            type="text"
            required
            placeholder="Objetivos, temario y competencias adquiridas..."
            class="mt-1 w-full rounded border p-1.5 text-sm"
          />
        </div>

        <div>
          <label for="course-status" class="block text-xs font-medium text-slate-700">Estado de publicación</label>
          <select id="course-status" v-model="courseStatus" class="mt-1 w-full rounded border p-1.5 text-sm">
            <option value="draft">Borrador</option>
            <option value="published">Publicado</option>
          </select>
        </div>

        <div class="md:col-span-3 pt-2">
          <button
            type="button"
            data-test="save-course-btn"
            :disabled="busy || !courseTitle || !courseSlug || !courseDesc"
            class="rounded bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
            @click="createCourse"
          >
            {{ busy ? 'Guardando...' : 'Crear curso' }}
          </button>
        </div>
      </form>
    </section>

    <!-- Courses List -->
    <section
      aria-labelledby="courses-list-heading"
      class="rounded-xl border border-slate-200 bg-white p-5 shadow-xs space-y-4"
    >
      <h2 id="courses-list-heading" class="text-base font-semibold text-slate-900">
        Cursos disponibles ({{ courses.length }})
      </h2>

      <div v-if="courses.length === 0 && !loading" class="text-xs text-slate-500 py-3">
        No hay cursos en el catálogo formativo.
      </div>

      <div v-else class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <article
          v-for="c in courses"
          :key="c.id"
          class="rounded-lg border border-slate-200 p-4 space-y-2 hover:border-indigo-300 transition-colors"
        >
          <div class="flex items-start justify-between">
            <div>
              <span class="text-[11px] font-mono text-slate-500">{{ c.slug }}</span>
              <h3 class="font-bold text-slate-900 text-base">{{ c.title }}</h3>
            </div>
            <span
              class="rounded-full px-2 py-0.5 text-[11px] font-semibold"
              :class="c.status === 'published' ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-600'"
            >
              {{ c.status }}
            </span>
          </div>

          <p class="text-xs text-slate-600 line-clamp-2">{{ c.description }}</p>

          <div class="flex items-center gap-4 text-xs text-slate-500 pt-2 border-t">
            <span>{{ c.durationMinutes ?? 30 }} min</span>
            <span>Aprobado: {{ c.passingScorePercent }}%</span>
            <button
              type="button"
              class="ml-auto text-indigo-600 hover:text-indigo-800 font-medium"
              @click="selectedCourse = c"
            >
              + Añadir lección
            </button>
          </div>
        </article>
      </div>
    </section>

    <!-- Add Lesson Section (when course selected) -->
    <section v-if="selectedCourse" class="rounded-xl border border-indigo-200 bg-indigo-50/50 p-5 space-y-3">
      <div class="flex justify-between items-center">
        <h3 class="font-bold text-slate-900 text-sm">Añadir lección al curso: {{ selectedCourse.title }}</h3>
        <button type="button" class="text-xs text-slate-500 hover:text-slate-700" @click="selectedCourse = null">
          Cancelar
        </button>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div>
          <label class="block text-xs text-slate-700">Título de la lección</label>
          <input
            v-model="lessonTitle"
            type="text"
            placeholder="Tema 1:..."
            class="mt-1 w-full rounded border p-1 text-xs bg-white"
          />
        </div>
        <div>
          <label class="block text-xs text-slate-700">Orden de impartición</label>
          <input
            v-model.number="lessonOrder"
            type="number"
            min="1"
            class="mt-1 w-full rounded border p-1 text-xs bg-white"
          />
        </div>
        <div class="md:col-span-3">
          <label class="block text-xs text-slate-700">Contenido pedagógico (Markdown / Texto)</label>
          <textarea v-model="lessonContent" rows="3" class="mt-1 w-full rounded border p-1 text-xs bg-white" />
        </div>
      </div>

      <button
        type="button"
        :disabled="busy || !lessonTitle || !lessonContent"
        class="rounded bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
        @click="createLesson"
      >
        Guardar lección
      </button>
    </section>
  </div>
</template>
