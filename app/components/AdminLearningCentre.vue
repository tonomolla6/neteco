<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

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
    notice.value = `Curso «${courseTitle.value}» creado.`
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
    notice.value = `Lección «${lessonTitle.value}» añadida a ${selectedCourse.value.title}.`
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

// Estado de interfaz: paneles laterales y columnas del listado.
const courseOpen = ref(false)
function openCourse() {
  error.value = null
  courseOpen.value = true
}
async function saveCourse() {
  await createCourse()
  if (!error.value && !courseTitle.value) courseOpen.value = false
}
function openLesson(course: Course) {
  error.value = null
  selectedCourse.value = course
}
const lessonOpen = computed({
  get: () => selectedCourse.value !== null,
  set: (open: boolean) => {
    if (!open) selectedCourse.value = null
  }
})
const columns = [
  { key: 'title', label: 'Curso', sortable: true },
  { key: 'status', label: 'Estado' },
  { key: 'durationMinutes', label: 'Duración', numeric: true },
  { key: 'passingScorePercent', label: 'Nota para aprobar', numeric: true, hideOnMobile: true }
]

onMounted(() => {
  loadCourses()
})
</script>

<template>
  <div class="adm-stack">
    <AdminPageActions>
      <AdminButton variant="primary" icon="i-lucide-plus" @click="openCourse">Nuevo curso</AdminButton>
    </AdminPageActions>

    <UAlert
      v-if="notice"
      data-test="notice"
      role="status"
      aria-live="polite"
      color="success"
      variant="subtle"
      icon="i-lucide-circle-check"
      :title="notice"
    />
    <UAlert
      v-if="error && courses.length && !courseOpen && !lessonOpen"
      role="alert"
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      title="No se ha podido completar la operación"
      description="Revisa los datos y vuelve a intentarlo."
    />

    <AdminTable
      aria-labelledby="courses-list-heading"
      :rows="courses"
      :columns="columns"
      :row-key="(row) => row.id"
      :status="loading ? 'pending' : error && !courses.length ? 'error' : 'success'"
      empty-title="Todavía no hay cursos"
      empty-description="Crea el primer curso de formación para tus clientes."
      empty-icon="i-lucide-graduation-cap"
      caption="Cursos disponibles"
      @retry="loadCourses"
    >
      <template #cell-title="{ row }">
        <p class="font-semibold text-[var(--text-strong)]">{{ row.title }}</p>
        <p class="adm-help line-clamp-2">{{ row.description }}</p>
      </template>
      <template #cell-status="{ row }">
        <AdminBadge :status="row.status" />
      </template>
      <template #cell-durationMinutes="{ row }">{{ row.durationMinutes ?? 30 }} min</template>
      <template #cell-passingScorePercent="{ row }">{{ row.passingScorePercent }} %</template>
      <template #actions="{ row }">
        <AdminButton size="sm" icon="i-lucide-plus" @click="openLesson(row)">Añadir lección</AdminButton>
      </template>
      <template #empty-action>
        <AdminButton icon="i-lucide-plus" @click="openCourse">Nuevo curso</AdminButton>
      </template>
    </AdminTable>
    <span id="courses-list-heading" class="sr-only">Cursos disponibles ({{ courses.length }})</span>

    <AdminDrawer v-model:open="courseOpen" title="Nuevo curso">
      <form class="adm-stack" aria-labelledby="create-course-heading" @submit.prevent="saveCourse">
        <span id="create-course-heading" class="sr-only">Crear nuevo curso</span>
        <UAlert
          v-if="error"
          role="alert"
          color="error"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          title="No se ha podido guardar el curso"
          description="Revisa los datos y vuelve a intentarlo."
        />
        <AdminFormField label="Título del curso" for="course-title" required>
          <input
            id="course-title"
            v-model="courseTitle"
            data-test="course-title"
            type="text"
            required
            placeholder="Manipulación segura de productos químicos"
            class="w-full"
          />
        </AdminFormField>
        <AdminFormField
          label="Dirección del curso"
          for="course-slug"
          help="Solo minúsculas y guiones: manipulacion-segura."
          required
        >
          <input
            id="course-slug"
            v-model="courseSlug"
            data-test="course-slug"
            type="text"
            required
            placeholder="manipulacion-segura"
            class="w-full"
          />
        </AdminFormField>
        <AdminFormField label="Descripción" for="course-desc" required>
          <input
            id="course-desc"
            v-model="courseDesc"
            data-test="course-desc"
            type="text"
            required
            placeholder="Qué se aprende y a quién va dirigido"
            class="w-full"
          />
        </AdminFormField>
        <div class="adm-form-grid">
          <AdminFormField label="Nota mínima para aprobar (%)" for="course-score">
            <input id="course-score" v-model.number="passingScore" type="number" min="50" max="100" />
          </AdminFormField>
          <AdminFormField label="Estado" for="course-status">
            <select id="course-status" v-model="courseStatus">
              <option value="draft">Borrador</option>
              <option value="published">Publicado</option>
            </select>
          </AdminFormField>
        </div>
      </form>
      <template #footer>
        <AdminButton @click="courseOpen = false">Cancelar</AdminButton>
        <button
          type="button"
          data-test="save-course-btn"
          :disabled="busy || !courseTitle || !courseSlug || !courseDesc"
          class="adm-btn adm-btn--primary"
          @click="saveCourse"
        >
          {{ busy ? 'Guardando…' : 'Crear curso' }}
        </button>
      </template>
    </AdminDrawer>

    <AdminDrawer v-model:open="lessonOpen" title="Añadir lección" :description="selectedCourse?.title">
      <div class="adm-stack">
        <UAlert
          v-if="error"
          role="alert"
          color="error"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          title="No se ha podido guardar la lección"
          description="Revisa los datos y vuelve a intentarlo."
        />
        <AdminFormField v-slot="{ id }" label="Título de la lección" required>
          <input :id="id" v-model="lessonTitle" type="text" placeholder="Tema 1: …" class="w-full" />
        </AdminFormField>
        <AdminFormField v-slot="{ id }" label="Posición dentro del curso">
          <input :id="id" v-model.number="lessonOrder" type="number" min="1" />
        </AdminFormField>
        <AdminFormField v-slot="{ id }" label="Contenido" required>
          <textarea :id="id" v-model="lessonContent" rows="8" class="w-full" />
        </AdminFormField>
      </div>
      <template #footer>
        <AdminButton @click="selectedCourse = null">Cancelar</AdminButton>
        <AdminButton variant="primary" :disabled="busy || !lessonTitle || !lessonContent" @click="createLesson">
          Guardar lección
        </AdminButton>
      </template>
    </AdminDrawer>
  </div>
</template>
