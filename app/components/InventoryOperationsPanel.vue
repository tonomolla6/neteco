<script setup lang="ts">
import { ref, watch, onMounted, computed } from 'vue'

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
  if (code) return errorMessages[code] ?? `Operación rechazada (${code}).`
  return error instanceof Error ? error.message : 'Error al comunicar con el servidor.'
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
async function releaseCommitment(item: Commitment) {
  if (!confirm(`¿Liberar el compromiso ${item.contractRef}? El stock volverá a estar disponible.`)) return
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
  label: string
) {
  if (!order.value) return
  const input: Record<string, unknown> = { expectedVersion: order.value.version }
  if (action !== 'submit_purchase_order') {
    if (!confirm(`¿Confirmas: ${label}?`)) return
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
  ['commitments', 'Compromisos de contrato (INV-014)'],
  ['picking', 'Ubicaciones de picking (INV-015)'],
  ['purchasing', 'Compras y recepciones (INV-016)']
] as const
</script>

<template>
  <section
    class="mt-6 rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
    aria-labelledby="inventory-operations-title"
  >
    <header class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 id="inventory-operations-title" class="text-base font-semibold text-slate-900">
          Compromisos, picking y compras
        </h2>
        <p class="text-xs text-slate-500">Un único almacén: sin transferencias entre almacenes.</p>
      </div>
      <nav class="flex flex-wrap gap-2" role="tablist" aria-label="Operaciones de inventario">
        <button
          v-for="[key, label] in tabs"
          :key="key"
          type="button"
          role="tab"
          :aria-selected="activeTab === key"
          :class="[
            'rounded-md px-3 py-1.5 text-sm font-medium',
            activeTab === key ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
          ]"
          @click="activeTab = key"
        >
          {{ label }}
        </button>
      </nav>
    </header>

    <div v-if="errorMessage" class="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-800" role="alert">
      {{ errorMessage }}
    </div>
    <div v-if="successMessage" class="mt-4 rounded-md bg-emerald-50 p-3 text-sm text-emerald-800" role="status">
      {{ successMessage }}
    </div>
    <p v-if="loading" class="mt-4 text-sm text-slate-500" role="status">Cargando…</p>

    <div role="tabpanel" class="mt-5 space-y-5">
      <!-- INV-014 -->
      <template v-if="activeTab === 'commitments'">
        <p
          v-if="!loading && !commitments.length && !errorMessage"
          class="rounded border border-dashed border-slate-300 p-4 text-center text-sm text-slate-500"
        >
          No hay compromisos de contrato para esta variante.
        </p>
        <div v-else-if="commitments.length" class="overflow-x-auto">
          <table class="min-w-full divide-y divide-slate-200 text-left text-xs">
            <thead class="bg-slate-50 font-semibold text-slate-600">
              <tr>
                <th class="px-3 py-2">Contrato</th>
                <th class="px-3 py-2">Cantidad</th>
                <th class="px-3 py-2">Caduca</th>
                <th class="px-3 py-2">Estado</th>
                <th class="px-3 py-2">Renovaciones</th>
                <th class="px-3 py-2 text-right">Acciones</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              <tr v-for="item in commitments" :key="item.id">
                <td class="px-3 py-2 font-mono">{{ item.contractRef }}</td>
                <td class="px-3 py-2 font-bold">{{ item.quantity }}</td>
                <td class="px-3 py-2">{{ item.expiresAt.substring(0, 10) }}</td>
                <td class="px-3 py-2">{{ statusLabel(item) }}</td>
                <td class="px-3 py-2">{{ item.renewalsRemaining }} renovación(es) restante(s)</td>
                <td class="px-3 py-2 text-right">
                  <template v-if="item.status === 'active'">
                    <button
                      type="button"
                      data-action="renew-commitment"
                      class="mr-2 rounded bg-slate-700 px-2 py-1 text-[11px] text-white disabled:opacity-50"
                      :disabled="busy || item.overdue || item.renewalsRemaining < 1"
                      @click="renewCommitment(item)"
                    >
                      Renovar 30 días
                    </button>
                    <button
                      type="button"
                      data-action="release-commitment"
                      class="rounded bg-amber-600 px-2 py-1 text-[11px] text-white disabled:opacity-50"
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
        <form aria-label="Nuevo compromiso" class="grid gap-3 sm:grid-cols-5" @submit.prevent="createCommitment">
          <label class="text-xs"
            >Contrato<input
              v-model="commitmentForm.contractRef"
              name="contractRef"
              required
              minlength="3"
              maxlength="100"
              class="mt-1 w-full rounded border px-2 py-1"
          /></label>
          <label class="text-xs"
            >Cantidad<input
              v-model.number="commitmentForm.quantity"
              name="quantity"
              type="number"
              min="1"
              required
              class="mt-1 w-full rounded border px-2 py-1"
          /></label>
          <label class="text-xs"
            >Caduca el<input
              v-model="commitmentForm.expiresOn"
              name="expiresOn"
              type="date"
              required
              class="mt-1 w-full rounded border px-2 py-1"
          /></label>
          <label class="text-xs"
            >Renovaciones<input
              v-model.number="commitmentForm.maxRenewals"
              name="maxRenewals"
              type="number"
              min="0"
              max="12"
              class="mt-1 w-full rounded border px-2 py-1"
          /></label>
          <label class="text-xs"
            >Motivo<input
              v-model="commitmentForm.reason"
              name="reason"
              minlength="5"
              maxlength="500"
              class="mt-1 w-full rounded border px-2 py-1"
          /></label>
          <button
            type="submit"
            class="rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50 sm:col-span-5 sm:w-fit"
            :disabled="busy"
          >
            Reservar stock para contrato
          </button>
        </form>
      </template>

      <!-- INV-015 -->
      <template v-else-if="activeTab === 'picking'">
        <dl v-if="consistency" class="grid grid-cols-2 gap-2 text-xs sm:grid-cols-6">
          <div>
            <dt class="text-slate-500">Físico</dt>
            <dd class="font-bold">{{ consistency.physicalQuantity }}</dd>
          </div>
          <div>
            <dt class="text-slate-500">Reservado</dt>
            <dd class="font-bold">{{ consistency.reservedQuantity }}</dd>
          </div>
          <div>
            <dt class="text-slate-500">Vendible</dt>
            <dd class="font-bold">{{ consistency.sellableQuantity }}</dd>
          </div>
          <div>
            <dt class="text-slate-500">Ubicado</dt>
            <dd class="font-bold">{{ consistency.locatedQuantity }}</dd>
          </div>
          <div>
            <dt class="text-slate-500">Sin ubicar</dt>
            <dd class="font-bold">{{ consistency.unlocatedQuantity }}</dd>
          </div>
          <div>
            <dt class="text-slate-500">Estado</dt>
            <dd :class="consistency.consistent ? 'font-bold text-emerald-700' : 'font-bold text-red-700'">
              {{ consistency.consistent ? 'Consistente' : 'Inconsistente' }}
            </dd>
          </div>
        </dl>
        <p
          v-if="!loading && !pickLocations.length && !errorMessage"
          class="rounded border border-dashed border-slate-300 p-4 text-center text-sm text-slate-500"
        >
          No hay ubicaciones de picking definidas.
        </p>
        <div v-else-if="pickLocations.length" class="overflow-x-auto">
          <table class="min-w-full divide-y divide-slate-200 text-left text-xs">
            <thead class="bg-slate-50 font-semibold text-slate-600">
              <tr>
                <th class="px-3 py-2">Ubicación</th>
                <th class="px-3 py-2">Zona</th>
                <th class="px-3 py-2">Tipo</th>
                <th class="px-3 py-2">Orden</th>
                <th class="px-3 py-2">Unidades</th>
                <th class="px-3 py-2">Esta variante</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              <tr v-for="bin in pickLocations" :key="bin.id">
                <td class="px-3 py-2 font-mono font-medium">
                  {{ bin.code }}<span v-if="!bin.active" class="ml-1 text-slate-400">(inactiva)</span>
                </td>
                <td class="px-3 py-2">{{ bin.zone }}</td>
                <td class="px-3 py-2">{{ bin.kind }}</td>
                <td class="px-3 py-2">{{ bin.pickSequence }}</td>
                <td class="px-3 py-2">
                  {{ bin.stockUnits }}<span v-if="bin.capacityUnits"> / {{ bin.capacityUnits }}</span>
                </td>
                <td class="px-3 py-2 font-bold">
                  {{ pickStock.find((s) => s.pickLocationId === bin.id)?.quantity ?? 0 }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <form aria-label="Ubicar stock" class="flex flex-wrap items-end gap-3" @submit.prevent="putaway">
          <label class="text-xs"
            >Ubicación
            <select
              v-model="putawayForm.pickLocationId"
              name="pickLocationId"
              required
              class="mt-1 block rounded border px-2 py-1"
            >
              <option value="" disabled>Selecciona…</option>
              <option v-for="bin in pickLocations.filter((b) => b.active)" :key="bin.id" :value="bin.id">
                {{ bin.code }}
              </option>
            </select>
          </label>
          <label class="text-xs"
            >Cantidad<input
              v-model.number="putawayForm.quantity"
              name="putawayQuantity"
              type="number"
              min="1"
              required
              class="mt-1 block w-28 rounded border px-2 py-1"
          /></label>
          <button
            type="submit"
            class="rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
            :disabled="busy"
          >
            Ubicar
          </button>
        </form>
        <form aria-label="Nueva ubicación" class="flex flex-wrap items-end gap-3" @submit.prevent="createBin">
          <label class="text-xs"
            >Código<input
              v-model="binForm.code"
              name="binCode"
              required
              maxlength="24"
              class="mt-1 block w-28 rounded border px-2 py-1"
          /></label>
          <label class="text-xs"
            >Zona<input
              v-model="binForm.zone"
              name="binZone"
              required
              maxlength="40"
              class="mt-1 block w-28 rounded border px-2 py-1"
          /></label>
          <label class="text-xs"
            >Orden de picking<input
              v-model.number="binForm.pickSequence"
              name="binSequence"
              type="number"
              min="0"
              class="mt-1 block w-28 rounded border px-2 py-1"
          /></label>
          <button
            type="submit"
            class="rounded bg-slate-700 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
            :disabled="busy"
          >
            Crear ubicación
          </button>
        </form>
      </template>

      <!-- INV-016 -->
      <template v-else>
        <p
          v-if="!loading && !orders.length && !errorMessage"
          class="rounded border border-dashed border-slate-300 p-4 text-center text-sm text-slate-500"
        >
          No hay órdenes de compra.
        </p>
        <div v-else-if="orders.length" class="overflow-x-auto">
          <table class="min-w-full divide-y divide-slate-200 text-left text-xs">
            <thead class="bg-slate-50 font-semibold text-slate-600">
              <tr>
                <th class="px-3 py-2">Orden</th>
                <th class="px-3 py-2">Proveedor</th>
                <th class="px-3 py-2">Estado</th>
                <th class="px-3 py-2">Recibido / esperado</th>
                <th class="px-3 py-2">Coste</th>
                <th class="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              <tr v-for="row in orders" :key="row.id">
                <td class="px-3 py-2 font-mono">{{ row.poNumber }}</td>
                <td class="px-3 py-2">{{ row.supplierName }}</td>
                <td class="px-3 py-2">
                  {{ orderStatuses[row.status] ?? row.status
                  }}<span v-if="row.hasDiscrepancy" class="ml-1 rounded bg-amber-100 px-1 text-amber-800"
                    >Discrepancia</span
                  >
                </td>
                <td class="px-3 py-2">{{ row.receivedUnits }} / {{ row.expectedUnits }}</td>
                <td class="px-3 py-2">{{ euros(row.totalCostCents) }}</td>
                <td class="px-3 py-2 text-right">
                  <button
                    type="button"
                    data-action="open-po"
                    class="rounded bg-slate-700 px-2 py-1 text-[11px] text-white"
                    @click="openOrder(row.id)"
                  >
                    Abrir
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <article v-if="order" class="rounded-lg border border-slate-200 p-4" :aria-label="`Orden ${order.poNumber}`">
          <h3 class="text-sm font-semibold">
            {{ order.poNumber }} · {{ order.supplierName }} · {{ orderStatuses[order.status] ?? order.status }}
          </h3>
          <p class="text-xs text-slate-500">
            Coste pedido {{ euros(order.totalCostCents) }} · recibido {{ euros(order.receivedCostCents) }}
          </p>
          <table class="mt-3 min-w-full text-left text-xs">
            <thead class="font-semibold text-slate-600">
              <tr>
                <th class="py-1">SKU</th>
                <th>Esperado</th>
                <th>Recibido</th>
                <th>Rechazado</th>
                <th>Pendiente</th>
                <th>Discrepancia</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="line in order.lines" :key="line.lineIndex">
                <td class="py-1 font-mono">{{ line.sku }}</td>
                <td>{{ line.expectedQuantity }}</td>
                <td>{{ line.receivedQuantity }}</td>
                <td>{{ line.rejectedQuantity }}</td>
                <td>{{ line.openQuantity }}</td>
                <td>{{ discrepancyLabels[line.discrepancy] ?? line.discrepancy }}</td>
              </tr>
            </tbody>
          </table>
          <div class="mt-3 flex flex-wrap gap-2">
            <button
              v-if="order.status === 'draft'"
              type="button"
              class="rounded bg-blue-600 px-3 py-1.5 text-xs text-white disabled:opacity-50"
              :disabled="busy"
              @click="orderAction('submit_purchase_order', 'enviada al proveedor')"
            >
              Enviar al proveedor
            </button>
            <button
              v-if="order.status === 'draft' || order.status === 'ordered'"
              type="button"
              class="rounded bg-red-600 px-3 py-1.5 text-xs text-white disabled:opacity-50"
              :disabled="busy"
              @click="orderAction('cancel_purchase_order', 'cancelada')"
            >
              Cancelar
            </button>
            <button
              v-if="order.status === 'partially_received'"
              type="button"
              class="rounded bg-amber-600 px-3 py-1.5 text-xs text-white disabled:opacity-50"
              :disabled="busy"
              @click="orderAction('close_purchase_order', 'cerrada con faltante')"
            >
              Cerrar con faltante
            </button>
          </div>

          <form
            v-if="order.status === 'ordered' || order.status === 'partially_received'"
            aria-label="Registrar recepción"
            class="mt-4 space-y-2"
            @submit.prevent="recordReceipt"
          >
            <label class="block text-xs"
              >Nº de recepción<input
                v-model="receiptForm.receiptNumber"
                name="receiptNumber"
                required
                minlength="3"
                maxlength="60"
                class="mt-1 block rounded border px-2 py-1"
            /></label>
            <div v-for="line in order.lines" :key="line.lineIndex" class="flex flex-wrap items-center gap-3 text-xs">
              <span class="w-32 font-mono">{{ line.sku }}</span>
              <label
                >Recibido<input
                  v-model.number="receiptForm.quantities[line.lineIndex]"
                  :name="`received-${line.lineIndex}`"
                  type="number"
                  min="0"
                  class="ml-1 w-20 rounded border px-2 py-1"
              /></label>
              <label
                >Rechazado<input
                  v-model.number="receiptForm.rejected[line.lineIndex]"
                  :name="`rejected-${line.lineIndex}`"
                  type="number"
                  min="0"
                  class="ml-1 w-20 rounded border px-2 py-1"
              /></label>
            </div>
            <button
              type="submit"
              class="rounded bg-emerald-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
              :disabled="busy"
            >
              Registrar recepción
            </button>
          </form>

          <h4 class="mt-4 text-xs font-semibold uppercase text-slate-600">Documentos</h4>
          <ul class="text-xs">
            <li v-for="doc in order.documents" :key="doc.id">
              {{ doc.kind }} · {{ doc.reference }} ·
              <span class="font-mono text-slate-400">{{ doc.sha256.substring(0, 12) }}</span>
            </li>
            <li v-if="!order.documents.length" class="text-slate-500">Sin documentos adjuntos.</li>
          </ul>
          <label class="mt-2 block text-xs"
            >Registrar albarán (PDF, imagen o CSV)
            <input
              type="file"
              accept="application/pdf,image/jpeg,image/png,text/csv"
              class="mt-1 block text-xs"
              :disabled="busy"
              @change="attachDocument"
            />
          </label>
        </article>
      </template>
    </div>
  </section>
</template>
