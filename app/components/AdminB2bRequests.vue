<script setup lang="ts">
import { b2bNextStatus, type B2bKind, type B2bStatus } from '~~/shared/support-insights'
import { randomId } from '../utils/uuid'
import { B2B_KIND_LABELS, B2B_STATUS_LABELS, SLA_LABELS, formatInstant } from '../utils/support-insights-labels'

/** Cola de solicitudes de empresas ordenada por plazo, con las acciones auditadas del flujo. */
interface Item {
  id: string
  publicRef: string
  kind: B2bKind
  subject: string
  status: B2bStatus
  slaDueAt: string
  slaState: string
  version: number
  companyName: string
}
interface Detail {
  request: Item & { details: Record<string, unknown>; orderId: string | null }
  events: Array<{
    seq: number
    actorType: string
    action: string
    toStatus: string
    note: string | null
    createdAt: string
  }>
  documents: Array<{ id: string; kind: string; fileName: string; scanStatus: string }>
}
const request = useRequestFetch()
const state = ref<'loading' | 'ready' | 'error'>('loading'),
  notice = ref(''),
  busy = ref(false)
const items = ref<Item[]>([]),
  detail = ref<Detail | null>(null),
  note = ref('')
const filters = reactive({ kind: '', status: '', sla: '' })
const NOTE_REQUIRED = ['request_info', 'reject', 'reply']
const ACTION_LABELS: Record<string, string> = {
  start_review: 'Iniciar revisión',
  request_info: 'Pedir información',
  approve: 'Aprobar',
  reject: 'Rechazar',
  resolve: 'Resolver',
  reply: 'Responder',
  assign: 'Asignármela'
}
const actions = computed(() => {
  const d = detail.value?.request
  if (!d) return []
  const open = ['submitted', 'in_review', 'waiting_customer'].includes(d.status)
  const workflow = ['start_review', 'request_info', 'approve', 'reject', 'resolve'].filter(
    (a) => b2bNextStatus(d.status, a, d.kind) !== null
  )
  return [...workflow, ...(open ? ['reply', 'assign'] : [])]
})
async function load() {
  state.value = 'loading'
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v)
  try {
    items.value = (
      (await request(`/api/admin/support/b2b-requests${params.size ? `?${params}` : ''}`)) as { items: Item[] }
    ).items
    state.value = 'ready'
  } catch {
    state.value = 'error'
  }
}
async function open(id: string) {
  notice.value = ''
  note.value = ''
  try {
    detail.value = (await request(`/api/admin/support/b2b-requests/${id}`)) as Detail
  } catch {
    notice.value = 'No se pudo abrir la solicitud.'
  }
}
async function run(action: string) {
  if (!detail.value) return
  busy.value = true
  notice.value = ''
  const id = detail.value.request.id
  try {
    await request<unknown, string>(`/api/admin/support/b2b-requests/${id}/commands`, {
      method: 'POST',
      headers: { 'idempotency-key': randomId() },
      body: {
        action,
        expectedVersion: detail.value.request.version,
        ...(note.value.trim() ? { note: note.value.trim() } : {})
      }
    })
    note.value = ''
    await Promise.all([load(), open(id)])
  } catch (error) {
    const code = (error as { data?: { error?: { code?: string } } })?.data?.error?.code
    notice.value =
      code === 'concurrency_conflict'
        ? 'La solicitud ha cambiado. Se ha recargado.'
        : 'La acción no es válida en el estado actual.'
    if (code === 'concurrency_conflict') await open(id)
  } finally {
    busy.value = false
  }
}
onMounted(load)

/* --- Presentación --- */
const STATUS_LABELS: Record<string, string> = { ...B2B_STATUS_LABELS, waiting_customer: 'Esperando al cliente' }
const STATUS_TONES: Record<string, 'neutral' | 'success' | 'warning' | 'danger' | 'info'> = {
  submitted: 'info',
  in_review: 'warning',
  waiting_customer: 'neutral',
  approved: 'success',
  rejected: 'danger',
  resolved: 'success',
  cancelled: 'neutral'
}
const SLA_TONES: Record<string, 'neutral' | 'success' | 'warning' | 'danger' | 'info'> = {
  on_track: 'success',
  at_risk: 'warning',
  met: 'neutral',
  breached: 'danger'
}
const DETAIL_LABELS: Record<string, string> = {
  lines: 'Productos',
  deliveryNote: 'Nota de entrega',
  productName: 'Producto',
  brand: 'Marca',
  intendedUse: 'Uso previsto',
  estimatedMonthlyUnits: 'Unidades al mes (estimación)',
  hasSafetyDataSheet: 'Tiene ficha de seguridad',
  documentType: 'Tipo de documento',
  productSlug: 'Producto',
  reason: 'Motivo',
  requestedLimitCents: 'Límite solicitado',
  paymentTermDays: 'Plazo de pago',
  justification: 'Justificación',
  claimType: 'Tipo de reclamación',
  description: 'Descripción',
  affectedUnits: 'Unidades afectadas'
}
const DETAIL_VALUES: Record<string, string> = {
  safety_data_sheet: 'Ficha de seguridad',
  technical_sheet: 'Ficha técnica',
  certificate: 'Certificado',
  invoice_copy: 'Copia de factura',
  other: 'Otro',
  damaged: 'Producto dañado',
  missing: 'Falta producto',
  wrong_item: 'Producto equivocado',
  billing: 'Facturación',
  quality: 'Calidad'
}
const SCAN_LABELS: Record<string, string> = {
  pending: 'Pendiente de análisis',
  clean: 'Sin amenazas',
  infected: 'Archivo peligroso'
}
function detailValue(key: string, value: unknown): string {
  if (typeof value === 'boolean') return value ? 'Sí' : 'No'
  if (key === 'requestedLimitCents' && typeof value === 'number') return adminMoney(value)
  if (key === 'paymentTermDays') return `${String(value)} días`
  if (key === 'lines' && Array.isArray(value))
    return value
      .map((line) => {
        const entry = line as { productSlug?: unknown; quantity?: unknown }
        return `${String(entry.quantity ?? '')} × ${String(entry.productSlug ?? '')}`
      })
      .join(', ')
  if (typeof value === 'string') return DETAIL_VALUES[value] ?? value
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}
const columns = [
  { key: 'companyName', label: 'Empresa' },
  { key: 'kind', label: 'Tipo' },
  { key: 'status', label: 'Estado' },
  { key: 'slaDueAt', label: 'Plazo de respuesta' }
]
const filtered = computed(() => Boolean(filters.kind || filters.status || filters.sla))
function clearFilters() {
  filters.kind = ''
  filters.status = ''
  filters.sla = ''
  void load()
}
</script>

<template>
  <section class="adm-stack">
    <UAlert
      v-if="state === 'error'"
      role="alert"
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      title="No se han podido cargar las solicitudes"
      description="Comprueba la conexión y vuelve a intentarlo."
    >
      <template #actions>
        <AdminButton size="sm" icon="i-lucide-rotate-cw" @click="load">Reintentar</AdminButton>
      </template>
    </UAlert>
    <UAlert
      v-else-if="notice && !detail"
      role="status"
      color="warning"
      variant="subtle"
      icon="i-lucide-info"
      :title="notice"
    />

    <AdminTable
      v-if="state !== 'error'"
      :rows="items"
      :columns="columns"
      :row-key="(row) => row.id"
      :status="state === 'loading' ? 'pending' : 'idle'"
      :filtered="filtered"
      empty-title="No hay solicitudes de empresas"
      empty-description="Las peticiones de presupuesto, crédito, documentación y reclamaciones aparecerán aquí."
      @clear-filters="clearFilters"
    >
      <template #toolbar>
        <form class="adm-toolbar" role="search" @submit.prevent="load">
          <select v-model="filters.kind" aria-label="Tipo">
            <option value="">Todos los tipos</option>
            <option v-for="(label, value) in B2B_KIND_LABELS" :key="value" :value="value">{{ label }}</option>
          </select>
          <select v-model="filters.status" aria-label="Estado">
            <option value="">Todos los estados</option>
            <option v-for="(label, value) in STATUS_LABELS" :key="value" :value="value">{{ label }}</option>
          </select>
          <select v-model="filters.sla" aria-label="Plazo">
            <option value="">Cualquier plazo</option>
            <option v-for="(label, value) in SLA_LABELS" :key="value" :value="value">{{ label }}</option>
          </select>
          <button type="submit" class="adm-btn adm-btn--secondary">Filtrar</button>
        </form>
      </template>
      <template #cell-companyName="{ row }">
        <p class="font-medium text-[var(--text-strong)]">{{ row.companyName }}</p>
        <p class="adm-help break-words">{{ row.subject }} · {{ row.publicRef }}</p>
      </template>
      <template #cell-kind="{ row }">{{ B2B_KIND_LABELS[row.kind] }}</template>
      <template #cell-status="{ row }">
        <AdminBadge :tone="STATUS_TONES[row.status] ?? 'neutral'">{{ STATUS_LABELS[row.status] }}</AdminBadge>
      </template>
      <template #cell-slaDueAt="{ row }">
        <AdminBadge :tone="SLA_TONES[row.slaState] ?? 'neutral'">{{ SLA_LABELS[row.slaState] }}</AdminBadge>
        <span class="adm-help ml-2 whitespace-nowrap">{{ formatInstant(row.slaDueAt) }}</span>
      </template>
      <template #actions="{ row }">
        <button
          type="button"
          data-test="request-open"
          class="adm-btn adm-btn--secondary adm-btn--sm"
          @click="open(row.id)"
        >
          Abrir
        </button>
      </template>
    </AdminTable>

    <AdminDrawer
      :open="detail !== null"
      :title="detail?.request.subject ?? 'Solicitud'"
      :description="detail ? `${detail.request.companyName} · ${B2B_KIND_LABELS[detail.request.kind]}` : undefined"
      wide
      @update:open="(value) => !value && (detail = null)"
    >
      <div v-if="detail" class="adm-stack" aria-live="polite">
        <UAlert v-if="notice" role="status" color="warning" variant="subtle" icon="i-lucide-info" :title="notice" />
        <div class="flex flex-wrap items-center gap-2">
          <AdminBadge :tone="STATUS_TONES[detail.request.status] ?? 'neutral'">
            {{ STATUS_LABELS[detail.request.status] }}
          </AdminBadge>
          <AdminBadge :tone="SLA_TONES[detail.request.slaState] ?? 'neutral'">
            {{ SLA_LABELS[detail.request.slaState] }}
          </AdminBadge>
          <span class="adm-help">Responder antes del {{ formatInstant(detail.request.slaDueAt) }}</span>
        </div>

        <AdminCard title="Datos de la solicitud">
          <dl class="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-[12rem_minmax(0,1fr)]">
            <template v-for="(value, key) in detail.request.details" :key="key">
              <dt class="text-[var(--text-muted)]">{{ DETAIL_LABELS[key] ?? adminHumanize(String(key)) }}</dt>
              <dd class="break-words text-[var(--text-strong)]">{{ detailValue(String(key), value) }}</dd>
            </template>
          </dl>
        </AdminCard>

        <AdminCard title="Historial">
          <ol class="space-y-2">
            <li v-for="e in detail.events" :key="e.seq">
              <p class="text-[var(--text-strong)]">
                {{ e.actorType === 'admin' ? 'Equipo' : 'Cliente' }} · {{ STATUS_LABELS[e.toStatus] }}
                <span class="adm-help ml-1">{{ formatInstant(e.createdAt) }}</span>
              </p>
              <p v-if="e.note" class="whitespace-pre-wrap break-words">{{ e.note }}</p>
            </li>
          </ol>
        </AdminCard>

        <AdminCard v-if="detail.documents.length" title="Documentos">
          <ul class="space-y-2">
            <li v-for="d in detail.documents" :key="d.id" class="flex flex-wrap items-center justify-between gap-2">
              <span class="break-all">{{ d.fileName }}</span>
              <AdminBadge
                :tone="d.scanStatus === 'clean' ? 'success' : d.scanStatus === 'pending' ? 'warning' : 'danger'"
              >
                {{ SCAN_LABELS[d.scanStatus] ?? SCAN_LABELS.infected }}
              </AdminBadge>
            </li>
          </ul>
        </AdminCard>

        <AdminFormField
          v-slot="{ id }"
          label="Nota para el cliente"
          help="El cliente verá este texto. Es obligatoria para pedir información, rechazar o responder."
        >
          <textarea :id="id" v-model="note" name="note" rows="3" maxlength="2000" class="w-full" />
        </AdminFormField>
        <div v-if="actions.length" class="flex flex-wrap gap-2">
          <button
            v-for="action in actions"
            :key="action"
            type="button"
            :data-test="`command-${action}`"
            :disabled="busy || (NOTE_REQUIRED.includes(action) && !note.trim())"
            class="adm-btn"
            :class="
              action === 'reject' ? 'adm-btn--danger' : action === 'approve' ? 'adm-btn--primary' : 'adm-btn--secondary'
            "
            @click="run(action)"
          >
            {{ ACTION_LABELS[action] }}
          </button>
        </div>
      </div>
    </AdminDrawer>
  </section>
</template>
