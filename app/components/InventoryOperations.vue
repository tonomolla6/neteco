<script setup lang="ts">
import {
  adminInventoryVariantSchema,
  inventoryReceiptInputSchema,
  inventoryCountProposalInputSchema,
  inventoryCountApprovalInputSchema,
  inventoryCommandReceiptSchema,
  type AdminInventoryVariant,
  type InventoryCommandAction,
  type InventoryCommandReceipt,
  type InventoryReceiptInput,
  type InventoryCountProposalInput,
  type InventoryCountApprovalInput
} from '~~/shared/inventory-commands'
import { catalogPolicyOwnJson, catalogPolicyUuidSchema } from '~~/shared/catalog-publication-policy'

const props = defineProps<{
  snapshot: unknown
  operatorId: string
  runtime: unknown
  authorize: () => boolean
  reload: () => Promise<unknown>
  scopeKey?: string
}>()
const emit = defineEmits<{ confirmed: [receipt: InventoryCommandReceipt]; pending: [value: boolean] }>()
const quantity = ref(''),
  counted = ref(''),
  reason = ref(''),
  reference = ref(''),
  approvalReason = ref(''),
  selectedCount = ref('')
const busy = ref(false),
  message = ref(''),
  ambiguous = ref(false),
  confirmed = ref<InventoryCommandReceipt | null>(null)
type CommandPayload =
  | { action: 'receipt'; body: Readonly<InventoryReceiptInput> }
  | { action: 'count_propose'; body: Readonly<InventoryCountProposalInput> }
  | { action: 'count_approve'; body: Readonly<InventoryCountApprovalInput> }
type Intent = CommandPayload & {
  path: string
  key: string
  variantId: number
  variantUuid: string
  operatorId: string
  version: number
  warehouseId: string
  physicalQuantity: number
  physicalDelta: number
}
const intent = shallowRef<Intent | null>(null)
let active = true,
  generation = 0
const contextCurrent = ref(true)
onBeforeUnmount(() => {
  purge()
  active = false
  generation++
})
function purge() {
  generation++
  intent.value = null
  quantity.value = counted.value = reason.value = reference.value = approvalReason.value = selectedCount.value = ''
  confirmed.value = null
  message.value = ''
  ambiguous.value = false
  busy.value = false
  contextCurrent.value = false
}
watch(() => [props.scopeKey, props.operatorId, props.runtime], purge, { flush: 'sync' })
watch(
  intent,
  (value) => {
    if (active) emit('pending', value !== null)
  },
  { flush: 'sync' }
)
function currentSnapshot(): AdminInventoryVariant | null {
  if (!contextCurrent.value) return null
  const parsed = adminInventoryVariantSchema.safeParse(props.snapshot)
  return parsed.success ? parsed.data : null
}
const view = computed(currentSnapshot)
function authorized() {
  return (
    active &&
    props.runtime === 'cloudflare' &&
    props.authorize() === true &&
    catalogPolicyUuidSchema.safeParse(props.operatorId).success
  )
}
function integer(value: string) {
  if (!/^(0|[1-9][0-9]*)$/.test(value) || String(Number(value)) !== value || !Number.isSafeInteger(Number(value)))
    return undefined
  return Number(value)
}
function prepare(action: InventoryCommandAction) {
  message.value = ''
  confirmed.value = null
  if (busy.value || intent.value || !authorized()) return
  const data = currentSnapshot()
  if (!data) return
  const root = `/api/admin/inventory/variants/${data.variant.id}`
  let command: CommandPayload, path: string
  if (action === 'receipt') {
    if (!data.capabilities.inventoryReceipt) return
    const parsed = inventoryReceiptInputSchema.safeParse({
      expectedBalanceVersion: data.balance.version,
      quantity: integer(quantity.value),
      reason: reason.value,
      reference: reference.value
    })
    if (!parsed.success) {
      message.value = 'Indica una cantidad entera positiva, un motivo de 10–500 caracteres y una referencia de 3–200.'
      return
    }
    command = { action, body: Object.freeze(parsed.data) }
    path = `${root}/receipts`
  } else if (action === 'count_propose') {
    if (!data.capabilities.inventoryCountPropose) return
    const parsed = inventoryCountProposalInputSchema.safeParse({
      expectedBalanceVersion: data.balance.version,
      countedPhysicalQuantity: integer(counted.value),
      reason: reason.value,
      reference: reference.value
    })
    if (!parsed.success) {
      message.value = 'El recuento debe ser entero y no negativo, con motivo y referencia.'
      return
    }
    if (parsed.data.countedPhysicalQuantity === data.balance.physicalQuantity) {
      message.value = 'El recuento coincide: no se genera un ajuste ni un movimiento cero.'
      return
    }
    if (
      parsed.data.countedPhysicalQuantity < data.balance.physicalQuantity &&
      parsed.data.countedPhysicalQuantity - data.balance.blockedQuantity < data.balance.reservedQuantity
    ) {
      message.value = 'El recuento no puede consumir unidades bloqueadas o comprometidas por reservas.'
      return
    }
    command = { action, body: Object.freeze(parsed.data) }
    path = `${root}/counts`
  } else {
    if (!data.capabilities.inventoryCountApprove) return
    const proposal = data.counts.items.find((entry) => entry.id === selectedCount.value)
    if (!proposal || !proposal.canApprove || proposal.proposedBy === props.operatorId) return
    const parsed = inventoryCountApprovalInputSchema.safeParse({
      expectedBalanceVersion: data.balance.version,
      reason: approvalReason.value
    })
    if (!parsed.success) {
      message.value = 'La aprobación independiente necesita un motivo de 10–500 caracteres.'
      return
    }
    command = { action, body: Object.freeze(parsed.data) }
    path = `${root}/counts/${proposal.id}/approve`
  }
  const proposal = data.counts.items.find((entry) => entry.id === selectedCount.value)
  const delta =
    command.action === 'receipt'
      ? command.body.quantity
      : command.action === 'count_propose'
        ? 0
        : proposal!.physicalDelta
  intent.value = Object.freeze({
    ...command,
    path,
    key: crypto.randomUUID(),
    variantId: data.variant.id,
    variantUuid: data.variant.uuid,
    operatorId: props.operatorId,
    version: data.balance.version,
    warehouseId: data.warehouse.id,
    physicalQuantity:
      command.action === 'count_approve' ? proposal!.countedPhysicalQuantity : data.balance.physicalQuantity + delta,
    physicalDelta: delta
  })
}
function ownData(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined
}
function domainCode(raw: unknown) {
  try {
    const data = catalogPolicyOwnJson(raw)
    if (
      data &&
      typeof data === 'object' &&
      'error' in data &&
      data.error &&
      typeof data.error === 'object' &&
      'code' in data.error &&
      typeof data.error.code === 'string'
    )
      return data.error.code
  } catch {
    /* Unknown responses stay ambiguous; never invent success. */
  }
  return null
}
function responseFailure(context: unknown): string | null {
  const response = ownData(context, 'response'),
    ownStatus = ownData(response, 'status')
  let status: unknown = ownStatus
  // A real FetchResponse inherits the platform's status accessor. Call only
  // that native accessor, never a provider/mock's status or FetchError.data getter.
  if (status === undefined && response instanceof Response) {
    try {
      status = Object.getOwnPropertyDescriptor(Response.prototype, 'status')?.get?.call(response)
    } catch {
      return null
    }
  }
  return typeof status === 'number' && status >= 400 && status < 500 ? domainCode(ownData(response, '_data')) : null
}
const definitive = new Set([
  'invalid_input',
  'unauthenticated',
  'email_unverified',
  'mfa_required',
  'forbidden',
  'not_found',
  'version_conflict',
  'idempotency_conflict',
  'warehouse_unavailable',
  'reconciliation_required',
  'insufficient_stock',
  'approval_self',
  'proposal_unavailable',
  'no_change',
  'csrf_rejected',
  'invalid_idempotency_key',
  'rate_limited'
])
async function dispatch(replay = false) {
  const pending = intent.value
  if (!pending || busy.value || !authorized() || pending.operatorId !== props.operatorId) return
  busy.value = true
  message.value = ''
  const epoch = generation
  const current = () => active && generation === epoch && authorized() && props.operatorId === pending.operatorId
  let sent = false
  let responseCode: string | null = null
  try {
    const raw = await props.reload()
    if (!current()) return
    const fresh = adminInventoryVariantSchema.safeParse(raw)
    if (
      !fresh.success ||
      !authorized() ||
      props.operatorId !== pending.operatorId ||
      fresh.data.variant.id !== pending.variantId ||
      fresh.data.variant.uuid !== pending.variantUuid
    )
      throw new Error('inventory_authority_unconfirmed')
    const data = fresh.data,
      cap =
        pending.action === 'receipt'
          ? 'inventoryReceipt'
          : pending.action === 'count_propose'
            ? 'inventoryCountPropose'
            : 'inventoryCountApprove'
    if (data.capabilities[cap] !== true) throw new Error('inventory_authority_unconfirmed')
    contextCurrent.value = true
    // Historical same-key retries do not reinterpret an advanced balance or an
    // already approved count as a new operation. Live actor/identity still apply.
    if (!replay && data.balance.version !== pending.version) {
      intent.value = null
      message.value = 'Las existencias han cambiado. Revisa los datos actuales y prepara otra operación.'
      return
    }
    if (!replay && pending.action === 'count_approve') {
      const id = pending.path.split('/').at(-2),
        proposal = data.counts.items.find((entry) => entry.id === id)
      if (!proposal?.canApprove || proposal.proposedBy === props.operatorId) {
        intent.value = null
        message.value = 'La propuesta ya no admite esta aprobación.'
        return
      }
    }
    sent = true
    // Preserve uncertainty even if current authority/generation changes while
    // the POST is awaiting its response. A later manual retry keeps this key.
    ambiguous.value = true
    const response: unknown = await $fetch(pending.path, {
      method: 'POST',
      headers: { 'Idempotency-Key': pending.key },
      body: pending.body,
      retry: 0,
      onResponseError(context: unknown) {
        responseCode = responseFailure(context)
      }
    })
    if (!current()) return
    const receipt = inventoryCommandReceiptSchema.safeParse(catalogPolicyOwnJson(response))
    if (
      !receipt.success ||
      receipt.data.action !== pending.action ||
      receipt.data.variantId !== pending.variantId ||
      receipt.data.variantUuid !== pending.variantUuid ||
      receipt.data.warehouseId !== pending.warehouseId ||
      receipt.data.physicalQuantity !== pending.physicalQuantity ||
      receipt.data.physicalDelta !== pending.physicalDelta ||
      receipt.data.balanceVersion !== pending.version + (pending.action === 'count_propose' ? 0 : 1) ||
      (pending.action === 'count_approve' && receipt.data.proposalId !== pending.path.split('/').at(-2))
    )
      throw new Error('inventory_receipt_unconfirmed')
    if (
      pending.action === 'receipt' &&
      receipt.data.physicalDelta !== inventoryReceiptInputSchema.parse(pending.body).quantity
    )
      throw new Error('inventory_receipt_unconfirmed')
    if (
      pending.action === 'count_propose' &&
      receipt.data.physicalQuantity + receipt.data.proposedPhysicalDelta! !==
        inventoryCountProposalInputSchema.parse(pending.body).countedPhysicalQuantity
    )
      throw new Error('inventory_receipt_unconfirmed')
    if (!authorized() || props.operatorId !== pending.operatorId) throw new Error('inventory_authority_unconfirmed')
    confirmed.value = receipt.data
    intent.value = null
    ambiguous.value = false
    quantity.value = ''
    counted.value = ''
    reason.value = ''
    reference.value = ''
    approvalReason.value = ''
    message.value =
      pending.action === 'count_propose'
        ? 'Propuesta guardada. No se ha cambiado el stock.'
        : 'Movimiento confirmado y auditado.'
    emit('confirmed', receipt.data)
    contextCurrent.value = false
    try {
      const refreshed = await props.reload()
      if (!current()) return
      const latest = adminInventoryVariantSchema.safeParse(refreshed)
      if (
        !latest.success ||
        latest.data.variant.id !== pending.variantId ||
        latest.data.variant.uuid !== pending.variantUuid ||
        latest.data.balance.version < receipt.data.balanceVersion
      )
        throw new Error('inventory_current_context_unconfirmed')
      contextCurrent.value = true
    } catch {
      if (!current()) return
      message.value += ' No se ha podido refrescar la consulta; no tomes el recibo histórico como saldo actual.'
    }
  } catch (failure) {
    if (!current()) return
    contextCurrent.value = false
    const code = responseCode ?? domainCode(ownData(failure, 'data'))
    const afterSendAuthorization =
      code && ['unauthenticated', 'email_unverified', 'mfa_required', 'forbidden'].includes(code) && (sent || replay)
    // A rejection of a replay does not disprove the first uncertain commit:
    // quotas/current-state guards may run before the durable receipt lookup.
    if (!replay && code && definitive.has(code) && !afterSendAuthorization) {
      intent.value = null
      ambiguous.value = false
      message.value =
        code === 'reconciliation_required'
          ? 'La conciliación no es consistente. Operación bloqueada; no se corrige con una entrada.'
          : ['unauthenticated', 'email_unverified', 'mfa_required', 'forbidden'].includes(code)
            ? 'El acceso actual no autoriza la operación.'
            : 'La operación se ha rechazado. Refresca y revisa cantidades, reservas y versión.'
    } else {
      ambiguous.value = sent || replay
      message.value = afterSendAuthorization
        ? 'El acceso actual no autoriza confirmar el recibo. El envío pudo haberse guardado: conserva el mismo intento y recupera autorización antes de reintentarlo.'
        : ambiguous.value
          ? 'No hay confirmación. Puede haberse guardado: conserva este intento y reintenta únicamente el mismo comando.'
          : 'No se ha podido confirmar la autoridad actual. Este intento no se ha enviado; refresca el acceso antes de confirmarlo.'
    }
  } finally {
    if (active) busy.value = false
  }
}
function cancel() {
  if (!busy.value && !ambiguous.value) intent.value = null
}
watch(
  () => [props.operatorId, props.runtime, props.authorize()],
  () => {
    generation++
    contextCurrent.value = false
    message.value = 'Ha cambiado la identidad. No se enviará el intento de otro operador.'
  }
)
watch(
  () => props.snapshot,
  () => {
    if (authorized() && adminInventoryVariantSchema.safeParse(props.snapshot).success) contextCurrent.value = true
  }
)
</script>

<template>
  <section v-if="authorized()" aria-label="Operaciones de inventario" class="space-y-6">
    <div v-if="view" class="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
      <p class="text-xs font-semibold uppercase tracking-wider text-neteco-700">
        Único almacén · {{ view.warehouse.code }}
      </p>
      <h2 id="inventory-context-title" class="mt-1 text-xl font-bold text-slate-950">
        {{ view.variant.sku }} · {{ view.variant.format }}
      </h2>
      <p class="mt-1 text-sm text-slate-600">
        {{ view.warehouse.name }} · Variante {{ view.variant.id }} · Unidad base: {{ view.variant.unitLabel }} ({{
          view.variant.unitBase
        }})
      </p>
      <dl class="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-5">
        <div>
          <dt class="text-sm text-slate-500">Físico</dt>
          <dd class="text-2xl font-bold tabular-nums">{{ view.balance.physicalQuantity }}</dd>
        </div>
        <div>
          <dt class="text-sm text-slate-500">Bloqueado</dt>
          <dd class="text-2xl font-bold tabular-nums">{{ view.balance.blockedQuantity }}</dd>
        </div>
        <div>
          <dt class="text-sm text-slate-500">Reservado</dt>
          <dd class="text-2xl font-bold tabular-nums">{{ view.balance.reservedQuantity }}</dd>
        </div>
        <div>
          <dt class="text-sm text-slate-500">Seguridad</dt>
          <dd class="text-2xl font-bold tabular-nums">{{ view.balance.safetyStock }}</dd>
        </div>
        <div>
          <dt class="text-sm text-slate-500">Vendible</dt>
          <dd class="text-2xl font-bold tabular-nums text-neteco-800">{{ view.balance.sellableQuantity }}</dd>
        </div>
      </dl>
      <p v-if="view.balance.sellableQuantity === 0" role="status" class="mt-2 text-sm font-medium text-amber-800">
        No hay unidades vendibles ahora.
      </p>
      <p
        v-if="view.balance.safetyStock > 0 && view.balance.physicalQuantity <= view.balance.safetyStock"
        role="status"
        class="mt-2 text-sm font-medium text-amber-800"
      >
        El físico es igual o inferior al stock de seguridad registrado.
      </p>
      <p class="mt-4 text-sm text-slate-600">
        Saldo v{{ view.balance.version }} · Conciliación confirmada con
        {{ view.reconciliation.movementCount }} movimientos.
      </p>
      <p v-if="view.reconciliation.reservationExpiryPending" class="mt-2 text-sm font-medium text-amber-800">
        {{ view.reconciliation.reservationExpiryPending }} reservas vencidas pendientes de liberar. Sus unidades siguen
        protegidas.
      </p>
    </div>
    <p class="rounded-xl bg-slate-100 p-4 text-sm text-slate-700">
      Las cantidades son unidades base enteras de esta variante: no litros, kilos ni importe. No se modifican precios,
      reservas, stock de seguridad ni publicación. Todos los ajustes de recuento necesitan doble control,
      independientemente de su importe.
    </p>
    <p v-if="!view" class="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm">
      El saldo actual no está confirmado. No se preparan nuevas operaciones hasta una nueva consulta autorizada.
    </p>
    <div v-if="view && authorized() && view.capabilities.inventoryReceipt" class="grid gap-5 lg:grid-cols-2">
      <form class="space-y-4 rounded-2xl border border-slate-200 bg-white p-5" @submit.prevent="prepare('receipt')">
        <h3 class="text-lg font-semibold">Entrada física</h3>
        <p class="text-sm text-slate-600">
          Registra mercancía recibida. La entrada aumenta el físico, sin crear una aprobación de precio.
        </p>
        <label class="block text-sm font-medium"
          >Unidades recibidas<input
            v-model="quantity"
            data-testid="receipt-quantity"
            inputmode="numeric"
            class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
            :disabled="busy || !!intent"
        /></label>
        <label class="block text-sm font-medium"
          >Referencia de entrega<input
            v-model="reference"
            data-testid="inventory-reference"
            maxlength="200"
            class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
            :disabled="busy || !!intent"
        /></label>
        <label class="block text-sm font-medium"
          >Motivo<textarea
            v-model="reason"
            data-testid="inventory-reason"
            rows="3"
            maxlength="500"
            class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
            :disabled="busy || !!intent"
          />
        </label>
        <UButton type="submit" data-testid="prepare-receipt" :disabled="busy || !!intent">Revisar entrada</UButton>
      </form>
      <form
        class="space-y-4 rounded-2xl border border-slate-200 bg-white p-5"
        @submit.prevent="prepare('count_propose')"
      >
        <h3 class="text-lg font-semibold">Recuento físico</h3>
        <p class="text-sm text-slate-600">
          Cuenta lo que existe y guarda una propuesta. Otro operador deberá verificarla antes de mover existencias.
        </p>
        <label class="block text-sm font-medium"
          >Total contado<input
            v-model="counted"
            data-testid="count-quantity"
            inputmode="numeric"
            class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
            :disabled="busy || !!intent"
        /></label>
        <p class="text-sm text-slate-600">
          Usa el motivo y referencia del formulario de entrada para documentar este recuento. La vista previa no cambia
          stock.
        </p>
        <UButton type="submit" data-testid="prepare-count" :disabled="busy || !!intent">Revisar propuesta</UButton>
      </form>
    </div>
    <div
      v-if="intent"
      class="rounded-2xl border border-amber-300 bg-amber-50 p-5"
      role="region"
      aria-label="Confirmación de operación"
    >
      <h3 class="font-semibold">
        {{
          intent.action === 'receipt'
            ? 'Confirmar entrada'
            : intent.action === 'count_propose'
              ? 'Guardar propuesta sin mover stock'
              : 'Confirmar ajuste independiente'
        }}
      </h3>
      <p class="mt-2 text-sm">
        Variante {{ intent.variantId }} · versión esperada {{ intent.version }}. El servidor volverá a comprobar
        identidad, permisos, reservas y conciliación.
      </p>
      <p class="mt-2 break-words text-sm">{{ JSON.stringify(intent.body) }}</p>
      <div class="mt-4 flex flex-wrap gap-3">
        <UButton
          v-if="!ambiguous"
          data-testid="confirm-inventory"
          :loading="busy"
          :disabled="!authorized() || props.operatorId !== intent.operatorId"
          @click="dispatch()"
          >Confirmar</UButton
        >
        <UButton
          v-else
          data-testid="retry-inventory"
          :loading="busy"
          :disabled="!authorized() || props.operatorId !== intent.operatorId"
          @click="dispatch(true)"
          >Reintentar el mismo comando</UButton
        >
        <UButton v-if="!ambiguous" variant="outline" color="neutral" :disabled="busy" @click="cancel">Cancelar</UButton>
      </div>
    </div>
    <p v-if="message" role="status" class="rounded-xl border border-slate-200 p-4 text-sm">{{ message }}</p>
    <div v-if="view" class="space-y-4 rounded-2xl border border-slate-200 bg-white p-5">
      <h3 class="text-lg font-semibold">Propuestas de recuento</h3>
      <p v-if="!view.counts.items.length" class="text-sm text-slate-600">
        No hay propuestas en esta consulta confirmada.
      </p>
      <div v-for="proposal in view.counts.items" :key="proposal.id" class="rounded-xl border border-slate-200 p-4">
        <p class="font-medium">
          Contado: {{ proposal.countedPhysicalQuantity }} · ajuste propuesto: {{ proposal.physicalDelta > 0 ? '+' : ''
          }}{{ proposal.physicalDelta }}
        </p>
        <p class="mt-1 text-sm text-slate-600">
          {{ proposal.reference }} · {{ proposal.createdAt }} · v{{ proposal.expectedBalanceVersion }}
        </p>
        <p class="mt-2 break-words text-sm">{{ proposal.reason }}</p>
        <p class="mt-2 text-sm">
          {{
            proposal.approved
              ? 'Aprobada'
              : proposal.stale
                ? 'Desactualizada; requiere nuevo recuento'
                : proposal.proposedBy === props.operatorId
                  ? 'Tu propuesta: debe aprobar otro operador'
                  : 'Pendiente de comprobación independiente'
          }}
        </p>
        <UButton
          v-if="proposal.canApprove && authorized()"
          class="mt-3"
          variant="outline"
          data-testid="select-count"
          :disabled="busy || !!intent"
          @click="selectedCount = proposal.id"
          >Revisar aprobación</UButton
        >
      </div>
      <p v-if="view.counts.hasMore" class="text-sm text-slate-600">
        Se muestran las 50 propuestas más recientes; no es el historial completo.
      </p>
      <form
        v-if="selectedCount && authorized()"
        class="space-y-3 border-t border-slate-200 pt-4"
        @submit.prevent="prepare('count_approve')"
      >
        <label class="block text-sm font-medium"
          >Motivo de verificación independiente<textarea
            v-model="approvalReason"
            data-testid="approval-reason"
            rows="3"
            maxlength="500"
            class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
            :disabled="busy || !!intent"
          />
        </label>
        <UButton type="submit" data-testid="prepare-approval" :disabled="busy || !!intent">Revisar ajuste</UButton>
      </form>
    </div>
    <div v-if="view" class="rounded-2xl border border-slate-200 bg-white p-5">
      <h3 class="text-lg font-semibold">
        Movimientos · página {{ view.ledger.pagination.page }} de {{ view.ledger.pagination.pages || 1 }}
      </h3>
      <p v-if="!view.ledger.items.length" class="mt-3 text-sm text-slate-600">
        Esta página no contiene movimientos confirmados.
      </p>
      <ul class="mt-4 divide-y divide-slate-200">
        <li v-for="movement in view.ledger.items" :key="movement.id" class="py-3">
          <p class="font-medium">
            {{ movement.type }} · físico {{ movement.physicalDelta > 0 ? '+' : '' }}{{ movement.physicalDelta }} ·
            reserva {{ movement.reservedDelta > 0 ? '+' : '' }}{{ movement.reservedDelta }}
          </p>
          <p class="mt-1 text-sm text-slate-600">
            {{ movement.createdAt }} ·
            {{ movement.actorId ? 'Actor registrado en auditoría' : 'Movimiento histórico: actor no documentado' }}
          </p>
          <p v-if="movement.reference" class="mt-1 text-sm">{{ movement.reference }}</p>
          <p v-if="movement.reason" class="mt-1 break-words text-sm">{{ movement.reason }}</p>
        </li>
      </ul>
    </div>
  </section>
</template>
