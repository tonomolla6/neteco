<script setup lang="ts">
import { onMounted, ref } from 'vue'

interface CommandRow {
  command_id: string
  customer_id: string
  dedup_key: string
  category: string
  event_type: string
  selected_channel: string | null
  priority_order: string
  status: string
  payload_hash: string
  attempts: number
  created_at: string
  updated_at: string
}

interface PreferencesData {
  customerId: string
  email: boolean
  sms: boolean
  whatsapp: boolean
  push: boolean
}

const requestFetch = useRequestFetch()

const loading = ref(true)
const error = ref<string | null>(null)
const successMessage = ref<string | null>(null)
const busy = ref(false)

const commands = ref<CommandRow[]>([])
const total = ref(0)
const filterCategory = ref('')
const filterStatus = ref('')
const filterCustomerId = ref('')

// Dispatch Form
const dispatchCustomerId = ref('')
const dispatchEventType = ref('')
const dispatchCategory = ref('transactional')
const dispatchDedupKey = ref('')
const dispatchPayload = ref('{}')
const dispatchError = ref<string | null>(null)

// Preferences check
const prefCustomerId = ref('')
const customerPrefs = ref<PreferencesData | null>(null)
const prefLoading = ref(false)
const prefError = ref<string | null>(null)

function errorMessage(caught: unknown): string {
  const code = (caught as { data?: { error?: { code?: string } } })?.data?.error?.code
  if (code) return code
  return caught instanceof Error ? caught.message : 'error_inesperado'
}

async function loadLogs() {
  loading.value = true
  error.value = null
  try {
    const params = new URLSearchParams()
    if (filterCategory.value) params.set('category', filterCategory.value)
    if (filterStatus.value) params.set('status', filterStatus.value)
    if (filterCustomerId.value) params.set('customerId', filterCustomerId.value)

    const url = `/api/admin/communications/multichannel/logs${params.toString() ? `?${params.toString()}` : ''}`
    const res = await requestFetch<{ total: number; commands: CommandRow[] }>(url)
    commands.value = res.commands ?? []
    total.value = res.total ?? 0
  } catch (caught) {
    error.value = errorMessage(caught)
  } finally {
    loading.value = false
  }
}

async function handleDispatch() {
  dispatchError.value = null
  successMessage.value = null

  if (!dispatchCustomerId.value || !dispatchEventType.value) {
    dispatchError.value = 'Cliente y tipo de evento son obligatorios'
    return
  }

  let payloadObj: Record<string, unknown> = {}
  try {
    payloadObj = JSON.parse(dispatchPayload.value)
  } catch {
    dispatchError.value = 'El payload debe ser un JSON válido'
    return
  }

  busy.value = true
  try {
    const dedup = dispatchDedupKey.value.trim() || `dispatch-${Date.now()}`
    const idempotencyKey = globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `idem-${Date.now()}`

    await requestFetch('/api/admin/communications/multichannel/dispatch', {
      method: 'POST',
      headers: {
        'Idempotency-Key': idempotencyKey
      },
      body: {
        customerId: dispatchCustomerId.value.trim(),
        dedupKey: dedup,
        category: dispatchCategory.value,
        eventType: dispatchEventType.value.trim(),
        payload: payloadObj
      }
    })

    successMessage.value = 'notificación enviada con éxito'
    dispatchEventType.value = ''
    dispatchPayload.value = '{}'
    await loadLogs()
  } catch (caught) {
    dispatchError.value = errorMessage(caught)
  } finally {
    busy.value = false
  }
}

async function checkPreferences() {
  if (!prefCustomerId.value.trim()) return
  prefLoading.value = true
  prefError.value = null
  customerPrefs.value = null
  try {
    const res = await requestFetch<PreferencesData>(
      `/api/admin/communications/multichannel/preferences/${encodeURIComponent(prefCustomerId.value.trim())}`
    )
    customerPrefs.value = res
  } catch (caught) {
    prefError.value = errorMessage(caught)
  } finally {
    prefLoading.value = false
  }
}

onMounted(() => {
  loadLogs()
})
</script>

<template>
  <div class="space-y-6">
    <header>
      <h1 class="text-2xl font-bold text-slate-900">Comunicaciones multicanal</h1>
      <p class="text-sm text-slate-600">
        Orquestación y registro de entregas multicanal (Email, SMS, WhatsApp, Push) con deduplicación y preferencias de
        cliente.
      </p>
    </header>

    <!-- Global status/alerts -->
    <div v-if="loading" role="status" aria-live="polite" class="text-sm text-slate-500">
      Cargando registros multicanal...
    </div>

    <div v-if="error" role="alert" class="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
      Error: {{ error }}
    </div>

    <div
      v-if="successMessage"
      data-test="success-message"
      role="status"
      aria-live="polite"
      class="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800"
    >
      {{ successMessage }}
    </div>

    <!-- Dispatch & Preferences Accordion/Grid -->
    <div class="grid gap-6 md:grid-cols-2">
      <!-- Dispatch form -->
      <section aria-labelledby="dispatch-heading" class="rounded-xl border border-slate-200 bg-white p-5 shadow-xs">
        <h2 id="dispatch-heading" class="text-base font-semibold text-slate-900">Despachar comunicación manual</h2>
        <form class="mt-4 space-y-3" @submit.prevent="handleDispatch">
          <div>
            <label for="dispatch-customer" class="block text-xs font-medium text-slate-700">ID de Cliente (UUID)</label>
            <input
              id="dispatch-customer"
              v-model="dispatchCustomerId"
              data-test="customer-id"
              type="text"
              required
              class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm"
              placeholder="00000000-0000-0000-0000-000000000000"
            />
          </div>

          <div class="grid grid-cols-2 gap-3">
            <div>
              <label for="dispatch-cat" class="block text-xs font-medium text-slate-700">Categoría</label>
              <select
                id="dispatch-cat"
                v-model="dispatchCategory"
                data-test="category"
                class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm"
              >
                <option value="operational">Operacional</option>
                <option value="transactional">Transaccional</option>
                <option value="marketing">Marketing</option>
                <option value="security">Seguridad</option>
                <option value="urgent">Urgente</option>
              </select>
            </div>
            <div>
              <label for="dispatch-event" class="block text-xs font-medium text-slate-700">Tipo de evento</label>
              <input
                id="dispatch-event"
                v-model="dispatchEventType"
                data-test="event-type"
                type="text"
                required
                class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm"
                placeholder="order.shipped"
              />
            </div>
          </div>

          <div>
            <label for="dispatch-payload" class="block text-xs font-medium text-slate-700">Payload (JSON)</label>
            <textarea
              id="dispatch-payload"
              v-model="dispatchPayload"
              data-test="payload"
              rows="3"
              class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-1.5 font-mono text-xs"
            />
          </div>

          <p v-if="dispatchError" role="alert" class="text-xs text-red-600">{{ dispatchError }}</p>

          <button
            type="button"
            data-test="dispatch-btn"
            :disabled="busy"
            class="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
            @click="handleDispatch"
          >
            {{ busy ? 'Enviando...' : 'Despachar comunicación' }}
          </button>
        </form>
      </section>

      <!-- Customer Preferences Lookup -->
      <section aria-labelledby="prefs-heading" class="rounded-xl border border-slate-200 bg-white p-5 shadow-xs">
        <h2 id="prefs-heading" class="text-base font-semibold text-slate-900">Consultar preferencias por cliente</h2>
        <div class="mt-4 flex gap-2">
          <input
            v-model="prefCustomerId"
            type="text"
            placeholder="UUID del cliente..."
            class="flex-1 rounded-md border border-slate-300 px-3 py-1.5 text-sm"
          />
          <button
            type="button"
            :disabled="prefLoading || !prefCustomerId"
            class="rounded-md bg-slate-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
            @click="checkPreferences"
          >
            {{ prefLoading ? 'Consultando...' : 'Consultar' }}
          </button>
        </div>

        <div v-if="prefError" role="alert" class="mt-3 text-xs text-red-600">
          {{ prefError }}
        </div>

        <div v-if="customerPrefs" class="mt-4 rounded-lg bg-slate-50 p-3 text-xs space-y-1">
          <p><span class="font-medium">Email:</span> {{ customerPrefs.email ? 'Habilitado' : 'Deshabilitado' }}</p>
          <p><span class="font-medium">SMS:</span> {{ customerPrefs.sms ? 'Habilitado' : 'Deshabilitado' }}</p>
          <p>
            <span class="font-medium">WhatsApp:</span> {{ customerPrefs.whatsapp ? 'Habilitado' : 'Deshabilitado' }}
          </p>
          <p><span class="font-medium">Push:</span> {{ customerPrefs.push ? 'Habilitado' : 'Deshabilitado' }}</p>
        </div>
      </section>
    </div>

    <!-- Logs Table -->
    <section aria-labelledby="logs-heading" class="space-y-4">
      <div class="flex flex-wrap items-center justify-between gap-4">
        <h2 id="logs-heading" class="text-lg font-semibold text-slate-900">Historial de orquestación ({{ total }})</h2>
        <div class="flex flex-wrap gap-2 text-xs">
          <select v-model="filterCategory" class="rounded border border-slate-300 px-2 py-1" @change="loadLogs">
            <option value="">Todas las categorías</option>
            <option value="operational">Operacional</option>
            <option value="transactional">Transaccional</option>
            <option value="marketing">Marketing</option>
            <option value="security">Seguridad</option>
            <option value="urgent">Urgente</option>
          </select>
          <select v-model="filterStatus" class="rounded border border-slate-300 px-2 py-1" @change="loadLogs">
            <option value="">Todos los estados</option>
            <option value="delivered">Entregado</option>
            <option value="sent">Enviado</option>
            <option value="suppressed">Suprimido</option>
            <option value="failed">Fallido</option>
          </select>
          <button
            type="button"
            class="rounded bg-slate-100 px-3 py-1 font-medium text-slate-700 hover:bg-slate-200"
            @click="loadLogs"
          >
            Refrescar
          </button>
        </div>
      </div>

      <!-- Empty state -->
      <div
        v-if="!loading && commands.length === 0"
        data-test="empty-state"
        class="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500"
      >
        No hay comunicaciones registradas con los filtros actuales.
      </div>

      <!-- Table -->
      <div v-else-if="commands.length > 0" class="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table class="min-w-full divide-y divide-slate-200 text-left text-xs">
          <thead class="bg-slate-50 font-medium text-slate-600">
            <tr>
              <th scope="col" class="px-4 py-2.5">Fecha</th>
              <th scope="col" class="px-4 py-2.5">Evento / Dedup</th>
              <th scope="col" class="px-4 py-2.5">Cliente</th>
              <th scope="col" class="px-4 py-2.5">Canal</th>
              <th scope="col" class="px-4 py-2.5">Estado</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-100">
            <tr v-for="cmd in commands" :key="cmd.command_id" class="hover:bg-slate-50">
              <td class="whitespace-nowrap px-4 py-2 text-slate-500">
                {{ new Date(cmd.created_at).toLocaleString('es-ES') }}
              </td>
              <td class="px-4 py-2">
                <span class="font-medium text-slate-900">{{ cmd.event_type }}</span>
                <span class="block font-mono text-[11px] text-slate-400">{{ cmd.dedup_key }}</span>
              </td>
              <td class="whitespace-nowrap px-4 py-2 font-mono text-slate-600">{{ cmd.customer_id.slice(0, 8) }}...</td>
              <td class="whitespace-nowrap px-4 py-2">
                <span class="rounded bg-slate-100 px-2 py-0.5 font-medium text-slate-700">
                  {{ cmd.selected_channel ?? 'ninguno' }}
                </span>
              </td>
              <td class="whitespace-nowrap px-4 py-2">
                <span
                  class="inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold"
                  :class="{
                    'bg-emerald-50 text-emerald-700': cmd.status === 'delivered' || cmd.status === 'sent',
                    'bg-amber-50 text-amber-700': cmd.status === 'suppressed',
                    'bg-red-50 text-red-700': cmd.status === 'failed'
                  }"
                >
                  {{ cmd.status }}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>
