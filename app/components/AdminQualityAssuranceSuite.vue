<template>
  <div class="adm-stack">
    <AdminPageActions>
      <AdminButton variant="primary" icon="i-lucide-rotate-cw" :loading="loading" @click="loadData">
        Repetir las comprobaciones
      </AdminButton>
    </AdminPageActions>

    <div v-if="error" role="alert">
      <AdminEmptyState
        variant="error"
        title="No se han podido cargar las pruebas"
        description="Comprueba la conexión y vuelve a intentarlo."
      >
        <AdminButton icon="i-lucide-rotate-cw" @click="loadData">Reintentar</AdminButton>
      </AdminEmptyState>
    </div>

    <div v-else-if="loading && !matrixSummary" class="adm-table-skeleton" aria-busy="true">
      <span class="sr-only">Cargando pruebas…</span>
      <div v-for="row in 4" :key="row"><i /><i /><i /></div>
    </div>

    <div v-else class="adm-grid">
      <AdminCard title="Promociones y automatizaciones">
        <template #actions>
          <AdminBadge v-if="matrixSummary" :tone="matrixSummary.failedCases > 0 ? 'danger' : 'success'">
            {{ matrixSummary.failedCases > 0 ? 'Con fallos' : 'Superadas' }}
          </AdminBadge>
        </template>
        <AdminEmptyState v-if="!matrixSummary" compact title="Sin resultados todavía" />
        <div v-else class="space-y-3">
          <div class="flex items-baseline justify-between gap-3">
            <span class="text-[var(--text-muted)]">Casos superados</span>
            <span class="text-lg font-semibold tabular-nums text-[var(--text-strong)]">
              {{ matrixSummary.passedCases }} de {{ matrixSummary.totalCases }}
            </span>
          </div>
          <dl class="grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt class="adm-help">Combinaciones</dt>
              <dd class="font-semibold">{{ matrixSummary.coverage.combinations }}</dd>
            </div>
            <div>
              <dt class="adm-help">Margen</dt>
              <dd class="font-semibold">{{ matrixSummary.coverage.margin }}</dd>
            </div>
            <div>
              <dt class="adm-help">Quién puede usarlas</dt>
              <dd class="font-semibold">{{ matrixSummary.coverage.eligibility }}</dd>
            </div>
            <div>
              <dt class="adm-help">Reembolsos</dt>
              <dd class="font-semibold">{{ matrixSummary.coverage.refund }}</dd>
            </div>
          </dl>
          <p class="adm-help">Última ejecución: {{ adminDate(matrixSummary.executedAt, true) }}</p>
        </div>
      </AdminCard>

      <AdminCard title="Separación entre particulares y empresas">
        <template #actions>
          <AdminBadge v-if="isolationStatus" :tone="isolationOk ? 'success' : 'danger'">
            {{ isolationOk ? 'Superadas' : 'Con fallos' }}
          </AdminBadge>
        </template>
        <AdminEmptyState v-if="!isolationStatus" compact title="Sin resultados todavía" />
        <div v-else class="space-y-3">
          <div class="flex flex-wrap gap-2">
            <AdminBadge :tone="isolationStatus.singleSiteConfirmed ? 'success' : 'danger'" plain>
              Una sola sede: {{ isolationStatus.singleSiteConfirmed ? 'comprobado' : 'falla' }}
            </AdminBadge>
            <AdminBadge :tone="isolationStatus.pricingIsolationEnforced ? 'success' : 'danger'" plain>
              Tarifas separadas: {{ isolationStatus.pricingIsolationEnforced ? 'comprobado' : 'falla' }}
            </AdminBadge>
          </div>
          <p class="adm-help">
            Los datos, pedidos, tarifas y condiciones de cada cliente no se mezclan, ni siquiera con muchas visitas a la
            vez.
          </p>
        </div>
      </AdminCard>

      <AdminCard title="Almacén, reparto y trabajo sin conexión">
        <template #actions>
          <AdminBadge v-if="warehouseStatus" :tone="warehouseStatus.reconciliationConsistent ? 'success' : 'danger'">
            {{ warehouseStatus.reconciliationConsistent ? 'Superadas' : 'Con fallos' }}
          </AdminBadge>
        </template>
        <AdminEmptyState v-if="!warehouseStatus" compact title="Sin resultados todavía" />
        <div v-else class="space-y-3">
          <div class="flex flex-wrap gap-2">
            <AdminBadge :tone="warehouseStatus.reconciliationConsistent ? 'success' : 'danger'" plain>
              {{ warehouseStatus.reconciliationConsistent ? 'Los datos cuadran' : 'Los datos no cuadran' }}
            </AdminBadge>
            <AdminBadge plain>Impresoras conectadas: {{ warehouseStatus.printersOnline }}</AdminBadge>
          </div>
          <p class="adm-help">
            Lectura de códigos, impresión de etiquetas, trabajo sin conexión y vuelta a conectar, control de duplicados
            y bloqueo de dispositivos perdidos.
          </p>
        </div>
      </AdminCard>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'

interface MatrixSummary {
  totalCases: number
  passedCases: number
  failedCases: number
  executedAt: string
  coverage: {
    combinations: string
    margin: string
    eligibility: string
    frequency: string
    consent: string
    refund: string
  }
}

interface IsolationStatus {
  singleSiteConfirmed: boolean
  concurrentQueriesPass: boolean
  dataIsolationEnforced: boolean
  pricingIsolationEnforced: boolean
  commercialConditionsEnforced: boolean
  prohibitedHierarchiesBlocked: boolean
}

interface WarehouseStatus {
  scanOperationsActive: boolean
  printersOnline: number
  reconnectionSyncActive: boolean
  duplicateDetectionEnforced: boolean
  lostDeviceQuarantineActive: boolean
  reconciliationConsistent: boolean
}

const loading = ref(false)
const error = ref<string | null>(null)
const matrixSummary = ref<MatrixSummary | null>(null)
const isolationStatus = ref<IsolationStatus | null>(null)
const warehouseStatus = ref<WarehouseStatus | null>(null)

const request = useRequestFetch()
const isolationOk = computed(() => {
  const status = isolationStatus.value
  return Boolean(
    status &&
    status.singleSiteConfirmed &&
    status.concurrentQueriesPass &&
    status.dataIsolationEnforced &&
    status.pricingIsolationEnforced &&
    status.commercialConditionsEnforced &&
    status.prohibitedHierarchiesBlocked
  )
})

async function loadData() {
  loading.value = true
  error.value = null
  try {
    const [resPromo, resIso, resWh] = await Promise.all([
      request<{ success: boolean; summary: MatrixSummary }>('/api/admin/qa/promotions-matrix'),
      request<{ success: boolean; status: IsolationStatus }>('/api/admin/qa/account-isolation'),
      request<{ success: boolean; status: WarehouseStatus }>('/api/admin/qa/warehouse-offline')
    ])

    if (resPromo?.success) matrixSummary.value = resPromo.summary
    if (resIso?.success) isolationStatus.value = resIso.status
    if (resWh?.success) warehouseStatus.value = resWh.status
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : 'No se ha podido conectar'
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  loadData()
})
</script>
