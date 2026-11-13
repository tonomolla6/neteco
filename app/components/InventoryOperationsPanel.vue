<script setup lang="ts">
import { ref, watch, onMounted, computed } from 'vue'
import type { AdminTone } from '~/utils/adminLabels'

// INV-014 contract commitments, INV-015 picking locations (single warehouse),
// INV-016 purchase orders and receipts. Every write is an idempotent command
// carrying the version the operator saw (compare-and-set).
const props = defineProps<{
  scopeKey: string
  enabled: boolean
  pending: boolean
  selectedVariantUuid?: string
}>()

interface Commitment {
  id: string
  contractRef: string
  customerId: string | null
  quantity: number
  expiresAt: string
  status: 'active' | 'fulfilled' | 'released' | 'expired'
  overdue: boolean
  expiringSoon: boolean
  renewalCount: number
  maxRenewals: number
  renewalsRemaining: number
  version: number
}
interface PickLocation {
  id: string
  code: string
  zone: string
  kind: string
  pickSequence: number
  capacityUnits: number | null
  active: boolean
  stockUnits: number
  version: number
}
interface PickStock {
  pickLocationId: string
  code: string
  quantity: number
  version: number
}
interface Consistency {
  physicalQuantity: number
  reservedQuantity: number
  sellableQuantity: number
  locatedQuantity: number
  unlocatedQuantity: number
  consistent: boolean
}
interface PurchaseOrderRow {
  id: string
  poNumber: string
  supplierName: string
  status: string
  currency: string
  totalCostCents: number
  expectedUnits: number
  receivedUnits: number
  hasDiscrepancy: boolean
  version: number
}
interface PurchaseOrderLine {
  lineIndex: number
  sku: string
  expectedQuantity: number
  receivedQuantity: number
  rejectedQuantity: number
  unitCostCents: number
  discrepancy: string
  openQuantity: number
}
interface PurchaseOrderDetail extends PurchaseOrderRow {
  receivedCostCents: number
  lines: PurchaseOrderLine[]
  receipts: { id: string; receiptNumber: string; receivedAt: string }[]
  documents: { id: string; kind: string; reference: string; sha256: string }[]
  summary: {
    expectedUnits: number
    receivedUnits: number
    rejectedUnits: number
    openUnits: number
    hasDiscrepancy: boolean
  }
}

const COMMAND_URL = '/api/admin/inventory/operations/commands'
const errorMessages: Record<string, string> = {
  invalid_input: 'Hay algún dato que no es válido. Revísalo y vuelve a intentarlo.',
  validation_error: 'Hay algún dato que no es válido. Revísalo y vuelve a intentarlo.',
  concurrency_conflict: 'Conflicto de versión: otra persona modificó el registro. Recarga e inténtalo de nuevo.',
  insufficient_stock: 'No hay stock vendible suficiente.',
  idempotency_payload_mismatch: 'La clave de operación ya se usó con otros datos.',
  forbidden: 'No tienes permiso para esta operación.',
  rate_limited: 'Demasiadas operaciones. Espera un momento.',
  pick_stock_exceeds_physical: 'No se puede ubicar más stock del que existe físicamente.',
  pick_location_capacity_exceeded: 'La ubicación no tiene capacidad suficiente.',
  over_receipt_exceeds_tolerance: 'La cantidad recibida supera la tolerancia permitida sobre lo pedido.',
  purchase_order_state_invalid: 'El estado de la orden no permite esta operación.',
  commitment_renewals_exhausted: 'El compromiso no admite más renovaciones.',
  commitment_not_active: 'El compromiso ya no está activo.',
  duplicate_receipt_number: 'Ya existe una recepción con ese número.',
  duplicate_po_number: 'Ya existe una orden con ese número.'
}

const activeTab = ref<'commitments' | 'picking' | 'purchasing'>('commitments')
const loading = ref(false)
const errorMessage = ref('')
const successMessage = ref('')
const busy = computed(() => loading.value || props.pending)
// Confirmación en modal de las acciones con consecuencias.
const pendingConfirm = ref<{ title: string; description: string; danger: boolean; run: () => unknown } | null>(null)
const confirmOpen = computed({
  get: () => pendingConfirm.value !== null,
  set: (value: boolean) => {
    if (!value) pendingConfirm.value = null
  }
})
function ask(title: string, description: string, run: () => unknown, danger = false) {
  pendingConfirm.value = { title, description, danger, run }
}
function runConfirm() {
  const run = pendingConfirm.value?.run
  pendingConfirm.value = null
  void run?.()
}

const commitments = ref<Commitment[]>([])
const commitmentForm = ref({ contractRef: '', quantity: '' as number | '', expiresOn: '', maxRenewals: 0, reason: '' })

const pickLocations = ref<PickLocation[]>([])
const pickStock = ref<PickStock[]>([])
const consistency = ref<Consistency | null>(null)
const binForm = ref({ code: '', zone: '', pickSequence: 10 })
const putawayForm = ref({ pickLocationId: '', quantity: '' as number | '' })

const orders = ref<PurchaseOrderRow[]>([])
const order = ref<PurchaseOrderDetail | null>(null)
const receiptForm = ref({
  receiptNumber: '',
  quantities: {} as Record<number, number | ''>,
  rejected: {} as Record<number, number | ''>
})

function describe(error: unknown): string {
  const code = (error as { data?: { error?: { code?: string } } })?.data?.error?.code
  if (code)
    return errorMessages[code] ?? 'No se ha podido completar la operación. Revisa los datos y vuelve a intentarlo.'
  return 'No hemos podido completar la operación. Vuelve a intentarlo.'
}

async function load() {
  if (!props.enabled || !props.selectedVariantUuid) return
  loading.value = true
  errorMessage.value = ''
  try {
    const variant = props.selectedVariantUuid
    if (activeTab.value === 'commitments') {
      commitments.value =
        (await $fetch<{ items: Commitment[] }>(`/api/admin/inventory/commitments?variantId=${variant}`)).items ?? []
    } else if (activeTab.value === 'picking') {
      const [locations, stock, report] = await Promise.all([
        $fetch<{ items: PickLocation[] }>('/api/admin/inventory/pick-locations'),
        $fetch<{ items: PickStock[] }>(`/api/admin/inventory/pick-locations/stock?variantId=${variant}`),
        $fetch<{ items: Consistency[] }>(`/api/admin/inventory/pick-locations/consistency?variantId=${variant}`)
      ])
      pickLocations.value = locations.items ?? []
      pickStock.value = stock.items ?? []
      consistency.value = report.items?.[0] ?? null
    } else {
      orders.value = (await $fetch<{ items: PurchaseOrderRow[] }>('/api/admin/inventory/purchase-orders')).items ?? []
      if (order.value) await openOrder(order.value.id, false)
    }
  } catch (error) {
    errorMessage.value = describe(error)
  } finally {
    loading.value = false
  }
}

async function command(action: string, targetId: string, input: Record<string, unknown>, done: string) {
  if (!props.enabled || busy.value) return false
  loading.value = true
  errorMessage.value = ''
  successMessage.value = ''
  try {
    const key = crypto.randomUUID()
    await $fetch(COMMAND_URL, {
      method: 'POST',
      headers: { 'Idempotency-Key': key, 'Content-Type': 'application/json' },
      body: { action, targetId, input }
    })
    successMessage.value = done
    loading.value = false
    await load()
    return true
  } catch (error) {
    errorMessage.value = describe(error)
    return false
  } finally {
    loading.value = false
  }
}

watch([() => props.selectedVariantUuid, activeTab, () => props.enabled], load)
onMounted(load)

// --- INV-014
async function createCommitment() {
  const f = commitmentForm.value
  if (!props.selectedVariantUuid || !f.contractRef || !f.quantity || !f.expiresOn) return
  const ok = await command(
    'create_commitment',
    crypto.randomUUID(),
    {
      variantId: props.selectedVariantUuid,
      contractRef: f.contractRef.trim(),
      quantity: Number(f.quantity),
      expiresAt: `${f.expiresOn}T23:59:59Z`,
      maxRenewals: Number(f.maxRenewals) || 0,
      reason: f.reason.trim() || 'Compromiso de stock por contrato'
    },
    `Compromiso ${f.contractRef} creado.`
  )
  if (ok) commitmentForm.value = { contractRef: '', quantity: '', expiresOn: '', maxRenewals: 0, reason: '' }
}
async function releaseCommitment(item: Commitment, confirmed = false) {
  if (!confirmed) {
    ask(`Liberar la reserva ${item.contractRef}`, 'El stock volverá a estar disponible para la venta.', () =>
      releaseCommitment(item, true)
    )
    return
  }
  await command(
    'release_commitment',
    item.id,
    { expectedVersion: item.version, reason: 'Liberado desde el panel de inventario' },
    'Compromiso liberado.'
  )
}
async function renewCommitment(item: Commitment) {
  const next = new Date(Date.parse(item.expiresAt) + 30 * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  await command(
    'renew_commitment',
    item.id,
    { expectedVersion: item.version, expiresAt: next, reason: 'Renovación 30 días desde el panel' },
    'Compromiso renovado.'
  )
}
function statusLabel(item: Commitment) {
  if (item.status === 'active')
    return item.overdue ? 'Vencido (pendiente de liberar)' : item.expiringSoon ? 'Caduca pronto' : 'Activo'
  return { fulfilled: 'Cumplido', released: 'Liberado', expired: 'Caducado' }[item.status]
}

// --- INV-015
async function createBin() {
  const f = binForm.value
  if (!f.code || !f.zone) return
  const ok = await command(
    'create_pick_location',
    crypto.randomUUID(),
    { code: f.code.trim(), zone: f.zone.trim(), kind: 'pick', pickSequence: Number(f.pickSequence) },
    `Ubicación ${f.code.toUpperCase()} creada.`
  )
  if (ok) binForm.value = { code: '', zone: '', pickSequence: 10 }
}
async function putaway() {
  const f = putawayForm.value
  if (!props.selectedVariantUuid || !f.pickLocationId || !f.quantity) return
  const current = pickStock.value.find((s) => s.pickLocationId === f.pickLocationId)
  const ok = await command(
    'putaway',
    crypto.randomUUID(),
    {
      variantId: props.selectedVariantUuid,
      pickLocationId: f.pickLocationId,
      quantity: Number(f.quantity),
      expectedVersion: current?.version ?? 0
    },
    'Stock ubicado.'
  )
  if (ok) putawayForm.value = { pickLocationId: f.pickLocationId, quantity: '' }
}

// --- INV-016
async function openOrder(id: string, resetForm = true) {
  loading.value = true
  errorMessage.value = ''
  try {
    order.value = await $fetch<PurchaseOrderDetail>(`/api/admin/inventory/purchase-orders/${id}`)
    if (resetForm) receiptForm.value = { receiptNumber: '', quantities: {}, rejected: {} }
  } catch (error) {
    errorMessage.value = describe(error)
  } finally {
    loading.value = false
  }
}
async function orderAction(
  action: 'submit_purchase_order' | 'cancel_purchase_order' | 'close_purchase_order',
  label: string,
  confirmed = false
) {
  if (!order.value) return
  const input: Record<string, unknown> = { expectedVersion: order.value.version }
  if (action !== 'submit_purchase_order') {
    if (!confirmed) {
      ask(
        action === 'cancel_purchase_order' ? 'Cancelar el pedido' : 'Cerrar el pedido con faltante',
        `El pedido ${order.value.poNumber} quedará ${label}.`,
        () => orderAction(action, label, true),
        action === 'cancel_purchase_order'
      )
      return
    }
    input.reason = `${label} desde el panel de inventario`
  }
  await command(action, order.value.id, input, `Orden ${label}.`)
}
async function recordReceipt() {
  const current = order.value
  if (!current || !receiptForm.value.receiptNumber) return
  const lines = current.lines
    .map((line) => ({
      lineIndex: line.lineIndex,
      receivedQuantity: Number(receiptForm.value.quantities[line.lineIndex] || 0),
      rejectedQuantity: Number(receiptForm.value.rejected[line.lineIndex] || 0)
    }))
    .filter((line) => line.receivedQuantity + line.rejectedQuantity > 0)
  if (!lines.length) {
    errorMessage.value = 'Indica al menos una cantidad recibida o rechazada.'
    return
  }
  await command(
    'record_receipt',
    crypto.randomUUID(),
    {
      purchaseOrderId: current.id,
      expectedVersion: current.version,
      receiptNumber: receiptForm.value.receiptNumber.trim(),
      receivedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      lines,
      documents: []
    },
    'Recepción registrada.'
  )
}
async function attachDocument(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file || !order.value) return
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  const sha256 = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
  await command(
    'attach_document',
    crypto.randomUUID(),
    {
      purchaseOrderId: order.value.id,
      kind: 'delivery_note',
      reference: file.name.slice(0, 200),
      sha256,
      sizeBytes: file.size,
      mediaType: file.type
    },
    'Documento registrado.'
  )
}
const euros = (cents: number) => (cents / 100).toLocaleString('es-ES', { style: 'currency', currency: 'EUR' })
const orderStatuses: Record<string, string> = {
  draft: 'Borrador',
  ordered: 'Pedida',
  partially_received: 'Recibida parcialmente',
  received: 'Recibida',
  closed: 'Cerrada',
  cancelled: 'Cancelada'
}
const discrepancyLabels: Record<string, string> = {
  none: 'Correcto',
  pending: 'Pendiente',
  short: 'Faltante',
  over: 'Exceso',
  rejected: 'Rechazo'
}
const tabs = [
  ['commitments', 'Reservas para contratos'],
  ['picking', 'Ubicaciones del almacén'],
  ['purchasing', 'Compras y recepciones']
] as const
const orderTones: Record<string, AdminTone> = {
  draft: 'neutral',
  ordered: 'info',
  partially_received: 'warning',
  received: 'success',
  closed: 'neutral',
  cancelled: 'danger'
}
function commitmentTone(item: Commitment): AdminTone {
  if (item.status === 'active') return item.overdue ? 'danger' : item.expiringSoon ? 'warning' : 'success'
  return 'neutral'
}
</script>

<template>
  <section class="adm-stack min-w-0" aria-labelledby="inventory-operations-title">
    <h2 id="inventory-operations-title" class="sr-only">Reservas, ubicaciones y compras</h2>
    <nav class="flex flex-wrap gap-2" role="tablist" aria-label="Operaciones de inventario">
      <button
        v-for="[key, label] in tabs"
        :key="key"
        type="button"
        role="tab"
        class="adm-chip"
        :aria-selected="activeTab === key"
        :data-active="activeTab === key || undefined"
        @click="activeTab = key"
      >
        {{ label }}
      </button>
    </nav>

    <UAlert
      v-if="errorMessage"
      role="alert"
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="errorMessage"
      :actions="[{ label: 'Recargar datos', color: 'neutral', variant: 'outline', onClick: () => void load() }]"
    />
    <UAlert
      v-if="successMessage"
      role="status"
      color="success"
      variant="subtle"
      icon="i-lucide-circle-check"
      :title="successMessage"
    />
    <p v-if="loading" class="adm-help" role="status">Cargando…</p>

    <div role="tabpanel" class="adm-stack">
      <!-- Reservas para contratos -->
      <template v-if="activeTab === 'commitments'">
        <AdminCard
          title="Stock reservado para contratos"
          description="Unidades apartadas para un cliente con contrato: no se venden en la tienda hasta que se liberan."
          flush
        >
          <AdminEmptyState
            v-if="!loading && !commitments.length && !errorMessage"
            compact
            icon="i-lucide-lock-open"
            title="No hay compromisos de contrato para este producto"
            description="Todo el stock está disponible para la venta."
          />
          <div v-else-if="commitments.length" class="adm-table-wrap">
            <table class="adm-table">
              <thead>
                <tr>
                  <th scope="col">Contrato</th>
                  <th scope="col" data-numeric>Unidades</th>
                  <th scope="col">Caduca</th>
                  <th scope="col">Estado</th>
                  <th scope="col">Renovaciones</th>
                  <th scope="col" data-numeric><span class="sr-only">Acciones</span></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="item in commitments" :key="item.id">
                  <td class="font-semibold text-[var(--text-strong)]">{{ item.contractRef }}</td>
                  <td data-numeric>{{ item.quantity }}</td>
                  <td>{{ adminDate(item.expiresAt) }}</td>
                  <td>
                    <AdminBadge :tone="commitmentTone(item)">{{ statusLabel(item) }}</AdminBadge>
                  </td>
                  <td>{{ item.renewalsRemaining }} renovación(es) restante(s)</td>
                  <td data-numeric class="adm-table__actions">
                    <template v-if="item.status === 'active'">
                      <button
                        type="button"
                        data-action="renew-commitment"
                        class="adm-btn adm-btn--secondary adm-btn--sm"
                        :disabled="busy || item.overdue || item.renewalsRemaining < 1"
                        @click="renewCommitment(item)"
                      >
                        Renovar 30 días
                      </button>
                      <button
                        type="button"
                        data-action="release-commitment"
                        class="adm-btn adm-btn--secondary adm-btn--sm"
                        :disabled="busy"
                        @click="releaseCommitment(item)"
                      >
                        Liberar
                      </button>
                    </template>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </AdminCard>
        <AdminCard title="Reservar stock para un contrato">
          <form aria-label="Nuevo compromiso" class="adm-stack" @submit.prevent="createCommitment">
            <div class="adm-form-grid">
              <label class="adm-field">
                <span class="adm-label">Contrato</span>
                <input v-model="commitmentForm.contractRef" name="contractRef" required minlength="3" maxlength="100" />
              </label>
              <label class="adm-field">
                <span class="adm-label">Unidades</span>
                <input v-model.number="commitmentForm.quantity" name="quantity" type="number" min="1" required />
              </label>
              <label class="adm-field">
                <span class="adm-label">Caduca el</span>
                <input v-model="commitmentForm.expiresOn" name="expiresOn" type="date" required />
              </label>
              <label class="adm-field">
                <span class="adm-label">Renovaciones permitidas</span>
                <input v-model.number="commitmentForm.maxRenewals" name="maxRenewals" type="number" min="0" max="12" />
              </label>
              <label class="adm-field">
                <span class="adm-label">Motivo</span>
                <input v-model="commitmentForm.reason" name="reason" minlength="5" maxlength="500" />
              </label>
            </div>
            <div class="flex justify-end">
              <button type="submit" class="adm-btn adm-btn--primary" :disabled="busy">Reservar stock</button>
            </div>
          </form>
        </AdminCard>
      </template>

      <!-- Ubicaciones -->
      <template v-else-if="activeTab === 'picking'">
        <AdminCard v-if="consistency" title="Reparto del stock">
          <template #actions>
            <AdminBadge :tone="consistency.consistent ? 'success' : 'danger'">
              {{ consistency.consistent ? 'Consistente' : 'Inconsistente' }}
            </AdminBadge>
          </template>
          <dl class="grid grid-cols-2 gap-4 sm:grid-cols-5">
            <div>
              <dt class="adm-help">Físico</dt>
              <dd class="font-semibold text-[var(--text-strong)]">{{ consistency.physicalQuantity }}</dd>
            </div>
            <div>
              <dt class="adm-help">Reservado</dt>
              <dd class="font-semibold text-[var(--text-strong)]">{{ consistency.reservedQuantity }}</dd>
            </div>
            <div>
              <dt class="adm-help">Vendible</dt>
              <dd class="font-semibold text-[var(--text-strong)]">{{ consistency.sellableQuantity }}</dd>
            </div>
            <div>
              <dt class="adm-help">Ubicado</dt>
              <dd class="font-semibold text-[var(--text-strong)]">{{ consistency.locatedQuantity }}</dd>
            </div>
            <div>
              <dt class="adm-help">Sin ubicar</dt>
              <dd class="font-semibold text-[var(--text-strong)]">{{ consistency.unlocatedQuantity }}</dd>
            </div>
          </dl>
        </AdminCard>
        <AdminCard title="Ubicaciones del almacén" description="Dónde está colocado este producto." flush>
          <AdminEmptyState
            v-if="!loading && !pickLocations.length && !errorMessage"
            compact
            icon="i-lucide-map-pin"
            title="Aún no hay ubicaciones"
            description="Crea la primera ubicación (estantería, pasillo…) para poder colocar el stock."
          />
          <div v-else-if="pickLocations.length" class="adm-table-wrap">
            <table class="adm-table">
              <thead>
                <tr>
                  <th scope="col">Ubicación</th>
                  <th scope="col">Zona</th>
                  <th scope="col">Tipo</th>
                  <th scope="col" data-numeric>Orden de recogida</th>
                  <th scope="col" data-numeric>Unidades</th>
                  <th scope="col" data-numeric>De este producto</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="bin in pickLocations" :key="bin.id">
                  <td class="font-semibold text-[var(--text-strong)]">
                    {{ bin.code }} <AdminBadge v-if="!bin.active" tone="neutral" plain>Inactiva</AdminBadge>
                  </td>
                  <td>{{ bin.zone }}</td>
                  <td>{{ adminHumanize(bin.kind) }}</td>
                  <td data-numeric>{{ bin.pickSequence }}</td>
                  <td data-numeric>
                    {{ bin.stockUnits }}<span v-if="bin.capacityUnits"> / {{ bin.capacityUnits }}</span>
                  </td>
                  <td data-numeric class="font-semibold">
                    {{ pickStock.find((s) => s.pickLocationId === bin.id)?.quantity ?? 0 }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </AdminCard>
        <div class="adm-grid">
          <AdminCard title="Colocar stock en una ubicación">
            <form aria-label="Ubicar stock" class="adm-stack" @submit.prevent="putaway">
              <label class="adm-field">
                <span class="adm-label">Ubicación</span>
                <select v-model="putawayForm.pickLocationId" name="pickLocationId" required>
                  <option value="" disabled>Selecciona…</option>
                  <option v-for="bin in pickLocations.filter((b) => b.active)" :key="bin.id" :value="bin.id">
                    {{ bin.code }}
                  </option>
                </select>
              </label>
              <label class="adm-field">
                <span class="adm-label">Unidades</span>
                <input v-model.number="putawayForm.quantity" name="putawayQuantity" type="number" min="1" required />
              </label>
              <div class="flex justify-end">
                <button type="submit" class="adm-btn adm-btn--primary" :disabled="busy">Ubicar</button>
              </div>
            </form>
          </AdminCard>
          <AdminCard title="Nueva ubicación">
            <form aria-label="Nueva ubicación" class="adm-stack" @submit.prevent="createBin">
              <label class="adm-field">
                <span class="adm-label">Código</span>
                <input v-model="binForm.code" name="binCode" required maxlength="24" placeholder="Ej. A-01" />
              </label>
              <label class="adm-field">
                <span class="adm-label">Zona</span>
                <input v-model="binForm.zone" name="binZone" required maxlength="40" />
              </label>
              <label class="adm-field">
                <span class="adm-label">Orden de recogida</span>
                <input v-model.number="binForm.pickSequence" name="binSequence" type="number" min="0" />
              </label>
              <div class="flex justify-end">
                <button type="submit" class="adm-btn adm-btn--secondary" :disabled="busy">Crear ubicación</button>
              </div>
            </form>
          </AdminCard>
        </div>
      </template>

      <!-- Compras -->
      <template v-else>
        <AdminCard title="Pedidos a proveedor con este producto" flush>
          <AdminEmptyState
            v-if="!loading && !orders.length && !errorMessage"
            compact
            icon="i-lucide-clipboard-pen"
            title="No hay pedidos a proveedor"
            description="Cuando pidas este producto a un proveedor, aquí podrás registrar su recepción."
          />
          <div v-else-if="orders.length" class="adm-table-wrap">
            <table class="adm-table">
              <thead>
                <tr>
                  <th scope="col">Pedido</th>
                  <th scope="col">Proveedor</th>
                  <th scope="col">Estado</th>
                  <th scope="col" data-numeric>Recibido / esperado</th>
                  <th scope="col" data-numeric>Coste</th>
                  <th scope="col" data-numeric><span class="sr-only">Acciones</span></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in orders" :key="row.id">
                  <td class="font-semibold text-[var(--text-strong)]">{{ row.poNumber }}</td>
                  <td>{{ row.supplierName }}</td>
                  <td>
                    <AdminBadge :tone="orderTones[row.status] ?? 'neutral'">
                      {{ orderStatuses[row.status] ?? adminHumanize(row.status) }}
                    </AdminBadge>
                    <AdminBadge v-if="row.hasDiscrepancy" tone="warning" plain>Discrepancia</AdminBadge>
                  </td>
                  <td data-numeric>{{ row.receivedUnits }} / {{ row.expectedUnits }}</td>
                  <td data-numeric>{{ euros(row.totalCostCents) }}</td>
                  <td data-numeric class="adm-table__actions">
                    <button
                      type="button"
                      data-action="open-po"
                      class="adm-btn adm-btn--secondary adm-btn--sm"
                      @click="openOrder(row.id)"
                    >
                      Abrir
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </AdminCard>

        <AdminCard
          v-if="order"
          as="article"
          :aria-label="`Orden ${order.poNumber}`"
          :title="`${order.poNumber} · ${order.supplierName}`"
          :description="`Coste pedido ${euros(order.totalCostCents)} · recibido ${euros(order.receivedCostCents)}`"
        >
          <template #actions>
            <AdminBadge :tone="orderTones[order.status] ?? 'neutral'">
              {{ orderStatuses[order.status] ?? adminHumanize(order.status) }}
            </AdminBadge>
            <button
              v-if="order.status === 'draft'"
              type="button"
              class="adm-btn adm-btn--primary adm-btn--sm"
              :disabled="busy"
              @click="orderAction('submit_purchase_order', 'enviada al proveedor')"
            >
              Enviar al proveedor
            </button>
            <button
              v-if="order.status === 'partially_received'"
              type="button"
              class="adm-btn adm-btn--secondary adm-btn--sm"
              :disabled="busy"
              @click="orderAction('close_purchase_order', 'cerrada con faltante')"
            >
              Cerrar con faltante
            </button>
            <button
              v-if="order.status === 'draft' || order.status === 'ordered'"
              type="button"
              class="adm-btn adm-btn--danger-soft adm-btn--sm"
              :disabled="busy"
              @click="orderAction('cancel_purchase_order', 'cancelada')"
            >
              Cancelar pedido
            </button>
          </template>
          <div class="adm-stack">
            <div class="adm-table-wrap rounded-[var(--radius-surface)] border border-[var(--border)]">
              <table class="adm-table">
                <thead>
                  <tr>
                    <th scope="col">Referencia</th>
                    <th scope="col" data-numeric>Esperado</th>
                    <th scope="col" data-numeric>Recibido</th>
                    <th scope="col" data-numeric>Rechazado</th>
                    <th scope="col" data-numeric>Pendiente</th>
                    <th scope="col">Resultado</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="line in order.lines" :key="line.lineIndex">
                    <td class="font-semibold">{{ line.sku }}</td>
                    <td data-numeric>{{ line.expectedQuantity }}</td>
                    <td data-numeric>{{ line.receivedQuantity }}</td>
                    <td data-numeric>{{ line.rejectedQuantity }}</td>
                    <td data-numeric>{{ line.openQuantity }}</td>
                    <td>{{ discrepancyLabels[line.discrepancy] ?? adminHumanize(line.discrepancy) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <form
              v-if="order.status === 'ordered' || order.status === 'partially_received'"
              aria-label="Registrar recepción"
              class="adm-stack border-t border-[var(--border)] pt-4"
              @submit.prevent="recordReceipt"
            >
              <h3>Registrar recepción</h3>
              <label class="adm-field max-w-xs">
                <span class="adm-label">Número de albarán o recepción</span>
                <input v-model="receiptForm.receiptNumber" name="receiptNumber" required minlength="3" maxlength="60" />
              </label>
              <div v-for="line in order.lines" :key="line.lineIndex" class="flex flex-wrap items-end gap-3">
                <span class="w-40 break-words pb-2 font-semibold">{{ line.sku }}</span>
                <label class="adm-field">
                  <span class="adm-label">Recibido</span>
                  <input
                    v-model.number="receiptForm.quantities[line.lineIndex]"
                    :name="`received-${line.lineIndex}`"
                    type="number"
                    min="0"
                    class="w-28"
                  />
                </label>
                <label class="adm-field">
                  <span class="adm-label">Rechazado</span>
                  <input
                    v-model.number="receiptForm.rejected[line.lineIndex]"
                    :name="`rejected-${line.lineIndex}`"
                    type="number"
                    min="0"
                    class="w-28"
                  />
                </label>
              </div>
              <div class="flex justify-end">
                <button type="submit" class="adm-btn adm-btn--primary" :disabled="busy">Registrar recepción</button>
              </div>
            </form>

            <div class="border-t border-[var(--border)] pt-4">
              <h3>Documentos</h3>
              <ul class="mt-2 space-y-1">
                <li v-for="doc in order.documents" :key="doc.id" class="break-words">
                  {{ adminHumanize(doc.kind) }} · {{ doc.reference }}
                </li>
                <li v-if="!order.documents.length" class="adm-help">Sin documentos adjuntos.</li>
              </ul>
              <label class="adm-field mt-3">
                <span class="adm-label">Adjuntar albarán (PDF, imagen o CSV)</span>
                <input
                  type="file"
                  accept="application/pdf,image/jpeg,image/png,text/csv"
                  :disabled="busy"
                  @change="attachDocument"
                />
              </label>
            </div>
          </div>
        </AdminCard>
      </template>
    </div>

    <AdminConfirm
      v-model:open="confirmOpen"
      :title="pendingConfirm?.title ?? ''"
      :description="pendingConfirm?.description"
      :danger="pendingConfirm?.danger"
      @confirm="runConfirm"
    />
  </section>
</template>
