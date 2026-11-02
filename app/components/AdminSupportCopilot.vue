<script setup lang="ts">
import { ref } from 'vue'

const props = defineProps<{
  ticketId: string
}>()

const requestFetch = useRequestFetch()

interface Citation {
  id: string
  sourceType: string
  factKey: string
  citationText: string
  verified: boolean
}

interface DraftResponse {
  interactionId: string
  ticketId: string
  contextSummary: string
  proposedReply: string
  citations: Citation[]
  redactionFlags: {
    noUnauthorizedRefundCommitment: boolean
    toneAppropriate: boolean
    safePiiMasking: boolean
  }
  approvalStatus: string
  humanApprovedAt?: string
  accuracyScore?: number
}

const loading = ref(false)
const approving = ref(false)
const errorMessage = ref('')
const draft = ref<DraftResponse | null>(null)
const editableReply = ref('')
const statusMessage = ref('')
const evaluated = ref(false)

async function generateDraft() {
  loading.value = true
  errorMessage.value = ''
  statusMessage.value = ''
  try {
    const res = await requestFetch<DraftResponse, string>('/api/admin/support/copilot/draft', {
      method: 'POST',
      body: {
        ticketId: props.ticketId
      }
    })
    draft.value = res
    editableReply.value = draft.value?.proposedReply || ''
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : 'Error al generar borrador con el copiloto'
  } finally {
    loading.value = false
  }
}

async function approveDraft() {
  if (!draft.value) return
  approving.value = true
  errorMessage.value = ''
  try {
    const isModified = editableReply.value.trim() !== draft.value.proposedReply.trim()
    const res = (await requestFetch<unknown, string>(
      `/api/admin/support/copilot/${draft.value.interactionId}/decision`,
      {
        method: 'POST',
        body: {
          expectedVersion: 1,
          decision: isModified ? 'modify_and_approve' : 'approve',
          modifiedReply: isModified ? editableReply.value : undefined
        }
      }
    )) as { approvalStatus: string }

    draft.value.approvalStatus = res.approvalStatus || 'approved'
    statusMessage.value = 'Respuesta aprobada por el operador'
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : 'Error al registrar la aprobación'
  } finally {
    approving.value = false
  }
}

async function rejectDraft() {
  if (!draft.value) return
  approving.value = true
  errorMessage.value = ''
  try {
    await requestFetch<unknown, string>(`/api/admin/support/copilot/${draft.value.interactionId}/decision`, {
      method: 'POST',
      body: {
        expectedVersion: 1,
        decision: 'reject',
        rejectionReason: 'Descartado por el operador para respuesta personalizada'
      }
    })
    draft.value.approvalStatus = 'rejected'
    statusMessage.value = 'Borrador descartado por el operador'
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : 'Error al descartar el borrador'
  } finally {
    approving.value = false
  }
}

async function rateAccuracy(score: number) {
  if (!draft.value) return
  try {
    await requestFetch<unknown, string>(`/api/admin/support/copilot/${draft.value.interactionId}/evaluate`, {
      method: 'POST',
      body: {
        score,
        evaluation: score >= 4 ? 'accurate' : score >= 3 ? 'partially_accurate' : 'inaccurate',
        notes: `Puntuación asignada por el agente de soporte: ${score}/5`
      }
    })
    evaluated.value = true
    draft.value.accuracyScore = score
  } catch {
    // Non blocking evaluation error
  }
}
</script>

<template>
  <div class="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
    <div class="flex items-center justify-between border-b pb-3">
      <div class="flex items-center gap-2">
        <span
          class="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-50 text-xs font-bold text-indigo-700"
        >
          AI
        </span>
        <div>
          <h3 class="text-sm font-bold text-slate-900">Copiloto de Soporte Neteco (SUP-019)</h3>
          <p class="text-xs text-slate-500">Genera propuesta citando datos objetivos; requiere aprobación humana</p>
        </div>
      </div>
      <button
        data-test="generate-copilot-draft"
        type="button"
        :disabled="loading"
        class="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:opacity-50"
        @click="generateDraft"
      >
        {{ loading ? 'Consultando datos...' : 'Proponer Respuesta' }}
      </button>
    </div>

    <!-- Error message -->
    <div v-if="errorMessage" role="alert" class="mt-3 rounded-lg bg-red-50 p-3 text-xs text-red-700">
      {{ errorMessage }}
    </div>

    <!-- Status message -->
    <div
      v-if="statusMessage"
      role="status"
      class="mt-3 rounded-lg bg-emerald-50 p-3 text-xs font-medium text-emerald-800"
    >
      ✓ {{ statusMessage }}
    </div>

    <!-- Draft Content -->
    <div v-if="draft" class="mt-4 space-y-4">
      <!-- Grounded Citations Box -->
      <div class="rounded-lg bg-slate-50 p-3">
        <h4 class="text-xs font-bold uppercase tracking-wider text-slate-600">
          Citas de datos verificadas (Fuente D1)
        </h4>
        <ul class="mt-2 space-y-1.5">
          <li v-for="cit in draft.citations" :key="cit.id" class="flex items-start gap-2 text-xs text-slate-700">
            <span class="rounded bg-indigo-100 px-1 py-0.5 font-mono text-[10px] font-bold text-indigo-800">
              [{{ cit.sourceType }}]
            </span>
            <span>{{ cit.citationText }}</span>
          </li>
        </ul>
      </div>

      <!-- Proposed / Editable Reply -->
      <div>
        <div class="mb-1.5 flex items-center justify-between">
          <label class="text-xs font-bold text-slate-700"> Respuesta propuesta (Editable antes de aprobar) </label>
          <span class="text-[11px] text-slate-400"> Estado: {{ draft.approvalStatus }} </span>
        </div>
        <textarea
          v-model="editableReply"
          rows="5"
          :disabled="draft.approvalStatus !== 'pending'"
          class="block w-full rounded-lg border border-slate-300 p-3 text-sm text-slate-800 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 disabled:bg-slate-50"
        />
      </div>

      <!-- Approval Actions -->
      <div v-if="draft.approvalStatus === 'pending'" class="flex items-center justify-between border-t pt-3">
        <span class="text-xs text-slate-500"> Supervisión humana obligatoria según política SUP-019 </span>
        <div class="flex items-center gap-2">
          <button
            data-test="reject-draft"
            type="button"
            :disabled="approving"
            class="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
            @click="rejectDraft"
          >
            Descartar
          </button>
          <button
            data-test="approve-draft"
            type="button"
            :disabled="approving"
            class="rounded-lg bg-emerald-600 px-4 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-50"
            @click="approveDraft"
          >
            Aprobar y Enviar
          </button>
        </div>
      </div>

      <!-- Accuracy Evaluation -->
      <div v-else class="rounded-lg border border-slate-100 bg-slate-50 p-3">
        <div class="flex items-center justify-between">
          <span class="text-xs font-medium text-slate-600"> Evaluación de exactitud de la propuesta: </span>
          <div class="flex items-center gap-1">
            <button
              v-for="s in [1, 2, 3, 4, 5]"
              :key="s"
              type="button"
              class="px-1.5 py-0.5 text-xs font-bold"
              :class="draft.accuracyScore === s ? 'text-indigo-600' : 'text-slate-400 hover:text-indigo-500'"
              @click="rateAccuracy(s)"
            >
              ★ {{ s }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
