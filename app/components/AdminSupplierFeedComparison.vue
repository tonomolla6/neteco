<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { SupplierFeedReviewItem } from '~~/shared/supplier-feed-comparison'

const props = withDefaults(
  defineProps<{
    importId?: string
    supplierId?: string
  }>(),
  {
    importId: 'feed-import-default',
    supplierId: 'SUP-QUIM-01'
  }
)

const requestFetch = useRequestFetch()

const loading = ref(true)
const loadError = ref<string | null>(null)
const actionError = ref<string | null>(null)
const actionSuccess = ref<string | null>(null)

const items = ref<SupplierFeedReviewItem[]>([])
const selectedDiffType = ref<'all' | 'alta' | 'cambio' | 'baja'>('all')
const selectedStatus = ref<'all' | 'pending_review' | 'approved' | 'rejected' | 'applied'>('all')

const filteredItems = computed(() => {
  return items.value.filter((item) => {
    if (selectedDiffType.value !== 'all' && item.diffType !== selectedDiffType.value) return false
    if (selectedStatus.value !== 'all' && item.status !== selectedStatus.value) return false
    return true
  })
})

const pendingCount = computed(() => items.value.filter((i) => i.status === 'pending_review').length)
const approvedCount = computed(() => items.value.filter((i) => i.status === 'approved').length)
const appliedCount = computed(() => items.value.filter((i) => i.status === 'applied').length)

async function loadFeedItems() {
  loading.value = true
  loadError.value = null
  try {
    const url = `/api/admin/supplier-feed/items?importId=${encodeURIComponent(props.importId)}`
    const res = await requestFetch(url)
    items.value = Array.isArray(res) ? res : []
  } catch (err: unknown) {
    loadError.value = err instanceof Error ? err.message : 'Error al cargar la cola de revisión de feed'
  } finally {
    loading.value = false
  }
}

async function handleReview(item: SupplierFeedReviewItem, decision: 'approved' | 'rejected') {
  actionError.value = null
  actionSuccess.value = null
  try {
    await requestFetch('/api/admin/supplier-feed/review', {
      method: 'POST',
      body: {
        itemId: item.id,
        decision,
        expectedVersion: item.version,
        reviewNotes: decision === 'approved' ? 'Validado por supervisor' : 'Rechazado en revisión'
      }
    })
    item.status = decision
    item.version += 1
    actionSuccess.value = `Elemento ${item.supplierSku} marcado como ${decision}.`
  } catch (err: unknown) {
    actionError.value = err instanceof Error ? err.message : 'Error al revisar el elemento del feed'
  }
}

async function handleApplyApproved() {
  const approvedIds = items.value.filter((i) => i.status === 'approved').map((i) => i.id)
  if (approvedIds.length === 0) {
    actionError.value = 'No hay elementos aprobados para aplicar al catálogo.'
    return
  }

  actionError.value = null
  actionSuccess.value = null
  try {
    await requestFetch('/api/admin/supplier-feed/apply', {
      method: 'POST',
      body: {
        importId: props.importId,
        itemIds: approvedIds
      }
    })
    for (const item of items.value) {
      if (approvedIds.includes(item.id)) {
        item.status = 'applied'
        item.isPublished = 1
      }
    }
    actionSuccess.value = `Se han aplicado ${approvedIds.length} elementos aprobados al catálogo.`
  } catch (err: unknown) {
    actionError.value = err instanceof Error ? err.message : 'Error al aplicar cambios aprobados'
  }
}

onMounted(() => {
  loadFeedItems()
})
</script>

<template>
  <div
    class="supplier-feed-panel p-6 bg-white dark:bg-zinc-900 rounded-xl shadow-sm border border-zinc-200 dark:border-zinc-800"
  >
    <header class="mb-6 flex flex-wrap justify-between items-center gap-4">
      <div>
        <h2 class="text-xl font-bold text-zinc-900 dark:text-zinc-100">Comparación de Feed de Proveedor (CAT-018)</h2>
        <p class="text-sm text-zinc-600 dark:text-zinc-400 mt-1">
          Proveedor: <span class="font-semibold">{{ supplierId }}</span> | Importación: {{ importId }}
        </p>
      </div>
      <div class="flex items-center gap-2">
        <button
          type="button"
          class="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-medium rounded-lg text-sm transition disabled:opacity-50"
          :disabled="approvedCount === 0"
          @click="handleApplyApproved"
        >
          Aplicar Aprobados ({{ approvedCount }})
        </button>
      </div>
    </header>

    <!-- Guardrail Banner -->
    <div
      role="alert"
      class="mb-6 p-4 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 rounded-lg flex items-start gap-3"
    >      <div class="text-sm text-amber-800 dark:text-amber-200">
        <strong>Guardrail de Aceptación:</strong> Altas, cambios y bajas quedan en revisión obligatoria. Ninguna
        modificación o alta se publica silenciosamente sin visto bueno explícito.
      </div>
    </div>

    <!-- Counters -->
    <div class="grid grid-cols-3 gap-4 mb-6">
      <div class="p-3 bg-zinc-50 dark:bg-zinc-800/60 rounded-lg border border-zinc-200 dark:border-zinc-700">
        <span class="text-xs text-zinc-500 uppercase">Pendientes Revisión</span>
        <div class="text-2xl font-bold text-amber-600">{{ pendingCount }}</div>
      </div>
      <div class="p-3 bg-zinc-50 dark:bg-zinc-800/60 rounded-lg border border-zinc-200 dark:border-zinc-700">
        <span class="text-xs text-zinc-500 uppercase">Aprobados Listos</span>
        <div class="text-2xl font-bold text-emerald-600">{{ approvedCount }}</div>
      </div>
      <div class="p-3 bg-zinc-50 dark:bg-zinc-800/60 rounded-lg border border-zinc-200 dark:border-zinc-700">
        <span class="text-xs text-zinc-500 uppercase">Aplicados en Catálogo</span>
        <div class="text-2xl font-bold text-blue-600">{{ appliedCount }}</div>
      </div>
    </div>

    <!-- Notifications -->
    <div v-if="actionSuccess" class="mb-4 p-3 bg-emerald-100 text-emerald-800 rounded-lg text-sm">
      {{ actionSuccess }}
    </div>
    <div v-if="actionError" class="mb-4 p-3 bg-rose-100 text-rose-800 rounded-lg text-sm">
      {{ actionError }}
    </div>

    <!-- Filters -->
    <div class="flex flex-wrap gap-4 mb-4">
      <div class="flex items-center gap-2">
        <label for="diff-filter" class="text-xs font-medium text-zinc-600 dark:text-zinc-400">Tipo de cambio:</label>
        <select
          id="diff-filter"
          v-model="selectedDiffType"
          class="text-sm px-3 py-1.5 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800"
        >
          <option value="all">Todos los tipos</option>
          <option value="alta">Altas (Nuevos productos)</option>
          <option value="cambio">Cambios (Precios / Stock / Datos)</option>
          <option value="baja">Bajas (Descatalogados)</option>
        </select>
      </div>

      <div class="flex items-center gap-2">
        <label for="status-filter" class="text-xs font-medium text-zinc-600 dark:text-zinc-400">Estado:</label>
        <select
          id="status-filter"
          v-model="selectedStatus"
          class="text-sm px-3 py-1.5 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800"
        >
          <option value="all">Todos los estados</option>
          <option value="pending_review">Pendientes de revisión</option>
          <option value="approved">Aprobados</option>
          <option value="rejected">Rechazados</option>
          <option value="applied">Aplicados</option>
        </select>
      </div>
    </div>

    <!-- Loading State -->
    <div v-if="loading" class="py-12 text-center text-zinc-500" role="status">Cargando comparación de feed...</div>

    <!-- Error State -->
    <div v-else-if="loadError" class="py-12 text-center text-rose-600">
      {{ loadError }}
    </div>

    <!-- Empty State -->
    <div v-else-if="filteredItems.length === 0" class="py-12 text-center text-zinc-500">
      No hay elementos en esta vista de revisión.
    </div>

    <!-- Table of Review Items -->
    <div v-else class="overflow-x-auto">
      <table class="w-full text-left text-sm border-collapse">
        <thead>
          <tr class="border-b border-zinc-200 dark:border-zinc-700 text-zinc-500 dark:text-zinc-400 text-xs uppercase">
            <th class="py-3 px-4">SKU Proveedor</th>
            <th class="py-3 px-4">Tipo</th>
            <th class="py-3 px-4">Detalles del Cambio</th>
            <th class="py-3 px-4">Estado</th>
            <th class="py-3 px-4 text-right">Acciones</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-zinc-200 dark:divide-zinc-800">
          <tr v-for="item in filteredItems" :key="item.id" class="hover:bg-zinc-50 dark:hover:bg-zinc-800/40">
            <td class="py-3 px-4 font-mono font-medium text-zinc-900 dark:text-zinc-100">
              {{ item.supplierSku }}
            </td>
            <td class="py-3 px-4">
              <span
                class="px-2 py-0.5 rounded text-xs font-semibold"
                :class="{
                  'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300': item.diffType === 'alta',
                  'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300': item.diffType === 'cambio',
                  'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300': item.diffType === 'baja'
                }"
              >
                {{ item.diffType.toUpperCase() }}
              </span>
            </td>
            <td class="py-3 px-4 text-xs">
              <div v-if="item.diffType === 'alta' && item.afterPayload">
                <span class="font-semibold">{{ item.afterPayload.name }}</span>
                <span class="text-zinc-500 ml-2"
                  >PVP Proveedor: {{ (Number(item.afterPayload.priceCents || 0) / 100).toFixed(2) }}€</span
                >
              </div>
              <div v-else-if="item.diffType === 'cambio'">
                <div v-if="item.diffDetails?.changedFields">
                  <span
                    v-for="ch in item.diffDetails.changedFields as any[]"
                    :key="ch.field"
                    class="block text-zinc-600 dark:text-zinc-300"
                  >
                    {{ ch.field }}: <del class="text-rose-500">{{ ch.before }}</del> ➔
                    <ins class="text-emerald-500 no-underline font-semibold">{{ ch.after }}</ins>
                  </span>
                </div>
              </div>
              <div v-else-if="item.diffType === 'baja'">
                <span class="text-rose-600">Descatalogado o ausente en el feed entrante</span>
              </div>
            </td>
            <td class="py-3 px-4">
              <span
                class="px-2 py-0.5 rounded-full text-xs font-medium"
                :class="{
                  'bg-amber-100 text-amber-800': item.status === 'pending_review',
                  'bg-emerald-100 text-emerald-800': item.status === 'approved',
                  'bg-rose-100 text-rose-800': item.status === 'rejected',
                  'bg-blue-100 text-blue-800': item.status === 'applied'
                }"
              >
                {{ item.status }}
              </span>
            </td>
            <td class="py-3 px-4 text-right space-x-2">
              <template v-if="item.status === 'pending_review'">
                <button
                  type="button"
                  class="px-2.5 py-1 text-xs font-medium bg-emerald-50 text-emerald-700 hover:bg-emerald-100 rounded border border-emerald-300"
                  @click="handleReview(item, 'approved')"
                >
                  Aprobar
                </button>
                <button
                  type="button"
                  class="px-2.5 py-1 text-xs font-medium bg-rose-50 text-rose-700 hover:bg-rose-100 rounded border border-rose-300"
                  @click="handleReview(item, 'rejected')"
                >
                  Rechazar
                </button>
              </template>
              <template v-else-if="item.status === 'approved'">
                <span class="text-xs text-emerald-600 font-medium">✓ Aprobado para aplicar</span>
              </template>
              <template v-else-if="item.status === 'applied'">
                <span class="text-xs text-blue-600 font-medium">Publicado en catálogo</span>
              </template>
              <template v-else>
                <span class="text-xs text-zinc-400">Rechazado</span>
              </template>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
