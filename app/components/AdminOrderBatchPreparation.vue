<script setup lang="ts">
import { adminCapabilitiesSchema } from '~~/shared/admin-navigation'
import { fulfillmentActionSchema, type FulfillmentAction } from '~~/shared/order-fulfillment'
import {
  adminOrderBulkPreviewInputSchema,
  adminOrderBulkCreateInputSchema,
  adminOrderBulkPreviewSchema,
  adminOrderBulkReceiptSchema,
  adminOrderBulkGroupSchema,
  adminOrderBulkCommandSchema,
  adminOrderBulkIntentHash,
  type AdminOrderBulkPreview,
  type AdminOrderBulkCreateInput,
  type AdminOrderBulkReceipt,
  type AdminOrderBulkGroup
} from '~~/shared/admin-order-bulk'
const props = defineProps<{ scopeKey: string; enabled: boolean; pending: boolean; orderIds: string[] }>()
const emit = defineEmits<{ pending: [value: boolean]; confirmed: [group: AdminOrderBulkGroup] }>()
const request = useRequestFetch(),
  runtime = useRuntimeConfig(),
  navigation = useAdminNavigation()
const { ready, loggedIn, user, session } = useUserSession()
const authority = computed(() => {
  const caps = adminCapabilitiesSchema.safeParse(navigation.capabilities.value)
  if (
    !props.enabled ||
    !props.scopeKey ||
    runtime.public.serverRuntime !== 'cloudflare' ||
    !ready.value ||
    !loggedIn.value ||
    user.value?.emailVerified !== true ||
    user.value?.mfaVerified !== true ||
    navigation.status.value !== 'ready' ||
    !caps.success ||
    caps.data.state !== 'ready' ||
    !caps.data.permissions.includes('administration.manage') ||
    caps.data.identityId !== user.value.id ||
    caps.data.sessionId !== session.value?.sessionId ||
    caps.data.sessionVersion !== session.value?.sessionVersion
  )
    return null
  return JSON.stringify([props.scopeKey, caps.data.identityId, caps.data.sessionId, caps.data.sessionVersion])
})
const denied = ref(false),
  usable = computed(() => Boolean(authority.value) && !denied.value)
const action = ref<FulfillmentAction | ''>(''),
  reason = ref(''),
  evidence = ref(''),
  consent = ref(false),
  busy = ref(false),
  failed = ref(false),
  uncertain = ref(false)
const reviewed = shallowRef<AdminOrderBulkPreview | null>(null),
  result = shallowRef<AdminOrderBulkGroup | null>(null)
type Intent = {
  scope: string
  key: string
  hash: string
  body: AdminOrderBulkCreateInput
  receipt: AdminOrderBulkReceipt | null
}
const intent = shallowRef<Intent | null>(null)
const root = '/api/admin/orders/bulk-fulfillment'
const labels: Record<string, string> = {
  picking: 'En preparación',
  packed: 'Embalado',
  ready_for_pickup: 'Listo para recoger',
  in_transit: 'En reparto',
  delivered: 'Entregado',
  exception: 'Incidencia',
  not_found: 'Pedido no disponible',
  version_conflict: 'La versión ha cambiado',
  invalid_transition: 'Transición no permitida',
  order_cancelled: 'Pedido cancelado',
  payment_unconfirmed: 'Pago no confirmado',
  inventory_unconfirmed: 'Inventario no confirmado',
  warehouse_unavailable: 'Almacén no disponible',
  shipping_mode_unavailable: 'Entrega no disponible',
  history_unconfirmed: 'Historial no confirmado',
  unauthenticated: 'Sesión no vigente',
  email_unverified: 'Correo no verificado',
  mfa_required: 'MFA no vigente',
  forbidden: 'Permiso no vigente',
  idempotency_conflict: 'Conflicto de clave',
  shipping_mode_mismatch: 'Modo de entrega incompatible',
  conflict: 'Conflicto operativo'
}
const statuses = {
  pending: 'Pendiente',
  unknown: 'Resultado incierto',
  applied: 'Confirmado',
  rejected: 'Rechazado',
  not_attempted: 'No intentado'
}
const contextKey = computed(() => JSON.stringify([props.orderIds, action.value, reason.value, evidence.value]))
let alive = true,
  epoch = 0,
  controller: AbortController | null = null
function invalidate() {
  epoch++
  controller?.abort()
  controller = null
  reviewed.value = null
  consent.value = false
  result.value = null
  busy.value = false
  failed.value = false
  uncertain.value = false
  if (!intent.value) emit('pending', false)
}
function purge() {
  intent.value = null
  invalidate()
  action.value = ''
  reason.value = ''
  evidence.value = ''
  emit('pending', false)
}
watch(
  [authority, () => JSON.stringify(props.orderIds)],
  () => {
    purge()
    denied.value = false
  },
  { flush: 'sync' }
)
watch(
  contextKey,
  () => {
    if (!intent.value) invalidate()
  },
  { flush: 'sync' }
)
onBeforeUnmount(() => {
  alive = false
  purge()
})
function current(generation: number, scope: string) {
  return alive && generation === epoch && authority.value === scope && !denied.value
}
function failure(error: unknown, generation: number, scope: string) {
  if (!current(generation, scope)) return
  const e = error as { statusCode?: number; status?: number }
  if ([401, 403].includes(e?.statusCode ?? e?.status ?? 0)) {
    purge()
    denied.value = true
    return
  }
  failed.value = !intent.value
  uncertain.value = Boolean(intent.value)
}
async function preview() {
  if (!usable.value || props.pending || busy.value || intent.value) return
  const parsed = adminOrderBulkPreviewInputSchema.safeParse({
    action: action.value,
    orderIds: [...props.orderIds],
    reason: reason.value,
    ...(evidence.value ? { evidence: evidence.value } : {})
  })
  if (!parsed.success) {
    reviewed.value = null
    failed.value = true
    return
  }
  invalidate()
  const generation = epoch,
    scope = authority.value!,
    key = contextKey.value
  controller = new AbortController()
  const signal = controller.signal
  busy.value = true
  try {
    const raw = await request<unknown>(root + '/preview', {
      method: 'POST',
      body: parsed.data,
      retry: 0,
      cache: 'no-store',
      signal
    })
    if (!current(generation, scope) || contextKey.value !== key) return
    const dto = adminOrderBulkPreviewSchema.parse(raw),
      ids = new Set(parsed.data.orderIds)
    if (
      dto.action !== parsed.data.action ||
      dto.rows.length !== ids.size ||
      new Set(dto.rows.map((row) => row.orderId)).size !== ids.size ||
      dto.rows.some((row) => !ids.has(row.orderId))
    )
      throw Error('uncorrelated_preview')
    reviewed.value = dto
    emit('pending', true)
  } catch (error) {
    failure(error, generation, scope)
  } finally {
    if (current(generation, scope)) {
      busy.value = false
      controller = null
    }
  }
}
function receipt(raw: unknown, frozen: Intent) {
  const dto = adminOrderBulkReceiptSchema.parse(raw)
  if (
    dto.commandId !== frozen.key ||
    dto.payloadHash !== frozen.hash ||
    dto.previewHash !== frozen.body.previewHash ||
    dto.selected !== frozen.body.orders.length ||
    (reviewed.value && (dto.eligible !== reviewed.value.eligible || dto.blocked !== reviewed.value.blocked))
  )
    throw Error('uncorrelated_receipt')
  return dto
}
async function readGroup(frozen: Intent, generation: number, signal: AbortSignal) {
  const proof = frozen.receipt!
  const raw = await request<unknown>(`${root}/${proof.groupId}`, { method: 'GET', retry: 0, cache: 'no-store', signal })
  if (!current(generation, frozen.scope)) return
  const dto = adminOrderBulkGroupSchema.parse(raw),
    expected = new Map(frozen.body.orders.map((row) => [row.orderId, row.expectedVersion]))
  if (
    dto.groupId !== proof.groupId ||
    dto.commandId !== frozen.key ||
    dto.payloadHash !== frozen.hash ||
    dto.dispatchId !== proof.dispatchId ||
    dto.action !== frozen.body.action ||
    dto.selected !== expected.size ||
    dto.rows.some((row) => expected.get(row.orderId) !== row.expectedVersion)
  )
    throw Error('uncorrelated_group')
  result.value = dto
  uncertain.value = dto.status !== 'completed' || dto.remaining !== 0
  if (!uncertain.value) {
    intent.value = null
    reviewed.value = null
    consent.value = false
    emit('pending', false)
    emit('confirmed', dto)
  }
}
async function commit() {
  const facts = reviewed.value
  if (!usable.value || props.pending || busy.value || intent.value || !facts || !facts.eligible || !consent.value)
    return
  const parsed = adminOrderBulkCreateInputSchema.safeParse({
    action: action.value,
    orders: facts.rows.map((row) => ({ orderId: row.orderId, expectedVersion: row.expectedVersion })),
    reason: reason.value,
    ...(evidence.value ? { evidence: evidence.value } : {}),
    previewHash: facts.previewHash
  })
  if (!parsed.success) {
    failed.value = true
    return
  }
  const body = structuredClone(parsed.data),
    scope = authority.value!,
    key = crypto.randomUUID(),
    generation = ++epoch,
    context = contextKey.value
  controller = new AbortController()
  const signal = controller.signal
  busy.value = true
  failed.value = false
  emit('pending', true)
  try {
    const hash = await adminOrderBulkIntentHash(body)
    if (!current(generation, scope) || props.pending || contextKey.value !== context) return
    const frozen: Intent = { scope, key, hash, body, receipt: null }
    intent.value = frozen
    const raw = await request<unknown>(root + '/commands', {
      method: 'POST',
      body,
      headers: { 'Idempotency-Key': key },
      retry: 0,
      cache: 'no-store',
      signal
    })
    if (!current(generation, scope)) return
    frozen.receipt = receipt(raw, frozen)
    await readGroup(frozen, generation, signal)
  } catch (error) {
    failure(error, generation, scope)
  } finally {
    if (current(generation, scope)) {
      busy.value = false
      controller = null
    }
  }
}
async function recover() {
  const frozen = intent.value
  if (!usable.value || props.pending || busy.value || !frozen || authority.value !== frozen.scope) return
  const generation = ++epoch
  controller = new AbortController()
  const signal = controller.signal
  busy.value = true
  try {
    if (!frozen.receipt) {
      const raw = await request<unknown>(`${root}/commands/${frozen.key}`, {
        method: 'GET',
        query: { payloadHash: frozen.hash },
        retry: 0,
        cache: 'no-store',
        signal
      })
      if (!current(generation, frozen.scope)) return
      const command = adminOrderBulkCommandSchema.parse(raw)
      if (command.outcome === 'unknown') {
        uncertain.value = true
        return
      }
      frozen.receipt = receipt(command.receipt, frozen)
    }
    await readGroup(frozen, generation, signal)
  } catch (error) {
    failure(error, generation, frozen.scope)
  } finally {
    if (current(generation, frozen.scope)) {
      busy.value = false
      controller = null
    }
  }
}
</script>
<template>
  <section
    v-if="usable"
    aria-label="Preparación de pedidos seleccionados"
    :aria-busy="busy"
    class="min-w-0 space-y-3 rounded border p-4"
  >
    <h2 class="font-semibold">Preparación de pedidos seleccionados</h2>
    <p>
      {{ orderIds.length }} pedidos seleccionados de esta página, máximo 25. No cambia existencias ni cobros. Cada
      transición necesita autorización actual.
    </p>
    <label class="block"
      >Acción operativa<select v-model="action" data-batch-action :disabled="pending || busy || Boolean(intent)">
        <option value="">Selecciona una acción</option>
        <option v-for="value in fulfillmentActionSchema.options" :key="value" :value="value">
          {{ labels[value] }}
        </option>
      </select></label
    >
    <label class="block"
      >Motivo verificable<textarea
        v-model="reason"
        data-batch-reason
        maxlength="500"
        :disabled="pending || busy || Boolean(intent)"
        class="w-full rounded border p-2"
      />
    </label>
    <label class="block"
      >Evidencia operativa · obligatoria para reparto, entrega o incidencia<textarea
        v-model="evidence"
        data-batch-evidence
        maxlength="500"
        :disabled="pending || busy || Boolean(intent)"
        class="w-full rounded border p-2"
      />
    </label>
    <button data-batch-preview type="button" :disabled="pending || busy || Boolean(intent)" @click="preview">
      Revisar pedidos seleccionados
    </button>
    <p v-if="busy" role="status">Confirmando hechos operativos…</p>
    <p v-if="failed" data-batch-error role="alert">
      No se pudo confirmar la selección o los hechos actuales. No se interpreta como un lote vacío ni se ha confirmado
      su ejecución.
    </p>
    <div v-if="reviewed" data-batch-review class="space-y-3">
      <p>{{ reviewed.eligible }} elegibles · {{ reviewed.blocked }} excluidos. Las exclusiones no se ejecutarán.</p>
      <ul class="space-y-2">
        <li v-for="row in reviewed.rows" :key="row.orderId" class="break-words">
          <span class="break-all">{{ row.orderId }}</span> · Versión observada
          {{ row.currentVersion ?? 'no confirmada' }} ·
          {{ row.eligible ? 'Elegible' : (labels[row.reason ?? ''] ?? 'No autorizado') }} ·
          {{ row.state ? (labels[row.state] ?? row.state) : 'Estado no confirmado' }}
        </li>
      </ul>
      <label
        ><input
          v-model="consent"
          data-batch-consent
          type="checkbox"
          :disabled="pending || busy || Boolean(intent)"
        />Confirmo la acción y el motivo sobre los {{ reviewed.eligible }} pedidos elegibles mostrados; los excluidos no
        se intentarán.</label
      >
      <button
        data-batch-confirm
        type="button"
        :disabled="pending || busy || Boolean(intent) || !consent || !reviewed.eligible"
        @click="commit"
      >
        Confirmar preparación seleccionada
      </button>
    </div>
    <div v-if="intent" data-batch-uncertain role="status">
      {{ uncertain ? 'El resultado no está confirmado por completo.' : 'Confirmando la ejecución por pedido.' }} No se
      reenviará ningún POST automáticamente.<button
        data-batch-recover
        type="button"
        :disabled="pending || busy"
        @click="recover"
      >
        Consultar recibo y progreso mediante GET
      </button>
    </div>
    <section v-if="result" data-batch-results aria-label="Resultados por pedido" class="space-y-2">
      <p>
        {{ result.completed }} resultados terminales · {{ result.remaining }} pendientes de confirmar.
        {{
          result.status === 'completed'
            ? 'Grupo confirmado.'
            : 'Grupo pendiente o pausado; revisa los resultados inciertos antes de continuar.'
        }}
      </p>
      <ul class="space-y-2">
        <li v-for="row in result.rows" :key="row.orderId" class="break-words">
          <span class="break-all">{{ row.orderId }}</span> · {{ statuses[row.status]
          }}<template v-if="row.reason"> · {{ labels[row.reason] ?? row.reason }}</template
          ><template v-if="row.receipt"> · Versión confirmada {{ row.receipt.version }}</template>
        </li>
      </ul>
    </section>
  </section>
</template>
