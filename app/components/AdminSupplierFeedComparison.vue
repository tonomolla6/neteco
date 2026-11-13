<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { SupplierFeedReviewItem } from '~~/shared/supplier-feed-comparison'

const props = withDefaults(
  defineProps<{
    importId?: string
    supplierId?: string
  }>(),
  {
    importId: 'feed-import-default',
    supplierId: 'SUP-QUIM-01'
  }
)

const requestFetch = useRequestFetch()

const loading = ref(true)
const loadError = ref<string | null>(null)
const actionError = ref<string | null>(null)
const actionSuccess = ref<string | null>(null)

const items = ref<SupplierFeedReviewItem[]>([])
const selectedDiffType = ref<'all' | 'alta' | 'cambio' | 'baja'>('all')
const selectedStatus = ref<'all' | 'pending_review' | 'approved' | 'rejected' | 'applied'>('all')

const search = ref('')
const diffLabels = { alta: 'Alta', cambio: 'Cambio', baja: 'Baja' } as const
const statusLabels = {
  pending_review: 'Pendiente de revisión',
  approved: 'Aprobado',
  rejected: 'Rechazado',
  applied: 'Aplicado'
} as const
const statusTones = { pending_review: 'warning', approved: 'success', rejected: 'neutral', applied: 'info' } as const
const FIELD_LABELS: Record<string, string> = {
  name: 'Nombre',
  priceCents: 'Precio (céntimos)',
  stockQuantity: 'Stock',
  leadTimeDays: 'Plazo de entrega (días)',
  categoryName: 'Categoría',
  description: 'Descripción',
  barcode: 'Código de barras',
  discontinued: 'Descatalogado'
}
const fieldLabel = (field: string) => FIELD_LABELS[field] ?? adminHumanize(String(field))
const columns = [
  { key: 'supplierSku', label: 'Referencia del proveedor', sortable: true },
  { key: 'diffType', label: 'Tipo', sortable: true },
  { key: 'details', label: 'Qué cambia' },
  { key: 'status', label: 'Estado', sortable: true }
]
const filtersActive = computed(
  () => search.value !== '' || selectedDiffType.value !== 'all' || selectedStatus.value !== 'all'
)
function clearFilters() {
  search.value = ''
  selectedDiffType.value = 'all'
  selectedStatus.value = 'all'
}

const filteredItems = computed(() => {
  const term = search.value.toLowerCase()
  return items.value.filter((item) => {
    if (term && !`${item.supplierSku} ${String(item.afterPayload?.name ?? '')}`.toLowerCase().includes(term))
      return false
    if (selectedDiffType.value !== 'all' && item.diffType !== selectedDiffType.value) return false
    if (selectedStatus.value !== 'all' && item.status !== selectedStatus.value) return false
    return true
  })
})

const pendingCount = computed(() => items.value.filter((i) => i.status === 'pending_review').length)
const approvedCount = computed(() => items.value.filter((i) => i.status === 'approved').length)
const appliedCount = computed(() => items.value.filter((i) => i.status === 'applied').length)

async function loadFeedItems() {
  loading.value = true
  loadError.value = null
  try {
    const url = `/api/admin/supplier-feed/items?importId=${encodeURIComponent(props.importId)}`
    const res = await requestFetch(url)
    items.value = Array.isArray(res) ? res : []
  } catch (err: unknown) {
    loadError.value = err instanceof Error ? err.message : 'No se han podido cargar los cambios del proveedor.'
  } finally {
    loading.value = false
  }
}

async function handleReview(item: SupplierFeedReviewItem, decision: 'approved' | 'rejected') {
  actionError.value = null
  actionSuccess.value = null
  try {
    await requestFetch('/api/admin/supplier-feed/review', {
      method: 'POST',
      body: {
        itemId: item.id,
        decision,
        expectedVersion: item.version,
        reviewNotes: decision === 'approved' ? 'Validado por supervisor' : 'Rechazado en revisión'
      }
    })
    item.status = decision
    item.version += 1
    actionSuccess.value = `${item.supplierSku}: ${decision === 'approved' ? 'aprobado' : 'rechazado'}.`
  } catch (err: unknown) {
    actionError.value = err instanceof Error ? err.message : 'No se ha podido guardar la revisión. Vuelve a intentarlo.'
  }
}

async function handleApplyApproved() {
  const approvedIds = items.value.filter((i) => i.status === 'approved').map((i) => i.id)
  if (approvedIds.length === 0) {
    actionError.value = 'No hay cambios aprobados que aplicar al catálogo.'
    return
  }

  actionError.value = null
  actionSuccess.value = null
  try {
    await requestFetch('/api/admin/supplier-feed/apply', {
      method: 'POST',
      body: {
        importId: props.importId,
        itemIds: approvedIds
      }
    })
    for (const item of items.value) {
      if (approvedIds.includes(item.id)) {
        item.status = 'applied'
        item.isPublished = 1
      }
    }
    actionSuccess.value = `Se han aplicado al catálogo ${approvedIds.length} cambios aprobados.`
  } catch (err: unknown) {
    actionError.value =
      err instanceof Error ? err.message : 'No se han podido aplicar los cambios aprobados. Vuelve a intentarlo.'
  }
}

onMounted(() => {
  loadFeedItems()
})
</script>

<template>
  <div class="adm-stack supplier-feed-panel">
    <AdminPageActions>
      <AdminButton
        variant="primary"
        icon="i-lucide-check-check"
        :disabled="approvedCount === 0"
        @click="handleApplyApproved"
      >
        Aplicar aprobados ({{ approvedCount }})
      </AdminButton>
    </AdminPageActions>

    <UAlert
      v-if="actionSuccess"
      role="status"
      color="success"
      variant="subtle"
      icon="i-lucide-circle-check"
      :title="actionSuccess"
    />
    <UAlert
      v-if="actionError"
      role="alert"
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="actionError"
    />

    <div class="grid gap-4 sm:grid-cols-3">
      <AdminStat label="Pendientes de revisar" :value="pendingCount" icon="i-lucide-hourglass" />
      <AdminStat label="Aprobados, listos para aplicar" :value="approvedCount" icon="i-lucide-check" />
      <AdminStat label="Aplicados al catálogo" :value="appliedCount" icon="i-lucide-package-check" />
    </div>

    <AdminTable
      :rows="filteredItems"
      :columns="columns"
      :row-key="(item) => item.id"
      :status="loading ? 'pending' : loadError ? 'error' : 'success'"
      :error-message="loadError ?? undefined"
      :filtered="filtersActive"
      empty-title="No hay cambios del proveedor por revisar"
      empty-description="Cuando llegue una nueva tarifa del proveedor, sus altas, cambios y bajas aparecerán aquí."
      caption="Cambios propuestos por el proveedor"
      @retry="loadFeedItems"
      @clear-filters="clearFilters"
    >
      <template #toolbar>
        <AdminToolbar v-model:search="search" placeholder="Buscar por referencia o nombre…">
          <label for="diff-filter" class="sr-only">Tipo de cambio</label>
          <select id="diff-filter" v-model="selectedDiffType" class="adm-input">
            <option value="all">Todos los tipos</option>
            <option value="alta">Altas (productos nuevos)</option>
            <option value="cambio">Cambios (precio, stock o datos)</option>
            <option value="baja">Bajas (descatalogados)</option>
          </select>
          <label for="status-filter" class="sr-only">Estado</label>
          <select id="status-filter" v-model="selectedStatus" class="adm-input">
            <option value="all">Todos los estados</option>
            <option value="pending_review">Pendientes de revisión</option>
            <option value="approved">Aprobados</option>
            <option value="rejected">Rechazados</option>
            <option value="applied">Aplicados</option>
          </select>
          <template #actions>
            <span class="adm-help"
              >Altas, cambios y bajas quedan en revisión obligatoria: nada se publica sin aprobarlo.</span
            >
          </template>
        </AdminToolbar>
      </template>
      <template #cell-supplierSku="{ row }">
        <span class="font-semibold text-[var(--text-strong)]">{{ row.supplierSku }}</span>
      </template>
      <template #cell-diffType="{ row }">
        <AdminBadge :tone="row.diffType === 'alta' ? 'info' : row.diffType === 'cambio' ? 'warning' : 'danger'" plain>
          {{ diffLabels[row.diffType] }}
        </AdminBadge>
      </template>
      <template #cell-details="{ row }">
        <div v-if="row.diffType === 'alta' && row.afterPayload">
          <span class="font-semibold">{{ row.afterPayload.name }}</span>
          <span class="adm-help ml-2"
            >Precio del proveedor: {{ adminMoney(Number(row.afterPayload.priceCents || 0)) }}</span
          >
        </div>
        <div v-else-if="row.diffType === 'cambio'">
          <template v-if="row.diffDetails?.changedFields">
            <span v-for="ch in row.diffDetails.changedFields as any[]" :key="ch.field" class="block">
              {{ fieldLabel(ch.field) }}: <del class="text-[var(--text-muted)]">{{ ch.before }}</del> →
              <ins class="font-semibold text-[var(--text-strong)] no-underline">{{ ch.after }}</ins>
            </span>
          </template>
        </div>
        <span v-else-if="row.diffType === 'baja'" class="adm-help"
          >Descatalogado o ya no aparece en la tarifa recibida</span
        >
      </template>
      <template #cell-status="{ row }">
        <AdminBadge :tone="statusTones[row.status]">{{ statusLabels[row.status] }}</AdminBadge>
      </template>
      <template #actions="{ row }">
        <template v-if="row.status === 'pending_review'">
          <AdminButton size="sm" icon="i-lucide-check" @click="handleReview(row, 'approved')">Aprobar</AdminButton>
          <AdminButton size="sm" variant="danger-soft" @click="handleReview(row, 'rejected')">Rechazar</AdminButton>
        </template>
        <span v-else-if="row.status === 'approved'" class="adm-help">Listo para aplicar</span>
        <span v-else-if="row.status === 'applied'" class="adm-help">Publicado en el catálogo</span>
        <span v-else class="adm-help">Rechazado</span>
      </template>
    </AdminTable>
  </div>
</template>
