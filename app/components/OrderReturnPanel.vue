<script setup lang="ts">
import {
  adminOrderReturnSchema,
  returnTransitionInputSchema,
  returnCommandReceiptSchema,
  returnStateLabels,
  returnResponseErrorCode,
  definiteReturnRejection,
  freezeReturnIntent,
  type ReturnAction,
  type ReturnTransitionInput,
  type ReturnCommandReceipt
} from '~~/shared/order-returns'
import { catalogPolicyUuidSchema } from '~~/shared/catalog-publication-policy'

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
  amountCents = ref(0),
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
  approved: 'Admitir tras revisión documentada',
  rejected: 'No admitir la solicitud',
  received: 'Registrar unidades recibidas',
  inspected: 'Registrar inspección física',
  resolution_ready: 'Preparar resolución sin efectos económicos'
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
    message.value = 'Ha cambiado el acceso. Confirma de nuevo tu sesión antes de continuar.'
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
  amountCents.value = 0
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
                  amountCents: amountCents.value,
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
      'Completa motivo interno, mensaje para el cliente y evidencia (10–500 caracteres), cantidades enteras y los datos de la acción.'
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
      message.value = 'El expediente ha cambiado. Consulta de nuevo su estado antes de preparar otra operación.'
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
    message.value =
      'Operación confirmada y auditada. Custodia no vendible; sin efectos sobre inventario, pago ni fiscalidad.'
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
        message.value += ' El recibo es histórico: no se ha podido confirmar el estado actual.'
      }
    }
  } catch {
    if (!current()) return
    contextCurrent.value = false
    if (!recovery && definiteReturnRejection(code, sent, recovery)) {
      intent.value = null
      ambiguous.value = false
      message.value =
        'La operación ha sido rechazada de forma confirmada. Actualiza el expediente antes de preparar otra.'
    } else {
      ambiguous.value = sent || recovery
      message.value = ambiguous.value
        ? 'Resultado no confirmado. Conservamos el mismo contenido y clave: recuperar no crea otra operación.'
        : 'No se ha podido confirmar el contexto. No se ha enviado ninguna operación.'
    }
  } finally {
    if (active) busy.value = false
  }
}
function cancel() {
  if (!busy.value && !ambiguous.value) {
    intent.value = null
    message.value = 'Intento no enviado cancelado.'
  }
}
</script>

<template>
  <section aria-label="Custodia e inspección del expediente RMA" class="space-y-4">
    <p v-if="message && authorized()" role="status" data-testid="return-message" class="rounded-lg border p-3 text-sm">
      {{ message }}
    </p>
    <div v-if="view" data-testid="return-facts" class="space-y-4">
      <h2 class="text-lg font-semibold">{{ view.publicRef }} · {{ returnStateLabels[view.state] }}</h2>
      <p class="text-sm">Almacén único: {{ view.warehouse.name }} · versión {{ view.version }} · {{ view.reason }}</p>
      <p class="rounded-lg bg-amber-50 p-3 text-sm">
        Revisión documentada, no admisión automática. Las unidades recibidas permanecen en custodia no vendible. Este
        panel no autoriza reembolsos, rectificativas, transportistas ni reposición de stock.
      </p>
      <p v-if="!view.readiness.ready" role="alert">Operación bloqueada: {{ view.readiness.blockers.join(', ') }}</p>
      <table class="w-full text-left text-sm">
        <caption class="sr-only">
          Cantidades históricas y custodia
        </caption>
        <thead>
          <tr>
            <th>Producto histórico</th>
            <th>Solicitadas / admitidas</th>
            <th>Recibidas / inspeccionadas</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="line in view.lines" :key="line.lineIndex">
            <td>{{ line.name }} · {{ line.sku }}</td>
            <td>{{ line.requestedQuantity }} / {{ line.authorizedQuantity }}</td>
            <td>{{ line.receivedQuantity }} / {{ line.inspectedQuantity }}</td>
          </tr>
        </tbody>
      </table>
      <form v-if="!intent && view.capabilities.returnsTransitions" class="space-y-3" @submit.prevent="prepare">
        <label class="block"
          >Acción
          <select v-model="selected" data-testid="return-action" required class="rounded border p-2">
            <option value="">Selecciona una acción</option>
            <option v-for="action in view.capabilities.allowedActions" :key="action" :value="action">
              {{ actionLabels[action] }}
            </option>
          </select></label
        >
        <label class="block"
          >Motivo interno
          <textarea
            v-model="reason"
            data-testid="return-reason"
            maxlength="500"
            required
            class="block w-full rounded border p-2"
          />
        </label>
        <label class="block"
          >Mensaje visible para el cliente
          <textarea
            v-model="publicMessage"
            data-testid="return-public-message"
            maxlength="500"
            required
            class="block w-full rounded border p-2"
          />
        </label>
        <label class="block"
          >Evidencia operativa / referencia documental
          <textarea
            v-model="evidence"
            data-testid="return-evidence"
            maxlength="500"
            required
            class="block w-full rounded border p-2"
          />
        </label>
        <label v-if="selected === 'approved'" class="block"
          >Referencia de la decisión de admisión
          <input v-model="decisionRef" data-testid="return-decision" maxlength="200" class="rounded border p-2"
        /></label>
        <fieldset v-if="['approved', 'received', 'inspected'].includes(selected)">
          <legend>Unidades de esta operación (0 omite recepción o inspección)</legend>
          <label v-for="line in view.lines" :key="line.lineIndex" class="flex justify-between gap-4"
            >{{ line.name
            }}<input
              v-model.number="quantities[line.lineIndex]"
              :data-testid="`return-quantity-${line.lineIndex}`"
              type="number"
              min="0"
              step="1"
              :max="
                selected === 'approved'
                  ? line.requestedQuantity
                  : selected === 'received'
                    ? line.authorizedQuantity - line.receivedQuantity
                    : line.receivedQuantity - line.inspectedQuantity
              "
              :aria-label="`Unidades de ${line.name}`"
              class="w-24 rounded border p-2"
          /></label>
        </fieldset>
        <fieldset v-if="selected === 'inspected'" class="space-y-2">
          <legend>Inspección de las unidades seleccionadas</legend>
          <label
            >Condición
            <select v-model="condition" data-testid="return-condition">
              <option value="unknown">Sin confirmar</option>
              <option value="sealed">Precintado</option>
              <option value="opened">Abierto</option>
              <option value="damaged">Dañado</option>
            </select></label
          ><label
            >Destino propuesto
            <select v-model="disposition" data-testid="return-disposition">
              <option value="quarantine">Cuarentena</option>
              <option value="non_restockable">No reponible</option>
              <option value="review_restock">Revisar reposición (no la ejecuta)</option>
            </select></label
          ><label class="block">Nota interna opcional <textarea v-model="note" maxlength="500" /></label>
        </fieldset>
        <fieldset v-if="selected === 'resolution_ready'" class="space-y-2">
          <legend>Preparación, no resolución económica</legend>
          <label class="block"
            >Propuesta documentada
            <textarea v-model="resolution" data-testid="return-resolution" maxlength="500" required /></label
          ><label
            ><input v-model="knownCost" data-testid="return-known-cost" type="checkbox" /> Coste operativo conocido (no
            un reembolso)</label
          >
          <div v-if="knownCost" class="space-y-2">
            <label
              >Importe en céntimos EUR
              <input
                v-model.number="amountCents"
                data-testid="return-cost-cents"
                type="number"
                min="0"
                step="1" /></label
            ><label
              >Clase
              <select v-model="costCategory">
                <option value="handling">Manipulación</option>
                <option value="return_shipping">Transporte de devolución</option>
                <option value="other">Otro</option>
              </select></label
            ><label class="block"
              >Referencia de coste
              <input v-model="costEvidence" data-testid="return-cost-evidence" maxlength="200" /></label
            ><label class="block"
              >Descripción <textarea v-model="costDescription" data-testid="return-cost-description" maxlength="500" />
            </label>
          </div>
          <p v-else>Coste no declarado; no se interpreta como coste cero.</p>
        </fieldset>
        <button type="submit" data-testid="return-prepare" :disabled="busy" class="rounded border px-4 py-2">
          Preparar para confirmar
        </button>
      </form>
      <ol aria-label="Auditoría interna" class="space-y-2">
        <li v-for="event in view.timeline.items" :key="event.commandId" class="rounded border p-2 text-sm">
          {{ returnStateLabels[event.action] }} · v{{ event.version }} · {{ event.reason }}
          <p v-if="event.evidence">Evidencia: {{ event.evidence }}</p>
          <p>Mensaje al cliente: {{ event.message }}</p>
          <p v-if="event.cost">
            Coste documentado: {{ event.cost.amountCents }} céntimos EUR · {{ event.cost.evidenceRef }}
          </p>
        </li>
      </ol>
    </div>
    <div v-if="intent && authorized()" data-testid="return-intent" class="rounded-lg border p-4">
      <p>
        {{ intent.publicRef }} · {{ actionLabels[intent.body.action] }} · versión de partida
        {{ intent.body.expectedVersion }}
      </p>
      <p>Mensaje al cliente: {{ intent.body.publicMessage }}</p>
      <p v-if="ambiguous">No cambies la clave ni el contenido: el resultado previo puede haberse confirmado.</p>
      <button
        data-testid="return-confirm"
        :disabled="busy || !authorized()"
        type="button"
        class="m-2 rounded border p-2"
        @click="dispatch(ambiguous)"
      >
        {{ ambiguous ? 'Recuperar con la misma clave' : 'Confirmar operación' }}</button
      ><button
        v-if="!ambiguous"
        data-testid="return-cancel"
        :disabled="busy"
        type="button"
        class="rounded border p-2"
        @click="cancel"
      >
        Cancelar intento no enviado
      </button>
    </div>
    <p v-if="!view && !intent && !message" role="status">No hay contexto RMA confirmado para mostrar.</p>
  </section>
</template>
