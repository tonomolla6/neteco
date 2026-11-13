<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { ManifestSummary, ManifestView } from '~~/shared/carrier-manifests'
import { newCommandId } from '../composables/useDeliveryDriverApp'
import { opsErrorMessage } from '../utils/shipping-ops-errors'
import type { AdminTone } from '~/utils/adminLabels'

const requestFetch = useRequestFetch()
const BASE = '/api/admin/carrier-manifests'

const loading = ref(true)
const busy = ref(false)
const error = ref<string | null>(null)
const notice = ref<string | null>(null)
const manifests = ref<ManifestSummary[]>([])
const current = ref<ManifestView | null>(null)
const carrier = ref('')
const pickupDate = ref(new Date().toISOString().slice(0, 10))
const scans = ref('')
// Estado de interfaz: fallo al cargar el listado y confirmación de cancelación.
const listFailed = ref(false)
const cancelOpen = ref(false)

const statusLabel: Record<string, string> = {
  open: 'Abierto',
  closed: 'Cerrado',
  picked_up: 'Recogido',
  discrepancy: 'Con discrepancias',
  cancelled: 'Cancelado'
}
const statusTone: Record<string, AdminTone> = {
  open: 'info',
  picked_up: 'success',
  discrepancy: 'danger'
}
const pickupStatusLabel: Record<string, string> = {
  scheduled: 'Solicitada',
  confirmed: 'Confirmada',
  discrepancy: 'Con discrepancias'
}
const manifestColumns = [
  { key: 'carrier', label: 'Transportista' },
  { key: 'pickupDate', label: 'Recogida' },
  { key: 'status', label: 'Estado' },
  { key: 'includedShipments', label: 'Incluidas', numeric: true },
  { key: 'excludedShipments', label: 'Excluidas', numeric: true }
]
const shortId = (id: string) => (id.length > 12 ? `#${id.slice(0, 8).toUpperCase()}` : id)
const reasonLabel: Record<string, string> = {
  already_manifested: 'Ya manifestada',
  order_exception: 'Pedido en excepción',
  already_delivered: 'Ya entregada',
  manual_hold: 'Retenida manualmente'
}
const canSchedule = computed(() => current.value?.status === 'closed' && !current.value.pickup)
const canConfirm = computed(() => current.value?.status === 'closed' && current.value.pickup?.status === 'scheduled')

async function loadList() {
  loading.value = true
  error.value = null
  listFailed.value = false
  try {
    manifests.value = (
      (await requestFetch<{ manifests: ManifestSummary[] }>(BASE)) as { manifests: ManifestSummary[] }
    ).manifests
  } catch (caught) {
    error.value = opsErrorMessage(caught)
    listFailed.value = true
  } finally {
    loading.value = false
  }
}
async function open(id: string) {
  error.value = null
  try {
    current.value = (
      (await requestFetch<{ manifest: ManifestView }>(`${BASE}/${id}`)) as { manifest: ManifestView }
    ).manifest
  } catch (caught) {
    error.value = opsErrorMessage(caught)
  }
}
async function act(
  path: string,
  body: Record<string, unknown>,
  done: string,
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE' = 'POST'
) {
  busy.value = true
  error.value = null
  notice.value = null
  try {
    const res = (await requestFetch<{ manifest: ManifestView }>(path, { method, body })) as { manifest: ManifestView }
    current.value = res.manifest
    notice.value = done
    await loadList()
  } catch (caught) {
    error.value = opsErrorMessage(caught)
  } finally {
    busy.value = false
  }
}
const create = () =>
  act(
    BASE,
    { commandId: newCommandId(), carrier: carrier.value.trim(), pickupDate: pickupDate.value },
    'Manifiesto creado.'
  )
const base = () => ({ commandId: newCommandId(), expectedVersion: current.value!.version })
const setItem = (trackingNumber: string, decision: 'included' | 'excluded') =>
  act(
    `${BASE}/${current.value!.id}/items`,
    { ...base(), trackingNumber, decision },
    decision === 'excluded' ? 'Expedición retenida.' : 'Expedición reincorporada.'
  )
const close = () => act(`${BASE}/${current.value!.id}/close`, base(), 'Manifiesto cerrado y archivado.')
const schedule = () => act(`${BASE}/${current.value!.id}/pickup`, base(), 'Recogida solicitada.')
const cancel = () => act(`${BASE}/${current.value!.id}/cancel`, base(), 'Manifiesto cancelado.')
const confirmCancel = () => {
  cancelOpen.value = false
  return cancel()
}
const confirm = () =>
  act(
    `${BASE}/${current.value!.id}/pickup/confirm`,
    {
      ...base(),
      scannedTrackingNumbers: scans.value
        .split(/\s+/)
        .map((s) => s.trim())
        .filter(Boolean)
    },
    'Recogida conciliada.'
  )

onMounted(() => void loadList())
</script>

<template>
  <div class="adm-stack">
    <form class="adm-toolbar" aria-label="Crear manifiesto" @submit.prevent="create">
      <input
        v-model="carrier"
        data-test="carrier"
        required
        maxlength="100"
        class="adm-input"
        placeholder="Transportista"
        aria-label="Transportista"
      />
      <input
        v-model="pickupDate"
        data-test="pickup-date"
        type="date"
        required
        class="adm-input"
        aria-label="Fecha de recogida"
      />
      <button type="submit" data-test="create" :disabled="busy" class="adm-btn adm-btn--primary">
        Crear manifiesto
      </button>
    </form>

    <UAlert v-if="notice" role="status" color="success" variant="subtle" :title="notice" />
    <UAlert v-if="error && !listFailed" role="alert" color="error" variant="subtle" :title="error" />

    <div v-if="loading" role="status" aria-live="polite" class="adm-help">Cargando manifiestos…</div>
    <AdminCard v-else-if="listFailed">
      <div role="alert">
        <AdminEmptyState
          compact
          variant="error"
          title="No se han podido cargar los manifiestos"
          :description="error ?? undefined"
        >
          <AdminButton icon="i-lucide-rotate-cw" @click="loadList()">Reintentar</AdminButton>
        </AdminEmptyState>
      </div>
    </AdminCard>
    <AdminTable
      v-else
      :rows="manifests"
      :columns="manifestColumns"
      :row-key="(row) => row.id"
      empty-title="Todavía no hay manifiestos"
      empty-description="Crea el primero indicando el transportista y la fecha de recogida."
      empty-icon="i-lucide-clipboard-list"
      caption="Manifiestos"
    >
      <template #cell-pickupDate="{ row }">{{ adminDate(row.pickupDate) }}</template>
      <template #cell-status="{ row }">
        <AdminBadge :tone="statusTone[row.status] ?? 'neutral'">{{ statusLabel[row.status] }}</AdminBadge>
      </template>
      <template #actions="{ row }">
        <button
          type="button"
          :data-test="`open-${row.id}`"
          class="adm-btn adm-btn--secondary adm-btn--sm"
          @click="open(row.id)"
        >
          Ver
        </button>
      </template>
    </AdminTable>

    <AdminCard
      v-if="current"
      flush
      data-test="detail"
      :aria-label="`Manifiesto ${current.carrier} ${current.pickupDate}`"
    >
      <template #title>
        <span class="flex flex-wrap items-center gap-2">
          {{ current.carrier }} · {{ adminDate(current.pickupDate) }}
          <AdminBadge :tone="statusTone[current.status] ?? 'neutral'">{{ statusLabel[current.status] }}</AdminBadge>
        </span>
      </template>
      <template #actions>
        <button
          v-if="(current.status === 'open' || current.status === 'closed') && !current.pickup"
          type="button"
          data-test="cancel"
          :disabled="busy"
          class="adm-btn adm-btn--danger-soft adm-btn--sm"
          @click="cancelOpen = true"
        >
          Cancelar manifiesto
        </button>
        <button
          v-if="current.status === 'open'"
          type="button"
          data-test="close"
          :disabled="busy"
          class="adm-btn adm-btn--secondary adm-btn--sm"
          @click="close"
        >
          Cerrar manifiesto
        </button>
        <button
          v-if="canSchedule"
          type="button"
          data-test="schedule"
          :disabled="busy"
          class="adm-btn adm-btn--secondary adm-btn--sm"
          @click="schedule"
        >
          Solicitar recogida
        </button>
      </template>

      <p
        data-test="reconciliation"
        class="px-5 py-3 text-[0.8125rem]"
        :class="current.reconciliation.balanced ? 'text-[var(--text-muted)]' : 'font-semibold text-red-700'"
      >
        {{ current.reconciliation.candidates }} expediciones: {{ current.reconciliation.included }} incluidas ·
        {{ current.reconciliation.excluded }} excluidas
        <span v-for="(n, reason) in current.reconciliation.excludedByReason" :key="reason">
          · {{ reasonLabel[reason] }}: {{ n }}</span
        >
        <span v-if="!current.reconciliation.balanced"> · Descuadre detectado: revisa las expediciones</span>
      </p>

      <div class="adm-table-wrap border-t border-[var(--border)]">
        <table class="adm-table">
          <caption class="sr-only">
            Expediciones del manifiesto
          </caption>
          <thead>
            <tr>
              <th scope="col">Seguimiento</th>
              <th scope="col">Pedido</th>
              <th scope="col" data-numeric>Peso</th>
              <th scope="col">Situación</th>
              <th scope="col">Lectura en recogida</th>
              <th scope="col" data-numeric><span class="sr-only">Acción</span></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in current.items" :key="item.trackingNumber">
              <td class="font-semibold text-[var(--text-strong)]">{{ item.trackingNumber }}</td>
              <td>{{ shortId(item.orderId) }}</td>
              <td data-numeric>{{ (item.weightGrams / 1000).toLocaleString('es-ES') }} kg</td>
              <td>
                <AdminBadge v-if="item.decision === 'included'" tone="success">Incluida</AdminBadge>
                <AdminBadge v-else tone="warning">
                  Excluida ({{ reasonLabel[item.exclusionReason ?? ''] ?? 'otro motivo' }})
                </AdminBadge>
              </td>
              <td>{{ item.scanStatus === 'scanned' ? 'Escaneada' : item.scanStatus === 'missing' ? 'Falta' : '—' }}</td>
              <td data-numeric class="adm-table__actions">
                <button
                  v-if="current.status === 'open' && item.decision === 'included'"
                  type="button"
                  :data-test="`hold-${item.trackingNumber}`"
                  class="adm-btn adm-btn--secondary adm-btn--sm"
                  :disabled="busy"
                  @click="setItem(item.trackingNumber, 'excluded')"
                >
                  Retener
                </button>
                <button
                  v-else-if="current.status === 'open' && item.exclusionReason === 'manual_hold'"
                  type="button"
                  :data-test="`release-${item.trackingNumber}`"
                  class="adm-btn adm-btn--secondary adm-btn--sm"
                  :disabled="busy"
                  @click="setItem(item.trackingNumber, 'included')"
                >
                  Reincorporar
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div
        v-if="current.documents.length || current.pickup || canConfirm"
        class="space-y-4 border-t border-[var(--border)] px-5 py-4"
      >
        <div v-if="current.documents.length" class="flex flex-wrap items-center gap-2">
          <span class="adm-label">Documentos</span>
          <a
            v-for="doc in current.documents"
            :key="doc.kind"
            :data-test="`doc-${doc.kind}`"
            :href="`${BASE}/${current.id}/documents/${doc.kind}`"
            download
            class="adm-btn adm-btn--secondary adm-btn--sm"
          >
            <UIcon name="i-lucide-download" class="size-4" />
            {{ doc.kind === 'manifest_csv' ? 'Manifiesto (CSV)' : 'Acta de recogida' }}
          </a>
        </div>

        <p v-if="current.pickup" data-test="pickup" class="text-[0.8125rem] text-[var(--text)]">
          Recogida n.º {{ current.pickup.providerPickupId }} ·
          {{ pickupStatusLabel[current.pickup.status] ?? adminStatusLabel(current.pickup.status) }}
          <span v-if="current.pickup.scannedCount !== null">
            · escaneados {{ current.pickup.scannedCount }}, faltan {{ current.pickup.missingCount }}, inesperados
            {{ current.pickup.unexpectedTrackings.length }}</span
          >
        </p>

        <form v-if="canConfirm" class="space-y-3" @submit.prevent="confirm">
          <AdminFormField
            v-slot="{ id }"
            label="Seguimientos escaneados por el transportista"
            help="Pega un número de seguimiento por línea."
          >
            <textarea :id="id" v-model="scans" data-test="scans" rows="4" class="adm-input w-full" />
          </AdminFormField>
          <button type="submit" data-test="confirm" :disabled="busy" class="adm-btn adm-btn--secondary">
            Conciliar recogida
          </button>
        </form>
      </div>
    </AdminCard>

    <AdminConfirm
      v-model:open="cancelOpen"
      title="¿Cancelar este manifiesto?"
      description="Las expediciones quedarán libres para incluirlas en otro manifiesto."
      confirm-label="Cancelar manifiesto"
      cancel-label="Volver"
      danger
      :loading="busy"
      @confirm="confirmCancel"
    />
  </div>
</template>
