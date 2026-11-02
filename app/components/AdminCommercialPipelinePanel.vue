<template>
  <div class="space-y-6" data-testid="admin-commercial-pipeline-panel">
    <!-- Header -->
    <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
      <div>
        <h1 class="text-2xl font-bold text-slate-900">Panel Comercial de Presupuestos y Cuentas</h1>
        <p class="text-sm text-slate-600">
          Supervisión de pipeline comercial, margen de presupuestos y gestión de próximas acciones en cuentas B2B.
        </p>
      </div>
      <div class="flex items-center gap-2">
        <button
          type="button"
          class="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 shadow-sm transition"
          data-testid="btn-create-action"
          @click="showActionModal = true"
        >
          Nueva Próxima Acción
        </button>
      </div>
    </div>

    <!-- Mandatory Non-ERP/CRM Disclaimer Banner -->
    <div
      class="rounded-xl border border-blue-200 bg-blue-50 p-4 text-blue-900 shadow-sm"
      data-testid="erp-crm-disclaimer"
    >
      <div class="flex items-start gap-3">
        <span class="text-lg">ℹ️</span>
        <div class="text-xs">
          <strong>Aviso de Gobernanza de Sistemas:</strong>
          {{
            pipelineData?.erpDisclaimer ??
            'Este panel comercial coordina presupuestos nativos y canal de cuentas Neteco. No sustituye un ERP/CRM empresarial sin decisión explícita de integración directiva.'
          }}
        </div>
      </div>
    </div>

    <!-- Overall Metrics Summary -->
    <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
      <div class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div class="text-xs font-medium text-slate-500 uppercase">Volumen en Pipeline</div>
        <div class="mt-1 text-2xl font-bold text-slate-900">
          {{ formatEuros(pipelineData?.overallGrossCents ?? 0) }}
        </div>
      </div>
      <div class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div class="text-xs font-medium text-slate-500 uppercase">Margen Medio Comercial</div>
        <div class="mt-1 text-2xl font-bold text-emerald-600">
          {{ ((pipelineData?.overallAverageMarginBps ?? 0) / 100).toFixed(1) }}%
        </div>
      </div>
      <div class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div class="text-xs font-medium text-slate-500 uppercase">Acciones Pendientes</div>
        <div class="mt-1 text-2xl font-bold text-amber-600">
          {{ pipelineData?.pendingNextActionsCount ?? 0 }}
        </div>
      </div>
    </div>

    <!-- Pipeline Stages Horizontal Board -->
    <div class="overflow-x-auto pb-2">
      <div class="flex gap-3 min-w-[900px]">
        <div
          v-for="(stageData, stageKey) in pipelineData?.stages ?? {}"
          :key="stageKey"
          class="flex-1 rounded-xl border border-slate-200 bg-slate-50 p-3 shadow-sm min-w-[140px]"
          :data-testid="`stage-column-${stageKey}`"
        >
          <div class="flex items-center justify-between">
            <span class="text-xs font-bold uppercase tracking-wider text-slate-700 capitalize">
              {{ stageKey.replace('_', ' ') }}
            </span>
            <span class="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-bold text-slate-700">
              {{ stageData?.count }}
            </span>
          </div>
          <div class="mt-2 text-sm font-semibold text-slate-900">
            {{ formatEuros(stageData?.totalGrossCents ?? 0) }}
          </div>
          <div class="text-[10px] text-slate-500">Ponderado: {{ formatEuros(stageData?.weightedValueCents ?? 0) }}</div>
        </div>
      </div>
    </div>

    <!-- Accounts and Next Actions Table -->
    <div class="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
      <div class="border-b border-slate-200 px-4 py-3 bg-slate-50">
        <h2 class="text-sm font-bold text-slate-900">Cuentas Clientes y Próximas Acciones</h2>
      </div>

      <div v-if="loading" class="p-8 text-center text-slate-500">Cargando canal comercial...</div>
      <div v-else-if="error" class="p-4 text-sm text-red-600">
        {{ error }}
      </div>
      <div v-else-if="!pipelineData?.accounts?.length" class="p-8 text-center text-slate-500 text-sm">
        No hay cuentas registradas en el pipeline comercial.
      </div>

      <div v-else class="divide-y divide-slate-100">
        <div
          v-for="acc in pipelineData.accounts"
          :key="acc.customerId"
          class="p-4 hover:bg-slate-50 transition"
          data-testid="account-row"
        >
          <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            <div>
              <div class="font-bold text-slate-900 text-sm">{{ acc.companyName }}</div>
              <div class="text-xs text-slate-500">Contacto: {{ acc.contactName }} ({{ acc.contactEmail }})</div>
            </div>
            <div class="flex items-center gap-4 text-xs">
              <div>
                <span class="text-slate-500">Presupuestos: </span>
                <strong>{{ acc.activeQuotesCount }}</strong>
              </div>
              <div>
                <span class="text-slate-500">Margen medio: </span>
                <strong class="text-emerald-700">{{ ((acc.averageMarginBps || 0) / 100).toFixed(1) }}%</strong>
              </div>
              <div class="font-semibold text-slate-900">
                {{ formatEuros(acc.pipelineValueGrossCents) }}
              </div>
            </div>
          </div>

          <!-- Next Actions for Account -->
          <div v-if="acc.nextActions?.length" class="mt-3 pl-4 border-l-2 border-slate-200 space-y-2">
            <div
              v-for="action in acc.nextActions"
              :key="action.id"
              class="flex flex-wrap items-center justify-between gap-2 text-xs"
            >
              <div class="flex items-center gap-2">
                <span
                  class="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase"
                  :class="priorityBadgeClass(action.priority)"
                >
                  {{ action.priority }}
                </span>
                <span
                  :class="{
                    'line-through text-slate-400': action.completed,
                    'text-slate-800 font-medium': !action.completed
                  }"
                >
                  {{ action.actionDescription }}
                </span>
                <span class="text-slate-400">| Límite: {{ action.dueDate }}</span>
              </div>
              <div v-if="!action.completed">
                <button
                  type="button"
                  class="rounded bg-slate-100 px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-200"
                  :data-testid="`btn-complete-action-${action.id}`"
                  @click="completeAction(action)"
                >
                  Marcar Hecha
                </button>
              </div>
              <div v-else class="text-[11px] text-emerald-600 font-semibold">✓ Completada</div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Modal Nueva Próxima Acción -->
    <div
      v-if="showActionModal"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      data-testid="modal-create-action"
    >
      <div class="w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl space-y-4 text-xs">
        <div class="flex items-center justify-between border-b pb-3">
          <h3 class="text-base font-bold text-slate-900">Crear Próxima Acción Comercial</h3>
          <button type="button" class="text-slate-400 hover:text-slate-600" @click="showActionModal = false">✕</button>
        </div>

        <form class="space-y-3" @submit.prevent="submitAction">
          <div>
            <label class="block font-medium text-slate-700">Cliente *</label>
            <select
              v-model="newAction.customerId"
              required
              class="mt-1 w-full rounded border border-slate-300 p-2 text-sm"
            >
              <option v-for="acc in pipelineData?.accounts ?? []" :key="acc.customerId" :value="acc.customerId">
                {{ acc.companyName }}
              </option>
            </select>
          </div>

          <div>
            <label class="block font-medium text-slate-700">Descripción de la Acción *</label>
            <textarea
              v-model="newAction.actionDescription"
              required
              rows="3"
              class="mt-1 w-full rounded border border-slate-300 p-2 text-sm"
              placeholder="Ej: Llamar para validar presupuesto y negociar plazo de entrega"
            ></textarea>
          </div>

          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block font-medium text-slate-700">Fecha Límite *</label>
              <input
                v-model="newAction.dueDate"
                type="date"
                required
                class="mt-1 w-full rounded border border-slate-300 p-2 text-sm"
              />
            </div>
            <div>
              <label class="block font-medium text-slate-700">Prioridad *</label>
              <select
                v-model="newAction.priority"
                required
                class="mt-1 w-full rounded border border-slate-300 p-2 text-sm"
              >
                <option value="urgent">Urgente</option>
                <option value="high">Alta</option>
                <option value="normal">Normal</option>
                <option value="low">Baja</option>
              </select>
            </div>
          </div>

          <div class="flex justify-end gap-2 border-t pt-3">
            <button
              type="button"
              class="rounded-lg border px-4 py-2 font-medium text-slate-700 hover:bg-slate-50"
              @click="showActionModal = false"
            >
              Cancelar
            </button>
            <button
              type="submit"
              class="rounded-lg bg-emerald-600 px-4 py-2 font-semibold text-white hover:bg-emerald-700"
            >
              Guardar Acción
            </button>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import type { CommercialPipelineSummary, CommercialNextAction } from '../../shared/commercial-quotes-accounts'

const requestFetch = useRequestFetch()
const loading = ref(false)
const error = ref<string | null>(null)
const pipelineData = ref<CommercialPipelineSummary | null>(null)
const showActionModal = ref(false)

const newAction = ref({
  customerId: '',
  actionDescription: '',
  dueDate: new Date().toISOString().slice(0, 10),
  priority: 'normal' as const,
  assignedIdentityId: '10000000-0000-4000-8000-000000000030'
})

async function fetchPipeline() {
  loading.value = true
  error.value = null
  try {
    const data = await requestFetch<CommercialPipelineSummary>('/api/admin/commercial/pipeline')
    pipelineData.value = data
    if (data?.accounts?.[0] && !newAction.value.customerId) {
      newAction.value.customerId = data.accounts[0].customerId
    }
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : 'Error cargando pipeline comercial'
  } finally {
    loading.value = false
  }
}

function formatEuros(cents: number): string {
  return (cents / 100).toLocaleString('es-ES', { style: 'currency', currency: 'EUR' })
}

function priorityBadgeClass(priority: string) {
  switch (priority) {
    case 'urgent':
      return 'bg-red-100 text-red-700'
    case 'high':
      return 'bg-amber-100 text-amber-700'
    case 'normal':
      return 'bg-blue-100 text-blue-700'
    case 'low':
      return 'bg-slate-100 text-slate-600'
    default:
      return 'bg-slate-100 text-slate-600'
  }
}

async function submitAction() {
  try {
    await $fetch('/api/admin/commercial/next-actions', {
      method: 'POST',
      body: newAction.value
    })
    showActionModal.value = false
    await fetchPipeline()
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Error desconocido'
    alert(`Error guardando acción: ${msg}`)
  }
}

async function completeAction(action: CommercialNextAction) {
  try {
    await $fetch(`/api/admin/commercial/next-actions/${action.id}/complete`, {
      method: 'POST',
      body: {
        expectedVersion: action.version,
        notes: 'Completado desde el panel comercial'
      }
    })
    await fetchPipeline()
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Error desconocido'
    alert(`Error completando acción: ${msg}`)
  }
}

onMounted(() => {
  fetchPipeline()
})
</script>
