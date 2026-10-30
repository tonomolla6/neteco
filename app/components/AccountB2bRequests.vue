<script setup lang="ts">
import { randomId } from '../utils/uuid'
import {
  B2B_KIND_LABELS,
  B2B_STATUS_LABELS,
  SLA_CLASSES,
  SLA_LABELS,
  errorCodeOf,
  formatInstant
} from '../utils/support-insights-labels'

interface RequestSummary {
  id: string
  publicRef: string
  kind: string
  subject: string
  status: string
  slaDueAt: string
  slaState: string
  version: number
  createdAt: string
}
interface TimelineEvent {
  seq: number
  actorType: 'customer' | 'admin'
  action: string
  toStatus: string
  note: string | null
  createdAt: string
}
interface DocumentItem {
  id: string
  kind: string
  fileName: string
  scanStatus: string
}
interface Detail {
  request: RequestSummary & { details: Record<string, unknown> }
  events: TimelineEvent[]
  documents: DocumentItem[]
}
const request = useRequestFetch(),
  prefix = useId()
const state = ref<'loading' | 'ready' | 'error'>('loading'),
  errorText = ref(''),
  notice = ref('')
const items = ref<RequestSummary[]>([])
const detail = ref<Detail | null>(null),
  creating = ref(false),
  busy = ref(false)
const OPEN = ['submitted', 'in_review', 'waiting_customer']

const messages: Record<string, string> = {
  company_not_approved: 'Tu empresa aún no está aprobada para usar el portal B2B.',
  unauthenticated: 'Inicia sesión para ver tus solicitudes.',
  limit_exceeded: 'Has alcanzado el máximo de solicitudes abiertas o de documentos.',
  concurrency_conflict: 'La solicitud ha cambiado. Recarga y vuelve a intentarlo.',
  invalid_transition: 'Esta solicitud ya no admite esa acción.',
  duplicate_document: 'Ese documento ya está adjunto.',
  not_found: 'No hemos encontrado la solicitud o el pedido indicado.',
  rate_limited: 'Demasiadas operaciones seguidas. Espera un poco.'
}
const messageFor = (error: unknown) =>
  messages[errorCodeOf(error)] ?? 'No hemos podido completar la operación. Inténtalo de nuevo.'

async function load() {
  state.value = 'loading'
  try {
    items.value = ((await request('/api/account/b2b-requests')) as { items: RequestSummary[] }).items
    state.value = 'ready'
  } catch (error) {
    errorText.value = messageFor(error)
    state.value = 'error'
  }
}
async function open(id: string) {
  notice.value = ''
  try {
    detail.value = (await request(`/api/account/b2b-requests/${id}`)) as Detail
  } catch (error) {
    notice.value = messageFor(error)
  }
}

// ---- create
const form = reactive({
  kind: 'quote',
  subject: '',
  lines: [{ productSlug: '', quantity: 1 }],
  productName: '',
  brand: '',
  intendedUse: '',
  estimatedMonthlyUnits: 1,
  hasSafetyDataSheet: false,
  documentType: 'safety_data_sheet',
  docProductSlug: '',
  reason: '',
  limitEuros: 0,
  paymentTermDays: 30,
  justification: '',
  orderId: '',
  claimType: 'damaged',
  description: ''
})
function payload() {
  const base = { kind: form.kind, subject: form.subject.trim() }
  switch (form.kind) {
    case 'quote':
      return {
        ...base,
        details: { lines: form.lines.map((l) => ({ productSlug: l.productSlug.trim(), quantity: Number(l.quantity) })) }
      }
    case 'product_onboarding':
      return {
        ...base,
        details: {
          productName: form.productName.trim(),
          ...(form.brand.trim() ? { brand: form.brand.trim() } : {}),
          intendedUse: form.intendedUse.trim(),
          estimatedMonthlyUnits: Number(form.estimatedMonthlyUnits),
          hasSafetyDataSheet: form.hasSafetyDataSheet
        }
      }
    case 'documentation':
      return {
        ...base,
        details: {
          documentType: form.documentType,
          ...(form.docProductSlug.trim() ? { productSlug: form.docProductSlug.trim() } : {}),
          ...(form.reason.trim() ? { reason: form.reason.trim() } : {})
        }
      }
    case 'credit':
      return {
        ...base,
        details: {
          requestedLimitCents: Math.round(Number(form.limitEuros) * 100),
          paymentTermDays: Number(form.paymentTermDays),
          justification: form.justification.trim()
        }
      }
    default:
      return {
        ...base,
        orderId: form.orderId.trim(),
        details: { claimType: form.claimType, description: form.description.trim() }
      }
  }
}
async function create() {
  busy.value = true
  notice.value = ''
  try {
    await request('/api/account/b2b-requests', {
      method: 'POST',
      headers: { 'idempotency-key': randomId() },
      body: payload()
    })
    creating.value = false
    notice.value = 'Solicitud enviada. Te responderemos dentro del plazo indicado.'
    await load()
  } catch (error) {
    notice.value = messageFor(error)
  } finally {
    busy.value = false
  }
}

// ---- detail actions
const message = ref('')
async function act(path: 'reply' | 'cancel', body: Record<string, unknown>) {
  if (!detail.value) return
  busy.value = true
  notice.value = ''
  const id = detail.value.request.id
  try {
    await request(`/api/account/b2b-requests/${id}/${path}`, {
      method: 'POST',
      headers: { 'idempotency-key': randomId() },
      body
    })
    message.value = ''
    await Promise.all([load(), open(id)])
  } catch (error) {
    notice.value = messageFor(error)
  } finally {
    busy.value = false
  }
}
async function attach(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file || !detail.value) return
  busy.value = true
  notice.value = ''
  try {
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
    const sha256 = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
    const id = detail.value.request.id
    await request(`/api/account/b2b-requests/${id}/documents`, {
      method: 'POST',
      headers: { 'idempotency-key': randomId() },
      body: { kind: 'other', fileName: file.name, contentType: file.type, sizeBytes: file.size, sha256 }
    })
    await open(id)
  } catch (error) {
    notice.value = messageFor(error)
  } finally {
    busy.value = false
  }
}
onMounted(load)
</script>

<template>
  <section class="space-y-6" :aria-labelledby="`${prefix}-h`">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 :id="`${prefix}-h`" class="text-2xl font-bold text-slate-950">Solicitudes de empresa</h1>
        <p class="text-sm text-slate-600">
          Presupuestos, altas de producto, documentación, crédito y reclamaciones con seguimiento y plazo.
        </p>
      </div>
      <button
        type="button"
        data-test="new-request"
        class="rounded-lg bg-neteco-600 px-4 py-2 text-sm font-semibold text-white"
        @click="creating = !creating"
      >
        {{ creating ? 'Cerrar' : 'Nueva solicitud' }}
      </button>
    </div>

    <p v-if="state === 'error'" role="alert" class="rounded-lg bg-red-50 p-4 text-sm text-red-700">{{ errorText }}</p>
    <p v-else-if="notice" role="status" class="rounded-lg bg-slate-50 p-3 text-sm text-slate-700">{{ notice }}</p>

    <form
      v-if="creating"
      data-test="request-form"
      class="space-y-3 rounded-xl border border-slate-200 bg-white p-5"
      @submit.prevent="create"
    >
      <label class="block text-sm font-medium"
        >Tipo
        <select
          v-model="form.kind"
          name="kind"
          class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
        >
          <option v-for="(label, value) in B2B_KIND_LABELS" :key="value" :value="value">{{ label }}</option>
        </select>
      </label>
      <label class="block text-sm font-medium"
        >Asunto
        <input
          v-model="form.subject"
          name="subject"
          type="text"
          minlength="5"
          maxlength="200"
          required
          class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
        />
      </label>

      <template v-if="form.kind === 'quote'">
        <div v-for="(line, index) in form.lines" :key="index" class="grid grid-cols-3 gap-2">
          <input
            v-model="line.productSlug"
            name="productSlug"
            type="text"
            placeholder="Referencia (slug) del producto"
            required
            class="col-span-2 rounded-md border border-slate-300 px-3 py-2 text-sm"
            aria-label="Producto"
          />
          <input
            v-model="line.quantity"
            name="quantity"
            type="number"
            min="1"
            max="100000"
            required
            class="rounded-md border border-slate-300 px-3 py-2 text-sm"
            aria-label="Cantidad"
          />
        </div>
        <button
          v-if="form.lines.length < 30"
          type="button"
          class="text-sm text-neteco-700"
          @click="form.lines.push({ productSlug: '', quantity: 1 })"
        >
          Añadir línea
        </button>
      </template>
      <template v-else-if="form.kind === 'product_onboarding'">
        <input
          v-model="form.productName"
          name="productName"
          type="text"
          placeholder="Nombre del producto"
          required
          class="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          aria-label="Nombre del producto"
        />
        <input
          v-model="form.brand"
          name="brand"
          type="text"
          placeholder="Marca (opcional)"
          class="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          aria-label="Marca"
        />
        <textarea
          v-model="form.intendedUse"
          name="intendedUse"
          rows="2"
          placeholder="Uso previsto"
          required
          class="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          aria-label="Uso previsto"
        />
        <input
          v-model="form.estimatedMonthlyUnits"
          name="estimatedMonthlyUnits"
          type="number"
          min="1"
          class="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          aria-label="Unidades al mes"
        />
        <label class="flex items-center gap-2 text-sm"
          ><input v-model="form.hasSafetyDataSheet" type="checkbox" /> Dispongo de la ficha de datos de seguridad</label
        >
      </template>
      <template v-else-if="form.kind === 'documentation'">
        <select
          v-model="form.documentType"
          name="documentType"
          class="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          aria-label="Documento"
        >
          <option value="safety_data_sheet">Ficha de datos de seguridad</option>
          <option value="technical_sheet">Ficha técnica</option>
          <option value="certificate">Certificado</option>
          <option value="invoice_copy">Copia de factura</option>
          <option value="other">Otro</option>
        </select>
        <input
          v-model="form.docProductSlug"
          name="docProductSlug"
          type="text"
          placeholder="Producto (opcional)"
          class="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          aria-label="Producto"
        />
      </template>
      <template v-else-if="form.kind === 'credit'">
        <input
          v-model="form.limitEuros"
          name="limitEuros"
          type="number"
          min="1"
          step="1"
          required
          class="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          aria-label="Límite solicitado en euros"
        />
        <select
          v-model="form.paymentTermDays"
          name="paymentTermDays"
          class="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          aria-label="Plazo de pago"
        >
          <option :value="30">30 días</option>
          <option :value="60">60 días</option>
          <option :value="90">90 días</option>
        </select>
        <textarea
          v-model="form.justification"
          name="justification"
          rows="2"
          placeholder="Justificación"
          required
          class="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          aria-label="Justificación"
        />
      </template>
      <template v-else>
        <input
          v-model="form.orderId"
          name="orderId"
          type="text"
          placeholder="Identificador del pedido"
          required
          class="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          aria-label="Pedido"
        />
        <select
          v-model="form.claimType"
          name="claimType"
          class="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          aria-label="Tipo de reclamación"
        >
          <option value="damaged">Mercancía dañada</option>
          <option value="missing">Falta mercancía</option>
          <option value="wrong_item">Artículo equivocado</option>
          <option value="billing">Facturación</option>
          <option value="quality">Calidad</option>
        </select>
        <textarea
          v-model="form.description"
          name="description"
          rows="3"
          placeholder="Qué ha ocurrido"
          required
          class="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          aria-label="Descripción"
        />
      </template>
      <button
        type="submit"
        :disabled="busy"
        class="rounded-lg bg-neteco-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
      >
        Enviar solicitud
      </button>
    </form>

    <p v-if="state === 'loading'" class="text-sm text-slate-500">Cargando solicitudes…</p>
    <p
      v-else-if="state === 'ready' && items.length === 0"
      class="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-600"
    >
      Todavía no tienes solicitudes.
    </p>
    <ul v-else-if="state === 'ready'" class="space-y-3">
      <li v-for="item in items" :key="item.id" class="rounded-xl border border-slate-200 bg-white p-4">
        <div class="flex flex-wrap items-center gap-2 text-xs">
          <span class="rounded bg-slate-100 px-2 py-0.5 font-mono">{{ item.publicRef }}</span>
          <span class="font-semibold">{{ B2B_KIND_LABELS[item.kind] ?? item.kind }}</span>
          <span class="rounded-full bg-blue-50 px-2 py-0.5 font-semibold text-blue-700">{{
            B2B_STATUS_LABELS[item.status] ?? item.status
          }}</span>
          <span class="rounded-full px-2 py-0.5 font-semibold" :class="SLA_CLASSES[item.slaState]"
            >{{ SLA_LABELS[item.slaState] }} · {{ formatInstant(item.slaDueAt) }}</span
          >
        </div>
        <p class="mt-2 font-medium text-slate-900">{{ item.subject }}</p>
        <button
          type="button"
          data-test="request-open"
          class="mt-2 text-sm text-neteco-700 hover:underline"
          @click="open(item.id)"
        >
          Ver seguimiento
        </button>
      </li>
    </ul>

    <div v-if="detail" class="space-y-4 rounded-xl border border-slate-200 bg-white p-5" aria-live="polite">
      <h2 class="text-lg font-semibold">{{ detail.request.subject }}</h2>
      <ol class="space-y-2 text-sm">
        <li v-for="event in detail.events" :key="event.seq">
          <span class="font-medium">{{ event.actorType === 'admin' ? 'Equipo NETECO' : 'Tú' }}</span>
          · {{ formatInstant(event.createdAt) }} · {{ B2B_STATUS_LABELS[event.toStatus] ?? event.toStatus }}
          <p v-if="event.note" class="text-slate-700">{{ event.note }}</p>
        </li>
      </ol>
      <ul v-if="detail.documents.length" class="text-sm">
        <li v-for="doc in detail.documents" :key="doc.id">
          {{ doc.fileName }} —
          {{
            doc.scanStatus === 'pending'
              ? 'pendiente de análisis'
              : doc.scanStatus === 'clean'
                ? 'revisado'
                : 'rechazado'
          }}
        </li>
      </ul>
      <template v-if="OPEN.includes(detail.request.status)">
        <form data-test="reply-form" class="space-y-2" @submit.prevent="act('reply', { message: message.trim() })">
          <label class="block text-sm font-medium"
            >Responder
            <textarea
              v-model="message"
              name="message"
              rows="2"
              required
              maxlength="2000"
              class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </label>
          <button
            type="submit"
            :disabled="busy || !message.trim()"
            class="rounded-lg border border-neteco-600 px-3 py-1.5 text-sm font-semibold text-neteco-700 disabled:opacity-50"
          >
            Enviar respuesta
          </button>
        </form>
        <label class="block text-sm"
          >Adjuntar documento (PDF, JPG o PNG)
          <input
            type="file"
            accept="application/pdf,image/jpeg,image/png"
            class="mt-1 block text-sm"
            @change="attach"
          />
        </label>
        <button
          type="button"
          data-test="request-cancel"
          :disabled="busy"
          class="text-sm text-red-700 hover:underline"
          @click="act('cancel', { expectedVersion: detail.request.version })"
        >
          Cancelar solicitud
        </button>
      </template>
    </div>
  </section>
</template>
