<script setup lang="ts">
import { ref, onMounted } from 'vue'
import type { LiveChatMessageRecord } from '../../workers/support/live-chat'

const requestFetch = useRequestFetch()

interface QueueSession {
  id: string
  publicRef: string
  customerId: string | null
  status: string
  department: string
  operatorId: string | null
  operatorName: string | null
  currentVersion: number
  context: {
    url?: string
    productSlug?: string
    orderReference?: string
  }
  waitedSeconds: number | null
  createdAt: string
}

const loading = ref(true)
const error = ref<string | null>(null)
const queue = ref<QueueSession[]>([])
const activeSession = ref<QueueSession | null>(null)
const messages = ref<LiveChatMessageRecord[]>([])
const replyText = ref('')

const operatorName = ref('Atención al cliente')
const handoffDept = ref<'general' | 'technical' | 'logistics' | 'sales' | 'billing'>('technical')
const handoffNote = ref('')
const escalateSummary = ref('')
const closeReason = ref('resolved')

async function fetchQueue() {
  loading.value = true
  error.value = null
  try {
    const res = await requestFetch<{ queue: QueueSession[] }>('/api/admin/support/live-chat/queue')
    queue.value = res.queue
  } catch {
    error.value = 'No se han podido cargar las conversaciones en espera.'
  } finally {
    loading.value = false
  }
}

async function claimSession(s: QueueSession) {
  loading.value = true
  error.value = null
  try {
    const res = await $fetch<{ session: QueueSession }>(`/api/admin/support/live-chat/sessions/${s.id}/claim`, {
      method: 'POST',
      body: {
        expectedVersion: s.currentVersion,
        operatorName: operatorName.value
      }
    })
    activeSession.value = res.session
    await loadTranscript(s.id)
    await fetchQueue()
  } catch {
    error.value =
      'No se ha podido abrir la conversación: puede que otra persona ya la esté atendiendo. Actualiza la lista.'
  } finally {
    loading.value = false
  }
}

async function loadTranscript(id: string) {
  try {
    const res = await requestFetch<{ transcript: { messages: LiveChatMessageRecord[] } }>(
      `/api/support/live-chat/sessions/${id}/transcript`
    )
    messages.value = res.transcript.messages
  } catch {
    // Ignore error
  }
}

async function sendReply() {
  if (!replyText.value.trim() || !activeSession.value) return
  const text = replyText.value.trim()
  replyText.value = ''
  try {
    const res = await $fetch<{ message: LiveChatMessageRecord }>(
      `/api/support/live-chat/sessions/${activeSession.value.id}/messages`,
      {
        method: 'POST',
        body: {
          message: text,
          senderName: operatorName.value
        }
      }
    )
    messages.value.push(res.message)
  } catch {
    error.value = 'No se ha podido enviar la respuesta. Vuelve a intentarlo.'
  }
}

async function executeHandoff() {
  if (!activeSession.value || !handoffNote.value.trim()) return
  try {
    await $fetch<{ session: QueueSession }>(`/api/admin/support/live-chat/sessions/${activeSession.value.id}/handoff`, {
      method: 'POST',
      body: {
        expectedVersion: activeSession.value.currentVersion,
        targetDepartment: handoffDept.value,
        note: handoffNote.value.trim()
      }
    })
    activeSession.value = null
    handoffNote.value = ''
    await fetchQueue()
  } catch {
    error.value = 'No se ha podido pasar la conversación a otro equipo.'
  }
}

async function executeEscalate() {
  if (!activeSession.value || !escalateSummary.value.trim()) return
  try {
    await $fetch<unknown, string>(`/api/admin/support/live-chat/sessions/${activeSession.value.id}/escalate`, {
      method: 'POST',
      body: {
        expectedVersion: activeSession.value.currentVersion,
        summary: escalateSummary.value.trim()
      }
    })
    activeSession.value = null
    escalateSummary.value = ''
    await fetchQueue()
  } catch {
    error.value = 'No se ha podido convertir la conversación en consulta.'
  }
}

async function executeClose() {
  if (!activeSession.value) return
  try {
    await $fetch<unknown, string>(`/api/admin/support/live-chat/sessions/${activeSession.value.id}/close`, {
      method: 'POST',
      body: {
        expectedVersion: activeSession.value.currentVersion,
        closureReason: closeReason.value
      }
    })
    activeSession.value = null
    await fetchQueue()
  } catch {
    error.value = 'No se ha podido cerrar la conversación.'
  }
}

const DEPARTMENTS: Record<string, string> = {
  general: 'General',
  technical: 'Técnico',
  logistics: 'Logística',
  sales: 'Ventas',
  billing: 'Facturación'
}
function waited(seconds: number | null) {
  if (seconds === null || seconds === undefined) return ''
  return seconds < 60 ? `${seconds} s en espera` : `${Math.round(seconds / 60)} min en espera`
}

onMounted(() => {
  void fetchQueue()
})
</script>

<template>
  <div class="adm-stack">
    <AdminPageActions>
      <AdminButton icon="i-lucide-rotate-cw" :loading="loading" @click="fetchQueue">Actualizar</AdminButton>
    </AdminPageActions>

    <UAlert v-if="error" role="alert" color="error" variant="subtle" icon="i-lucide-triangle-alert" :title="error">
      <template #actions>
        <AdminButton size="sm" icon="i-lucide-rotate-cw" @click="fetchQueue">Reintentar</AdminButton>
      </template>
    </UAlert>

    <div class="grid grid-cols-1 gap-5 lg:grid-cols-3">
      <AdminCard flush>
        <template #title>
          En espera <AdminBadge :tone="queue.length ? 'warning' : 'neutral'" plain>{{ queue.length }}</AdminBadge>
        </template>
        <div v-if="loading && queue.length === 0" class="adm-table-skeleton" aria-busy="true">
          <span class="sr-only">Cargando…</span>
          <div v-for="row in 3" :key="row"><i /><i /></div>
        </div>
        <AdminEmptyState
          v-else-if="queue.length === 0"
          compact
          icon="i-lucide-messages-square"
          title="Nadie está esperando"
          description="Cuando un cliente abra el chat de la tienda, aparecerá aquí."
        />
        <ul v-else class="adm-list">
          <li v-for="s in queue" :key="s.id">
            <div class="min-w-0 flex-1">
              <p class="adm-list__title">
                <span class="break-all">{{ s.publicRef }}</span>
                <AdminBadge tone="neutral" plain>{{ DEPARTMENTS[s.department] ?? 'General' }}</AdminBadge>
              </p>
              <p v-if="s.context?.productSlug" class="adm-help break-words">Producto: {{ s.context.productSlug }}</p>
              <p v-if="s.context?.orderReference" class="adm-help break-words">
                Pedido: {{ s.context.orderReference }}
              </p>
              <p v-if="waited(s.waitedSeconds)" class="adm-help">{{ waited(s.waitedSeconds) }}</p>
            </div>
            <button type="button" class="adm-btn adm-btn--secondary adm-btn--sm" @click="claimSession(s)">
              Atender
            </button>
          </li>
        </ul>
      </AdminCard>

      <AdminCard
        class="lg:col-span-2"
        :title="activeSession ? `Conversación ${activeSession.publicRef}` : 'Conversación'"
      >
        <template v-if="activeSession" #actions>
          <AdminButton size="sm" @click="executeClose">Cerrar conversación</AdminButton>
        </template>

        <AdminEmptyState
          v-if="!activeSession"
          icon="i-lucide-message-circle"
          title="Ninguna conversación abierta"
          description="Pulsa «Atender» en una conversación en espera para empezar."
        />

        <div v-else class="adm-stack">
          <div
            class="h-72 space-y-3 overflow-y-auto rounded-[var(--radius-surface)] border border-[var(--border)] bg-[var(--surface-sunken)] p-4"
            aria-label="Mensajes de la conversación"
          >
            <div
              v-for="m in messages"
              :key="m.sequence"
              :class="[
                'max-w-[85%] rounded-[var(--radius-control)] p-3',
                m.senderType === 'operator'
                  ? 'ml-auto bg-neteco-50 text-[var(--text-strong)]'
                  : m.senderType === 'system'
                    ? 'mx-auto text-center text-xs text-[var(--text-muted)]'
                    : 'mr-auto border border-[var(--border)] bg-[var(--surface)] text-[var(--text-strong)]'
              ]"
            >
              <div class="mb-1 text-xs font-medium text-[var(--text-muted)]">{{ m.senderName }}</div>
              <div class="whitespace-pre-wrap break-words">{{ m.message }}</div>
            </div>
          </div>

          <form class="flex flex-wrap gap-2" @submit.prevent="sendReply">
            <input
              v-model="replyText"
              type="text"
              class="adm-input min-w-0 flex-1"
              aria-label="Respuesta al cliente"
              placeholder="Escribe tu respuesta…"
            />
            <button type="submit" class="adm-btn adm-btn--primary">Responder</button>
          </form>

          <div class="grid grid-cols-1 gap-5 border-t border-[var(--border)] pt-4 md:grid-cols-2">
            <div class="adm-stack">
              <AdminFormField v-slot="{ id }" label="Pasar a otro equipo">
                <select :id="id" v-model="handoffDept" class="adm-input">
                  <option value="technical">Técnico</option>
                  <option value="logistics">Logística</option>
                  <option value="sales">Ventas</option>
                  <option value="billing">Facturación</option>
                </select>
              </AdminFormField>
              <AdminFormField v-slot="{ id }" label="Motivo" required>
                <input
                  :id="id"
                  v-model="handoffNote"
                  type="text"
                  class="adm-input"
                  placeholder="Qué necesita el cliente"
                />
              </AdminFormField>
              <div>
                <AdminButton :disabled="!handoffNote.trim()" @click="executeHandoff">Pasar conversación</AdminButton>
              </div>
            </div>

            <div class="adm-stack">
              <AdminFormField
                v-slot="{ id }"
                label="Convertir en consulta"
                help="Para seguir el caso por correo cuando no se resuelve en el chat."
                required
              >
                <input
                  :id="id"
                  v-model="escalateSummary"
                  type="text"
                  class="adm-input"
                  placeholder="Resumen del caso"
                />
              </AdminFormField>
              <div>
                <AdminButton :disabled="!escalateSummary.trim()" @click="executeEscalate"> Crear consulta </AdminButton>
              </div>
            </div>
          </div>
        </div>
      </AdminCard>
    </div>
  </div>
</template>
