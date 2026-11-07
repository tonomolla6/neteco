<script setup lang="ts">
import { ref, onMounted } from 'vue'
import type {
  TemplateSummary,
  TemplateListResponse,
  TemplateCategory,
  TemplateType
} from '~~/shared/downloadable-templates'

const props = withDefaults(
  defineProps<{
    initialCategory?: string
    initialType?: string
  }>(),
  {
    initialCategory: '',
    initialType: ''
  }
)

const request = useRequestFetch()

const query = ref('')
const selectedCategory = ref(props.initialCategory)
const selectedType = ref(props.initialType)
const loading = ref(true)
const error = ref<string | null>(null)
const templates = ref<TemplateSummary[]>([])
const total = ref(0)

const CATEGORIES: Array<{ value: TemplateCategory; label: string }> = [
  { value: 'hosteleria', label: 'Hostelería y Restauración' },
  { value: 'industria', label: 'Industria' },
  { value: 'sanitario', label: 'Sanitario y Sociosanitario' },
  { value: 'lavanderia', label: 'Lavandería Industrial' },
  { value: 'alimentaria', label: 'Industria Alimentaria (APPCC)' },
  { value: 'mantenimiento', label: 'Mantenimiento e Instalaciones' }
]

const TYPES: Array<{ value: TemplateType; label: string }> = [
  { value: 'checklist', label: 'Checklist de Control' },
  { value: 'plan', label: 'Plan de Limpieza' },
  { value: 'guide', label: 'Guía Técnica' }
]

async function fetchTemplates() {
  loading.value = true
  error.value = null
  try {
    const params = new URLSearchParams()
    if (query.value.trim()) params.set('q', query.value.trim())
    if (selectedCategory.value) params.set('category', selectedCategory.value)
    if (selectedType.value) params.set('type', selectedType.value)

    const url = `/api/templates${params.toString() ? `?${params.toString()}` : ''}`
    const data = await request<TemplateListResponse>(url, { method: 'GET' })
    templates.value = data.items
    total.value = data.total
  } catch {
    error.value = 'No se pudieron cargar las plantillas profesionales. Por favor, reintente más tarde.'
  } finally {
    loading.value = false
  }
}

function onSearch() {
  fetchTemplates()
}

function resetFilters() {
  query.value = ''
  selectedCategory.value = ''
  selectedType.value = ''
  fetchTemplates()
}

onMounted(() => {
  fetchTemplates()
})
</script>

<template>
  <div class="mx-auto max-w-6xl px-4 py-8" data-testid="downloadable-templates-panel">
    <!-- Header banner -->
    <div class="mb-8 rounded-2xl bg-gradient-to-r from-sky-900 to-blue-800 p-8 text-white shadow-md">
      <div class="max-w-3xl">
        <span
          class="inline-block rounded-full bg-sky-700/60 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-sky-200"
        >
          Documentación Oficial y Guías Técnicas
        </span>
        <h1 class="mt-3 text-3xl font-extrabold tracking-tight sm:text-4xl">Biblioteca de Plantillas Descargables</h1>
        <p class="mt-3 text-base text-sky-100 sm:text-lg">
          Checklists higiénicos, planes de limpieza APPCC y protocolos de autocontrol químico versionados. Disponibles
          para consulta directa en HTML indexable y descarga en PDF accesible conforme a normativa.
        </p>
      </div>
    </div>

    <!-- Filter controls -->
    <div class="mb-6 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-4">
        <!-- Search bar -->
        <div class="sm:col-span-2">
          <label for="template-search" class="block text-xs font-medium text-slate-700">Buscar por palabra clave</label>
          <input
            id="template-search"
            v-model="query"
            type="search"
            placeholder="Ej. APPCC, desinfección, cocinas..."
            class="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            @keyup.enter="onSearch"
          />
        </div>

        <!-- Category selector -->
        <div>
          <label for="template-category" class="block text-xs font-medium text-slate-700">Sector / Categoría</label>
          <select
            id="template-category"
            v-model="selectedCategory"
            class="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            @change="fetchTemplates"
          >
            <option value="">Todos los sectores</option>
            <option v-for="cat in CATEGORIES" :key="cat.value" :value="cat.value">
              {{ cat.label }}
            </option>
          </select>
        </div>

        <!-- Type selector -->
        <div>
          <label for="template-type" class="block text-xs font-medium text-slate-700">Tipo de formato</label>
          <select
            id="template-type"
            v-model="selectedType"
            class="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            @change="fetchTemplates"
          >
            <option value="">Todos los formatos</option>
            <option v-for="t in TYPES" :key="t.value" :value="t.value">
              {{ t.label }}
            </option>
          </select>
        </div>
      </div>

      <div class="mt-4 flex items-center justify-between border-t border-slate-100 pt-3">
        <span class="text-xs text-slate-500">
          {{ total }} {{ total === 1 ? 'plantilla encontrada' : 'plantillas encontradas' }}
        </span>
        <button
          v-if="query || selectedCategory || selectedType"
          type="button"
          class="text-xs font-semibold text-blue-600 hover:text-blue-800"
          @click="resetFilters"
        >
          Limpiar filtros
        </button>
      </div>
    </div>

    <!-- Loading state -->
    <div v-if="loading" class="py-12 text-center" aria-busy="true" data-testid="templates-loading">
      <div
        class="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-blue-600 border-r-transparent align-[-0.125em]"
      />
      <p class="mt-3 text-sm text-slate-500">Cargando biblioteca de plantillas...</p>
    </div>

    <!-- Error state -->
    <div
      v-else-if="error"
      class="rounded-xl border border-red-200 bg-red-50 p-6 text-center text-red-800"
      role="alert"
      data-testid="templates-error"
    >
      <p class="text-sm font-semibold">{{ error }}</p>
      <button
        type="button"
        class="mt-3 rounded-lg bg-red-600 px-4 py-2 text-xs font-bold text-white hover:bg-red-700"
        @click="fetchTemplates"
      >
        Reintentar
      </button>
    </div>

    <!-- Empty state -->
    <div
      v-else-if="templates.length === 0"
      class="rounded-xl border border-dashed border-slate-300 bg-white p-12 text-center"
      data-testid="templates-empty"
    >
      <h3 class="mt-3 text-base font-semibold text-slate-800">No se encontraron plantillas</h3>
      <p class="mt-1 text-sm text-slate-500">No hay plantillas que coincidan con los criterios de búsqueda actuales.</p>
      <button
        type="button"
        class="mt-4 rounded-lg bg-blue-600 px-4 py-2 text-xs font-bold text-white hover:bg-blue-700"
        @click="resetFilters"
      >
        Ver todas las plantillas
      </button>
    </div>

    <!-- Template grid -->
    <div v-else class="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3" data-testid="templates-grid">
      <article
        v-for="tpl in templates"
        :key="tpl.id"
        class="flex flex-col justify-between rounded-xl border border-slate-200 bg-white p-6 shadow-sm transition hover:shadow-md"
        data-testid="template-card"
      >
        <div>
          <div class="flex items-center justify-between gap-2">
            <span
              class="inline-flex rounded-full bg-blue-50 px-2.5 py-0.5 text-xs font-semibold text-blue-700 uppercase"
            >
              {{ tpl.templateType }}
            </span>
            <span class="text-xs text-slate-400">v{{ tpl.version }}</span>
          </div>

          <h2 class="mt-3 text-lg font-bold text-slate-900 leading-snug">
            <NuxtLink :to="tpl.canonicalPath" class="hover:text-blue-600">
              {{ tpl.title }}
            </NuxtLink>
          </h2>

          <p class="mt-2 text-sm text-slate-600 line-clamp-3">
            {{ tpl.description }}
          </p>

          <div class="mt-4 border-t border-slate-100 pt-3 text-xs text-slate-500">
            <p><strong>Sector:</strong> {{ tpl.category }}</p>
            <p class="mt-1"><strong>Dirigido a:</strong> {{ tpl.targetAudience }}</p>
            <p class="mt-1"><strong>Puntos de control:</strong> {{ tpl.itemCount }} ítems verificables</p>
          </div>
        </div>

        <div class="mt-6 flex items-center justify-between gap-2 border-t border-slate-100 pt-4">
          <NuxtLink :to="tpl.canonicalPath" class="text-xs font-bold text-blue-600 hover:text-blue-800">
            Ver online →
          </NuxtLink>

          <a
            :href="tpl.downloadUrl"
            download
            class="inline-flex items-center gap-1 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-slate-800"
            :title="`Descargar PDF accesible: ${tpl.title}`"
          >
            Descargar PDF
          </a>
        </div>
      </article>
    </div>
  </div>
</template>
