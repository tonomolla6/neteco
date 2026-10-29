<script setup lang="ts">
import { fiscalUuid } from '~~/shared/fiscal-issuance'
import {
  parseFinancialSnapshot,
  actionAvailable,
  prepareFinancialIntent,
  FinancialCommandSession,
  FinancialHttpFailure,
  financialResponseErrorCode,
  financialAccessDenied,
  financialAmount,
  integerInput,
  type FinancialSnapshot,
  type FinancialAction,
  type FinancialReceipt
} from './financial-ui'

const props = defineProps<{
  orderId: string
  runtime: unknown
  audience: 'admin' | 'customer'
  operatorId: string
  snapshot: unknown
  credits?: unknown
  /** Current admin access; backed by the native private read, never a grant. */
  authorize: () => boolean
  /** MUST issue fresh native GET(s), not return a cached prop. */
  reload: () => Promise<unknown>
}>()
const emit = defineEmits<{ confirmed: [receipt: FinancialReceipt]; pending: [value: boolean]; invalidated: [] }>()
const { ready, loggedIn, user } = useUserSession()
const selected = ref<FinancialAction | ''>(''),
  targetId = ref(''),
  policyId = ref(''),
  returnRef = ref(''),
  returnVersion = ref(''),
  reason = ref(''),
  evidenceRef = ref(''),
  shipping = ref(false),
  shippingCents = ref(''),
  message = ref(''),
  contextCurrent = ref(true),
  denied = ref(false),
  revision = ref(0)
const lines = ref([{ lineIndex: '', quantity: '', amountCents: '' }])
const liveSnapshot = shallowRef<FinancialSnapshot | null>(null)
let active = true
const commands = new FinancialCommandSession(() => {
  if (active) revision.value++
})
const state = computed(() => {
  void revision.value
  return { intent: commands.intent, busy: commands.busy, ambiguous: commands.ambiguous }
})
function access() {
  try {
    return (
      active &&
      props.runtime === 'cloudflare' &&
      props.audience === 'admin' &&
      ready.value === true &&
      loggedIn.value === true &&
      fiscalUuid.safeParse(props.operatorId).success &&
      user.value?.id === props.operatorId &&
      user.value?.emailVerified === true &&
      user.value?.mfaVerified === true &&
      props.authorize() === true
    )
  } catch {
    return false
  }
}
const authorized = () => access() && !denied.value
const view = computed(() => {
  if (!authorized() || !contextCurrent.value) return null
  return liveSnapshot.value
})
const labels: Record<FinancialAction, string> = {
  plan: 'Preparar solicitud de reembolso',
  confirm: 'Autorizar solicitud preparada',
  cancel: 'Cancelar solicitud no enviada',
  queue_credit: 'Solicitar rectificativa enlazada',
  reconcile_refund: 'Conciliar resultado del reembolso',
  reconcile_credit: 'Conciliar resultado de la rectificativa'
}
const targets = computed(() =>
  !view.value
    ? []
    : selected.value === 'reconcile_credit'
      ? view.value.credits
          .filter((item) => item.capabilities.reconcile)
          .map((item) => ({
            id: item.id,
            text: `${item.code ?? 'Rectificativa pendiente'} · ${financialAmount(item.amountCents)}`
          }))
      : view.value.refunds.items
          .filter((item) => selected.value && actionAvailable(selected.value, view.value!, item.id))
          .map((item) => ({
            id: item.id,
            text: `${item.returnPublicRef} · ${financialAmount(item.amountCents)} · ${item.id.slice(0, 8)}`
          }))
)
const selectionAvailable = computed(
  () => !!view.value && !!selected.value && actionAvailable(selected.value, view.value, targetId.value || undefined)
)
function clearFields() {
  selected.value = ''
  targetId.value = ''
  policyId.value = ''
  returnRef.value = ''
  returnVersion.value = ''
  reason.value = ''
  evidenceRef.value = ''
  shipping.value = false
  shippingCents.value = ''
  lines.value = [{ lineIndex: '', quantity: '', amountCents: '' }]
}
watch(
  () => [
    props.orderId,
    props.operatorId,
    props.runtime,
    props.audience,
    ready.value,
    loggedIn.value,
    user.value?.id,
    user.value?.emailVerified,
    user.value?.mfaVerified,
    access()
  ],
  () => {
    denied.value = false
    commands.setOwner(
      access() && fiscalUuid.safeParse(props.orderId).success ? `${props.operatorId}:${props.orderId}` : null
    )
    clearFields()
    liveSnapshot.value = null
    message.value = ''
    contextCurrent.value = false
  },
  { immediate: true, flush: 'sync' }
)
watch(
  () => [props.snapshot, props.credits],
  () => {
    try {
      liveSnapshot.value = parseFinancialSnapshot(
        { refunds: props.snapshot, credits: props.credits ?? [] },
        props.orderId,
        'admin'
      )
      contextCurrent.value = authorized()
    } catch {
      liveSnapshot.value = null
      contextCurrent.value = false
    }
  },
  { immediate: true, flush: 'sync' }
)
watch(selected, () => {
  targetId.value = ''
})
watch(
  () => state.value.intent,
  (value) => emit('pending', value !== null),
  { flush: 'sync' }
)
onBeforeUnmount(() => {
  active = false
  commands.setOwner(null)
  liveSnapshot.value = null
  clearFields()
  emit('pending', false)
})
function prepare() {
  message.value = ''
  const data = view.value,
    action = selected.value
  if (!data || !action || !selectionAvailable.value || state.value.busy || state.value.intent) return
  try {
    const common = {
        idempotencyKey: crypto.randomUUID(),
        reason: reason.value.trim(),
        evidenceRef: evidenceRef.value.trim()
      },
      refund = data.refunds.items.find((item) => item.id === targetId.value),
      credit = data.credits.find((item) => item.id === targetId.value),
      body =
        action === 'plan'
          ? {
              ...common,
              policyId: policyId.value.trim(),
              returnPublicRef: returnRef.value.trim(),
              expectedReturnVersion: integerInput(returnVersion.value, 1, Number.MAX_SAFE_INTEGER - 1),
              lines: lines.value.map((line) => ({
                lineIndex: integerInput(line.lineIndex, 0, 99),
                quantity: integerInput(line.quantity, 1, 999),
                ...(line.amountCents ? { amountCents: integerInput(line.amountCents, 1, 1_000_000_000) } : {})
              })),
              ...(shipping.value ? { shippingCents: integerInput(shippingCents.value, 1, 1_000_000_000) } : {})
            }
          : action === 'queue_credit'
            ? { ...common, policyId: policyId.value.trim() }
            : {
                ...common,
                expectedGeneration: action === 'reconcile_credit' ? credit!.generation : refund!.generation,
                ...(action === 'confirm' ? { contractFingerprint: refund!.contractFingerprint } : {})
              }
    commands.prepare(
      prepareFinancialIntent(action, body, {
        operatorId: props.operatorId,
        orderId: props.orderId,
        snapshot: data,
        ...(action === 'plan' ? {} : { targetId: targetId.value })
      })
    )
  } catch {
    message.value =
      'Completa los campos exactos de la operación: UUID de política, expediente y versión RMA, líneas y cantidades enteras, motivo (10–500 caracteres) y referencia de evidencia.'
  }
}
async function dispatch() {
  if (!authorized() || !state.value.intent || state.value.busy) return
  message.value = ''
  contextCurrent.value = false
  const result = await commands.send({
    read: props.reload,
    authorized,
    async post(intent) {
      let code: string | null = null
      try {
        const endpoint: string = intent.endpoint
        return await $fetch<unknown>(endpoint, {
          method: 'POST',
          body: intent.body,
          retry: 0,
          onResponseError(context: unknown) {
            code = financialResponseErrorCode(context)
          }
        })
      } catch {
        if (financialAccessDenied(code)) {
          denied.value = true
          commands.setOwner(null)
          liveSnapshot.value = null
          clearFields()
          emit('invalidated')
        }
        throw new FinancialHttpFailure(code)
      }
    }
  })
  if (!active || !authorized() || result.kind === 'discarded') return
  if (result.kind === 'confirmed') {
    clearFields()
    liveSnapshot.value = result.latest
    contextCurrent.value = result.latest !== null
    message.value =
      result.receipt.action === 'confirmed'
        ? 'Solicitud autorizada y en cola. No confirma devolución bancaria ni emisión fiscal.'
        : result.receipt.action === 'planned'
          ? 'Solicitud preparada y auditada. Requiere autorización; todavía no se ha enviado al banco.'
          : result.receipt.action === 'queued'
            ? 'Rectificativa solicitada. Todavía no confirma una factura emitida.'
            : result.receipt.action === 'blocked'
              ? 'Conciliación registrada. El resultado del proveedor continúa pendiente; no confirma una devolución bancaria.'
              : result.receipt.action === 'cancelled'
                ? 'Solicitud cancelada antes del envío al proveedor.'
                : 'Conciliación administrativa confirmada. Consulta el estado financiero y fiscal actual.'
    if (result.receipt.validationOnly)
      message.value += ' Validación local sintética, sin movimiento bancario ni validez fiscal.'
    if (result.latest === null) message.value += ' El recibo es histórico: el estado actual no se ha podido confirmar.'
    emit('confirmed', result.receipt)
  } else if (result.kind === 'unknown')
    message.value =
      'Resultado no confirmado. Conservamos exactamente la misma clave y contenido. Recuperar comprueba el estado y relee el comando; no reenvía una devolución ni emite un documento.'
  else if (result.kind === 'not_sent')
    message.value = 'No se ha confirmado la lectura actual. No se ha enviado ningún comando.'
  else if (result.kind === 'stale')
    message.value =
      'El expediente ha cambiado. Actualiza el estado antes de preparar otro comando con su nueva versión.'
  else if (result.kind === 'rejected')
    message.value = 'Comando rechazado de forma confirmada. Actualiza el estado; no se reintentará automáticamente.'
}
function discard() {
  if (commands.discard()) message.value = 'Preparación no enviada descartada.'
}
</script>

<template>
  <section aria-label="Comandos financieros administrativos" class="space-y-4 border-t border-slate-200 pt-5">
    <h3 class="font-semibold text-slate-900">Gestión financiera documentada</h3>
    <p v-if="!authorized()" role="status" data-testid="refund-admin-access" class="text-sm text-slate-600">
      Requiere acceso administrativo actual, correo verificado y MFA. Clientes e invitados no pueden ejecutar estos
      comandos.
    </p>
    <template v-else>
      <p class="rounded-lg bg-slate-50 p-3 text-sm text-slate-600">
        Preparar, autorizar o solicitar una rectificativa no ejecuta el proveedor. La política aprobada, la captura
        histórica y la custodia se comprueban en el servidor. Nunca se modifica la factura original ni se repone
        inventario.
      </p>
      <p
        v-if="message"
        role="status"
        data-testid="refund-admin-message"
        class="rounded-lg border border-slate-200 p-3 text-sm"
      >
        {{ message }}
      </p>
      <p
        v-if="!view && !state.intent"
        role="status"
        data-testid="refund-admin-read-error"
        class="text-sm text-amber-900"
      >
        Comandos deshabilitados: confirma una lectura privada actual del pedido.
      </p>
      <form v-if="view && !state.intent" data-testid="refund-admin-form" class="space-y-4" @submit.prevent="prepare">
        <fieldset :disabled="state.busy" class="space-y-4">
          <legend class="sr-only">Preparar comando financiero</legend>
          <label class="block text-sm font-medium"
            >Operación
            <select
              v-model="selected"
              data-testid="refund-admin-action"
              class="mt-1 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 py-2"
            >
              <option value="">Selecciona una operación</option>
              <option
                v-for="(label, action) in labels"
                :key="action"
                :value="action"
                :disabled="action === 'plan' && !actionAvailable('plan', view)"
              >
                {{ label }}
              </option>
            </select>
          </label>
          <label v-if="selected && selected !== 'plan'" class="block text-sm font-medium"
            >Solicitud o rectificativa de esta lectura
            <select
              v-model="targetId"
              data-testid="refund-admin-target"
              class="mt-1 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 py-2"
            >
              <option value="">Selecciona un expediente disponible</option>
              <option v-for="target in targets" :key="target.id" :value="target.id">{{ target.text }}</option>
            </select>
          </label>
          <template v-if="selected === 'plan' || selected === 'queue_credit'">
            <label class="block text-sm font-medium"
              >UUID de política aprobada ({{ selected === 'plan' ? 'reembolso' : 'rectificativa' }})
              <input
                v-model="policyId"
                data-testid="refund-admin-policy"
                type="text"
                autocomplete="off"
                spellcheck="false"
                placeholder="00000000-0000-0000-0000-000000000000"
                class="mt-1 min-h-11 w-full rounded-lg border border-slate-300 px-3 py-2"
                required
              />
            </label>
          </template>
          <fieldset v-if="selected === 'plan'" class="space-y-4 rounded-lg border border-slate-200 p-4">
            <legend class="px-1 text-sm font-semibold">Datos explícitos del RMA y sus unidades históricas</legend>
            <div class="grid gap-3 sm:grid-cols-2">
              <label class="text-sm font-medium"
                >Referencia pública RMA<input
                  v-model="returnRef"
                  data-testid="refund-admin-rma"
                  type="text"
                  autocomplete="off"
                  spellcheck="false"
                  placeholder="RMA-…"
                  class="mt-1 min-h-11 w-full rounded-lg border border-slate-300 px-3 py-2"
                  required
              /></label>
              <label class="text-sm font-medium"
                >Versión actual del RMA<input
                  v-model="returnVersion"
                  data-testid="refund-admin-rma-version"
                  type="text"
                  inputmode="numeric"
                  autocomplete="off"
                  class="mt-1 min-h-11 w-full rounded-lg border border-slate-300 px-3 py-2"
                  required
              /></label>
            </div>
            <p class="text-xs text-slate-500">
              Copia la versión de una lectura actual del expediente. El servidor verifica que esté preparado para
              resolución. No se deduce de una versión del reembolso.
            </p>
            <div
              v-for="(line, index) in lines"
              :key="index"
              class="grid gap-3 rounded-lg bg-slate-50 p-3 sm:grid-cols-3"
            >
              <label class="text-sm"
                >Índice histórico de línea (0–99)<input
                  v-model="line.lineIndex"
                  :data-testid="`refund-line-index-${index}`"
                  type="text"
                  inputmode="numeric"
                  autocomplete="off"
                  class="mt-1 min-h-11 w-full rounded-lg border border-slate-300 px-3 py-2"
                  required
              /></label>
              <label class="text-sm"
                >Cantidad (1–999)<input
                  v-model="line.quantity"
                  :data-testid="`refund-line-quantity-${index}`"
                  type="text"
                  inputmode="numeric"
                  autocomplete="off"
                  class="mt-1 min-h-11 w-full rounded-lg border border-slate-300 px-3 py-2"
                  required
              /></label>
              <label class="text-sm"
                >Compensación menor, opcional (céntimos EUR)<input
                  v-model="line.amountCents"
                  :data-testid="`refund-line-amount-${index}`"
                  type="text"
                  inputmode="numeric"
                  autocomplete="off"
                  class="mt-1 min-h-11 w-full rounded-lg border border-slate-300 px-3 py-2"
              /></label>
              <button
                v-if="lines.length > 1"
                type="button"
                class="min-h-11 text-left text-sm underline"
                :aria-label="`Quitar línea ${index + 1}`"
                @click="lines.splice(index, 1)"
              >
                Quitar línea
              </button>
            </div>
            <button
              type="button"
              :disabled="lines.length >= 100"
              data-testid="refund-add-line"
              class="min-h-11 rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:opacity-50"
              @click="lines.push({ lineIndex: '', quantity: '', amountCents: '' })"
            >
              Añadir línea
            </button>
            <p class="text-xs text-slate-500">
              Sin importe manual se usa el valor histórico exacto de las unidades. Una compensación menor consume esas
              unidades; esta pantalla no permite completarla después sobre las mismas unidades.
            </p>
            <label class="flex items-center gap-2 text-sm"
              ><input
                v-model="shipping"
                data-testid="refund-shipping-opt-in"
                type="checkbox"
                class="h-4 w-4"
              />Solicitar portes según política explícita aprobada</label
            >
            <label v-if="shipping" class="block text-sm"
              >Importe de portes (céntimos EUR)<input
                v-model="shippingCents"
                data-testid="refund-shipping-cents"
                type="text"
                inputmode="numeric"
                autocomplete="off"
                class="mt-1 min-h-11 w-full rounded-lg border border-slate-300 px-3 py-2"
                required
            /></label>
          </fieldset>
          <label class="block text-sm font-medium"
            >Motivo interno (10–500 caracteres)<textarea
              v-model="reason"
              data-testid="refund-admin-reason"
              minlength="10"
              maxlength="500"
              autocomplete="off"
              rows="3"
              class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
              required
            />
          </label>
          <label class="block text-sm font-medium"
            >Referencia de evidencia documentada<input
              v-model="evidenceRef"
              data-testid="refund-admin-evidence"
              type="text"
              maxlength="200"
              autocomplete="off"
              class="mt-1 min-h-11 w-full rounded-lg border border-slate-300 px-3 py-2"
              required
          /></label>
          <button
            type="submit"
            data-testid="refund-admin-prepare"
            :disabled="!selectionAvailable"
            class="min-h-11 w-full rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50 sm:w-auto"
          >
            Revisar comando antes de enviarlo
          </button>
        </fieldset>
      </form>
      <div
        v-if="state.intent"
        data-testid="refund-admin-intent"
        class="space-y-3 rounded-lg border border-slate-300 p-4"
      >
        <p class="font-semibold">{{ labels[state.intent.action] }}</p>
        <p class="text-sm">
          Clave y contenido congelados. La siguiente comprobación relee el estado actual antes de enviar el comando
          administrativo.
        </p>
        <p class="break-all text-xs text-slate-500">Referencia del intento: {{ state.intent.body.idempotencyKey }}</p>
        <p v-if="state.ambiguous" role="alert" class="text-sm text-amber-900">
          No prepares otra operación ni cierres esta pantalla sin resolver el resultado. Recuperar no ejecuta el banco
          ni el proveedor fiscal.
        </p>
        <dl class="space-y-2 text-sm">
          <div v-if="state.intent.targetId">
            <dt class="text-slate-600">Expediente inmutable</dt>
            <dd class="break-all">{{ state.intent.targetId }}</dd>
          </div>
          <div v-if="state.intent.amountCents !== null">
            <dt class="text-slate-600">Importe histórico del expediente</dt>
            <dd class="tabular-nums">{{ financialAmount(state.intent.amountCents) }}</dd>
          </div>
          <div v-if="'policyId' in state.intent.body">
            <dt class="text-slate-600">Política explícita</dt>
            <dd class="break-all">{{ state.intent.body.policyId }}</dd>
          </div>
          <div v-if="'returnPublicRef' in state.intent.body">
            <dt class="text-slate-600">RMA y versión declarada</dt>
            <dd>{{ state.intent.body.returnPublicRef }} · {{ state.intent.body.expectedReturnVersion }}</dd>
          </div>
          <div v-if="state.intent.generation !== null">
            <dt class="text-slate-600">Generación comprobada</dt>
            <dd>{{ state.intent.generation }}</dd>
          </div>
          <div>
            <dt class="text-slate-600">Motivo congelado</dt>
            <dd class="break-words">{{ state.intent.body.reason }}</dd>
          </div>
          <div>
            <dt class="text-slate-600">Evidencia</dt>
            <dd class="break-all">{{ state.intent.body.evidenceRef }}</dd>
          </div>
        </dl>
        <ul v-if="'lines' in state.intent.body" class="space-y-2 text-sm">
          <li v-for="line in state.intent.body.lines" :key="line.lineIndex">
            Línea histórica {{ line.lineIndex }} · {{ line.quantity }} ud.<span v-if="line.amountCents !== undefined">
              · Compensación solicitada: {{ financialAmount(line.amountCents) }}</span
            >
          </li>
        </ul>
        <p v-if="'shippingCents' in state.intent.body && state.intent.body.shippingCents !== undefined" class="text-sm">
          Portes explícitos solicitados: {{ financialAmount(state.intent.body.shippingCents) }}
        </p>
        <p v-if="state.intent.action === 'plan'" class="text-xs text-slate-600">
          El servidor calculará y verificará el importe histórico exacto. Esta preparación no reserva ni devuelve
          dinero.
        </p>
        <div class="flex flex-wrap gap-3">
          <button
            type="button"
            data-testid="refund-admin-send"
            :disabled="state.busy"
            class="min-h-11 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            @click="dispatch"
          >
            {{
              state.busy ? 'Comprobando…' : state.ambiguous ? 'Recuperar mismo comando' : 'Comprobar y enviar comando'
            }}
          </button>
          <button
            v-if="!state.ambiguous"
            type="button"
            data-testid="refund-admin-discard"
            :disabled="state.busy"
            class="min-h-11 rounded-lg border border-slate-300 px-4 py-2 text-sm disabled:opacity-50"
            @click="discard"
          >
            Descartar preparación no enviada
          </button>
        </div>
      </div>
    </template>
  </section>
</template>
