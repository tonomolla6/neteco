<script setup lang="ts">
import { b2bNextStatus, type B2bKind, type B2bStatus } from '~~/shared/support-insights'
import { randomId } from '../utils/uuid'
import {
  B2B_KIND_LABELS,
  B2B_STATUS_LABELS,
  SLA_CLASSES,
  SLA_LABELS,
  formatInstant
} from '../utils/support-insights-labels'

/** SUP-017: administrative queue of B2B requests ordered by SLA, with the audited workflow commands. */
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
</script>

<template>
  <section class="space-y-6">
    <div>
      <h2 class="text-xl font-bold text-slate-900">Solicitudes B2B</h2>
      <p class="text-sm text-slate-500">
        SUP-017: presupuestos, altas de producto, documentación, crédito y reclamaciones con SLA.
      </p>
    </div>
    <form class="flex flex-wrap gap-3" @submit.prevent="load">
      <select v-model="filters.kind" aria-label="Tipo" class="rounded border border-slate-300 px-2 py-1 text-sm">
        <option value="">Todos los tipos</option>
        <option v-for="(label, value) in B2B_KIND_LABELS" :key="value" :value="value">{{ label }}</option>
      </select>
      <select v-model="filters.status" aria-label="Estado" class="rounded border border-slate-300 px-2 py-1 text-sm">
        <option value="">Todos los estados</option>
        <option v-for="(label, value) in B2B_STATUS_LABELS" :key="value" :value="value">{{ label }}</option>
      </select>
      <select v-model="filters.sla" aria-label="SLA" class="rounded border border-slate-300 px-2 py-1 text-sm">
        <option value="">Cualquier SLA</option>
        <option v-for="(label, value) in SLA_LABELS" :key="value" :value="value">{{ label }}</option>
      </select>
      <button type="submit" class="rounded-lg bg-neteco-600 px-3 py-1.5 text-sm font-semibold text-white">
        Filtrar
      </button>
    </form>
    <p v-if="state === 'error'" role="alert" class="rounded-lg bg-red-50 p-4 text-sm text-red-700">
      No hemos podido cargar las solicitudes B2B.
    </p>
    <p v-else-if="notice" role="status" class="rounded-lg bg-slate-50 p-3 text-sm">{{ notice }}</p>
    <p v-if="state === 'loading'" class="text-sm text-slate-500">Cargando…</p>
    <p
      v-else-if="state === 'ready' && items.length === 0"
      class="rounded-xl border border-dashed p-6 text-center text-sm text-slate-600"
    >
      No hay solicitudes con estos filtros.
    </p>

    <ul v-if="state === 'ready'" class="space-y-3">
      <li v-for="item in items" :key="item.id" class="rounded-xl border bg-white p-4 text-sm">
        <div class="flex flex-wrap items-center gap-2 text-xs">
          <span class="rounded bg-slate-100 px-2 py-0.5 font-mono">{{ item.publicRef }}</span>
          <span class="font-semibold">{{ B2B_KIND_LABELS[item.kind] }}</span>
          <span class="rounded-full bg-blue-50 px-2 py-0.5 font-semibold text-blue-700">{{
            B2B_STATUS_LABELS[item.status]
          }}</span>
          <span class="rounded-full px-2 py-0.5 font-semibold" :class="SLA_CLASSES[item.slaState]"
            >{{ SLA_LABELS[item.slaState] }} · {{ formatInstant(item.slaDueAt) }}</span
          >
        </div>
        <p class="mt-2">
          <strong>{{ item.companyName }}</strong> — {{ item.subject }}
        </p>
        <button
          type="button"
          data-test="request-open"
          class="mt-2 text-neteco-700 hover:underline"
          @click="open(item.id)"
        >
          Abrir
        </button>
      </li>
    </ul>

    <div v-if="detail" class="space-y-4 rounded-xl border bg-white p-5 text-sm" aria-live="polite">
      <h3 class="text-lg font-semibold">{{ detail.request.subject }}</h3>
      <dl class="grid grid-cols-2 gap-2">
        <template v-for="(value, key) in detail.request.details" :key="key"
          ><dt class="text-slate-500">{{ key }}</dt>
          <dd>{{ typeof value === 'object' ? JSON.stringify(value) : value }}</dd></template
        >
      </dl>
      <ol class="space-y-1">
        <li v-for="e in detail.events" :key="e.seq">
          {{ formatInstant(e.createdAt) }} · {{ e.actorType === 'admin' ? 'Equipo' : 'Cliente' }} ·
          {{ B2B_STATUS_LABELS[e.toStatus] }}<span v-if="e.note"> — {{ e.note }}</span>
        </li>
      </ol>
      <ul v-if="detail.documents.length">
        <li v-for="d in detail.documents" :key="d.id">
          {{ d.fileName }} —
          {{ d.scanStatus === 'pending' ? 'pendiente de análisis' : d.scanStatus === 'clean' ? 'limpio' : 'infectado' }}
        </li>
      </ul>
      <label class="block text-xs font-semibold uppercase text-slate-500"
        >Nota (visible para el cliente)
        <textarea
          v-model="note"
          name="note"
          rows="2"
          maxlength="2000"
          class="mt-1 block w-full rounded border border-slate-300 px-2 py-1 text-sm normal-case"
        />
      </label>
      <div class="flex flex-wrap gap-2">
        <button
          v-for="action in actions"
          :key="action"
          type="button"
          :data-test="`command-${action}`"
          :disabled="busy || (NOTE_REQUIRED.includes(action) && !note.trim())"
          class="rounded border px-3 py-1 disabled:opacity-50"
          @click="run(action)"
        >
          {{ ACTION_LABELS[action] }}
        </button>
      </div>
    </div>
  </section>
</template>
