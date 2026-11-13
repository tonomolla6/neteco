<script setup lang="ts">
import {
  inventoryAlertsQuerySchema,
  inventoryAlertsResponseSchema,
  inventoryAlertPolicyResponseSchema,
  inventoryAlertThresholdInputSchema,
  inventoryAlertAckInputSchema,
  inventoryAlertEvaluationInputSchema,
  inventoryAlertCommandReceiptSchema,
  inventoryAlertCommandResponseSchema,
  inventoryAlertIntentHash,
  type InventoryAlertAction,
  type InventoryAlertsResponse,
  type InventoryAlertPolicyResponse,
  type InventoryAlertCommandReceipt
} from '~~/shared/inventory-alerts'
import { inventoryLegacyIdSchema } from '~~/shared/inventory-commands'

const props = defineProps<{ scopeKey: string; enabled: boolean; pending: boolean; selectedVariantId?: number }>()
const emit = defineEmits<{
  pending: [value: boolean]
  confirmed: [receipt: InventoryAlertCommandReceipt]
  selectVariant: [variantId: number]
}>()
const kindLabels = { low: 'Stock bajo', out_of_stock: 'Agotado', anomaly: 'Descuadre de inventario' }
const kindTones = { low: 'warning', out_of_stock: 'danger', anomaly: 'info' } as const
const stateLabels = { open: 'Abierta', acknowledged: 'Revisada', resolved: 'Resuelta' }
const stateTones = { open: 'warning', acknowledged: 'neutral', resolved: 'success' } as const
const filters = reactive({ state: 'open', kind: '', q: '' })
type Query = ReturnType<typeof inventoryAlertsQuerySchema.parse>
const initialQuery = () => inventoryAlertsQuerySchema.parse({})
const applied = shallowRef<Query>(initialQuery())
const queue = shallowRef<InventoryAlertsResponse | null>(null)
const policy = shallowRef<InventoryAlertPolicyResponse | null>(null)
const loading = ref(false),
  readError = ref(false),
  policyLoading = ref(false),
  policyError = ref(false)
const variantText = ref(''),
  thresholdText = ref(''),
  reason = ref(''),
  message = ref('')
const ackTarget = shallowRef<InventoryAlertsResponse['items'][number] | null>(null)
const commandBusy = ref(false),
  ambiguous = ref(false)
const nextAfterVariantId = ref<number | null>(null)
type Intent = Readonly<{
  action: InventoryAlertAction
  targetId: string
  body: Readonly<Record<string, unknown>>
  key: string
  hash: string
  path: string
}>
const intent = shallowRef<Intent | null>(null)
let active = true,
  generation = 0
const controllers = new Set<AbortController>()
const permitted = () => active && props.enabled && !!props.scopeKey
const idle = () => permitted() && !props.pending && !commandBusy.value && !intent.value
function current(epoch: number) {
  return permitted() && generation === epoch
}
function purge() {
  generation++
  for (const controller of controllers) controller.abort()
  controllers.clear()
  queue.value = policy.value = null
  intent.value = ackTarget.value = null
  loading.value = policyLoading.value = commandBusy.value = ambiguous.value = false
  readError.value = policyError.value = false
  variantText.value = thresholdText.value = reason.value = message.value = ''
  filters.state = 'open'
  filters.kind = filters.q = ''
  applied.value = initialQuery()
  nextAfterVariantId.value = null
}
async function request(path: string, options: Record<string, unknown> = {}): Promise<unknown> {
  const controller = new AbortController()
  controllers.add(controller)
  try {
    return await $fetch<unknown>(path, { ...options, retry: 0, cache: 'no-store', signal: controller.signal })
  } finally {
    controllers.delete(controller)
  }
}
async function getQueue(query: Query, epoch: number) {
  const parsed = inventoryAlertsResponseSchema.safeParse(await request('/api/admin/inventory/alerts', { query }))
  if (
    !current(epoch) ||
    !parsed.success ||
    parsed.data.pagination.page !== query.page ||
    parsed.data.pagination.perPage !== query.perPage
  )
    throw new Error('unconfirmed_inventory_alerts')
  return parsed.data
}
async function readQueue(query = applied.value) {
  if (!idle() || loading.value || policyLoading.value) return
  const epoch = generation
  loading.value = true
  readError.value = false
  queue.value = null
  applied.value = query
  try {
    const result = await getQueue(query, epoch)
    if (current(epoch)) queue.value = result
  } catch {
    if (current(epoch)) readError.value = true
  } finally {
    if (current(epoch)) loading.value = false
  }
}
function applyFilters() {
  const parsed = inventoryAlertsQuerySchema.safeParse({
    state: filters.state,
    ...(filters.kind ? { kind: filters.kind } : {}),
    q: filters.q,
    page: 1,
    perPage: 25
  })
  if (!parsed.success) {
    message.value = 'Revisa la búsqueda: admite hasta 100 caracteres del nombre o de la referencia.'
    return
  }
  void readQueue(parsed.data)
}
function movePage(delta: number) {
  const data = queue.value
  if (!data || applied.value.page + delta < 1 || applied.value.page + delta > data.pagination.pages) return
  void readQueue({ ...applied.value, page: applied.value.page + delta })
}
async function getPolicy(id: number, epoch: number) {
  const parsed = inventoryAlertPolicyResponseSchema.safeParse(
    await request(`/api/admin/inventory/variants/${id}/alert-policy`)
  )
  if (!current(epoch) || !parsed.success || parsed.data.variantId !== id)
    throw new Error('unconfirmed_inventory_policy')
  return parsed.data
}
async function loadPolicy(id?: number) {
  if (!idle() || loading.value || policyLoading.value) return
  const parsed = inventoryLegacyIdSchema.safeParse(id === undefined ? variantText.value : String(id))
  if (!parsed.success) {
    message.value = 'Escribe el número interno del producto, solo cifras.'
    return
  }
  const epoch = generation
  policyLoading.value = true
  policyError.value = false
  policy.value = null
  ackTarget.value = null
  reason.value = ''
  try {
    const result = await getPolicy(Number(parsed.data), epoch)
    if (current(epoch)) {
      policy.value = result
      variantText.value = String(result.variantId)
      thresholdText.value = result.threshold === null ? '' : String(result.threshold)
    }
  } catch {
    if (current(epoch)) policyError.value = true
  } finally {
    if (current(epoch)) policyLoading.value = false
  }
}
async function prepare(action: InventoryAlertAction, targetId: string, body: Record<string, unknown>) {
  if (!idle() || loading.value || policyLoading.value) return
  const epoch = generation
  commandBusy.value = true
  message.value = ''
  try {
    const hash = await inventoryAlertIntentHash(action, targetId, body)
    if (!current(epoch) || props.pending) return
    intent.value = Object.freeze({
      action,
      targetId,
      body: Object.freeze({ ...body }),
      key: crypto.randomUUID(),
      hash,
      path:
        action === 'threshold'
          ? `/api/admin/inventory/variants/${targetId}/alert-policy`
          : action === 'ack'
            ? `/api/admin/inventory/alerts/${targetId}/ack`
            : '/api/admin/inventory/alerts/evaluate'
    })
    ambiguous.value = false
  } catch {
    if (current(epoch)) message.value = 'Revisa los datos. No se ha enviado nada.'
  } finally {
    if (current(epoch)) commandBusy.value = false
  }
}
function prepareThreshold() {
  const data = policy.value
  if (!data?.capabilities.inventoryWrite) return
  const threshold =
    thresholdText.value === ''
      ? null
      : /^(0|[1-9][0-9]*)$/.test(thresholdText.value)
        ? Number(thresholdText.value)
        : NaN
  const parsed = inventoryAlertThresholdInputSchema.safeParse({
    expectedVersion: data.version,
    threshold,
    reason: reason.value
  })
  if (!parsed.success) {
    message.value = 'Escribe un número entero (o déjalo vacío) y un motivo de entre 10 y 500 caracteres.'
    return
  }
  void prepare('threshold', String(data.variantId), parsed.data)
}
function chooseAck(item: InventoryAlertsResponse['items'][number]) {
  if (!idle() || !queue.value?.capabilities.inventoryWrite || item.state !== 'open' || item.currentKind !== item.kind)
    return
  ackTarget.value = item
  policy.value = null
  reason.value = ''
  message.value = ''
}
function prepareAck() {
  if (!ackTarget.value || !queue.value?.capabilities.inventoryWrite) return
  const parsed = inventoryAlertAckInputSchema.safeParse({
    expectedVersion: ackTarget.value.version,
    reason: reason.value
  })
  if (!parsed.success) {
    message.value = 'Escribe un motivo de entre 10 y 500 caracteres.'
    return
  }
  void prepare('ack', ackTarget.value.id, parsed.data)
}
function prepareEvaluation(next = false) {
  if (!queue.value?.capabilities.inventoryWrite) return
  const body = inventoryAlertEvaluationInputSchema.parse({
    limit: 100,
    ...(next && nextAfterVariantId.value !== null ? { afterVariantId: nextAfterVariantId.value } : {})
  })
  void prepare('evaluate', 'warehouse', body)
}
function matchingReceipt(raw: unknown, command: Intent) {
  const parsed = inventoryAlertCommandReceiptSchema.safeParse(raw)
  if (
    !parsed.success ||
    parsed.data.commandId !== command.key ||
    parsed.data.action !== command.action ||
    parsed.data.targetId !== command.targetId ||
    parsed.data.payloadHash !== command.hash ||
    (command.action !== 'evaluate' && parsed.data.version !== Number(command.body.expectedVersion) + 1)
  )
    throw new Error('unconfirmed_inventory_receipt')
  return parsed.data
}
async function confirmReceipt(receipt: InventoryAlertCommandReceipt, command: Intent, epoch: number) {
  if (command.action === 'threshold') {
    const fresh = await getPolicy(Number(command.targetId), epoch)
    if (
      fresh.version < receipt.version! ||
      (fresh.version === receipt.version && fresh.threshold !== command.body.threshold)
    )
      throw new Error('unconfirmed_inventory_policy')
    policy.value = fresh
    thresholdText.value = fresh.threshold === null ? '' : String(fresh.threshold)
  } else if (command.action === 'ack') {
    const fresh = await getQueue(
      inventoryAlertsQuerySchema.parse({ state: 'all', alertId: command.targetId, page: 1, perPage: 25 }),
      epoch
    )
    const item = fresh.items.find((entry) => entry.id === command.targetId)
    if (!item || item.version < receipt.version! || (item.version === receipt.version && item.state !== 'acknowledged'))
      throw new Error('unconfirmed_inventory_ack')
  } else {
    const fresh = await getQueue(applied.value, epoch)
    if (receipt.processed > 0 && fresh.lastEvaluationAt === null) throw new Error('unconfirmed_inventory_evaluation')
    queue.value = fresh
    nextAfterVariantId.value = receipt.nextAfterVariantId
  }
  if (!current(epoch) || intent.value !== command) return
  intent.value = null
  ambiguous.value = false
  reason.value = ''
  ackTarget.value = null
  message.value =
    command.action === 'ack'
      ? 'Alerta marcada como revisada. No repara ni resuelve el stock.'
      : command.action === 'threshold'
        ? 'Aviso guardado. No modifica el stock de seguridad ni las existencias.'
        : `Inventario revisado: ${receipt.processed} productos, ${receipt.opened} alertas nuevas y ${receipt.resolved} resueltas.`
  emit('confirmed', receipt)
  if (command.action !== 'evaluate') {
    try {
      queue.value = await getQueue(applied.value, epoch)
      readError.value = false
    } catch {
      if (current(epoch)) {
        queue.value = null
        readError.value = true
      }
    }
  }
}
async function send() {
  const command = intent.value
  if (!command || !permitted() || props.pending || commandBusy.value) return
  const epoch = generation
  commandBusy.value = true
  ambiguous.value = true
  message.value = ''
  try {
    const raw = await request(command.path, {
      method: command.action === 'threshold' ? 'PUT' : 'POST',
      headers: { 'Idempotency-Key': command.key },
      body: command.body
    })
    if (!current(epoch) || intent.value !== command) return
    await confirmReceipt(matchingReceipt(raw, command), command, epoch)
  } catch {
    if (current(epoch))
      message.value =
        'No sabemos si el cambio se ha guardado. Pulsa «Comprobar si se guardó»; no se reenviará nada automáticamente.'
  } finally {
    if (current(epoch)) commandBusy.value = false
  }
}
async function recover() {
  const command = intent.value
  if (!command || !permitted() || props.pending || commandBusy.value) return
  const epoch = generation
  commandBusy.value = true
  message.value = ''
  try {
    const raw = await request(`/api/admin/inventory/alerts/commands/${command.key}`, {
      headers: { 'X-Neteco-Command-Payload-Hash': command.hash }
    })
    if (!current(epoch) || intent.value !== command) return
    const parsed = inventoryAlertCommandResponseSchema.safeParse(raw)
    if (!parsed.success || parsed.data.outcome === 'unknown') throw new Error('unknown_inventory_command')
    await confirmReceipt(matchingReceipt(parsed.data.receipt, command), command, epoch)
  } catch {
    if (current(epoch))
      message.value =
        'Seguimos sin poder confirmarlo. Conservamos el mismo cambio: desconocido no significa que no se aplicara.'
  } finally {
    if (current(epoch)) commandBusy.value = false
  }
}
function cancel() {
  if (!commandBusy.value && !ambiguous.value) intent.value = null
}
function select(item: InventoryAlertsResponse['items'][number]) {
  if (idle() && !loading.value && !policyLoading.value) emit('selectVariant', item.variantId)
}
watch(
  intent,
  (value) => {
    if (active) emit('pending', value !== null)
  },
  { flush: 'sync' }
)
watch(
  () => [props.scopeKey, props.enabled],
  () => {
    purge()
    if (permitted() && !props.pending) void readQueue()
  },
  { immediate: true, flush: 'sync' }
)
watch(
  () => props.pending,
  (pending) => {
    if (!pending && permitted() && !queue.value && !readError.value) void readQueue()
  }
)
onBeforeUnmount(() => {
  purge()
  active = false
  emit('pending', false)
})
</script>

<template>
  <section v-if="enabled" aria-label="Alertas operativas de inventario" class="adm-stack min-w-0">
    <UAlert
      v-if="message"
      role="status"
      color="neutral"
      variant="subtle"
      icon="i-lucide-info"
      :title="message"
      class="break-words"
    />
    <UAlert
      v-if="policyError"
      role="alert"
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      title="No hemos podido cargar el aviso de este producto"
      description="No se ha cambiado nada. Vuelve a intentarlo."
    />

    <AdminCard v-if="intent" title="Confirmar el cambio">
      <div class="adm-stack">
        <p>
          <span class="font-semibold text-[var(--text-strong)]">
            {{
              intent.action === 'ack'
                ? 'Marcar la alerta como revisada'
                : intent.action === 'threshold'
                  ? 'Cambiar el aviso de stock bajo'
                  : 'Revisar el inventario'
            }}.
          </span>
          No cambia las existencias ni envía correos.
        </p>
        <p v-if="intent.action === 'threshold'">
          Nuevo umbral: {{ intent.body.threshold ?? 'Desactivado' }}. El stock mínimo del producto no cambia.
        </p>
        <p v-if="intent.action === 'evaluate'">
          Se revisan como máximo {{ intent.body.limit }} productos,
          {{
            intent.body.afterVariantId ? 'después de la variante ' + intent.body.afterVariantId : 'desde el principio'
          }}. Para seguir con los siguientes habrá que confirmarlo otra vez.
        </p>
        <p v-if="intent.body.reason" class="break-words">Motivo: {{ intent.body.reason }}</p>
      </div>
      <template #footer>
        <button
          v-if="!ambiguous"
          type="button"
          data-testid="alerts-cancel"
          class="adm-btn adm-btn--secondary"
          :disabled="commandBusy || pending"
          @click="cancel"
        >
          Cancelar
        </button>
        <button
          v-if="!ambiguous"
          type="button"
          data-testid="alerts-confirm"
          class="adm-btn adm-btn--primary"
          :disabled="commandBusy || pending"
          @click="send()"
        >
          Confirmar
        </button>
        <template v-else>
          <button
            type="button"
            data-testid="alerts-recover"
            class="adm-btn adm-btn--secondary"
            :disabled="commandBusy || pending"
            @click="recover"
          >
            Comprobar si se guardó
          </button>
          <button
            type="button"
            data-testid="alerts-replay"
            class="adm-btn adm-btn--secondary"
            :disabled="commandBusy || pending"
            @click="send()"
          >
            Reintentar el mismo cambio
          </button>
        </template>
      </template>
    </AdminCard>

    <AdminCard
      v-if="policy && !intent"
      title="Aviso de stock bajo"
      :description="`Producto n.º ${policy.variantId}. Ahora avisa por debajo de: ${policy.threshold ?? 'desactivado'}.`"
    >
      <form
        id="alerts-threshold-form"
        data-testid="alerts-threshold-form"
        class="adm-stack"
        @submit.prevent="prepareThreshold"
      >
        <template v-if="policy.capabilities.inventoryWrite">
          <label class="adm-field">
            <span class="adm-label">Avisar cuando queden menos de (unidades)</span>
            <input
              v-model="thresholdText"
              data-testid="alerts-threshold"
              inputmode="numeric"
              class="max-w-40"
              :disabled="!idle()"
            />
            <span class="adm-help">Déjalo vacío para no recibir avisos de stock bajo ni de agotado.</span>
          </label>
          <label class="adm-field">
            <span class="adm-label">Motivo del cambio</span>
            <textarea
              v-model="reason"
              data-testid="alerts-threshold-reason"
              minlength="10"
              maxlength="500"
              :disabled="!idle()"
            />
          </label>
        </template>
        <p v-else class="adm-help">No tienes permiso para cambiar este aviso.</p>
      </form>
      <template #footer>
        <AdminButton :disabled="!idle()" @click="policy = null">Cancelar</AdminButton>
        <button
          v-if="policy.capabilities.inventoryWrite"
          type="submit"
          form="alerts-threshold-form"
          class="adm-btn adm-btn--primary"
          :disabled="!idle()"
        >
          Revisar cambio
        </button>
      </template>
    </AdminCard>

    <AdminCard
      v-if="ackTarget && !intent"
      :title="`Marcar como revisada: ${ackTarget.sku}`"
      description="Solo deja constancia de que la has visto. No repara el inventario ni resuelve la incidencia."
    >
      <form id="alerts-ack-form" data-testid="alerts-ack-form" class="adm-stack" @submit.prevent="prepareAck">
        <label class="adm-field">
          <span class="adm-label">Motivo</span>
          <textarea
            v-model="reason"
            data-testid="alerts-ack-reason"
            minlength="10"
            maxlength="500"
            :disabled="!idle()"
          />
        </label>
      </form>
      <template #footer>
        <AdminButton :disabled="!idle()" @click="ackTarget = null">Cancelar</AdminButton>
        <button type="submit" form="alerts-ack-form" class="adm-btn adm-btn--primary" :disabled="!idle()">
          Revisar
        </button>
      </template>
    </AdminCard>

    <div class="adm-card adm-tablecard">
      <div class="adm-tablecard__bar">
        <form data-testid="alerts-filters" class="adm-toolbar" role="search" @submit.prevent="applyFilters">
          <label class="adm-toolbar__search">
            <span class="sr-only">Buscar por nombre o referencia</span>
            <UIcon name="i-lucide-search" class="size-4" />
            <input
              v-model="filters.q"
              type="search"
              data-testid="alerts-query"
              data-slot="adm-search"
              maxlength="100"
              placeholder="Buscar por nombre o referencia"
              :disabled="!idle() || loading"
            />
          </label>
          <select
            v-model="filters.state"
            data-testid="alerts-state"
            aria-label="Estado"
            :disabled="!idle() || loading"
            @change="applyFilters"
          >
            <option value="open">Abiertas</option>
            <option value="acknowledged">Revisadas</option>
            <option value="resolved">Resueltas</option>
            <option value="all">Todas</option>
          </select>
          <select
            v-model="filters.kind"
            data-testid="alerts-kind"
            aria-label="Tipo de alerta"
            :disabled="!idle() || loading"
            @change="applyFilters"
          >
            <option value="">Todos los tipos</option>
            <option v-for="(label, kind) in kindLabels" :key="kind" :value="kind">{{ label }}</option>
          </select>
          <div class="adm-toolbar__end">
            <button
              data-testid="alerts-refresh"
              type="button"
              class="adm-btn adm-btn--secondary"
              :disabled="!idle() || loading || policyLoading"
              @click="readQueue()"
            >
              <UIcon name="i-lucide-rotate-cw" class="size-4" />Actualizar
            </button>
            <template v-if="queue?.capabilities.inventoryWrite">
              <button
                type="button"
                data-testid="alerts-evaluate"
                class="adm-btn adm-btn--secondary"
                title="Comprueba hasta 100 productos y abre o cierra alertas según su stock"
                :disabled="!idle() || loading || policyLoading"
                @click="prepareEvaluation()"
              >
                Revisar inventario
              </button>
              <button
                v-if="nextAfterVariantId !== null"
                type="button"
                data-testid="alerts-evaluate-next"
                class="adm-btn adm-btn--secondary"
                :disabled="!idle() || loading || policyLoading"
                @click="prepareEvaluation(true)"
              >
                Revisar los 100 siguientes
              </button>
            </template>
          </div>
        </form>
      </div>

      <div v-if="loading" class="adm-table-skeleton" aria-busy="true" role="status">
        <span class="sr-only">Cargando alertas…</span>
        <div v-for="row in 4" :key="row"><i /><i /><i /><i /></div>
      </div>
      <div v-else-if="readError" role="alert">
        <AdminEmptyState
          variant="error"
          title="No hemos podido cargar las alertas"
          description="Un error no significa que no haya alertas. Vuelve a intentarlo."
        >
          <AdminButton icon="i-lucide-rotate-cw" :disabled="!idle() || policyLoading" @click="readQueue()">
            Reintentar
          </AdminButton>
        </AdminEmptyState>
      </div>
      <template v-else-if="queue">
        <p v-if="queue.lastEvaluationAt === null" role="status" class="adm-help px-4 pt-3">
          Aún no evaluado: todavía no se ha revisado el inventario, así que una lista vacía no garantiza que todo esté
          bien. Pulsa «Revisar inventario».
        </p>
        <AdminEmptyState
          v-if="!queue.items.length"
          icon="i-lucide-bell-off"
          :variant="applied.q || applied.kind || applied.state !== 'open' ? 'filtered' : 'empty'"
          :title="
            applied.q || applied.kind || applied.state !== 'open'
              ? 'Ninguna alerta con estos filtros'
              : 'No hay alertas abiertas'
          "
          description="Cuando un producto baje de su aviso de stock o se agote, aparecerá aquí."
        />
        <div v-else class="adm-table-wrap">
          <table class="adm-table">
            <caption class="sr-only">
              Alertas de inventario
            </caption>
            <thead>
              <tr>
                <th scope="col">Referencia</th>
                <th scope="col">Alerta</th>
                <th scope="col">Estado</th>
                <th scope="col" data-numeric>Disponible</th>
                <th scope="col" data-numeric>Avisa por debajo de</th>
                <th scope="col" data-numeric><span class="sr-only">Acciones</span></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in queue.items" :key="item.id">
                <td class="break-words font-semibold text-[var(--text-strong)]">
                  <a :href="item.to" :aria-disabled="!idle() || loading" @click.prevent="select(item)">{{
                    item.sku
                  }}</a>
                </td>
                <td>
                  <AdminBadge :tone="kindTones[item.kind]">{{ kindLabels[item.kind] }}</AdminBadge>
                  <p v-if="item.currentKind !== item.kind" class="adm-help">
                    Ahora: {{ item.currentKind ? kindLabels[item.currentKind] : 'sin incidencia' }}
                  </p>
                </td>
                <td>
                  <AdminBadge :tone="stateTones[item.state]" plain>{{ stateLabels[item.state] }}</AdminBadge>
                </td>
                <td data-numeric>{{ item.sellableQuantity ?? 'Sin dato' }}</td>
                <td data-numeric>{{ item.threshold ?? 'Desactivado' }}</td>
                <td data-numeric class="adm-table__actions">
                  <button
                    type="button"
                    class="adm-btn adm-btn--ghost adm-btn--sm"
                    :data-alert-policy="item.variantId"
                    :disabled="!idle() || loading || policyLoading"
                    @click="loadPolicy(item.variantId)"
                  >
                    Cambiar aviso
                  </button>
                  <button
                    v-if="queue.capabilities.inventoryWrite && item.state === 'open' && item.currentKind === item.kind"
                    type="button"
                    class="adm-btn adm-btn--secondary adm-btn--sm"
                    :data-alert-ack="item.id"
                    :disabled="!idle() || loading || policyLoading"
                    @click="chooseAck(item)"
                  >
                    Marcar como revisada
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <nav aria-label="Páginas de alertas" class="adm-pagination">
          <p>
            {{ queue.pagination.total }} {{ queue.pagination.total === 1 ? 'alerta' : 'alertas' }}
            <template v-if="queue.lastEvaluationAt">
              · última revisión {{ adminDate(queue.lastEvaluationAt, true) }}</template
            >
          </p>
          <div class="flex items-center gap-2">
            <button
              type="button"
              data-testid="alerts-previous"
              class="adm-btn adm-btn--secondary adm-btn--sm"
              :disabled="!idle() || loading || applied.page <= 1"
              @click="movePage(-1)"
            >
              Anterior
            </button>
            <span class="tabular-nums">Página {{ applied.page }} de {{ queue.pagination.pages || 1 }}</span>
            <button
              type="button"
              data-testid="alerts-next"
              class="adm-btn adm-btn--secondary adm-btn--sm"
              :disabled="!idle() || loading || applied.page >= queue.pagination.pages"
              @click="movePage(1)"
            >
              Siguiente
            </button>
          </div>
        </nav>
      </template>
    </div>

    <div v-if="!intent" class="flex flex-wrap items-start gap-x-6 gap-y-3">
      <button
        v-if="selectedVariantId !== undefined"
        data-testid="alerts-selected-policy"
        type="button"
        class="adm-btn adm-btn--secondary adm-btn--sm"
        :disabled="!idle() || loading || policyLoading"
        @click="loadPolicy(selectedVariantId)"
      >
        Cambiar el aviso del último producto consultado
      </button>
      <details class="adm-help">
        <summary class="cursor-pointer">Cambiar el aviso de otro producto por su número interno</summary>
        <form class="adm-toolbar mt-3" @submit.prevent="loadPolicy()">
          <input
            v-model="variantText"
            data-testid="alerts-policy-variant"
            aria-label="Número interno del producto"
            inputmode="numeric"
            placeholder="Ej. 101"
            :disabled="!idle() || loading || policyLoading"
          />
          <button type="submit" class="adm-btn adm-btn--secondary" :disabled="!idle() || loading || policyLoading">
            Ver aviso
          </button>
        </form>
      </details>
      <p v-if="policyLoading" role="status" class="adm-help">Cargando el aviso…</p>
    </div>
  </section>
</template>
