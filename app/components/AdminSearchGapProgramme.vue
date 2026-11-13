<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

interface BacklogItem {
  term: string
  searches: number
  zeroResults: number
  zeroRate: number
  existingAction: 'synonym' | 'redirect' | 'none'
}

interface SearchGapCase {
  id: string
  termNormalized: string
  termDisplay: string
  status: 'open' | 'actioned' | 'dismissed'
  actionType: 'synonym' | 'content' | 'assortment' | 'redirect' | null
  baselineZeroRate: number
  outcomeZeroRate: number | null
  verdict: string | null
  version: number
  createdAt: string
  updatedAt: string
}

interface Measurement {
  before: { searches: number; zeroResults: number; zeroRate: number }
  after: { searches: number; zeroResults: number; zeroRate: number }
  deltaPercent: number
  verdict: string
}

const requestFetch = useRequestFetch()

const loading = ref(true)
const error = ref<string | null>(null)
const notice = ref<string | null>(null)

const backlog = ref<BacklogItem[]>([])
const cases = ref<SearchGapCase[]>([])
const statusFilter = ref<'open' | 'actioned' | 'dismissed'>('open')

// Action dialog / inline form
const activeCase = ref<SearchGapCase | null>(null)
const actionType = ref<'synonym' | 'content' | 'assortment' | 'redirect'>('synonym')
const targetReference = ref('')
const actionNote = ref('')
const actioning = ref(false)

// Measurement modal
const measuredCaseId = ref<string | null>(null)
const measurement = ref<Measurement | null>(null)

function errorMessage(caught: unknown): string {
  const code = (caught as { data?: { error?: { code?: string } } })?.data?.error?.code
  if (code) return code
  return caught instanceof Error ? caught.message : 'error_servidor'
}

function randomUuid(): string {
  return globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `gap-${Date.now()}`
}

async function loadData() {
  loading.value = true
  error.value = null
  try {
    const [backlogRes, casesRes] = await Promise.all([
      requestFetch<{ items: BacklogItem[] }>('/api/admin/search-gaps/backlog'),
      requestFetch<{ items: SearchGapCase[] }>(`/api/admin/search-gaps?status=${statusFilter.value}`)
    ])
    backlog.value = backlogRes.items ?? []
    cases.value = casesRes.items ?? []
  } catch (caught) {
    error.value = errorMessage(caught)
  } finally {
    loading.value = false
  }
}

async function openCase(term: string) {
  notice.value = null
  error.value = null
  try {
    const key = randomUuid()
    await requestFetch('/api/admin/search-gaps', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'idempotency-key': key
      },
      body: {
        action: 'open_case',
        term
      }
    })
    notice.value = `Caso abierto para el término "${term}".`
    await loadData()
  } catch (caught) {
    error.value = errorMessage(caught)
  }
}

async function recordAction() {
  if (!activeCase.value || !targetReference.value.trim()) return
  actioning.value = true
  error.value = null
  try {
    const key = randomUuid()
    await requestFetch('/api/admin/search-gaps', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'idempotency-key': key
      },
      body: {
        action: 'record_action',
        id: activeCase.value.id,
        expectedVersion: activeCase.value.version,
        actionType: actionType.value,
        targetReference: targetReference.value.trim(),
        note: actionNote.value.trim() || undefined
      }
    })
    notice.value = `Acción registrada para "${activeCase.value.termDisplay}".`
    activeCase.value = null
    targetReference.value = ''
    actionNote.value = ''
    await loadData()
  } catch (caught) {
    error.value = errorMessage(caught)
  } finally {
    actioning.value = false
  }
}

async function measure(caseItem: SearchGapCase) {
  measuredCaseId.value = caseItem.id
  measurement.value = null
  try {
    const res = await requestFetch<Measurement>(`/api/admin/search-gaps/${caseItem.id}/measurement`)
    measurement.value = res
  } catch (caught) {
    error.value = errorMessage(caught)
  }
}

// Etiquetas legibles y estado de interfaz (el panel lateral se abre al elegir un caso).
const STATUS_OPTIONS = [
  { value: 'open', label: 'Abiertos' },
  { value: 'actioned', label: 'Con solución aplicada' },
  { value: 'dismissed', label: 'Descartados' }
]
const STATUS_LABEL: Record<SearchGapCase['status'], string> = {
  open: 'Abierto',
  actioned: 'Solución aplicada',
  dismissed: 'Descartado'
}
const STATUS_TONE = { open: 'warning', actioned: 'success', dismissed: 'neutral' } as const
const ACTION_LABEL: Record<string, string> = {
  synonym: 'Sinónimo',
  redirect: 'Redirección a una página',
  content: 'Contenido nuevo',
  assortment: 'Producto añadido al catálogo'
}
const VERDICT_LABEL: Record<string, string> = {
  improved: 'Ha mejorado',
  no_change: 'Sin cambios apreciables',
  worse: 'Ha empeorado',
  insufficient_data: 'Todavía no hay datos suficientes',
  not_actioned: 'Aún no se ha aplicado ninguna solución'
}
const ERROR_LABEL: Record<string, string> = {
  forbidden: 'No tienes permiso para gestionar las búsquedas sin resultado.',
  unauthorized: 'Tu sesión ha caducado. Vuelve a iniciar sesión.',
  version_conflict: 'Otra persona ha modificado este caso. Actualiza y vuelve a intentarlo.',
  conflict: 'Otra persona ha modificado este caso. Actualiza y vuelve a intentarlo.'
}
const errorText = computed(() =>
  error.value ? (ERROR_LABEL[error.value] ?? 'No hemos podido completar la operación. Vuelve a intentarlo.') : ''
)
const percent = (rate: number) => `${(rate * 100).toFixed(1)}%`
function setStatus(value: string) {
  statusFilter.value = value as typeof statusFilter.value
  void loadData()
}
const drawerOpen = computed({
  get: () => activeCase.value !== null,
  set: (open: boolean) => {
    if (!open) activeCase.value = null
  }
})
const measuredCase = computed(() => cases.value.find((entry) => entry.id === measuredCaseId.value) ?? null)

onMounted(() => {
  loadData()
})
</script>

<template>
  <div class="adm-stack">
    <AdminPageActions>
      <AdminButton icon="i-lucide-rotate-cw" :loading="loading" @click="loadData">Actualizar</AdminButton>
    </AdminPageActions>

    <div v-if="notice" data-test="notice" role="status" aria-live="polite">
      <UAlert color="success" variant="subtle" icon="i-lucide-circle-check" :title="notice" />
    </div>

    <div v-if="error" role="alert">
      <UAlert color="error" variant="subtle" icon="i-lucide-triangle-alert" :title="errorText">
        <template #actions>
          <AdminButton size="sm" icon="i-lucide-rotate-cw" @click="loadData">Reintentar</AdminButton>
        </template>
      </UAlert>
    </div>

    <AdminSection
      title="Términos pendientes de revisar"
      description="Búsquedas recientes que casi nunca devuelven productos. Abre un caso para darles solución."
      aria-labelledby="backlog-heading"
    >
      <AdminCard flush>
        <span id="backlog-heading" class="sr-only">Términos pendientes de revisar ({{ backlog.length }})</span>
        <div v-if="loading && !backlog.length" class="adm-table-skeleton" aria-busy="true">
          <span class="sr-only">Cargando…</span>
          <div v-for="row in 4" :key="row"><i /><i /><i /><i /></div>
        </div>
        <AdminEmptyState
          v-else-if="backlog.length === 0"
          compact
          icon="i-lucide-circle-check"
          title="Nada pendiente"
          description="En los últimos días no hay términos que se queden sin resultado con frecuencia."
        />
        <div v-else class="adm-table-wrap">
          <table class="adm-table">
            <thead>
              <tr>
                <th scope="col">Búsqueda</th>
                <th scope="col" data-numeric>Veces buscada</th>
                <th scope="col" data-numeric>Sin resultado</th>
                <th scope="col" data-numeric>% sin resultado</th>
                <th scope="col" data-numeric><span class="sr-only">Acciones</span></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in backlog" :key="item.term">
                <td class="font-medium text-[var(--text-strong)]">{{ item.term }}</td>
                <td data-numeric>{{ item.searches }}</td>
                <td data-numeric>{{ item.zeroResults }}</td>
                <td data-numeric>{{ percent(item.zeroRate) }}</td>
                <td data-numeric class="adm-table__actions">
                  <button
                    type="button"
                    data-test="open-case-btn"
                    class="adm-btn adm-btn--secondary adm-btn--sm"
                    @click="openCase(item.term)"
                  >
                    Abrir caso
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </AdminCard>
    </AdminSection>

    <AdminSection title="Casos" aria-labelledby="cases-heading">
      <template #actions>
        <AdminFilters
          :model-value="statusFilter"
          :options="STATUS_OPTIONS"
          label="Filtrar casos por estado"
          @update:model-value="setStatus"
        />
      </template>
      <AdminCard flush>
        <span id="cases-heading" class="sr-only">Casos de búsquedas sin resultado</span>
        <AdminEmptyState
          v-if="cases.length === 0 && !loading"
          compact
          variant="filtered"
          title="No hay casos en este estado"
          description="Cambia el filtro o abre un caso desde la lista de términos pendientes."
        />
        <div v-else-if="cases.length" class="adm-table-wrap">
          <table class="adm-table">
            <thead>
              <tr>
                <th scope="col">Búsqueda</th>
                <th scope="col">Estado</th>
                <th scope="col" data-numeric>% sin resultado al abrirlo</th>
                <th scope="col">Solución aplicada</th>
                <th scope="col" data-numeric><span class="sr-only">Acciones</span></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="c in cases" :key="c.id">
                <td class="font-medium text-[var(--text-strong)]">{{ c.termDisplay }}</td>
                <td>
                  <AdminBadge :tone="STATUS_TONE[c.status]">{{ STATUS_LABEL[c.status] }}</AdminBadge>
                </td>
                <td data-numeric>{{ percent(c.baselineZeroRate) }}</td>
                <td>{{ c.actionType ? (ACTION_LABEL[c.actionType] ?? adminHumanize(c.actionType)) : 'Pendiente' }}</td>
                <td data-numeric class="adm-table__actions">
                  <AdminButton v-if="c.status === 'open'" size="sm" @click="activeCase = c">
                    Registrar solución
                  </AdminButton>
                  <AdminButton v-if="c.status === 'actioned'" size="sm" icon="i-lucide-chart-line" @click="measure(c)">
                    Ver resultado
                  </AdminButton>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else class="adm-table-skeleton" aria-busy="true">
          <span class="sr-only">Cargando…</span>
          <div v-for="row in 3" :key="row"><i /><i /><i /><i /></div>
        </div>
      </AdminCard>
    </AdminSection>

    <AdminCard
      v-if="measurement"
      :title="measuredCase ? `Resultado de «${measuredCase.termDisplay}»` : 'Resultado de la solución'"
      :description="VERDICT_LABEL[measurement.verdict] ?? adminHumanize(measurement.verdict)"
    >
      <template #actions>
        <AdminButton variant="ghost" size="sm" icon="i-lucide-x" label="Cerrar resultado" @click="measurement = null" />
      </template>
      <div class="adm-grid">
        <AdminStat
          label="Antes"
          :value="percent(measurement.before.zeroRate)"
          :hint="`${measurement.before.zeroResults} de ${measurement.before.searches} búsquedas sin resultado`"
        />
        <AdminStat
          label="Después"
          :value="percent(measurement.after.zeroRate)"
          :hint="`${measurement.after.zeroResults} de ${measurement.after.searches} búsquedas sin resultado`"
        />
        <AdminStat
          label="Variación"
          :value="`${measurement.deltaPercent > 0 ? '+' : ''}${measurement.deltaPercent.toFixed(1)}%`"
          hint="Cambio en las búsquedas sin resultado"
        />
      </div>
    </AdminCard>

    <AdminDrawer
      v-model:open="drawerOpen"
      :title="activeCase ? `Solución para «${activeCase.termDisplay}»` : 'Registrar solución'"
      description="Anota qué has hecho para que esta búsqueda encuentre productos."
    >
      <div class="adm-stack">
        <AdminFormField v-slot="{ id }" label="Qué has hecho">
          <select :id="id" v-model="actionType" class="adm-input">
            <option value="synonym">Añadir un sinónimo</option>
            <option value="redirect">Redirigir a una página</option>
            <option value="content">Publicar contenido</option>
            <option value="assortment">Añadir el producto al catálogo</option>
          </select>
        </AdminFormField>
        <AdminFormField
          v-slot="{ id }"
          label="Dónde lleva ahora la búsqueda"
          help="Dirección de la página o referencia del producto."
          required
        >
          <input :id="id" v-model="targetReference" class="adm-input" placeholder="/catalogo/…" />
        </AdminFormField>
        <AdminFormField v-slot="{ id }" label="Nota" help="Opcional.">
          <input :id="id" v-model="actionNote" class="adm-input" placeholder="Por ejemplo: sinónimo añadido" />
        </AdminFormField>
      </div>
      <template #footer>
        <AdminButton @click="activeCase = null">Cancelar</AdminButton>
        <AdminButton variant="primary" :loading="actioning" :disabled="!targetReference" @click="recordAction">
          Guardar
        </AdminButton>
      </template>
    </AdminDrawer>
  </div>
</template>
