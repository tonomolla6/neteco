<template>
  <div class="space-y-6" data-testid="admin-editorial-seo-briefing-panel">
    <!-- Header -->
    <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
      <div>
        <h1 class="text-2xl font-bold text-slate-900">Calendario Editorial y Briefing SEO</h1>
        <p class="text-sm text-slate-600">
          Planificación editorial, intenciones de búsqueda, autores expertos, fuentes verificadas y KPIs orgánicos.
        </p>
      </div>
      <div class="flex items-center gap-2">
        <button
          type="button"
          class="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 shadow-sm transition"
          data-testid="btn-create-briefing"
          @click="showCreateModal = true"
        >
          Nuevo Briefing SEO
        </button>
      </div>
    </div>

    <!-- Month Navigation and Filters -->
    <div
      class="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
    >
      <div class="flex items-center gap-2">
        <button
          type="button"
          class="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          data-testid="btn-prev-month"
          @click="changeMonth(-1)"
        >
          &larr; Mes anterior
        </button>
        <span class="font-semibold text-slate-800 text-sm px-2">{{ currentMonth }}</span>
        <button
          type="button"
          class="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          data-testid="btn-next-month"
          @click="changeMonth(1)"
        >
          Mes siguiente &rarr;
        </button>
      </div>

      <div class="flex flex-wrap items-center gap-3 text-xs">
        <label class="flex items-center gap-1.5 font-medium text-slate-700">
          Intención:
          <select
            v-model="intentFilter"
            class="rounded border border-slate-300 px-2 py-1 text-xs"
            data-testid="select-intent-filter"
          >
            <option value="">Todas</option>
            <option value="informational">Informacional</option>
            <option value="commercial">Comercial</option>
            <option value="transactional">Transaccional</option>
            <option value="navigational">Navegacional</option>
          </select>
        </label>
        <label class="flex items-center gap-1.5 font-medium text-slate-700">
          Revisión:
          <select
            v-model="reviewFilter"
            class="rounded border border-slate-300 px-2 py-1 text-xs"
            data-testid="select-review-filter"
          >
            <option value="">Todos los estados</option>
            <option value="pending">Pendiente</option>
            <option value="in_review">En revisión</option>
            <option value="approved">Aprobado</option>
            <option value="rejected">Rechazado</option>
          </select>
        </label>
      </div>
    </div>

    <!-- Metrics Cards -->
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-4" data-testid="metrics-overview">
      <div class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div class="text-xs font-medium text-slate-500 uppercase tracking-wider">Planificados</div>
        <div class="mt-1 text-2xl font-bold text-slate-900" data-testid="metric-planned">
          {{ calendarData?.metrics?.totalPlanned ?? 0 }}
        </div>
      </div>
      <div class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div class="text-xs font-medium text-slate-500 uppercase tracking-wider">En Revisión</div>
        <div class="mt-1 text-2xl font-bold text-amber-600" data-testid="metric-in-review">
          {{ calendarData?.metrics?.totalInReview ?? 0 }}
        </div>
      </div>
      <div class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div class="text-xs font-medium text-slate-500 uppercase tracking-wider">Aprobados</div>
        <div class="mt-1 text-2xl font-bold text-emerald-600" data-testid="metric-approved">
          {{ calendarData?.metrics?.totalApproved ?? 0 }}
        </div>
      </div>
      <div class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div class="text-xs font-medium text-slate-500 uppercase tracking-wider">Publicados</div>
        <div class="mt-1 text-2xl font-bold text-blue-600" data-testid="metric-published">
          {{ calendarData?.metrics?.totalPublished ?? 0 }}
        </div>
      </div>
    </div>

    <!-- Loading / Error States -->
    <div v-if="loading" class="p-8 text-center text-slate-500">Cargando briefings y calendario editorial...</div>
    <div v-else-if="error" class="p-4 rounded-xl bg-red-50 text-red-700 border border-red-200 text-sm">
      Error al cargar los briefings: {{ error }}
    </div>

    <!-- Briefings List -->
    <div
      v-else-if="filteredBriefings.length === 0"
      class="rounded-xl border border-dashed border-slate-300 p-8 text-center text-slate-500"
    >
      No hay briefings editoriales registrados para {{ currentMonth }}.
    </div>

    <div v-else class="space-y-4">
      <div
        v-for="brief in filteredBriefings"
        :key="brief.id"
        class="rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition hover:shadow-md"
        data-testid="briefing-card"
      >
        <div class="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
          <div class="space-y-1">
            <div class="flex flex-wrap items-center gap-2">
              <span
                class="rounded-full px-2.5 py-0.5 text-xs font-semibold capitalize"
                :class="intentBadgeClass(brief.searchIntent)"
              >
                {{ brief.searchIntent }}
              </span>
              <span
                class="rounded-full px-2.5 py-0.5 text-xs font-semibold capitalize"
                :class="statusBadgeClass(brief.reviewStatus)"
              >
                {{ brief.reviewStatus }}
              </span>
              <span class="text-xs text-slate-500">
                Fecha objetivo: <strong>{{ brief.targetPublishDate }}</strong>
              </span>
            </div>
            <h2 class="text-lg font-bold text-slate-900">{{ brief.topic }}</h2>
            <div class="text-xs text-slate-600">
              Keyword objetivo: <span class="font-semibold text-slate-800">{{ brief.targetKeyword }}</span>
              <span v-if="brief.secondaryKeywords?.length" class="ml-2 text-slate-500">
                (Secundarias: {{ brief.secondaryKeywords.join(', ') }})
              </span>
            </div>
          </div>
        </div>

        <div class="mt-4 grid grid-cols-1 md:grid-cols-3 gap-4 border-t border-slate-100 pt-3 text-xs">
          <!-- Autor Experto & Fuentes -->
          <div class="space-y-1.5">
            <div class="font-semibold text-slate-700">Autor Experto &amp; Fuentes</div>
            <div class="text-slate-600">
              <strong>{{ brief.expertAuthor?.name }}</strong> — {{ brief.expertAuthor?.credentials }}
            </div>
            <div v-if="brief.sources?.length" class="text-slate-500">
              Fuentes: {{ brief.sources.map((s: any) => s.title).join('; ') }}
            </div>
          </div>

          <!-- Assets Multimedia -->
          <div class="space-y-1.5">
            <div class="font-semibold text-slate-700">Assets Multimedia</div>
            <div v-if="brief.assets?.length" class="text-slate-600">
              <span
                v-for="(asset, idx) in brief.assets"
                :key="idx"
                class="inline-block mr-2 mb-1 rounded bg-slate-100 px-2 py-0.5"
              >
                {{ asset.assetType }}: {{ asset.name }}
              </span>
            </div>
            <div v-else class="text-slate-400">Sin assets asignados</div>
          </div>

          <!-- Metas KPI -->
          <div class="space-y-1.5">
            <div class="font-semibold text-slate-700">Metas KPI</div>
            <div class="text-slate-600">
              Visitas mensuales: <strong>{{ brief.kpiTargets?.targetMonthlyVisits }}</strong> | SERP Rank:
              <strong>#{{ brief.kpiTargets?.targetSerpRank }}</strong>
            </div>
            <div class="text-slate-500">Objetivo: {{ brief.kpiTargets?.conversionGoal }}</div>
          </div>
        </div>
      </div>
    </div>

    <!-- Modal Nuevo Briefing -->
    <div
      v-if="showCreateModal"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      data-testid="modal-create-briefing"
    >
      <div class="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-6 shadow-xl space-y-4">
        <div class="flex items-center justify-between border-b pb-3">
          <h3 class="text-lg font-bold text-slate-900">Crear Nuevo Briefing SEO</h3>
          <button type="button" class="text-slate-400 hover:text-slate-600" @click="showCreateModal = false">✕</button>
        </div>

        <form class="space-y-4 text-xs" @submit.prevent="submitBriefing">
          <div>
            <label class="block font-medium text-slate-700">Tema / Título del Contenido *</label>
            <input
              v-model="newBriefing.topic"
              required
              class="mt-1 w-full rounded border border-slate-300 p-2 text-sm"
              placeholder="Ej: Guía de limpieza y desinfección en la industria láctea"
            />
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label class="block font-medium text-slate-700">Intención de Búsqueda *</label>
              <select
                v-model="newBriefing.searchIntent"
                required
                class="mt-1 w-full rounded border border-slate-300 p-2 text-sm"
              >
                <option value="informational">Informacional</option>
                <option value="commercial">Comercial</option>
                <option value="transactional">Transaccional</option>
                <option value="navigational">Navegacional</option>
              </select>
            </div>
            <div>
              <label class="block font-medium text-slate-700">Keyword Objetivo *</label>
              <input
                v-model="newBriefing.targetKeyword"
                required
                class="mt-1 w-full rounded border border-slate-300 p-2 text-sm"
                placeholder="Ej: desinfectante industrial lacteo"
              />
            </div>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label class="block font-medium text-slate-700">Nombre Autor Experto *</label>
              <input
                v-model="newBriefing.expertAuthor.name"
                required
                class="mt-1 w-full rounded border border-slate-300 p-2 text-sm"
                placeholder="Ej: Dr. Roberto Méndez"
              />
            </div>
            <div>
              <label class="block font-medium text-slate-700">Credenciales del Autor *</label>
              <input
                v-model="newBriefing.expertAuthor.credentials"
                required
                class="mt-1 w-full rounded border border-slate-300 p-2 text-sm"
                placeholder="Ej: Químico colegiado nº 241, Especialista HACCP"
              />
            </div>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label class="block font-medium text-slate-700">Fecha Objetivo Publicación *</label>
              <input
                v-model="newBriefing.targetPublishDate"
                type="date"
                required
                class="mt-1 w-full rounded border border-slate-300 p-2 text-sm"
              />
            </div>
            <div>
              <label class="block font-medium text-slate-700">Visitas Meta / Mes *</label>
              <input
                v-model.number="newBriefing.kpiTargets.targetMonthlyVisits"
                type="number"
                min="0"
                required
                class="mt-1 w-full rounded border border-slate-300 p-2 text-sm"
              />
            </div>
            <div>
              <label class="block font-medium text-slate-700">SERP Rank Meta *</label>
              <input
                v-model.number="newBriefing.kpiTargets.targetSerpRank"
                type="number"
                min="1"
                max="100"
                required
                class="mt-1 w-full rounded border border-slate-300 p-2 text-sm"
              />
            </div>
          </div>

          <div>
            <label class="block font-medium text-slate-700">Meta de Conversión *</label>
            <input
              v-model="newBriefing.kpiTargets.conversionGoal"
              required
              class="mt-1 w-full rounded border border-slate-300 p-2 text-sm"
              placeholder="Ej: Formulario de asesoramiento B2B o solicitud de muestra"
            />
          </div>

          <div class="flex justify-end gap-2 border-t pt-3">
            <button
              type="button"
              class="rounded-lg border px-4 py-2 font-medium text-slate-700 hover:bg-slate-50"
              @click="showCreateModal = false"
            >
              Cancelar
            </button>
            <button type="submit" class="rounded-lg bg-blue-600 px-4 py-2 font-semibold text-white hover:bg-blue-700">
              Guardar Briefing
            </button>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import type { UnifiedEditorialCalendar, EditorialBriefing } from '../../shared/editorial-seo-briefing'

const props = defineProps<{
  initialMonth?: string
}>()

const requestFetch = useRequestFetch()
const currentMonth = ref(props.initialMonth ?? new Date().toISOString().slice(0, 7))
const intentFilter = ref('')
const reviewFilter = ref('')
const showCreateModal = ref(false)
const loading = ref(false)
const error = ref<string | null>(null)
const calendarData = ref<UnifiedEditorialCalendar | null>(null)

const newBriefing = ref({
  topic: '',
  searchIntent: 'informational' as const,
  targetKeyword: '',
  secondaryKeywords: ['quimica profesional'],
  expertAuthor: {
    name: '',
    credentials: ''
  },
  sources: [
    {
      title: 'Reglamento CLP (CE) Nº 1272/2008',
      citation: 'DOUE L 353',
      verified: true
    }
  ],
  assets: [],
  targetPublishDate: new Date().toISOString().slice(0, 10),
  updateCadenceMonths: 6,
  kpiTargets: {
    targetMonthlyVisits: 1000,
    targetSerpRank: 3,
    conversionGoal: 'Lead B2B'
  }
})

async function fetchCalendar() {
  loading.value = true
  error.value = null
  try {
    const data = await requestFetch(`/api/admin/cms/editorial-calendar-briefings?month=${currentMonth.value}`)
    calendarData.value = data
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : 'Error cargando datos'
  } finally {
    loading.value = false
  }
}

function changeMonth(delta: number) {
  const [year, month] = currentMonth.value.split('-').map(Number)
  const d = new Date(Date.UTC(year, month - 1 + delta, 1))
  currentMonth.value = d.toISOString().slice(0, 7)
  fetchCalendar()
}

const filteredBriefings = computed(() => {
  const list: EditorialBriefing[] = calendarData.value?.briefings ?? []
  return list.filter((b) => {
    if (intentFilter.value && b.searchIntent !== intentFilter.value) return false
    if (reviewFilter.value && b.reviewStatus !== reviewFilter.value) return false
    return true
  })
})

function intentBadgeClass(intent: string) {
  switch (intent) {
    case 'informational':
      return 'bg-blue-50 text-blue-700 border border-blue-200'
    case 'commercial':
      return 'bg-purple-50 text-purple-700 border border-purple-200'
    case 'transactional':
      return 'bg-emerald-50 text-emerald-700 border border-emerald-200'
    case 'navigational':
      return 'bg-amber-50 text-amber-700 border border-amber-200'
    default:
      return 'bg-slate-50 text-slate-700 border border-slate-200'
  }
}

function statusBadgeClass(status: string) {
  switch (status) {
    case 'approved':
      return 'bg-emerald-50 text-emerald-700 border border-emerald-200'
    case 'in_review':
      return 'bg-amber-50 text-amber-700 border border-amber-200'
    case 'rejected':
      return 'bg-red-50 text-red-700 border border-red-200'
    default:
      return 'bg-slate-50 text-slate-700 border border-slate-200'
  }
}

async function submitBriefing() {
  try {
    await $fetch('/api/admin/cms/briefings', {
      method: 'POST',
      body: newBriefing.value
    })
    showCreateModal.value = false
    await fetchCalendar()
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Error desconocido'
    alert(`Error guardando briefing: ${msg}`)
  }
}

onMounted(() => {
  fetchCalendar()
})
</script>
