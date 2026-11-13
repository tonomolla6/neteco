<template>
  <div class="adm-stack" data-testid="admin-warehouse-scan-panel">
    <AdminPageActions>
      <AdminButton icon="i-lucide-rotate-cw" :loading="loading" @click="fetchAll">Actualizar</AdminButton>
      <button
        type="button"
        class="adm-btn adm-btn--primary"
        data-testid="btn-report-exception"
        @click="showExceptionModal = true"
      >
        <UIcon name="i-lucide-triangle-alert" class="size-4 shrink-0" />
        Comunicar incidencia
      </button>
    </AdminPageActions>

    <!-- Lector de códigos -->
    <AdminCard>
      <form class="flex flex-col gap-3 sm:flex-row sm:items-end" @submit.prevent="onScanSubmit">
        <div class="adm-field min-w-0 flex-1">
          <label for="warehouse-scan-code" class="adm-label">Código leído</label>
          <input
            id="warehouse-scan-code"
            ref="scanInputRef"
            v-model="scannedCode"
            type="text"
            autofocus
            autocomplete="off"
            class="adm-input w-full font-mono"
            placeholder="Código de barras, referencia o ubicación"
            aria-describedby="warehouse-scan-help"
            data-testid="input-barcode-scanner"
          />
        </div>
        <button type="submit" class="adm-btn adm-btn--secondary">Validar lectura</button>
      </form>
      <p id="warehouse-scan-help" class="adm-help mt-2">
        Lee el código con el lector y pulsa Intro. Se anota en la primera recepción pendiente.
      </p>
      <UAlert
        v-if="lastScanFeedback"
        class="mt-3"
        :color="lastScanSuccess ? 'success' : 'error'"
        variant="subtle"
        :icon="lastScanSuccess ? 'i-lucide-circle-check' : 'i-lucide-triangle-alert'"
        :title="lastScanFeedback"
        role="status"
      />
    </AdminCard>

    <AdminCard v-if="loadError && !queues">
      <AdminEmptyState
        compact
        variant="error"
        title="No hemos podido cargar el almacén"
        description="Comprueba la conexión y vuelve a intentarlo."
      >
        <AdminButton icon="i-lucide-rotate-cw" @click="fetchAll">Reintentar</AdminButton>
      </AdminEmptyState>
    </AdminCard>

    <template v-else>
      <!-- Cifras del día -->
      <div class="adm-grid" data-testid="warehouse-metrics-cards">
        <AdminStat
          label="Lecturas de hoy"
          icon="i-lucide-scan-barcode"
          :value="metrics?.dailyStats?.itemsScannedToday ?? 0"
          data-testid="metric-scanned-today"
        />
        <AdminStat
          label="Tiempo medio de preparación"
          icon="i-lucide-timer"
          :value="`${metrics?.dailyStats?.avgPickMinutes ?? 0} min`"
          data-testid="metric-avg-pick"
        />
        <AdminStat
          label="Tiempo medio de embalaje"
          icon="i-lucide-package"
          :value="`${metrics?.dailyStats?.avgPackMinutes ?? 0} min`"
        />
        <AdminStat
          label="Incidencias abiertas"
          icon="i-lucide-triangle-alert"
          :value="metrics?.queueCounts?.exceptions ?? 0"
        />
      </div>

      <!-- Impresoras -->
      <AdminCard title="Impresoras de etiquetas">
        <template v-if="printers[0]" #actions>
          <AdminButton size="sm" icon="i-lucide-printer" @click="printers[0] && testPrintLabel(printers[0].id)">
            Imprimir etiqueta de prueba
          </AdminButton>
        </template>
        <ul v-if="printers.length" class="flex flex-wrap gap-x-6 gap-y-2">
          <li v-for="printer in printers" :key="printer.id" class="flex items-center gap-2">
            <span class="font-medium text-[var(--text-strong)]">{{ printer.name }}</span>
            <AdminBadge :tone="printer.status === 'online' ? 'success' : 'danger'">
              {{ PRINTER_STATUS[printer.status] ?? adminStatusLabel(printer.status) }}
            </AdminBadge>
          </li>
        </ul>
        <AdminEmptyState v-else compact icon="i-lucide-printer" title="No hay impresoras conectadas" />
      </AdminCard>

      <!-- Colas de trabajo -->
      <div class="adm-tabs" role="tablist" aria-label="Colas de trabajo del almacén">
        <button
          v-for="entry in QUEUE_TABS"
          :key="entry.value"
          type="button"
          role="tab"
          class="adm-tab"
          :aria-selected="activeTab === entry.value"
          :data-testid="`queue-tab-${entry.value}`"
          @click="activeTab = entry.value"
        >
          {{ entry.label }}
          <span class="adm-segment__count">{{ queues?.[entry.value]?.length ?? 0 }}</span>
        </button>
      </div>

      <div v-if="loading && !queues" class="adm-card adm-tablecard">
        <div class="adm-table-skeleton" aria-busy="true">
          <span class="sr-only">Cargando…</span>
          <div v-for="row in 4" :key="row"><i /><i /><i /><i /></div>
        </div>
      </div>

      <!-- Incidencias -->
      <template v-else-if="activeTab === 'exceptions'">
        <AdminCard v-if="!queues?.exceptions?.length">
          <AdminEmptyState
            compact
            icon="i-lucide-circle-check"
            title="No hay incidencias abiertas"
            description="Cuando alguien comunique un problema con la mercancía aparecerá aquí."
          />
        </AdminCard>
        <AdminCard v-else flush>
          <ul class="divide-y divide-[var(--border)]">
            <li
              v-for="exc in queues?.exceptions ?? []"
              :key="exc.id"
              class="flex flex-wrap items-start justify-between gap-3 px-5 py-4"
            >
              <div class="min-w-0">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="font-semibold text-[var(--text-strong)]">
                    {{ EXCEPTION_TYPE[exc.exceptionType] ?? adminHumanize(exc.exceptionType) }}
                  </span>
                  <AdminBadge :tone="SEVERITY_TONE[exc.severity] ?? 'neutral'">
                    {{ SEVERITY_LABEL[exc.severity] ?? adminStatusLabel(exc.severity) }}
                  </AdminBadge>
                </div>
                <p class="adm-help mt-1">
                  {{ TARGET_TYPE[exc.targetType] ?? 'Referencia' }} {{ exc.targetId }} ·
                  {{ adminDate(exc.createdAt, true) }}
                </p>
                <p class="mt-2">{{ exc.reason }}</p>
              </div>
              <button
                type="button"
                class="adm-btn adm-btn--secondary adm-btn--sm"
                :data-testid="`btn-resolve-exception-${exc.id}`"
                @click="resolveException(exc)"
              >
                Marcar como resuelta
              </button>
            </li>
          </ul>
        </AdminCard>
      </template>

      <!-- Recepción, preparación y embalaje -->
      <template v-else>
        <AdminCard v-if="!currentItems.length">
          <AdminEmptyState compact :title="QUEUE_EMPTY[activeTab]" />
        </AdminCard>
        <AdminCard v-for="item in currentItems" :key="item.id" :title="item.referenceCode" flush>
          <template #actions>
            <AdminBadge :status="item.status" />
          </template>
          <div class="adm-table-wrap">
            <table class="adm-table">
              <thead>
                <tr>
                  <th scope="col">Producto</th>
                  <th scope="col">Código de barras</th>
                  <th scope="col">Ubicación</th>
                  <th scope="col" data-numeric>Leídas / esperadas</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="sub in item.items" :key="sub.sku">
                  <td>
                    <span class="font-medium text-[var(--text-strong)]">{{ sub.name }}</span>
                    <span class="adm-help block">Ref. {{ sub.sku }}</span>
                  </td>
                  <td class="font-mono">{{ sub.barcode }}</td>
                  <td>{{ sub.location || 'Pendiente' }}</td>
                  <td data-numeric>
                    <AdminBadge :tone="sub.scannedQty >= sub.expectedQty ? 'success' : 'neutral'" plain>
                      {{ sub.scannedQty }} / {{ sub.expectedQty }} uds.
                    </AdminBadge>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </AdminCard>
      </template>
    </template>

    <!-- Comunicar una incidencia -->
    <AdminDrawer
      v-model:open="showExceptionModal"
      title="Comunicar incidencia de almacén"
      description="Queda registrada en la cola de incidencias hasta que alguien la resuelva."
    >
      <form
        id="warehouse-exception-form"
        class="adm-stack"
        data-testid="modal-report-exception"
        @submit.prevent="submitException"
      >
        <div class="adm-form-grid">
          <AdminFormField v-slot="{ id }" label="Afecta a" required>
            <select :id="id" v-model="newException.targetType" class="adm-input w-full">
              <option value="order">Pedido</option>
              <option value="reception">Recepción</option>
              <option value="item">Lote o producto</option>
            </select>
          </AdminFormField>
          <AdminFormField v-slot="{ id }" label="Número o referencia" required>
            <input
              :id="id"
              v-model="newException.targetId"
              required
              class="adm-input w-full"
              placeholder="Número de pedido, albarán o lote"
            />
          </AdminFormField>
          <AdminFormField v-slot="{ id }" label="Qué ha pasado" required>
            <select :id="id" v-model="newException.exceptionType" class="adm-input w-full">
              <option v-for="(label, value) in EXCEPTION_TYPE" :key="value" :value="value">{{ label }}</option>
            </select>
          </AdminFormField>
          <AdminFormField v-slot="{ id }" label="Gravedad" required>
            <select :id="id" v-model="newException.severity" class="adm-input w-full">
              <option value="low">Baja</option>
              <option value="medium">Media</option>
              <option value="high">Alta</option>
              <option value="critical">Crítica</option>
            </select>
          </AdminFormField>
        </div>
        <AdminFormField
          v-slot="{ id, describedBy }"
          label="Descripción"
          help="Explica qué ha ocurrido y qué se ha hecho ya (cubeto de contención, aislamiento…)."
          required
        >
          <textarea
            :id="id"
            v-model="newException.reason"
            required
            rows="4"
            class="adm-input w-full"
            :aria-describedby="describedBy"
          ></textarea>
        </AdminFormField>
      </form>
      <template #footer>
        <AdminButton @click="showExceptionModal = false">Cancelar</AdminButton>
        <button type="submit" form="warehouse-exception-form" class="adm-btn adm-btn--primary">
          Registrar incidencia
        </button>
      </template>
    </AdminDrawer>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import type { AdminTone } from '~/utils/adminLabels'
import type { WarehouseMetricsSummary, WarehousePrinter, WarehouseQueueItem } from '~~/shared/warehouse-scan-operations'

interface WarehouseQueuesData {
  reception: WarehouseQueueItem[]
  picking: WarehouseQueueItem[]
  packing: WarehouseQueueItem[]
  exceptions: Array<{
    id: string
    targetType: string
    targetId: string
    exceptionType: string
    severity: string
    reason: string
    status: string
    createdAt: string
  }>
}

type QueueTab = 'reception' | 'picking' | 'packing' | 'exceptions'
const QUEUE_TABS: Array<{ value: QueueTab; label: string }> = [
  { value: 'reception', label: 'Recepción de proveedores' },
  { value: 'picking', label: 'Preparación de pedidos' },
  { value: 'packing', label: 'Embalaje y expedición' },
  { value: 'exceptions', label: 'Incidencias' }
]
const QUEUE_EMPTY: Record<QueueTab, string> = {
  reception: 'No hay albaranes pendientes de recibir',
  picking: 'No hay pedidos pendientes de preparar',
  packing: 'No hay pedidos pendientes de embalar',
  exceptions: 'No hay incidencias abiertas'
}
const EXCEPTION_TYPE: Record<string, string> = {
  damaged_item: 'Envase o producto dañado',
  barcode_mismatch: 'El código de barras no coincide',
  shortage: 'Falta cantidad',
  spill_hazard: 'Fuga o riesgo químico',
  expired_lot: 'Lote caducado',
  damaged_box: 'Caja rota'
}
const TARGET_TYPE: Record<string, string> = { order: 'Pedido', reception: 'Recepción', item: 'Lote o producto' }
const SEVERITY_LABEL: Record<string, string> = { low: 'Baja', medium: 'Media', high: 'Alta', critical: 'Crítica' }
const SEVERITY_TONE: Record<string, AdminTone> = {
  low: 'neutral',
  medium: 'warning',
  high: 'danger',
  critical: 'danger'
}
const PRINTER_STATUS: Record<string, string> = {
  online: 'Conectada',
  offline: 'Desconectada',
  error: 'Con avería',
  paused: 'En pausa'
}

const requestFetch = useRequestFetch()
const toast = useToast()
const activeTab = ref<QueueTab>('reception')
const scannedCode = ref('')
const lastScanFeedback = ref('')
const lastScanSuccess = ref(true)
const scanInputRef = ref<HTMLInputElement | null>(null)
const loading = ref(false)
const loadError = ref(false)
const queues = ref<WarehouseQueuesData | null>(null)
const metrics = ref<WarehouseMetricsSummary | null>(null)
const printers = ref<WarehousePrinter[]>([])
const showExceptionModal = ref(false)
const currentItems = computed<WarehouseQueueItem[]>(() =>
  activeTab.value === 'exceptions' ? [] : (queues.value?.[activeTab.value] ?? [])
)

const newException = ref({
  targetType: 'reception' as const,
  targetId: '',
  exceptionType: 'damaged_item' as const,
  severity: 'high' as const,
  reason: ''
})

async function fetchAll() {
  loading.value = true
  loadError.value = false
  try {
    const [qData, mData, pData] = await Promise.all([
      requestFetch<WarehouseQueuesData>('/api/admin/warehouse/queues'),
      requestFetch<WarehouseMetricsSummary>('/api/admin/warehouse/metrics'),
      requestFetch<WarehousePrinter[]>('/api/admin/warehouse/printers')
    ])
    queues.value = qData
    metrics.value = mData
    printers.value = Array.isArray(pData) ? pData : []
  } catch (err: unknown) {
    console.error('Error cargando almacén:', err)
    loadError.value = true
  } finally {
    loading.value = false
  }
}

async function onScanSubmit() {
  if (!scannedCode.value.trim()) return
  const code = scannedCode.value.trim()
  scannedCode.value = ''

  try {
    const targetItem = queues.value?.reception?.[0]
    if (!targetItem) {
      lastScanFeedback.value = `Código ${code} leído, pero no hay ninguna recepción pendiente donde anotarlo.`
      lastScanSuccess.value = false
      return
    }

    await $fetch('/api/admin/warehouse/scan', {
      method: 'POST',
      body: {
        queueType: 'reception',
        targetId: targetItem.id,
        barcode: code,
        quantity: 1
      }
    })
    lastScanFeedback.value = `Código ${code} anotado correctamente.`
    lastScanSuccess.value = true
    await fetchAll()
  } catch {
    lastScanFeedback.value = `No se ha podido anotar el código ${code}. Comprueba que pertenece a esta recepción y vuelve a leerlo.`
    lastScanSuccess.value = false
  } finally {
    scanInputRef.value?.focus()
  }
}

async function testPrintLabel(printerId: string) {
  try {
    await $fetch(`/api/admin/warehouse/printers/${printerId}/print`, {
      method: 'POST',
      body: {
        labelType: 'parcel_4x6',
        documentId: 'TEST-LABEL-01',
        copies: 1
      }
    })
    toast.add({ title: 'Etiqueta de prueba enviada a la impresora', color: 'success' })
  } catch {
    toast.add({
      title: 'No se ha podido imprimir',
      description: 'Comprueba que la impresora está encendida y con papel.',
      color: 'error'
    })
  }
}

async function submitException() {
  try {
    await $fetch('/api/admin/warehouse/exceptions', {
      method: 'POST',
      body: newException.value
    })
    showExceptionModal.value = false
    activeTab.value = 'exceptions'
    await fetchAll()
  } catch {
    toast.add({
      title: 'No se ha podido registrar la incidencia',
      description: 'Revisa los datos y vuelve a intentarlo.',
      color: 'error'
    })
  }
}

async function resolveException(exc: { id: string }) {
  try {
    await $fetch(`/api/admin/warehouse/exceptions/${exc.id}/resolve`, {
      method: 'POST',
      body: {
        resolution: 'resolved',
        resolutionNotes: 'Incidencia resuelta por el operario responsable en terminal'
      }
    })
    await fetchAll()
  } catch {
    toast.add({ title: 'No se ha podido resolver la incidencia', description: 'Vuelve a intentarlo.', color: 'error' })
  }
}

onMounted(() => {
  fetchAll()
})
</script>
