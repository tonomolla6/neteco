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
  refundLabel,
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
  shippingEuros = ref(''),
  message = ref(''),
  messageTone = ref<'neutral' | 'success' | 'warning' | 'error'>('neutral'),
  drawerOpen = ref(false),
  contextCurrent = ref(true),
  denied = ref(false),
  revision = ref(0)
const lines = ref([{ lineIndex: '', quantity: '', amountEuros: '' }])
const formId = useId()
/** El comerciante teclea euros; la API sigue recibiendo céntimos enteros. Un importe mal escrito no pasa la validación. */
function centsInput(euros: string): string {
  const cents = adminEurosToCents(euros)
  return cents === null ? 'importe no válido' : String(cents)
}
const liveSnapshot = shallowRef<FinancialSnapshot | null>(null)
let active = true
const commands = new FinancialCommandSession(() => {
  if (active) revision.value++
})
const state = computed(() => {
  void revision.value
  return { intent: commands.intent, busy: commands.busy, ambiguous: commands.ambiguous }
})
const intentTarget = computed(() => {
  const id = state.value.intent?.refundId
  return (id && liveSnapshot.value?.refunds.items.find((item) => item.id === id)) || null
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
  plan: 'Preparar un reembolso nuevo',
  confirm: 'Autorizar un reembolso preparado',
  cancel: 'Cancelar un reembolso que aún no se ha enviado',
  queue_credit: 'Pedir la factura rectificativa de un reembolso',
  reconcile_refund: 'Comprobar el resultado de un reembolso',
  reconcile_credit: 'Comprobar el resultado de una factura rectificativa'
}
const targets = computed(() =>
  !view.value
    ? []
    : selected.value === 'reconcile_credit'
      ? view.value.credits
          .filter((item) => item.capabilities.reconcile)
          .map((item) => ({
            id: item.id,
            text: `${item.code ?? 'Factura rectificativa pendiente'} · ${financialAmount(item.amountCents)}`
          }))
      : view.value.refunds.items
          .filter((item) => selected.value && actionAvailable(selected.value, view.value!, item.id))
          .map((item) => ({
            id: item.id,
            text: `${financialAmount(item.amountCents)} · ${refundLabel(item)} · devolución ${item.returnPublicRef}`
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
  shippingEuros.value = ''
  lines.value = [{ lineIndex: '', quantity: '', amountEuros: '' }]
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
                ...(line.amountEuros.trim()
                  ? { amountCents: integerInput(centsInput(line.amountEuros), 1, 1_000_000_000) }
                  : {})
              })),
              ...(shipping.value
                ? { shippingCents: integerInput(centsInput(shippingEuros.value), 1, 1_000_000_000) }
                : {})
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
    messageTone.value = 'error'
    message.value =
      'Revisa los datos: identificador de la política, referencia y versión de la devolución, líneas y unidades en números enteros, importes en euros, motivo (entre 10 y 500 caracteres) y justificante.'
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
  messageTone.value = result.kind === 'confirmed' ? 'success' : result.kind === 'rejected' ? 'error' : 'warning'
  if (result.kind === 'confirmed') {
    drawerOpen.value = false
    clearFields()
    liveSnapshot.value = result.latest
    contextCurrent.value = result.latest !== null
    message.value =
      result.receipt.action === 'confirmed'
        ? 'Reembolso autorizado y en cola. Todavía no confirma que el banco haya devuelto el dinero.'
        : result.receipt.action === 'planned'
          ? 'Reembolso preparado. Falta autorizarlo; todavía no se ha enviado al banco.'
          : result.receipt.action === 'queued'
            ? 'Factura rectificativa solicitada. Todavía no está emitida.'
            : result.receipt.action === 'blocked'
              ? 'Comprobación registrada. El banco aún no ha dado un resultado: el dinero no consta como devuelto.'
              : result.receipt.action === 'cancelled'
                ? 'Reembolso cancelado antes de enviarse al banco.'
                : 'Comprobación terminada. Revisa el estado actual del reembolso y de su factura rectificativa.'
    if (result.receipt.validationOnly)
      message.value += ' Es una operación de prueba: no hay movimiento en el banco ni validez fiscal.'
    if (result.latest === null) message.value += ' No hemos podido actualizar los datos del pedido: pulsa «Actualizar».'
    emit('confirmed', result.receipt)
  } else if (result.kind === 'unknown')
    message.value =
      'No sabemos si la operación se ha guardado. No prepares otra: pulsa «Comprobar de nuevo» para recuperar esta misma, sin duplicar el reembolso.'
  else if (result.kind === 'not_sent')
    message.value = 'No hemos podido cargar los datos actuales del pedido. No se ha enviado nada.'
  else if (result.kind === 'stale')
    message.value = 'El reembolso ha cambiado mientras lo preparabas. Actualiza los datos y vuelve a prepararlo.'
  else if (result.kind === 'rejected')
    message.value = 'La operación se ha rechazado. Actualiza los datos y revísala; no se reintentará sola.'
}
function discard() {
  if (commands.discard()) {
    messageTone.value = 'neutral'
    message.value = 'Operación descartada. No se ha enviado nada.'
  }
}
</script>

<template>
  <section aria-label="Gestión de reembolsos" class="space-y-3">
    <UAlert
      v-if="!authorized()"
      role="status"
      data-testid="refund-admin-access"
      color="warning"
      variant="subtle"
      icon="i-lucide-lock"
      title="Confirma tu sesión para gestionar reembolsos"
      description="Solo puede hacerlo un administrador con el correo verificado y la verificación en dos pasos."
    />
    <template v-else>
      <UAlert
        v-if="message && !drawerOpen"
        role="status"
        data-testid="refund-admin-message"
        :color="messageTone"
        variant="subtle"
        :title="message"
      />
      <p v-if="!view && !state.intent" role="status" data-testid="refund-admin-read-error" class="sr-only">
        Para gestionar reembolsos hace falta cargar antes los datos actuales del pedido.
      </p>
      <UAlert
        v-if="state.intent && !drawerOpen"
        color="warning"
        variant="subtle"
        icon="i-lucide-hourglass"
        title="Tienes una operación de reembolso sin terminar"
        :description="
          state.ambiguous
            ? 'Falta confirmar su resultado. Ábrela y compruébala antes de preparar otra o de salir de esta página.'
            : 'La has preparado pero no la has enviado. Ábrela para enviarla o descartarla.'
        "
      />
      <div v-if="view || state.intent" class="flex justify-end border-t border-[var(--border)] pt-4">
        <AdminButton
          variant="primary"
          icon="i-lucide-banknote"
          data-testid="refund-admin-open"
          @click="drawerOpen = true"
        >
          {{ state.intent ? 'Continuar la operación' : 'Gestionar reembolsos' }}
        </AdminButton>
      </div>

      <AdminDrawer
        v-model:open="drawerOpen"
        wide
        title="Gestionar reembolsos"
        description="Prepara, autoriza o cancela un reembolso y pide su factura rectificativa. Antes de enviar verás un resumen."
      >
        <div class="adm-stack">
          <UAlert
            v-if="message"
            role="status"
            data-testid="refund-admin-message"
            :color="messageTone"
            variant="subtle"
            :title="message"
          />
          <AdminEmptyState
            v-if="!view && !state.intent"
            compact
            icon="i-lucide-refresh-cw"
            title="Faltan los datos actuales del pedido"
            description="Cierra este panel, pulsa «Actualizar» en la tarjeta de reembolsos y vuelve a abrirlo."
          />
          <form v-if="view && !state.intent" :id="formId" data-testid="refund-admin-form" @submit.prevent="prepare">
            <fieldset :disabled="state.busy" class="adm-stack min-w-0">
              <legend class="sr-only">Preparar una operación de reembolso</legend>
              <AdminFormField v-slot="{ id }" label="Qué quieres hacer" required>
                <select :id="id" v-model="selected" data-testid="refund-admin-action" class="adm-input w-full" required>
                  <option value="">Elige una operación</option>
                  <option
                    v-for="(label, action) in labels"
                    :key="action"
                    :value="action"
                    :disabled="action === 'plan' && !actionAvailable('plan', view)"
                  >
                    {{ label }}
                  </option>
                </select>
              </AdminFormField>
              <AdminFormField
                v-if="selected && selected !== 'plan'"
                v-slot="{ id }"
                :label="selected === 'reconcile_credit' ? 'Factura rectificativa' : 'Reembolso'"
                :help="
                  targets.length ? undefined : 'Ahora mismo no hay ninguno al que se pueda aplicar esta operación.'
                "
                required
              >
                <select :id="id" v-model="targetId" data-testid="refund-admin-target" class="adm-input w-full" required>
                  <option value="">Elige uno</option>
                  <option v-for="target in targets" :key="target.id" :value="target.id">{{ target.text }}</option>
                </select>
              </AdminFormField>
              <AdminFormField
                v-if="selected === 'plan' || selected === 'queue_credit'"
                v-slot="{ id, describedBy }"
                :label="
                  selected === 'plan'
                    ? 'Identificador de la política de reembolsos aprobada'
                    : 'Identificador de la política de rectificativas aprobada'
                "
                help="Pega el identificador completo de la política aprobada que ampara esta operación."
                required
              >
                <input
                  :id="id"
                  v-model="policyId"
                  :aria-describedby="describedBy"
                  data-testid="refund-admin-policy"
                  type="text"
                  autocomplete="off"
                  spellcheck="false"
                  placeholder="00000000-0000-0000-0000-000000000000"
                  class="adm-input w-full"
                  required
                />
              </AdminFormField>
              <fieldset v-if="selected === 'plan'" class="adm-stack min-w-0">
                <legend class="adm-label">Devolución y artículos que se reembolsan</legend>
                <div class="grid gap-4 sm:grid-cols-2">
                  <AdminFormField v-slot="{ id }" label="Referencia de la devolución" required>
                    <input
                      :id="id"
                      v-model="returnRef"
                      data-testid="refund-admin-rma"
                      type="text"
                      autocomplete="off"
                      spellcheck="false"
                      placeholder="RMA-…"
                      class="adm-input w-full"
                      required
                    />
                  </AdminFormField>
                  <AdminFormField
                    v-slot="{ id, describedBy }"
                    label="Versión de la devolución"
                    help="La verás en la ficha de la devolución, junto a su estado."
                    required
                  >
                    <input
                      :id="id"
                      v-model="returnVersion"
                      :aria-describedby="describedBy"
                      data-testid="refund-admin-rma-version"
                      type="text"
                      inputmode="numeric"
                      autocomplete="off"
                      class="adm-input w-full"
                      required
                    />
                  </AdminFormField>
                </div>
                <div
                  v-for="(line, index) in lines"
                  :key="index"
                  class="rounded-[var(--radius-control)] border border-[var(--border)] p-3"
                >
                  <div class="mb-3 flex items-center justify-between gap-3">
                    <p class="font-medium text-[var(--text-strong)]">Artículo {{ index + 1 }}</p>
                    <AdminButton
                      v-if="lines.length > 1"
                      variant="ghost"
                      size="sm"
                      icon="i-lucide-trash-2"
                      :aria-label="`Quitar línea ${index + 1}`"
                      @click="lines.splice(index, 1)"
                    >
                      Quitar
                    </AdminButton>
                  </div>
                  <div class="grid gap-3 sm:grid-cols-3">
                    <AdminFormField
                      v-slot="{ id, describedBy }"
                      label="Línea del pedido"
                      help="Posición en el pedido; la primera es la 0."
                      required
                    >
                      <input
                        :id="id"
                        v-model="line.lineIndex"
                        :aria-describedby="describedBy"
                        :data-testid="`refund-line-index-${index}`"
                        type="text"
                        inputmode="numeric"
                        autocomplete="off"
                        class="adm-input w-full"
                        required
                      />
                    </AdminFormField>
                    <AdminFormField v-slot="{ id }" label="Unidades" required>
                      <input
                        :id="id"
                        v-model="line.quantity"
                        :data-testid="`refund-line-quantity-${index}`"
                        type="text"
                        inputmode="numeric"
                        autocomplete="off"
                        class="adm-input w-full"
                        required
                      />
                    </AdminFormField>
                    <AdminFormField
                      v-slot="{ id, describedBy }"
                      label="Importe (€)"
                      help="Opcional. Vacío devuelve lo pagado."
                    >
                      <input
                        :id="id"
                        v-model="line.amountEuros"
                        :aria-describedby="describedBy"
                        :data-testid="`refund-line-amount-${index}`"
                        type="text"
                        inputmode="decimal"
                        autocomplete="off"
                        placeholder="0,00"
                        class="adm-input w-full"
                      />
                    </AdminFormField>
                  </div>
                </div>
                <div>
                  <AdminButton
                    size="sm"
                    icon="i-lucide-plus"
                    :disabled="lines.length >= 100"
                    data-testid="refund-add-line"
                    @click="lines.push({ lineIndex: '', quantity: '', amountEuros: '' })"
                  >
                    Añadir otro artículo
                  </AdminButton>
                </div>
                <p class="adm-help">
                  Si indicas un importe menor que lo pagado, esas unidades quedan reembolsadas: después no se podrá
                  devolver el resto desde aquí.
                </p>
                <label class="adm-check">
                  <input v-model="shipping" data-testid="refund-shipping-opt-in" type="checkbox" />
                  Devolver también gastos de envío
                </label>
                <AdminFormField v-if="shipping" v-slot="{ id }" label="Gastos de envío que se devuelven (€)" required>
                  <input
                    :id="id"
                    v-model="shippingEuros"
                    data-testid="refund-shipping-cents"
                    type="text"
                    inputmode="decimal"
                    autocomplete="off"
                    placeholder="0,00"
                    class="adm-input w-full sm:max-w-48"
                    required
                  />
                </AdminFormField>
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
                  data-testid="refund-admin-reason"
                  minlength="10"
                  maxlength="500"
                  autocomplete="off"
                  rows="3"
                  class="adm-input w-full"
                  required
                />
              </AdminFormField>
              <AdminFormField
                v-slot="{ id, describedBy }"
                label="Justificante"
                help="Referencia del documento o de la conversación que respalda la operación."
                required
              >
                <input
                  :id="id"
                  v-model="evidenceRef"
                  :aria-describedby="describedBy"
                  data-testid="refund-admin-evidence"
                  type="text"
                  maxlength="200"
                  autocomplete="off"
                  class="adm-input w-full"
                  required
                />
              </AdminFormField>
              <p class="adm-help">
                Preparar o autorizar no mueve dinero al instante: el reembolso se envía al banco después. La factura
                original no se modifica y las unidades no vuelven al stock.
              </p>
            </fieldset>
          </form>
          <div v-if="state.intent" data-testid="refund-admin-intent" class="adm-stack">
            <UAlert
              v-if="state.ambiguous"
              role="alert"
              color="warning"
              variant="subtle"
              icon="i-lucide-triangle-alert"
              title="Falta confirmar el resultado"
              description="No prepares otra operación ni cierres la página. «Comprobar de nuevo» recupera esta misma operación; no devuelve el dinero dos veces."
            />
            <div>
              <p class="adm-help">Revisa antes de enviar</p>
              <p class="mt-0.5 text-base font-semibold text-[var(--text-strong)]">{{ labels[state.intent.action] }}</p>
            </div>
            <dl class="divide-y divide-[var(--border)] border-y border-[var(--border)]">
              <div v-if="state.intent.amountCents !== null" class="flex justify-between gap-4 py-2.5">
                <dt class="text-[var(--text-muted)]">Importe</dt>
                <dd class="whitespace-nowrap font-medium tabular-nums text-[var(--text-strong)]">
                  {{ financialAmount(state.intent.amountCents) }}
                </dd>
              </div>
              <div v-if="intentTarget" class="flex justify-between gap-4 py-2.5">
                <dt class="text-[var(--text-muted)]">Devolución</dt>
                <dd class="whitespace-nowrap tabular-nums">{{ intentTarget.returnPublicRef }}</dd>
              </div>
              <div v-if="'returnPublicRef' in state.intent.body" class="flex justify-between gap-4 py-2.5">
                <dt class="text-[var(--text-muted)]">Devolución</dt>
                <dd class="whitespace-nowrap tabular-nums">
                  {{ state.intent.body.returnPublicRef }} · versión {{ state.intent.body.expectedReturnVersion }}
                </dd>
              </div>
              <div v-if="'policyId' in state.intent.body" class="flex justify-between gap-4 py-2.5">
                <dt class="text-[var(--text-muted)]">Política aprobada</dt>
                <dd class="whitespace-nowrap tabular-nums" :title="state.intent.body.policyId">
                  {{ adminShortId(state.intent.body.policyId) }}
                </dd>
              </div>
              <div v-if="'lines' in state.intent.body" class="py-2.5">
                <dt class="text-[var(--text-muted)]">Artículos</dt>
                <dd>
                  <ul class="mt-1 space-y-1">
                    <li
                      v-for="line in state.intent.body.lines"
                      :key="line.lineIndex"
                      class="flex justify-between gap-4"
                    >
                      <span>
                        Línea {{ line.lineIndex }} · {{ line.quantity }}
                        {{ line.quantity === 1 ? 'unidad' : 'unidades' }}
                      </span>
                      <span class="whitespace-nowrap tabular-nums">
                        {{ line.amountCents !== undefined ? financialAmount(line.amountCents) : 'Lo pagado' }}
                      </span>
                    </li>
                  </ul>
                </dd>
              </div>
              <div
                v-if="'shippingCents' in state.intent.body && state.intent.body.shippingCents !== undefined"
                class="flex justify-between gap-4 py-2.5"
              >
                <dt class="text-[var(--text-muted)]">Gastos de envío</dt>
                <dd class="whitespace-nowrap tabular-nums">{{ financialAmount(state.intent.body.shippingCents) }}</dd>
              </div>
              <div class="py-2.5">
                <dt class="text-[var(--text-muted)]">Motivo interno</dt>
                <dd class="mt-0.5 break-words">{{ state.intent.body.reason }}</dd>
              </div>
              <div class="py-2.5">
                <dt class="text-[var(--text-muted)]">Justificante</dt>
                <dd class="mt-0.5 break-words">{{ state.intent.body.evidenceRef }}</dd>
              </div>
            </dl>
            <p v-if="state.intent.action === 'plan'" class="adm-help">
              El importe exacto se calcula al enviar, con lo que se pagó por esas unidades. Preparar el reembolso
              todavía no devuelve dinero.
            </p>
          </div>
        </div>
        <template #footer>
          <template v-if="state.intent">
            <AdminButton
              v-if="!state.ambiguous"
              data-testid="refund-admin-discard"
              :disabled="state.busy"
              @click="discard"
            >
              Descartar
            </AdminButton>
            <AdminButton variant="primary" data-testid="refund-admin-send" :loading="state.busy" @click="dispatch">
              {{ state.busy ? 'Comprobando…' : state.ambiguous ? 'Comprobar de nuevo' : 'Enviar' }}
            </AdminButton>
          </template>
          <template v-else>
            <AdminButton @click="drawerOpen = false">Cancelar</AdminButton>
            <AdminButton
              v-if="view"
              variant="primary"
              type="submit"
              :form="formId"
              data-testid="refund-admin-prepare"
              :disabled="!selectionAvailable || state.busy"
            >
              Revisar antes de enviar
            </AdminButton>
          </template>
        </template>
      </AdminDrawer>
    </template>
  </section>
</template>
