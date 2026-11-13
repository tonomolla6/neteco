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
  <AdminCard title="Envíos parciales" description="Qué sale ya, qué queda pendiente de stock y cómo se factura">
    <div v-if="loading" class="adm-help" aria-live="polite">Cargando envíos parciales…</div>

    <AdminEmptyState
      v-else-if="error"
      role="alert"
      compact
      variant="error"
      title="No se han podido cargar los envíos parciales"
      description="Comprueba el pedido y vuelve a intentarlo."
    >
      <AdminButton icon="i-lucide-rotate-cw" @click="loadData">Reintentar</AdminButton>
    </AdminEmptyState>

    <div v-else-if="data" class="space-y-4">
      <UAlert
        v-if="data.preferences?.customerAcceptsSplit"
        color="success"
        variant="subtle"
        icon="i-lucide-circle-check"
        title="El cliente acepta recibir el pedido en varios envíos"
        :description="`Coste extra de envío aceptado: ${adminMoney(data.preferences.acceptedExtraShippingCents || 0)} (lo paga ${
          data.preferences.shippingCostPayer === 'customer' ? 'el cliente' : 'la tienda'
        }).`"
      />
      <p v-else class="adm-help">El cliente no ha pedido envíos parciales: el pedido saldrá en un único envío.</p>

      <ul v-if="data.shipments.length > 0" class="space-y-3">
        <li
          v-for="shipment in data.shipments"
          :key="shipment.id"
          class="rounded-[var(--radius-surface)] border border-[var(--border)] p-4"
        >
          <div class="flex flex-wrap items-center justify-between gap-2">
            <p class="font-semibold text-[var(--text-strong)]">
              Envío {{ shipment.shipmentNumber }}
              <span class="font-normal text-[var(--text-muted)]">
                · {{ shipment.shipmentType === 'immediate' ? 'sale ya' : 'pendiente de stock' }}</span
              >
            </p>
            <AdminBadge :status="shipment.status" />
          </div>
          <p v-if="shipment.estimatedRestockAt" class="adm-help mt-1">
            Reposición prevista: {{ adminDate(shipment.estimatedRestockAt) }}
          </p>
          <p v-if="shipment.trackingNumber" class="adm-help mt-1">
            {{ shipment.carrier ?? 'Seguimiento' }}: <span class="tabular-nums">{{ shipment.trackingNumber }}</span>
          </p>
          <ul class="mt-3 divide-y divide-[var(--border)]">
            <li
              v-for="item in shipment.items"
              :key="item.lineIndex"
              class="flex justify-between gap-3 py-1.5 text-[var(--text)]"
            >
              <span class="min-w-0 [overflow-wrap:anywhere]"
                >Línea {{ item.lineIndex }} · {{ item.sku || item.variantId }}</span
              >
              <span class="shrink-0 tabular-nums">
                {{
                  item.quantityAllocated > 0
                    ? `${item.quantityAllocated} en este envío`
                    : `${item.quantityBackordered} pendientes`
                }}
              </span>
            </li>
          </ul>
        </li>
      </ul>

      <div
        v-if="data.billing"
        class="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-control)] bg-[var(--surface-sunken)] p-3"
      >
        <span>
          Facturado en los envíos:
          <span class="font-semibold tabular-nums text-[var(--text-strong)]">{{
            adminMoney(data.billing.totalBilledCents)
          }}</span>
        </span>
        <AdminBadge v-if="data.billing.isFullyReconciled" tone="success">Coincide con el total del pedido</AdminBadge>
        <AdminBadge v-else tone="danger">Diferencia de {{ adminMoney(data.billing.discrepancyCents) }}</AdminBadge>
      </div>
    </div>
  </AdminCard>
</template>
