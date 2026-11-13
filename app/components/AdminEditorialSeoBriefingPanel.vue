<template>
  <div class="adm-stack" data-testid="admin-editorial-seo-briefing-panel">
    <AdminPageActions>
      <button
        type="button"
        class="adm-btn adm-btn--primary"
        data-testid="btn-create-briefing"
        @click="showCreateModal = true"
      >
        <UIcon name="i-lucide-plus" class="size-4 shrink-0" />
        Nueva planificación
      </button>
    </AdminPageActions>

    <div class="adm-grid" data-testid="metrics-overview">
      <div class="adm-card adm-stat">
        <p class="adm-stat__label">Planificados</p>
        <p class="adm-stat__value" data-testid="metric-planned">{{ calendarData?.metrics?.totalPlanned ?? 0 }}</p>
      </div>
      <div class="adm-card adm-stat">
        <p class="adm-stat__label">En revisión</p>
        <p class="adm-stat__value" data-testid="metric-in-review">{{ calendarData?.metrics?.totalInReview ?? 0 }}</p>
      </div>
      <div class="adm-card adm-stat">
        <p class="adm-stat__label">Aprobados</p>
        <p class="adm-stat__value" data-testid="metric-approved">{{ calendarData?.metrics?.totalApproved ?? 0 }}</p>
      </div>
      <div class="adm-card adm-stat">
        <p class="adm-stat__label">Publicados</p>
        <p class="adm-stat__value" data-testid="metric-published">{{ calendarData?.metrics?.totalPublished ?? 0 }}</p>
      </div>
    </div>

    <AdminCard flush>
      <template #title>
        <span class="capitalize">{{ monthLabel }}</span>
      </template>
      <template #actions>
        <button
          type="button"
          class="adm-btn adm-btn--secondary adm-btn--sm"
          data-testid="btn-prev-month"
          @click="changeMonth(-1)"
        >
          <UIcon name="i-lucide-chevron-left" class="size-4" />
          Mes anterior
        </button>
        <button
          type="button"
          class="adm-btn adm-btn--secondary adm-btn--sm"
          data-testid="btn-next-month"
          @click="changeMonth(1)"
        >
          Mes siguiente
          <UIcon name="i-lucide-chevron-right" class="size-4" />
        </button>
      </template>

      <div class="adm-tablecard__bar">
        <AdminToolbar :searchable="false">
          <select
            v-model="intentFilter"
            class="adm-input"
            aria-label="Filtrar por tipo de búsqueda"
            data-testid="select-intent-filter"
          >
            <option value="">Todos los tipos de búsqueda</option>
            <option value="informational">Busca información</option>
            <option value="commercial">Compara opciones</option>
            <option value="transactional">Quiere comprar</option>
            <option value="navigational">Busca la marca</option>
          </select>
          <select
            v-model="reviewFilter"
            class="adm-input"
            aria-label="Filtrar por estado de revisión"
            data-testid="select-review-filter"
          >
            <option value="">Todos los estados</option>
            <option value="pending">Pendiente</option>
            <option value="in_review">En revisión</option>
            <option value="approved">Aprobado</option>
            <option value="rejected">Rechazado</option>
          </select>
        </AdminToolbar>
      </div>

      <div v-if="loading" class="adm-table-skeleton" aria-busy="true">
        <span class="sr-only">Cargando la planificación…</span>
        <div v-for="row in 4" :key="row"><i /><i /><i /></div>
      </div>
      <AdminEmptyState
        v-else-if="error"
        variant="error"
        title="No se ha podido cargar la planificación"
        description="Comprueba la conexión y vuelve a intentarlo."
      >
        <AdminButton icon="i-lucide-rotate-cw" @click="fetchCalendar">Reintentar</AdminButton>
      </AdminEmptyState>
      <AdminEmptyState
        v-else-if="filteredBriefings.length === 0"
        :variant="intentFilter || reviewFilter ? 'filtered' : 'empty'"
        icon="i-lucide-calendar"
        :title="
          intentFilter || reviewFilter
            ? 'Ningún resultado con estos filtros'
            : 'No hay contenidos planificados este mes'
        "
        :description="
          intentFilter || reviewFilter
            ? 'Prueba con otro filtro o quítalos.'
            : 'Crea una planificación para decidir qué se va a escribir, quién y cuándo.'
        "
      >
        <AdminButton v-if="intentFilter || reviewFilter" @click="((intentFilter = ''), (reviewFilter = ''))">
          Quitar filtros
        </AdminButton>
        <AdminButton v-else icon="i-lucide-plus" @click="showCreateModal = true">Nueva planificación</AdminButton>
      </AdminEmptyState>

      <ul v-else class="divide-y divide-[var(--border)]">
        <li v-for="brief in filteredBriefings" :key="brief.id" class="space-y-3 p-4" data-testid="briefing-card">
          <div class="flex flex-wrap items-center gap-2">
            <AdminBadge tone="info" plain>{{ intentLabel(brief.searchIntent) }}</AdminBadge>
            <AdminBadge :status="brief.reviewStatus" />
            <span class="adm-help">Publicación prevista: {{ adminDate(brief.targetPublishDate) }}</span>
          </div>
          <div>
            <h3 class="text-[0.9375rem] font-semibold text-[var(--text-strong)]">{{ brief.topic }}</h3>
            <p class="adm-help">
              Palabra clave: <span class="font-semibold text-[var(--text-strong)]">{{ brief.targetKeyword }}</span>
              <template v-if="brief.secondaryKeywords?.length">
                · Secundarias: {{ brief.secondaryKeywords.join(', ') }}
              </template>
            </p>
          </div>
          <dl class="grid gap-4 text-[0.8125rem] md:grid-cols-3">
            <div>
              <dt class="font-semibold text-[var(--text-strong)]">Autor y fuentes</dt>
              <dd>
                {{ brief.expertAuthor?.name
                }}<template v-if="brief.expertAuthor?.credentials"> — {{ brief.expertAuthor?.credentials }}</template>
              </dd>
              <dd v-if="brief.sources?.length" class="adm-help">
                Fuentes: {{ brief.sources.map((s: any) => s.title).join('; ') }}
              </dd>
            </div>
            <div>
              <dt class="font-semibold text-[var(--text-strong)]">Imágenes y archivos</dt>
              <dd v-if="brief.assets?.length" class="flex flex-wrap gap-1.5">
                <AdminBadge v-for="(asset, idx) in brief.assets" :key="idx" plain>
                  {{ assetLabel(String(asset.assetType)) }}: {{ asset.name }}
                </AdminBadge>
              </dd>
              <dd v-else class="adm-help">Sin archivos asignados</dd>
            </div>
            <div>
              <dt class="font-semibold text-[var(--text-strong)]">Objetivos</dt>
              <dd>
                {{ brief.kpiTargets?.targetMonthlyVisits }} visitas al mes · puesto
                {{ brief.kpiTargets?.targetSerpRank }} en Google
              </dd>
              <dd class="adm-help">Meta: {{ brief.kpiTargets?.conversionGoal }}</dd>
            </div>
          </dl>
        </li>
      </ul>
    </AdminCard>

    <AdminDrawer v-model:open="showCreateModal" title="Nueva planificación de contenido" wide>
      <form
        id="seo-briefing-form"
        class="adm-stack"
        data-testid="modal-create-briefing"
        @submit.prevent="submitBriefing"
      >
        <UAlert
          v-if="saveError"
          role="alert"
          color="error"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          title="No se ha podido guardar la planificación"
          :description="saveError"
        />
        <AdminFormField v-slot="{ id }" label="Tema o título del contenido" required>
          <input
            :id="id"
            v-model="newBriefing.topic"
            required
            placeholder="Ej.: guía de limpieza y desinfección en la industria láctea"
          />
        </AdminFormField>

        <div class="adm-form-grid">
          <AdminFormField v-slot="{ id }" label="Qué busca el cliente" required>
            <select :id="id" v-model="newBriefing.searchIntent" required>
              <option value="informational">Busca información</option>
              <option value="commercial">Compara opciones</option>
              <option value="transactional">Quiere comprar</option>
              <option value="navigational">Busca la marca</option>
            </select>
          </AdminFormField>
          <AdminFormField v-slot="{ id }" label="Palabra clave principal" required>
            <input
              :id="id"
              v-model="newBriefing.targetKeyword"
              required
              placeholder="Ej.: desinfectante industrial lácteo"
            />
          </AdminFormField>
        </div>

        <div class="adm-form-grid">
          <AdminFormField v-slot="{ id }" label="Autor experto" required>
            <input :id="id" v-model="newBriefing.expertAuthor.name" required placeholder="Ej.: Dr. Roberto Méndez" />
          </AdminFormField>
          <AdminFormField v-slot="{ id }" label="Titulación del autor" required>
            <input
              :id="id"
              v-model="newBriefing.expertAuthor.credentials"
              required
              placeholder="Ej.: químico colegiado n.º 241"
            />
          </AdminFormField>
        </div>

        <div class="adm-form-grid">
          <AdminFormField v-slot="{ id }" label="Fecha prevista de publicación" required>
            <input :id="id" v-model="newBriefing.targetPublishDate" type="date" required />
          </AdminFormField>
          <AdminFormField v-slot="{ id }" label="Visitas al mes que se esperan" required>
            <input
              :id="id"
              v-model.number="newBriefing.kpiTargets.targetMonthlyVisits"
              type="number"
              min="0"
              required
            />
          </AdminFormField>
          <AdminFormField v-slot="{ id }" label="Puesto deseado en Google" help="1 es el primer resultado." required>
            <input
              :id="id"
              v-model.number="newBriefing.kpiTargets.targetSerpRank"
              type="number"
              min="1"
              max="100"
              required
            />
          </AdminFormField>
        </div>

        <AdminFormField v-slot="{ id }" label="Qué queremos que haga el visitante" required>
          <input
            :id="id"
            v-model="newBriefing.kpiTargets.conversionGoal"
            required
            placeholder="Ej.: pedir asesoramiento o solicitar una muestra"
          />
        </AdminFormField>
      </form>
      <template #footer>
        <AdminButton @click="showCreateModal = false">Cancelar</AdminButton>
        <button type="submit" form="seo-briefing-form" class="adm-btn adm-btn--primary">Guardar planificación</button>
      </template>
    </AdminDrawer>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import type { UnifiedEditorialCalendar, EditorialBriefing } from '~~/shared/editorial-seo-briefing'

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
    const data = await requestFetch<UnifiedEditorialCalendar>(
      `/api/admin/cms/editorial-calendar-briefings?month=${currentMonth.value}`
    )
    calendarData.value = data
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : 'Error cargando datos'
  } finally {
    loading.value = false
  }
}

function changeMonth(delta: number) {
  const parts = currentMonth.value.split('-').map(Number)
  const year = parts[0] ?? new Date().getUTCFullYear()
  const month = parts[1] ?? 1
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

const INTENTS: Record<string, string> = {
  informational: 'Busca información',
  commercial: 'Compara opciones',
  transactional: 'Quiere comprar',
  navigational: 'Busca la marca'
}
const ASSETS: Record<string, string> = {
  image: 'Imagen',
  infographic: 'Infografía',
  technical_sheet: 'Ficha técnica',
  table: 'Tabla',
  video: 'Vídeo',
  checklist: 'Lista de comprobación'
}
const assetLabel = (type: string) => ASSETS[type] ?? adminHumanize(type)
const intentLabel = (intent: string) => INTENTS[intent] ?? adminHumanize(intent)
const monthLabel = computed(() => {
  const [year, month] = currentMonth.value.split('-').map(Number)
  return new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, 1)).toLocaleDateString('es-ES', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC'
  })
})
const saveError = ref('')

async function submitBriefing() {
  saveError.value = ''
  try {
    await $fetch('/api/admin/cms/briefings', {
      method: 'POST',
      body: newBriefing.value
    })
    showCreateModal.value = false
    await fetchCalendar()
  } catch {
    saveError.value = 'Revisa los datos y vuelve a intentarlo.'
  }
}

onMounted(() => {
  fetchCalendar()
})
</script>
