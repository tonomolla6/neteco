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
    errorMessage.value = err instanceof Error ? err.message : 'No se ha podido preparar la propuesta de respuesta'
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
    statusMessage.value = 'Respuesta aprobada'
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : 'No se ha podido registrar la aprobación'
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
    statusMessage.value = 'Propuesta descartada'
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : 'No se ha podido descartar la propuesta'
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
const sourceLabels: Record<string, string> = {
  order: 'Pedido',
  shipment: 'Envío',
  tracking: 'Seguimiento',
  product: 'Producto',
  policy: 'Condiciones',
  invoice: 'Factura',
  payment: 'Pago',
  customer: 'Cliente',
  ticket: 'Consulta'
}
const approvalLabels: Record<string, { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' }> = {
  pending: { label: 'Pendiente de revisar', tone: 'warning' },
  approved: { label: 'Aprobada', tone: 'success' },
  modified_and_approved: { label: 'Aprobada con cambios', tone: 'success' },
  rejected: { label: 'Descartada', tone: 'neutral' }
}
</script>

<template>
  <AdminCard
    title="Asistente de respuestas"
    description="Propone una respuesta a partir de los datos del pedido. Siempre la revisa una persona antes de enviarla."
  >
    <template #actions>
      <button
        data-test="generate-copilot-draft"
        type="button"
        :disabled="loading"
        class="adm-btn adm-btn--secondary adm-btn--sm"
        @click="generateDraft"
      >
        {{ loading ? 'Consultando datos…' : 'Proponer respuesta' }}
      </button>
    </template>

    <div class="adm-stack">
      <UAlert
        v-if="errorMessage"
        role="alert"
        color="error"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        :title="errorMessage"
      />
      <UAlert
        v-if="statusMessage"
        role="status"
        color="success"
        variant="subtle"
        icon="i-lucide-circle-check"
        :title="statusMessage"
      />

      <p v-if="!draft && !errorMessage" class="adm-help">
        Pulsa «Proponer respuesta» para preparar un borrador que podrás editar.
      </p>

      <template v-if="draft">
        <div class="rounded-[var(--radius-surface)] bg-[var(--surface-sunken)] p-3">
          <p class="adm-label">Citas de datos verificadas</p>
          <ul class="mt-2 space-y-1.5">
            <li v-for="cit in draft.citations" :key="cit.id" class="flex flex-wrap items-start gap-2">
              <AdminBadge tone="info" plain>{{
                sourceLabels[cit.sourceType] ?? adminHumanize(cit.sourceType)
              }}</AdminBadge>
              <span class="min-w-0 break-words">{{ cit.citationText }}</span>
            </li>
          </ul>
        </div>

        <AdminFormField v-slot="{ id }" label="Respuesta propuesta" help="Puedes editarla antes de aprobarla.">
          <textarea
            :id="id"
            v-model="editableReply"
            rows="5"
            :disabled="draft.approvalStatus !== 'pending'"
            class="adm-input"
          />
        </AdminFormField>
        <div>
          <AdminBadge :tone="approvalLabels[draft.approvalStatus]?.tone ?? 'neutral'">
            {{ approvalLabels[draft.approvalStatus]?.label ?? adminHumanize(draft.approvalStatus) }}
          </AdminBadge>
        </div>

        <div v-if="draft.approvalStatus === 'pending'" class="flex flex-wrap justify-end gap-2">
          <button
            data-test="reject-draft"
            type="button"
            :disabled="approving"
            class="adm-btn adm-btn--secondary"
            @click="rejectDraft"
          >
            Descartar
          </button>
          <button
            data-test="approve-draft"
            type="button"
            :disabled="approving"
            class="adm-btn adm-btn--primary"
            @click="approveDraft"
          >
            Aprobar y enviar
          </button>
        </div>

        <div v-else class="flex flex-wrap items-center justify-between gap-2">
          <span class="adm-label">¿Era correcta la propuesta?</span>
          <div class="flex items-center gap-1" role="group" aria-label="Valoración de 1 a 5">
            <button
              v-for="s in [1, 2, 3, 4, 5]"
              :key="s"
              type="button"
              class="adm-chip"
              :aria-pressed="draft.accuracyScore === s"
              :aria-label="`${s} de 5`"
              @click="rateAccuracy(s)"
            >
              {{ s }}
            </button>
          </div>
        </div>
      </template>
    </div>
  </AdminCard>
</template>
