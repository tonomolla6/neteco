<script setup lang="ts">
import { onMounted, ref } from 'vue'

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
const lineUnitCost = ref<number | ''>(1000)

function errorMessage(caught: unknown): string {
  const code = (caught as { data?: { error?: { code?: string } } })?.data?.error?.code
  if (code) return code
  return caught instanceof Error ? caught.message : 'error_servidor'
}

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
    createError.value = 'Completa el número de PO, el proveedor y al menos una línea con variante.'
    return
  }

  const qty = Number(lineQuantity.value)
  const cost = Number(lineUnitCost.value)
  if (!qty || qty <= 0 || cost < 0) {
    createError.value = 'La cantidad debe ser mayor a 0 y el coste unitario no negativo.'
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

    successBanner.value = `Pedido de compra ${poNumber.value} creado con éxito.`
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
  <div class="space-y-6">
    <header>
      <h1 class="text-2xl font-bold text-slate-900">Pedidos de compra a proveedores</h1>
      <p class="text-sm text-slate-600">
        Gestión integral del ciclo de aprovisionamiento (INV-016): alta de pedidos, recepción de mercancía y
        comprobación de discrepancias.
      </p>
    </header>

    <div
      v-if="successBanner"
      data-test="success-banner"
      role="status"
      aria-live="polite"
      class="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800"
    >
      {{ successBanner }}
    </div>

    <div v-if="error" role="alert" class="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
      Error: {{ error }}
    </div>

    <!-- Create Form -->
    <section aria-labelledby="create-po-heading" class="rounded-xl border border-slate-200 bg-white p-5 shadow-xs">
      <h2 id="create-po-heading" class="text-base font-semibold text-slate-900">Nuevo pedido de compra (PO)</h2>
      <form class="mt-4 space-y-3" @submit.prevent="createOrder">
        <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div>
            <label for="po-number" class="block text-xs font-medium text-slate-700">Número de PO</label>
            <input
              id="po-number"
              v-model="poNumber"
              data-test="po-number"
              type="text"
              required
              placeholder="PO-2026-..."
              class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm"
            />
          </div>

          <div>
            <label for="supplier-id" class="block text-xs font-medium text-slate-700">UUID Proveedor</label>
            <input
              id="supplier-id"
              v-model="supplierId"
              data-test="supplier-id"
              type="text"
              required
              placeholder="00000000-0000-0000-0000-000000000000"
              class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm"
            />
          </div>

          <div>
            <label for="notes" class="block text-xs font-medium text-slate-700">Notas internas</label>
            <input
              id="notes"
              v-model="notes"
              type="text"
              placeholder="Condiciones de entrega..."
              class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm"
            />
          </div>
        </div>

        <div class="rounded-lg border border-slate-100 bg-slate-50 p-3 text-xs space-y-2">
          <h3 class="font-medium text-slate-800">Línea de pedido inicial</h3>
          <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <label for="variant-id" class="block text-slate-600">UUID de la Variante</label>
              <input
                id="variant-id"
                v-model="lineVariantId"
                data-test="line-variant-id"
                type="text"
                required
                placeholder="UUID de variante..."
                class="mt-1 block w-full rounded border p-1"
              />
            </div>
            <div>
              <label for="quantity" class="block text-slate-600">Cantidad esperada</label>
              <input
                id="quantity"
                v-model.number="lineQuantity"
                data-test="line-quantity"
                type="number"
                min="1"
                required
                class="mt-1 block w-full rounded border p-1"
              />
            </div>
            <div>
              <label for="unit-cost" class="block text-slate-600">Coste unitario (céntimos)</label>
              <input
                id="unit-cost"
                v-model.number="lineUnitCost"
                data-test="line-unit-cost"
                type="number"
                min="0"
                required
                class="mt-1 block w-full rounded border p-1"
              />
            </div>
          </div>
        </div>

        <p v-if="createError" role="alert" class="text-xs text-red-600">{{ createError }}</p>

        <button
          type="button"
          data-test="submit-po-btn"
          :disabled="creating"
          class="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
          @click="createOrder"
        >
          {{ creating ? 'Creando pedido...' : 'Registrar orden de compra' }}
        </button>
      </form>
    </section>

    <!-- Orders List -->
    <section aria-labelledby="po-list-heading" class="space-y-4">
      <div class="flex items-center justify-between">
        <h2 id="po-list-heading" class="text-lg font-semibold text-slate-900">
          Historial de órdenes ({{ orders.length }})
        </h2>
        <div class="flex gap-2 text-xs">
          <select v-model="statusFilter" class="rounded border border-slate-300 px-2 py-1" @change="loadOrders">
            <option value="">Todos los estados</option>
            <option value="draft">Borrador</option>
            <option value="ordered">Enviada</option>
            <option value="partial">Recepción parcial</option>
            <option value="received">Recibida completa</option>
            <option value="closed">Cerrada</option>
            <option value="cancelled">Cancelada</option>
          </select>
          <button
            type="button"
            class="rounded bg-slate-100 px-3 py-1 font-medium text-slate-700 hover:bg-slate-200"
            @click="loadOrders"
          >
            Refrescar
          </button>
        </div>
      </div>

      <div
        v-if="!loading && orders.length === 0"
        data-test="empty-orders"
        class="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500"
      >
        No hay pedidos de compra registrados.
      </div>

      <div v-else-if="orders.length > 0" class="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table class="min-w-full divide-y divide-slate-200 text-left text-xs">
          <thead class="bg-slate-50 font-medium text-slate-600">
            <tr>
              <th scope="col" class="px-4 py-2.5">PO / ID</th>
              <th scope="col" class="px-4 py-2.5">Proveedor</th>
              <th scope="col" class="px-4 py-2.5">Unidades (Esperadas / Recibidas)</th>
              <th scope="col" class="px-4 py-2.5">Coste Total</th>
              <th scope="col" class="px-4 py-2.5">Estado</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-100">
            <tr v-for="po in orders" :key="po.id" class="hover:bg-slate-50">
              <td class="px-4 py-2 font-mono">
                <span class="font-bold text-slate-900">{{ po.poNumber }}</span>
                <span class="block text-[11px] text-slate-400">{{ po.id }}</span>
              </td>
              <td class="px-4 py-2 text-slate-800 font-medium">
                {{ po.supplierName || 'Proveedor' }}
              </td>
              <td class="whitespace-nowrap px-4 py-2 text-slate-600">
                {{ po.receivedUnits }} / {{ po.expectedUnits }}
                <span v-if="po.hasDiscrepancy" class="ml-1 text-red-600 font-bold" title="Discrepancia detectada"
                  >⚠️</span
                >
              </td>
              <td class="whitespace-nowrap px-4 py-2 font-semibold text-slate-900">
                {{ formatCents(po.totalCostCents) }}
              </td>
              <td class="whitespace-nowrap px-4 py-2">
                <span
                  class="inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold"
                  :class="{
                    'bg-slate-100 text-slate-700': po.status === 'draft',
                    'bg-blue-50 text-blue-700': po.status === 'ordered',
                    'bg-amber-50 text-amber-700': po.status === 'partial',
                    'bg-emerald-50 text-emerald-700': po.status === 'received' || po.status === 'closed',
                    'bg-red-50 text-red-700': po.status === 'cancelled'
                  }"
                >
                  {{ po.status }}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>
