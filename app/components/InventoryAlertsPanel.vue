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
const kindLabels = { low: 'Stock bajo', out_of_stock: 'Agotado', anomaly: 'Anomalía de inventario' }
const stateLabels = { open: 'Abierta', acknowledged: 'Reconocida', resolved: 'Resuelta por evaluación' }
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
    message.value = 'Comprueba los filtros: SKU o nombre de hasta 100 caracteres, sin controles.'
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
    message.value = 'Indica un ID de variante canónico positivo.'
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
    if (current(epoch)) message.value = 'Comprueba los datos de la operación. No se ha enviado nada.'
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
    message.value = 'Indica un umbral entero no negativo o vacío y un motivo de 10–500 caracteres.'
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
    message.value = 'Documenta un motivo de 10–500 caracteres.'
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
      ? 'Reconocimiento confirmado. No repara ni resuelve el stock.'
      : command.action === 'threshold'
        ? 'Umbral confirmado. No modifica el stock de seguridad ni las existencias.'
        : `Evaluación confirmada: ${receipt.processed} variantes, ${receipt.opened} abiertas y ${receipt.resolved} resueltas por hechos.`
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
        'Resultado no confirmado. Comprueba el recibo manualmente; no se enviará otro comando automáticamente.'
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
        'El resultado sigue sin confirmarse. Conservamos la misma intención; desconocido no significa que no se aplicara.'
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
  <section
    v-if="enabled"
    aria-label="Alertas operativas de inventario"
    class="min-w-0 space-y-4 rounded-2xl border border-slate-200 bg-white p-5"
  >
    <h2 class="text-xl font-semibold">Alertas de inventario</h2>
    <p>
      Umbrales operativos distintos del stock de seguridad. Reconocer una alerta no registra una recepción ni corrige
      existencias.
    </p>
    <form data-testid="alerts-filters" class="flex flex-wrap gap-3" @submit.prevent="applyFilters">
      <label
        >Estado<select v-model="filters.state" data-testid="alerts-state" :disabled="!idle() || loading">
          <option value="open">Abiertas</option>
          <option value="acknowledged">Reconocidas</option>
          <option value="resolved">Resueltas por evaluación</option>
          <option value="all">Todas</option>
        </select></label
      >
      <label
        >Tipo<select v-model="filters.kind" data-testid="alerts-kind" :disabled="!idle() || loading">
          <option value="">Todos</option>
          <option v-for="(label, kind) in kindLabels" :key="kind" :value="kind">{{ label }}</option>
        </select></label
      >
      <label class="min-w-0 flex-1"
        >SKU o nombre<input
          v-model="filters.q"
          data-testid="alerts-query"
          maxlength="100"
          class="w-full rounded border p-2"
          :disabled="!idle() || loading"
      /></label>
      <button type="submit" :disabled="!idle() || loading" class="rounded border p-2">Aplicar filtros</button>
    </form>
    <p v-if="loading" role="status">Confirmando alertas y hechos actuales…</p>
    <p v-if="readError" role="alert">No se ha confirmado la cola. Un error no significa que no haya alertas.</p>
    <button
      data-testid="alerts-refresh"
      type="button"
      :disabled="!idle() || loading || policyLoading"
      class="rounded border p-2"
      @click="readQueue()"
    >
      Actualizar cola
    </button>
    <div v-if="queue" class="space-y-3">
      <p>{{ queue.warehouse.name }} · Hechos observados: {{ queue.evaluatedAt }}</p>
      <p>
        Filtro aplicado: {{ applied.state === 'all' ? 'Todas' : stateLabels[applied.state] }} ·
        {{ applied.kind ? kindLabels[applied.kind] : 'Todos los tipos' }} · {{ applied.q || 'Sin búsqueda' }}
      </p>
      <p v-if="queue.lastEvaluationAt === null" role="status">
        Aún no evaluado. Una cola vacía no acredita que el inventario esté bien.
      </p>
      <p v-else>Última evaluación de episodios: {{ queue.lastEvaluationAt }}</p>
      <p v-if="!queue.items.length">No hay episodios en esta consulta confirmada.</p>
      <ul class="space-y-3">
        <li v-for="item in queue.items" :key="item.id" class="min-w-0 rounded border p-3">
          <p class="break-words font-semibold">{{ item.sku }} · {{ kindLabels[item.kind] }}</p>
          <p>{{ stateLabels[item.state] }} · Versión {{ item.version }}</p>
          <p>
            Disponibilidad vendible observada: {{ item.sellableQuantity ?? 'No confirmada' }} · Umbral:
            {{ item.threshold ?? 'Desactivado' }}
          </p>
          <p>
            Hecho actual: {{ item.currentKind ? kindLabels[item.currentKind] : 'Sin condición activa confirmada' }}. El
            episodio conserva su historial.
          </p>
          <div class="flex flex-wrap gap-3">
            <a :href="item.to" :aria-disabled="!idle() || loading" class="underline" @click.prevent="select(item)"
              >Ver existencias, recepción y conteo</a
            >
            <button
              :data-alert-policy="item.variantId"
              :disabled="!idle() || loading || policyLoading"
              class="rounded border p-2"
              @click="loadPolicy(item.variantId)"
            >
              Configurar umbral
            </button>
            <button
              v-if="queue.capabilities.inventoryWrite && item.state === 'open' && item.currentKind === item.kind"
              :data-alert-ack="item.id"
              :disabled="!idle() || loading || policyLoading"
              class="rounded border p-2"
              @click="chooseAck(item)"
            >
              Reconocer alerta
            </button>
          </div>
        </li>
      </ul>
      <nav aria-label="Páginas de alertas" class="flex flex-wrap items-center gap-3">
        <button data-testid="alerts-previous" :disabled="!idle() || loading || applied.page <= 1" @click="movePage(-1)">
          Anterior</button
        ><span>{{ queue.pagination.total }} episodios · Página {{ applied.page }} de {{ queue.pagination.pages }}</span
        ><button
          data-testid="alerts-next"
          :disabled="!idle() || loading || applied.page >= queue.pagination.pages"
          @click="movePage(1)"
        >
          Siguiente
        </button>
      </nav>
      <div v-if="queue.capabilities.inventoryWrite" class="flex flex-wrap gap-3">
        <button
          data-testid="alerts-evaluate"
          :disabled="!idle() || loading || policyLoading"
          class="rounded border p-2"
          @click="prepareEvaluation()"
        >
          Revisar evaluación de hasta 100 variantes
        </button>
        <button
          v-if="nextAfterVariantId !== null"
          data-testid="alerts-evaluate-next"
          :disabled="!idle() || loading || policyLoading"
          class="rounded border p-2"
          @click="prepareEvaluation(true)"
        >
          Revisar siguiente lote de evaluación
        </button>
      </div>
    </div>
    <button
      v-if="selectedVariantId !== undefined && !intent"
      data-testid="alerts-selected-policy"
      type="button"
      :disabled="!idle() || loading || policyLoading"
      class="rounded border p-2"
      @click="loadPolicy(selectedVariantId)"
    >
      Configurar umbral de la variante seleccionada
    </button>
    <details v-if="!intent">
      <summary class="cursor-pointer">Atajo por ID</summary>
      <form class="flex flex-wrap gap-3" @submit.prevent="loadPolicy()">
        <label
          >ID de variante para umbral<input
            v-model="variantText"
            data-testid="alerts-policy-variant"
            inputmode="numeric"
            :disabled="!idle() || loading || policyLoading"
            class="rounded border p-2" /></label
        ><button :disabled="!idle() || loading || policyLoading" class="rounded border p-2">Consultar umbral</button>
      </form>
    </details>
    <p v-if="policyLoading" role="status">Confirmando umbral vigente…</p>
    <p v-if="policyError" role="alert">No se ha confirmado el umbral. No se sustituye por cero.</p>
    <form
      v-if="policy && !intent"
      data-testid="alerts-threshold-form"
      class="space-y-3"
      @submit.prevent="prepareThreshold"
    >
      <p>
        Variante {{ policy.variantId }} · Política v{{ policy.version }}. Umbral actual:
        {{ policy.threshold ?? 'Desactivado' }}.
      </p>
      <template v-if="policy.capabilities.inventoryWrite"
        ><label class="block"
          >Umbral entero (vacío desactiva stock bajo/agotado)<input
            v-model="thresholdText"
            data-testid="alerts-threshold"
            inputmode="numeric"
            :disabled="!idle()"
            class="rounded border p-2" /></label
        ><label class="block"
          >Motivo<textarea
            v-model="reason"
            data-testid="alerts-threshold-reason"
            minlength="10"
            maxlength="500"
            :disabled="!idle()"
            class="w-full rounded border p-2"
          /></label
        ><button :disabled="!idle()" class="rounded border p-2">Revisar cambio de umbral</button></template
      >
    </form>
    <form v-if="ackTarget && !intent" data-testid="alerts-ack-form" class="space-y-3" @submit.prevent="prepareAck">
      <p>Reconocer {{ ackTarget.sku }} no repara el inventario ni resuelve la incidencia.</p>
      <label
        >Motivo<textarea
          v-model="reason"
          data-testid="alerts-ack-reason"
          minlength="10"
          maxlength="500"
          :disabled="!idle()"
          class="w-full rounded border p-2"
        /></label
      ><button :disabled="!idle()" class="rounded border p-2">Revisar reconocimiento</button>
    </form>
    <div v-if="intent" class="space-y-3 rounded border p-3">
      <p>
        Intención congelada:
        {{
          intent.action === 'ack'
            ? 'Reconocer alerta'
            : intent.action === 'threshold'
              ? 'Cambiar umbral'
              : 'Evaluar lote'
        }}
        · {{ intent.targetId }}. No cambia existencias ni envía correos.
      </p>
      <p v-if="intent.action === 'threshold'">
        Nuevo umbral: {{ intent.body.threshold ?? 'Desactivado' }}. El stock de seguridad permanece intacto.
      </p>
      <p v-if="intent.action === 'evaluate'">
        Máximo {{ intent.body.limit }} variantes;
        {{ intent.body.afterVariantId ? 'después de la variante ' + intent.body.afterVariantId : 'desde el inicio' }}.
        Los lotes siguientes requieren otra confirmación explícita.
      </p>
      <p v-if="intent.body.reason" class="break-words">Motivo: {{ intent.body.reason }}</p>
      <button
        v-if="!ambiguous"
        data-testid="alerts-confirm"
        :disabled="commandBusy || pending"
        class="rounded border p-2"
        @click="send()"
      >
        Confirmar operación</button
      ><template v-else
        ><button
          data-testid="alerts-recover"
          :disabled="commandBusy || pending"
          class="rounded border p-2"
          @click="recover"
        >
          Comprobar recibo</button
        ><button
          data-testid="alerts-replay"
          :disabled="commandBusy || pending"
          class="rounded border p-2"
          @click="send()"
        >
          Reintentar exactamente el mismo comando
        </button></template
      ><button
        v-if="!ambiguous"
        data-testid="alerts-cancel"
        :disabled="commandBusy || pending"
        class="rounded border p-2"
        @click="cancel"
      >
        Cancelar intento no enviado
      </button>
    </div>
    <p v-if="message" role="status" class="break-words">{{ message }}</p>
  </section>
</template>
