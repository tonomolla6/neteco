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
import type { AdminTone } from '~/utils/adminLabels'
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
  message = ref(''),
  /** Solo interfaz: panel lateral abierto y servicio no activado (la lectura responde 503). */
  drawerOpen = ref(false),
  unavailable = ref(false)
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
/** El comerciante teclea euros y un porcentaje; la API sigue recibiendo céntimos y puntos básicos (21 % = 2100). */
const netCents = computed(() => adminEurosToCents(actualNet.value) ?? NaN)
const taxBps = computed(() => adminEurosToCents(tax.value) ?? NaN)
const costReady = computed(() => Number.isSafeInteger(netCents.value) && Number.isSafeInteger(taxBps.value))
const gross = computed(() => actualGross(netCents.value, taxBps.value))
const taxPercent = (bps: number) => `${(bps / 100).toLocaleString('es-ES')} %`
const stateBadges: Record<AdminOrderPacking['state'], [string, AdminTone]> = {
  unpacked: ['Sin embalar', 'neutral'],
  packed: ['Embalado', 'info'],
  manual_dispatch_recorded: ['Envío manual registrado', 'success']
}
const blockerLabels: Record<AdminOrderPacking['readiness']['blockers'][number], string> = {
  order_cancelled: 'El pedido está cancelado',
  payment_unconfirmed: 'El cobro no está confirmado',
  inventory_unconfirmed: 'La reserva de stock no está confirmada',
  warehouse_unavailable: 'El almacén no está disponible',
  shipping_mode_unavailable: 'La forma de entrega no está disponible',
  history_unconfirmed: 'El historial de la preparación no está confirmado'
}
const parcelFields = [
  ['weight', 'Peso (g)'],
  ['width', 'Ancho (mm)'],
  ['height', 'Alto (mm)'],
  ['depth', 'Fondo (mm)']
] as const
const lineName = (data: AdminOrderPacking | null, lineIndex: number) =>
  data?.lines.find((line) => line.lineIndex === lineIndex)?.name ?? `Línea ${lineIndex + 1}`
function openDrawer(next: 'pack' | 'manual_dispatch') {
  mode.value = next
  drawerOpen.value = true
}
function httpStatus(error: unknown): number | null {
  const failure = error as { statusCode?: number; status?: number; response?: { status?: number } } | null
  return failure?.statusCode ?? failure?.status ?? failure?.response?.status ?? null
}
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
  drawerOpen.value = false
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
      'El pedido ha cambiado mientras lo preparabas y no se ha guardado nada. Revisa el embalaje actual y vuelve a intentarlo.'
    return true
  }
  if (status !== 401 && status !== 403) return false
  purge()
  revoked.value = true
  failed.value = true
  message.value = 'Tu sesión ya no tiene permiso para ver estos datos. No se ha enviado nada.'
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
  unavailable.value = false
  snapshot.value = null
  try {
    const data = await state(epoch)
    if (current(epoch)) {
      snapshot.value = data
      drafts(data)
    }
  } catch (error) {
    if (current(epoch) && !rejection(error)) {
      failed.value = true
      unavailable.value = httpStatus(error) === 503
    }
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
          actualNetCents: netCents.value,
          taxBps: taxBps.value
        })
  }
  const parsed = orderPackingInputSchema.safeParse(raw)
  if (
    !parsed.success ||
    (mode.value === 'pack' && data.lines.some((line) => remaining(line.lineIndex, line.quantity) !== 0))
  ) {
    message.value =
      'Completa el peso y las medidas de cada bulto, reparte todas las unidades y escribe un motivo de entre 10 y 500 caracteres. El envío manual necesita además todos los datos del transportista, el coste real y el IVA.'
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
    if (current(epoch)) message.value = 'No se ha podido preparar el resumen. No se ha enviado nada.'
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
  drawerOpen.value = false
  message.value =
    'Registro guardado. No cambia el stock, los cobros ni el estado de la preparación, y no avisa al transportista.'
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
      message.value = 'No sabemos si se ha guardado. Pulsa «Comprobar de nuevo»; no se enviará otra vez.'
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
      message.value = 'Sigue sin confirmarse. Puede que sí se haya guardado: vuelve a comprobarlo en unos segundos.'
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
    unavailable.value = false
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
    aria-label="Embalaje y envío manual"
    class="adm-stack min-w-0 border-t border-[var(--border)] pt-5"
  >
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="min-w-0">
        <h3 class="font-semibold text-[var(--text-strong)]">Embalaje y envío manual</h3>
        <p class="adm-help">
          Anota los bultos del pedido y, si lo envías por tu cuenta, los datos del transportista. No genera etiquetas ni
          avisa al transportista.
        </p>
      </div>
      <AdminButton
        v-if="authorized && !intent"
        size="sm"
        icon="i-lucide-rotate-cw"
        :disabled="busy || loading || pending"
        @click="read"
      >
        Actualizar embalaje
      </AdminButton>
    </div>
    <UAlert
      v-if="!authorized || revoked"
      role="status"
      color="warning"
      variant="subtle"
      icon="i-lucide-lock"
      title="Confirma tu sesión para ver el embalaje"
      description="Hace falta el correo verificado, la verificación en dos pasos y permiso de administración."
    />
    <p v-if="loading" role="status" class="adm-help">Cargando el embalaje…</p>
    <div v-if="unavailable" role="status" data-testid="packing-unavailable">
      <AdminEmptyState
        compact
        icon="i-lucide-package"
        title="El registro de embalaje no está activado en esta tienda"
        description="Cuando se active, aquí podrás anotar los bultos y los envíos hechos por tu cuenta."
      />
    </div>
    <div v-else-if="failed && !revoked" role="alert">
      <AdminEmptyState
        variant="error"
        compact
        title="No hemos podido cargar el embalaje"
        description="No significa que el pedido no tenga bultos. Vuelve a intentarlo."
      />
    </div>
    <template v-if="snapshot && authorized && !revoked">
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <AdminBadge :tone="stateBadges[snapshot.state][1]" class="whitespace-nowrap">
          {{ stateBadges[snapshot.state][0] }}
        </AdminBadge>
        <span class="adm-help">
          Envío presupuestado:
          <span class="whitespace-nowrap tabular-nums">{{ money(snapshot.quotedGrossCents) }}</span> (IVA incluido)
        </span>
      </div>
      <UAlert
        v-if="!snapshot.readiness.ready"
        role="status"
        color="warning"
        variant="subtle"
        icon="i-lucide-circle-pause"
        title="Ahora no se puede registrar el embalaje"
        :description="snapshot.readiness.blockers.map((blocker) => blockerLabels[blocker]).join('. ') + '.'"
      />
      <div v-if="snapshot.parcels.length" class="adm-table-wrap">
        <table class="adm-table min-w-[30rem]" aria-label="Bultos registrados">
          <thead>
            <tr>
              <th scope="col">Bulto</th>
              <th scope="col" data-numeric>Peso</th>
              <th scope="col">Medidas</th>
              <th scope="col">Contenido</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(parcel, index) in snapshot.parcels" :key="index">
              <td class="whitespace-nowrap font-medium text-[var(--text-strong)]">Bulto {{ index + 1 }}</td>
              <td data-numeric class="whitespace-nowrap tabular-nums">
                {{ parcel.weightGrams.toLocaleString('es-ES') }} g
              </td>
              <td class="whitespace-nowrap tabular-nums">
                {{ parcel.widthMm }} × {{ parcel.heightMm }} × {{ parcel.depthMm }} mm
              </td>
              <td>
                <ul class="space-y-0.5">
                  <li v-for="content in parcel.contents" :key="content.lineIndex">
                    {{ content.quantity }} × {{ lineName(snapshot, content.lineIndex) }}
                  </li>
                </ul>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="adm-help">Todavía no hay bultos anotados.</p>
      <div v-if="snapshot.dispatch" class="adm-stack">
        <div class="adm-table-wrap">
          <table class="adm-table min-w-[36rem]" aria-label="Envío manual registrado">
            <thead>
              <tr>
                <th scope="col">Bulto</th>
                <th scope="col">Transportista</th>
                <th scope="col">Número de envío</th>
                <th scope="col">Seguimiento</th>
                <th scope="col">Etiqueta</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="shipment in snapshot.dispatch.shipments" :key="shipment.parcelIndex">
                <td class="whitespace-nowrap font-medium text-[var(--text-strong)]">
                  Bulto {{ shipment.parcelIndex + 1 }}
                </td>
                <td>{{ shipment.carrier }}</td>
                <td class="whitespace-nowrap tabular-nums">{{ shipment.shipmentNumber }}</td>
                <td class="whitespace-nowrap tabular-nums">{{ shipment.trackingNumber }}</td>
                <td class="whitespace-nowrap tabular-nums">{{ shipment.externalLabelReference }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="adm-help">
          Anotado el <span class="whitespace-nowrap">{{ adminDate(snapshot.dispatch.recordedAt, true) }}</span> · Coste
          real <span class="whitespace-nowrap tabular-nums">{{ money(snapshot.dispatch.actualGrossCents) }}</span> ·
          Diferencia con lo presupuestado
          <span class="whitespace-nowrap tabular-nums">{{ money(snapshot.dispatch.varianceGrossCents) }}</span> · Datos
          anotados a mano, sin comprobar con el transportista.
        </p>
      </div>
      <div
        v-if="!intent && (snapshot.capabilities.packingWrite || snapshot.capabilities.manualDispatch)"
        class="flex flex-wrap gap-2"
      >
        <AdminButton
          v-if="snapshot.capabilities.packingWrite"
          icon="i-lucide-package"
          :disabled="locked"
          @click="openDrawer('pack')"
        >
          {{ snapshot.parcels.length ? 'Cambiar embalaje' : 'Anotar embalaje' }}
        </AdminButton>
        <AdminButton
          v-if="snapshot.capabilities.manualDispatch"
          data-testid="packing-dispatch-mode"
          icon="i-lucide-truck"
          :disabled="locked"
          @click="openDrawer('manual_dispatch')"
        >
          Anotar envío manual
        </AdminButton>
      </div>
    </template>
    <UAlert
      v-if="intent && authorized && !revoked && !drawerOpen"
      color="warning"
      variant="subtle"
      icon="i-lucide-hourglass"
      title="Tienes un registro sin terminar"
      :description="
        uncertain
          ? 'Falta confirmar si se ha guardado. Ábrelo y compruébalo antes de salir de esta página.'
          : 'Lo has preparado pero no lo has confirmado. Ábrelo para confirmarlo o cancelarlo.'
      "
    />
    <div v-if="intent && authorized && !revoked && !drawerOpen">
      <AdminButton variant="primary" @click="drawerOpen = true">Continuar el registro</AdminButton>
    </div>
    <UAlert
      v-if="message && !drawerOpen"
      role="status"
      :color="uncertain ? 'warning' : 'neutral'"
      variant="subtle"
      :title="message"
    />

    <AdminDrawer
      v-model:open="drawerOpen"
      wide
      :title="(intent ? intent.body.action : mode) === 'pack' ? 'Embalaje del pedido' : 'Envío manual'"
      :description="
        (intent ? intent.body.action : mode) === 'pack'
          ? 'Anota cada bulto con su peso, sus medidas y lo que lleva dentro.'
          : 'Anota los datos del transportista de cada bulto y lo que ha costado el envío.'
      "
    >
      <div class="adm-stack">
        <UAlert
          v-if="message"
          role="status"
          :color="uncertain ? 'warning' : 'neutral'"
          variant="subtle"
          :title="message"
        />
        <fieldset
          v-if="
            snapshot &&
            authorized &&
            !revoked &&
            !intent &&
            (mode === 'pack' ? snapshot.capabilities.packingWrite : snapshot.capabilities.manualDispatch)
          "
          :disabled="locked"
          class="adm-stack min-w-0"
        >
          <legend class="sr-only">
            {{ mode === 'pack' ? 'Contenido y medidas de cada bulto' : 'Datos del transportista por bulto' }}
          </legend>
          <template v-if="mode === 'pack'">
            <fieldset
              v-for="(parcel, index) in parcels"
              :key="index"
              class="min-w-0 rounded-[var(--radius-control)] border border-[var(--border)] p-3"
            >
              <legend class="sr-only">Bulto {{ index + 1 }}</legend>
              <div class="mb-3 flex items-center justify-between gap-3">
                <p class="font-medium text-[var(--text-strong)]">Bulto {{ index + 1 }}</p>
                <AdminButton
                  variant="ghost"
                  size="sm"
                  icon="i-lucide-trash-2"
                  :data-testid="`packing-remove-parcel-${index}`"
                  :disabled="parcels.length <= 1"
                  :aria-label="`Quitar bulto ${index + 1}`"
                  @click="parcels.splice(index, 1)"
                >
                  Quitar
                </AdminButton>
              </div>
              <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <AdminFormField v-for="[field, text] in parcelFields" :key="field" v-slot="{ id }" :label="text">
                  <input
                    :id="id"
                    v-model="parcel[field]"
                    :data-testid="`packing-${field}-${index}`"
                    type="number"
                    min="1"
                    :max="field === 'weight' ? 1000000 : 3000"
                    step="1"
                    class="adm-input w-full min-w-0"
                  />
                </AdminFormField>
              </div>
              <p class="adm-label mt-4">Unidades en este bulto</p>
              <ul class="mt-1 divide-y divide-[var(--border)]">
                <li
                  v-for="line in snapshot.lines"
                  :key="line.lineIndex"
                  class="flex items-center justify-between gap-3 py-2"
                >
                  <label :for="`packing-quantity-${index}-${line.lineIndex}`" class="min-w-0 break-words font-normal">
                    {{ line.name }}
                    <span class="block text-xs text-[var(--text-muted)]">
                      {{ line.sku }} · {{ line.quantity }} en el pedido
                    </span>
                  </label>
                  <input
                    :id="`packing-quantity-${index}-${line.lineIndex}`"
                    v-model="parcel.quantities[line.lineIndex]"
                    :data-testid="`packing-quantity-${index}-${line.lineIndex}`"
                    type="number"
                    min="0"
                    :max="line.quantity"
                    step="1"
                    placeholder="0"
                    class="adm-input w-20 shrink-0"
                  />
                </li>
              </ul>
            </fieldset>
            <div>
              <AdminButton
                size="sm"
                icon="i-lucide-plus"
                data-testid="packing-add-parcel"
                :disabled="parcels.length >= 20"
                @click="parcels.push(emptyParcel())"
              >
                Añadir bulto
              </AdminButton>
            </div>
            <div>
              <p class="adm-label">Unidades por repartir</p>
              <ul aria-label="Artículos del pedido" class="mt-1 space-y-1">
                <li
                  v-for="line in snapshot.lines"
                  :key="line.lineIndex"
                  class="flex items-center justify-between gap-3"
                >
                  <span class="min-w-0 break-words">{{ line.name }}</span>
                  <AdminBadge
                    :tone="remaining(line.lineIndex, line.quantity) === 0 ? 'success' : 'warning'"
                    class="whitespace-nowrap"
                  >
                    {{
                      remaining(line.lineIndex, line.quantity) === 0
                        ? 'Repartido'
                        : remaining(line.lineIndex, line.quantity) > 0
                          ? `Faltan ${remaining(line.lineIndex, line.quantity)}`
                          : `Sobran ${-remaining(line.lineIndex, line.quantity)}`
                    }}
                  </AdminBadge>
                </li>
              </ul>
              <p class="adm-help mt-2">
                Cada unidad del pedido tiene que ir en un bulto, y solo en uno. Hasta 20 bultos.
              </p>
            </div>
          </template>
          <template v-else>
            <fieldset
              v-for="(shipment, index) in shipments"
              :key="shipment.parcelIndex"
              class="min-w-0 rounded-[var(--radius-control)] border border-[var(--border)] p-3"
            >
              <legend class="sr-only">Bulto {{ shipment.parcelIndex + 1 }}</legend>
              <p class="mb-3 font-medium text-[var(--text-strong)]">Bulto {{ shipment.parcelIndex + 1 }}</p>
              <div class="grid gap-3 sm:grid-cols-2">
                <AdminFormField v-slot="{ id }" label="Transportista">
                  <input
                    :id="id"
                    v-model="shipment.carrier"
                    :data-testid="`packing-carrier-${index}`"
                    maxlength="100"
                    class="adm-input w-full"
                  />
                </AdminFormField>
                <AdminFormField v-slot="{ id }" label="Número de envío">
                  <input
                    :id="id"
                    v-model="shipment.shipmentNumber"
                    :data-testid="`packing-shipment-${index}`"
                    maxlength="120"
                    class="adm-input w-full"
                  />
                </AdminFormField>
                <AdminFormField v-slot="{ id }" label="Número de seguimiento">
                  <input
                    :id="id"
                    v-model="shipment.trackingNumber"
                    :data-testid="`packing-tracking-${index}`"
                    maxlength="120"
                    class="adm-input w-full"
                  />
                </AdminFormField>
                <AdminFormField
                  v-slot="{ id, describedBy }"
                  label="Referencia de la etiqueta"
                  help="El código de la etiqueta, no un enlace ni un archivo."
                >
                  <input
                    :id="id"
                    v-model="shipment.externalLabelReference"
                    :aria-describedby="describedBy"
                    :data-testid="`packing-label-${index}`"
                    maxlength="200"
                    class="adm-input w-full"
                  />
                </AdminFormField>
              </div>
            </fieldset>
            <div class="grid gap-3 sm:grid-cols-2">
              <AdminFormField v-slot="{ id }" label="Coste real sin IVA (€)">
                <input
                  :id="id"
                  v-model="actualNet"
                  data-testid="packing-actual-net"
                  type="text"
                  inputmode="decimal"
                  autocomplete="off"
                  placeholder="0,00"
                  class="adm-input w-full"
                />
              </AdminFormField>
              <AdminFormField v-slot="{ id }" label="IVA (%)">
                <input
                  :id="id"
                  v-model="tax"
                  data-testid="packing-tax"
                  type="text"
                  inputmode="decimal"
                  autocomplete="off"
                  placeholder="21"
                  class="adm-input w-full"
                />
              </AdminFormField>
            </div>
            <p v-if="costReady" class="text-[var(--text)]">
              Total con IVA:
              <span class="whitespace-nowrap font-medium tabular-nums text-[var(--text-strong)]">{{
                money(gross)
              }}</span>
              · Diferencia con lo presupuestado:
              <span class="whitespace-nowrap tabular-nums">{{ money(gross - snapshot.quotedGrossCents) }}</span>
            </p>
          </template>
          <AdminFormField
            v-slot="{ id, describedBy }"
            label="Motivo"
            help="Entre 10 y 500 caracteres. No escribas datos bancarios ni contraseñas."
          >
            <textarea
              :id="id"
              v-model="reason"
              :aria-describedby="describedBy"
              data-testid="packing-reason"
              maxlength="500"
              rows="2"
              class="adm-input w-full"
            />
          </AdminFormField>
        </fieldset>
        <div v-if="intent && authorized && !revoked" class="adm-stack">
          <UAlert
            v-if="uncertain"
            role="status"
            color="warning"
            variant="subtle"
            icon="i-lucide-triangle-alert"
            title="Falta confirmar si se ha guardado"
            description="No se volverá a enviar. Pulsa «Comprobar de nuevo» para ver si el registro quedó guardado."
          />
          <div>
            <p class="adm-help">Revisa antes de confirmar</p>
            <h3 class="mt-0.5 text-base font-semibold text-[var(--text-strong)]">
              {{ intent.body.action === 'pack' ? 'Embalaje del pedido' : 'Envío manual' }}
            </h3>
            <p class="mt-1 break-words">{{ intent.body.reason }}</p>
          </div>
          <ol
            v-if="intent.body.action === 'pack'"
            class="divide-y divide-[var(--border)] border-y border-[var(--border)]"
          >
            <li v-for="(parcel, index) in intent.body.parcels" :key="index" class="py-2.5">
              <p class="font-medium text-[var(--text-strong)]">
                Bulto {{ index + 1 }}
                <span class="whitespace-nowrap font-normal tabular-nums text-[var(--text-muted)]">
                  · {{ parcel.weightGrams.toLocaleString('es-ES') }} g · {{ parcel.widthMm }} × {{ parcel.heightMm }} ×
                  {{ parcel.depthMm }} mm
                </span>
              </p>
              <ul class="mt-1 space-y-0.5">
                <li v-for="content in parcel.contents" :key="content.lineIndex">
                  {{ content.quantity }} × {{ lineName(snapshot, content.lineIndex) }}
                </li>
              </ul>
            </li>
          </ol>
          <template v-else>
            <ul class="divide-y divide-[var(--border)] border-y border-[var(--border)]">
              <li v-for="shipment in intent.body.shipments" :key="shipment.parcelIndex" class="py-2.5">
                <p class="font-medium text-[var(--text-strong)]">
                  Bulto {{ shipment.parcelIndex + 1 }} · {{ shipment.carrier }}
                </p>
                <p class="break-words text-xs text-[var(--text-muted)]">
                  Envío {{ shipment.shipmentNumber }} · Seguimiento {{ shipment.trackingNumber }} · Etiqueta
                  {{ shipment.externalLabelReference }}
                </p>
              </li>
            </ul>
            <p>
              Coste real con IVA ({{ taxPercent(intent.body.taxBps) }}):
              <span class="whitespace-nowrap font-medium tabular-nums text-[var(--text-strong)]">{{
                money(actualGross(intent.body.actualNetCents, intent.body.taxBps))
              }}</span>
            </p>
          </template>
        </div>
      </div>
      <template #footer>
        <template v-if="intent && authorized && !revoked">
          <AdminButton v-if="!uncertain" data-testid="packing-cancel-review" :disabled="busy" @click="intent = null">
            Volver a editar
          </AdminButton>
          <AdminButton
            v-if="!uncertain"
            variant="primary"
            data-testid="packing-confirm"
            :loading="busy"
            :disabled="pending"
            @click="send"
          >
            Confirmar
          </AdminButton>
          <AdminButton
            v-else
            variant="primary"
            data-testid="packing-recover"
            :loading="busy"
            :disabled="pending"
            @click="recover"
          >
            Comprobar de nuevo
          </AdminButton>
        </template>
        <template v-else>
          <AdminButton @click="drawerOpen = false">Cancelar</AdminButton>
          <AdminButton variant="primary" data-testid="packing-review" :disabled="locked" @click="prepare">
            Revisar
          </AdminButton>
        </template>
      </template>
    </AdminDrawer>
  </section>
</template>
