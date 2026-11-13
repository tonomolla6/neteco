<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { AdminTone } from '~/utils/adminLabels'

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

const requestFetch = useRequestFetch()

const loading = ref(true)
const error = ref<string | null>(null)
const successBanner = ref<string | null>(null)
const orders = ref<PurchaseOrderRow[]>([])
const statusFilter = ref('')

// Form state
const creating = ref(false)
const createError = ref<string | null>(null)
const poNumber = ref('')
const supplierId = ref('')
const notes = ref('')
const lineVariantId = ref('')
const lineQuantity = ref<number | ''>(10)
// El coste se teclea en euros; se convierte a céntimos al enviar.
const lineUnitCost = ref('10,00')

const ERROR_TEXT: Record<string, string> = {
  invalid_input: 'Falta algún dato o no es válido. Revisa el formulario y vuelve a intentarlo.',
  validation_error: 'Falta algún dato o no es válido. Revisa el formulario y vuelve a intentarlo.',
  forbidden: 'No tienes permiso para hacer esto.',
  unauthorized: 'Tu sesión ha caducado. Vuelve a iniciar sesión.',
  not_found: 'No hemos encontrado el proveedor o el producto indicado.',
  duplicate_po_number: 'Ya existe un pedido con ese número.',
  concurrency_conflict: 'Otra persona lo ha cambiado mientras tanto. Recarga y vuelve a intentarlo.',
  rate_limited: 'Demasiadas operaciones seguidas. Espera un momento.'
}
function errorMessage(caught: unknown): string {
  const code = (caught as { data?: { error?: { code?: string } } })?.data?.error?.code
  return (code ? ERROR_TEXT[code] : undefined) ?? 'No hemos podido completar la operación. Vuelve a intentarlo.'
}

// Presentación: buscador local, columnas, nombres de estado y panel lateral de alta.
const search = ref('')
const formOpen = ref(false)
const visibleOrders = computed(() => {
  const term = search.value.toLowerCase()
  return term
    ? orders.value.filter(
        (po) => po.poNumber.toLowerCase().includes(term) || (po.supplierName ?? '').toLowerCase().includes(term)
      )
    : orders.value
})
const columns = [
  { key: 'poNumber', label: 'Pedido', sortable: true },
  { key: 'supplierName', label: 'Proveedor', sortable: true },
  { key: 'units', label: 'Recibido / pedido', numeric: true, hideOnMobile: true },
  { key: 'totalCostCents', label: 'Coste total', numeric: true, sortable: true },
  { key: 'status', label: 'Estado' }
]
const STATUS_LABELS: Record<string, string> = {
  draft: 'Borrador',
  ordered: 'Enviado',
  partial: 'Recibido en parte',
  partially_received: 'Recibido en parte',
  received: 'Recibido',
  closed: 'Cerrado',
  cancelled: 'Cancelado'
}
const STATUS_TONES: Record<string, AdminTone> = {
  draft: 'neutral',
  ordered: 'info',
  partial: 'warning',
  partially_received: 'warning',
  received: 'success',
  closed: 'success',
  cancelled: 'danger'
}
function clearFilters() {
  search.value = ''
  if (statusFilter.value) {
    statusFilter.value = ''
    void loadOrders()
  }
}
watch(successBanner, (value) => {
  if (value) formOpen.value = false
})

function formatCents(cents: number): string {
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(cents / 100)
}

function randomUuid(): string {
  return globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `cmd-${Date.now()}`
}

async function loadOrders() {
  loading.value = true
  error.value = null
  try {
    const url = statusFilter.value
      ? `/api/admin/inventory/purchase-orders?status=${encodeURIComponent(statusFilter.value)}`
      : '/api/admin/inventory/purchase-orders'
    const res = await requestFetch<{ items: PurchaseOrderRow[] }>(url)
    orders.value = res.items ?? []
  } catch (caught) {
    error.value = errorMessage(caught)
  } finally {
    loading.value = false
  }
}

async function createOrder() {
  createError.value = null
  successBanner.value = null

  if (!poNumber.value.trim() || !supplierId.value.trim() || !lineVariantId.value.trim()) {
    createError.value = 'Completa el número de pedido, el proveedor y el producto.'
    return
  }

  const qty = Number(lineQuantity.value)
  const cost = adminEurosToCents(lineUnitCost.value)
  if (!qty || qty <= 0 || cost === null) {
    createError.value = 'Las unidades deben ser más de 0 y el coste, un importe en euros como 10,00.'
    return
  }

  creating.value = true
  try {
    const targetId = randomUuid()
    const idempotencyKey = randomUuid()

    await requestFetch('/api/admin/inventory/operations/commands', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'idempotency-key': idempotencyKey
      },
      body: {
        action: 'create_purchase_order',
        targetId,
        input: {
          supplierId: supplierId.value.trim(),
          poNumber: poNumber.value.trim(),
          notes: notes.value.trim() || undefined,
          lines: [
            {
              variantId: lineVariantId.value.trim(),
              expectedQuantity: qty,
              unitCostCents: cost
            }
          ]
        }
      }
    })

    successBanner.value = `Pedido ${poNumber.value} creado con éxito.`
    poNumber.value = ''
    notes.value = ''
    await loadOrders()
  } catch (caught) {
    createError.value = errorMessage(caught)
  } finally {
    creating.value = false
  }
}

onMounted(() => {
  loadOrders()
})
</script>

<template>
  <div class="adm-stack">
    <AdminPageActions>
      <AdminButton variant="primary" icon="i-lucide-plus" @click="formOpen = true">Nuevo pedido</AdminButton>
    </AdminPageActions>

    <UAlert
      v-if="successBanner"
      data-test="success-banner"
      role="status"
      aria-live="polite"
      color="success"
      variant="subtle"
      icon="i-lucide-circle-check"
      :title="successBanner"
    />

    <section aria-labelledby="po-list-heading">
      <h2 id="po-list-heading" class="sr-only">Pedidos a proveedor</h2>
      <div v-if="error" role="alert">
        <AdminCard>
          <AdminEmptyState variant="error" title="No hemos podido cargar los pedidos" :description="error">
            <AdminButton icon="i-lucide-rotate-cw" @click="loadOrders">Reintentar</AdminButton>
          </AdminEmptyState>
        </AdminCard>
      </div>
      <AdminTable
        v-else
        :rows="visibleOrders"
        :columns="columns"
        :row-key="(po) => po.id"
        :status="loading ? 'pending' : 'idle'"
        :filtered="Boolean(search || statusFilter)"
        empty-icon="i-lucide-clipboard-pen"
        empty-title="Aún no hay pedidos a proveedor"
        empty-description="Crea el primero para llevar el control de lo que has pedido y lo que te ha llegado."
        caption="Pedidos a proveedor"
        @clear-filters="clearFilters"
      >
        <template #toolbar>
          <AdminToolbar v-model:search="search" placeholder="Buscar por número o proveedor">
            <select v-model="statusFilter" aria-label="Estado" @change="loadOrders">
              <option value="">Todos los estados</option>
              <option value="draft">Borrador</option>
              <option value="ordered">Enviado</option>
              <option value="partial">Recibido en parte</option>
              <option value="received">Recibido</option>
              <option value="closed">Cerrado</option>
              <option value="cancelled">Cancelado</option>
            </select>
            <template #actions>
              <AdminButton icon="i-lucide-rotate-cw" @click="loadOrders">Actualizar</AdminButton>
            </template>
          </AdminToolbar>
        </template>
        <template #cell-poNumber="{ row }">
          <span class="font-semibold text-[var(--text-strong)]" :title="row.id">{{ row.poNumber }}</span>
        </template>
        <template #cell-supplierName="{ row }">{{ row.supplierName || 'Proveedor sin nombre' }}</template>
        <template #cell-units="{ row }">
          {{ row.receivedUnits }} / {{ row.expectedUnits }}
          <AdminBadge v-if="row.hasDiscrepancy" tone="danger" plain>No coincide</AdminBadge>
        </template>
        <template #cell-totalCostCents="{ row }">{{ formatCents(row.totalCostCents) }}</template>
        <template #cell-status="{ row }">
          <AdminBadge :tone="STATUS_TONES[row.status] ?? 'neutral'">
            {{ STATUS_LABELS[row.status] ?? adminHumanize(row.status) }}
          </AdminBadge>
        </template>
        <template #empty-action>
          <AdminButton icon="i-lucide-plus" @click="formOpen = true">Nuevo pedido</AdminButton>
        </template>
      </AdminTable>
    </section>

    <AdminDrawer
      v-model:open="formOpen"
      title="Nuevo pedido a proveedor"
      description="Se guarda como borrador. Podrás enviarlo y registrar su recepción desde Inventario."
    >
      <form id="create-po-form" aria-label="Nuevo pedido a proveedor" class="adm-stack" @submit.prevent="createOrder">
        <UAlert
          v-if="createError"
          role="alert"
          color="error"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          :title="createError"
        />
        <div class="adm-field">
          <label for="po-number" class="adm-label">Número de pedido</label>
          <input id="po-number" v-model="poNumber" data-test="po-number" type="text" required placeholder="PO-2026-…" />
        </div>
        <div class="adm-field">
          <label for="supplier-id" class="adm-label">Proveedor (identificador)</label>
          <input
            id="supplier-id"
            v-model="supplierId"
            data-test="supplier-id"
            type="text"
            required
            autocomplete="off"
          />
          <p class="adm-help">
            Pega el código largo del proveedor, con sus guiones. Todavía no hay un listado para elegirlo aquí.
          </p>
        </div>
        <div class="adm-field">
          <label for="notes" class="adm-label">Notas internas</label>
          <input id="notes" v-model="notes" type="text" placeholder="Condiciones de entrega…" />
        </div>

        <fieldset class="adm-stack border-t border-[var(--border)] pt-4">
          <legend class="adm-label">Producto que pides</legend>
          <div class="adm-field">
            <label for="variant-id" class="adm-label">Producto</label>
            <AdminVariantPicker id="variant-id" v-model="lineVariantId" data-test="line-variant-id" required />
          </div>
          <div class="grid grid-cols-2 gap-4">
            <div class="adm-field">
              <label for="quantity" class="adm-label">Unidades</label>
              <input
                id="quantity"
                v-model.number="lineQuantity"
                data-test="line-quantity"
                type="number"
                min="1"
                required
              />
            </div>
            <div class="adm-field">
              <label for="unit-cost" class="adm-label">Coste por unidad</label>
              <div class="flex items-center gap-2">
                <input
                  id="unit-cost"
                  v-model="lineUnitCost"
                  data-test="line-unit-cost"
                  type="text"
                  inputmode="decimal"
                  class="adm-input"
                  placeholder="0,00"
                  required
                />
                <span class="text-[var(--text-muted)]">€</span>
              </div>
            </div>
          </div>
        </fieldset>
      </form>
      <template #footer>
        <AdminButton @click="formOpen = false">Cancelar</AdminButton>
        <button
          type="button"
          data-test="submit-po-btn"
          class="adm-btn adm-btn--primary"
          :disabled="creating"
          @click="createOrder"
        >
          {{ creating ? 'Guardando…' : 'Guardar pedido' }}
        </button>
      </template>
    </AdminDrawer>
  </div>
</template>
