<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { DraftOrder } from '~~/shared/draft-orders'

const requestFetch = useRequestFetch()

const loading = ref(true)
const loadError = ref<string | null>(null)
const actionMessage = ref<string | null>(null)
const actionType = ref<'success' | 'error'>('success')

const draftOrders = ref<DraftOrder[]>([])
const selectedDraft = ref<DraftOrder | null>(null)
const filterStatus = ref<'all' | 'draft' | 'pending_approval' | 'approved' | 'expired' | 'converted'>('all')

const filteredDrafts = computed(() => {
  if (filterStatus.value === 'all') return draftOrders.value
  return draftOrders.value.filter((d) => d.status === filterStatus.value)
})

async function loadDraftOrders() {
  loading.value = true
  loadError.value = null
  try {
    const res = await requestFetch<DraftOrder[]>('/api/admin/draft-orders/list')
    draftOrders.value = Array.isArray(res) ? res : []
    if (draftOrders.value[0] && !selectedDraft.value) {
      selectedDraft.value = draftOrders.value[0]
    }
  } catch (err: unknown) {
    loadError.value = err instanceof Error ? err.message : 'Error al cargar pedidos en borrador'
  } finally {
    loading.value = false
  }
}

async function handleReview(draft: DraftOrder, decision: 'approved' | 'rejected') {
  actionMessage.value = null
  try {
    const updated = await requestFetch<DraftOrder>('/api/admin/draft-orders/review', {
      method: 'POST',
      body: {
        draftOrderId: draft.id,
        decision,
        expectedVersion: draft.version,
        notes: decision === 'approved' ? 'Aprobado por el gestor de cuentas' : 'Condiciones no aprobadas'
      }
    })
    const idx = draftOrders.value.findIndex((d) => d.id === draft.id)
    if (idx !== -1) draftOrders.value[idx] = updated
    if (selectedDraft.value?.id === draft.id) selectedDraft.value = updated
    actionType.value = 'success'
    actionMessage.value = `Borrador ${draft.draftNumber} marcado como ${decision}.`
  } catch (err: unknown) {
    actionType.value = 'error'
    actionMessage.value = err instanceof Error ? err.message : 'Error al revisar el borrador de pedido'
  }
}

async function handleConvert(draft: DraftOrder) {
  actionMessage.value = null
  try {
    const orderNumber = `ORD-CONF-${Math.floor(100000 + Math.random() * 900000)}`
    const updated = await requestFetch<DraftOrder>('/api/admin/draft-orders/convert', {
      method: 'POST',
      body: {
        draftOrderId: draft.id,
        expectedVersion: draft.version,
        confirmedOrderId: orderNumber
      }
    })
    const idx = draftOrders.value.findIndex((d) => d.id === draft.id)
    if (idx !== -1) draftOrders.value[idx] = updated
    if (selectedDraft.value?.id === draft.id) selectedDraft.value = updated
    actionType.value = 'success'
    actionMessage.value = `Borrador convertido con éxito a pedido firme: ${orderNumber}.`
  } catch (err: unknown) {
    actionType.value = 'error'
    actionMessage.value = err instanceof Error ? err.message : 'Error al convertir el borrador'
  }
}

async function handleSweepExpired() {
  actionMessage.value = null
  try {
    const res = await requestFetch<{ expiredCount: number }>('/api/admin/draft-orders/sweep', {
      method: 'POST'
    })
    actionType.value = 'success'
    actionMessage.value = `Barrido ejecutado: ${res.expiredCount} borradores vencidos actualizados a 'expired'.`
    await loadDraftOrders()
  } catch (err: unknown) {
    actionType.value = 'error'
    actionMessage.value = err instanceof Error ? err.message : 'Error al barrer borradores vencidos'
  }
}

onMounted(() => {
  loadDraftOrders()
})
</script>

<template>
  <div
    class="draft-orders-panel p-6 bg-white dark:bg-zinc-900 rounded-xl shadow-sm border border-zinc-200 dark:border-zinc-800"
  >
    <header class="mb-6 flex flex-wrap justify-between items-center gap-4">
      <div>
        <h2 class="text-xl font-bold text-zinc-900 dark:text-zinc-100">
          Pedidos como Borrador Sujetos a Aprobación (CHK-022)
        </h2>
        <p class="text-sm text-zinc-600 dark:text-zinc-400 mt-1">
          Flujo B2B con expiración explícita y auditoría temporal completa.
        </p>
      </div>

      <div class="flex items-center gap-2">
        <button
          type="button"
          class="px-3 py-1.5 bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 text-zinc-700 dark:text-zinc-300 text-xs font-medium rounded-lg border border-zinc-300 dark:border-zinc-700"
          @click="handleSweepExpired"
        >
          Barrer Expirados
        </button>
      </div>
    </header>

    <!-- Guardrail Acceptance Alert -->
    <div
      role="alert"
      class="mb-6 p-4 bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800 rounded-lg text-sm text-blue-900 dark:text-blue-200 flex items-start gap-3"
    >      <div>
        <strong>Criterio de Aceptación CHK-022:</strong>
        No reserva inventario ni cobra de forma indefinida. Todo borrador tiene fecha de expiración obligatoria y
        timeline auditable.
      </div>
    </div>

    <!-- Feedback Message -->
    <div
      v-if="actionMessage"
      class="mb-6 p-3 rounded-lg text-sm"
      :class="{
        'bg-emerald-50 text-emerald-800 border border-emerald-200': actionType === 'success',
        'bg-rose-50 text-rose-800 border border-rose-200': actionType === 'error'
      }"
      role="alert"
    >
      {{ actionMessage }}
    </div>

    <!-- Filter Buttons -->
    <div class="flex flex-wrap gap-2 mb-6">
      <button
        v-for="st in ['all', 'draft', 'pending_approval', 'approved', 'expired', 'converted']"
        :key="st"
        type="button"
        class="px-3 py-1 text-xs rounded-full font-medium transition"
        :class="
          filterStatus === st
            ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
            : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400'
        "
        @click="filterStatus = st as any"
      >
        {{ st }}
      </button>
    </div>

    <!-- Main Content Layout -->
    <div v-if="loading" class="py-12 text-center text-zinc-500" role="status">Cargando pedidos en borrador...</div>
    <div v-else-if="loadError" class="py-12 text-center text-rose-600">
      {{ loadError }}
    </div>
    <div v-else-if="filteredDrafts.length === 0" class="py-12 text-center text-zinc-500">
      No hay borradores con el filtro seleccionado.
    </div>
    <div v-else class="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <!-- Left: Drafts List -->
      <div class="lg:col-span-1 space-y-3">
        <div
          v-for="draft in filteredDrafts"
          :key="draft.id"
          class="p-4 rounded-lg border cursor-pointer transition text-left"
          :class="
            selectedDraft?.id === draft.id
              ? 'border-blue-500 bg-blue-50/30 dark:bg-blue-950/20 shadow-sm'
              : 'border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-800/40'
          "
          @click="selectedDraft = draft"
        >
          <div class="flex justify-between items-start">
            <span class="font-mono font-bold text-sm text-zinc-900 dark:text-zinc-100">{{ draft.draftNumber }}</span>
            <span
              class="px-2 py-0.5 rounded text-xs font-semibold"
              :class="{
                'bg-zinc-100 text-zinc-700': draft.status === 'draft',
                'bg-amber-100 text-amber-800': draft.status === 'pending_approval',
                'bg-emerald-100 text-emerald-800': draft.status === 'approved',
                'bg-rose-100 text-rose-800': draft.status === 'rejected',
                'bg-zinc-200 text-zinc-600': draft.status === 'expired',
                'bg-purple-100 text-purple-800': draft.status === 'converted'
              }"
            >
              {{ draft.status }}
            </span>
          </div>
          <div class="mt-2 text-xs font-semibold text-zinc-800 dark:text-zinc-200">{{ draft.companyName }}</div>
          <div class="text-xs text-zinc-500">
            {{ (draft.totalCents / 100).toFixed(2) }}€ • {{ draft.items.length }} líneas
          </div>
          <div class="mt-2 text-xs text-zinc-400">Expira: {{ draft.expiresAt }}</div>
        </div>
      </div>

      <!-- Right: Detailed View & Timeline -->
      <div
        v-if="selectedDraft"
        class="lg:col-span-2 p-6 rounded-lg bg-zinc-50 dark:bg-zinc-800/40 border border-zinc-200 dark:border-zinc-700 space-y-6"
      >
        <div class="flex flex-wrap justify-between items-start gap-4">
          <div>
            <h3 class="text-lg font-bold text-zinc-900 dark:text-zinc-100 font-mono">
              {{ selectedDraft.draftNumber }}
            </h3>
            <p class="text-sm text-zinc-600 dark:text-zinc-400">
              {{ selectedDraft.companyName }} ({{ selectedDraft.contactEmail }})
            </p>
          </div>
          <div class="flex items-center gap-2">
            <template v-if="selectedDraft.status === 'pending_approval'">
              <button
                type="button"
                class="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded text-xs font-medium"
                @click="handleReview(selectedDraft, 'approved')"
              >
                Aprobar
              </button>
              <button
                type="button"
                class="px-3 py-1.5 bg-rose-600 hover:bg-rose-700 text-white rounded text-xs font-medium"
                @click="handleReview(selectedDraft, 'rejected')"
              >
                Rechazar
              </button>
            </template>
            <template v-else-if="selectedDraft.status === 'approved'">
              <button
                type="button"
                class="px-4 py-1.5 bg-purple-600 hover:bg-purple-700 text-white rounded text-xs font-bold"
                @click="handleConvert(selectedDraft)"
              >
                Convertir a Pedido Firme
              </button>
            </template>
          </div>
        </div>

        <!-- Acceptance Guarantees Badges -->
        <div class="grid grid-cols-2 gap-4 text-xs">
          <div class="p-3 bg-white dark:bg-zinc-900 rounded border border-zinc-200 dark:border-zinc-700">
            <span class="text-zinc-500 block mb-1 font-semibold uppercase">Reserva Inventario:</span>
            <span class="font-bold text-emerald-600">
              {{ selectedDraft.inventoryReserved === 0 ? 'Sin bloqueo indefinido (0)' : 'Reservado' }}
            </span>
          </div>
          <div class="p-3 bg-white dark:bg-zinc-900 rounded border border-zinc-200 dark:border-zinc-700">
            <span class="text-zinc-500 block mb-1 font-semibold uppercase">Estado Cobro:</span>
            <span class="font-bold text-blue-600 uppercase">
              {{ selectedDraft.paymentStatus }} (Sin cargo anticipado)
            </span>
          </div>
        </div>

        <!-- Lines -->
        <div>
          <h4 class="text-xs font-bold uppercase text-zinc-500 mb-2">Líneas del Borrador</h4>
          <div class="space-y-1.5">
            <div
              v-for="item in selectedDraft.items"
              :key="item.sku"
              class="flex justify-between text-xs py-1.5 px-3 bg-white dark:bg-zinc-900 rounded border border-zinc-200 dark:border-zinc-800"
            >
              <div>
                <span class="font-mono font-medium">{{ item.sku }}</span> - {{ item.name }}
              </div>
              <div class="font-semibold">
                {{ item.quantity }} x {{ (item.unitPriceCents / 100).toFixed(2) }}€ =
                {{ (item.lineTotalCents / 100).toFixed(2) }}€
              </div>
            </div>
          </div>
        </div>

        <!-- Timeline -->
        <div>
          <h4 class="text-xs font-bold uppercase text-zinc-500 mb-2">Timeline y Auditoría de Eventos</h4>
          <div class="space-y-2 border-l-2 border-zinc-300 dark:border-zinc-700 pl-4 ml-2">
            <div v-for="evt in selectedDraft.timeline" :key="evt.id" class="text-xs space-y-0.5">
              <div class="flex items-center gap-2">
                <span class="font-bold text-zinc-800 dark:text-zinc-200 uppercase">{{ evt.eventType }}</span>
                <span class="text-zinc-400 text-[10px]">{{ evt.createdAt }}</span>
                <span
                  class="px-1.5 py-0.2 bg-zinc-200 dark:bg-zinc-800 rounded text-[10px] text-zinc-600 dark:text-zinc-300"
                >
                  {{ evt.actorType }}
                </span>
              </div>
              <p class="text-zinc-600 dark:text-zinc-400">
                {{ evt.notes || 'Evento registrado en el flujo de aprobación.' }}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
