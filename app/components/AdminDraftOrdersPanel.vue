<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { DraftOrder } from '~~/shared/draft-orders'
import type { AdminTone } from '~/utils/adminLabels'

const requestFetch = useRequestFetch()

const loading = ref(true)
const loadError = ref<string | null>(null)
const actionMessage = ref<string | null>(null)
const actionType = ref<'success' | 'error'>('success')

const draftOrders = ref<DraftOrder[]>([])
const selectedDraft = ref<DraftOrder | null>(null)
const filterStatus = ref<string>('all')

const filteredDrafts = computed(() => {
  if (filterStatus.value === 'all') return draftOrders.value
  return draftOrders.value.filter((d) => d.status === filterStatus.value)
})

const drawerOpen = ref(false)
const confirming = ref<'rejected' | 'convert' | null>(null)
const STATUS: Record<string, [string, AdminTone]> = {
  draft: ['Borrador', 'neutral'],
  pending_approval: ['Pendiente de aprobación', 'warning'],
  approved: ['Aprobado', 'success'],
  rejected: ['Rechazado', 'danger'],
  expired: ['Caducado', 'neutral'],
  converted: ['Convertido en pedido', 'success']
}
const statusMeta = (status: string) => {
  const [label, tone] = STATUS[status] ?? [adminStatusLabel(status), 'neutral' as AdminTone]
  return { label, tone }
}
const statusOptions = [
  { value: 'all', label: 'Todos' },
  { value: 'pending_approval', label: 'Pendientes de aprobación' },
  { value: 'approved', label: 'Aprobados' },
  { value: 'draft', label: 'Borradores' },
  { value: 'expired', label: 'Caducados' },
  { value: 'converted', label: 'Convertidos' }
]
const paymentLabels: Record<string, string> = {
  unbilled: 'Sin cobrar',
  preauthorized: 'Importe retenido',
  captured: 'Cobrado',
  voided: 'Retención anulada'
}
const actorLabels: Record<string, string> = { customer: 'Cliente', approver: 'Equipo', system: 'Automático' }
const eventLabels: Record<string, string> = {
  created: 'Borrador creado',
  submitted_for_approval: 'Enviado a aprobación',
  under_review: 'En revisión',
  approved: 'Aprobado',
  rejected: 'Rechazado',
  expired: 'Caducado',
  converted: 'Convertido en pedido',
  cancelled: 'Cancelado',
  note_added: 'Nota añadida'
}
const columns = [
  { key: 'draftNumber', label: 'Borrador', sortable: true },
  { key: 'companyName', label: 'Empresa', sortable: true },
  { key: 'status', label: 'Estado' },
  { key: 'lines', label: 'Líneas', numeric: true, hideOnMobile: true, value: (row: DraftOrder) => row.items.length },
  { key: 'total', label: 'Total', numeric: true, sortable: true, value: (row: DraftOrder) => row.totalCents },
  { key: 'expiresAt', label: 'Caduca', sortable: true, hideOnMobile: true }
]
function openDraft(draft: DraftOrder) {
  selectedDraft.value = draft
  drawerOpen.value = true
}
function confirmPending() {
  const draft = selectedDraft.value,
    action = confirming.value
  confirming.value = null
  if (!draft || !action) return
  if (action === 'convert') void handleConvert(draft)
  else void handleReview(draft, 'rejected')
}

async function loadDraftOrders() {
  loading.value = true
  loadError.value = null
  try {
    const res = await requestFetch<DraftOrder[]>('/api/admin/draft-orders/list')
    draftOrders.value = Array.isArray(res) ? res : []
    if (draftOrders.value[0] && !selectedDraft.value) {
      selectedDraft.value = draftOrders.value[0]
    }
  } catch (err: unknown) {
    loadError.value = err instanceof Error ? err.message : 'Error al cargar pedidos en borrador'
  } finally {
    loading.value = false
  }
}

async function handleReview(draft: DraftOrder, decision: 'approved' | 'rejected') {
  actionMessage.value = null
  try {
    const updated = await requestFetch<DraftOrder>('/api/admin/draft-orders/review', {
      method: 'POST',
      body: {
        draftOrderId: draft.id,
        decision,
        expectedVersion: draft.version,
        notes: decision === 'approved' ? 'Aprobado por el gestor de cuentas' : 'Condiciones no aprobadas'
      }
    })
    const idx = draftOrders.value.findIndex((d) => d.id === draft.id)
    if (idx !== -1) draftOrders.value[idx] = updated
    if (selectedDraft.value?.id === draft.id) selectedDraft.value = updated
    actionType.value = 'success'
    actionMessage.value = `Borrador ${draft.draftNumber} ${decision === 'approved' ? 'aprobado' : 'rechazado'}.`
  } catch (err: unknown) {
    actionType.value = 'error'
    actionMessage.value = err instanceof Error ? err.message : 'Error al revisar el borrador de pedido'
  }
}

async function handleConvert(draft: DraftOrder) {
  actionMessage.value = null
  try {
    const orderNumber = `ORD-CONF-${Math.floor(100000 + Math.random() * 900000)}`
    const updated = await requestFetch<DraftOrder>('/api/admin/draft-orders/convert', {
      method: 'POST',
      body: {
        draftOrderId: draft.id,
        expectedVersion: draft.version,
        confirmedOrderId: orderNumber
      }
    })
    const idx = draftOrders.value.findIndex((d) => d.id === draft.id)
    if (idx !== -1) draftOrders.value[idx] = updated
    if (selectedDraft.value?.id === draft.id) selectedDraft.value = updated
    actionType.value = 'success'
    actionMessage.value = `Borrador convertido en el pedido ${orderNumber}.`
  } catch (err: unknown) {
    actionType.value = 'error'
    actionMessage.value = err instanceof Error ? err.message : 'Error al convertir el borrador'
  }
}

async function handleSweepExpired() {
  actionMessage.value = null
  try {
    const res = await requestFetch<{ expiredCount: number }>('/api/admin/draft-orders/sweep', {
      method: 'POST'
    })
    actionType.value = 'success'
    actionMessage.value =
      res.expiredCount === 1
        ? 'Se ha caducado 1 borrador vencido.'
        : `Se han caducado ${res.expiredCount} borradores vencidos.`
    await loadDraftOrders()
  } catch (err: unknown) {
    actionType.value = 'error'
    actionMessage.value = err instanceof Error ? err.message : 'Error al barrer borradores vencidos'
  }
}

onMounted(() => {
  loadDraftOrders()
})
</script>

<template>
  <div class="draft-orders-panel adm-stack">
    <AdminPageActions>
      <AdminButton icon="i-lucide-timer-off" @click="handleSweepExpired">Caducar los vencidos</AdminButton>
    </AdminPageActions>

    <UAlert
      v-if="actionMessage"
      role="alert"
      :color="actionType === 'success' ? 'success' : 'error'"
      variant="subtle"
      :icon="actionType === 'success' ? 'i-lucide-circle-check' : 'i-lucide-triangle-alert'"
      :title="actionMessage"
      :close="true"
      @update:open="actionMessage = null"
    />

    <AdminTable
      :rows="filteredDrafts"
      :columns="columns"
      :row-key="(row) => row.id"
      :status="loading ? 'pending' : loadError ? 'error' : 'success'"
      :error-message="loadError ?? undefined"
      :filtered="filterStatus !== 'all'"
      empty-title="Todavía no hay borradores"
      empty-description="Los pedidos que una empresa deja pendientes de aprobación aparecerán aquí. No reservan stock ni cobran hasta convertirse en pedido."
      empty-icon="i-lucide-file-clock"
      @retry="loadDraftOrders"
      @clear-filters="filterStatus = 'all'"
      @row-click="openDraft"
    >
      <template #toolbar>
        <AdminToolbar :searchable="false">
          <AdminFilters v-model="filterStatus" :options="statusOptions" label="Filtrar por estado" />
        </AdminToolbar>
      </template>
      <template #cell-draftNumber="{ row }">
        <button
          type="button"
          class="font-semibold tabular-nums text-neteco-700 hover:underline"
          @click="openDraft(row)"
        >
          {{ row.draftNumber }}
        </button>
      </template>
      <template #cell-status="{ row }">
        <AdminBadge :tone="statusMeta(row.status).tone">{{ statusMeta(row.status).label }}</AdminBadge>
      </template>
      <template #cell-total="{ row }">{{ adminMoney(row.totalCents) }}</template>
      <template #cell-expiresAt="{ row }">{{ adminDate(row.expiresAt, true) }}</template>
      <template #actions="{ row }">
        <AdminButton size="sm" variant="ghost" @click="openDraft(row)">Ver</AdminButton>
      </template>
    </AdminTable>

    <AdminDrawer
      v-model:open="drawerOpen"
      :title="selectedDraft ? `Borrador ${selectedDraft.draftNumber}` : 'Borrador'"
      :description="selectedDraft ? `${selectedDraft.companyName} · ${selectedDraft.contactEmail}` : undefined"
      wide
    >
      <div v-if="selectedDraft" class="adm-stack">
        <div class="flex flex-wrap items-center gap-2">
          <AdminBadge :tone="statusMeta(selectedDraft.status).tone">
            {{ statusMeta(selectedDraft.status).label }}
          </AdminBadge>
          <span class="adm-help">Caduca el {{ adminDate(selectedDraft.expiresAt, true) }}</span>
        </div>

        <dl class="grid grid-cols-2 gap-3">
          <div class="rounded-[var(--radius-control)] bg-[var(--surface-sunken)] p-3">
            <dt class="adm-help">Stock</dt>
            <dd class="font-semibold text-[var(--text-strong)]">
              {{ selectedDraft.inventoryReserved === 0 ? 'Sin reservar' : 'Reservado' }}
            </dd>
          </div>
          <div class="rounded-[var(--radius-control)] bg-[var(--surface-sunken)] p-3">
            <dt class="adm-help">Cobro</dt>
            <dd class="font-semibold text-[var(--text-strong)]">
              {{ paymentLabels[selectedDraft.paymentStatus] ?? adminStatusLabel(selectedDraft.paymentStatus) }}
            </dd>
          </div>
        </dl>

        <AdminCard title="Artículos" flush>
          <ul class="adm-list">
            <li v-for="item in selectedDraft.items" :key="item.sku" class="justify-between">
              <div class="min-w-0">
                <p class="font-medium text-[var(--text-strong)]">{{ item.name }}</p>
                <p class="text-xs tabular-nums text-[var(--text-muted)]">
                  {{ item.sku }} · {{ item.quantity }} × {{ adminMoney(item.unitPriceCents) }}
                </p>
              </div>
              <span class="font-semibold tabular-nums text-[var(--text-strong)]">{{
                adminMoney(item.lineTotalCents)
              }}</span>
            </li>
          </ul>
          <template #footer>
            <span class="text-[var(--text-muted)]">Total</span>
            <span class="font-semibold tabular-nums text-[var(--text-strong)]">{{
              adminMoney(selectedDraft.totalCents)
            }}</span>
          </template>
        </AdminCard>

        <AdminCard title="Historial">
          <ol class="space-y-3 border-l border-[var(--border)] pl-4">
            <li v-for="evt in selectedDraft.timeline" :key="evt.id" class="relative">
              <span class="absolute -left-[1.3125rem] top-1.5 size-2 rounded-full bg-[var(--border-strong)]" />
              <p class="font-medium text-[var(--text-strong)]">
                {{ eventLabels[evt.eventType] ?? adminHumanize(evt.eventType) }}
              </p>
              <p class="text-xs text-[var(--text-muted)]">
                {{ adminDate(evt.createdAt, true) }} · {{ actorLabels[evt.actorType] ?? adminHumanize(evt.actorType) }}
              </p>
              <p v-if="evt.notes" class="mt-0.5 text-[var(--text)]">{{ evt.notes }}</p>
            </li>
          </ol>
        </AdminCard>
      </div>
      <template v-if="selectedDraft" #footer>
        <AdminButton @click="drawerOpen = false">Cerrar</AdminButton>
        <template v-if="selectedDraft.status === 'pending_approval'">
          <AdminButton variant="danger-soft" @click="confirming = 'rejected'">Rechazar</AdminButton>
          <AdminButton variant="primary" @click="handleReview(selectedDraft, 'approved')">Aprobar</AdminButton>
        </template>
        <AdminButton v-else-if="selectedDraft.status === 'approved'" variant="primary" @click="confirming = 'convert'">
          Convertir en pedido
        </AdminButton>
      </template>
    </AdminDrawer>

    <AdminConfirm
      :open="confirming !== null"
      :title="confirming === 'convert' ? '¿Convertir este borrador en pedido?' : '¿Rechazar este borrador?'"
      :description="
        confirming === 'convert'
          ? 'Se creará un pedido en firme con estos artículos. No se puede deshacer.'
          : 'La empresa verá el borrador como rechazado. No se puede deshacer.'
      "
      :confirm-label="confirming === 'convert' ? 'Convertir en pedido' : 'Rechazar'"
      :danger="confirming === 'rejected'"
      @update:open="(value) => !value && (confirming = null)"
      @confirm="confirmPending"
    />
  </div>
</template>
