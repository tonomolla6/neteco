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
    const res = await requestFetch('/api/admin/orders/procurement/approve', {
      method: 'POST',
      body: {
        orderId: props.orderId,
        expectedVersion: data.value.version,
        notes: approvalNotes.value || 'Aprobado desde panel administrativo'
      }
    })
    data.value = res as ProcurementData
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
    const res = await requestFetch('/api/admin/orders/procurement/reject', {
      method: 'POST',
      body: {
        orderId: props.orderId,
        expectedVersion: data.value.version,
        rejectionReason: rejectionReason.value.trim()
      }
    })
    data.value = res as ProcurementData
    showRejectModal.value = false
  } catch (err: unknown) {
    const fetchErr = err as { data?: { error?: { code?: string } } }
    error.value = fetchErr?.data?.error?.code ?? 'error_rejecting'
  } finally {
    submitting.value = false
  }
}

const statusBadgeClass = computed(() => {
  switch (data.value?.approvalStatus) {
    case 'approved':
      return 'bg-green-100 text-green-800'
    case 'rejected':
      return 'bg-red-100 text-red-800'
    case 'pending_approval':
      return 'bg-amber-100 text-amber-800'
    default:
      return 'bg-gray-100 text-gray-800'
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
      return 'No requerida'
  }
})

onMounted(() => {
  loadData()
})
</script>

<template>
  <div class="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
    <div class="flex items-center justify-between border-b border-slate-100 pb-4">
      <div>
        <h3 class="text-lg font-semibold text-slate-900">Datos de Compra y Aprobación</h3>
        <p class="text-sm text-slate-500">PO contractual, centro de coste y gobernanza de compras</p>
      </div>
      <span
        v-if="data"
        class="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium"
        :class="statusBadgeClass"
      >
        {{ statusLabel }}
      </span>
    </div>

    <!-- Loading State -->
    <div v-if="loading" class="py-8 text-center text-sm text-slate-500" aria-live="polite">
      Cargando datos de compras...
    </div>

    <!-- Error State -->
    <div v-else-if="error" class="my-4 rounded-md bg-red-50 p-4 text-sm text-red-700" role="alert">
      Error: {{ error }}
    </div>

    <!-- Content State -->
    <div v-else-if="data" class="mt-4 space-y-4">
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div class="rounded-md bg-slate-50 p-3">
          <span class="block text-xs font-medium text-slate-500">Orden de Compra (PO):</span>
          <span class="font-mono text-sm font-semibold text-slate-900">
            {{ data.purchaseOrderReference || 'No asignada' }}
          </span>
        </div>
        <div class="rounded-md bg-slate-50 p-3">
          <span class="block text-xs font-medium text-slate-500">Centro de Coste:</span>
          <span class="font-mono text-sm font-semibold text-slate-900">
            {{ data.costCenter || 'No asignado' }}
          </span>
        </div>
      </div>

      <div
        v-if="data.requiresApproval"
        class="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800"
      >
        Este pedido superó el umbral de aprobación o las políticas del centro de coste y requiere validación de compras.
      </div>

      <!-- Action Buttons when Pending Approval -->
      <div v-if="data.approvalStatus === 'pending_approval'" class="mt-4 flex items-center gap-3">
        <button
          data-testid="approve-btn"
          type="button"
          :disabled="submitting"
          class="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-500 disabled:opacity-50"
          @click="handleApprove"
        >
          Aprobar Pedido
        </button>
        <button
          data-testid="reject-btn"
          type="button"
          :disabled="submitting"
          class="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500 disabled:opacity-50"
          @click="showRejectModal = true"
        >
          Rechazar Pedido
        </button>
      </div>

      <!-- Rejection Modal / Prompt -->
      <div v-if="showRejectModal" class="mt-4 rounded-md border border-red-200 bg-red-50 p-4">
        <label for="rejection-reason" class="block text-xs font-medium text-red-800">
          Motivo del rechazo (obligatorio):
        </label>
        <textarea
          id="rejection-reason"
          v-model="rejectionReason"
          rows="2"
          class="mt-1 block w-full rounded-md border-red-300 text-sm shadow-sm focus:border-red-500 focus:ring-red-500"
          placeholder="Indique el motivo del rechazo del pedido..."
        />
        <div class="mt-2 flex gap-2">
          <button
            type="button"
            :disabled="submitting || !rejectionReason.trim()"
            class="rounded-md bg-red-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-800 disabled:opacity-50"
            @click="handleReject"
          >
            Confirmar Rechazo
          </button>
          <button
            type="button"
            class="rounded-md bg-white px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-300 hover:bg-slate-50"
            @click="showRejectModal = false"
          >
            Cancelar
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
