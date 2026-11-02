<script setup lang="ts">
/* eslint-disable @typescript-eslint/no-explicit-any */
import { onMounted, ref } from 'vue'

type Tab = 'reorder' | 'scan' | 'counts'
interface Suggestion {
  id: string
  sku: string
  status: string
  positionQuantity: number
  reorderPoint: number
  suggestedQuantity: number
  dailyDemand: number
  leadTimeDays: number
  version: number
}
interface ScanTask {
  id: string
  stage: string
  reference: string
  status: string
  expectedQuantity: number
  scannedQuantity: number
}
interface CountPlan {
  id: string
  name: string
  status: string
  version: number
  blind: number
  lines: number
}

const ROOT_CAUSES = [
  ['miscount', 'Error de conteo'],
  ['receiving_error', 'Error de recepción'],
  ['picking_error', 'Error de picking'],
  ['damage_loss', 'Daño o merma'],
  ['theft_suspected', 'Sospecha de robo'],
  ['supplier_shortage', 'Faltante de proveedor'],
  ['system_error', 'Error de sistema'],
  ['unknown', 'Desconocida']
] as const
const STAGES: Record<string, string> = { receiving: 'Recepción', picking: 'Picking', packing: 'Packing' }

const requestFetch = useRequestFetch()
const tab = ref<Tab>('reorder')
const loading = ref(false)
const error = ref('')
const notice = ref('')

const suggestions = ref<Suggestion[]>([])
const approvedQuantity = ref<Record<string, number>>({})
const decisionNote = ref<Record<string, string>>({})

const tasks = ref<ScanTask[]>([])
const activeTask = ref<any>(null)
const barcode = ref('')
const scanQuantity = ref(1)
const exceptionMode = ref(false)
const exceptionReason = ref('barcode_unreadable')
const exceptionNote = ref('')
const scanFeedback = ref('')
const scanOk = ref(true)

const plans = ref<CountPlan[]>([])
const activePlan = ref<any>(null)
const counts = ref<Record<string, number>>({})
const rootCause = ref<Record<string, string>>({})
const lineNote = ref<Record<string, string>>({})

const policyForm = ref({
  variantId: '',
  leadTimeDays: 7,
  reviewDays: 7,
  demandWindowDays: 30,
  orderMultiple: 1,
  minOrderQuantity: 1,
  expectedVersion: 0
})

const planForm = ref({
  name: '',
  blind: 1,
  variantsRaw: ''
})

const taskForm = ref({
  stage: 'receiving',
  reference: '',
  variantId: '',
  expectedQuantity: 1
})

const newKey = () => globalThis.crypto.randomUUID()

function message(cause: any) {
  const code = cause?.data?.error?.code ?? cause?.statusMessage ?? cause?.message
  return typeof code === 'string' ? code : 'service_unavailable'
}

async function post(path: string, body: Record<string, unknown>) {
  return requestFetch(path, { method: 'POST', body, headers: { 'Idempotency-Key': newKey() } }) as Promise<any>
}

async function loadAll() {
  loading.value = true
  error.value = ''
  try {
    const [s, t, p] = await Promise.all([
      requestFetch('/api/admin/inventory/reorder/suggestions?status=pending'),
      requestFetch('/api/admin/warehouse/barcode-tasks?status=open'),
      requestFetch('/api/admin/inventory/cycle-counts')
    ])
    suggestions.value = (s as any).suggestions ?? []
    tasks.value = (t as any).tasks ?? []
    plans.value = (p as any).plans ?? []
  } catch (cause) {
    error.value = message(cause)
  } finally {
    loading.value = false
  }
}

async function guarded(action: () => Promise<void>) {
  error.value = ''
  notice.value = ''
  try {
    await action()
  } catch (cause) {
    error.value = message(cause)
  }
}

const evaluate = () =>
  guarded(async () => {
    const r = await post('/api/admin/inventory/reorder/evaluate', {})
    notice.value = `Evaluadas ${r.evaluated} políticas; ${r.created.length} sugerencias nuevas.`
    await loadAll()
  })

const savePolicy = () =>
  guarded(async () => {
    if (!policyForm.value.variantId.trim()) return
    await post('/api/admin/inventory/reorder/policies', {
      variantId: policyForm.value.variantId.trim(),
      leadTimeDays: Number(policyForm.value.leadTimeDays),
      reviewDays: Number(policyForm.value.reviewDays),
      demandWindowDays: Number(policyForm.value.demandWindowDays),
      orderMultiple: Number(policyForm.value.orderMultiple),
      minOrderQuantity: Number(policyForm.value.minOrderQuantity),
      expectedVersion: Number(policyForm.value.expectedVersion)
    })
    notice.value = 'Política de reposición guardada.'
  })

const savePlan = () =>
  guarded(async () => {
    if (!planForm.value.name.trim()) return
    const ids = planForm.value.variantsRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    await post('/api/admin/inventory/cycle-counts', {
      name: planForm.value.name.trim(),
      blind: Number(planForm.value.blind),
      variantIds: ids
    })
    notice.value = 'Plan de conteo creado.'
    planForm.value.name = ''
    planForm.value.variantsRaw = ''
    await loadAll()
  })

const saveTask = () =>
  guarded(async () => {
    if (!taskForm.value.reference.trim() || !taskForm.value.variantId.trim()) return
    await post('/api/admin/warehouse/barcode-tasks', {
      stage: taskForm.value.stage,
      reference: taskForm.value.reference.trim(),
      lines: [
        {
          variantId: taskForm.value.variantId.trim(),
          expectedQuantity: Number(taskForm.value.expectedQuantity)
        }
      ]
    })
    notice.value = 'Tarea de escaneo creada.'
    taskForm.value.reference = ''
    taskForm.value.variantId = ''
    await loadAll()
  })
const decideSuggestion = (s: Suggestion, decision: 'approve' | 'reject') =>
  guarded(async () => {
    const note = decisionNote.value[s.id]?.trim() ?? ''
    const body =
      decision === 'approve'
        ? {
            decision,
            expectedVersion: s.version,
            approvedQuantity: approvedQuantity.value[s.id] ?? s.suggestedQuantity,
            note
          }
        : { decision, expectedVersion: s.version, note }
    await post(`/api/admin/inventory/reorder/suggestions/${s.id}/decision`, body)
    notice.value = decision === 'approve' ? 'Sugerencia aprobada.' : 'Sugerencia rechazada.'
    await loadAll()
  })

const openTask = (id: string) =>
  guarded(async () => {
    activeTask.value = await requestFetch(`/api/admin/warehouse/barcode-tasks/${id}`)
  })
const submitScan = () =>
  guarded(async () => {
    const code = barcode.value.trim()
    if (!code || !activeTask.value) return
    const body: Record<string, unknown> = { barcode: code, quantity: scanQuantity.value }
    if (exceptionMode.value) body.exception = { reason: exceptionReason.value, note: exceptionNote.value.trim() }
    barcode.value = ''
    try {
      const r = await post(`/api/admin/warehouse/barcode-tasks/${activeTask.value.id}/scan`, body)
      scanOk.value = true
      scanFeedback.value = `${r.sku}: ${r.scannedQuantity}/${r.expectedQuantity}`
    } catch (cause: any) {
      scanOk.value = false
      scanFeedback.value = `Escaneo rechazado: ${message(cause)}`
    }
    await openTask(activeTask.value.id)
    await loadAll()
  })

const openPlan = (id: string) =>
  guarded(async () => {
    activePlan.value = await requestFetch(`/api/admin/inventory/cycle-counts/${id}`)
  })
const planAction = (action: 'start' | 'cancel') =>
  guarded(async () => {
    await post(`/api/admin/inventory/cycle-counts/${activePlan.value.id}/${action}`, {
      expectedVersion: activePlan.value.version
    })
    await Promise.all([openPlan(activePlan.value.id), loadAll()])
  })
const sendCount = (line: any) =>
  guarded(async () => {
    await post(`/api/admin/inventory/cycle-counts/${activePlan.value.id}/count`, {
      variantId: line.variantId,
      countedQuantity: Number(counts.value[line.variantId]),
      expectedLineVersion: line.version
    })
    await openPlan(activePlan.value.id)
  })
const decideLine = (line: any, decision: 'approve' | 'reject') =>
  guarded(async () => {
    await post(`/api/admin/inventory/cycle-counts/${activePlan.value.id}/decide`, {
      variantId: line.variantId,
      expectedLineVersion: line.version,
      decision,
      ...(rootCause.value[line.variantId] ? { rootCause: rootCause.value[line.variantId] } : {}),
      note: lineNote.value[line.variantId]?.trim() ?? ''
    })
    await Promise.all([openPlan(activePlan.value.id), loadAll()])
  })
const recount = (line: any) =>
  guarded(async () => {
    await post(`/api/admin/inventory/cycle-counts/${activePlan.value.id}/recount`, {
      variantId: line.variantId,
      expectedLineVersion: line.version,
      note: lineNote.value[line.variantId]?.trim() ?? ''
    })
    await openPlan(activePlan.value.id)
  })

onMounted(loadAll)
</script>

<template>
  <section class="space-y-6" data-testid="admin-inventory-planning" aria-labelledby="planning-title">
    <header>
      <h1 id="planning-title" class="text-2xl font-bold text-slate-900">Reposición, escaneo y conteos cíclicos</h1>
      <p class="text-sm text-slate-600">
        Puntos de pedido con aprobación humana, validación de código de barras y conteo ciego con causa raíz.
      </p>
    </header>

    <div role="tablist" class="flex gap-2" aria-label="Secciones">
      <button
        v-for="[key, label] in [
          ['reorder', 'Sugerencias de compra'],
          ['scan', 'Escaneo'],
          ['counts', 'Conteos cíclicos']
        ] as const"
        :key="key"
        type="button"
        role="tab"
        :aria-selected="tab === key"
        :data-testid="`tab-${key}`"
        class="rounded-lg border px-4 py-2 text-sm font-semibold"
        :class="tab === key ? 'border-blue-600 bg-blue-600 text-white' : 'border-slate-300 bg-white text-slate-700'"
        @click="tab = key"
      >
        {{ label }}
      </button>
    </div>

    <p v-if="loading" role="status" data-testid="planning-loading" class="text-sm text-slate-500">Cargando…</p>
    <p v-if="error" role="alert" data-testid="planning-error" class="rounded-lg bg-red-50 p-3 text-sm text-red-800">
      Error: {{ error }}
    </p>
    <p
      v-if="notice"
      role="status"
      data-testid="planning-notice"
      class="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800"
    >
      {{ notice }}
    </p>

    <!-- INV-017 -->
    <div v-if="tab === 'reorder'" role="tabpanel" data-testid="panel-reorder" class="space-y-3">
      <div class="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
        <h3 class="font-semibold text-slate-800 text-sm">Configurar política de reposición</h3>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-2 text-xs">
          <div>
            <label class="block text-slate-600">UUID Variante</label>
            <input v-model="policyForm.variantId" data-testid="policy-variant-id" class="w-full rounded border p-1" />
          </div>
          <div>
            <label class="block text-slate-600">Plazo entrega (días)</label>
            <input
              v-model.number="policyForm.leadTimeDays"
              data-testid="policy-lead-time"
              type="number"
              class="w-full rounded border p-1"
            />
          </div>
          <div>
            <label class="block text-slate-600">Pedido mínimo</label>
            <input
              v-model.number="policyForm.minOrderQuantity"
              data-testid="policy-min-order"
              type="number"
              class="w-full rounded border p-1"
            />
          </div>
        </div>
        <button
          type="button"
          data-testid="save-policy-btn"
          class="rounded bg-slate-800 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-700"
          @click="savePolicy"
        >
          Guardar política
        </button>
      </div>

      <button
        type="button"
        class="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white"
        data-testid="btn-evaluate"
        @click="evaluate"
      >
        Evaluar puntos de pedido
      </button>
      <p v-if="!loading && !suggestions.length" data-testid="reorder-empty" class="text-sm text-slate-500">
        No hay sugerencias pendientes.
      </p>
      <article
        v-for="s in suggestions"
        :key="s.id"
        class="rounded-xl border border-slate-200 bg-white p-4"
        :data-testid="`suggestion-${s.id}`"
      >
        <h2 class="font-semibold text-slate-900">{{ s.sku }}</h2>
        <p class="text-sm text-slate-600">
          Posición {{ s.positionQuantity }} ≤ punto de pedido {{ s.reorderPoint }} · demanda {{ s.dailyDemand }}/día ·
          plazo {{ s.leadTimeDays }} d · sugerido {{ s.suggestedQuantity }}
        </p>
        <div class="mt-2 flex flex-wrap items-end gap-2">
          <label class="text-xs text-slate-600">
            Cantidad a pedir
            <input
              v-model.number="approvedQuantity[s.id]"
              type="number"
              min="1"
              :placeholder="String(s.suggestedQuantity)"
              class="block w-28 rounded border border-slate-300 px-2 py-1 text-sm"
              :data-testid="`qty-${s.id}`"
            />
          </label>
          <label class="flex-1 text-xs text-slate-600">
            Nota de decisión
            <input
              v-model="decisionNote[s.id]"
              type="text"
              maxlength="500"
              class="block w-full rounded border border-slate-300 px-2 py-1 text-sm"
              :data-testid="`note-${s.id}`"
            />
          </label>
          <button
            type="button"
            class="rounded bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white"
            :data-testid="`approve-${s.id}`"
            @click="decideSuggestion(s, 'approve')"
          >
            Aprobar
          </button>
          <button
            type="button"
            class="rounded bg-slate-200 px-3 py-1.5 text-sm font-semibold text-slate-800"
            :data-testid="`reject-${s.id}`"
            @click="decideSuggestion(s, 'reject')"
          >
            Rechazar
          </button>
        </div>
      </article>
    </div>

    <!-- INV-018 -->
    <div v-if="tab === 'scan'" role="tabpanel" data-testid="panel-scan" class="space-y-3">
      <div class="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
        <h3 class="font-semibold text-slate-800 text-sm">Crear tarea de escaneo</h3>
        <div class="grid grid-cols-1 md:grid-cols-4 gap-2 text-xs">
          <div>
            <label class="block text-slate-600">Etapa</label>
            <select v-model="taskForm.stage" class="w-full rounded border p-1">
              <option value="receiving">Recepción</option>
              <option value="picking">Picking</option>
              <option value="packing">Packing</option>
            </select>
          </div>
          <div>
            <label class="block text-slate-600">Referencia</label>
            <input
              v-model="taskForm.reference"
              data-testid="new-task-reference"
              placeholder="ALB-..."
              class="w-full rounded border p-1"
            />
          </div>
          <div>
            <label class="block text-slate-600">UUID Variante</label>
            <input v-model="taskForm.variantId" data-testid="new-task-variant" class="w-full rounded border p-1" />
          </div>
          <div>
            <label class="block text-slate-600">Cantidad esperada</label>
            <input
              v-model.number="taskForm.expectedQuantity"
              data-testid="new-task-quantity"
              type="number"
              min="1"
              class="w-full rounded border p-1"
            />
          </div>
        </div>
        <button
          type="button"
          data-testid="save-task-btn"
          class="rounded bg-slate-800 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-700"
          @click="saveTask"
        >
          Crear tarea
        </button>
      </div>

      <p v-if="!loading && !tasks.length" data-testid="scan-empty" class="text-sm text-slate-500">
        No hay tareas de escaneo abiertas.
      </p>
      <ul class="space-y-2">
        <li v-for="t in tasks" :key="t.id">
          <button
            type="button"
            class="w-full rounded-lg border border-slate-200 bg-white p-3 text-left text-sm"
            :data-testid="`task-${t.id}`"
            @click="openTask(t.id)"
          >
            <strong>{{ STAGES[t.stage] ?? t.stage }}</strong> · {{ t.reference }} · {{ t.scannedQuantity }}/{{
              t.expectedQuantity
            }}
          </button>
        </li>
      </ul>
      <form
        v-if="activeTask"
        class="space-y-2 rounded-xl border-2 border-blue-500 bg-blue-50/50 p-4"
        data-testid="scan-form"
        @submit.prevent="submitScan"
      >
        <h2 class="font-semibold">{{ activeTask.reference }} — {{ STAGES[activeTask.stage] }}</h2>
        <ul class="text-sm text-slate-700" data-testid="scan-lines">
          <li v-for="l in activeTask.lines" :key="l.variantId">
            {{ l.sku }}: {{ l.scannedQuantity }}/{{ l.expectedQuantity }}
          </li>
        </ul>
        <div class="flex flex-wrap gap-2">
          <label class="flex-1 text-xs text-slate-600">
            {{ exceptionMode ? 'SKU (modo excepción)' : 'Código de barras' }}
            <input
              v-model="barcode"
              type="text"
              autocomplete="off"
              class="block w-full rounded border border-blue-300 px-3 py-2 font-mono"
              data-testid="scan-input"
            />
          </label>
          <label class="text-xs text-slate-600">
            Cantidad
            <input
              v-model.number="scanQuantity"
              type="number"
              min="1"
              class="block w-24 rounded border border-slate-300 px-2 py-2"
              data-testid="scan-quantity"
            />
          </label>
          <button
            type="submit"
            class="self-end rounded bg-blue-600 px-4 py-2 text-sm font-bold text-white"
            data-testid="scan-submit"
          >
            Validar
          </button>
        </div>
        <label class="flex items-center gap-2 text-sm text-slate-700">
          <input v-model="exceptionMode" type="checkbox" data-testid="scan-exception-toggle" /> Modo excepción (código
          ilegible o ausente)
        </label>
        <div v-if="exceptionMode" class="flex flex-wrap gap-2">
          <select
            v-model="exceptionReason"
            class="rounded border border-slate-300 px-2 py-1 text-sm"
            aria-label="Motivo de la excepción"
          >
            <option value="barcode_unreadable">Código ilegible</option>
            <option value="barcode_missing">Sin código</option>
            <option value="wrong_barcode_on_item">Código erróneo en el artículo</option>
            <option value="damaged_label">Etiqueta dañada</option>
          </select>
          <input
            v-model="exceptionNote"
            type="text"
            minlength="10"
            maxlength="500"
            placeholder="Motivo (mín. 10 caracteres)"
            class="min-w-64 flex-1 rounded border border-slate-300 px-2 py-1 text-sm"
            data-testid="scan-exception-note"
          />
        </div>
        <p
          v-if="scanFeedback"
          role="status"
          data-testid="scan-feedback"
          class="text-sm font-medium"
          :class="scanOk ? 'text-emerald-700' : 'text-red-700'"
        >
          {{ scanFeedback }}
        </p>
      </form>
    </div>

    <!-- INV-020 -->
    <div v-if="tab === 'counts'" role="tabpanel" data-testid="panel-counts" class="space-y-3">
      <div class="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
        <h3 class="font-semibold text-slate-800 text-sm">Crear plan de conteo cíclico</h3>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-2 text-xs">
          <div>
            <label class="block text-slate-600">Nombre del plan</label>
            <input
              v-model="planForm.name"
              data-testid="new-plan-name"
              placeholder="Conteo Pasillo..."
              class="w-full rounded border p-1"
            />
          </div>
          <div>
            <label class="block text-slate-600">UUIDs Variantes (separados por coma)</label>
            <input
              v-model="planForm.variantsRaw"
              data-testid="new-plan-variants"
              placeholder="uuid1, uuid2"
              class="w-full rounded border p-1"
            />
          </div>
          <div class="flex items-center gap-2 pt-4">
            <label class="flex items-center gap-1 text-slate-700">
              <input v-model="planForm.blind" type="checkbox" :true-value="1" :false-value="0" /> Conteo ciego
            </label>
          </div>
        </div>
        <button
          type="button"
          data-testid="save-plan-btn"
          class="rounded bg-slate-800 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-700"
          @click="savePlan"
        >
          Crear plan
        </button>
      </div>

      <p v-if="!loading && !plans.length" data-testid="counts-empty" class="text-sm text-slate-500">
        No hay planes de conteo.
      </p>
      <ul class="space-y-2">
        <li v-for="p in plans" :key="p.id">
          <button
            type="button"
            class="w-full rounded-lg border border-slate-200 bg-white p-3 text-left text-sm"
            :data-testid="`plan-${p.id}`"
            @click="openPlan(p.id)"
          >
            <strong>{{ p.name }}</strong> · {{ p.status }} · {{ p.lines }} líneas<span v-if="p.blind"> · ciego</span>
          </button>
        </li>
      </ul>
      <div
        v-if="activePlan"
        class="space-y-2 rounded-xl border border-slate-200 bg-white p-4"
        data-testid="plan-detail"
      >
        <h2 class="font-semibold">{{ activePlan.name }} ({{ activePlan.status }})</h2>
        <div class="flex gap-2">
          <button
            v-if="activePlan.status === 'planned'"
            type="button"
            class="rounded bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white"
            data-testid="plan-start"
            @click="planAction('start')"
          >
            Iniciar conteo
          </button>
          <button
            v-if="['planned', 'counting', 'review'].includes(activePlan.status)"
            type="button"
            class="rounded bg-slate-200 px-3 py-1.5 text-sm font-semibold"
            data-testid="plan-cancel"
            @click="planAction('cancel')"
          >
            Cancelar plan
          </button>
        </div>
        <table class="w-full text-left text-sm">
          <caption class="sr-only">
            Líneas del plan de conteo
          </caption>
          <thead>
            <tr>
              <th scope="col">SKU</th>
              <th scope="col">Estado</th>
              <th v-if="activePlan.status === 'review' || activePlan.status === 'closed'" scope="col">Teórico</th>
              <th scope="col">Contado</th>
              <th scope="col">Acción</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="l in activePlan.lines" :key="l.variantId" :data-testid="`line-${l.variantId}`">
              <td>{{ l.sku }}</td>
              <td>{{ l.status }}</td>
              <td v-if="activePlan.status === 'review' || activePlan.status === 'closed'">
                {{ l.expectedQuantity
                }}<span v-if="l.discrepancy" class="ml-1 font-semibold text-amber-700"
                  >({{ l.discrepancy > 0 ? '+' : '' }}{{ l.discrepancy }})</span
                >
              </td>
              <td>{{ l.countedQuantity ?? '—' }}</td>
              <td>
                <div
                  v-if="activePlan.status === 'counting' && ['pending', 'recount'].includes(l.status)"
                  class="flex gap-1"
                >
                  <input
                    v-model.number="counts[l.variantId]"
                    type="number"
                    min="0"
                    class="w-24 rounded border border-slate-300 px-2 py-1"
                    :aria-label="`Cantidad contada de ${l.sku}`"
                    :data-testid="`count-${l.variantId}`"
                  />
                  <button
                    type="button"
                    class="rounded bg-blue-600 px-2 py-1 text-white"
                    :data-testid="`send-count-${l.variantId}`"
                    @click="sendCount(l)"
                  >
                    Enviar
                  </button>
                </div>
                <div v-else-if="activePlan.status === 'review' && l.status === 'counted'" class="space-y-1">
                  <select
                    v-model="rootCause[l.variantId]"
                    class="rounded border border-slate-300 px-1 py-1"
                    :aria-label="`Causa raíz de ${l.sku}`"
                    :data-testid="`cause-${l.variantId}`"
                  >
                    <option value="">Causa raíz…</option>
                    <option v-for="[value, label] in ROOT_CAUSES" :key="value" :value="value">{{ label }}</option>
                  </select>
                  <input
                    v-model="lineNote[l.variantId]"
                    type="text"
                    maxlength="500"
                    placeholder="Nota"
                    class="rounded border border-slate-300 px-2 py-1"
                    :aria-label="`Nota de ${l.sku}`"
                    :data-testid="`line-note-${l.variantId}`"
                  />
                  <button
                    type="button"
                    class="rounded bg-emerald-600 px-2 py-1 text-white"
                    :data-testid="`approve-line-${l.variantId}`"
                    @click="decideLine(l, 'approve')"
                  >
                    Aprobar ajuste
                  </button>
                  <button
                    type="button"
                    class="rounded bg-slate-200 px-2 py-1"
                    :data-testid="`reject-line-${l.variantId}`"
                    @click="decideLine(l, 'reject')"
                  >
                    Rechazar
                  </button>
                  <button
                    type="button"
                    class="rounded bg-amber-200 px-2 py-1"
                    :data-testid="`recount-${l.variantId}`"
                    @click="recount(l)"
                  >
                    Recontar
                  </button>
                </div>
                <span v-else-if="l.rootCause">{{ l.rootCause }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>
</template>
