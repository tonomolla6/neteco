<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'

const requestFetch = useRequestFetch()

interface AudienceCondition {
  field: string
  operator: string
  value: string | number | boolean
}

interface AudienceSegment {
  id: string
  slug: string
  name: string
  description?: string
  version: number
  targetType: 'all' | 'b2b' | 'b2c'
  rules: {
    logic: string
    conditions: AudienceCondition[]
  }
  estimatedTotalUsers: number
  estimatedConsentedUsers: number
  status: string
}

interface UserPreview {
  id: string
  maskedIdentifier: string
  customerType: string
  hasConsent: boolean
  orderCount: number
  totalSpentCents: number
  daysSinceLastOrder?: number
}

const loading = ref(false)
const calculating = ref(false)
const errorMessage = ref('')
const segments = ref<AudienceSegment[]>([])
const activeSegment = ref<AudienceSegment | null>(null)
const estimationResult = ref<{
  totalMatchingUsers: number
  consentedUsers: number
  unconsentedUsers: number
  consentPercentage: number
} | null>(null)
const previewUsers = ref<UserPreview[]>([])
const showCreateModal = ref(false)

const newSegment = ref({
  slug: '',
  name: '',
  description: '',
  targetType: 'all' as const,
  conditionField: 'customer_type',
  conditionOp: 'eq',
  conditionValue: 'b2b'
})

async function loadSegments() {
  loading.value = true
  errorMessage.value = ''
  try {
    const res = (await requestFetch('/api/admin/audiences')) as { items: AudienceSegment[] }
    segments.value = res?.items ?? []
    if (segments.value.length > 0 && !activeSegment.value) {
      activeSegment.value = segments.value[0]!
    }
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : 'No se han podido cargar las audiencias.'
  } finally {
    loading.value = false
  }
}

async function estimateActiveAudience() {
  if (!activeSegment.value) return
  calculating.value = true
  errorMessage.value = ''
  try {
    const res = (await requestFetch(`/api/admin/audiences/${activeSegment.value.id}/estimate`, {
      method: 'POST'
    })) as {
      totalMatchingUsers: number
      consentedUsers: number
      unconsentedUsers: number
      consentPercentage: number
    }
    estimationResult.value = res
    activeSegment.value.estimatedTotalUsers = res.totalMatchingUsers
    activeSegment.value.estimatedConsentedUsers = res.consentedUsers
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : 'No se ha podido calcular el tamaño de la audiencia.'
  } finally {
    calculating.value = false
  }
}

async function previewActiveAudience() {
  if (!activeSegment.value) return
  calculating.value = true
  errorMessage.value = ''
  try {
    const res = (await requestFetch(`/api/admin/audiences/${activeSegment.value.id}/preview?limit=10`)) as {
      items: UserPreview[]
    }
    previewUsers.value = res?.items ?? []
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : 'No se ha podido cargar la muestra de clientes.'
  } finally {
    calculating.value = false
  }
}

async function createSegment() {
  loading.value = true
  errorMessage.value = ''
  try {
    await requestFetch('/api/admin/audiences', {
      method: 'POST',
      body: {
        slug: newSegment.value.slug,
        name: newSegment.value.name,
        description: newSegment.value.description,
        targetType: newSegment.value.targetType,
        rules: {
          logic: 'AND',
          conditions: [
            {
              field: newSegment.value.conditionField,
              operator: newSegment.value.conditionOp,
              value: newSegment.value.conditionValue
            }
          ]
        }
      }
    })
    showCreateModal.value = false
    await loadSegments()
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : 'No se ha podido crear la audiencia.'
  } finally {
    loading.value = false
  }
}

function selectSegment(seg: AudienceSegment) {
  activeSegment.value = seg
  estimationResult.value = null
  previewUsers.value = []
  detailOpen.value = true
}

// Estado de interfaz y nombres legibles.
const detailOpen = ref(false)
const search = ref('')
const targetFilter = ref('any')
const TARGET_OPTIONS = [
  { value: 'any', label: 'Todas' },
  { value: 'b2b', label: 'Empresas' },
  { value: 'b2c', label: 'Particulares' }
]
const TARGET_LABELS: Record<string, string> = {
  all: 'Todos los clientes',
  b2b: 'Empresas',
  b2c: 'Particulares'
}
const targetLabel = (code: string) => TARGET_LABELS[code.toLowerCase()] ?? adminHumanize(code)
const FIELD_LABELS: Record<string, string> = {
  customer_type: 'Tipo de cliente',
  orders_count: 'Número de pedidos',
  order_count: 'Número de pedidos',
  total_spent_cents: 'Gasto acumulado (céntimos)',
  total_spent: 'Gasto acumulado',
  days_since_last_order: 'Días desde el último pedido',
  has_consent: 'Consentimiento de publicidad',
  city: 'Ciudad',
  province: 'Provincia',
  postal_code: 'Código postal',
  sector: 'Sector'
}
const OPERATOR_LABELS: Record<string, string> = {
  eq: 'es',
  neq: 'no es',
  ne: 'no es',
  gt: 'mayor que',
  gte: 'como mínimo',
  lt: 'menor que',
  lte: 'como máximo',
  in: 'es uno de',
  contains: 'contiene'
}
function conditionText(condition: AudienceCondition) {
  const field = FIELD_LABELS[condition.field] ?? adminHumanize(condition.field)
  const operator = OPERATOR_LABELS[condition.operator] ?? adminHumanize(condition.operator).toLowerCase()
  const value =
    typeof condition.value === 'boolean'
      ? condition.value
        ? 'sí'
        : 'no'
      : condition.field === 'customer_type'
        ? targetLabel(String(condition.value)).toLowerCase()
        : String(condition.value)
  return `${field} ${operator} ${value}`
}
const columns = [
  { key: 'name', label: 'Audiencia', sortable: true },
  { key: 'targetType', label: 'Clientes', value: (row: AudienceSegment) => targetLabel(row.targetType) },
  { key: 'estimatedTotalUsers', label: 'Tamaño estimado', numeric: true, sortable: true },
  { key: 'estimatedConsentedUsers', label: 'Aceptan publicidad', numeric: true, sortable: true, hideOnMobile: true },
  { key: 'status', label: 'Estado', hideOnMobile: true }
]
const previewColumns = [
  { key: 'maskedIdentifier', label: 'Cliente' },
  { key: 'customerType', label: 'Tipo', value: (row: UserPreview) => targetLabel(row.customerType) },
  { key: 'orderCount', label: 'Pedidos', numeric: true },
  {
    key: 'totalSpentCents',
    label: 'Gasto acumulado',
    numeric: true,
    value: (row: UserPreview) => adminMoney(row.totalSpentCents)
  },
  { key: 'hasConsent', label: 'Publicidad' }
]
const visibleSegments = computed(() => {
  const term = search.value.trim().toLowerCase()
  return segments.value.filter(
    (seg) =>
      (targetFilter.value === 'any' || seg.targetType === targetFilter.value) &&
      (!term || `${seg.name} ${seg.slug} ${seg.description ?? ''}`.toLowerCase().includes(term))
  )
})
function clearFilters() {
  search.value = ''
  targetFilter.value = 'any'
}

onMounted(() => {
  loadSegments()
})
</script>

<template>
  <div class="adm-stack">
    <AdminPageActions>
      <AdminButton variant="primary" icon="i-lucide-plus" @click="showCreateModal = true">Nueva audiencia</AdminButton>
    </AdminPageActions>

    <UAlert
      v-if="errorMessage"
      role="alert"
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="errorMessage"
    />

    <AdminTable
      :rows="visibleSegments"
      :columns="columns"
      :row-key="(row) => row.id"
      :status="loading && !segments.length ? 'pending' : 'success'"
      :filtered="search !== '' || targetFilter !== 'any'"
      caption="Audiencias"
      empty-title="Todavía no hay audiencias"
      empty-description="Crea grupos de clientes para dirigir campañas y promociones."
      empty-icon="i-lucide-users"
      @row-click="selectSegment"
      @clear-filters="clearFilters"
    >
      <template #toolbar>
        <AdminToolbar v-model:search="search" placeholder="Buscar audiencia…" search-label="Buscar audiencias">
          <AdminFilters v-model="targetFilter" :options="TARGET_OPTIONS" label="Filtrar por tipo de cliente" />
        </AdminToolbar>
      </template>
      <template #cell-name="{ row }">
        <p class="font-semibold text-[var(--text-strong)]">{{ row.name }}</p>
        <p class="adm-help">{{ row.description || 'Sin descripción' }} · v{{ row.version }}</p>
      </template>
      <template #cell-status="{ row }"><AdminBadge :status="row.status" /></template>
      <template #actions="{ row }">
        <AdminButton size="sm" @click="selectSegment(row)">Ver detalle</AdminButton>
      </template>
      <template #empty-action>
        <AdminButton variant="primary" icon="i-lucide-plus" @click="showCreateModal = true">
          Nueva audiencia
        </AdminButton>
      </template>
    </AdminTable>

    <AdminDrawer
      v-model:open="detailOpen"
      wide
      :title="activeSegment?.name ?? 'Audiencia'"
      :description="
        activeSegment ? `${targetLabel(activeSegment.targetType)} · versión ${activeSegment.version}` : undefined
      "
    >
      <div v-if="activeSegment" class="adm-stack">
        <p v-if="activeSegment.description">{{ activeSegment.description }}</p>

        <AdminSection title="Condiciones" description="Quién entra en esta audiencia.">
          <ul v-if="activeSegment.rules.conditions.length" class="adm-card adm-list">
            <li v-for="(condition, index) in activeSegment.rules.conditions" :key="index">
              <span class="adm-list__index">{{ index + 1 }}</span>
              <span>{{ conditionText(condition) }}</span>
            </li>
          </ul>
          <p v-else class="adm-help">Sin condiciones: incluye a todos los clientes del tipo elegido.</p>
        </AdminSection>

        <AdminSection title="Tamaño" description="Cuántos clientes cumplen las condiciones ahora mismo.">
          <template #actions>
            <button
              data-test="estimate-audience"
              type="button"
              :disabled="calculating"
              class="adm-btn adm-btn--secondary adm-btn--sm"
              @click="estimateActiveAudience"
            >
              {{ calculating ? 'Calculando…' : 'Calcular tamaño' }}
            </button>
          </template>
          <div v-if="estimationResult" class="adm-grid">
            <AdminStat label="Clientes" :value="estimationResult.totalMatchingUsers" />
            <AdminStat
              label="Aceptan publicidad"
              :value="estimationResult.consentedUsers"
              :hint="`${estimationResult.consentPercentage} % del total`"
            />
            <AdminStat label="No la aceptan" :value="estimationResult.unconsentedUsers" hint="No recibirán campañas" />
          </div>
          <div v-else class="adm-grid">
            <AdminStat label="Clientes (última estimación)" :value="activeSegment.estimatedTotalUsers" />
            <AdminStat label="Aceptan publicidad" :value="activeSegment.estimatedConsentedUsers" />
          </div>
        </AdminSection>

        <AdminSection
          title="Muestra de clientes"
          description="Diez clientes de ejemplo, con los datos personales ocultos."
        >
          <template #actions>
            <button
              data-test="preview-audience"
              type="button"
              :disabled="calculating"
              class="adm-btn adm-btn--secondary adm-btn--sm"
              @click="previewActiveAudience"
            >
              Ver muestra
            </button>
          </template>
          <AdminTable
            v-if="previewUsers.length > 0"
            :rows="previewUsers"
            :columns="previewColumns"
            :row-key="(row) => row.id"
            caption="Muestra de clientes de la audiencia"
          >
            <template #cell-hasConsent="{ row }">
              <AdminBadge :tone="row.hasConsent ? 'success' : 'neutral'">
                {{ row.hasConsent ? 'Aceptada' : 'No aceptada' }}
              </AdminBadge>
            </template>
          </AdminTable>
        </AdminSection>
      </div>
      <template #footer>
        <AdminButton @click="detailOpen = false">Cerrar</AdminButton>
      </template>
    </AdminDrawer>

    <AdminDrawer v-model:open="showCreateModal" title="Nueva audiencia">
      <form id="audience-create-form" class="adm-stack" @submit.prevent="createSegment">
        <AdminFormField v-slot="{ id }" label="Nombre" required>
          <input
            :id="id"
            v-model="newSegment.name"
            type="text"
            required
            class="adm-input"
            placeholder="Por ejemplo: hostelería de Valencia"
          />
        </AdminFormField>
        <AdminFormField
          v-slot="{ id }"
          label="Nombre interno"
          help="Corto, en minúsculas y con guiones. No se muestra a los clientes."
          required
        >
          <input
            :id="id"
            v-model="newSegment.slug"
            type="text"
            required
            class="adm-input"
            placeholder="hosteleria-valencia"
          />
        </AdminFormField>
        <AdminFormField v-slot="{ id }" label="Descripción">
          <textarea :id="id" v-model="newSegment.description" rows="2" class="adm-input" />
        </AdminFormField>
        <AdminFormField v-slot="{ id }" label="Clientes incluidos">
          <select :id="id" v-model="newSegment.targetType" class="adm-input">
            <option value="all">Todos los clientes</option>
            <option value="b2b">Solo empresas</option>
            <option value="b2c">Solo particulares</option>
          </select>
        </AdminFormField>
      </form>
      <template #footer>
        <AdminButton @click="showCreateModal = false">Cancelar</AdminButton>
        <AdminButton variant="primary" type="submit" form="audience-create-form" :loading="loading">
          Guardar audiencia
        </AdminButton>
      </template>
    </AdminDrawer>
  </div>
</template>
