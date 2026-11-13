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
  version_conflict: 'El pedido ha cambiado mientras tanto',
  invalid_transition: 'Cambio de estado no permitido',
  order_cancelled: 'Pedido cancelado',
  payment_unconfirmed: 'Pago no confirmado',
  inventory_unconfirmed: 'Inventario no confirmado',
  warehouse_unavailable: 'Almacén no disponible',
  shipping_mode_unavailable: 'Entrega no disponible',
  history_unconfirmed: 'Historial no confirmado',
  unauthenticated: 'Sesión caducada',
  email_unverified: 'Correo no verificado',
  mfa_required: 'Falta la verificación en dos pasos',
  forbidden: 'Sin permiso',
  idempotency_conflict: 'Operación duplicada',
  shipping_mode_mismatch: 'Modo de entrega incompatible',
  conflict: 'No se puede aplicar ahora'
}
const statuses = {
  pending: 'Pendiente',
  unknown: 'Resultado incierto',
  applied: 'Confirmado',
  rejected: 'Rechazado',
  not_attempted: 'No intentado'
}
const resultTones = {
  pending: 'warning',
  unknown: 'warning',
  applied: 'success',
  rejected: 'danger',
  not_attempted: 'neutral'
} as const
const shortId = (id: string) => '#' + id.slice(0, 8).toUpperCase()
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
  <section v-if="usable" aria-label="Preparación de pedidos seleccionados" :aria-busy="busy" class="min-w-0 space-y-3">
    <h2 class="sr-only">Preparación de pedidos seleccionados</h2>
    <div class="adm-form-grid">
      <label class="adm-field"
        ><span class="adm-label">Cambiar estado a</span
        ><select
          v-model="action"
          data-batch-action
          class="adm-input w-full"
          :disabled="pending || busy || Boolean(intent)"
        >
          <option value="">Elige un estado</option>
          <option v-for="value in fulfillmentActionSchema.options" :key="value" :value="value">
            {{ labels[value] }}
          </option>
        </select></label
      >
      <label class="adm-field"
        ><span class="adm-label">Motivo</span
        ><textarea
          v-model="reason"
          data-batch-reason
          rows="2"
          maxlength="500"
          :disabled="pending || busy || Boolean(intent)"
          class="adm-input w-full"
        />
      </label>
      <label class="adm-field"
        ><span class="adm-label">Comprobante o detalle</span
        ><textarea
          v-model="evidence"
          data-batch-evidence
          rows="2"
          maxlength="500"
          :disabled="pending || busy || Boolean(intent)"
          class="adm-input w-full"
        />
        <span class="adm-help">Obligatorio para reparto, entrega o incidencia.</span>
      </label>
    </div>
    <div class="flex flex-wrap items-center gap-3">
      <button
        data-batch-preview
        type="button"
        class="adm-btn adm-btn--secondary"
        :disabled="pending || busy || Boolean(intent)"
        @click="preview"
      >
        Revisar pedidos seleccionados
      </button>
      <p class="adm-help">
        {{ orderIds.length }} {{ orderIds.length === 1 ? 'pedido' : 'pedidos' }} de esta página (máximo 25). No cambia
        existencias ni cobros.
      </p>
      <p v-if="busy" role="status" class="adm-help">Comprobando…</p>
    </div>
    <div v-if="failed" data-batch-error role="alert">
      <UAlert
        color="error"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        title="No se ha podido revisar la selección"
        description="No se ha cambiado ningún pedido. Vuelve a intentarlo."
      />
    </div>
    <div
      v-if="reviewed"
      data-batch-review
      class="space-y-3 rounded-[var(--radius-surface)] border border-[var(--border)] bg-[var(--surface)] p-4"
    >
      <p class="font-semibold text-[var(--text-strong)]">
        {{ reviewed.eligible }} elegibles · {{ reviewed.blocked }} excluidos
        <span class="font-normal text-[var(--text-muted)]">· los excluidos no se cambiarán</span>
      </p>
      <ul class="divide-y divide-[var(--border)]">
        <li v-for="row in reviewed.rows" :key="row.orderId" class="flex flex-wrap items-center gap-2 py-2">
          <span class="font-semibold tabular-nums text-[var(--text-strong)]" :title="row.orderId">{{
            shortId(row.orderId)
          }}</span>
          <AdminBadge :tone="row.eligible ? 'success' : 'warning'">{{
            row.eligible ? 'Elegible' : (labels[row.reason ?? ''] ?? 'No permitido')
          }}</AdminBadge>
          <span class="adm-help">{{
            row.state ? 'Ahora: ' + (labels[row.state] ?? adminStatusLabel(row.state)) : 'Estado actual desconocido'
          }}</span>
        </li>
      </ul>
      <label class="adm-check"
        ><input
          v-model="consent"
          data-batch-consent
          type="checkbox"
          :disabled="pending || busy || Boolean(intent)"
        />Confirmo el cambio en los {{ reviewed.eligible }} pedidos elegibles.</label
      >
      <div>
        <button
          data-batch-confirm
          type="button"
          class="adm-btn adm-btn--primary"
          :disabled="pending || busy || Boolean(intent) || !consent || !reviewed.eligible"
          @click="commit"
        >
          Aplicar a los pedidos elegibles
        </button>
      </div>
    </div>
    <div v-if="intent" data-batch-uncertain role="status">
      <UAlert
        color="warning"
        variant="subtle"
        icon="i-lucide-hourglass"
        :title="uncertain ? 'Todavía no sabemos si se ha aplicado a todos' : 'Aplicando el cambio pedido a pedido…'"
        description="No se volverá a enviar nada por su cuenta. Comprueba el resultado antes de seguir."
      />
      <button
        data-batch-recover
        type="button"
        class="adm-btn adm-btn--secondary mt-2"
        :disabled="pending || busy"
        @click="recover"
      >
        Comprobar resultado
      </button>
    </div>
    <section
      v-if="result"
      data-batch-results
      aria-label="Resultados por pedido"
      class="space-y-2 rounded-[var(--radius-surface)] border border-[var(--border)] bg-[var(--surface)] p-4"
    >
      <p class="font-semibold text-[var(--text-strong)]">
        {{ result.completed }} terminados · {{ result.remaining }} por confirmar
        <span class="font-normal text-[var(--text-muted)]">
          ·
          {{
            result.status === 'completed'
              ? 'Grupo completado.'
              : 'Aún hay pedidos sin confirmar: revísalos antes de continuar.'
          }}</span
        >
      </p>
      <ul class="divide-y divide-[var(--border)]">
        <li v-for="row in result.rows" :key="row.orderId" class="flex flex-wrap items-center gap-2 py-2">
          <span class="font-semibold tabular-nums text-[var(--text-strong)]" :title="row.orderId">{{
            shortId(row.orderId)
          }}</span>
          <AdminBadge :tone="resultTones[row.status]">{{ statuses[row.status] }}</AdminBadge>
          <span v-if="row.reason" class="adm-help">{{ labels[row.reason] ?? adminStatusLabel(row.reason) }}</span>
        </li>
      </ul>
    </section>
  </section>
</template>
