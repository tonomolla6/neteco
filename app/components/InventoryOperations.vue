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
// ── Presentación ────────────────────────────────────────────────────────
const mode = ref<string>('receipt')
const modes = [
  { value: 'receipt', label: 'Entrada de mercancía' },
  { value: 'count', label: 'Recuento' }
]
const movementLabels: Record<string, string> = {
  initial: 'Existencias iniciales',
  receipt: 'Entrada de mercancía',
  adjustment: 'Ajuste por recuento',
  reserve: 'Reserva para un pedido',
  release: 'Reserva liberada',
  allocate: 'Asignación a un pedido',
  ship: 'Salida por envío',
  return: 'Devolución',
  damage: 'Baja por daños',
  transfer_in: 'Traslado recibido',
  transfer_out: 'Traslado enviado'
}
function signed(value: number) {
  return `${value > 0 ? '+' : ''}${value.toLocaleString('es-ES')}`
}
const figures = computed(() => {
  const balance = view.value?.balance
  if (!balance) return []
  return [
    { label: 'En almacén', value: balance.physicalQuantity },
    { label: 'Bloqueadas', value: balance.blockedQuantity },
    { label: 'Reservadas', value: balance.reservedQuantity },
    { label: 'Mínimo de seguridad', value: balance.safetyStock },
    { label: 'Disponibles para vender', value: balance.sellableQuantity }
  ]
})
const intentTitle = computed(() =>
  intent.value?.action === 'receipt'
    ? 'Confirmar la entrada'
    : intent.value?.action === 'count_propose'
      ? 'Guardar la propuesta de recuento'
      : 'Confirmar el ajuste'
)
const intentFacts = computed(() => {
  const pending = intent.value
  if (!pending) return []
  const facts: Array<{ label: string; value: string }> = []
  if (pending.action === 'receipt') {
    facts.push(
      { label: 'Unidades que entran', value: signed(pending.body.quantity) },
      { label: 'Quedarán en almacén', value: pending.physicalQuantity.toLocaleString('es-ES') },
      { label: 'Referencia de entrega', value: pending.body.reference }
    )
  } else if (pending.action === 'count_propose') {
    facts.push(
      { label: 'Total contado', value: pending.body.countedPhysicalQuantity.toLocaleString('es-ES') },
      { label: 'Ahora en almacén', value: pending.physicalQuantity.toLocaleString('es-ES') },
      { label: 'Referencia', value: pending.body.reference }
    )
  } else {
    facts.push(
      { label: 'Ajuste', value: `${signed(pending.physicalDelta)} unidades` },
      { label: 'Quedarán en almacén', value: pending.physicalQuantity.toLocaleString('es-ES') }
    )
  }
  facts.push({ label: 'Motivo', value: pending.body.reason })
  return facts
})
type CountProposal = AdminInventoryVariant['counts']['items'][number]
function proposalState(proposal: CountProposal): { label: string; tone: 'success' | 'warning' | 'neutral' | 'info' } {
  if (proposal.approved) return { label: 'Aprobada', tone: 'success' }
  if (proposal.stale) return { label: 'Desactualizada', tone: 'neutral' }
  if (proposal.proposedBy === props.operatorId) return { label: 'Tuya: la aprueba otra persona', tone: 'info' }
  return { label: 'Pendiente de comprobar', tone: 'warning' }
}
</script>

<template>
  <section v-if="authorized()" aria-label="Operaciones de inventario" class="adm-stack">
    <AdminCard
      v-if="view"
      title="Existencias"
      :description="`${view.warehouse.name} · se cuenta en ${view.variant.unitLabel}`"
    >
      <dl class="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-5">
        <div v-for="figure in figures" :key="figure.label" class="min-w-0">
          <dt class="adm-help">{{ figure.label }}</dt>
          <dd class="text-lg font-semibold tabular-nums text-[var(--text-strong)]">
            {{ figure.value.toLocaleString('es-ES') }}
          </dd>
        </div>
      </dl>
      <div class="mt-4 space-y-2">
        <UAlert
          v-if="view.balance.sellableQuantity === 0"
          role="status"
          color="warning"
          variant="subtle"
          icon="i-lucide-package-x"
          title="Ahora no hay unidades disponibles para vender"
        />
        <UAlert
          v-if="view.balance.safetyStock > 0 && view.balance.physicalQuantity <= view.balance.safetyStock"
          role="status"
          color="warning"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          title="Lo que hay en almacén ha llegado al mínimo de seguridad"
        />
        <UAlert
          v-if="view.reconciliation.reservationExpiryPending"
          role="status"
          color="warning"
          variant="subtle"
          icon="i-lucide-clock"
          :title="`${view.reconciliation.reservationExpiryPending} reservas caducadas pendientes de liberar`"
          description="Sus unidades siguen apartadas hasta que se liberen."
        />
        <p class="adm-help">
          Las cifras cuadran con los {{ view.reconciliation.movementCount.toLocaleString('es-ES') }} movimientos
          registrados.
        </p>
      </div>
    </AdminCard>
    <AdminCard v-else>
      <AdminEmptyState
        compact
        icon="i-lucide-package-search"
        title="No hemos podido confirmar las existencias actuales"
        description="Vuelve a consultar el producto para registrar entradas o recuentos."
      />
    </AdminCard>

    <AdminCard
      v-if="view && authorized() && view.capabilities.inventoryReceipt && !intent"
      title="Registrar un cambio"
      description="Las cantidades van en unidades enteras de este producto, no en litros, kilos ni euros."
    >
      <form class="adm-stack" @submit.prevent="prepare(mode === 'count' ? 'count_propose' : 'receipt')">
        <AdminFilters v-model="mode" :options="modes" label="Qué quieres registrar" />
        <p class="adm-help">
          {{
            mode === 'count'
              ? 'Cuenta lo que hay de verdad y guarda la propuesta. Las existencias no cambian hasta que otra persona del equipo la apruebe.'
              : 'Anota la mercancía que ha llegado. Se suma a lo que hay en almacén; no cambia precios ni reservas.'
          }}
        </p>
        <div class="adm-form-grid">
          <AdminFormField v-if="mode !== 'count'" v-slot="{ id }" label="Unidades recibidas" required>
            <input
              :id="id"
              v-model="quantity"
              data-testid="receipt-quantity"
              inputmode="numeric"
              class="adm-input"
              :disabled="busy || !!intent"
            />
          </AdminFormField>
          <AdminFormField
            v-else
            v-slot="{ id }"
            label="Total contado"
            help="El total que hay en almacén, no la diferencia."
            required
          >
            <input
              :id="id"
              v-model="counted"
              data-testid="count-quantity"
              inputmode="numeric"
              class="adm-input"
              :disabled="busy || !!intent"
            />
          </AdminFormField>
          <AdminFormField
            v-slot="{ id }"
            :label="mode === 'count' ? 'Referencia del recuento' : 'Referencia de entrega'"
            help="Por ejemplo, el número de albarán."
            required
          >
            <input
              :id="id"
              v-model="reference"
              data-testid="inventory-reference"
              maxlength="200"
              class="adm-input"
              :disabled="busy || !!intent"
            />
          </AdminFormField>
        </div>
        <AdminFormField v-slot="{ id }" label="Motivo" help="Entre 10 y 500 caracteres." required>
          <textarea
            :id="id"
            v-model="reason"
            data-testid="inventory-reason"
            rows="3"
            maxlength="500"
            class="adm-input"
            :disabled="busy || !!intent"
          />
        </AdminFormField>
        <div class="flex justify-end">
          <AdminButton
            v-if="mode !== 'count'"
            type="submit"
            variant="primary"
            data-testid="prepare-receipt"
            :disabled="busy || !!intent"
          >
            Revisar entrada
          </AdminButton>
          <AdminButton v-else type="submit" variant="primary" data-testid="prepare-count" :disabled="busy || !!intent">
            Revisar propuesta
          </AdminButton>
        </div>
      </form>
    </AdminCard>

    <AdminCard v-if="intent" :title="intentTitle" role="region" aria-label="Confirmación de operación">
      <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2">
        <template v-for="fact in intentFacts" :key="fact.label">
          <dt class="text-[var(--text-muted)]">{{ fact.label }}</dt>
          <dd class="break-words text-[var(--text-strong)]">{{ fact.value }}</dd>
        </template>
      </dl>
      <p class="adm-help mt-3">
        {{
          intent.action === 'count_propose'
            ? 'Guardar la propuesta no cambia las existencias.'
            : 'Al confirmar se vuelven a comprobar tus permisos y las existencias actuales.'
        }}
      </p>
      <template #footer>
        <div class="flex flex-wrap justify-end gap-2">
          <AdminButton v-if="!ambiguous" :disabled="busy" @click="cancel">Cancelar</AdminButton>
          <AdminButton
            v-if="!ambiguous"
            variant="primary"
            data-testid="confirm-inventory"
            :loading="busy"
            :disabled="!authorized() || props.operatorId !== intent.operatorId"
            @click="dispatch()"
          >
            Confirmar
          </AdminButton>
          <AdminButton
            v-else
            variant="primary"
            data-testid="retry-inventory"
            :loading="busy"
            :disabled="!authorized() || props.operatorId !== intent.operatorId"
            @click="dispatch(true)"
          >
            Reintentar la misma operación
          </AdminButton>
        </div>
      </template>
    </AdminCard>

    <UAlert v-if="message" role="status" color="info" variant="subtle" icon="i-lucide-info" :title="message" />

    <AdminCard v-if="view" title="Propuestas de recuento" :flush="view.counts.items.length > 0">
      <AdminEmptyState
        v-if="!view.counts.items.length"
        compact
        icon="i-lucide-clipboard-check"
        title="No hay propuestas de recuento"
        description="Cuando alguien guarde un recuento aparecerá aquí para que otra persona lo apruebe."
      />
      <ul v-else class="adm-list">
        <li v-for="proposal in view.counts.items" :key="proposal.id">
          <div class="min-w-0 flex-1">
            <p class="adm-list__title">
              <span class="whitespace-nowrap">
                Contado: {{ proposal.countedPhysicalQuantity.toLocaleString('es-ES') }}
              </span>
              <span class="whitespace-nowrap font-normal text-[var(--text-muted)]">
                Ajuste {{ signed(proposal.physicalDelta) }}
              </span>
              <AdminBadge :tone="proposalState(proposal).tone" class="whitespace-nowrap">
                {{ proposalState(proposal).label }}
              </AdminBadge>
            </p>
            <p class="adm-help">
              <span class="whitespace-nowrap">{{ adminDate(proposal.createdAt, true) }}</span> ·
              {{ proposal.reference }}
            </p>
            <p class="mt-1 break-words">{{ proposal.reason }}</p>
            <p v-if="proposal.stale && !proposal.approved" class="adm-help">
              Las existencias han cambiado desde entonces: hay que volver a contar.
            </p>
          </div>
          <AdminButton
            v-if="proposal.canApprove && authorized()"
            size="sm"
            data-testid="select-count"
            :disabled="busy || !!intent"
            @click="selectedCount = proposal.id"
          >
            {{ selectedCount === proposal.id ? 'Elegida' : 'Revisar y aprobar' }}
          </AdminButton>
        </li>
      </ul>
      <p v-if="view.counts.hasMore" class="adm-help px-5 py-3">Se muestran las 50 propuestas más recientes.</p>
      <form
        v-if="selectedCount && authorized() && !intent"
        class="adm-stack border-t border-[var(--border)] px-5 py-4"
        @submit.prevent="prepare('count_approve')"
      >
        <AdminFormField
          v-slot="{ id }"
          label="Motivo de la aprobación"
          help="Explica cómo lo has comprobado (entre 10 y 500 caracteres)."
          required
        >
          <textarea
            :id="id"
            v-model="approvalReason"
            data-testid="approval-reason"
            rows="3"
            maxlength="500"
            class="adm-input"
            :disabled="busy || !!intent"
          />
        </AdminFormField>
        <div class="flex justify-end gap-2">
          <AdminButton :disabled="busy" @click="selectedCount = ''">Cancelar</AdminButton>
          <AdminButton type="submit" variant="primary" data-testid="prepare-approval" :disabled="busy || !!intent">
            Revisar ajuste
          </AdminButton>
        </div>
      </form>
    </AdminCard>

    <AdminCard
      v-if="view"
      title="Movimientos"
      :description="`Página ${view.ledger.pagination.page} de ${view.ledger.pagination.pages || 1}`"
      :flush="view.ledger.items.length > 0"
    >
      <AdminEmptyState
        v-if="!view.ledger.items.length"
        compact
        icon="i-lucide-arrow-left-right"
        title="No hay movimientos en esta página"
      />
      <div v-else class="adm-table-wrap">
        <table class="adm-table">
          <thead>
            <tr>
              <th scope="col">Fecha</th>
              <th scope="col">Movimiento</th>
              <th scope="col" data-numeric>En almacén</th>
              <th scope="col" data-numeric>Reservadas</th>
              <th scope="col">Detalle</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="movement in view.ledger.items" :key="movement.id">
              <td class="whitespace-nowrap">{{ adminDate(movement.createdAt, true) }}</td>
              <td class="whitespace-nowrap">{{ movementLabels[movement.type] ?? adminHumanize(movement.type) }}</td>
              <td data-numeric class="whitespace-nowrap tabular-nums">
                {{ movement.physicalDelta ? signed(movement.physicalDelta) : '—' }}
              </td>
              <td data-numeric class="whitespace-nowrap tabular-nums">
                {{ movement.reservedDelta ? signed(movement.reservedDelta) : '—' }}
              </td>
              <td class="min-w-48">
                <p v-if="movement.reference">{{ movement.reference }}</p>
                <p v-if="movement.reason" class="adm-help break-words">{{ movement.reason }}</p>
                <p v-if="!movement.actorId" class="adm-help">Sin autor registrado</p>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </AdminCard>
  </section>
</template>
