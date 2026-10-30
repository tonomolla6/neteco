<template>
  <div class="space-y-6" data-testid="admin-warehouse-scan-panel">
    <!-- Header -->
    <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
      <div>
        <h1 class="text-2xl font-bold text-slate-900">Panel de Almacén — Modo Escaneo</h1>
        <p class="text-sm text-slate-600">
          Terminal optimizado para pistola escáner de código de barras. Recepción, picking, packing y modo excepción.
        </p>
      </div>
      <div class="flex items-center gap-2">
        <button
          type="button"
          class="rounded-lg bg-amber-600 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-700 shadow-sm transition"
          data-testid="btn-report-exception"
          @click="showExceptionModal = true"
        >
          ⚠️ Reportar Excepción
        </button>
      </div>
    </div>

    <!-- Live Scanner Bar -->
    <div class="rounded-2xl border-2 border-blue-500 bg-blue-50/50 p-4 shadow-sm">
      <form class="flex flex-col sm:flex-row items-center gap-3" @submit.prevent="onScanSubmit">
        <div class="relative flex-1 w-full">
          <input
            ref="scanInputRef"
            v-model="scannedCode"
            type="text"
            autofocus
            autocomplete="off"
            class="w-full rounded-xl border border-blue-300 bg-white px-4 py-3 text-lg font-mono font-bold tracking-wider text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="Escanear código de barras (EAN-13, SKU, Ubicación)..."
            data-testid="input-barcode-scanner"
          />
          <span class="absolute right-3 top-3.5 text-xs text-slate-400 font-sans"> Presiona Enter tras escanear </span>
        </div>
        <button
          type="submit"
          class="w-full sm:w-auto rounded-xl bg-blue-600 px-6 py-3 text-sm font-bold text-white hover:bg-blue-700 transition"
        >
          Validar Escaneo
        </button>
      </form>
      <div
        v-if="lastScanFeedback"
        class="mt-2 text-xs font-medium"
        :class="lastScanSuccess ? 'text-emerald-700' : 'text-red-700'"
      >
        {{ lastScanFeedback }}
      </div>
    </div>

    <!-- Operational Metrics Cards -->
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-4" data-testid="warehouse-metrics-cards">
      <div class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div class="text-xs font-medium text-slate-500 uppercase">Escaneos Hoy</div>
        <div class="mt-1 text-2xl font-bold text-blue-600" data-testid="metric-scanned-today">
          {{ metrics?.dailyStats?.itemsScannedToday ?? 0 }}
        </div>
      </div>
      <div class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div class="text-xs font-medium text-slate-500 uppercase">Tiempo Medio Picking</div>
        <div class="mt-1 text-2xl font-bold text-slate-900" data-testid="metric-avg-pick">
          {{ metrics?.dailyStats?.avgPickMinutes ?? 0 }}m
        </div>
      </div>
      <div class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div class="text-xs font-medium text-slate-500 uppercase">Tiempo Medio Packing</div>
        <div class="mt-1 text-2xl font-bold text-slate-900">{{ metrics?.dailyStats?.avgPackMinutes ?? 0 }}m</div>
      </div>
      <div class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div class="text-xs font-medium text-slate-500 uppercase">Excepciones Activas</div>
        <div class="mt-1 text-2xl font-bold text-red-600">
          {{ metrics?.queueCounts?.exceptions ?? 0 }}
        </div>
      </div>
    </div>

    <!-- Printer Status Bar -->
    <div
      class="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs shadow-sm"
    >
      <div class="flex items-center gap-3">
        <span class="font-bold text-slate-700">Impresoras de Almacén:</span>
        <div v-for="printer in printers" :key="printer.id" class="flex items-center gap-1.5">
          <span
            class="h-2.5 w-2.5 rounded-full"
            :class="printer.status === 'online' ? 'bg-emerald-500' : 'bg-red-500'"
          ></span>
          <span class="font-medium text-slate-800">{{ printer.name }}</span>
          <span class="text-slate-400">({{ printer.status }})</span>
        </div>
      </div>
      <button
        v-if="printers.length"
        type="button"
        class="rounded border border-slate-300 px-3 py-1 font-semibold text-slate-700 hover:bg-slate-50"
        @click="testPrintLabel(printers[0].id)"
      >
        Imprimir Etiqueta Prueba
      </button>
    </div>

    <!-- Queue Tabs Navigation -->
    <div class="flex border-b border-slate-200 text-sm font-semibold">
      <button
        type="button"
        class="border-b-2 px-5 py-3 transition"
        :class="
          activeTab === 'reception'
            ? 'border-blue-600 text-blue-600'
            : 'border-transparent text-slate-500 hover:text-slate-700'
        "
        data-testid="queue-tab-reception"
        @click="activeTab = 'reception'"
      >
        Recepción Proveedores ({{ queues?.reception?.length ?? 0 }})
      </button>
      <button
        type="button"
        class="border-b-2 px-5 py-3 transition"
        :class="
          activeTab === 'picking'
            ? 'border-blue-600 text-blue-600'
            : 'border-transparent text-slate-500 hover:text-slate-700'
        "
        data-testid="queue-tab-picking"
        @click="activeTab = 'picking'"
      >
        Picking Pedidos ({{ queues?.picking?.length ?? 0 }})
      </button>
      <button
        type="button"
        class="border-b-2 px-5 py-3 transition"
        :class="
          activeTab === 'packing'
            ? 'border-blue-600 text-blue-600'
            : 'border-transparent text-slate-500 hover:text-slate-700'
        "
        data-testid="queue-tab-packing"
        @click="activeTab = 'packing'"
      >
        Packing &amp; Expedición ({{ queues?.packing?.length ?? 0 }})
      </button>
      <button
        type="button"
        class="border-b-2 px-5 py-3 transition"
        :class="
          activeTab === 'exceptions'
            ? 'border-red-600 text-red-600'
            : 'border-transparent text-slate-500 hover:text-slate-700'
        "
        data-testid="queue-tab-exceptions"
        @click="activeTab = 'exceptions'"
      >
        Modo Excepción ({{ queues?.exceptions?.length ?? 0 }})
      </button>
    </div>

    <!-- Active Tab Content -->
    <div v-if="loading" class="p-8 text-center text-slate-500">Actualizando colas de almacén...</div>

    <!-- Reception Tab -->
    <div v-else-if="activeTab === 'reception'" class="space-y-4">
      <div v-if="!queues?.reception?.length" class="p-8 text-center text-slate-500 text-sm">
        No hay albaranes pendientes en la cola de recepción.
      </div>
      <div
        v-for="item in queues?.reception ?? []"
        :key="item.id"
        class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
      >
        <div class="flex items-center justify-between border-b pb-2">
          <div>
            <span class="font-bold text-slate-900 text-sm">{{ item.referenceCode }}</span>
            <span class="ml-2 text-xs text-slate-500">ID: {{ item.id }}</span>
          </div>
          <span class="rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-bold text-blue-800 uppercase">
            {{ item.status }}
          </span>
        </div>
        <div class="mt-3 divide-y divide-slate-100 text-xs">
          <div v-for="sub in item.items" :key="sub.sku" class="flex items-center justify-between py-2">
            <div>
              <div class="font-semibold text-slate-800">{{ sub.name }} ({{ sub.sku }})</div>
              <div class="text-slate-400 font-mono">
                EAN: {{ sub.barcode }} | Ubicación: {{ sub.location || 'Pendiente' }}
              </div>
            </div>
            <div class="font-mono text-sm">
              <span
                class="font-bold"
                :class="sub.scannedQty >= sub.expectedQty ? 'text-emerald-600' : 'text-slate-900'"
              >
                {{ sub.scannedQty }}
              </span>
              / {{ sub.expectedQty }} uds
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Exceptions Tab -->
    <div v-else-if="activeTab === 'exceptions'" class="space-y-4">
      <div v-if="!queues?.exceptions?.length" class="p-8 text-center text-slate-500 text-sm">
        No hay incidencias o excepciones abiertas en almacén.
      </div>
      <div
        v-for="exc in queues?.exceptions ?? []"
        :key="exc.id"
        class="rounded-xl border border-red-200 bg-red-50/50 p-4 shadow-sm"
      >
        <div class="flex items-start justify-between">
          <div>
            <div class="flex items-center gap-2">
              <span class="rounded bg-red-600 px-2 py-0.5 text-[10px] font-bold text-white uppercase">
                {{ exc.severity }}
              </span>
              <span class="font-bold text-slate-900 text-sm">{{ exc.exceptionType }}</span>
              <span class="text-xs text-slate-500">Referencia: {{ exc.targetId }}</span>
            </div>
            <p class="mt-2 text-xs text-slate-700">{{ exc.reason }}</p>
          </div>
          <button
            type="button"
            class="rounded-lg bg-white border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 shadow-sm"
            :data-testid="`btn-resolve-exception-${exc.id}`"
            @click="resolveException(exc)"
          >
            Resolver
          </button>
        </div>
      </div>
    </div>

    <!-- Picking/Packing empty states -->
    <div v-else class="p-8 text-center text-slate-500 text-sm">No hay pedidos en cola activa de {{ activeTab }}.</div>

    <!-- Modal Reportar Excepción -->
    <div
      v-if="showExceptionModal"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      data-testid="modal-report-exception"
    >
      <div class="w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl space-y-4 text-xs">
        <div class="flex items-center justify-between border-b pb-3">
          <h3 class="text-base font-bold text-slate-900">Declarar Excepción de Almacén</h3>
          <button type="button" class="text-slate-400 hover:text-slate-600" @click="showExceptionModal = false">
            ✕
          </button>
        </div>

        <form class="space-y-3" @submit.prevent="submitException">
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block font-medium text-slate-700">Tipo de Objetivo *</label>
              <select v-model="newException.targetType" class="mt-1 w-full rounded border p-2">
                <option value="order">Pedido</option>
                <option value="reception">Recepción</option>
                <option value="item">Lote / Producto</option>
              </select>
            </div>
            <div>
              <label class="block font-medium text-slate-700">ID / Referencia *</label>
              <input
                v-model="newException.targetId"
                required
                class="mt-1 w-full rounded border p-2"
                placeholder="Ej: ORD-2026-99"
              />
            </div>
          </div>

          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block font-medium text-slate-700">Tipo de Incidencia *</label>
              <select v-model="newException.exceptionType" class="mt-1 w-full rounded border p-2">
                <option value="damaged_item">Envase / Producto Dañado</option>
                <option value="barcode_mismatch">Código de Barras No Coincide</option>
                <option value="shortage">Falta de Cantidad</option>
                <option value="spill_hazard">Fuga / Riesgo Químico</option>
                <option value="expired_lot">Lote Caducado</option>
                <option value="damaged_box">Caja Rota</option>
              </select>
            </div>
            <div>
              <label class="block font-medium text-slate-700">Severidad *</label>
              <select v-model="newException.severity" class="mt-1 w-full rounded border p-2">
                <option value="low">Baja</option>
                <option value="medium">Media</option>
                <option value="high">Alta</option>
                <option value="critical">Crítica</option>
              </select>
            </div>
          </div>

          <div>
            <label class="block font-medium text-slate-700">Descripción detallada del incidente *</label>
            <textarea
              v-model="newException.reason"
              required
              rows="3"
              class="mt-1 w-full rounded border p-2"
              placeholder="Explica qué ha ocurrido y medidas inmediatas tomadas (ej. cubeto de contención, aislamiento)"
            ></textarea>
          </div>

          <div class="flex justify-end gap-2 border-t pt-3">
            <button
              type="button"
              class="rounded-lg border px-4 py-2 font-medium text-slate-700 hover:bg-slate-50"
              @click="showExceptionModal = false"
            >
              Cancelar
            </button>
            <button type="submit" class="rounded-lg bg-red-600 px-4 py-2 font-semibold text-white hover:bg-red-700">
              Confirmar Excepción
            </button>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import type {
  WarehouseMetricsSummary,
  WarehousePrinter,
  WarehouseQueueItem
} from '../../shared/warehouse-scan-operations'

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

const requestFetch = useRequestFetch()
const activeTab = ref<'reception' | 'picking' | 'packing' | 'exceptions'>('reception')
const scannedCode = ref('')
const lastScanFeedback = ref('')
const lastScanSuccess = ref(true)
const scanInputRef = ref<HTMLInputElement | null>(null)
const loading = ref(false)
const queues = ref<WarehouseQueuesData | null>(null)
const metrics = ref<WarehouseMetricsSummary | null>(null)
const printers = ref<WarehousePrinter[]>([])
const showExceptionModal = ref(false)

const newException = ref({
  targetType: 'reception' as const,
  targetId: '',
  exceptionType: 'damaged_item' as const,
  severity: 'high' as const,
  reason: ''
})

async function fetchAll() {
  loading.value = true
  try {
    const [qData, mData, pData] = await Promise.all([
      requestFetch('/api/admin/warehouse/queues'),
      requestFetch('/api/admin/warehouse/metrics'),
      requestFetch('/api/admin/warehouse/printers')
    ])
    queues.value = qData
    metrics.value = mData
    printers.value = Array.isArray(pData) ? pData : []
  } catch (err: unknown) {
    console.error('Error cargando almacén:', err)
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
      lastScanFeedback.value = `Código ${code} leído, pero no hay cola activa seleccionada.`
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
    lastScanFeedback.value = `✓ Código ${code} escaneado correctamente.`
    lastScanSuccess.value = true
    await fetchAll()
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Error desconocido'
    lastScanFeedback.value = `✕ Error en escaneo de ${code}: ${msg}`
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
    alert('Etiqueta enviada a la impresora con éxito')
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Error desconocido'
    alert(`Error de impresión: ${msg}`)
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
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Error desconocido'
    alert(`Error reportando excepción: ${msg}`)
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
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Error desconocido'
    alert(`Error resolviendo excepción: ${msg}`)
  }
}

onMounted(() => {
  fetchAll()
})
</script>
