<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'

const props = defineProps<{
  orderId: string
}>()

interface ProcurementEvent {
  id: string
  eventType: string
  actorId: string
  notes: string | null
  createdAt: string
}

interface ProcurementData {
  orderId: string
  purchaseOrderReference: string | null
  costCenter: string | null
  approvalStatus: 'not_required' | 'pending_approval' | 'approved' | 'rejected'
  requiresApproval: boolean
  approvalThresholdCents: number | null
  approvedBy: string | null
  approvedAt: string | null
  rejectedBy: string | null
  rejectedAt: string | null
  rejectionReason: string | null
  approvalNotes: string | null
  version: number
  events?: ProcurementEvent[]
}

const loading = ref(true)
const error = ref<string | null>(null)
const data = ref<ProcurementData | null>(null)
const approvalNotes = ref('')
const rejectionReason = ref('')
const showRejectModal = ref(false)
const submitting = ref(false)

const requestFetch = useRequestFetch()

async function loadData() {
  loading.value = true
  error.value = null
  try {
    const res = await requestFetch(`/api/admin/orders/procurement?orderId=${props.orderId}`)
    data.value = res as ProcurementData
  } catch (err: unknown) {
    const fetchErr = err as { data?: { error?: { code?: string } } }
    error.value = fetchErr?.data?.error?.code ?? 'error_loading_procurement'
  } finally {
    loading.value = false
  }
}

async function handleApprove() {
  if (!data.value) return
  submitting.value = true
  try {
    const res = await requestFetch<ProcurementData, string>('/api/admin/orders/procurement/approve', {
      method: 'POST',
      body: {
        orderId: props.orderId,
        expectedVersion: data.value.version,
        notes: approvalNotes.value || 'Aprobado desde panel administrativo'
      }
    })
    data.value = res
  } catch (err: unknown) {
    const fetchErr = err as { data?: { error?: { code?: string } } }
    error.value = fetchErr?.data?.error?.code ?? 'error_approving'
  } finally {
    submitting.value = false
  }
}

async function handleReject() {
  if (!data.value || !rejectionReason.value.trim()) return
  submitting.value = true
  try {
    const res = await requestFetch<ProcurementData, string>('/api/admin/orders/procurement/reject', {
      method: 'POST',
      body: {
        orderId: props.orderId,
        expectedVersion: data.value.version,
        rejectionReason: rejectionReason.value.trim()
      }
    })
    data.value = res
    showRejectModal.value = false
  } catch (err: unknown) {
    const fetchErr = err as { data?: { error?: { code?: string } } }
    error.value = fetchErr?.data?.error?.code ?? 'error_rejecting'
  } finally {
    submitting.value = false
  }
}

const statusTone = computed(() => {
  switch (data.value?.approvalStatus) {
    case 'approved':
      return 'success'
    case 'rejected':
      return 'danger'
    case 'pending_approval':
      return 'warning'
    default:
      return 'neutral'
  }
})

const statusLabel = computed(() => {
  switch (data.value?.approvalStatus) {
    case 'approved':
      return 'Aprobado'
    case 'rejected':
      return 'Rechazado'
    case 'pending_approval':
      return 'Pendiente de aprobación'
    default:
      return 'No necesita aprobación'
  }
})

onMounted(() => {
  loadData()
})
</script>

<template>
  <AdminCard title="Compra de empresa" description="Orden de compra, centro de coste y aprobación">
    <template v-if="data" #actions>
      <AdminBadge :tone="statusTone">{{ statusLabel }}</AdminBadge>
    </template>

    <div v-if="loading" class="adm-help" aria-live="polite">Cargando datos de compra…</div>

    <AdminEmptyState
      v-else-if="error"
      role="alert"
      compact
      variant="error"
      title="No se han podido cargar los datos de compra"
      description="Comprueba el pedido y vuelve a intentarlo."
    >
      <AdminButton icon="i-lucide-rotate-cw" @click="loadData">Reintentar</AdminButton>
    </AdminEmptyState>

    <div v-else-if="data" class="space-y-4">
      <dl class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div class="rounded-[var(--radius-control)] bg-[var(--surface-sunken)] p-3">
          <dt class="adm-help">Orden de compra del cliente</dt>
          <dd class="font-semibold text-[var(--text-strong)] [overflow-wrap:anywhere]">
            {{ data.purchaseOrderReference || 'Sin asignar' }}
          </dd>
        </div>
        <div class="rounded-[var(--radius-control)] bg-[var(--surface-sunken)] p-3">
          <dt class="adm-help">Centro de coste</dt>
          <dd class="font-semibold text-[var(--text-strong)] [overflow-wrap:anywhere]">
            {{ data.costCenter || 'Sin asignar' }}
          </dd>
        </div>
      </dl>

      <UAlert
        v-if="data.requiresApproval"
        color="warning"
        variant="subtle"
        icon="i-lucide-shield-alert"
        title="Este pedido necesita la aprobación de compras"
        description="Supera el importe máximo o las condiciones acordadas con la empresa."
      />
      <p v-if="data.approvalStatus === 'rejected' && data.rejectionReason" class="adm-help">
        Motivo del rechazo: {{ data.rejectionReason }}
      </p>

      <div v-if="data.approvalStatus === 'pending_approval'" class="flex flex-wrap items-center justify-end gap-2">
        <button
          data-testid="reject-btn"
          type="button"
          :disabled="submitting"
          class="adm-btn adm-btn--danger-soft"
          @click="showRejectModal = true"
        >
          Rechazar pedido
        </button>
        <button
          data-testid="approve-btn"
          type="button"
          :disabled="submitting"
          class="adm-btn adm-btn--secondary"
          @click="handleApprove"
        >
          <UIcon name="i-lucide-check" class="size-4" />Aprobar pedido
        </button>
      </div>
    </div>

    <AdminConfirm
      v-model:open="showRejectModal"
      title="¿Rechazar este pedido?"
      description="La empresa verá el pedido como rechazado junto con el motivo."
      confirm-label="Rechazar pedido"
      danger
      :loading="submitting"
      :confirm-disabled="!rejectionReason.trim()"
      @confirm="handleReject"
    >
      <AdminFormField label="Motivo del rechazo" required for="rejection-reason">
        <textarea
          id="rejection-reason"
          v-model="rejectionReason"
          rows="3"
          class="adm-input w-full"
          placeholder="Por ejemplo: supera el presupuesto aprobado"
        />
      </AdminFormField>
    </AdminConfirm>
  </AdminCard>
</template>
