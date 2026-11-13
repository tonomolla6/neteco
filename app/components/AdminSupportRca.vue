<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'

const requestFetch = useRequestFetch()

interface PreventiveActionItem {
  id: string
  actionType: string
  description: string
  assignee: string
  targetDate: string
  status: string
  completedAt?: string
}

interface RcaItem {
  id: string
  publicRef: string
  incidentCategory: 'damage' | 'picking_error' | 'delay' | 'stock_discrepancy' | 'documentation'
  title: string
  status: string
  severity: string
  rootCauseSummary: string
  fiveWhys: string[]
  preventiveActions: PreventiveActionItem[]
  verificationStatus: string
  verifiedAt?: string
  verificationNotes?: string
  version: number
  createdAt: string
}

const loading = ref(false)
const saving = ref(false)
const errorMessage = ref('')
const successMessage = ref('')
const items = ref<RcaItem[]>([])
const isCreating = ref(false)

const form = ref({
  incidentCategory: 'damage' as RcaItem['incidentCategory'],
  title: '',
  severity: 'high' as const,
  rootCauseSummary: '',
  why1: '',
  why2: '',
  why3: '',
  why4: '',
  why5: '',
  actionType: 'packaging_update',
  actionDescription: '',
  actionAssignee: '',
  actionTargetDate: '2026-11-15T00:00:00Z'
})

const categoryLabels: Record<RcaItem['incidentCategory'], string> = {
  damage: 'Daño en mercancía',
  picking_error: 'Error al preparar el pedido',
  delay: 'Retraso en la entrega',
  stock_discrepancy: 'Descuadre de stock',
  documentation: 'Documentación o etiquetado'
}

const actionLabels: Record<string, string> = {
  packaging_update: 'Embalaje reforzado',
  process_change: 'Cambio de proceso',
  training: 'Formación del equipo',
  inventory_audit: 'Revisión de inventario',
  documentation_template: 'Plantilla de documentación'
}
const severityLabels: Record<string, string> = { low: 'Baja', medium: 'Media', high: 'Alta', critical: 'Crítica' }
const severityTones: Record<string, 'neutral' | 'warning' | 'danger'> = {
  low: 'neutral',
  medium: 'warning',
  high: 'danger',
  critical: 'danger'
}
const columns = [
  { key: 'title', label: 'Incidencia' },
  { key: 'incidentCategory', label: 'Tipo' },
  { key: 'severity', label: 'Gravedad', hideOnMobile: true },
  { key: 'preventiveActions', label: 'Medidas preventivas' },
  { key: 'verificationStatus', label: 'Verificación' },
  { key: 'createdAt', label: 'Alta', hideOnMobile: true }
]
const search = ref('')
const categoryFilter = ref('')
const filteredItems = computed(() => {
  const term = search.value.toLowerCase()
  return items.value.filter(
    (rca) =>
      (!categoryFilter.value || rca.incidentCategory === categoryFilter.value) &&
      (!term ||
        rca.title.toLowerCase().includes(term) ||
        rca.publicRef.toLowerCase().includes(term) ||
        (rca.rootCauseSummary ?? '').toLowerCase().includes(term))
  )
})
function clearFilters() {
  search.value = ''
  categoryFilter.value = ''
}

async function loadRcas() {
  loading.value = true
  errorMessage.value = ''
  try {
    const res = (await requestFetch('/api/admin/support/rca')) as { items: RcaItem[] }
    items.value = res?.items ?? []
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : 'No se han podido cargar los análisis de causas'
  } finally {
    loading.value = false
  }
}

async function submitRca() {
  saving.value = true
  errorMessage.value = ''
  try {
    const whys = [form.value.why1, form.value.why2, form.value.why3, form.value.why4, form.value.why5].filter(Boolean)
    const preventiveActions: PreventiveActionItem[] = []
    if (form.value.actionDescription) {
      preventiveActions.push({
        id: crypto.randomUUID(),
        actionType: form.value.actionType,
        description: form.value.actionDescription,
        assignee: form.value.actionAssignee || 'Responsable de calidad',
        targetDate: form.value.actionTargetDate,
        status: 'pending'
      })
    }

    await requestFetch<unknown, string>('/api/admin/support/rca', {
      method: 'POST',
      body: {
        incidentCategory: form.value.incidentCategory,
        title: form.value.title || 'Incidencia de calidad operativa',
        severity: form.value.severity,
        rootCauseSummary: form.value.rootCauseSummary || 'Análisis sistemático de causa raíz',
        fiveWhys: whys.length > 0 ? whys : ['Causa primaria identificada'],
        preventiveActions
      }
    })

    successMessage.value = 'Análisis y medida preventiva guardados'
    isCreating.value = false
    await loadRcas()
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : 'No se ha podido guardar el análisis'
  } finally {
    saving.value = false
  }
}

async function verifyRca(rca: RcaItem) {
  saving.value = true
  errorMessage.value = ''
  try {
    await requestFetch<unknown, string>(`/api/admin/support/rca/${rca.id}/verify`, {
      method: 'POST',
      body: {
        expectedVersion: rca.version,
        verificationStatus: 'verified_effective',
        verificationNotes: 'Verificación realizada en almacén: medidas correctoras efectivas sin recurrencias.'
      }
    })
    rca.verificationStatus = 'verified_effective'
    rca.status = 'verified'
    successMessage.value = 'Medidas preventivas verificadas'
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : 'No se ha podido registrar la verificación'
  } finally {
    saving.value = false
  }
}

onMounted(() => {
  loadRcas()
})
</script>

<template>
  <div class="adm-stack">
    <AdminPageActions>
      <button
        data-test="open-create-rca"
        type="button"
        class="adm-btn adm-btn--primary"
        @click="isCreating = !isCreating"
      >
        Nuevo análisis
      </button>
    </AdminPageActions>

    <UAlert
      v-if="errorMessage"
      role="alert"
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="errorMessage"
    >
      <template #actions>
        <AdminButton size="sm" icon="i-lucide-rotate-cw" @click="loadRcas">Reintentar</AdminButton>
      </template>
    </UAlert>
    <UAlert
      v-if="successMessage"
      role="status"
      color="success"
      variant="subtle"
      icon="i-lucide-circle-check"
      :title="successMessage"
    />

    <AdminTable
      :rows="filteredItems"
      :columns="columns"
      :row-key="(rca) => rca.id"
      :status="loading ? 'pending' : 'idle'"
      :filtered="Boolean(search || categoryFilter)"
      empty-icon="i-lucide-search-check"
      empty-title="Todavía no hay análisis de causas"
      empty-description="Registra aquí por qué ocurrió una incidencia (daños, errores de preparación, retrasos…) y qué se hará para que no se repita."
      @clear-filters="clearFilters"
    >
      <template #toolbar>
        <AdminToolbar v-model:search="search" placeholder="Buscar por incidencia o referencia">
          <select v-model="categoryFilter" class="adm-input w-auto" aria-label="Filtrar por tipo de incidencia">
            <option value="">Todos los tipos</option>
            <option v-for="(label, value) in categoryLabels" :key="value" :value="value">{{ label }}</option>
          </select>
        </AdminToolbar>
      </template>

      <template #cell-title="{ row }">
        <p class="font-medium text-[var(--text-strong)]">{{ row.title }}</p>
        <p class="adm-help break-words">{{ row.rootCauseSummary }}</p>
        <p class="adm-help">{{ row.publicRef }}</p>
      </template>
      <template #cell-incidentCategory="{ row }">
        {{ categoryLabels[row.incidentCategory] || 'Otra incidencia' }}
      </template>
      <template #cell-severity="{ row }">
        <AdminBadge :tone="severityTones[row.severity] ?? 'neutral'">
          {{ severityLabels[row.severity] ?? 'Sin indicar' }}
        </AdminBadge>
      </template>
      <template #cell-preventiveActions="{ row }">
        <ul v-if="row.preventiveActions && row.preventiveActions.length > 0" class="space-y-1">
          <li v-for="act in row.preventiveActions" :key="act.id">
            {{ act.description }}
            <span class="adm-help">
              {{ actionLabels[act.actionType] ?? 'Otra medida' }} · Responsable: {{ act.assignee }}
            </span>
          </li>
        </ul>
        <span v-else class="adm-help">Sin medidas</span>
      </template>
      <template #cell-verificationStatus="{ row }">
        <AdminBadge :tone="row.verificationStatus === 'verified_effective' ? 'success' : 'warning'">
          {{ row.verificationStatus === 'verified_effective' ? 'Verificado: funciona' : 'Pendiente de verificar' }}
        </AdminBadge>
      </template>
      <template #cell-createdAt="{ row }">{{ adminDate(row.createdAt) }}</template>
      <template #actions="{ row }">
        <button
          v-if="row.verificationStatus !== 'verified_effective'"
          data-test="verify-rca"
          type="button"
          class="adm-btn adm-btn--secondary adm-btn--sm"
          :disabled="saving"
          @click="verifyRca(row)"
        >
          Marcar como verificado
        </button>
      </template>
    </AdminTable>

    <AdminDrawer
      v-model:open="isCreating"
      title="Nuevo análisis de causas"
      description="Qué pasó, por qué y qué se hará para que no se repita."
      wide
    >
      <form id="rca-create-form" class="adm-stack" @submit.prevent="submitRca">
        <div class="adm-form-grid">
          <AdminFormField v-slot="{ id }" label="Tipo de incidencia" required>
            <select :id="id" v-model="form.incidentCategory" class="adm-input" required>
              <option value="damage">Daño (rotura o embalaje)</option>
              <option value="picking_error">Error al preparar el pedido</option>
              <option value="delay">Retraso en la entrega</option>
              <option value="stock_discrepancy">Descuadre de stock</option>
              <option value="documentation">Documentación o etiquetado</option>
            </select>
          </AdminFormField>
          <AdminFormField v-slot="{ id }" label="Gravedad">
            <select :id="id" v-model="form.severity" class="adm-input">
              <option value="low">Baja</option>
              <option value="medium">Media</option>
              <option value="high">Alta</option>
              <option value="critical">Crítica</option>
            </select>
          </AdminFormField>
        </div>

        <AdminFormField v-slot="{ id }" label="Qué ha pasado" required>
          <input
            :id="id"
            v-model="form.title"
            name="rcaTitle"
            type="text"
            required
            class="adm-input"
            placeholder="Por ejemplo: rotura de garrafas en transporte paletizado"
          />
        </AdminFormField>

        <AdminFormField v-slot="{ id }" label="Por qué ha pasado" required>
          <textarea
            :id="id"
            v-model="form.rootCauseSummary"
            rows="3"
            required
            class="adm-input"
            placeholder="La causa principal que habéis identificado"
          />
        </AdminFormField>

        <AdminCard title="Medida preventiva" description="Opcional: qué se hará para que no vuelva a ocurrir.">
          <div class="adm-form-grid">
            <AdminFormField v-slot="{ id }" label="Tipo de medida">
              <select :id="id" v-model="form.actionType" class="adm-input">
                <option value="packaging_update">Embalaje reforzado</option>
                <option value="process_change">Cambio de proceso</option>
                <option value="training">Formación del equipo</option>
                <option value="inventory_audit">Revisión de inventario</option>
                <option value="documentation_template">Plantilla de documentación</option>
              </select>
            </AdminFormField>
            <AdminFormField v-slot="{ id }" label="Descripción">
              <input
                :id="id"
                v-model="form.actionDescription"
                type="text"
                class="adm-input"
                placeholder="Por ejemplo: añadir cantoneras rígidas y fleje"
              />
            </AdminFormField>
            <AdminFormField v-slot="{ id }" label="Responsable">
              <input :id="id" v-model="form.actionAssignee" type="text" class="adm-input" />
            </AdminFormField>
          </div>
        </AdminCard>
      </form>
      <template #footer>
        <AdminButton @click="isCreating = false">Cancelar</AdminButton>
        <button
          data-test="submit-rca"
          type="submit"
          form="rca-create-form"
          :disabled="saving"
          class="adm-btn adm-btn--primary"
        >
          {{ saving ? 'Guardando…' : 'Guardar análisis' }}
        </button>
      </template>
    </AdminDrawer>
  </div>
</template>
