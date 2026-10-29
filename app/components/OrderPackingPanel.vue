<script setup lang="ts">
import { useAdminNavigation } from '~/composables/useAdminNavigation'
import { roundRatio } from '~~/server/domain/money'
import { catalogPolicyUuidSchema } from '~~/shared/catalog-publication-policy'
import {
  adminOrderPackingSchema,
  orderPackingInputSchema,
  orderPackingReceiptSchema,
  orderPackingCommandResponseSchema,
  orderPackingIntentHash,
  type AdminOrderPacking,
  type OrderPackingInput,
  type OrderPackingReceipt
} from '~~/shared/order-packing'
const props = defineProps<{ orderId: string; runtime: unknown; pending: boolean }>()
const emit = defineEmits<{ pending: [value: boolean]; confirmed: [receipt: OrderPackingReceipt] }>()
const { ready, loggedIn, user, session } = useUserSession()
const requestFetch = useRequestFetch()
const navigation = useAdminNavigation()
const scope = computed(() =>
  JSON.stringify([props.orderId, user.value?.id, session.value?.sessionId, session.value?.sessionVersion])
)
const authorized = computed(() => {
  const caps = navigation.capabilities.value
  return (
    props.runtime === 'cloudflare' &&
    ready.value &&
    loggedIn.value &&
    user.value?.emailVerified === true &&
    user.value?.mfaVerified === true &&
    catalogPolicyUuidSchema.safeParse(props.orderId).success &&
    catalogPolicyUuidSchema.safeParse(session.value?.sessionId).success &&
    Number.isSafeInteger(session.value?.sessionVersion) &&
    Number(session.value?.sessionVersion) >= 1 &&
    navigation.status.value === 'ready' &&
    caps?.state === 'ready' &&
    caps.identityId === user.value?.id &&
    caps.sessionId === session.value?.sessionId &&
    caps.sessionVersion === session.value?.sessionVersion &&
    caps.permissions.includes('administration.manage')
  )
})
const snapshot = shallowRef<AdminOrderPacking | null>(null)
const loading = ref(false),
  busy = ref(false),
  failed = ref(false),
  uncertain = ref(false),
  revoked = ref(false),
  message = ref('')
const mode = ref<'pack' | 'manual_dispatch'>('pack'),
  reason = ref(''),
  actualNet = ref(''),
  tax = ref('')
type ParcelDraft = { weight: string; width: string; height: string; depth: string; quantities: Record<number, string> }
const parcels = ref<ParcelDraft[]>([])
const shipments = ref<
  Array<{
    parcelIndex: number
    carrier: string
    shipmentNumber: string
    trackingNumber: string
    externalLabelReference: string
  }>
>([])
type Intent = Readonly<{ key: string; hash: string; body: OrderPackingInput }>
const intent = shallowRef<Intent | null>(null)
let active = true,
  generation = 0
const controllers = new Set<AbortController>()
const endpoint = () => `/api/admin/orders/${props.orderId}/packing`
const current = (epoch: number) => active && authorized.value && !revoked.value && epoch === generation
const locked = computed(() => busy.value || loading.value || props.pending || intent.value !== null)
const money = (cents: number) =>
  new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(cents / 100)
function actualGross(net: number, taxBps: number) {
  return Number.isSafeInteger(net) && Number.isSafeInteger(taxBps) && net >= 0 && taxBps >= 0
    ? net + roundRatio(BigInt(net) * BigInt(taxBps), 10000n)
    : 0
}
const gross = computed(() => actualGross(Number(actualNet.value), Number(tax.value)))
function emptyParcel(): ParcelDraft {
  return { weight: '', width: '', height: '', depth: '', quantities: {} }
}
function freezeBody(body: OrderPackingInput): OrderPackingInput {
  if (body.action === 'pack') {
    body.parcels.forEach((parcel) => {
      parcel.contents.forEach(Object.freeze)
      Object.freeze(parcel.contents)
      Object.freeze(parcel)
    })
    Object.freeze(body.parcels)
  } else {
    body.shipments.forEach(Object.freeze)
    Object.freeze(body.shipments)
  }
  return Object.freeze(body)
}
function drafts(data: AdminOrderPacking) {
  parcels.value = data.parcels.length
    ? data.parcels.map((parcel) => ({
        weight: String(parcel.weightGrams),
        width: String(parcel.widthMm),
        height: String(parcel.heightMm),
        depth: String(parcel.depthMm),
        quantities: Object.fromEntries(parcel.contents.map((item) => [item.lineIndex, String(item.quantity)]))
      }))
    : [emptyParcel()]
  shipments.value = data.parcels.map((_, parcelIndex) => ({
    parcelIndex,
    carrier: '',
    shipmentNumber: '',
    trackingNumber: '',
    externalLabelReference: ''
  }))
  mode.value = 'pack'
  reason.value = actualNet.value = tax.value = ''
}
function remaining(index: number, quantity: number) {
  return quantity - parcels.value.reduce((n, parcel) => n + Number(parcel.quantities[index] || 0), 0)
}
function purge() {
  generation++
  controllers.forEach((controller) => controller.abort())
  controllers.clear()
  snapshot.value = intent.value = null
  parcels.value = []
  shipments.value = []
  reason.value = actualNet.value = tax.value = message.value = ''
  busy.value = loading.value = failed.value = uncertain.value = false
}
function rejection(error: unknown, allowCas = false) {
  const failure = error as {
    statusCode?: number
    status?: number
    data?: { error?: { code?: string } }
    response?: { status?: number; _data?: { error?: { code?: string } } }
  } | null
  const status = failure?.statusCode ?? failure?.status ?? failure?.response?.status
  const code = failure?.data?.error?.code ?? failure?.response?._data?.error?.code
  if (allowCas && status === 409 && (code === 'version_conflict' || code === 'fulfillment_version_conflict')) {
    purge()
    failed.value = true
    message.value =
      'La versión ha cambiado y este intento se ha rechazado sin aplicarse. Actualiza el embalaje y revisa de nuevo antes de decidir.'
    return true
  }
  if (status !== 401 && status !== 403) return false
  purge()
  revoked.value = true
  failed.value = true
  message.value =
    'Acceso revocado. Se han retirado los datos privados; no se enviará ninguna operación automáticamente.'
  return true
}
async function request(path: string, options: Record<string, unknown> = {}) {
  const controller = new AbortController()
  controllers.add(controller)
  try {
    return await requestFetch<unknown>(path, { ...options, retry: 0, cache: 'no-store', signal: controller.signal })
  } finally {
    controllers.delete(controller)
  }
}
async function state(epoch: number) {
  const parsed = adminOrderPackingSchema.safeParse(await request(endpoint()))
  if (!current(epoch) || !parsed.success || parsed.data.orderId !== props.orderId)
    throw new Error('packing_unconfirmed')
  return parsed.data
}
async function read() {
  if (!authorized.value || props.pending || busy.value || loading.value || intent.value) return
  revoked.value = false
  const epoch = generation
  loading.value = true
  failed.value = false
  snapshot.value = null
  try {
    const data = await state(epoch)
    if (current(epoch)) {
      snapshot.value = data
      drafts(data)
    }
  } catch (error) {
    if (current(epoch) && !rejection(error)) failed.value = true
  } finally {
    if (current(epoch)) loading.value = false
  }
}
async function prepare() {
  const data = snapshot.value
  if (
    !current(generation) ||
    locked.value ||
    !data ||
    !(mode.value === 'pack' ? data.capabilities.packingWrite : data.capabilities.manualDispatch)
  )
    return
  const raw = {
    action: mode.value,
    expectedVersion: data.version,
    expectedFulfillmentVersion: data.fulfillmentVersion,
    reason: reason.value.trim(),
    ...(mode.value === 'pack'
      ? {
          parcels: parcels.value.map((parcel) => ({
            weightGrams: Number(parcel.weight),
            widthMm: Number(parcel.width),
            heightMm: Number(parcel.height),
            depthMm: Number(parcel.depth),
            contents: data.lines
              .filter((line) => Number(parcel.quantities[line.lineIndex] || 0) !== 0)
              .map((line) => ({ lineIndex: line.lineIndex, quantity: Number(parcel.quantities[line.lineIndex]) }))
          }))
        }
      : {
          shipments: shipments.value.map((shipment) => ({
            ...shipment,
            carrier: shipment.carrier.trim(),
            shipmentNumber: shipment.shipmentNumber.trim(),
            trackingNumber: shipment.trackingNumber.trim(),
            externalLabelReference: shipment.externalLabelReference.trim()
          })),
          actualNetCents: actualNet.value === '' ? NaN : Number(actualNet.value),
          taxBps: tax.value === '' ? NaN : Number(tax.value)
        })
  }
  const parsed = orderPackingInputSchema.safeParse(raw)
  if (
    !parsed.success ||
    (mode.value === 'pack' && data.lines.some((line) => remaining(line.lineIndex, line.quantity) !== 0))
  ) {
    message.value =
      'Completa medidas reales, cantidades exactas y un motivo de 10–500 caracteres; la expedición requiere todas las referencias y el coste real.'
    return
  }
  const epoch = generation
  busy.value = true
  message.value = ''
  try {
    const hash = await orderPackingIntentHash(props.orderId, parsed.data)
    if (current(epoch) && !props.pending)
      intent.value = Object.freeze({ key: crypto.randomUUID(), hash, body: freezeBody(parsed.data) })
  } catch {
    if (current(epoch)) message.value = 'No se pudo preparar la revisión. No se ha enviado nada.'
  } finally {
    if (current(epoch)) busy.value = false
  }
}
function receipt(raw: unknown, command: Intent) {
  const parsed = orderPackingReceiptSchema.safeParse(raw)
  if (
    !parsed.success ||
    parsed.data.orderId !== props.orderId ||
    parsed.data.commandId !== command.key ||
    parsed.data.payloadHash !== command.hash ||
    parsed.data.action !== command.body.action ||
    parsed.data.version !== command.body.expectedVersion + 1 ||
    parsed.data.fulfillmentVersion !== command.body.expectedFulfillmentVersion ||
    parsed.data.parcelCount !==
      (command.body.action === 'pack' ? command.body.parcels.length : command.body.shipments.length)
  )
    throw new Error('packing_receipt_unconfirmed')
  return parsed.data
}
async function confirm(result: OrderPackingReceipt, command: Intent, epoch: number) {
  const fresh = await state(epoch)
  if (
    fresh.version < result.version ||
    fresh.fulfillmentVersion < result.fulfillmentVersion ||
    (command.body.action === 'pack'
      ? JSON.stringify(fresh.parcels) !== JSON.stringify(command.body.parcels)
      : !fresh.dispatch ||
        fresh.dispatch.commandId !== command.key ||
        fresh.dispatch.packingVersion !== command.body.expectedVersion ||
        JSON.stringify(fresh.dispatch.shipments) !== JSON.stringify(command.body.shipments) ||
        fresh.dispatch.actualNetCents !== command.body.actualNetCents ||
        fresh.dispatch.taxBps !== command.body.taxBps)
  )
    throw new Error('packing_current_unconfirmed')
  if (!current(epoch) || intent.value !== command) return
  snapshot.value = fresh
  intent.value = null
  uncertain.value = false
  drafts(fresh)
  message.value =
    'Registro confirmado. No cambia existencias, cobros ni el estado de preparación; no acredita aceptación del transportista.'
  emit('confirmed', result)
}
async function send() {
  const command = intent.value
  if (!command || uncertain.value || busy.value || props.pending || !current(generation)) return
  const epoch = generation
  busy.value = uncertain.value = true
  let postResponded = false
  try {
    const raw = await request(endpoint() + '/commands', {
      method: 'POST',
      headers: { 'Idempotency-Key': command.key },
      body: command.body
    })
    postResponded = true
    if (current(epoch) && intent.value === command) await confirm(receipt(raw, command), command, epoch)
  } catch (error) {
    if (current(epoch) && !rejection(error, !postResponded))
      message.value = 'Resultado incierto. Comprueba el recibo; no se repetirá el envío.'
  } finally {
    if (current(epoch)) busy.value = false
  }
}
async function recover() {
  const command = intent.value
  if (!command || !uncertain.value || busy.value || props.pending || !current(generation)) return
  const epoch = generation
  busy.value = true
  try {
    const raw = await request(endpoint() + '/commands/' + command.key, {
      headers: { 'X-Neteco-Command-Payload-Hash': command.hash }
    })
    if (!current(epoch) || intent.value !== command) return
    const parsed = orderPackingCommandResponseSchema.safeParse(raw)
    if (!parsed.success || parsed.data.outcome !== 'applied') throw new Error('packing_unknown')
    await confirm(receipt(parsed.data.receipt, command), command, epoch)
  } catch (error) {
    if (current(epoch) && !rejection(error))
      message.value =
        'El resultado sigue sin confirmar. Desconocido no significa que no se aplicara; se conserva la intención.'
  } finally {
    if (current(epoch)) busy.value = false
  }
}
watch(intent, (value) => emit('pending', value !== null), { flush: 'sync' })
watch(
  () => [scope.value, authorized.value, props.runtime],
  () => {
    purge()
    revoked.value = false
    if (authorized.value) void read()
  },
  { immediate: true, flush: 'sync' }
)
onBeforeUnmount(() => {
  active = false
  purge()
  emit('pending', false)
})
defineExpose({ refresh: read })
</script>

<template>
  <section
    v-if="runtime === 'cloudflare'"
    aria-label="Embalaje y expedición manual"
    class="min-w-0 space-y-4 rounded-2xl border border-slate-200 bg-white p-5"
  >
    <h2 class="text-xl font-bold">Embalaje multibulto y expedición manual</h2>
    <p class="text-sm">
      Registro manual de contingencia: no confirma al transportista y no genera etiquetas. No cambia existencias, cobros
      ni la preparación.
    </p>
    <p v-if="!authorized || revoked" role="status">
      Confirma la sesión, el correo, MFA y los permisos vigentes para consultar datos privados.
    </p>
    <p v-if="loading" role="status">Consultando embalaje confirmado…</p>
    <p v-if="failed" role="alert">No se pudo confirmar el contexto privado. No se interpreta como pedido sin bultos.</p>
    <button
      v-if="authorized && !intent"
      type="button"
      :disabled="busy || loading || pending"
      class="rounded-lg border px-3 py-2 disabled:opacity-50"
      @click="read"
    >
      Actualizar embalaje
    </button>
    <template v-if="snapshot && authorized && !revoked">
      <p class="text-sm">
        Versión de embalaje {{ snapshot.version }} · Preparación {{ snapshot.fulfillmentVersion }} · Cotización
        histórica: {{ money(snapshot.quotedGrossCents) }} (IVA incluido)
      </p>
      <ul aria-label="Líneas contractuales" class="space-y-2">
        <li v-for="line in snapshot.lines" :key="line.lineIndex" class="break-words text-sm">
          {{ line.sku }} · {{ line.name }} · Cantidad pedida {{ line.quantity }} · Pendiente de asignar
          {{ remaining(line.lineIndex, line.quantity) }}
        </li>
      </ul>
      <ol v-if="snapshot.parcels.length" aria-label="Bultos registrados" class="space-y-2 text-sm">
        <li v-for="(parcel, index) in snapshot.parcels" :key="index" class="break-words">
          Bulto {{ index + 1 }} registrado: {{ parcel.weightGrams }} g · {{ parcel.widthMm }} × {{ parcel.heightMm }} ×
          {{ parcel.depthMm }} mm
          <ul>
            <li v-for="content in parcel.contents" :key="content.lineIndex">
              {{ snapshot.lines.find((line) => line.lineIndex === content.lineIndex)?.sku }} ·
              {{ content.quantity }} unidades
            </li>
          </ul>
        </li>
      </ol>
      <p v-if="!snapshot.readiness.ready" role="status">
        El servidor no confirma las condiciones necesarias para operar: {{ snapshot.readiness.blockers.join(', ') }}.
      </p>
      <div v-if="snapshot.dispatch" class="space-y-2 break-words text-sm">
        <p>Expedición manual registrada · Referencias no verificadas por el transportista.</p>
        <p>
          Coste real {{ money(snapshot.dispatch.actualGrossCents) }} · Diferencia con cotización
          {{ money(snapshot.dispatch.varianceGrossCents) }}
        </p>
        <p v-for="shipment in snapshot.dispatch.shipments" :key="shipment.parcelIndex">
          Bulto {{ shipment.parcelIndex + 1 }} · {{ shipment.carrier }} · Expedición {{ shipment.shipmentNumber }} ·
          Seguimiento {{ shipment.trackingNumber }} · Referencia de etiqueta externa
          {{ shipment.externalLabelReference }}
        </p>
      </div>
      <div
        v-if="!intent && (snapshot.capabilities.packingWrite || snapshot.capabilities.manualDispatch)"
        class="flex flex-wrap gap-2"
      >
        <button
          v-if="snapshot.capabilities.packingWrite"
          type="button"
          :disabled="locked"
          class="rounded-lg border px-3 py-2"
          @click="mode = 'pack'"
        >
          Revisar embalaje
        </button>
        <button
          v-if="snapshot.capabilities.manualDispatch"
          data-testid="packing-dispatch-mode"
          type="button"
          :disabled="locked"
          class="rounded-lg border px-3 py-2"
          @click="mode = 'manual_dispatch'"
        >
          Registrar expedición manual
        </button>
      </div>
      <fieldset
        v-if="!intent && (mode === 'pack' ? snapshot.capabilities.packingWrite : snapshot.capabilities.manualDispatch)"
        :disabled="locked"
        class="min-w-0 space-y-4"
      >
        <legend class="font-semibold">
          {{ mode === 'pack' ? 'Contenido y medidas reales' : 'Referencias externas por bulto' }}
        </legend>
        <template v-if="mode === 'pack'">
          <fieldset v-for="(parcel, index) in parcels" :key="index" class="min-w-0 space-y-3 rounded-lg border p-3">
            <legend class="font-semibold">Bulto {{ index + 1 }}</legend>
            <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label v-for="field in ['weight', 'width', 'height', 'depth'] as const" :key="field" class="text-sm"
                >{{
                  {
                    weight: 'Peso real (g)',
                    width: 'Ancho real (mm)',
                    height: 'Alto real (mm)',
                    depth: 'Fondo real (mm)'
                  }[field]
                }}
                <input
                  v-model="parcel[field]"
                  :data-testid="`packing-${field}-${index}`"
                  type="number"
                  min="1"
                  :max="field === 'weight' ? 1000000 : 3000"
                  step="1"
                  class="mt-1 block w-full min-w-0 rounded border p-2"
                />
              </label>
            </div>
            <label v-for="line in snapshot.lines" :key="line.lineIndex" class="block break-words text-sm"
              >Cantidad de {{ line.sku }} en bulto {{ index + 1 }}
              <input
                v-model="parcel.quantities[line.lineIndex]"
                :data-testid="`packing-quantity-${index}-${line.lineIndex}`"
                type="number"
                min="0"
                :max="line.quantity"
                step="1"
                class="mt-1 block w-full rounded border p-2"
              />
            </label>
            <button
              :data-testid="`packing-remove-parcel-${index}`"
              type="button"
              :disabled="parcels.length <= 1"
              class="rounded border px-3 py-2"
              @click="parcels.splice(index, 1)"
            >
              Quitar bulto {{ index + 1 }}
            </button>
          </fieldset>
          <button
            data-testid="packing-add-parcel"
            type="button"
            :disabled="parcels.length >= 20"
            class="rounded border px-3 py-2"
            @click="parcels.push(emptyParcel())"
          >
            Añadir bulto (máximo 20)
          </button>
          <p class="text-xs">
            Las medidas son límites de entrada, no certifican admisión por un transportista. Asigna todas las unidades
            exactamente una vez entre los bultos.
          </p>
        </template>
        <template v-else>
          <fieldset
            v-for="(shipment, index) in shipments"
            :key="shipment.parcelIndex"
            class="min-w-0 space-y-3 rounded-lg border p-3"
          >
            <legend>Bulto {{ shipment.parcelIndex + 1 }}</legend>
            <label class="block text-sm"
              >Transportista
              <input
                v-model="shipment.carrier"
                :data-testid="`packing-carrier-${index}`"
                maxlength="100"
                class="block w-full rounded border p-2"
            /></label>
            <label class="block text-sm"
              >Número de expedición
              <input
                v-model="shipment.shipmentNumber"
                :data-testid="`packing-shipment-${index}`"
                maxlength="120"
                class="block w-full rounded border p-2"
            /></label>
            <label class="block text-sm"
              >Número de seguimiento
              <input
                v-model="shipment.trackingNumber"
                :data-testid="`packing-tracking-${index}`"
                maxlength="120"
                class="block w-full rounded border p-2"
            /></label>
            <label class="block text-sm"
              >Referencia externa de etiqueta (no URL ni archivo)
              <input
                v-model="shipment.externalLabelReference"
                :data-testid="`packing-label-${index}`"
                maxlength="200"
                class="block w-full rounded border p-2"
            /></label>
          </fieldset>
          <label class="block text-sm"
            >Coste real neto (céntimos EUR)
            <input
              v-model="actualNet"
              data-testid="packing-actual-net"
              type="number"
              min="0"
              max="1000000000"
              step="1"
              class="block w-full rounded border p-2"
          /></label>
          <label class="block text-sm"
            >IVA real (puntos básicos; 2100 = 21 %)
            <input
              v-model="tax"
              data-testid="packing-tax"
              type="number"
              min="0"
              max="10000"
              step="1"
              class="block w-full rounded border p-2"
          /></label>
          <p v-if="actualNet !== '' && tax !== ''">
            Total real: {{ money(gross) }} · Diferencia: {{ money(gross - snapshot.quotedGrossCents) }}
          </p>
        </template>
        <label class="block text-sm"
          >Motivo operativo (sin datos sensibles)
          <textarea
            v-model="reason"
            data-testid="packing-reason"
            maxlength="500"
            rows="2"
            class="block w-full rounded border p-2"
          />
        </label>
        <button
          data-testid="packing-review"
          type="button"
          :disabled="locked"
          class="rounded-lg bg-neteco-700 px-4 py-2 text-white disabled:opacity-50"
          @click="prepare"
        >
          Revisar registro
        </button>
      </fieldset>
    </template>
    <div v-if="intent && authorized && !revoked" class="space-y-3 rounded-lg border border-amber-300 bg-amber-50 p-4">
      <h3 class="font-semibold">
        Confirmación explícita: {{ intent.body.action === 'pack' ? 'embalaje' : 'expedición manual' }}
      </h3>
      <p class="break-words">
        {{ intent.body.reason }} · Versión {{ intent.body.expectedVersion }} · Preparación
        {{ intent.body.expectedFulfillmentVersion }}
      </p>
      <ol v-if="intent.body.action === 'pack'" class="space-y-2 text-sm">
        <li v-for="(parcel, index) in intent.body.parcels" :key="index">
          Bulto {{ index + 1 }}: {{ parcel.weightGrams }} g · {{ parcel.widthMm }} × {{ parcel.heightMm }} ×
          {{ parcel.depthMm }} mm
          <ul>
            <li v-for="content in parcel.contents" :key="content.lineIndex">
              {{ snapshot?.lines.find((line) => line.lineIndex === content.lineIndex)?.sku }}:
              {{ content.quantity }} unidades
            </li>
          </ul>
        </li>
      </ol>
      <template v-else
        ><p>Total real {{ money(actualGross(intent.body.actualNetCents, intent.body.taxBps)) }}</p>
        <p v-for="shipment in intent.body.shipments" :key="shipment.parcelIndex" class="break-words text-sm">
          Bulto {{ shipment.parcelIndex + 1 }} · {{ shipment.carrier }} · {{ shipment.shipmentNumber }} ·
          {{ shipment.trackingNumber }} · {{ shipment.externalLabelReference }}
        </p></template
      >
      <p v-if="uncertain" role="status">
        Resultado incierto. La intención permanece bloqueada hasta comprobar recibo y estado actual; no se repetirá el
        POST.
      </p>
      <div class="flex flex-wrap gap-2">
        <button
          v-if="!uncertain"
          data-testid="packing-confirm"
          type="button"
          :disabled="busy || pending"
          class="rounded-lg bg-neteco-700 px-4 py-2 text-white"
          @click="send"
        >
          Confirmar registro
        </button>
        <button
          v-else
          data-testid="packing-recover"
          type="button"
          :disabled="busy || pending"
          class="rounded-lg border px-4 py-2"
          @click="recover"
        >
          Comprobar recibo y estado actual
        </button>
        <button
          v-if="!uncertain"
          data-testid="packing-cancel-review"
          type="button"
          :disabled="busy"
          class="rounded-lg border px-4 py-2"
          @click="intent = null"
        >
          Cancelar revisión sin enviar
        </button>
      </div>
    </div>
    <p v-if="message" role="status" class="break-words text-sm">{{ message }}</p>
  </section>
</template>
