<script setup lang="ts">
/* eslint-disable @typescript-eslint/no-explicit-any */
import { onMounted, ref, watch } from 'vue'
import type { AdminTone } from '~/utils/adminLabels'

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
const STAGES: Record<string, string> = { receiving: 'Recepción', picking: 'Recogida', packing: 'Empaquetado' }
const TABS = [
  ['reorder', 'Sugerencias de compra'],
  ['scan', 'Lectura de códigos'],
  ['counts', 'Recuentos']
] as const
const PLAN_STATUS: Record<string, string> = {
  planned: 'Sin empezar',
  counting: 'Contando',
  review: 'En revisión',
  closed: 'Cerrado',
  cancelled: 'Cancelado'
}
const PLAN_TONES: Record<string, AdminTone> = {
  planned: 'neutral',
  counting: 'info',
  review: 'warning',
  closed: 'success',
  cancelled: 'neutral'
}
const LINE_STATUS: Record<string, string> = {
  pending: 'Pendiente de contar',
  counted: 'Contado',
  recount: 'Volver a contar',
  approved: 'Ajuste aprobado',
  rejected: 'Ajuste rechazado'
}
const ERROR_TEXT: Record<string, string> = {
  invalid_input: 'Falta algún dato o no es válido. Revisa el formulario y vuelve a intentarlo.',
  validation_error: 'Falta algún dato o no es válido. Revisa el formulario y vuelve a intentarlo.',
  forbidden: 'No tienes permiso para hacer esto.',
  unauthorized: 'Tu sesión ha caducado. Vuelve a iniciar sesión.',
  not_found: 'No hemos encontrado lo que buscas. Puede que ya no exista.',
  concurrency_conflict: 'Otra persona lo ha cambiado mientras tanto. Recarga y vuelve a intentarlo.',
  version_conflict: 'Otra persona lo ha cambiado mientras tanto. Recarga y vuelve a intentarlo.',
  rate_limited: 'Demasiadas operaciones seguidas. Espera un momento.',
  barcode_unknown: 'Ese código de barras no corresponde a ningún producto de la tarea.',
  quantity_exceeds_expected: 'La cantidad supera lo que se esperaba en la tarea.',
  service_unavailable: 'No hemos podido conectar con la tienda. Vuelve a intentarlo.'
}
function rootCauseLabel(code: string) {
  return ROOT_CAUSES.find(([value]) => value === code)?.[1] ?? adminHumanize(code)
}

const requestFetch = useRequestFetch()
const tab = ref<Tab>('reorder')
const loading = ref(false)
const error = ref('')
const notice = ref('')
// Paneles laterales de alta: se cierran cuando la operación se confirma.
const policyOpen = ref(false)
const taskOpen = ref(false)
const planOpen = ref(false)
watch(notice, (value) => {
  if (value) policyOpen.value = taskOpen.value = planOpen.value = false
})

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
  return (
    (typeof code === 'string' ? ERROR_TEXT[code] : undefined) ??
    'No hemos podido completar la operación. Vuelve a intentarlo.'
  )
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
    notice.value = `Revisadas ${r.evaluated} reglas de reposición: ${r.created.length} sugerencias nuevas.`
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
    notice.value = 'Regla de reposición guardada.'
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
    notice.value = 'Recuento creado.'
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
    notice.value = 'Tarea de lectura creada.'
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
      scanFeedback.value = `Lectura rechazada: ${message(cause)}`
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
  <section class="adm-stack" data-testid="admin-inventory-planning" aria-labelledby="planning-title">
    <h2 id="planning-title" class="sr-only">Reposición y recuentos</h2>
    <div role="tablist" class="adm-tabs" aria-label="Secciones">
      <button
        v-for="[key, label] in TABS"
        :key="key"
        type="button"
        role="tab"
        class="adm-tab"
        :aria-selected="tab === key"
        :data-testid="`tab-${key}`"
        @click="tab = key"
      >
        {{ label }}
      </button>
    </div>

    <p v-if="loading" role="status" data-testid="planning-loading" class="adm-help">Cargando…</p>
    <UAlert
      v-if="error"
      role="alert"
      data-testid="planning-error"
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="error"
      :actions="[{ label: 'Reintentar', color: 'neutral', variant: 'outline', onClick: () => void loadAll() }]"
    />
    <UAlert
      v-if="notice"
      role="status"
      data-testid="planning-notice"
      color="success"
      variant="subtle"
      icon="i-lucide-circle-check"
      :title="notice"
    />

    <!-- Sugerencias de compra -->
    <div v-if="tab === 'reorder'" role="tabpanel" data-testid="panel-reorder" class="adm-stack">
      <AdminCard
        title="Sugerencias de compra"
        description="Productos cuyo stock ha bajado del punto en el que conviene volver a pedir."
        flush
      >
        <template #actions>
          <AdminButton size="sm" icon="i-lucide-settings-2" @click="policyOpen = true">Regla de reposición</AdminButton>
          <button
            type="button"
            class="adm-btn adm-btn--primary adm-btn--sm"
            data-testid="btn-evaluate"
            @click="evaluate"
          >
            Calcular sugerencias
          </button>
        </template>
        <div v-if="!loading && !suggestions.length" data-testid="reorder-empty">
          <AdminEmptyState
            compact
            icon="i-lucide-package-check"
            title="No hay sugerencias pendientes"
            description="Pulsa «Calcular sugerencias» para revisar el stock con tus reglas de reposición."
          />
        </div>
        <ul v-else class="adm-list">
          <li v-for="s in suggestions" :key="s.id" :data-testid="`suggestion-${s.id}`">
            <div class="min-w-0 flex-1 basis-64">
              <p class="adm-list__title">{{ s.sku }}</p>
              <p class="adm-help">
                Quedan {{ s.positionQuantity }} (se repone al bajar de {{ s.reorderPoint }}) · se venden
                {{ s.dailyDemand }} al día · el proveedor tarda {{ s.leadTimeDays }} días
              </p>
            </div>
            <label class="adm-field">
              <span class="adm-label">Cantidad a pedir</span>
              <input
                v-model.number="approvedQuantity[s.id]"
                type="number"
                min="1"
                :placeholder="String(s.suggestedQuantity)"
                class="w-28"
                :data-testid="`qty-${s.id}`"
              />
            </label>
            <label class="adm-field min-w-40 flex-1">
              <span class="adm-label">Nota</span>
              <input v-model="decisionNote[s.id]" type="text" maxlength="500" :data-testid="`note-${s.id}`" />
            </label>
            <div class="flex gap-2 self-end">
              <button
                type="button"
                class="adm-btn adm-btn--secondary"
                :data-testid="`reject-${s.id}`"
                @click="decideSuggestion(s, 'reject')"
              >
                Rechazar
              </button>
              <button
                type="button"
                class="adm-btn adm-btn--primary"
                :data-testid="`approve-${s.id}`"
                @click="decideSuggestion(s, 'approve')"
              >
                Aprobar
              </button>
            </div>
          </li>
        </ul>
      </AdminCard>

      <AdminDrawer
        v-model:open="policyOpen"
        title="Regla de reposición"
        description="Indica cuánto tarda el proveedor y el pedido mínimo de un producto para calcular cuándo reponerlo."
      >
        <div class="adm-stack">
          <UAlert v-if="error" role="alert" color="error" variant="subtle" :title="error" />
          <AdminFormField
            v-slot="{ id }"
            label="Identificador del producto"
            help="El código largo de la variante, con sus guiones."
            required
          >
            <input :id="id" v-model="policyForm.variantId" data-testid="policy-variant-id" autocomplete="off" />
          </AdminFormField>
          <AdminFormField v-slot="{ id }" label="Plazo de entrega del proveedor (días)">
            <input :id="id" v-model.number="policyForm.leadTimeDays" data-testid="policy-lead-time" type="number" />
          </AdminFormField>
          <AdminFormField v-slot="{ id }" label="Pedido mínimo (unidades)">
            <input :id="id" v-model.number="policyForm.minOrderQuantity" data-testid="policy-min-order" type="number" />
          </AdminFormField>
        </div>
        <template #footer>
          <AdminButton @click="policyOpen = false">Cancelar</AdminButton>
          <button type="button" data-testid="save-policy-btn" class="adm-btn adm-btn--primary" @click="savePolicy">
            Guardar regla
          </button>
        </template>
      </AdminDrawer>
    </div>

    <!-- Lectura de códigos -->
    <div v-if="tab === 'scan'" role="tabpanel" data-testid="panel-scan" class="adm-stack">
      <AdminCard
        title="Tareas de lectura de códigos"
        description="Comprueba con el lector que lo recibido, recogido o empaquetado coincide con lo esperado."
        flush
      >
        <template #actions>
          <AdminButton size="sm" variant="primary" icon="i-lucide-plus" @click="taskOpen = true">
            Nueva tarea
          </AdminButton>
        </template>
        <div v-if="!loading && !tasks.length" data-testid="scan-empty">
          <AdminEmptyState
            compact
            icon="i-lucide-scan-barcode"
            title="No hay tareas abiertas"
            description="Crea una tarea para empezar a leer códigos."
          />
        </div>
        <ul v-else class="adm-list">
          <li v-for="t in tasks" :key="t.id">
            <div class="min-w-0 flex-1">
              <p class="adm-list__title">
                {{ t.reference }}
                <AdminBadge tone="info" plain>{{ STAGES[t.stage] ?? adminHumanize(t.stage) }}</AdminBadge>
              </p>
              <p class="adm-help">{{ t.scannedQuantity }} de {{ t.expectedQuantity }} unidades leídas</p>
            </div>
            <button
              type="button"
              class="adm-btn adm-btn--secondary adm-btn--sm"
              :data-testid="`task-${t.id}`"
              @click="openTask(t.id)"
            >
              Abrir
            </button>
          </li>
        </ul>
      </AdminCard>

      <AdminCard
        v-if="activeTask"
        :title="`${activeTask.reference} · ${STAGES[activeTask.stage] ?? adminHumanize(activeTask.stage)}`"
      >
        <form class="adm-stack" data-testid="scan-form" @submit.prevent="submitScan">
          <ul class="space-y-1" data-testid="scan-lines">
            <li v-for="l in activeTask.lines" :key="l.variantId">
              {{ l.sku }}: {{ l.scannedQuantity }}/{{ l.expectedQuantity }}
            </li>
          </ul>
          <div class="flex flex-wrap items-end gap-3">
            <label class="adm-field min-w-48 flex-1">
              <span class="adm-label">{{ exceptionMode ? 'Referencia (sin código)' : 'Código de barras' }}</span>
              <input v-model="barcode" type="text" autocomplete="off" class="font-mono" data-testid="scan-input" />
            </label>
            <label class="adm-field">
              <span class="adm-label">Cantidad</span>
              <input v-model.number="scanQuantity" type="number" min="1" class="w-24" data-testid="scan-quantity" />
            </label>
            <button type="submit" class="adm-btn adm-btn--primary" data-testid="scan-submit">Validar</button>
          </div>
          <label class="adm-check">
            <input v-model="exceptionMode" type="checkbox" data-testid="scan-exception-toggle" />
            El código no se puede leer o no existe
          </label>
          <div v-if="exceptionMode" class="flex flex-wrap gap-3">
            <select v-model="exceptionReason" aria-label="Motivo de la excepción">
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
              placeholder="Explica el motivo (mínimo 10 caracteres)"
              aria-label="Explicación"
              class="min-w-64 flex-1"
              data-testid="scan-exception-note"
            />
          </div>
          <UAlert
            v-if="scanFeedback"
            role="status"
            data-testid="scan-feedback"
            :color="scanOk ? 'success' : 'error'"
            variant="subtle"
            :icon="scanOk ? 'i-lucide-circle-check' : 'i-lucide-triangle-alert'"
            :title="scanFeedback"
          />
        </form>
      </AdminCard>

      <AdminDrawer v-model:open="taskOpen" title="Nueva tarea de lectura">
        <div class="adm-stack">
          <UAlert v-if="error" role="alert" color="error" variant="subtle" :title="error" />
          <AdminFormField v-slot="{ id }" label="Momento">
            <select :id="id" v-model="taskForm.stage">
              <option value="receiving">Recepción de mercancía</option>
              <option value="picking">Recogida del pedido</option>
              <option value="packing">Empaquetado</option>
            </select>
          </AdminFormField>
          <AdminFormField v-slot="{ id }" label="Referencia" help="Por ejemplo, el número de albarán." required>
            <input :id="id" v-model="taskForm.reference" data-testid="new-task-reference" placeholder="ALB-…" />
          </AdminFormField>
          <AdminFormField
            v-slot="{ id }"
            label="Identificador del producto"
            help="El código largo de la variante, con sus guiones."
            required
          >
            <input :id="id" v-model="taskForm.variantId" data-testid="new-task-variant" autocomplete="off" />
          </AdminFormField>
          <AdminFormField v-slot="{ id }" label="Unidades esperadas" required>
            <input
              :id="id"
              v-model.number="taskForm.expectedQuantity"
              data-testid="new-task-quantity"
              type="number"
              min="1"
            />
          </AdminFormField>
        </div>
        <template #footer>
          <AdminButton @click="taskOpen = false">Cancelar</AdminButton>
          <button type="button" data-testid="save-task-btn" class="adm-btn adm-btn--primary" @click="saveTask">
            Crear tarea
          </button>
        </template>
      </AdminDrawer>
    </div>

    <!-- Recuentos -->
    <div v-if="tab === 'counts'" role="tabpanel" data-testid="panel-counts" class="adm-stack">
      <AdminCard
        title="Recuentos de almacén"
        description="Cuenta por partes el almacén y aprueba las diferencias con el stock registrado."
        flush
      >
        <template #actions>
          <AdminButton size="sm" variant="primary" icon="i-lucide-plus" @click="planOpen = true">
            Nuevo recuento
          </AdminButton>
        </template>
        <div v-if="!loading && !plans.length" data-testid="counts-empty">
          <AdminEmptyState
            compact
            icon="i-lucide-clipboard-list"
            title="Aún no hay recuentos"
            description="Crea un recuento con los productos que quieras contar."
          />
        </div>
        <ul v-else class="adm-list">
          <li v-for="p in plans" :key="p.id">
            <div class="min-w-0 flex-1">
              <p class="adm-list__title">
                {{ p.name }}
                <AdminBadge :tone="PLAN_TONES[p.status] ?? 'neutral'">
                  {{ PLAN_STATUS[p.status] ?? adminHumanize(p.status) }}
                </AdminBadge>
              </p>
              <p class="adm-help">
                {{ p.lines }} {{ p.lines === 1 ? 'producto' : 'productos' }}
                <template v-if="p.blind"> · a ciegas (sin ver el stock registrado)</template>
              </p>
            </div>
            <button
              type="button"
              class="adm-btn adm-btn--secondary adm-btn--sm"
              :data-testid="`plan-${p.id}`"
              @click="openPlan(p.id)"
            >
              Abrir
            </button>
          </li>
        </ul>
      </AdminCard>

      <AdminCard v-if="activePlan" data-testid="plan-detail" :title="activePlan.name" flush>
        <template #actions>
          <AdminBadge :tone="PLAN_TONES[activePlan.status] ?? 'neutral'">
            {{ PLAN_STATUS[activePlan.status] ?? adminHumanize(activePlan.status) }}
          </AdminBadge>
          <button
            v-if="['planned', 'counting', 'review'].includes(activePlan.status)"
            type="button"
            class="adm-btn adm-btn--secondary adm-btn--sm"
            data-testid="plan-cancel"
            @click="planAction('cancel')"
          >
            Cancelar recuento
          </button>
          <button
            v-if="activePlan.status === 'planned'"
            type="button"
            class="adm-btn adm-btn--primary adm-btn--sm"
            data-testid="plan-start"
            @click="planAction('start')"
          >
            Empezar a contar
          </button>
        </template>
        <div class="adm-table-wrap">
          <table class="adm-table">
            <caption class="sr-only">
              Líneas del plan de conteo
            </caption>
            <thead>
              <tr>
                <th scope="col">Referencia</th>
                <th scope="col">Estado</th>
                <th
                  v-if="activePlan.status === 'review' || activePlan.status === 'closed'"
                  scope="col"
                  data-numeric
                  title="Stock registrado"
                >
                  Teórico
                </th>
                <th scope="col" data-numeric>Contado</th>
                <th scope="col">Acción</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="l in activePlan.lines" :key="l.variantId" :data-testid="`line-${l.variantId}`">
                <td class="font-semibold text-[var(--text-strong)]">{{ l.sku }}</td>
                <td>{{ LINE_STATUS[l.status] ?? adminHumanize(l.status) }}</td>
                <td v-if="activePlan.status === 'review' || activePlan.status === 'closed'" data-numeric>
                  {{ l.expectedQuantity }}
                  <AdminBadge v-if="l.discrepancy" tone="warning" plain
                    >({{ l.discrepancy > 0 ? '+' : '' }}{{ l.discrepancy }})</AdminBadge
                  >
                </td>
                <td data-numeric>{{ l.countedQuantity ?? '—' }}</td>
                <td>
                  <div
                    v-if="activePlan.status === 'counting' && ['pending', 'recount'].includes(l.status)"
                    class="flex gap-2"
                  >
                    <input
                      v-model.number="counts[l.variantId]"
                      type="number"
                      min="0"
                      class="w-24"
                      :aria-label="`Cantidad contada de ${l.sku}`"
                      :data-testid="`count-${l.variantId}`"
                    />
                    <button
                      type="button"
                      class="adm-btn adm-btn--primary adm-btn--sm"
                      :data-testid="`send-count-${l.variantId}`"
                      @click="sendCount(l)"
                    >
                      Guardar
                    </button>
                  </div>
                  <div
                    v-else-if="activePlan.status === 'review' && l.status === 'counted'"
                    class="flex flex-wrap items-center gap-2"
                  >
                    <select
                      v-model="rootCause[l.variantId]"
                      :aria-label="`Causa raíz de ${l.sku}`"
                      :data-testid="`cause-${l.variantId}`"
                    >
                      <option value="">Causa de la diferencia…</option>
                      <option v-for="[value, label] in ROOT_CAUSES" :key="value" :value="value">{{ label }}</option>
                    </select>
                    <input
                      v-model="lineNote[l.variantId]"
                      type="text"
                      maxlength="500"
                      placeholder="Nota"
                      class="w-40"
                      :aria-label="`Nota de ${l.sku}`"
                      :data-testid="`line-note-${l.variantId}`"
                    />
                    <button
                      type="button"
                      class="adm-btn adm-btn--primary adm-btn--sm"
                      :data-testid="`approve-line-${l.variantId}`"
                      @click="decideLine(l, 'approve')"
                    >
                      Aprobar ajuste
                    </button>
                    <button
                      type="button"
                      class="adm-btn adm-btn--secondary adm-btn--sm"
                      :data-testid="`reject-line-${l.variantId}`"
                      @click="decideLine(l, 'reject')"
                    >
                      Rechazar
                    </button>
                    <button
                      type="button"
                      class="adm-btn adm-btn--ghost adm-btn--sm"
                      :data-testid="`recount-${l.variantId}`"
                      @click="recount(l)"
                    >
                      Volver a contar
                    </button>
                  </div>
                  <span v-else-if="l.rootCause">{{ rootCauseLabel(l.rootCause) }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </AdminCard>

      <AdminDrawer v-model:open="planOpen" title="Nuevo recuento">
        <div class="adm-stack">
          <UAlert v-if="error" role="alert" color="error" variant="subtle" :title="error" />
          <AdminFormField v-slot="{ id }" label="Nombre" required>
            <input :id="id" v-model="planForm.name" data-testid="new-plan-name" placeholder="Recuento del pasillo A" />
          </AdminFormField>
          <AdminFormField
            v-slot="{ id }"
            label="Productos a contar"
            help="Identificadores de los productos, separados por comas."
            required
          >
            <input :id="id" v-model="planForm.variantsRaw" data-testid="new-plan-variants" autocomplete="off" />
          </AdminFormField>
          <label class="adm-check">
            <input v-model="planForm.blind" type="checkbox" :true-value="1" :false-value="0" />
            Contar a ciegas (quien cuenta no ve el stock registrado)
          </label>
        </div>
        <template #footer>
          <AdminButton @click="planOpen = false">Cancelar</AdminButton>
          <button type="button" data-testid="save-plan-btn" class="adm-btn adm-btn--primary" @click="savePlan">
            Crear recuento
          </button>
        </template>
      </AdminDrawer>
    </div>
  </section>
</template>
