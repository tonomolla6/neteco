<script setup lang="ts">
import {
  adminOrderReturnSchema,
  returnTransitionInputSchema,
  returnCommandReceiptSchema,
  returnResponseErrorCode,
  definiteReturnRejection,
  freezeReturnIntent,
  type ReturnAction,
  type ReturnBlocker,
  type ReturnState,
  type ReturnTransitionInput,
  type ReturnCommandReceipt
} from '~~/shared/order-returns'
import { catalogPolicyUuidSchema } from '~~/shared/catalog-publication-policy'
import type { AdminTone } from '~/utils/adminLabels'

const props = defineProps<{
  snapshot: unknown
  operatorId: string
  runtime: unknown
  authorize: () => boolean
  reload: () => Promise<unknown>
}>()
const emit = defineEmits<{ confirmed: [receipt: ReturnCommandReceipt]; pending: [value: boolean] }>()
const selected = ref<ReturnAction | ''>(''),
  reason = ref(''),
  publicMessage = ref(''),
  evidence = ref(''),
  decisionRef = ref(''),
  resolution = ref('')
const quantities = reactive<Record<number, number>>({})
const condition = ref<'sealed' | 'opened' | 'damaged' | 'unknown'>('unknown'),
  disposition = ref<'quarantine' | 'non_restockable' | 'review_restock'>('quarantine')
const note = ref(''),
  knownCost = ref(false),
  /** Importe del coste en euros, tal como lo teclea el comerciante; a la API se envían céntimos. */
  costEuros = ref(''),
  costCategory = ref<'handling' | 'return_shipping' | 'other'>('handling'),
  costEvidence = ref(''),
  costDescription = ref('')
const busy = ref(false),
  ambiguous = ref(false),
  message = ref(''),
  contextCurrent = ref(true)
type Intent = {
  body: ReturnTransitionInput
  key: string
  returnId: string
  publicRef: string
  orderId: string
  warehouseId: string
  operatorId: string
}
const intent = shallowRef<Readonly<Intent> | null>(null)
let active = true,
  generation = 0
const authorized = () => {
  try {
    return (
      active &&
      props.runtime === 'cloudflare' &&
      props.authorize() === true &&
      catalogPolicyUuidSchema.safeParse(props.operatorId).success
    )
  } catch {
    return false
  }
}
const view = computed(() => {
  if (!contextCurrent.value || !authorized()) return null
  const parsed = adminOrderReturnSchema.safeParse(props.snapshot)
  return parsed.success ? parsed.data : null
})
const actionLabels: Record<ReturnAction, string> = {
  approved: 'Aceptar la devolución',
  rejected: 'Rechazar la devolución',
  received: 'Anotar las unidades recibidas',
  inspected: 'Anotar la revisión de las unidades',
  resolution_ready: 'Dejarla lista para resolver'
}
const stateLabels: Record<ReturnState, string> = {
  requested: 'Solicitada',
  approved: 'Aceptada',
  rejected: 'Rechazada',
  received: 'Recibida',
  inspected: 'Revisada',
  resolution_ready: 'Lista para resolver'
}
const stateTones: Record<ReturnState, AdminTone> = {
  requested: 'warning',
  approved: 'info',
  rejected: 'danger',
  received: 'info',
  inspected: 'info',
  resolution_ready: 'success'
}
const blockerLabels: Record<ReturnBlocker, string> = {
  order_cancelled: 'El pedido está cancelado',
  payment_unconfirmed: 'El cobro no está confirmado',
  delivery_unconfirmed: 'La entrega del pedido no está confirmada',
  warehouse_unavailable: 'El almacén no está disponible',
  history_unconfirmed: 'El historial de la devolución no está confirmado'
}
const costLabels: Record<'handling' | 'return_shipping' | 'other', string> = {
  handling: 'Manipulación',
  return_shipping: 'Transporte de la devolución',
  other: 'Otro'
}
function maxQuantity(line: {
  requestedQuantity: number
  authorizedQuantity: number
  receivedQuantity: number
  inspectedQuantity: number
}) {
  return selected.value === 'approved'
    ? line.requestedQuantity
    : selected.value === 'received'
      ? line.authorizedQuantity - line.receivedQuantity
      : line.receivedQuantity - line.inspectedQuantity
}
watch(
  intent,
  (value) => {
    if (active) emit('pending', value !== null)
  },
  { flush: 'sync' }
)
watch(
  () => [props.operatorId, props.runtime, authorized()],
  () => {
    generation++
    contextCurrent.value = false
    if (intent.value && (intent.value.operatorId !== props.operatorId || props.runtime !== 'cloudflare')) {
      intent.value = null
      ambiguous.value = false
    }
    message.value = 'Ha cambiado tu sesión. Confírmala de nuevo antes de continuar.'
  }
)
watch(
  () => props.snapshot,
  () => {
    const parsed = adminOrderReturnSchema.safeParse(props.snapshot)
    if (parsed.success && intent.value && parsed.data.id !== intent.value.returnId) {
      generation++
      intent.value = null
      ambiguous.value = false
    }
    if (authorized() && parsed.success) contextCurrent.value = true
  }
)
watch(selected, () => {
  for (const key of Object.keys(quantities)) Reflect.deleteProperty(quantities, key)
  for (const line of view.value?.lines ?? [])
    quantities[line.lineIndex] =
      selected.value === 'approved'
        ? line.requestedQuantity
        : selected.value === 'received'
          ? line.authorizedQuantity - line.receivedQuantity
          : selected.value === 'inspected'
            ? line.receivedQuantity - line.inspectedQuantity
            : 0
})
onBeforeUnmount(() => {
  purge()
  active = false
  generation++
})
function purge() {
  generation++
  intent.value = null
  selected.value =
    reason.value =
    publicMessage.value =
    evidence.value =
    decisionRef.value =
    resolution.value =
    note.value =
    costEvidence.value =
    costDescription.value =
      ''
  for (const key of Object.keys(quantities)) Reflect.deleteProperty(quantities, key)
  condition.value = 'unknown'
  disposition.value = 'quarantine'
  knownCost.value = false
  costEuros.value = ''
  costCategory.value = 'handling'
  busy.value = ambiguous.value = contextCurrent.value = false
  message.value = ''
}
watch(() => [props.operatorId, props.runtime], purge, { flush: 'sync' })
function prepare() {
  message.value = ''
  const data = view.value
  if (
    busy.value ||
    intent.value ||
    !data ||
    !selected.value ||
    !data.capabilities.allowedActions.includes(selected.value)
  )
    return
  const lineInput = data.lines.map((line) => ({ lineIndex: line.lineIndex, quantity: quantities[line.lineIndex] ?? 0 }))
  const input = returnTransitionInputSchema.safeParse({
    action: selected.value,
    expectedVersion: data.version,
    reason: reason.value.trim(),
    publicMessage: publicMessage.value.trim(),
    evidence: evidence.value.trim(),
    ...(selected.value === 'approved' ? { decisionRef: decisionRef.value.trim(), lines: lineInput } : {}),
    ...(selected.value === 'received' ? { lines: lineInput.filter((line) => line.quantity > 0) } : {}),
    ...(selected.value === 'inspected'
      ? {
          lines: lineInput
            .filter((line) => line.quantity > 0)
            .map((line) => ({
              ...line,
              condition: condition.value,
              disposition: disposition.value,
              ...(note.value.trim() ? { note: note.value.trim() } : {})
            }))
        }
      : {}),
    ...(selected.value === 'resolution_ready'
      ? {
          resolution: resolution.value.trim(),
          ...(knownCost.value
            ? {
                cost: {
                  amountCents: adminEurosToCents(costEuros.value) ?? NaN,
                  currency: 'EUR',
                  category: costCategory.value,
                  evidenceRef: costEvidence.value.trim(),
                  description: costDescription.value.trim()
                }
              }
            : {})
        }
      : {})
  })
  if (!input.success) {
    message.value =
      'Revisa los datos: motivo interno, mensaje para el cliente y justificante (entre 10 y 500 caracteres cada uno), unidades en números enteros y los campos propios de este paso.'
    return
  }
  intent.value = freezeReturnIntent({
    body: input.data,
    key: crypto.randomUUID(),
    returnId: data.id,
    publicRef: data.publicRef,
    orderId: data.orderId,
    warehouseId: data.warehouse.id,
    operatorId: props.operatorId
  })
}
async function dispatch(recovery = false) {
  const pending = intent.value
  if (!pending || busy.value || !authorized() || props.operatorId !== pending.operatorId) return
  busy.value = true
  message.value = ''
  const epoch = generation,
    current = () => active && epoch === generation && authorized() && props.operatorId === pending.operatorId
  let sent = false,
    code: string | null = null
  try {
    const fresh = adminOrderReturnSchema.safeParse(await props.reload())
    if (!current()) return
    if (
      !fresh.success ||
      fresh.data.id !== pending.returnId ||
      fresh.data.publicRef !== pending.publicRef ||
      fresh.data.orderId !== pending.orderId ||
      fresh.data.warehouse.id !== pending.warehouseId
    )
      throw new Error('return_context_unconfirmed')
    if (
      !recovery &&
      (!fresh.data.readiness.ready ||
        !fresh.data.capabilities.allowedActions.includes(pending.body.action) ||
        fresh.data.version !== pending.body.expectedVersion)
    ) {
      intent.value = null
      ambiguous.value = false
      contextCurrent.value = false
      message.value = 'La devolución ha cambiado. Revisa su estado actual antes de continuar.'
      return
    }
    sent = true
    ambiguous.value = true
    const endpoint: string = `/api/admin/returns/${pending.publicRef}`
    const raw: unknown = await $fetch(endpoint, {
      method: 'PUT',
      body: pending.body,
      headers: { 'Idempotency-Key': pending.key },
      retry: 0,
      onResponseError(context: unknown) {
        code = returnResponseErrorCode(context)
      }
    })
    if (!current()) return
    const receipt = returnCommandReceiptSchema.safeParse(raw)
    if (
      !receipt.success ||
      receipt.data.returnId !== pending.returnId ||
      receipt.data.publicRef !== pending.publicRef ||
      receipt.data.orderId !== pending.orderId ||
      receipt.data.action !== pending.body.action ||
      receipt.data.version !== pending.body.expectedVersion + 1
    )
      throw new Error('return_receipt_unconfirmed')
    intent.value = null
    ambiguous.value = false
    selected.value = ''
    reason.value = ''
    publicMessage.value = ''
    evidence.value = ''
    contextCurrent.value = false
    message.value = 'Paso registrado. No cambia el stock, los cobros ni las facturas.'
    emit('confirmed', receipt.data)
    try {
      const latest = adminOrderReturnSchema.safeParse(await props.reload())
      if (!current()) return
      if (
        !latest.success ||
        latest.data.id !== pending.returnId ||
        latest.data.publicRef !== pending.publicRef ||
        latest.data.orderId !== pending.orderId ||
        latest.data.warehouse.id !== pending.warehouseId ||
        latest.data.version < receipt.data.version
      )
        throw new Error('return_read_unconfirmed')
      contextCurrent.value = true
    } catch {
      if (current()) {
        contextCurrent.value = false
        message.value += ' No hemos podido actualizar los datos de la devolución.'
      }
    }
  } catch {
    if (!current()) return
    contextCurrent.value = false
    if (!recovery && definiteReturnRejection(code, sent, recovery)) {
      intent.value = null
      ambiguous.value = false
      message.value =
        'No se ha podido registrar el paso. Revisa el estado actual de la devolución antes de intentarlo otra vez.'
    } else {
      ambiguous.value = sent || recovery
      message.value = ambiguous.value
        ? 'No sabemos si el paso se ha guardado. No lo repitas: pulsa «Comprobar de nuevo» para recuperarlo sin duplicarlo.'
        : 'No hemos podido cargar los datos actuales de la devolución. No se ha enviado nada.'
    }
  } finally {
    if (active) busy.value = false
  }
}
function cancel() {
  if (!busy.value && !ambiguous.value) {
    intent.value = null
    message.value = 'Paso cancelado. No se ha enviado nada.'
  }
}
</script>

<template>
  <section aria-label="Gestión de la devolución" class="adm-stack">
    <UAlert
      v-if="message && authorized()"
      role="status"
      data-testid="return-message"
      :color="ambiguous ? 'warning' : 'neutral'"
      variant="subtle"
      :title="message"
    />
    <div v-if="view" data-testid="return-facts" class="adm-stack">
      <div>
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <h2 class="whitespace-nowrap text-base font-semibold tabular-nums text-[var(--text-strong)]">
            {{ view.publicRef }}
          </h2>
          <AdminBadge :tone="stateTones[view.state]" class="whitespace-nowrap">
            {{ stateLabels[view.state] }}
          </AdminBadge>
        </div>
        <p class="adm-help mt-1">
          <span class="whitespace-nowrap">Solicitada el {{ adminDate(view.createdAt) }}</span> ·
          <span class="whitespace-nowrap">Almacén: {{ view.warehouse.name }}</span> ·
          <span class="whitespace-nowrap">Versión {{ view.version }}</span>
        </p>
        <p class="mt-2 break-words text-[var(--text)]">
          <span class="text-[var(--text-muted)]">Motivo del cliente:</span> {{ view.reason }}
        </p>
      </div>
      <UAlert
        color="neutral"
        variant="subtle"
        icon="i-lucide-info"
        title="Aceptar una devolución no devuelve el dinero"
        description="Las unidades recibidas quedan apartadas y no vuelven al stock por sí solas. El reembolso y la factura rectificativa se gestionan desde el pedido."
      />
      <UAlert
        v-if="!view.readiness.ready"
        role="alert"
        color="warning"
        variant="subtle"
        icon="i-lucide-circle-pause"
        title="Ahora no se puede avanzar esta devolución"
        :description="view.readiness.blockers.map((blocker) => blockerLabels[blocker]).join('. ') + '.'"
      />
      <AdminCard title="Artículos" flush>
        <div class="adm-table-wrap">
          <table class="adm-table min-w-[30rem]">
            <caption class="sr-only">
              Unidades solicitadas, aceptadas, recibidas y revisadas
            </caption>
            <thead>
              <tr>
                <th scope="col">Artículo</th>
                <th scope="col" data-numeric>Solicitadas</th>
                <th scope="col" data-numeric>Aceptadas</th>
                <th scope="col" data-numeric>Recibidas</th>
                <th scope="col" data-numeric>Revisadas</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="line in view.lines" :key="line.lineIndex">
                <td>
                  <p class="font-medium text-[var(--text-strong)]">{{ line.name }}</p>
                  <p class="whitespace-nowrap text-xs text-[var(--text-muted)]">{{ line.sku }}</p>
                </td>
                <td data-numeric class="whitespace-nowrap tabular-nums">{{ line.requestedQuantity }}</td>
                <td data-numeric class="whitespace-nowrap tabular-nums">{{ line.authorizedQuantity }}</td>
                <td data-numeric class="whitespace-nowrap tabular-nums">{{ line.receivedQuantity }}</td>
                <td data-numeric class="whitespace-nowrap tabular-nums">{{ line.inspectedQuantity }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </AdminCard>
      <AdminCard v-if="!intent && view.capabilities.returnsTransitions" title="Siguiente paso">
        <form class="adm-stack" @submit.prevent="prepare">
          <AdminFormField v-slot="{ id }" label="Qué quieres hacer" required>
            <select :id="id" v-model="selected" data-testid="return-action" required class="adm-input w-full">
              <option value="">Elige un paso</option>
              <option v-for="action in view.capabilities.allowedActions" :key="action" :value="action">
                {{ actionLabels[action] }}
              </option>
            </select>
          </AdminFormField>
          <AdminFormField
            v-if="selected === 'approved'"
            v-slot="{ id, describedBy }"
            label="Referencia de la decisión"
            help="Dónde consta quién ha aceptado la devolución: correo, parte o documento."
          >
            <input
              :id="id"
              v-model="decisionRef"
              :aria-describedby="describedBy"
              data-testid="return-decision"
              maxlength="200"
              class="adm-input w-full"
            />
          </AdminFormField>
          <fieldset v-if="['approved', 'received', 'inspected'].includes(selected)" class="min-w-0">
            <legend class="adm-label">Unidades de este paso</legend>
            <ul class="mt-1 divide-y divide-[var(--border)]">
              <li v-for="line in view.lines" :key="line.lineIndex" class="flex items-center justify-between gap-3 py-2">
                <label :for="`return-quantity-${line.lineIndex}`" class="min-w-0 break-words font-normal">
                  {{ line.name }}
                  <span class="block text-xs text-[var(--text-muted)]">Como máximo {{ maxQuantity(line) }}</span>
                </label>
                <input
                  :id="`return-quantity-${line.lineIndex}`"
                  v-model.number="quantities[line.lineIndex]"
                  :data-testid="`return-quantity-${line.lineIndex}`"
                  type="number"
                  min="0"
                  step="1"
                  :max="maxQuantity(line)"
                  :aria-label="`Unidades de ${line.name}`"
                  class="adm-input w-20 shrink-0"
                />
              </li>
            </ul>
            <p v-if="selected !== 'approved'" class="adm-help mt-1">
              Deja a 0 los artículos que no entren en este paso.
            </p>
          </fieldset>
          <fieldset v-if="selected === 'inspected'" class="adm-stack min-w-0">
            <legend class="adm-label">Resultado de la revisión</legend>
            <div class="grid gap-4 sm:grid-cols-2">
              <AdminFormField v-slot="{ id }" label="Estado del artículo">
                <select :id="id" v-model="condition" data-testid="return-condition" class="adm-input w-full">
                  <option value="unknown">Sin confirmar</option>
                  <option value="sealed">Precintado</option>
                  <option value="opened">Abierto</option>
                  <option value="damaged">Dañado</option>
                </select>
              </AdminFormField>
              <AdminFormField
                v-slot="{ id, describedBy }"
                label="Qué hacer con él"
                help="Solo queda anotado: no cambia el stock."
              >
                <select
                  :id="id"
                  v-model="disposition"
                  :aria-describedby="describedBy"
                  data-testid="return-disposition"
                  class="adm-input w-full"
                >
                  <option value="quarantine">Dejarlo apartado</option>
                  <option value="non_restockable">No se puede volver a vender</option>
                  <option value="review_restock">Revisar si puede volver al stock</option>
                </select>
              </AdminFormField>
            </div>
            <AdminFormField v-slot="{ id }" label="Nota interna (opcional)">
              <textarea :id="id" v-model="note" maxlength="500" rows="2" class="adm-input w-full" />
            </AdminFormField>
          </fieldset>
          <fieldset v-if="selected === 'resolution_ready'" class="adm-stack min-w-0">
            <legend class="adm-label">Propuesta de resolución</legend>
            <AdminFormField
              v-slot="{ id, describedBy }"
              label="Qué propones"
              help="Entre 10 y 500 caracteres. Dejarla lista no devuelve dinero: el reembolso se hace desde el pedido."
              required
            >
              <textarea
                :id="id"
                v-model="resolution"
                :aria-describedby="describedBy"
                data-testid="return-resolution"
                maxlength="500"
                rows="2"
                class="adm-input w-full"
                required
              />
            </AdminFormField>
            <label class="adm-check">
              <input v-model="knownCost" data-testid="return-known-cost" type="checkbox" />
              Esta devolución ha tenido un coste para la tienda
            </label>
            <div v-if="knownCost" class="adm-stack">
              <div class="grid gap-4 sm:grid-cols-2">
                <AdminFormField v-slot="{ id }" label="Importe del coste (€)">
                  <input
                    :id="id"
                    v-model="costEuros"
                    data-testid="return-cost-cents"
                    type="text"
                    inputmode="decimal"
                    autocomplete="off"
                    placeholder="0,00"
                    class="adm-input w-full"
                  />
                </AdminFormField>
                <AdminFormField v-slot="{ id }" label="Tipo de coste">
                  <select :id="id" v-model="costCategory" class="adm-input w-full">
                    <option value="handling">{{ costLabels.handling }}</option>
                    <option value="return_shipping">{{ costLabels.return_shipping }}</option>
                    <option value="other">{{ costLabels.other }}</option>
                  </select>
                </AdminFormField>
              </div>
              <AdminFormField
                v-slot="{ id, describedBy }"
                label="Justificante del coste"
                help="Número de factura, albarán o referencia."
              >
                <input
                  :id="id"
                  v-model="costEvidence"
                  :aria-describedby="describedBy"
                  data-testid="return-cost-evidence"
                  maxlength="200"
                  class="adm-input w-full"
                />
              </AdminFormField>
              <AdminFormField v-slot="{ id }" label="Descripción del coste">
                <textarea
                  :id="id"
                  v-model="costDescription"
                  data-testid="return-cost-description"
                  maxlength="500"
                  rows="2"
                  class="adm-input w-full"
                />
              </AdminFormField>
            </div>
            <p v-else class="adm-help">Sin coste anotado. No se guarda como coste cero.</p>
          </fieldset>
          <AdminFormField
            v-slot="{ id, describedBy }"
            label="Motivo interno"
            help="Entre 10 y 500 caracteres. El cliente no lo ve."
            required
          >
            <textarea
              :id="id"
              v-model="reason"
              :aria-describedby="describedBy"
              data-testid="return-reason"
              maxlength="500"
              rows="2"
              required
              class="adm-input w-full"
            />
          </AdminFormField>
          <AdminFormField
            v-slot="{ id, describedBy }"
            label="Mensaje para el cliente"
            help="Entre 10 y 500 caracteres. El cliente lo verá en su devolución."
            required
          >
            <textarea
              :id="id"
              v-model="publicMessage"
              :aria-describedby="describedBy"
              data-testid="return-public-message"
              maxlength="500"
              rows="2"
              required
              class="adm-input w-full"
            />
          </AdminFormField>
          <AdminFormField
            v-slot="{ id, describedBy }"
            label="Justificante"
            help="Entre 10 y 500 caracteres: fotos, correo o documento que respalda este paso."
            required
          >
            <textarea
              :id="id"
              v-model="evidence"
              :aria-describedby="describedBy"
              data-testid="return-evidence"
              maxlength="500"
              rows="2"
              required
              class="adm-input w-full"
            />
          </AdminFormField>
          <div class="flex justify-end">
            <AdminButton variant="primary" type="submit" data-testid="return-prepare" :disabled="busy">
              Revisar
            </AdminButton>
          </div>
        </form>
      </AdminCard>
      <AdminCard v-if="view.timeline.items.length" title="Historial">
        <ol aria-label="Historial de la devolución" class="space-y-4 border-l border-[var(--border)] pl-4">
          <li v-for="event in view.timeline.items" :key="event.commandId" class="relative">
            <span class="absolute -left-[1.3125rem] top-1.5 size-2 rounded-full bg-[var(--border-strong)]" />
            <p class="font-medium text-[var(--text-strong)]">
              {{ stateLabels[event.action] }}
              <span class="whitespace-nowrap text-xs font-normal text-[var(--text-muted)]">
                · {{ adminDate(event.createdAt, true) }} ·
                {{ event.actorType === 'customer' ? 'Cliente' : 'Tienda' }}
              </span>
            </p>
            <p class="break-words text-[var(--text)]">{{ event.reason }}</p>
            <p class="break-words text-xs text-[var(--text-muted)]">Mensaje al cliente: {{ event.message }}</p>
            <p v-if="event.evidence" class="break-words text-xs text-[var(--text-muted)]">
              Justificante: {{ event.evidence }}
            </p>
            <p v-if="event.cost" class="break-words text-xs text-[var(--text-muted)]">
              Coste para la tienda:
              <span class="whitespace-nowrap tabular-nums">{{ adminMoney(event.cost.amountCents) }}</span> ·
              {{ costLabels[event.cost.category] }} · {{ event.cost.evidenceRef }}
            </p>
          </li>
        </ol>
      </AdminCard>
    </div>
    <div
      v-if="intent && authorized()"
      data-testid="return-intent"
      class="rounded-[var(--radius-surface)] border border-[var(--border)] bg-[var(--surface-sunken)] p-4"
    >
      <p class="adm-help">Revisa antes de confirmar</p>
      <p class="mt-0.5 font-semibold text-[var(--text-strong)]">
        {{ actionLabels[intent.body.action] }}
        <span class="whitespace-nowrap font-normal tabular-nums text-[var(--text-muted)]">
          · {{ intent.publicRef }}
        </span>
      </p>
      <p class="mt-2 break-words">
        <span class="text-[var(--text-muted)]">Mensaje para el cliente:</span> {{ intent.body.publicMessage }}
      </p>
      <UAlert
        v-if="ambiguous"
        class="mt-3"
        color="warning"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        title="Falta confirmar el resultado"
        description="Puede que el paso ya esté guardado. «Comprobar de nuevo» recupera este mismo paso, sin registrarlo dos veces."
      />
      <div class="mt-4 flex flex-wrap justify-end gap-2">
        <AdminButton v-if="!ambiguous" data-testid="return-cancel" :disabled="busy" @click="cancel">
          Cancelar
        </AdminButton>
        <AdminButton
          variant="primary"
          data-testid="return-confirm"
          :loading="busy"
          :disabled="!authorized()"
          @click="dispatch(ambiguous)"
        >
          {{ ambiguous ? 'Comprobar de nuevo' : 'Confirmar' }}
        </AdminButton>
      </div>
    </div>
    <p v-if="!view && !intent && !message" role="status" class="sr-only">
      Todavía no hay datos de esta devolución para mostrar.
    </p>
  </section>
</template>
