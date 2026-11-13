<script setup lang="ts">
import { computed, ref } from 'vue'

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
const category = ref<
  'order_ops' | 'customer_care' | 'catalog_review' | 'inventory_planning' | 'financial_inquiry' | 'general_admin'
>('catalog_review')
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
    const res = (await requestFetch('/api/admin/ai/assistant/propose', {
      method: 'POST',
      body: {
        category: category.value,
        prompt: prompt.value.trim(),
        contextId: contextId.value.trim() || undefined
      }
    })) as { interaction: ProposalResponse }
    proposal.value = res.interaction
    editableReply.value = res.interaction.proposedReply
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : 'No se ha podido generar la propuesta'
  } finally {
    loading.value = false
  }
}

async function recordDecision(decision: 'approve' | 'reject' | 'modify_and_approve') {
  if (!proposal.value) return
  deciding.value = true
  errorMessage.value = ''
  try {
    const isModified =
      decision === 'modify_and_approve' ||
      (decision === 'approve' && editableReply.value !== proposal.value.proposedReply)
    const finalDecision = isModified ? 'modify_and_approve' : decision

    const res = (await requestFetch(`/api/admin/ai/assistant/interactions/${proposal.value.id}/decision`, {
      method: 'POST',
      body: {
        expectedVersion: proposal.value.version,
        decision: finalDecision,
        notes: decisionNotes.value || undefined,
        modifiedReply: isModified ? editableReply.value : undefined
      }
    })) as { interaction: ProposalResponse }

    proposal.value = res.interaction
    if (res.interaction.approvalStatus === 'approved') {
      statusMessage.value = 'Propuesta aprobada'
    } else if (res.interaction.approvalStatus === 'modified_and_approved') {
      statusMessage.value = 'Propuesta aprobada con tus cambios'
    } else {
      statusMessage.value = 'Propuesta rechazada'
    }
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : 'No se ha podido guardar tu decisión'
  } finally {
    deciding.value = false
  }
}

// ── Presentación ───────────────────────────────────────────────────────────
const APPROVAL: Record<string, [string, 'warning' | 'success' | 'danger' | 'neutral']> = {
  pending: ['Pendiente de tu decisión', 'warning'],
  approved: ['Aprobada', 'success'],
  modified_and_approved: ['Aprobada con cambios', 'success'],
  rejected: ['Rechazada', 'danger']
}
const SOURCES: Record<string, string> = {
  product: 'Producto',
  catalog: 'Catálogo',
  inventory: 'Inventario',
  stock: 'Inventario',
  order: 'Pedido',
  customer: 'Cliente',
  policy: 'Política de la tienda',
  finance: 'Finanzas'
}
const sourceLabel = (code: string) => SOURCES[code.toLowerCase()] ?? adminHumanize(code)
/** Los fallos de red llegan con textos técnicos en inglés: se enseña una frase legible. */
const readableError = computed(() =>
  /[áéíóúñ]| (el|la|no|se|al) /i.test(errorMessage.value)
    ? errorMessage.value
    : 'El asistente no ha respondido. Vuelve a intentarlo en unos minutos.'
)
</script>

<template>
  <div class="adm-stack">
    <UAlert
      v-if="errorMessage"
      role="alert"
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="readableError"
    />
    <UAlert
      v-if="statusMessage"
      role="status"
      :color="proposal?.approvalStatus === 'rejected' ? 'neutral' : 'success'"
      variant="subtle"
      icon="i-lucide-circle-check"
      :title="statusMessage"
    />

    <AdminCard
      title="Pregunta al asistente"
      description="El asistente propone y tú decides: nunca publica ni reembolsa por su cuenta."
    >
      <div class="adm-stack">
        <div class="adm-form-grid">
          <div class="adm-field">
            <label for="ai-cat" class="adm-label">Tema</label>
            <select id="ai-cat" v-model="category" class="adm-input">
              <option value="catalog_review">Revisión de catálogo</option>
              <option value="order_ops">Pedidos</option>
              <option value="customer_care">Atención al cliente</option>
              <option value="inventory_planning">Planificación de inventario</option>
              <option value="financial_inquiry">Consulta financiera</option>
              <option value="general_admin">Administración general</option>
            </select>
          </div>
          <div class="adm-field">
            <label for="ai-ctx" class="adm-label">Producto o pedido (opcional)</label>
            <input
              id="ai-ctx"
              v-model="contextId"
              type="text"
              class="adm-input"
              placeholder="Referencia del producto o número de pedido"
              aria-describedby="ai-ctx-help"
            />
            <p id="ai-ctx-help" class="adm-help">Si lo indicas, el asistente consultará sus datos.</p>
          </div>
        </div>
        <div class="adm-field">
          <label for="ai-prompt" class="adm-label">Tu consulta</label>
          <textarea
            id="ai-prompt"
            v-model="prompt"
            data-test="assistant-prompt"
            rows="3"
            class="adm-input"
            placeholder="Por ejemplo: ¿qué productos de limpieza están a punto de agotarse?"
          />
        </div>
        <div>
          <button
            type="button"
            data-test="generate-proposal-btn"
            :disabled="loading || !prompt.trim()"
            class="adm-btn adm-btn--primary"
            @click="generateProposal"
          >
            <span v-if="loading">Consultando los datos de la tienda…</span>
            <span v-else>Consultar al asistente</span>
          </button>
        </div>
      </div>
    </AdminCard>

    <AdminCard v-if="proposal">
      <template #title>Propuesta del asistente</template>
      <template #actions>
        <AdminBadge :tone="APPROVAL[proposal.approvalStatus]?.[1] ?? 'neutral'">
          {{ APPROVAL[proposal.approvalStatus]?.[0] ?? adminStatusLabel(proposal.approvalStatus) }}
        </AdminBadge>
      </template>
      <div class="adm-stack">
        <div v-if="proposal.citations && proposal.citations.length">
          <h4>Datos en los que se basa</h4>
          <ol class="adm-list mt-2">
            <li v-for="(cit, idx) in proposal.citations" :key="cit.id">
              <span class="adm-list__index">{{ idx + 1 }}</span>
              <div class="min-w-0 flex-1">
                <p>{{ cit.citationText }}</p>
                <p class="adm-help">{{ sourceLabel(cit.sourceType) }}</p>
              </div>
              <AdminBadge v-if="cit.verified" tone="success" plain>Comprobado</AdminBadge>
            </li>
          </ol>
        </div>

        <UAlert
          v-if="proposal.actionType"
          color="warning"
          variant="subtle"
          icon="i-lucide-hand"
          :title="`Acción que propone: ${proposal.proposedAction ?? ''}`"
          description="No se aplicará sola. Las publicaciones y los reembolsos siempre los ejecuta una persona."
        />

        <div class="adm-field">
          <label for="ai-edit-reply" class="adm-label">Respuesta propuesta</label>
          <textarea id="ai-edit-reply" v-model="editableReply" rows="5" class="adm-input" />
          <p class="adm-help">Puedes corregir el texto antes de aprobarlo.</p>
        </div>

        <div v-if="proposal.approvalStatus === 'pending'" class="adm-field">
          <label for="ai-decision-notes" class="adm-label">Notas de revisión (opcional)</label>
          <input id="ai-decision-notes" v-model="decisionNotes" type="text" class="adm-input" />
        </div>
      </div>
      <template v-if="proposal.approvalStatus === 'pending'" #footer>
        <button
          type="button"
          data-test="reject-proposal-btn"
          :disabled="deciding"
          class="adm-btn adm-btn--danger-soft"
          @click="recordDecision('reject')"
        >
          Rechazar
        </button>
        <button
          type="button"
          data-test="approve-proposal-btn"
          :disabled="deciding"
          class="adm-btn adm-btn--secondary"
          @click="recordDecision('approve')"
        >
          Aprobar y guardar
        </button>
      </template>
    </AdminCard>
  </div>
</template>
