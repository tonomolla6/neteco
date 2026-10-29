<script setup lang="ts">
import { ref } from 'vue'

const requestFetch = useRequestFetch()

interface Citation {
  id: string
  sourceType: string
  factKey: string
  citationText: string
  verified: boolean
}

interface ProposalResponse {
  id: string
  category: string
  prompt: string
  contextSummary: string
  proposedReply: string
  proposedAction: string | null
  actionType: string | null
  actionPayload: Record<string, unknown> | null
  citations: Citation[]
  redactionFlags: {
    noUnauthorizedRefundCommitment: boolean
    toneAppropriate: boolean
    safePiiMasking: boolean
    restrictedAccessFiltered: boolean
  }
  requiresHumanApproval: boolean
  autoExecutionForbidden: boolean
  approvalStatus: string
  version: number
  humanDecidedAt?: string
}

const prompt = ref('')
const category = ref<'order_ops' | 'customer_care' | 'catalog_review' | 'inventory_planning' | 'financial_inquiry' | 'general_admin'>('catalog_review')
const contextId = ref('')
const loading = ref(false)
const deciding = ref(false)
const errorMessage = ref('')
const proposal = ref<ProposalResponse | null>(null)
const editableReply = ref('')
const decisionNotes = ref('')
const statusMessage = ref('')

async function generateProposal() {
  if (!prompt.value.trim()) return
  loading.value = true
  errorMessage.value = ''
  statusMessage.value = ''
  try {
    const res = await requestFetch('/api/admin/ai/assistant/propose', {
      method: 'POST',
      body: {
        category: category.value,
        prompt: prompt.value.trim(),
        contextId: contextId.value.trim() || undefined
      }
    }) as { interaction: ProposalResponse }
    proposal.value = res.interaction
    editableReply.value = res.interaction.proposedReply
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : 'Error al generar propuesta con el copiloto'
  } finally {
    loading.value = false
  }
}

async function recordDecision(decision: 'approve' | 'reject' | 'modify_and_approve') {
  if (!proposal.value) return
  deciding.value = true
  errorMessage.value = ''
  try {
    const isModified = decision === 'modify_and_approve' || (decision === 'approve' && editableReply.value !== proposal.value.proposedReply)
    const finalDecision = isModified ? 'modify_and_approve' : decision

    const res = await requestFetch(`/api/admin/ai/assistant/interactions/${proposal.value.id}/decision`, {
      method: 'POST',
      body: {
        expectedVersion: proposal.value.version,
        decision: finalDecision,
        notes: decisionNotes.value || undefined,
        modifiedReply: isModified ? editableReply.value : undefined
      }
    }) as { interaction: ProposalResponse }

    proposal.value = res.interaction
    if (res.interaction.approvalStatus === 'approved') {
      statusMessage.value = 'Propuesta Aprobada por el administrador'
    } else if (res.interaction.approvalStatus === 'modified_and_approved') {
      statusMessage.value = 'Propuesta Aprobada con modificaciones'
    } else {
      statusMessage.value = 'Propuesta Rechazada'
    }
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : 'Error al registrar la decisión humana'
  } finally {
    deciding.value = false
  }
}
</script>

<template>
  <div class="space-y-6 rounded-xl border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-800 dark:bg-gray-900">
    <div class="flex items-center justify-between border-b border-gray-100 pb-4 dark:border-gray-800">
      <div>
        <h2 class="text-lg font-semibold text-gray-900 dark:text-gray-100">
          Asistente de Administración IA (ADM-032)
        </h2>
        <p class="text-sm text-gray-500 dark:text-gray-400">
          Copiloto bajo aprobación humana obligatoria. Cita datos verificados y nunca publica ni reembolsa automáticamente.
        </p>
      </div>
      <span class="inline-flex items-center rounded-full bg-blue-50 px-2.5 py-0.5 text-xs font-medium text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">
        Supervisión Humana Activa
      </span>
    </div>

    <!-- Error Banner -->
    <div v-if="errorMessage" class="rounded-lg bg-red-50 p-4 text-sm text-red-700 dark:bg-red-950/50 dark:text-red-300" role="alert">
      {{ errorMessage }}
    </div>

    <!-- Success Message -->
    <div v-if="statusMessage" class="rounded-lg bg-emerald-50 p-4 text-sm text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300">
      {{ statusMessage }}
    </div>

    <!-- Prompt Form -->
    <div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
      <div>
        <label for="ai-cat" class="block text-xs font-medium text-gray-700 dark:text-gray-300">Categoría</label>
        <select
          id="ai-cat"
          v-model="category"
          class="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
        >
          <option value="catalog_review">Revisión de Catálogo</option>
          <option value="order_ops">Operaciones de Pedidos</option>
          <option value="customer_care">Atención al Cliente</option>
          <option value="inventory_planning">Planificación de Inventario</option>
          <option value="financial_inquiry">Consulta Financiera</option>
          <option value="general_admin">Administración General</option>
        </select>
      </div>

      <div class="sm:col-span-2">
        <label for="ai-ctx" class="block text-xs font-medium text-gray-700 dark:text-gray-300">Contexto (ID Producto / Pedido)</label>
        <input
          id="ai-ctx"
          v-model="contextId"
          type="text"
          placeholder="Ej: prod-desengrasante-1 o ORD-1001"
          class="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
        >
      </div>

      <div class="sm:col-span-3">
        <label for="ai-prompt" class="block text-xs font-medium text-gray-700 dark:text-gray-300">Instrucción o Consulta</label>
        <textarea
          id="ai-prompt"
          v-model="prompt"
          data-test="assistant-prompt"
          rows="3"
          placeholder="Escribe tu consulta o instrucción para el asistente..."
          class="mt-1 block w-full rounded-md border border-gray-300 bg-white p-3 text-sm text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
        />
      </div>

      <div class="sm:col-span-3 flex justify-end">
        <button
          type="button"
          data-test="generate-proposal-btn"
          :disabled="loading || !prompt.trim()"
          class="inline-flex items-center rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow hover:bg-blue-700 disabled:opacity-50 dark:bg-blue-500 dark:hover:bg-blue-600"
          @click="generateProposal"
        >
          <span v-if="loading">Analizando y Consultando D1...</span>
          <span v-else>Consultar al Asistente IA</span>
        </button>
      </div>
    </div>

    <!-- Proposal Details -->
    <div v-if="proposal" class="space-y-4 rounded-lg border border-blue-100 bg-blue-50/50 p-5 dark:border-blue-900/50 dark:bg-blue-950/20">
      <div class="flex items-center justify-between">
        <h3 class="font-semibold text-gray-900 dark:text-gray-100">
          Propuesta de Copiloto (ID: {{ proposal.id.slice(0, 8) }}...)
        </h3>
        <span
          class="rounded-full px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wider"
          :class="{
            'bg-amber-100 text-amber-800 dark:bg-amber-900/60 dark:text-amber-300': proposal.approvalStatus === 'pending',
            'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/60 dark:text-emerald-300': proposal.approvalStatus.includes('approved'),
            'bg-red-100 text-red-800 dark:bg-red-900/60 dark:text-red-300': proposal.approvalStatus === 'rejected'
          }"
        >
          Estado: {{ proposal.approvalStatus }}
        </span>
      </div>

      <!-- Verified Citations -->
      <div v-if="proposal.citations && proposal.citations.length" class="space-y-2">
        <h4 class="text-xs font-semibold uppercase tracking-wider text-gray-600 dark:text-gray-400">
          Citas de datos verificadas en base de datos
        </h4>
        <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div
            v-for="(cit, idx) in proposal.citations"
            :key="cit.id"
            class="flex items-start gap-2 rounded-md border border-gray-200 bg-white p-2.5 text-xs text-gray-700 shadow-sm dark:border-gray-800 dark:bg-gray-800/80 dark:text-gray-300"
          >
            <span class="inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-blue-100 font-bold text-blue-700 dark:bg-blue-900 dark:text-blue-200">
              {{ idx + 1 }}
            </span>
            <div>
              <span class="font-semibold text-gray-900 dark:text-gray-100">[{{ cit.sourceType }}]</span>
              {{ cit.citationText }}
            </div>
          </div>
        </div>
      </div>

      <!-- Action Proposal Notice -->
      <div v-if="proposal.actionType" class="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
        <span class="font-bold">Acción propuesta bajo revisión:</span> {{ proposal.proposedAction }}
        <p class="mt-1 text-[11px] text-amber-700 dark:text-amber-400">
          Protección activa: La publicación y los reembolsos automáticos están estrictamente bloqueados. Solo un humano puede aprobar y ejecutar.
        </p>
      </div>

      <!-- Proposed Content Editor -->
      <div>
        <label for="ai-edit-reply" class="block text-xs font-semibold uppercase tracking-wider text-gray-600 dark:text-gray-400">
          Respuesta y propuesta para el back-office (editable antes de aprobar)
        </label>
        <textarea
          id="ai-edit-reply"
          v-model="editableReply"
          rows="4"
          class="mt-1 block w-full rounded-md border border-gray-300 bg-white p-3 text-sm text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
        />
      </div>

      <!-- Decision Actions -->
      <div v-if="proposal.approvalStatus === 'pending'" class="flex flex-wrap items-center justify-between gap-3 border-t border-gray-200 pt-4 dark:border-gray-800">
        <input
          v-model="decisionNotes"
          type="text"
          placeholder="Notas de revisión humana (opcional)..."
          class="flex-1 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs text-gray-900 shadow-sm dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
        >
        <div class="flex items-center gap-2">
          <button
            type="button"
            data-test="reject-proposal-btn"
            :disabled="deciding"
            class="rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 shadow-sm hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:bg-gray-800 dark:text-red-400 dark:hover:bg-red-950/40"
            @click="recordDecision('reject')"
          >
            Rechazar Propuesta
          </button>
          <button
            type="button"
            data-test="approve-proposal-btn"
            :disabled="deciding"
            class="rounded-md bg-emerald-600 px-4 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-emerald-700 disabled:opacity-50 dark:bg-emerald-500 dark:hover:bg-emerald-600"
            @click="recordDecision('approve')"
          >
            Aprobar y Registrar
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
