<script setup lang="ts">
import { ref, watch, onMounted } from 'vue'
import type {
  InventoryLot,
  LotTraceabilityResponse,
  AnalyticalMarginReport,
  ForecastModelEvaluation,
  ReorderSuggestion,
  DemandAnomaly
} from '~~/shared/inventory-lots-costing-forecast'

const props = defineProps<{
  scopeKey: string
  enabled: boolean
  pending: boolean
  selectedVariantUuid?: string
  selectedVariantId?: number
}>()

const activeTab = ref<'lotes' | 'costes' | 'forecast'>('lotes')
const loading = ref(false)
const errorMessage = ref('')
const successMessage = ref('')

// Lotes state
const lots = ref<InventoryLot[]>([])
const newLotNumber = ref('')
const newLotExpiry = ref('')
const newLotQuantity = ref<number | ''>('')
const newLotManufactured = ref('')
const newLotReason = ref('')

// Traceability state
const traceQuery = ref('')
const traceabilityResult = ref<LotTraceabilityResponse | null>(null)
const traceLoading = ref(false)

// Costing state
const marginReport = ref<AnalyticalMarginReport | null>(null)
const newCostLayerCents = ref<number | ''>('')
const newCostLayerQuantity = ref<number | ''>('')

// Forecast state
const forecastEvaluation = ref<ForecastModelEvaluation | null>(null)
const suggestions = ref<ReorderSuggestion[]>([])
const anomalies = ref<DemandAnomaly[]>([])

async function loadData() {
  if (!props.enabled || !props.selectedVariantUuid) return
  loading.value = true
  errorMessage.value = ''
  try {
    if (activeTab.value === 'lotes') {
      const res = await $fetch<{ items: InventoryLot[] }>(
        `/api/admin/inventory/lots?variantId=${props.selectedVariantUuid}`
      )
      lots.value = res.items ?? []
    } else if (activeTab.value === 'costes') {
      const res = await $fetch<AnalyticalMarginReport>(
        `/api/admin/inventory/costing/margin?variantId=${props.selectedVariantUuid}`
      )
      marginReport.value = res
    } else if (activeTab.value === 'forecast') {
      const [suggRes, anomRes] = await Promise.all([
        $fetch<{ items: ReorderSuggestion[] }>(
          `/api/admin/inventory/forecast/suggestions?variantId=${props.selectedVariantUuid}`
        ),
        $fetch<{ items: DemandAnomaly[] }>(
          `/api/admin/inventory/forecast/anomalies?variantId=${props.selectedVariantUuid}`
        )
      ])
      suggestions.value = suggRes.items ?? []
      anomalies.value = anomRes.items ?? []
    }
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : 'Error al cargar los datos operativos de inventario.'
  } finally {
    loading.value = false
  }
}

watch([() => props.selectedVariantUuid, activeTab], () => {
  loadData()
})

onMounted(() => {
  loadData()
})

async function submitCreateLot() {
  if (!newLotNumber.value || !newLotExpiry.value || !newLotQuantity.value || !props.selectedVariantUuid) return
  loading.value = true
  errorMessage.value = ''
  successMessage.value = ''
  try {
    const cmdId = crypto.randomUUID()
    const payload = {
      variantId: props.selectedVariantUuid,
      lotNumber: newLotNumber.value.trim(),
      expiresAt: `${newLotExpiry.value}T23:59:59Z`,
      manufacturedAt: newLotManufactured.value ? `${newLotManufactured.value}T00:00:00Z` : undefined,
      initialQuantity: Number(newLotQuantity.value),
      reason: newLotReason.value ? newLotReason.value.trim() : 'Alta de lote en almacén'
    }

    await $fetch('/api/admin/inventory/lots-costing/commands', {
      method: 'POST',
      headers: {
        'Idempotency-Key': cmdId,
        'Content-Type': 'application/json'
      },
      body: {
        action: 'create_lot',
        targetId: cmdId,
        input: payload
      }
    })

    successMessage.value = `Lote ${newLotNumber.value} registrado con éxito.`
    newLotNumber.value = ''
    newLotExpiry.value = ''
    newLotQuantity.value = ''
    newLotManufactured.value = ''
    newLotReason.value = ''
    await loadData()
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : 'No se pudo crear el lote.'
  } finally {
    loading.value = false
  }
}

async function quarantineLot(lot: InventoryLot) {
  if (!confirm(`¿Poner en cuarentena el lote ${lot.lotNumber}? No podrá ser asignado mediante FEFO.`)) return
  loading.value = true
  errorMessage.value = ''
  try {
    const cmdId = crypto.randomUUID()
    await $fetch('/api/admin/inventory/lots-costing/commands', {
      method: 'POST',
      headers: {
        'Idempotency-Key': cmdId,
        'Content-Type': 'application/json'
      },
      body: {
        action: 'quarantine_lot',
        targetId: lot.id,
        input: {
          expectedVersion: lot.version,
          reason: 'Puesta en cuarentena preventiva por operador'
        }
      }
    })
    successMessage.value = `Lote ${lot.lotNumber} puesto en cuarentena.`
    await loadData()
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : 'Error al poner lote en cuarentena.'
  } finally {
    loading.value = false
  }
}

async function searchTraceability() {
  if (!traceQuery.value.trim()) return
  traceLoading.value = true
  errorMessage.value = ''
  try {
    const q = traceQuery.value.trim()
    const param = q.includes('-') && q.length === 36 ? `orderId=${q}` : `lotNumber=${encodeURIComponent(q)}`
    traceabilityResult.value = await $fetch<LotTraceabilityResponse>(`/api/admin/inventory/lots/traceability?${param}`)
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : 'Error al buscar trazabilidad.'
  } finally {
    traceLoading.value = false
  }
}

async function submitRecordCostLayer() {
  if (!newCostLayerCents.value || !newCostLayerQuantity.value || !props.selectedVariantUuid) return
  loading.value = true
  errorMessage.value = ''
  try {
    const cmdId = crypto.randomUUID()
    await $fetch('/api/admin/inventory/lots-costing/commands', {
      method: 'POST',
      headers: {
        'Idempotency-Key': cmdId,
        'Content-Type': 'application/json'
      },
      body: {
        action: 'record_cost_layer',
        targetId: cmdId,
        input: {
          variantId: props.selectedVariantUuid,
          unitCostCents: Number(newCostLayerCents.value),
          quantity: Number(newCostLayerQuantity.value),
          reason: 'Entrada de mercancía con coste'
        }
      }
    })
    successMessage.value = 'Capa de coste registrada.'
    newCostLayerCents.value = ''
    newCostLayerQuantity.value = ''
    await loadData()
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : 'Error al registrar capa de coste.'
  } finally {
    loading.value = false
  }
}

async function evaluateForecast() {
  if (!props.selectedVariantUuid) return
  loading.value = true
  errorMessage.value = ''
  try {
    forecastEvaluation.value = await $fetch<ForecastModelEvaluation>('/api/admin/inventory/forecast/evaluate', {
      method: 'POST',
      body: {
        variantId: props.selectedVariantUuid,
        leadTimeDays: 7,
        historyDays: 14
      }
    })
    successMessage.value = 'Previsión de demanda evaluada con éxito.'
    await loadData()
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : 'Error al evaluar previsión de demanda.'
  } finally {
    loading.value = false
  }
}

async function reviewSuggestion(suggestionId: string, action: 'review' | 'dismiss') {
  loading.value = true
  errorMessage.value = ''
  try {
    const cmdId = crypto.randomUUID()
    await $fetch('/api/admin/inventory/lots-costing/commands', {
      method: 'POST',
      headers: {
        'Idempotency-Key': cmdId,
        'Content-Type': 'application/json'
      },
      body: {
        action: 'review_suggestion',
        targetId: suggestionId,
        input: {
          suggestionId,
          action,
          reason: `Sugerencia ${action === 'review' ? 'revisada y aceptada' : 'descartada'} por operador`
        }
      }
    })
    await loadData()
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : 'Error al actualizar sugerencia.'
  } finally {
    loading.value = false
  }
}

async function ackAnomaly(anomalyId: string) {
  loading.value = true
  errorMessage.value = ''
  try {
    const cmdId = crypto.randomUUID()
    await $fetch('/api/admin/inventory/lots-costing/commands', {
      method: 'POST',
      headers: {
        'Idempotency-Key': cmdId,
        'Content-Type': 'application/json'
      },
      body: {
        action: 'ack_anomaly',
        targetId: anomalyId,
        input: {
          anomalyId,
          reason: 'Anomalía de demanda verificada por operador'
        }
      }
    })
    await loadData()
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : 'Error al reconocer anomalía.'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <section
    class="mt-6 rounded-lg border border-slate-200 bg-white p-5 shadow-sm"
    aria-label="Gestión avanzada de lotes, costes y previsión de inventario"
  >
    <header class="border-b border-slate-200 pb-4">
      <h2 class="text-lg font-semibold text-slate-900">Control Avanzado de Inventario (INV-019, INV-021, INV-022)</h2>
      <p class="mt-1 text-sm text-slate-600">
        Gestión de lotes y FEFO con trazabilidad integral, valoración contable FIFO/PMP con reconciliación de margen, y
        modelo de previsión con sugerencias no destructivas.
      </p>

      <!-- Tabs Navigation -->
      <nav class="mt-4 flex gap-2" role="tablist" aria-label="Secciones de inventario avanzado">
        <button
          type="button"
          role="tab"
          :aria-selected="activeTab === 'lotes'"
          :class="[
            'px-3 py-1.5 text-sm font-medium rounded-md transition-colors',
            activeTab === 'lotes'
              ? 'bg-blue-600 text-white shadow-sm'
              : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
          ]"
          @click="activeTab = 'lotes'"
        >
          Lotes y FEFO (INV-019)
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="activeTab === 'costes'"
          :class="[
            'px-3 py-1.5 text-sm font-medium rounded-md transition-colors',
            activeTab === 'costes'
              ? 'bg-blue-600 text-white shadow-sm'
              : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
          ]"
          @click="activeTab = 'costes'"
        >
          Costes y Margen (INV-021)
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="activeTab === 'forecast'"
          :class="[
            'px-3 py-1.5 text-sm font-medium rounded-md transition-colors',
            activeTab === 'forecast'
              ? 'bg-blue-600 text-white shadow-sm'
              : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
          ]"
          @click="activeTab = 'forecast'"
        >
          Previsión y Anomalías (INV-022)
        </button>
      </nav>
    </header>

    <!-- Feedback messages -->
    <div v-if="errorMessage" class="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-800" role="alert">
      {{ errorMessage }}
    </div>
    <div v-if="successMessage" class="mt-4 rounded-md bg-emerald-50 p-3 text-sm text-emerald-800" role="status">
      {{ successMessage }}
    </div>

    <!-- TAB 1: LOTES Y FEFO -->
    <div v-if="activeTab === 'lotes'" class="mt-5 space-y-6">
      <div>
        <h3 class="text-sm font-semibold uppercase tracking-wider text-slate-700">
          Lotes Activos y Política FEFO (First Expired, First Out)
        </h3>
        <p class="mt-1 text-xs text-slate-500">
          Los lotes se consumen y reservan estrictamente en orden de caducidad más cercana. Los lotes vencidos o en
          cuarentena son excluidos automáticamente de la venta.
        </p>

        <div v-if="loading && !lots.length" class="mt-4 text-sm text-slate-500" role="status">Cargando lotes...</div>

        <div
          v-else-if="!lots.length"
          class="mt-4 rounded border border-dashed border-slate-300 p-4 text-center text-sm text-slate-500"
        >
          No hay lotes registrados para esta variante.
        </div>

        <div v-else class="mt-3 overflow-x-auto">
          <table class="min-w-full divide-y divide-slate-200 text-left text-xs">
            <thead class="bg-slate-50 text-slate-600 font-semibold">
              <tr>
                <th class="px-3 py-2">Nº Lote</th>
                <th class="px-3 py-2">Caducidad</th>
                <th class="px-3 py-2">Disponible</th>
                <th class="px-3 py-2">Inicial</th>
                <th class="px-3 py-2">Estado</th>
                <th class="px-3 py-2 text-right">Acciones</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              <tr v-for="lot in lots" :key="lot.id" :class="lot.status === 'quarantined' ? 'bg-amber-50/50' : ''">
                <td class="px-3 py-2 font-mono font-medium text-slate-900">{{ lot.lotNumber }}</td>
                <td class="px-3 py-2">{{ lot.expiresAt ? lot.expiresAt.substring(0, 10) : '-' }}</td>
                <td class="px-3 py-2 font-bold">{{ lot.availableQuantity }}</td>
                <td class="px-3 py-2 text-slate-500">{{ lot.initialQuantity }}</td>
                <td class="px-3 py-2">
                  <span
                    :class="[
                      'inline-block px-2 py-0.5 rounded text-[11px] font-medium',
                      lot.status === 'active'
                        ? 'bg-emerald-100 text-emerald-800'
                        : lot.status === 'quarantined'
                          ? 'bg-amber-100 text-amber-800'
                          : lot.status === 'depleted'
                            ? 'bg-slate-100 text-slate-600'
                            : 'bg-red-100 text-red-800'
                    ]"
                  >
                    {{ lot.status }}
                  </span>
                </td>
                <td class="px-3 py-2 text-right">
                  <button
                    v-if="lot.status === 'active'"
                    type="button"
                    class="rounded bg-amber-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-amber-700"
                    @click="quarantineLot(lot)"
                  >
                    Cuarentena
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Form: Crear Nuevo Lote -->
      <div class="rounded border border-slate-200 bg-slate-50/60 p-4">
        <h4 class="text-xs font-semibold uppercase tracking-wider text-slate-800">
          Registrar Nuevo Lote de Fabricación
        </h4>
        <form class="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-4" @submit.prevent="submitCreateLot">
          <div>
            <label class="block text-xs font-medium text-slate-700">Nº de Lote</label>
            <input
              v-model="newLotNumber"
              type="text"
              required
              placeholder="p. ej. L-2026-X1"
              class="mt-1 block w-full rounded border border-slate-300 px-2 py-1 text-xs"
            />
          </div>
          <div>
            <label class="block text-xs font-medium text-slate-700">Fecha Caducidad</label>
            <input
              v-model="newLotExpiry"
              type="date"
              required
              class="mt-1 block w-full rounded border border-slate-300 px-2 py-1 text-xs"
            />
          </div>
          <div>
            <label class="block text-xs font-medium text-slate-700">Cantidad Inicial</label>
            <input
              v-model.number="newLotQuantity"
              type="number"
              min="1"
              required
              placeholder="Unidades"
              class="mt-1 block w-full rounded border border-slate-300 px-2 py-1 text-xs"
            />
          </div>
          <div class="flex items-end">
            <button
              type="submit"
              :disabled="loading"
              class="w-full rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              Guardar Lote
            </button>
          </div>
        </form>
      </div>

      <!-- Trazabilidad a Pedido / Cliente -->
      <div class="rounded border border-slate-200 p-4">
        <h4 class="text-xs font-semibold uppercase tracking-wider text-slate-800">
          Trazabilidad Bidireccional (Lote ⇄ Pedido ⇄ Cliente)
        </h4>
        <p class="mt-1 text-xs text-slate-500">
          Introduce un número de lote para auditar clientes y pedidos que lo han recibido, o un ID de pedido para ver
          los lotes suministrados.
        </p>
        <div class="mt-3 flex gap-2">
          <input
            v-model="traceQuery"
            type="text"
            placeholder="Nº de lote"
            class="flex-1 rounded border border-slate-300 px-3 py-1.5 text-xs"
          />
          <button
            type="button"
            data-testid="search-traceability"
            :disabled="traceLoading"
            class="rounded bg-slate-800 px-4 py-1.5 text-xs font-medium text-white hover:bg-slate-900 disabled:opacity-50"
            @click="searchTraceability"
          >
            Buscar Trazabilidad
          </button>
        </div>

        <div v-if="traceabilityResult" class="mt-3">
          <div v-if="!traceabilityResult.records.length" class="text-xs text-slate-500">
            No se han encontrado registros de expedición o asignación para esta consulta.
          </div>
          <table v-else class="min-w-full divide-y divide-slate-200 text-left text-xs">
            <thead class="bg-slate-50 text-slate-600 font-semibold">
              <tr>
                <th class="px-2 py-1.5">Lote</th>
                <th class="px-2 py-1.5">Pedido ID</th>
                <th class="px-2 py-1.5">Cliente</th>
                <th class="px-2 py-1.5">Cantidad</th>
                <th class="px-2 py-1.5">Fecha Asignación</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              <tr v-for="rec in traceabilityResult.records" :key="rec.allocationId">
                <td class="px-2 py-1.5 font-mono font-medium">{{ rec.lotNumber }}</td>
                <td class="px-2 py-1.5 font-mono text-slate-600">{{ rec.orderId }}</td>
                <td class="px-2 py-1.5 text-slate-800">{{ rec.customerEmail || rec.customerId || 'Invitado' }}</td>
                <td class="px-2 py-1.5 font-bold">{{ rec.quantity }} ud.</td>
                <td class="px-2 py-1.5 text-slate-500">{{ rec.allocatedAt.substring(0, 19).replace('T', ' ') }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- TAB 2: COSTES Y MARGEN ANALÍTICO -->
    <div v-if="activeTab === 'costes'" class="mt-5 space-y-6">
      <div>
        <h3 class="text-sm font-semibold uppercase tracking-wider text-slate-700">
          Valoración de Existencias y Margen Analítico (INV-021)
        </h3>
        <p class="mt-1 text-xs text-slate-500">
          Cálculo analítico del Coste de Ventas (COGS) bajo métodos contables formalizados (Precio Medio Ponderado /
          FIFO) y reconciliación estricta con facturación.
        </p>

        <!-- KPI Cards -->
        <div v-if="marginReport" class="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div class="rounded border border-slate-200 bg-slate-50 p-3">
            <div class="text-[11px] font-medium text-slate-500">Ingresos Netos</div>
            <div class="mt-1 text-base font-bold text-slate-900">
              {{ (marginReport.totalRevenueNetCents / 100).toFixed(2) }} €
            </div>
          </div>
          <div class="rounded border border-slate-200 bg-slate-50 p-3">
            <div class="text-[11px] font-medium text-slate-500">Coste de Ventas (COGS)</div>
            <div class="mt-1 text-base font-bold text-slate-900">
              {{ (marginReport.totalCogsCents / 100).toFixed(2) }} €
            </div>
          </div>
          <div class="rounded border border-slate-200 bg-slate-50 p-3">
            <div class="text-[11px] font-medium text-slate-500">Margen analítico bruto</div>
            <div class="mt-1 text-base font-bold text-emerald-600">
              {{ (marginReport.analyticalGrossMarginCents / 100).toFixed(2) }} €
            </div>
          </div>
          <div class="rounded border border-slate-200 bg-slate-50 p-3">
            <div class="text-[11px] font-medium text-slate-500">% Margen s/ Venta</div>
            <div class="mt-1 text-base font-bold text-emerald-600">
              {{ (marginReport.analyticalGrossMarginBasisPoints / 100).toFixed(1) }} %
            </div>
          </div>
        </div>

        <!-- Reconciliation Status Banner -->
        <div
          v-if="marginReport"
          class="mt-4 rounded-md border p-3 text-xs"
          :class="
            marginReport.reconciliationStatus === 'reconciled'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
              : 'border-amber-200 bg-amber-50 text-amber-900'
          "
        >
          <span class="font-semibold">
            {{
              marginReport.reconciliationStatus === 'reconciled'
                ? 'Conciliado con fuente financiera'
                : 'Discrepancia en conciliación'
            }}:
          </span>
          La facturación de pedidos coincide exactamente con el total consumido (Discrepancia:
          {{ marginReport.discrepancyCents }} céntimos).
        </div>
      </div>

      <!-- Form: Registrar entrada con coste -->
      <div class="rounded border border-slate-200 bg-slate-50/60 p-4">
        <h4 class="text-xs font-semibold uppercase tracking-wider text-slate-800">
          Registrar Capa de Coste de Entrada (FIFO / PMP)
        </h4>
        <form class="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3" @submit.prevent="submitRecordCostLayer">
          <div>
            <label class="block text-xs font-medium text-slate-700">Coste Unitario (céntimos EUR)</label>
            <input
              v-model.number="newCostLayerCents"
              type="number"
              min="0"
              required
              placeholder="p. ej. 450 (4.50€)"
              class="mt-1 block w-full rounded border border-slate-300 px-2 py-1 text-xs"
            />
          </div>
          <div>
            <label class="block text-xs font-medium text-slate-700">Cantidad</label>
            <input
              v-model.number="newCostLayerQuantity"
              type="number"
              min="1"
              required
              placeholder="Unidades"
              class="mt-1 block w-full rounded border border-slate-300 px-2 py-1 text-xs"
            />
          </div>
          <div class="flex items-end">
            <button
              type="submit"
              :disabled="loading"
              class="w-full rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              Registrar Capa de Coste
            </button>
          </div>
        </form>
      </div>
    </div>

    <!-- TAB 3: FORECAST Y ANOMALÍAS -->
    <div v-if="activeTab === 'forecast'" class="mt-5 space-y-6">
      <div>
        <div class="flex items-center justify-between">
          <div>
            <h3 class="text-sm font-semibold uppercase tracking-wider text-slate-700">
              Previsión de Demanda y Detección de Anomalías (INV-022)
            </h3>
            <p class="mt-1 text-xs text-slate-500">
              Evaluación predictiva frente a baseline (Media Móvil Simple vs Suavizado Exponencial). Genera sugerencias
              de reaprovisionamiento bajo control humano estricto.
            </p>
          </div>
          <button
            type="button"
            :disabled="loading"
            class="rounded bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            @click="evaluateForecast"
          >
            Evaluar Modelo vs Baseline
          </button>
        </div>

        <!-- Evaluation Results Card -->
        <div v-if="forecastEvaluation" class="mt-4 rounded border border-indigo-100 bg-indigo-50/40 p-4 text-xs">
          <div class="font-semibold text-indigo-950">
            Comparativa de Precisión: Modelo Avanzado vs Baseline Naive/SMA
          </div>
          <div class="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div>
              <span class="text-slate-500">Error Baseline (SMA MAE):</span>
              <div class="font-mono font-bold text-slate-900">{{ forecastEvaluation.baselineMae }}</div>
            </div>
            <div>
              <span class="text-slate-500">Error Suavizado (Exp MAE):</span>
              <div class="font-mono font-bold text-slate-900">{{ forecastEvaluation.advancedMae }}</div>
            </div>
            <div>
              <span class="text-slate-500">Mejora de Precisión:</span>
              <div class="font-mono font-bold text-emerald-700">+{{ forecastEvaluation.maeImprovementPercent }}%</div>
            </div>
            <div>
              <span class="text-slate-500">Demanda Diaria Prevista:</span>
              <div class="font-mono font-bold text-slate-900">{{ forecastEvaluation.forecastDailyDemand }} ud/día</div>
            </div>
          </div>
        </div>
      </div>

      <!-- Reorder Suggestions (Non-destructive) -->
      <div>
        <h4 class="text-xs font-semibold uppercase tracking-wider text-slate-800">
          Sugerencias de reabastecimiento (Sugerencia humana, no automática)
        </h4>
        <p class="mt-1 text-xs text-slate-500">
          Conforme al criterio de aceptación, estas recomendaciones son de carácter consultivo: ninguna orden de compra
          ni mutación de balance se ejecuta automáticamente.
        </p>

        <div
          v-if="!suggestions.length"
          class="mt-3 rounded border border-dashed border-slate-300 p-3 text-center text-xs text-slate-500"
        >
          No hay sugerencias pendientes de reabastecimiento para esta variante.
        </div>

        <div v-else class="mt-3 space-y-2">
          <div
            v-for="sugg in suggestions"
            :key="sugg.id"
            class="flex items-center justify-between rounded border border-slate-200 bg-slate-50 p-3 text-xs"
          >
            <div>
              <div class="font-semibold text-slate-900">Sugerencia: Pedir {{ sugg.suggestedQuantity }} unidades</div>
              <div class="text-slate-600">{{ sugg.reason }}</div>
              <div class="mt-1 text-[11px] text-slate-400">
                Stock actual: {{ sugg.currentPhysicalStock }} | Stock seg.: {{ sugg.safetyStock }} | Plazo:
                {{ sugg.leadTimeDays }}d | Estado: {{ sugg.status }}
              </div>
            </div>
            <div v-if="sugg.status === 'suggested'" class="flex gap-2">
              <button
                type="button"
                class="rounded bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-700"
                @click="reviewSuggestion(sugg.id, 'review')"
              >
                Aceptar
              </button>
              <button
                type="button"
                class="rounded bg-slate-200 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-300"
                @click="reviewSuggestion(sugg.id, 'dismiss')"
              >
                Descartar
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Demand Anomalies -->
      <div>
        <h4 class="text-xs font-semibold uppercase tracking-wider text-slate-800">Anomalías de demanda detectadas</h4>
        <p class="mt-1 text-xs text-slate-500">
          Detección estadística mediante Z-score de picos atípicos o caídas abruptas en la demanda observada.
        </p>

        <div
          v-if="!anomalies.length"
          class="mt-3 rounded border border-dashed border-slate-300 p-3 text-center text-xs text-slate-500"
        >
          No se han detectado anomalías de demanda para esta variante.
        </div>

        <div v-else class="mt-3 space-y-2">
          <div
            v-for="anom in anomalies"
            :key="anom.id"
            class="flex items-center justify-between rounded border border-amber-200 bg-amber-50/40 p-3 text-xs"
          >
            <div>
              <div class="flex items-center gap-2">
                <span
                  :class="[
                    'px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider',
                    anom.severity === 'critical' ? 'bg-red-600 text-white' : 'bg-amber-500 text-white'
                  ]"
                >
                  {{ anom.kind === 'spike' ? 'Pico Inusual' : 'Caída Abrupta' }} ({{ anom.severity }})
                </span>
                <span class="font-mono text-slate-700">Z-Score: {{ anom.zScore }}</span>
              </div>
              <div class="mt-1 text-slate-700">
                Observadas: <strong>{{ anom.observedUnits }}</strong> ud. (Esperadas: {{ anom.expectedUnits }} ud.)
              </div>
            </div>
            <button
              v-if="anom.status === 'open'"
              type="button"
              class="rounded bg-slate-800 px-2.5 py-1 text-xs font-medium text-white hover:bg-slate-900"
              @click="ackAnomaly(anom.id)"
            >
              Reconocer
            </button>
            <span v-else class="text-[11px] font-medium text-slate-500">Reconocida</span>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
