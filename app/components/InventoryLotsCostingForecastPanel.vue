<script setup lang="ts">
import { computed, ref, watch, onMounted } from 'vue'
import type { AdminTone } from '~/utils/adminLabels'
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
const sectionTabs = [
  { value: 'lotes', label: 'Lotes y caducidades' },
  { value: 'costes', label: 'Costes y margen' },
  { value: 'forecast', label: 'Previsión y anomalías' }
] as const
const lotColumns = [
  { key: 'lotNumber', label: 'Nº de lote' },
  { key: 'expiresAt', label: 'Caducidad' },
  { key: 'availableQuantity', label: 'Disponible', numeric: true },
  { key: 'initialQuantity', label: 'Recibido', numeric: true, hideOnMobile: true },
  { key: 'status', label: 'Estado' }
]
const lotStatusLabels: Record<string, string> = {
  active: 'Activo',
  quarantined: 'En cuarentena',
  depleted: 'Agotado',
  expired: 'Caducado'
}
const lotStatusTones: Record<string, AdminTone> = {
  active: 'success',
  quarantined: 'warning',
  depleted: 'neutral',
  expired: 'danger'
}
const suggestionStatusLabels: Record<string, string> = {
  suggested: 'Pendiente',
  reviewed: 'Aceptada',
  dismissed: 'Descartada',
  ordered: 'Pedida'
}
// Estado de interfaz: paneles laterales y confirmación de cuarentena.
const lotDrawer = ref(false)
const costDrawer = ref(false)
const lotToQuarantine = ref<InventoryLot | null>(null)
const quarantineOpen = computed({
  get: () => lotToQuarantine.value !== null,
  set: (value: boolean) => {
    if (!value) lotToQuarantine.value = null
  }
})
function confirmQuarantine() {
  const lot = lotToQuarantine.value
  lotToQuarantine.value = null
  if (lot) void quarantineLot(lot)
}
const loading = ref(false)
const errorMessage = ref('')
const successMessage = ref('')
watch(successMessage, (value) => {
  if (value) lotDrawer.value = costDrawer.value = false
})

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
// El coste se teclea en euros; se convierte a céntimos al enviar.
const newCostLayerEuros = ref('')
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
  } catch {
    errorMessage.value = 'No hemos podido cargar los datos de este producto. Vuelve a intentarlo.'
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

    successMessage.value = `Lote ${newLotNumber.value} guardado.`
    newLotNumber.value = ''
    newLotExpiry.value = ''
    newLotQuantity.value = ''
    newLotManufactured.value = ''
    newLotReason.value = ''
    await loadData()
  } catch {
    errorMessage.value = 'No hemos podido guardar el lote. Revisa los datos y vuelve a intentarlo.'
  } finally {
    loading.value = false
  }
}

async function quarantineLot(lot: InventoryLot) {
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
  } catch {
    errorMessage.value = 'No hemos podido poner el lote en cuarentena. Vuelve a intentarlo.'
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
  } catch {
    errorMessage.value = 'No hemos podido buscar ese lote. Vuelve a intentarlo.'
  } finally {
    traceLoading.value = false
  }
}

async function submitRecordCostLayer() {
  if (!newCostLayerQuantity.value || !props.selectedVariantUuid) return
  const unitCostCents = adminEurosToCents(newCostLayerEuros.value)
  if (!unitCostCents) {
    errorMessage.value = 'Revisa el coste por unidad: escribe un importe en euros mayor que cero, como 4,50.'
    return
  }
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
          unitCostCents,
          quantity: Number(newCostLayerQuantity.value),
          reason: 'Entrada de mercancía con coste'
        }
      }
    })
    successMessage.value = 'Coste de entrada guardado.'
    newCostLayerEuros.value = ''
    newCostLayerQuantity.value = ''
    await loadData()
  } catch {
    errorMessage.value = 'No hemos podido guardar el coste. Revisa los datos y vuelve a intentarlo.'
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
    successMessage.value = 'Previsión calculada.'
    await loadData()
  } catch {
    errorMessage.value = 'No hemos podido calcular la previsión. Vuelve a intentarlo.'
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
  } catch {
    errorMessage.value = 'No hemos podido actualizar la sugerencia. Vuelve a intentarlo.'
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
  } catch {
    errorMessage.value = 'No hemos podido marcar la anomalía como revisada. Vuelve a intentarlo.'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <section class="adm-stack min-w-0" aria-label="Gestión avanzada de lotes, costes y previsión de inventario">
    <nav class="flex flex-wrap gap-2" role="tablist" aria-label="Secciones de inventario avanzado">
      <button
        v-for="entry in sectionTabs"
        :key="entry.value"
        type="button"
        role="tab"
        class="adm-chip"
        :aria-selected="activeTab === entry.value"
        :data-active="activeTab === entry.value || undefined"
        @click="activeTab = entry.value"
      >
        {{ entry.label }}
      </button>
    </nav>

    <UAlert
      v-if="errorMessage"
      role="alert"
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="errorMessage"
      :actions="[{ label: 'Recargar datos', color: 'neutral', variant: 'outline', onClick: () => void loadData() }]"
    />
    <UAlert
      v-if="successMessage"
      role="status"
      color="success"
      variant="subtle"
      icon="i-lucide-circle-check"
      :title="successMessage"
    />

    <!-- Lotes -->
    <div v-if="activeTab === 'lotes'" class="adm-stack">
      <AdminTable
        :rows="lots"
        :columns="lotColumns"
        :row-key="(lot) => lot.id"
        :status="loading && !lots.length ? 'pending' : 'idle'"
        empty-icon="i-lucide-boxes"
        empty-title="No hay lotes registrados para esta variante."
        empty-description="Registra el primer lote para controlar caducidades. Siempre se vende antes el lote que caduca primero."
        caption="Lotes del producto"
      >
        <template #toolbar>
          <div class="adm-toolbar">
            <p class="adm-help">
              Se vende primero el lote que caduca antes. Los lotes caducados o en cuarentena no se venden.
            </p>
            <div class="adm-toolbar__end">
              <AdminButton size="sm" icon="i-lucide-plus" @click="lotDrawer = true">Nuevo lote</AdminButton>
            </div>
          </div>
        </template>
        <template #cell-lotNumber="{ row }">
          <span class="font-semibold text-[var(--text-strong)]">{{ row.lotNumber }}</span>
        </template>
        <template #cell-expiresAt="{ row }">{{ row.expiresAt ? adminDate(row.expiresAt) : '—' }}</template>
        <template #cell-status="{ row }">
          <AdminBadge :tone="lotStatusTones[row.status] ?? 'neutral'">
            {{ lotStatusLabels[row.status] ?? adminHumanize(row.status) }}
          </AdminBadge>
        </template>
        <template #actions="{ row }">
          <AdminButton v-if="row.status === 'active'" size="sm" :disabled="loading" @click="lotToQuarantine = row">
            Poner en cuarentena
          </AdminButton>
        </template>
        <template #empty-action>
          <AdminButton icon="i-lucide-plus" @click="lotDrawer = true">Nuevo lote</AdminButton>
        </template>
      </AdminTable>

      <AdminCard
        title="¿Quién recibió un lote?"
        description="Escribe el número de lote para ver los pedidos y clientes a los que se envió."
        flush
      >
        <form class="adm-toolbar px-5 py-4" role="search" @submit.prevent="searchTraceability">
          <label class="adm-toolbar__search">
            <span class="sr-only">Número de lote</span>
            <UIcon name="i-lucide-search" class="size-4" />
            <input v-model="traceQuery" type="text" data-slot="adm-search" placeholder="Nº de lote" />
          </label>
          <button
            type="button"
            data-testid="search-traceability"
            class="adm-btn adm-btn--secondary"
            :disabled="traceLoading"
            @click="searchTraceability"
          >
            Buscar
          </button>
        </form>
        <template v-if="traceabilityResult">
          <AdminEmptyState
            v-if="!traceabilityResult.records.length"
            compact
            variant="filtered"
            title="Este lote no se ha enviado en ningún pedido"
            description="Comprueba que el número de lote está bien escrito."
          />
          <div v-else class="adm-table-wrap border-t border-[var(--border)]">
            <table class="adm-table">
              <thead>
                <tr>
                  <th scope="col">Lote</th>
                  <th scope="col">Pedido</th>
                  <th scope="col">Cliente</th>
                  <th scope="col" data-numeric>Unidades</th>
                  <th scope="col">Fecha</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="rec in traceabilityResult.records" :key="rec.allocationId">
                  <td class="font-semibold">{{ rec.lotNumber }}</td>
                  <td :title="rec.orderId">#{{ rec.orderId.slice(0, 8).toUpperCase() }}</td>
                  <td class="break-words">{{ rec.customerEmail || rec.customerId || 'Invitado' }}</td>
                  <td data-numeric>{{ rec.quantity }}</td>
                  <td>{{ adminDate(rec.allocatedAt, true) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
      </AdminCard>
    </div>

    <!-- Costes y margen -->
    <div v-if="activeTab === 'costes'" class="adm-stack">
      <div v-if="marginReport" class="adm-grid">
        <AdminStat label="Ingresos netos" :value="adminMoney(marginReport.totalRevenueNetCents)" />
        <AdminStat label="Coste de lo vendido" :value="adminMoney(marginReport.totalCogsCents)" />
        <AdminStat label="Margen analítico bruto" :value="adminMoney(marginReport.analyticalGrossMarginCents)" />
        <AdminStat
          label="Margen sobre venta"
          :value="`${(marginReport.analyticalGrossMarginBasisPoints / 100).toLocaleString('es-ES', { maximumFractionDigits: 1 })} %`"
        />
      </div>
      <UAlert
        v-if="marginReport"
        :color="marginReport.reconciliationStatus === 'reconciled' ? 'success' : 'warning'"
        variant="subtle"
        :icon="marginReport.reconciliationStatus === 'reconciled' ? 'i-lucide-circle-check' : 'i-lucide-triangle-alert'"
        :title="
          marginReport.reconciliationStatus === 'reconciled'
            ? 'Conciliado con fuente financiera: los costes cuadran con lo facturado'
            : 'Los costes no cuadran con lo facturado'
        "
        :description="
          marginReport.reconciliationStatus === 'reconciled'
            ? undefined
            : `Diferencia: ${adminMoney(marginReport.discrepancyCents)}. Revisa los costes de entrada registrados.`
        "
      />
      <AdminCard
        title="Coste de compra"
        description="Cada vez que entra mercancía, apunta cuánto te costó cada unidad. Con eso se calcula el margen."
      >
        <template #actions>
          <AdminButton size="sm" icon="i-lucide-plus" @click="costDrawer = true"
            >Registrar coste de entrada</AdminButton
          >
        </template>
        <p v-if="!marginReport" class="adm-help">Todavía no hay ventas ni costes con los que calcular el margen.</p>
        <p v-else class="adm-help">Las cifras de arriba se actualizan al registrar un coste nuevo.</p>
      </AdminCard>
    </div>

    <!-- Previsión -->
    <div v-if="activeTab === 'forecast'" class="adm-stack">
      <AdminCard
        title="Previsión de ventas"
        description="Calcula cuántas unidades se venderán al día según el histórico de este producto."
      >
        <template #actions>
          <AdminButton size="sm" icon="i-lucide-line-chart" :disabled="loading" @click="evaluateForecast">
            Calcular previsión
          </AdminButton>
        </template>
        <dl v-if="forecastEvaluation" class="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <div>
            <dt class="adm-help">Demanda diaria prevista</dt>
            <dd class="font-semibold text-[var(--text-strong)]">{{ forecastEvaluation.forecastDailyDemand }} ud/día</dd>
          </div>
          <div>
            <dt class="adm-help">Mejora frente al método simple</dt>
            <dd class="font-semibold text-[var(--text-strong)]">+{{ forecastEvaluation.maeImprovementPercent }} %</dd>
          </div>
          <div>
            <dt class="adm-help">Error del método simple</dt>
            <dd class="font-semibold text-[var(--text-strong)]">{{ forecastEvaluation.baselineMae }}</dd>
          </div>
          <div>
            <dt class="adm-help">Error del método avanzado</dt>
            <dd class="font-semibold text-[var(--text-strong)]">{{ forecastEvaluation.advancedMae }}</dd>
          </div>
        </dl>
        <p v-else class="adm-help">Pulsa «Calcular previsión» para ver la estimación.</p>
      </AdminCard>

      <AdminCard
        title="Sugerencias de reabastecimiento"
        description="Son solo recomendaciones: la compra es siempre manual, no automática."
        flush
      >
        <AdminEmptyState
          v-if="!suggestions.length"
          compact
          icon="i-lucide-package-check"
          title="No hay sugerencias pendientes"
          description="Cuando el stock previsto no cubra la demanda, verás aquí cuánto conviene pedir."
        />
        <ul v-else class="adm-list">
          <li v-for="sugg in suggestions" :key="sugg.id">
            <div class="min-w-0 flex-1">
              <p class="adm-list__title">
                Pedir {{ sugg.suggestedQuantity }} unidades
                <AdminBadge :tone="sugg.status === 'suggested' ? 'warning' : 'neutral'" plain>
                  {{ suggestionStatusLabels[sugg.status] ?? adminHumanize(sugg.status) }}
                </AdminBadge>
              </p>
              <p class="break-words">{{ sugg.reason }}</p>
              <p class="adm-help">
                Stock actual: {{ sugg.currentPhysicalStock }} · stock mínimo: {{ sugg.safetyStock }} · plazo de entrega:
                {{ sugg.leadTimeDays }} días
              </p>
            </div>
            <template v-if="sugg.status === 'suggested'">
              <AdminButton size="sm" @click="reviewSuggestion(sugg.id, 'dismiss')">Descartar</AdminButton>
              <AdminButton size="sm" variant="primary" @click="reviewSuggestion(sugg.id, 'review')">
                Aceptar
              </AdminButton>
            </template>
          </li>
        </ul>
      </AdminCard>

      <AdminCard
        title="Anomalías de demanda detectadas"
        description="Días con ventas muy por encima o muy por debajo de lo habitual."
        flush
      >
        <AdminEmptyState
          v-if="!anomalies.length"
          compact
          icon="i-lucide-activity"
          title="Sin anomalías"
          description="Las ventas de este producto siguen su ritmo habitual."
        />
        <ul v-else class="adm-list">
          <li v-for="anom in anomalies" :key="anom.id">
            <div class="min-w-0 flex-1">
              <p class="adm-list__title">
                {{ anom.kind === 'spike' ? 'Pico de ventas' : 'Caída de ventas' }}
                <AdminBadge :tone="anom.severity === 'critical' ? 'danger' : 'warning'">
                  {{ anom.severity === 'critical' ? 'Grave' : 'Moderada' }}
                </AdminBadge>
              </p>
              <p class="adm-help">
                Vendidas: {{ anom.observedUnits }} unidades · lo habitual: {{ anom.expectedUnits }} unidades
              </p>
            </div>
            <AdminButton v-if="anom.status === 'open'" size="sm" @click="ackAnomaly(anom.id)">
              Marcar como revisada
            </AdminButton>
            <AdminBadge v-else tone="neutral" plain>Revisada</AdminBadge>
          </li>
        </ul>
      </AdminCard>
    </div>

    <AdminDrawer v-model:open="lotDrawer" title="Nuevo lote" description="Registra un lote recibido y su caducidad.">
      <form id="inventory-new-lot" class="adm-stack" @submit.prevent="submitCreateLot">
        <UAlert v-if="errorMessage" role="alert" color="error" variant="subtle" :title="errorMessage" />
        <AdminFormField v-slot="{ id }" label="Número de lote" required>
          <input :id="id" v-model="newLotNumber" type="text" required placeholder="Ej. L-2026-X1" />
        </AdminFormField>
        <AdminFormField v-slot="{ id }" label="Fecha de caducidad" required>
          <input :id="id" v-model="newLotExpiry" type="date" required />
        </AdminFormField>
        <AdminFormField v-slot="{ id }" label="Unidades recibidas" required>
          <input :id="id" v-model.number="newLotQuantity" type="number" min="1" required />
        </AdminFormField>
      </form>
      <template #footer>
        <AdminButton @click="lotDrawer = false">Cancelar</AdminButton>
        <button type="submit" form="inventory-new-lot" class="adm-btn adm-btn--primary" :disabled="loading">
          Guardar lote
        </button>
      </template>
    </AdminDrawer>

    <AdminDrawer
      v-model:open="costDrawer"
      title="Registrar coste de entrada"
      description="Apunta lo que te costó cada unidad de la mercancía recibida."
    >
      <form id="inventory-new-cost" class="adm-stack" @submit.prevent="submitRecordCostLayer">
        <UAlert v-if="errorMessage" role="alert" color="error" variant="subtle" :title="errorMessage" />
        <AdminFormField
          v-slot="{ id }"
          label="Coste por unidad"
          help="En euros. Puedes usar coma o punto para los decimales."
          required
        >
          <div class="flex items-center gap-2">
            <input
              :id="id"
              v-model="newCostLayerEuros"
              type="text"
              inputmode="decimal"
              class="adm-input"
              placeholder="4,50"
              required
            />
            <span class="text-[var(--text-muted)]">€</span>
          </div>
        </AdminFormField>
        <AdminFormField v-slot="{ id }" label="Unidades" required>
          <input :id="id" v-model.number="newCostLayerQuantity" type="number" min="1" required />
        </AdminFormField>
      </form>
      <template #footer>
        <AdminButton @click="costDrawer = false">Cancelar</AdminButton>
        <button type="submit" form="inventory-new-cost" class="adm-btn adm-btn--primary" :disabled="loading">
          Guardar coste
        </button>
      </template>
    </AdminDrawer>

    <AdminConfirm
      v-model:open="quarantineOpen"
      title="Poner el lote en cuarentena"
      :description="`El lote ${lotToQuarantine?.lotNumber ?? ''} dejará de venderse hasta que se revise.`"
      confirm-label="Poner en cuarentena"
      danger
      @confirm="confirmQuarantine"
    />
  </section>
</template>
