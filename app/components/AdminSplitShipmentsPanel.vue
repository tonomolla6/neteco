<script setup lang="ts">
import { ref, onMounted } from 'vue'

const props = defineProps<{
  orderId: string
}>()

interface SplitPreferences {
  customerAcceptsSplit: boolean
  acceptedExtraShippingCents: number
  shippingCostPayer: string
  customerConsentAt: string
}

interface SplitItem {
  lineIndex: number
  sku?: string
  variantId?: string
  quantityAllocated: number
  quantityBackordered: number
}

interface SplitShipment {
  id: string
  shipmentNumber: number
  shipmentType: 'immediate' | 'backorder'
  status: string
  trackingNumber: string | null
  carrier: string | null
  estimatedRestockAt?: string | null
  items: SplitItem[]
}

interface BillingSummary {
  totalBilledCents: number
  expectedTotalCents: number
  isFullyReconciled: boolean
  discrepancyCents: number
}

interface SplitPanelData {
  preferences: SplitPreferences | null
  shipments: SplitShipment[]
  billing: BillingSummary | null
}

const loading = ref(true)
const error = ref<string | null>(null)
const data = ref<SplitPanelData | null>(null)

const requestFetch = useRequestFetch()

async function loadData() {
  loading.value = true
  error.value = null
  try {
    const res = await requestFetch(`/api/admin/orders/split-details?orderId=${props.orderId}`)
    data.value = res as SplitPanelData
  } catch (err: unknown) {
    const fetchErr = err as { data?: { error?: { code?: string } } }
    error.value = fetchErr?.data?.error?.code ?? 'error_loading_split_data'
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  loadData()
})
</script>

<template>
  <div class="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
    <div class="flex items-center justify-between border-b border-slate-100 pb-4">
      <div>
        <h3 class="text-lg font-semibold text-slate-900">Envíos Parciales y Backorders</h3>
        <p class="text-sm text-slate-500">Gestión de disponibilidad, entregas divididas y conciliación contable</p>
      </div>
    </div>

    <!-- Loading State -->
    <div v-if="loading" class="py-8 text-center text-sm text-slate-500" aria-live="polite">
      Cargando envíos parciales...
    </div>

    <!-- Error State -->
    <div v-else-if="error" class="my-4 rounded-md bg-red-50 p-4 text-sm text-red-700" role="alert">
      Error: {{ error }}
    </div>

    <!-- Content State -->
    <div v-else-if="data" class="mt-4 space-y-6">
      <!-- Consent Banner -->
      <div
        v-if="data.preferences?.customerAcceptsSplit"
        class="rounded-md border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800"
      >
        <div class="flex items-center gap-2">
          <span class="font-semibold">Envío parcial aceptado por el cliente</span>
        </div>
        <div class="mt-1 text-xs text-emerald-700">
          Coste adicional aceptado: {{ ((data.preferences.acceptedExtraShippingCents || 0) / 100).toFixed(2) }} EUR
          (Asumido por: {{ data.preferences.shippingCostPayer === 'customer' ? 'Cliente' : 'Tienda' }})
        </div>
      </div>
      <div v-else class="rounded-md border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
        El cliente no ha solicitado envíos parciales. El pedido se expedirá en un único paquete completo.
      </div>

      <!-- Shipments List -->
      <div v-if="data.shipments.length > 0" class="space-y-4">
        <h4 class="text-sm font-semibold text-slate-800">Paquetes y Expediciones</h4>
        <div
          v-for="shipment in data.shipments"
          :key="shipment.id"
          class="rounded-md border p-4"
          :class="
            shipment.shipmentType === 'immediate' ? 'border-sky-200 bg-sky-50/30' : 'border-amber-200 bg-amber-50/30'
          "
        >
          <div class="flex items-center justify-between">
            <span class="font-medium text-slate-900">
              Paquete #{{ shipment.shipmentNumber }}:
              <span v-if="shipment.shipmentType === 'immediate'" class="text-sky-700 font-semibold"
                >Envío inmediato</span
              >
              <span v-else class="text-amber-700 font-semibold">Envío pendiente / Backorder</span>
            </span>
            <span class="rounded bg-slate-100 px-2 py-0.5 text-xs font-mono uppercase text-slate-700">
              {{ shipment.status }}
            </span>
          </div>

          <div v-if="shipment.estimatedRestockAt" class="mt-2 text-xs text-amber-800">
            Fecha estimada de reposición: {{ new Date(shipment.estimatedRestockAt).toLocaleDateString() }}
          </div>

          <!-- Items in Shipment -->
          <ul class="mt-3 divide-y divide-slate-100 text-xs">
            <li v-for="item in shipment.items" :key="item.lineIndex" class="flex justify-between py-1 text-slate-600">
              <span>Línea #{{ item.lineIndex }} ({{ item.sku || item.variantId }})</span>
              <span>
                {{
                  item.quantityAllocated > 0
                    ? `Asignado: ${item.quantityAllocated}`
                    : `Pendiente: ${item.quantityBackordered}`
                }}
              </span>
            </li>
          </ul>
        </div>
      </div>

      <!-- Billing Reconciliation Summary -->
      <div v-if="data.billing" class="rounded-md border border-slate-200 bg-slate-50 p-4">
        <h4 class="text-xs font-semibold uppercase text-slate-500">Conciliación de Facturación</h4>
        <div class="mt-2 flex items-center justify-between text-sm">
          <span>Total facturado en envíos: {{ (data.billing.totalBilledCents / 100).toFixed(2) }} EUR</span>
          <span
            v-if="data.billing.isFullyReconciled"
            class="inline-flex items-center rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-800"
          >
            Facturación totalmente conciliada
          </span>
          <span
            v-else
            class="inline-flex items-center rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-medium text-red-800"
          >
            Discrepancia: {{ (data.billing.discrepancyCents / 100).toFixed(2) }} EUR
          </span>
        </div>
      </div>
    </div>
  </div>
</template>
