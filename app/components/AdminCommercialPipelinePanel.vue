<template>
  <div class="adm-stack" data-testid="admin-commercial-pipeline-panel">
    <AdminPageActions>
      <AdminButton
        variant="primary"
        icon="i-lucide-plus"
        data-testid="btn-create-action"
        @click="showActionModal = true"
      >
        Nueva acción
      </AdminButton>
    </AdminPageActions>

    <UAlert
      v-if="error"
      role="alert"
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      title="No se han podido cargar las oportunidades"
      description="Comprueba la conexión y vuelve a intentarlo."
    >
      <template #actions>
        <AdminButton size="sm" icon="i-lucide-rotate-cw" :loading="loading" @click="fetchPipeline">
          Reintentar
        </AdminButton>
      </template>
    </UAlert>

    <div class="adm-grid">
      <AdminStat label="Importe en curso" :value="adminMoney(pipelineData?.overallGrossCents ?? 0)" />
      <AdminStat label="Margen medio" :value="formatPercent(pipelineData?.overallAverageMarginBps ?? 0)" />
      <AdminStat label="Acciones pendientes" :value="pipelineData?.pendingNextActionsCount ?? 0" />
    </div>

    <AdminSection
      v-if="Object.keys(pipelineData?.stages ?? {}).length"
      title="Fases"
      description="Importe total de cada fase y su valor estimado según la probabilidad de cierre."
    >
      <div class="adm-grid">
        <div
          v-for="(stageData, stageKey) in pipelineData?.stages ?? {}"
          :key="stageKey"
          class="adm-card p-4"
          :data-testid="`stage-column-${stageKey}`"
        >
          <p class="flex items-center justify-between gap-2 text-[0.8125rem] font-semibold text-[var(--text-strong)]">
            {{ STAGE_LABELS[stageKey] ?? adminHumanize(stageKey) }}
            <AdminBadge plain>{{ stageData?.count }}</AdminBadge>
          </p>
          <p class="mt-2 text-lg font-semibold tabular-nums text-[var(--text-strong)]">
            {{ adminMoney(stageData?.totalGrossCents ?? 0) }}
          </p>
          <p class="adm-help">Estimado: {{ adminMoney(stageData?.weightedValueCents ?? 0) }}</p>
        </div>
      </div>
    </AdminSection>

    <AdminCard title="Empresas y próximas acciones" flush>
      <div v-if="loading && !pipelineData" class="adm-table-skeleton" aria-busy="true">
        <span class="sr-only">Cargando…</span>
        <div v-for="row in 4" :key="row"><i /><i /><i /></div>
      </div>
      <AdminEmptyState
        v-else-if="!pipelineData?.accounts?.length"
        compact
        icon="i-lucide-handshake"
        title="Todavía no hay empresas con oportunidades"
        description="Aparecerán aquí cuando se prepare un presupuesto para una empresa."
      />
      <ul v-else class="divide-y divide-[var(--border)]">
        <li v-for="acc in pipelineData.accounts" :key="acc.customerId" class="px-5 py-4" data-testid="account-row">
          <div class="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
            <div class="min-w-0">
              <p class="font-semibold text-[var(--text-strong)]">{{ acc.companyName }}</p>
              <p class="adm-help break-words">{{ acc.contactName }} · {{ acc.contactEmail }}</p>
            </div>
            <dl class="flex flex-wrap items-baseline gap-x-5 gap-y-1 text-[0.8125rem] text-[var(--text-muted)]">
              <div class="flex gap-1.5">
                <dt>Presupuestos</dt>
                <dd class="font-semibold tabular-nums text-[var(--text-strong)]">{{ acc.activeQuotesCount }}</dd>
              </div>
              <div class="flex gap-1.5">
                <dt>Margen medio</dt>
                <dd class="font-semibold tabular-nums text-[var(--text-strong)]">
                  {{ formatPercent(acc.averageMarginBps || 0) }}
                </dd>
              </div>
              <div class="flex gap-1.5">
                <dt>Importe</dt>
                <dd class="font-semibold tabular-nums text-[var(--text-strong)]">
                  {{ adminMoney(acc.pipelineValueGrossCents) }}
                </dd>
              </div>
            </dl>
          </div>

          <ul v-if="acc.nextActions?.length" class="mt-3 space-y-2 border-l border-[var(--border)] pl-4">
            <li
              v-for="action in acc.nextActions"
              :key="action.id"
              class="flex flex-wrap items-center justify-between gap-2"
            >
              <div class="flex min-w-0 flex-wrap items-center gap-2">
                <AdminBadge :tone="PRIORITY_TONES[action.priority] ?? 'neutral'">
                  {{ PRIORITY_LABELS[action.priority] ?? adminHumanize(action.priority) }}
                </AdminBadge>
                <span
                  :class="
                    action.completed ? 'text-[var(--text-muted)] line-through' : 'font-medium text-[var(--text-strong)]'
                  "
                >
                  {{ action.actionDescription }}
                </span>
                <span class="adm-help">Antes del {{ adminDate(action.dueDate) }}</span>
              </div>
              <button
                v-if="!action.completed"
                type="button"
                class="adm-btn adm-btn--secondary adm-btn--sm"
                :data-testid="`btn-complete-action-${action.id}`"
                @click="completeAction(action)"
              >
                Marcar como hecha
              </button>
              <AdminBadge v-else tone="success">Hecha</AdminBadge>
            </li>
          </ul>
        </li>
      </ul>
      <template #footer>
        <span class="adm-help mr-auto" data-testid="erp-crm-disclaimer">
          Este apartado sirve para seguir presupuestos y próximas acciones con cada empresa. No sustituye al programa de
          gestión de la empresa.
        </span>
      </template>
    </AdminCard>

    <AdminDrawer v-model:open="showActionModal" title="Nueva acción comercial">
      <form :id="formId" class="adm-stack" data-testid="modal-create-action" @submit.prevent="submitAction">
        <AdminFormField v-slot="{ id }" label="Empresa" required>
          <select :id="id" v-model="newAction.customerId" required>
            <option v-for="acc in pipelineData?.accounts ?? []" :key="acc.customerId" :value="acc.customerId">
              {{ acc.companyName }}
            </option>
          </select>
        </AdminFormField>
        <AdminFormField v-slot="{ id }" label="Qué hay que hacer" required>
          <textarea
            :id="id"
            v-model="newAction.actionDescription"
            required
            rows="3"
            placeholder="Por ejemplo: llamar para revisar el presupuesto y acordar el plazo de entrega"
          ></textarea>
        </AdminFormField>
        <div class="adm-form-grid">
          <AdminFormField v-slot="{ id }" label="Fecha límite" required>
            <input :id="id" v-model="newAction.dueDate" type="date" required />
          </AdminFormField>
          <AdminFormField v-slot="{ id }" label="Prioridad" required>
            <select :id="id" v-model="newAction.priority" required>
              <option value="urgent">Urgente</option>
              <option value="high">Alta</option>
              <option value="normal">Normal</option>
              <option value="low">Baja</option>
            </select>
          </AdminFormField>
        </div>
      </form>
      <template #footer>
        <AdminButton @click="showActionModal = false">Cancelar</AdminButton>
        <AdminButton variant="primary" type="submit" :form="formId">Guardar acción</AdminButton>
      </template>
    </AdminDrawer>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import type { CommercialPipelineSummary, CommercialNextAction } from '~~/shared/commercial-quotes-accounts'

const requestFetch = useRequestFetch()
const toast = useToast()
const formId = useId()
const STAGE_LABELS: Record<string, string> = {
  lead: 'Contacto nuevo',
  contacted: 'Contactado',
  quote_drafted: 'Presupuesto en preparación',
  quote_sent: 'Presupuesto enviado',
  negotiation: 'En negociación',
  approved: 'Aprobado',
  converted: 'Convertido en pedido',
  lost: 'Perdido'
}
const PRIORITY_LABELS: Record<string, string> = { urgent: 'Urgente', high: 'Alta', normal: 'Normal', low: 'Baja' }
const PRIORITY_TONES: Record<string, 'danger' | 'warning' | 'info' | 'neutral'> = {
  urgent: 'danger',
  high: 'warning',
  normal: 'info',
  low: 'neutral'
}
function formatPercent(bps: number): string {
  return `${(bps / 100).toLocaleString('es-ES', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`
}
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
    error.value = err instanceof Error ? err.message : 'No se han podido cargar las oportunidades'
  } finally {
    loading.value = false
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
    toast.add({
      title: 'No se ha podido guardar la acción',
      description: apiErrorMessage(err, 'Revisa los datos y vuelve a intentarlo.'),
      color: 'error',
      icon: 'i-lucide-triangle-alert'
    })
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
    toast.add({
      title: 'No se ha podido marcar la acción como hecha',
      description: apiErrorMessage(err, 'Vuelve a intentarlo.'),
      color: 'error',
      icon: 'i-lucide-triangle-alert'
    })
  }
}

onMounted(() => {
  fetchPipeline()
})
</script>
