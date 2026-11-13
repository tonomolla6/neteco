<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'

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
    dispatchError.value = 'Los datos del mensaje deben estar en formato JSON válido'
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

    successMessage.value = 'Comunicación enviada correctamente (notificación enviada).'
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

// Estado de interfaz y etiquetas legibles.
const dispatchOpen = ref(false)
const prefsOpen = ref(false)
const search = ref('')
const CATEGORIES: Record<string, string> = {
  operational: 'Operativa',
  transactional: 'De pedido',
  marketing: 'Comercial',
  security: 'Seguridad',
  urgent: 'Urgente'
}
const CHANNELS: Record<string, string> = { email: 'Correo', sms: 'SMS', whatsapp: 'WhatsApp', push: 'Notificación' }
const STATUSES: Record<string, [string, 'success' | 'warning' | 'danger' | 'neutral']> = {
  delivered: ['Entregado', 'success'],
  sent: ['Enviado', 'success'],
  suppressed: ['No enviado', 'warning'],
  failed: ['Fallido', 'danger']
}
const statusOptions = [
  { value: '', label: 'Todos' },
  { value: 'delivered', label: 'Entregados' },
  { value: 'sent', label: 'Enviados' },
  { value: 'suppressed', label: 'No enviados' },
  { value: 'failed', label: 'Fallidos' }
]
const rows = computed(() => {
  const term = search.value.toLowerCase()
  return term
    ? commands.value.filter((cmd) =>
        [cmd.event_type, cmd.dedup_key, cmd.customer_id].some((value) => value.toLowerCase().includes(term))
      )
    : commands.value
})
const columns = [
  { key: 'created_at', label: 'Fecha', sortable: true },
  { key: 'event_type', label: 'Mensaje' },
  { key: 'customer_id', label: 'Cliente', hideOnMobile: true },
  { key: 'category', label: 'Tipo', hideOnMobile: true },
  { key: 'selected_channel', label: 'Canal' },
  { key: 'status', label: 'Estado' }
]
const filtered = computed(() => !!(search.value || filterCategory.value || filterStatus.value))
// Los filtros de servidor recargan el historial al cambiar; la búsqueda filtra lo ya cargado.
watch([filterCategory, filterStatus], () => void loadLogs())
watch(successMessage, (message) => {
  if (message) dispatchOpen.value = false
})
function clearFilters() {
  search.value = ''
  filterCategory.value = ''
  filterStatus.value = ''
}
const prefChannels = computed(() =>
  customerPrefs.value
    ? ([
        ['Correo', customerPrefs.value.email],
        ['SMS', customerPrefs.value.sms],
        ['WhatsApp', customerPrefs.value.whatsapp],
        ['Notificación', customerPrefs.value.push]
      ] as Array<[string, boolean]>)
    : []
)
</script>

<template>
  <div class="adm-stack">
    <AdminPageActions>
      <AdminButton icon="i-lucide-user-round-check" @click="prefsOpen = true">Preferencias de un cliente</AdminButton>
      <AdminButton variant="primary" icon="i-lucide-send" @click="dispatchOpen = true">Enviar comunicación</AdminButton>
    </AdminPageActions>

    <p v-if="loading" role="status" aria-live="polite" class="sr-only">Cargando comunicaciones…</p>

    <UAlert
      v-if="error"
      role="alert"
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      title="No se han podido cargar las comunicaciones"
      :description="error"
    >
      <template #actions>
        <button type="button" class="adm-btn adm-btn--secondary adm-btn--sm" @click="loadLogs">Reintentar</button>
      </template>
    </UAlert>

    <div v-if="successMessage" data-test="success-message" role="status" aria-live="polite">
      <UAlert color="success" variant="subtle" icon="i-lucide-circle-check" :title="successMessage" />
    </div>

    <div v-if="!loading && commands.length === 0 && !error" data-test="empty-state" class="adm-card">
      <div class="adm-tablecard__bar">
        <AdminToolbar :searchable="false">
          <select v-model="filterCategory" class="adm-input" aria-label="Tipo de comunicación">
            <option value="">Todos los tipos</option>
            <option v-for="(label, value) in CATEGORIES" :key="value" :value="value">{{ label }}</option>
          </select>
          <AdminFilters v-model="filterStatus" :options="statusOptions" label="Filtrar por estado" />
        </AdminToolbar>
      </div>
      <AdminEmptyState
        :variant="filtered ? 'filtered' : 'empty'"
        icon="i-lucide-messages-square"
        title="No hay comunicaciones registradas con los filtros actuales."
        :description="filtered ? 'Prueba con otro filtro.' : 'Cuando se envíe un aviso a un cliente aparecerá aquí.'"
      >
        <AdminButton v-if="filtered" @click="clearFilters">Quitar filtros</AdminButton>
      </AdminEmptyState>
    </div>

    <AdminTable
      v-else-if="!error || commands.length > 0"
      :rows="rows"
      :columns="columns"
      :row-key="(cmd) => cmd.command_id"
      :status="loading ? 'pending' : 'idle'"
      :filtered="filtered"
      caption="Historial de comunicaciones enviadas"
      @clear-filters="clearFilters"
    >
      <template #toolbar>
        <AdminToolbar v-model:search="search" placeholder="Buscar por mensaje o cliente…">
          <select v-model="filterCategory" class="adm-input" aria-label="Tipo de comunicación">
            <option value="">Todos los tipos</option>
            <option v-for="(label, value) in CATEGORIES" :key="value" :value="value">{{ label }}</option>
          </select>
          <AdminFilters v-model="filterStatus" :options="statusOptions" label="Filtrar por estado" />
          <template #actions>
            <span class="adm-help">{{ total }} en total</span>
            <AdminButton size="sm" icon="i-lucide-rotate-cw" @click="loadLogs">Actualizar</AdminButton>
          </template>
        </AdminToolbar>
      </template>
      <template #cell-created_at="{ row }">
        <span class="whitespace-nowrap">{{ adminDate(row.created_at, true) }}</span>
      </template>
      <template #cell-event_type="{ row }">
        <span class="font-medium text-[var(--text-strong)]">{{ row.event_type }}</span>
        <span class="adm-help block">{{ row.dedup_key }}</span>
      </template>
      <template #cell-customer_id="{ row }">#{{ row.customer_id.slice(0, 8).toUpperCase() }}</template>
      <template #cell-category="{ row }">{{ CATEGORIES[row.category] ?? adminHumanize(row.category) }}</template>
      <template #cell-selected_channel="{ row }">
        {{ row.selected_channel ? (CHANNELS[row.selected_channel] ?? row.selected_channel) : 'Ninguno' }}
      </template>
      <template #cell-status="{ row }">
        <AdminBadge :tone="STATUSES[row.status]?.[1] ?? 'neutral'">
          {{ STATUSES[row.status]?.[0] ?? adminHumanize(row.status) }}
        </AdminBadge>
      </template>
    </AdminTable>

    <AdminDrawer
      v-model:open="dispatchOpen"
      title="Enviar comunicación"
      description="Envía un aviso puntual a un cliente por el canal que tenga permitido."
    >
      <form id="multichannel-dispatch-form" class="adm-stack" @submit.prevent="handleDispatch">
        <UAlert v-if="dispatchError" role="alert" color="error" variant="subtle" :title="dispatchError" />
        <AdminFormField label="Identificador de cliente" for="dispatch-customer" required>
          <input
            id="dispatch-customer"
            v-model="dispatchCustomerId"
            data-test="customer-id"
            type="text"
            required
            placeholder="00000000-0000-0000-0000-000000000000"
          />
        </AdminFormField>
        <div class="adm-form-grid">
          <AdminFormField label="Tipo de comunicación" for="dispatch-cat">
            <select id="dispatch-cat" v-model="dispatchCategory" data-test="category">
              <option v-for="(label, value) in CATEGORIES" :key="value" :value="value">{{ label }}</option>
            </select>
          </AdminFormField>
          <AdminFormField label="Mensaje que se envía" for="dispatch-event" help="Por ejemplo: order.shipped" required>
            <input
              id="dispatch-event"
              v-model="dispatchEventType"
              data-test="event-type"
              type="text"
              required
              placeholder="order.shipped"
            />
          </AdminFormField>
        </div>
        <AdminFormField
          label="Datos del mensaje (JSON)"
          for="dispatch-payload"
          help="Valores que rellenan la plantilla, por ejemplo el número de seguimiento."
        >
          <textarea id="dispatch-payload" v-model="dispatchPayload" data-test="payload" rows="4" class="font-mono" />
        </AdminFormField>
      </form>
      <template #footer>
        <AdminButton @click="dispatchOpen = false">Cancelar</AdminButton>
        <button
          type="button"
          data-test="dispatch-btn"
          class="adm-btn adm-btn--primary"
          :disabled="busy"
          @click="handleDispatch"
        >
          {{ busy ? 'Enviando…' : 'Enviar comunicación' }}
        </button>
      </template>
    </AdminDrawer>

    <AdminDrawer
      v-model:open="prefsOpen"
      title="Preferencias de un cliente"
      description="Consulta por qué canales acepta recibir comunicaciones."
    >
      <div class="adm-stack">
        <form class="flex flex-wrap items-end gap-2" @submit.prevent="checkPreferences">
          <div class="adm-field min-w-0 flex-1">
            <label for="prefs-customer" class="adm-label">Identificador de cliente</label>
            <input
              id="prefs-customer"
              v-model="prefCustomerId"
              type="text"
              placeholder="00000000-0000-0000-0000-000000000000"
            />
          </div>
          <button type="submit" class="adm-btn adm-btn--primary" :disabled="prefLoading || !prefCustomerId">
            {{ prefLoading ? 'Consultando…' : 'Consultar' }}
          </button>
        </form>
        <UAlert
          v-if="prefError"
          role="alert"
          color="error"
          variant="subtle"
          title="No se han podido consultar las preferencias"
          :description="prefError"
        />
        <ul
          v-if="customerPrefs"
          class="divide-y divide-[var(--border)] rounded-[var(--radius-surface)] border border-[var(--border)]"
        >
          <li v-for="[name, enabled] in prefChannels" :key="name" class="flex items-center justify-between px-4 py-3">
            <span class="font-medium text-[var(--text-strong)]">{{ name }}</span>
            <AdminBadge :tone="enabled ? 'success' : 'neutral'">{{
              enabled ? 'Permitido' : 'No permitido'
            }}</AdminBadge>
          </li>
        </ul>
      </div>
    </AdminDrawer>
  </div>
</template>
