<script setup lang="ts">
import { ref, onMounted } from 'vue'
import type { LiveChatSessionRecord, LiveChatMessageRecord } from '../../workers/support/live-chat'

const props = defineProps<{
  contextUrl?: string
  productSlug?: string
  orderReference?: string
}>()

const requestFetch = useRequestFetch()

interface AvailabilityData {
  isOpen: boolean
  schedule?: string
  timezone?: string
  nextOpeningAt?: string
  operatingHours?: {
    schedule: string
    timezone: string
  }
  queue: {
    length: number
    estimatedWaitSeconds: number
  }
  disclaimer: string
}

const loading = ref(true)
const error = ref<string | null>(null)
const availability = ref<AvailabilityData | null>(null)

const session = ref<LiveChatSessionRecord | null>(null)
const messages = ref<LiveChatMessageRecord[]>([])
const messageInput = ref('')
const sendingMessage = ref(false)

const consentGiven = ref(false)
const customerName = ref('')
const initialMessage = ref('')
const department = ref<'general' | 'technical' | 'logistics' | 'sales' | 'billing'>('general')

const policyHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

async function fetchAvailability() {
  loading.value = true
  error.value = null
  try {
    const res = await requestFetch<AvailabilityData>('/api/support/live-chat/availability')
    availability.value = res
  } catch {
    error.value = 'No se ha podido comprobar la disponibilidad del chat.'
  } finally {
    loading.value = false
  }
}

async function startSession() {
  if (!consentGiven.value) {
    error.value = 'Es necesario otorgar el consentimiento para iniciar el chat.'
    return
  }

  loading.value = true
  error.value = null

  try {
    const res = await $fetch<{ session: LiveChatSessionRecord }>('/api/support/live-chat/sessions', {
      method: 'POST',
      body: {
        consentGiven: true,
        consentPolicyHash: policyHash,
        department: department.value,
        customerName: customerName.value.trim() || undefined,
        initialMessage: initialMessage.value.trim() || undefined,
        context: {
          url: props.contextUrl,
          productSlug: props.productSlug,
          orderReference: props.orderReference
        }
      }
    })

    session.value = res.session
    if (initialMessage.value.trim()) {
      messages.value.push({
        id: crypto.randomUUID(),
        sessionId: res.session.id,
        sequence: 1,
        senderType: 'customer',
        senderId: null,
        senderName: customerName.value.trim() || 'Cliente',
        isHuman: 1,
        message: initialMessage.value.trim(),
        createdAt: new Date().toISOString()
      })
    }
  } catch (err: unknown) {
    const dataObj =
      typeof err === 'object' && err !== null && 'data' in err
        ? (err as { data?: { error?: { code?: string } } }).data
        : undefined
    if (dataObj?.error?.code === 'outside_business_hours') {
      error.value = 'El servicio de chat se encuentra fuera de horario de atención.'
    } else {
      error.value = 'Error al iniciar la sesión de chat con el operador humano.'
    }
  } finally {
    loading.value = false
  }
}

async function sendMessage() {
  if (!messageInput.value.trim() || !session.value) return
  const text = messageInput.value.trim()
  messageInput.value = ''
  sendingMessage.value = true

  try {
    const res = await $fetch<{ message: LiveChatMessageRecord }>(
      `/api/support/live-chat/sessions/${session.value.id}/messages`,
      {
        method: 'POST',
        body: {
          message: text,
          senderName: customerName.value.trim() || 'Cliente'
        }
      }
    )
    messages.value.push(res.message)
  } catch {
    error.value = 'Error al enviar el mensaje. Inténtelo de nuevo.'
  } finally {
    sendingMessage.value = false
  }
}

async function downloadTranscript() {
  if (!session.value) return
  try {
    const res = await requestFetch<{
      transcript: { sessionId: string; sessionRef: string; messages: LiveChatMessageRecord[] }
    }>(`/api/support/live-chat/sessions/${session.value.id}/transcript`)
    const blob = new Blob([JSON.stringify(res.transcript, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `transcript-${session.value.publicRef}.json`
    a.click()
    URL.revokeObjectURL(url)
  } catch {
    error.value = 'No se ha podido descargar el transcript.'
  }
}

onMounted(() => {
  void fetchAvailability()
})
</script>

<template>
  <div class="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
    <!-- Header -->
    <div class="mb-4 flex items-center justify-between border-b border-slate-100 pb-3">
      <div>
        <h2 class="text-lg font-semibold text-slate-900">Chat de soporte y atención humana</h2>
        <p class="text-xs text-emerald-700 font-medium mt-0.5">
          Atención exclusivamente humana por el equipo de Neteco. No utilizamos bots simulando ser personas.
        </p>
      </div>
      <span
        v-if="availability?.isOpen"
        class="inline-flex items-center rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700"
      >
        <span class="mr-1.5 h-2 w-2 rounded-full bg-emerald-500"></span>
        Operadores disponibles
      </span>
      <span
        v-else
        class="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600"
      >
        Horario cerrado
      </span>
    </div>

    <!-- Error notice -->
    <div v-if="error" class="mb-4 rounded-lg bg-rose-50 p-3 text-sm text-rose-800" role="alert">
      {{ error }}
    </div>

    <!-- Closed state notice -->
    <div
      v-if="availability && !availability.isOpen && !session"
      class="mb-4 rounded-lg bg-amber-50 p-4 border border-amber-200 text-sm text-amber-900"
    >
      <div class="font-semibold mb-1">Fuera de horario de atención</div>
      <p class="text-amber-800">
        Nuestro equipo humano atiende de
        {{ availability.operatingHours?.schedule || availability.schedule || 'L-V 08:00 - 18:00' }}.
      </p>
      <p v-if="availability.nextOpeningAt" class="mt-1 text-xs text-amber-700">
        Próxima apertura: {{ new Date(availability.nextOpeningAt).toLocaleString('es-ES') }}
      </p>
    </div>

    <!-- Form state (no active session yet) -->
    <form v-if="!session" class="space-y-4" @submit.prevent="startSession">
      <div v-if="availability?.isOpen" class="rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
        <span class="font-medium text-slate-700">Estado de la cola:</span>
        {{ availability.queue.length }} personas en espera (tiempo estimado: ~{{
          Math.ceil(availability.queue.estimatedWaitSeconds / 60)
        }}
        min).
      </div>

      <div>
        <label for="chat-name" class="block text-xs font-medium text-slate-700">Tu nombre o empresa</label>
        <input
          id="chat-name"
          v-model="customerName"
          name="customerName"
          type="text"
          class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          placeholder="Nombre de contacto"
        />
      </div>

      <div>
        <label for="chat-dept" class="block text-xs font-medium text-slate-700">Departamento</label>
        <select
          id="chat-dept"
          v-model="department"
          class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
        >
          <option value="general">Atención General</option>
          <option value="technical">Soporte Técnico Químico</option>
          <option value="sales">Comercial y Presupuestos</option>
          <option value="logistics">Envíos y Logística</option>
          <option value="billing">Facturación</option>
        </select>
      </div>

      <div>
        <label for="chat-msg" class="block text-xs font-medium text-slate-700">Consulta inicial</label>
        <textarea
          id="chat-msg"
          v-model="initialMessage"
          rows="2"
          class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          placeholder="Escribe brevemente el motivo de tu consulta..."
        ></textarea>
      </div>

      <!-- Consent check -->
      <div class="flex items-start">
        <input
          id="chat-consent"
          v-model="consentGiven"
          type="checkbox"
          class="mt-0.5 h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
        />
        <label for="chat-consent" class="ml-2 text-xs text-slate-600">
          Acepto el tratamiento de mis datos y el registro del transcript conforme a la política de privacidad de
          Neteco.
        </label>
      </div>

      <button
        type="submit"
        :disabled="loading || !availability?.isOpen || !consentGiven"
        class="w-full rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-300 transition-colors"
      >
        <span v-if="loading">Conectando...</span>
        <span v-else>Iniciar chat con operador humano</span>
      </button>
    </form>

    <!-- Active Chat Session -->
    <div v-else class="space-y-4">
      <div class="flex items-center justify-between rounded-lg bg-indigo-50 p-3 text-xs text-indigo-900">
        <div>
          <span class="font-bold">Referencia:</span> {{ session.publicRef }}
          <span class="ml-2">({{ session.department }})</span>
        </div>
        <div v-if="session.status === 'waiting_operator'" class="text-amber-800 font-medium">
          Posición en cola: {{ session.queuePosition }} (Tiempo estimado: ~{{
            Math.ceil((session.estimatedWaitSeconds || 120) / 60)
          }}
          min)
        </div>
        <div v-else-if="session.status === 'in_progress'" class="text-emerald-800 font-medium">
          Atendido por: {{ session.operatorName || 'Operador humano' }}
        </div>
        <div v-else class="text-slate-600 font-medium">Estado: {{ session.status }}</div>
      </div>

      <!-- Messages Window -->
      <div class="h-64 overflow-y-auto rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-3">
        <div
          v-for="msg in messages"
          :key="msg.sequence"
          :class="[
            'max-w-[85%] rounded-lg p-3 text-sm shadow-sm',
            msg.senderType === 'customer'
              ? 'ml-auto bg-indigo-600 text-white'
              : msg.senderType === 'system'
                ? 'mx-auto bg-slate-200 text-slate-700 text-xs italic text-center'
                : 'mr-auto bg-white text-slate-900 border border-slate-200'
          ]"
        >
          <div class="mb-1 flex items-center justify-between text-xs opacity-75">
            <span class="font-medium">{{ msg.senderName }}</span>
            <span v-if="msg.isHuman" class="ml-2 font-semibold text-[10px] uppercase tracking-wider">Humano</span>
          </div>
          <div class="whitespace-pre-wrap">{{ msg.message }}</div>
        </div>
      </div>

      <!-- Message input -->
      <form class="flex gap-2" @submit.prevent="sendMessage">
        <input
          v-model="messageInput"
          type="text"
          class="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          placeholder="Escribe tu mensaje al operador humano..."
          :disabled="sendingMessage || ['resolved', 'closed', 'escalated_ticket'].includes(session.status)"
        />
        <button
          type="submit"
          :disabled="
            sendingMessage ||
            !messageInput.trim() ||
            ['resolved', 'closed', 'escalated_ticket'].includes(session.status)
          "
          class="rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:bg-slate-300"
        >
          Enviar
        </button>
      </form>

      <!-- Transcript download -->
      <div class="flex justify-end pt-2 border-t border-slate-100">
        <button
          type="button"
          class="text-xs text-indigo-600 hover:text-indigo-800 font-medium"
          @click="downloadTranscript"
        >
          Descargar copia íntegra del transcript
        </button>
      </div>
    </div>
  </div>
</template>
