<script setup lang="ts">
import { ref, onMounted } from 'vue'

interface ContingencyRoute {
  id: string
  marketCode: string
  primaryProvider: string
  alternativeProvider: string
  activeProvider: string
  contingencyActive: boolean
  contingencyReason: string | null
  circuitState: string
  version: number
}

interface ReconciliationItem {
  id: string
  intentId: string
  orderId: string
  provider: string
  providerReference: string
  amountCents: number
  currency: string
  status: string
  settledAt: string | null
}

interface ContingencyData {
  routes: ContingencyRoute[]
  reconciliations: ReconciliationItem[]
}

const loading = ref(true)
const error = ref<string | null>(null)
const data = ref<ContingencyData | null>(null)
const toggling = ref(false)

const requestFetch = useRequestFetch()

async function loadData() {
  loading.value = true
  error.value = null
  try {
    const res = await requestFetch('/api/admin/payments/contingency/status')
    data.value = res as ContingencyData
  } catch (err: unknown) {
    const fetchErr = err as { data?: { error?: { code?: string } } }
    error.value = fetchErr?.data?.error?.code ?? 'error_loading_contingency'
  } finally {
    loading.value = false
  }
}

async function handleToggle(route: ContingencyRoute) {
  toggling.value = true
  try {
    const res = await requestFetch('/api/admin/payments/contingency/toggle', {
      method: 'POST',
      body: {
        marketCode: route.marketCode,
        activateContingency: !route.contingencyActive,
        reason: !route.contingencyActive
          ? 'Activación manual de contingencia hacia pasarela alternativa'
          : 'Restauración del proveedor principal',
        expectedVersion: route.version
      }
    })
    const updated = res as ContingencyRoute
    const idx = data.value?.routes.findIndex((r) => r.marketCode === updated.marketCode)
    if (idx !== undefined && idx >= 0 && data.value) {
      data.value.routes[idx] = updated
    }
  } catch (err: unknown) {
    const fetchErr = err as { data?: { error?: { code?: string } } }
    error.value = fetchErr?.data?.error?.code ?? 'error_toggling_contingency'
  } finally {
    toggling.value = false
  }
}

onMounted(() => {
  loadData()
})
</script>

<template>
  <div class="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
    <div class="border-b border-slate-100 pb-4">
      <h3 class="text-lg font-semibold text-slate-900">Pasarelas de Pago y Contingencia</h3>
      <p class="text-sm text-slate-500">
        Enrutamiento por mercado, conmutación por contingencia y conciliación unificada
      </p>
    </div>

    <!-- Loading State -->
    <div v-if="loading" class="py-8 text-center text-sm text-slate-500" aria-live="polite">
      Cargando estado de pasarelas...
    </div>

    <!-- Error State -->
    <div v-else-if="error" class="my-4 rounded-md bg-red-50 p-4 text-sm text-red-700" role="alert">
      Error: {{ error }}
    </div>

    <!-- Content State -->
    <div v-else-if="data" class="mt-4 space-y-6">
      <div class="space-y-4">
        <div
          v-for="route in data.routes"
          :key="route.id"
          class="rounded-md border p-4 transition-colors"
          :class="route.contingencyActive ? 'border-amber-300 bg-amber-50/50' : 'border-slate-200 bg-slate-50/50'"
        >
          <div class="flex items-center justify-between">
            <div>
              <span class="text-base font-semibold text-slate-900">Mercado {{ route.marketCode }}</span>
              <div class="mt-1 flex items-center gap-3 text-xs text-slate-600">
                <span>Principal: {{ route.primaryProvider }}</span>
                <span>Alternativo: {{ route.alternativeProvider }}</span>
                <span class="font-bold text-slate-800">Activo: {{ route.activeProvider }}</span>
              </div>
            </div>

            <button
              data-testid="toggle-contingency-btn"
              type="button"
              :disabled="toggling"
              class="rounded-md px-3 py-1.5 text-xs font-semibold shadow-sm focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:opacity-50"
              :class="
                route.contingencyActive
                  ? 'bg-amber-600 text-white hover:bg-amber-700 focus:ring-amber-500'
                  : 'bg-indigo-600 text-white hover:bg-indigo-700 focus:ring-indigo-500'
              "
              @click="handleToggle(route)"
            >
              {{ route.contingencyActive ? 'Desactivar Contingencia' : 'Activar Contingencia' }}
            </button>
          </div>

          <div v-if="route.contingencyActive" class="mt-3 rounded bg-amber-100 p-2 text-xs text-amber-900">
            <strong>Modo contingencia activo:</strong> {{ route.contingencyReason || 'Sin motivo indicado' }}
          </div>
        </div>
      </div>

      <!-- Unified Reconciliation List -->
      <div v-if="data.reconciliations.length > 0" class="mt-6">
        <h4 class="text-xs font-semibold uppercase tracking-wider text-slate-500">Últimos cobros unificados</h4>
        <div class="mt-2 overflow-x-auto">
          <table class="min-w-full divide-y divide-slate-200 text-left text-xs">
            <thead>
              <tr class="text-slate-500">
                <th class="py-2">Proveedor</th>
                <th class="py-2">Referencia</th>
                <th class="py-2">Importe</th>
                <th class="py-2">Estado</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              <tr v-for="rec in data.reconciliations" :key="rec.id">
                <td class="py-2 font-mono font-medium">{{ rec.provider }}</td>
                <td class="py-2 font-mono">{{ rec.providerReference }}</td>
                <td class="py-2">{{ (rec.amountCents / 100).toFixed(2) }} {{ rec.currency }}</td>
                <td class="py-2 font-semibold capitalize">{{ rec.status }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</template>
