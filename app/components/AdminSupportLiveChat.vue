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

const operatorName = ref('Operador Soporte')
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
    error.value = 'No se ha podido cargar la cola de chats en espera.'
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
    error.value = 'No se ha podido reclamar la sesión de chat (posible conflicto CAS).'
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
    error.value = 'Error al enviar el mensaje de respuesta.'
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
    error.value = 'Error al realizar el handoff del chat.'
  }
}

async function executeEscalate() {
  if (!activeSession.value || !escalateSummary.value.trim()) return
  try {
    await $fetch(`/api/admin/support/live-chat/sessions/${activeSession.value.id}/escalate`, {
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
    error.value = 'Error al escalar el chat a ticket oficial.'
  }
}

async function executeClose() {
  if (!activeSession.value) return
  try {
    await $fetch(`/api/admin/support/live-chat/sessions/${activeSession.value.id}/close`, {
      method: 'POST',
      body: {
        expectedVersion: activeSession.value.currentVersion,
        closureReason: closeReason.value
      }
    })
    activeSession.value = null
    await fetchQueue()
  } catch {
    error.value = 'Error al cerrar la sesión de chat.'
  }
}

onMounted(() => {
  void fetchQueue()
})
</script>

<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between border-b border-slate-200 pb-4">
      <div>
        <h1 class="text-2xl font-bold text-slate-900">Panel de Chat Humano (SUP-011)</h1>
        <p class="text-sm text-slate-500">Gestión de colas, atención con contexto y handoff sin simulación de bots.</p>
      </div>
      <button
        type="button"
        class="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
        @click="fetchQueue"
      >
        Actualizar cola
      </button>
    </div>

    <div v-if="error" class="rounded-lg bg-rose-50 p-4 text-sm text-rose-800" role="alert">
      {{ error }}
    </div>

    <div class="grid grid-cols-1 gap-6 lg:grid-cols-3">
      <!-- Waiting queue column -->
      <div class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h2 class="text-base font-semibold text-slate-900 mb-3 flex items-center justify-between">
          <span>Cola de espera</span>
          <span class="rounded-full bg-indigo-100 px-2.5 py-0.5 text-xs font-bold text-indigo-800">{{
            queue.length
          }}</span>
        </h2>

        <div v-if="queue.length === 0" class="text-center py-8 text-sm text-slate-500">
          No hay chats en cola de espera actualmente.
        </div>

        <ul v-else class="divide-y divide-slate-100 space-y-3">
          <li v-for="s in queue" :key="s.id" class="pt-3 first:pt-0">
            <div class="flex items-start justify-between">
              <div>
                <span class="font-bold text-xs text-indigo-600">{{ s.publicRef }}</span>
                <span
                  class="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] uppercase font-semibold text-slate-600"
                >
                  {{ s.department }}
                </span>
                <div v-if="s.context?.productSlug" class="text-xs text-slate-600 mt-0.5">
                  Producto: <span class="font-medium">{{ s.context.productSlug }}</span>
                </div>
                <div v-if="s.context?.orderReference" class="text-xs text-slate-600">
                  Pedido: <span class="font-medium">{{ s.context.orderReference }}</span>
                </div>
              </div>
              <button
                type="button"
                class="rounded bg-indigo-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-indigo-700"
                @click="claimSession(s)"
              >
                Atender
              </button>
            </div>
          </li>
        </ul>
      </div>

      <!-- Active conversation area -->
      <div class="lg:col-span-2 rounded-xl border border-slate-200 bg-white p-4 shadow-sm space-y-4">
        <div v-if="!activeSession" class="text-center py-16 text-sm text-slate-400">
          Selecciona una sesión de la cola para comenzar a atender.
        </div>

        <div v-else class="space-y-4">
          <div class="flex items-center justify-between border-b border-slate-100 pb-3">
            <div>
              <span class="text-xs text-slate-500 uppercase font-bold tracking-wider">Conversación activa</span>
              <h3 class="text-base font-bold text-slate-900">{{ activeSession.publicRef }}</h3>
            </div>
            <div class="flex items-center gap-2">
              <button
                type="button"
                class="rounded bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-200"
                @click="executeClose"
              >
                Cerrar chat
              </button>
            </div>
          </div>

          <!-- Messages stream -->
          <div class="h-72 overflow-y-auto rounded-lg border border-slate-200 bg-slate-50 p-4 space-y-3">
            <div
              v-for="m in messages"
              :key="m.sequence"
              :class="[
                'max-w-[85%] rounded-lg p-3 text-sm shadow-sm',
                m.senderType === 'operator'
                  ? 'ml-auto bg-indigo-600 text-white'
                  : m.senderType === 'system'
                    ? 'mx-auto bg-slate-200 text-slate-700 text-xs italic text-center'
                    : 'mr-auto bg-white text-slate-900 border border-slate-200'
              ]"
            >
              <div class="mb-1 text-xs opacity-75 font-medium">{{ m.senderName }}</div>
              <div class="whitespace-pre-wrap">{{ m.message }}</div>
            </div>
          </div>

          <!-- Reply form -->
          <form class="flex gap-2" @submit.prevent="sendReply">
            <input
              v-model="replyText"
              type="text"
              class="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              placeholder="Escribe respuesta como operador humano..."
            />
            <button
              type="submit"
              class="rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700"
            >
              Responder
            </button>
          </form>

          <!-- Handoff & Escalate controls -->
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4 pt-3 border-t border-slate-100">
            <!-- Handoff form -->
            <div class="rounded-lg bg-slate-50 p-3 space-y-2">
              <span class="text-xs font-bold text-slate-700 block">Transferir / Handoff</span>
              <div class="flex gap-2">
                <select v-model="handoffDept" class="rounded border border-slate-300 px-2 py-1 text-xs">
                  <option value="technical">Técnico</option>
                  <option value="logistics">Logística</option>
                  <option value="sales">Ventas</option>
                  <option value="billing">Facturación</option>
                </select>
                <input
                  v-model="handoffNote"
                  type="text"
                  placeholder="Motivo de handoff"
                  class="flex-1 rounded border border-slate-300 px-2 py-1 text-xs"
                />
              </div>
              <button
                type="button"
                class="w-full rounded bg-slate-700 px-2 py-1 text-xs font-semibold text-white hover:bg-slate-800"
                @click="executeHandoff"
              >
                Transferir chat
              </button>
            </div>

            <!-- Escalate to Ticket -->
            <div class="rounded-lg bg-slate-50 p-3 space-y-2">
              <span class="text-xs font-bold text-slate-700 block">Escalar a Ticket oficial</span>
              <input
                v-model="escalateSummary"
                type="text"
                placeholder="Resumen para ticket SOP"
                class="w-full rounded border border-slate-300 px-2 py-1 text-xs"
              />
              <button
                type="button"
                class="w-full rounded bg-amber-600 px-2 py-1 text-xs font-semibold text-white hover:bg-amber-700"
                @click="executeEscalate"
              >
                Escalar a ticket formal
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
