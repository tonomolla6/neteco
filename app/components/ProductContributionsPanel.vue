<script setup lang="ts">
import { z } from 'zod'
import {
  productContributionSubmitInputSchema,
  productContributionReplyInputSchema,
  productContributionModerationInputSchema,
  productContributionListSchema,
  publicProductContributionListSchema,
  productContributionSnapshotSchema,
  productContributionReceiptSchema,
  productContributionCommandSchema,
  productContributionIntentHash,
  type ProductContributionSnapshot,
  type ProductContributionReceipt,
  type PublicProductContributionList
} from '~~/shared/product-contributions'
const props = withDefaults(
  defineProps<{
    productId?: number
    scopeKey: string
    enabled: boolean
    customerEnabled?: boolean
    pending?: boolean
    audience?: 'customer' | 'admin'
  }>(),
  { audience: 'customer', productId: undefined }
)
const emit = defineEmits<{ pending: [value: boolean] }>()
const request = useRequestFetch()
const published = ref<PublicProductContributionList | null>(null),
  items = ref<ProductContributionSnapshot[]>([])
const page = ref(1),
  pages = ref(0),
  publicPage = ref(1),
  publicPages = ref(0)
const kind = ref<'review' | 'question'>('question'),
  title = ref(''),
  body = ref(''),
  score = ref(5),
  privacy = ref(false)
const orderId = ref(''),
  orders = ref<Array<{ id: string; createdAt: string }>>([])
const selected = ref<ProductContributionSnapshot | null>(null),
  action = ref<'publish' | 'answer' | 'close' | 'withdraw'>('publish')
const answer = ref(''),
  reply = ref(''),
  reason = ref(''),
  reference = ref(''),
  dueAt = ref('')
const loading = ref(false),
  preparing = ref(false),
  pendingLocal = ref(false),
  revoked = ref(false),
  message = ref(''),
  sent = ref(false),
  secondFactorRejected = ref(false)
type Intent = {
  action: ProductContributionReceipt['action']
  target: string | null
  key: string
  hash: string
  body:
    | z.infer<typeof productContributionSubmitInputSchema>
    | z.infer<typeof productContributionReplyInputSchema>
    | z.infer<typeof productContributionModerationInputSchema>
  expectedVersion: number
}
const intent = shallowRef<Intent | null>(null)
const reviewedFields = computed(() => {
  if (!intent.value) return []
  const value = intent.value.body as Record<string, unknown>
  return [
    ['title', 'Título'],
    ['body', 'Contenido'],
    ['score', 'Valoración'],
    ['reason', 'Motivo'],
    ['reviewReference', 'Referencia de la revisión'],
    ['slaDueAt', 'Fecha de seguimiento (UTC)']
  ].flatMap(([key, label]) =>
    typeof value[key!] === 'string' || typeof value[key!] === 'number'
      ? [{ label: label!, value: String(value[key!]) }]
      : []
  )
})
let epoch = 0,
  alive = true,
  controller: AbortController | null = null
const active = computed(() => props.enabled && !revoked.value)
// Booleano aparte: `audience === 'admin'` en el v-if estrecha el tipo en la rama de cliente.
const adminView = computed<boolean>(() => props.audience === 'admin')
const privateEnabled = computed(() => active.value && (props.audience === 'admin' || props.customerEnabled === true))
const busy = computed(() => loading.value || preparing.value || pendingLocal.value || props.pending === true)
const base = computed(() => `/api/${props.audience === 'admin' ? 'admin' : 'account'}/product-contributions`)
const confirmedProduct = computed(() => Number.isSafeInteger(props.productId) && Number(props.productId) > 0)
function setPending(value: boolean) {
  pendingLocal.value = value
  emit('pending', value)
}
function purge() {
  epoch++
  controller?.abort()
  controller = null
  published.value = null
  items.value = []
  orders.value = []
  selected.value = null
  title.value = ''
  body.value = ''
  privacy.value = false
  orderId.value = ''
  answer.value = ''
  reply.value = ''
  reason.value = ''
  reference.value = ''
  dueAt.value = ''
  intent.value = null
  sent.value = false
  preparing.value = false
  loading.value = false
  pages.value = 0
  publicPages.value = 0
  message.value = ''
  setPending(false)
}
watch(
  () => [props.scopeKey, props.enabled, props.customerEnabled, props.productId, props.audience],
  () => {
    purge()
    revoked.value = false
    secondFactorRejected.value = false
  },
  { flush: 'sync' }
)
onBeforeUnmount(() => {
  alive = false
  purge()
})
function current(generation: number) {
  return alive && generation === epoch && active.value
}
function signal() {
  controller?.abort()
  controller = new AbortController()
  return controller.signal
}
function status(error: unknown) {
  const e = error as { statusCode?: number; status?: number; response?: { status?: number } }
  return e?.statusCode ?? e?.status ?? e?.response?.status
}
function failure(error: unknown, generation: number, ambiguous = false) {
  if (!current(generation)) return
  if ([401, 403].includes(Number(status(error)))) {
    purge()
    revoked.value = true
    secondFactorRejected.value =
      (error as { data?: { error?: { code?: unknown } } } | null)?.data?.error?.code === 'mfa_required'
    message.value = 'La autorización ha cambiado. No se conserva contenido privado.'
    return
  }
  message.value = ambiguous
    ? 'Resultado incierto. Comprueba el recibo antes de continuar.'
    : 'No se ha podido confirmar la consulta. No se muestran datos anteriores.'
}
async function loadPublic(targetPage = 1) {
  if (!active.value || !confirmedProduct.value || busy.value) return
  const generation = epoch
  loading.value = true
  published.value = null
  message.value = ''
  try {
    const dto = publicProductContributionListSchema.parse(
      await request(`/api/products/${props.productId}/contributions`, {
        query: { page: targetPage, perPage: 25 },
        signal: signal()
      })
    )
    if (dto.productId !== props.productId) throw new Error('identity')
    if (current(generation)) {
      published.value = dto
      publicPage.value = dto.page
      publicPages.value = dto.pages
    }
  } catch (error) {
    failure(error, generation)
  } finally {
    if (current(generation)) loading.value = false
  }
}
async function privateList(targetPage = 1, generation = epoch) {
  const dto = productContributionListSchema.parse(
    await request(base.value, { query: { page: targetPage, perPage: 25 }, signal: controller?.signal })
  )
  if (current(generation)) {
    items.value = dto.items
    page.value = dto.page
    pages.value = dto.pages
  }
  return dto
}
async function loadPrivate(targetPage = 1) {
  if (!privateEnabled.value || busy.value) return
  const generation = epoch
  loading.value = true
  items.value = []
  message.value = ''
  signal()
  try {
    await privateList(targetPage, generation)
  } catch (error) {
    failure(error, generation)
  } finally {
    if (current(generation)) loading.value = false
  }
}
async function loadOrders() {
  if (!privateEnabled.value || props.audience !== 'customer' || busy.value) return
  const generation = epoch
  loading.value = true
  orders.value = []
  message.value = ''
  try {
    const dto = z
      .object({ orders: z.array(z.object({ id: z.string().uuid(), createdAt: z.string() }).passthrough()).max(200) })
      .passthrough()
      .parse(await request('/api/orders', { signal: signal() }))
    if (current(generation)) orders.value = dto.orders.map((order) => ({ id: order.id, createdAt: order.createdAt }))
  } catch (error) {
    failure(error, generation)
  } finally {
    if (current(generation)) loading.value = false
  }
}
async function prepare(nextAction: Intent['action'], target: string | null, raw: unknown, expectedVersion: number) {
  if (!privateEnabled.value || busy.value || intent.value) return
  const generation = epoch
  preparing.value = true
  message.value = ''
  try {
    const input =
      nextAction === 'submit'
        ? productContributionSubmitInputSchema.parse(raw)
        : nextAction === 'reply'
          ? productContributionReplyInputSchema.parse(raw)
          : productContributionModerationInputSchema.parse(raw)
    const hash = await productContributionIntentHash(nextAction, target, input),
      key = crypto.randomUUID()
    if (current(generation)) {
      intent.value = { action: nextAction, target, body: input, expectedVersion, hash, key }
      sent.value = false
      setPending(true)
    }
  } catch {
    if (current(generation)) message.value = 'Revisa los campos y la confirmación de privacidad. No se ha enviado nada.'
  } finally {
    if (current(generation)) preparing.value = false
  }
}
function prepareSubmit() {
  if (!confirmedProduct.value) return
  return prepare(
    'submit',
    null,
    {
      kind: kind.value,
      productId: props.productId,
      title: title.value,
      body: body.value,
      privacyAcknowledged: privacy.value,
      ...(kind.value === 'review'
        ? { score: Number(score.value), ...(orderId.value ? { orderId: orderId.value } : {}) }
        : {})
    },
    0
  )
}
function select(item: ProductContributionSnapshot) {
  if (busy.value) return
  selected.value = item
  action.value = 'publish'
  reason.value = ''
  reference.value = ''
  answer.value = ''
  reply.value = ''
  dueAt.value = ''
}
function prepareReview() {
  const item = selected.value
  if (!item) return
  if (props.audience === 'customer')
    return prepare('reply', item.id, { expectedVersion: item.version, body: reply.value }, item.version)
  let slaDueAt: string | null = null
  if (action.value === 'publish' && dueAt.value) {
    const date = new Date(dueAt.value + 'Z')
    if (!Number.isFinite(date.getTime())) {
      message.value = 'Revisa la fecha UTC.'
      return
    }
    slaDueAt = date.toISOString()
  }
  return prepare(
    action.value,
    item.id,
    {
      action: action.value,
      expectedVersion: item.version,
      reason: reason.value,
      ...(action.value === 'publish' ? { reviewReference: reference.value, slaDueAt } : {}),
      ...(action.value === 'answer' ? { reviewReference: reference.value, body: answer.value } : {})
    },
    item.version
  )
}
function cancelReview() {
  if (sent.value || loading.value) return
  intent.value = null
  setPending(false)
}
function exactReceipt(raw: unknown, frozen: Intent) {
  const receipt = productContributionReceiptSchema.parse(raw)
  if (
    receipt.commandId !== frozen.key ||
    receipt.action !== frozen.action ||
    receipt.payloadHash !== frozen.hash ||
    receipt.expectedVersion !== frozen.expectedVersion ||
    (frozen.target !== null && receipt.contributionId !== frozen.target)
  )
    throw new Error('receipt')
  return receipt
}
async function confirmCurrent(receipt: ProductContributionReceipt, frozen: Intent, generation: number) {
  const detail = productContributionSnapshotSchema.parse(
    await request(`${base.value}/${receipt.contributionId}`, { signal: controller?.signal })
  )
  if (!current(generation)) return
  if (
    detail.id !== receipt.contributionId ||
    detail.version < receipt.version ||
    !detail.history.some(
      (h) => h.action === receipt.action && h.version === receipt.version && h.recordedAt === receipt.recordedAt
    )
  )
    throw new Error('current')
  if (receipt.action === 'submit' && detail.productId !== (frozen.body as { productId: number }).productId)
    throw new Error('product')
  await privateList(1, generation)
  if (!current(generation)) return
  selected.value = null
  intent.value = null
  sent.value = false
  title.value = ''
  body.value = ''
  privacy.value = false
  answer.value = ''
  reply.value = ''
  reason.value = ''
  reference.value = ''
  published.value = null
  setPending(false)
  message.value = 'Aportación confirmada. El contenido público depende de su revisión.'
}
async function send() {
  const frozen = intent.value
  if (!privateEnabled.value || !frozen || sent.value || loading.value || props.pending) return
  const generation = epoch
  sent.value = true
  loading.value = true
  message.value = ''
  signal()
  let received = false
  try {
    const path =
      frozen.action === 'submit'
        ? base.value
        : `${base.value}/${frozen.target}/${frozen.action === 'reply' ? 'reply' : 'commands'}`
    const raw = await request(path, {
      method: 'POST',
      body: frozen.body,
      headers: { 'Idempotency-Key': frozen.key },
      signal: controller?.signal
    })
    received = true
    const receipt = exactReceipt(raw, frozen)
    if (!current(generation)) return
    await confirmCurrent(receipt, frozen, generation)
  } catch (error) {
    const e = error as { data?: { error?: { code?: string } } }
    if (current(generation) && !received && status(error) === 409 && e?.data?.error?.code === 'version_conflict') {
      intent.value = null
      selected.value = null
      items.value = []
      setPending(false)
      sent.value = false
      message.value = 'La versión ha cambiado. Consulta de nuevo; no se ha repetido el envío.'
    } else failure(error, generation, true)
  } finally {
    if (current(generation)) loading.value = false
  }
}
async function recover() {
  const frozen = intent.value
  if (!privateEnabled.value || !frozen || !sent.value || loading.value || props.pending) return
  const generation = epoch
  loading.value = true
  signal()
  try {
    const dto = productContributionCommandSchema.parse(
      await request(`${base.value}/commands/${frozen.key}`, {
        headers: { 'X-Neteco-Command-Payload-Hash': frozen.hash },
        signal: controller?.signal
      })
    )
    if (!current(generation)) return
    if (dto.outcome === 'unknown') {
      message.value = 'Resultado incierto. El recibo aún no está confirmado; no se repite el envío.'
      return
    }
    await confirmCurrent(exactReceipt(dto.receipt, frozen), frozen, generation)
  } catch (error) {
    failure(error, generation, true)
  } finally {
    if (current(generation)) loading.value = false
  }
}
function originLabel(origin: string) {
  return origin === 'verified_purchase' ? 'Compra verificada' : 'Compra no verificada'
}
function stateLabel(state: string) {
  return state === 'published' ? 'Publicado' : state === 'withdrawn' ? 'Retirado' : 'Pendiente de moderación'
}
// Vista del panel de administración: filtros locales sobre la página cargada y nombres legibles.
const adminSearch = ref(''),
  adminState = ref('all'),
  adminLoaded = ref(false)
watch(items, (list) => {
  if (list.length) adminLoaded.value = true
})
watch(active, (value) => {
  if (!value) adminLoaded.value = false
})
const adminStateOptions = computed(() => [
  { value: 'all', label: 'Todas', count: items.value.length },
  {
    value: 'pending',
    label: 'Pendientes',
    count: items.value.filter((i) => adminStateKey(i.state) === 'pending').length
  },
  { value: 'published', label: 'Publicadas' },
  { value: 'withdrawn', label: 'Retiradas' }
])
function adminStateKey(state: string) {
  return state === 'published' || state === 'withdrawn' ? state : 'pending'
}
const adminItems = computed(() => {
  const term = adminSearch.value.toLowerCase()
  return items.value.filter(
    (item) =>
      (adminState.value === 'all' || adminStateKey(item.state) === adminState.value) &&
      (!term || `${item.title} ${item.body}`.toLowerCase().includes(term))
  )
})
function adminClearFilters() {
  adminSearch.value = ''
  adminState.value = 'all'
}
const ADMIN_ACTIONS: Record<string, string> = {
  publish: 'Publicar',
  answer: 'Responder y publicar',
  close: 'Cerrar la pregunta',
  withdraw: 'Retirar de la tienda',
  submit: 'Enviar aportación',
  reply: 'Enviar réplica'
}
const adminFormId = useId()
/** La revisión se hace en un panel lateral; con un envío sin confirmar no se puede descartar. */
const adminDrawer = computed({
  get: () => adminView.value && (selected.value !== null || intent.value !== null),
  set: (open: boolean) => {
    if (open || loading.value || preparing.value) return
    if (intent.value) {
      if (sent.value) return
      cancelReview()
    }
    selected.value = null
  }
})
function adminRowClick(item: ProductContributionSnapshot, event: MouseEvent) {
  if ((event.target as HTMLElement).closest('a,button,input,label,select')) return
  if (item.capabilities.canModerate || item.capabilities.canReply) select(item)
}
/** Se pide el día; se guarda a mediodía para que no cambie de fecha al mostrarse en hora peninsular. */
function adminSetDueDay(event: Event) {
  const day = (event.target as HTMLInputElement).value
  dueAt.value = day ? `${day}T12:00` : ''
}
const ADMIN_FIELDS: Array<[string, string]> = [
  ['title', 'Título'],
  ['body', 'Contenido'],
  ['score', 'Valoración'],
  ['reason', 'Motivo'],
  ['reviewReference', 'Referencia de la revisión'],
  ['slaDueAt', 'Fecha de seguimiento']
]
const adminReviewedFields = computed(() => {
  if (!intent.value) return []
  const value = intent.value.body as Record<string, unknown>
  return ADMIN_FIELDS.flatMap(([key, label]) => {
    const raw = value[key]
    if (typeof raw !== 'string' && typeof raw !== 'number') return []
    const text = key === 'slaDueAt' ? adminDate(raw) : key === 'score' ? `${raw} de 5` : String(raw)
    return [{ label, value: text }]
  })
})
const adminMessageTone = computed(() =>
  message.value.startsWith('Aportación confirmada') ? 'success' : revoked.value ? 'error' : 'warning'
)
</script>
<template>
  <section v-if="adminView" aria-label="Moderación de aportaciones de productos" class="adm-stack min-w-0">
    <AdminCard v-if="!active">
      <AdminEmptyState
        v-if="secondFactorRejected"
        role="status"
        icon="i-lucide-shield-check"
        title="Hace falta la verificación en dos pasos"
        description="Por seguridad, las reseñas y preguntas de clientes solo se pueden consultar con la verificación en dos pasos activada en tu cuenta. En la demostración pública no está disponible."
      />
      <AdminEmptyState
        v-else
        role="status"
        icon="i-lucide-lock"
        title="No puedes ver las reseñas y preguntas ahora mismo"
        description="Comprueba que tu cuenta tiene permiso de atención al cliente y el correo verificado. Si acabas de cambiar algo en tu cuenta, vuelve a entrar."
      />
    </AdminCard>
    <template v-else-if="privateEnabled">
      <AdminPageActions>
        <button type="button" class="adm-btn adm-btn--primary" :disabled="busy" @click="loadPrivate(1)">
          <UIcon name="i-lucide-rotate-cw" class="size-4" />{{ adminLoaded ? 'Actualizar' : 'Consultar' }}
        </button>
      </AdminPageActions>
      <UAlert
        v-if="message && !adminDrawer"
        role="status"
        aria-live="polite"
        :color="adminMessageTone"
        variant="subtle"
        :icon="adminMessageTone === 'success' ? 'i-lucide-circle-check' : 'i-lucide-triangle-alert'"
        :title="message"
      />
      <AdminCard flush>
        <div v-if="items.length" class="adm-tablecard__bar">
          <AdminToolbar v-model:search="adminSearch" placeholder="Buscar en esta página…">
            <AdminFilters v-model="adminState" :options="adminStateOptions" label="Filtrar por estado" />
          </AdminToolbar>
        </div>
        <div v-if="loading && !items.length" class="adm-table-skeleton" aria-busy="true">
          <div v-for="row in 4" :key="row"><i /><i /><i /><i /></div>
        </div>
        <AdminEmptyState
          v-else-if="!items.length"
          icon="i-lucide-message-square-text"
          :title="
            adminLoaded ? 'No hay reseñas ni preguntas por revisar' : 'Consulta las reseñas y preguntas recibidas'
          "
          :description="
            adminLoaded
              ? 'Vuelve a consultar más tarde para ver si han llegado nuevas.'
              : 'Por privacidad, las reseñas y preguntas de clientes solo se cargan cuando lo pides.'
          "
        >
          <button type="button" class="adm-btn adm-btn--secondary" :disabled="busy" @click="loadPrivate(1)">
            {{ adminLoaded ? 'Volver a consultar' : 'Consultar ahora' }}
          </button>
        </AdminEmptyState>
        <AdminEmptyState
          v-else-if="!adminItems.length"
          variant="filtered"
          title="Ningún resultado con estos filtros"
          description="Prueba con otra búsqueda o quita algún filtro."
        >
          <button type="button" class="adm-btn adm-btn--secondary" @click="adminClearFilters">Quitar filtros</button>
        </AdminEmptyState>
        <div v-else class="adm-table-wrap">
          <table class="adm-table">
            <caption class="sr-only">
              Reseñas y preguntas de clientes
            </caption>
            <thead>
              <tr>
                <th scope="col">Aportación</th>
                <th scope="col">Tipo</th>
                <th scope="col">Estado</th>
                <th scope="col">Recibida</th>
                <th scope="col"><span class="sr-only">Acciones</span></th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="item in adminItems"
                :key="item.id"
                :data-selected="selected?.id === item.id || undefined"
                :class="(item.capabilities.canModerate || item.capabilities.canReply) && 'cursor-pointer'"
                @click="adminRowClick(item, $event)"
              >
                <td class="min-w-0 max-w-md break-words">
                  <p class="font-semibold text-[var(--text-strong)]">{{ item.title }}</p>
                  <p class="adm-help line-clamp-2 whitespace-pre-wrap">{{ item.body }}</p>
                </td>
                <td class="whitespace-nowrap">
                  {{ item.kind === 'question' ? 'Pregunta' : 'Reseña' }}
                  <span v-if="item.score !== null" class="adm-help"> · {{ item.score }} de 5</span>
                  <p class="adm-help">{{ originLabel(item.origin) }}</p>
                </td>
                <td>
                  <AdminBadge
                    :tone="item.state === 'published' ? 'success' : item.state === 'withdrawn' ? 'neutral' : 'warning'"
                  >
                    {{ stateLabel(item.state) }}
                  </AdminBadge>
                </td>
                <td class="whitespace-nowrap">{{ adminDate(item.createdAt) }}</td>
                <td class="adm-table__actions">
                  <button
                    v-if="item.capabilities.canModerate || item.capabilities.canReply"
                    type="button"
                    class="adm-btn adm-btn--secondary adm-btn--sm"
                    :disabled="busy"
                    @click="select(item)"
                  >
                    Revisar
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <template v-if="pages > 1" #footer>
          <nav
            aria-label="Páginas de aportaciones privadas"
            class="flex w-full flex-wrap items-center justify-end gap-2"
          >
            <button
              type="button"
              class="adm-btn adm-btn--secondary adm-btn--sm"
              :disabled="busy || page <= 1"
              @click="loadPrivate(page - 1)"
            >
              Anteriores
            </button>
            <span class="adm-help tabular-nums">Página {{ page }} de {{ pages }}</span>
            <button
              type="button"
              class="adm-btn adm-btn--secondary adm-btn--sm"
              :disabled="busy || page >= pages"
              @click="loadPrivate(page + 1)"
            >
              Siguientes
            </button>
          </nav>
        </template>
      </AdminCard>

      <AdminDrawer
        v-model:open="adminDrawer"
        :title="intent ? 'Confirma el cambio' : (selected?.title ?? 'Revisar')"
        :description="
          !intent && selected
            ? `${selected.kind === 'question' ? 'Pregunta' : 'Reseña'} · ${originLabel(selected.origin)} · ${adminDate(selected.createdAt, true)}`
            : undefined
        "
      >
        <div class="adm-stack min-w-0">
          <UAlert
            v-if="message"
            role="status"
            aria-live="polite"
            :color="adminMessageTone"
            variant="subtle"
            :icon="adminMessageTone === 'success' ? 'i-lucide-circle-check' : 'i-lucide-triangle-alert'"
            :title="message"
          />
          <div v-if="intent" class="adm-stack" aria-live="polite">
            <p>
              <strong>{{ ADMIN_ACTIONS[intent.action] ?? adminHumanize(intent.action) }}.</strong>
              {{
                intent.action === 'submit' || intent.action === 'reply'
                  ? 'El contenido quedará pendiente de moderación.'
                  : 'Lo que se ve en la tienda cambiará según esta revisión.'
              }}
            </p>
            <dl class="grid gap-3 break-words">
              <div v-for="field in adminReviewedFields" :key="field.label">
                <dt class="adm-help">{{ field.label }}</dt>
                <dd class="whitespace-pre-wrap text-[var(--text-strong)]">{{ field.value }}</dd>
              </div>
            </dl>
            <p v-if="!sent" class="adm-help">
              Comprueba el contenido antes de confirmar. No afecta a pagos ni a existencias, y no envía correos.
            </p>
          </div>
          <template v-else-if="selected">
            <div class="break-words">
              <p v-if="selected.score !== null" class="adm-help">Valoración: {{ selected.score }} de 5</p>
              <p class="whitespace-pre-wrap">{{ selected.body }}</p>
              <p v-if="selected.answer" class="mt-2 whitespace-pre-wrap">
                <strong>Respuesta del equipo:</strong> {{ selected.answer }}
              </p>
              <p v-if="selected.reply" class="mt-2 whitespace-pre-wrap">
                <strong>Réplica del cliente:</strong> {{ selected.reply }}
              </p>
              <p v-if="selected.kind === 'question'" class="adm-help mt-2">
                {{
                  selected.slaDueAt
                    ? `Seguimiento acordado: ${adminDate(selected.slaDueAt)}`
                    : 'Sin fecha de seguimiento acordada.'
                }}
              </p>
            </div>
            <form :id="adminFormId" data-contribution-review @submit.prevent="prepareReview">
              <fieldset :disabled="busy" class="adm-stack">
                <legend class="sr-only">Revisión de {{ selected.title }}</legend>
                <AdminFormField v-slot="{ id }" label="Qué quieres hacer">
                  <select :id="id" v-model="action" data-contribution-action class="w-full">
                    <option value="publish">Publicar tal como está</option>
                    <option v-if="selected.kind === 'question'" value="answer">Responder y publicar</option>
                    <option v-if="selected.kind === 'question'" value="close">Cerrar la pregunta</option>
                    <option value="withdraw">Retirar de la tienda</option>
                  </select>
                </AdminFormField>
                <AdminFormField v-if="action === 'answer'" v-slot="{ id }" label="Respuesta del equipo" required>
                  <textarea
                    :id="id"
                    v-model="answer"
                    data-contribution-answer
                    required
                    minlength="10"
                    maxlength="3000"
                    rows="4"
                    class="w-full"
                  />
                </AdminFormField>
                <AdminFormField
                  v-slot="{ id }"
                  label="Motivo"
                  help="Queda guardado en el registro de actividad. Mínimo 10 caracteres."
                  required
                >
                  <textarea
                    :id="id"
                    v-model="reason"
                    data-contribution-reason
                    required
                    minlength="10"
                    maxlength="500"
                    class="w-full"
                  />
                </AdminFormField>
                <AdminFormField
                  v-if="action === 'publish' || action === 'answer'"
                  v-slot="{ id }"
                  label="Referencia de la revisión"
                  help="Documento o procedimiento en el que te has basado."
                  required
                >
                  <input
                    :id="id"
                    v-model="reference"
                    data-contribution-reference
                    required
                    minlength="3"
                    maxlength="200"
                    class="w-full"
                  />
                </AdminFormField>
                <AdminFormField
                  v-if="action === 'publish' && selected.kind === 'question'"
                  v-slot="{ id }"
                  label="Fecha de seguimiento (opcional)"
                  help="Día en el que el equipo volverá a revisar esta pregunta."
                >
                  <input :id="id" :value="dueAt.slice(0, 10)" type="date" class="w-full" @input="adminSetDueDay" />
                </AdminFormField>
              </fieldset>
            </form>
          </template>
        </div>
        <template #footer>
          <template v-if="intent">
            <button
              v-if="!sent"
              type="button"
              class="adm-btn adm-btn--secondary"
              :disabled="loading"
              @click="cancelReview"
            >
              Volver a editar
            </button>
            <button
              v-if="!sent"
              type="button"
              class="adm-btn adm-btn--primary"
              :disabled="loading || pending"
              @click="send"
            >
              Confirmar
            </button>
            <button
              v-if="sent"
              type="button"
              class="adm-btn adm-btn--primary"
              :disabled="loading || pending"
              @click="recover"
            >
              Comprobar si se ha guardado
            </button>
          </template>
          <template v-else>
            <button type="button" class="adm-btn adm-btn--secondary" @click="selected = null">Cancelar</button>
            <button type="submit" :form="adminFormId" class="adm-btn adm-btn--primary" :disabled="busy">
              Revisar cambios
            </button>
          </template>
        </template>
      </AdminDrawer>
    </template>
    <p v-if="loading || preparing" role="status" class="sr-only">Comprobando…</p>
  </section>
  <section
    v-else
    :aria-label="audience === 'admin' ? 'Moderación de aportaciones de productos' : 'Reseñas y preguntas de productos'"
    class="min-w-0 space-y-5 rounded-lg border p-4"
  >
    <h2 class="text-xl font-semibold">
      {{ audience === 'admin' ? 'Reseñas y preguntas: moderación' : 'Reseñas y preguntas' }}
    </h2>
    <p>
      Contenido revisado antes de publicarse. La compra verificada se comprueba con un pedido propio entregado; no
      implica una garantía técnica.
    </p>
    <p v-if="!active" role="status">La consulta no está disponible con la autorización actual.</p>
    <template v-else>
      <button v-if="audience === 'customer' && confirmedProduct" type="button" :disabled="busy" @click="loadPublic(1)">
        Consultar reseñas y preguntas
      </button>
      <div v-if="published" class="space-y-4" aria-live="polite">
        <p v-if="!published.items.length">No hay aportaciones publicadas.</p>
        <article v-for="item in published.items" :key="item.id" class="break-words rounded border p-3">
          <h3>{{ item.title }}</h3>
          <p>
            {{ originLabel(item.origin) }}<span v-if="item.score !== null"> · {{ item.score }} de 5</span>
          </p>
          <p class="whitespace-pre-wrap">{{ item.body }}</p>
          <p v-if="item.answer" class="whitespace-pre-wrap">Respuesta experta revisada: {{ item.answer }}</p>
          <p v-if="item.reply" class="whitespace-pre-wrap">Réplica revisada: {{ item.reply }}</p>
          <p v-if="item.questionStatus">
            Estado de la pregunta:
            {{
              item.questionStatus === 'answered'
                ? 'Respondida'
                : item.questionStatus === 'closed'
                  ? 'Cerrada'
                  : 'Abierta'
            }}
          </p>
        </article>
        <nav v-if="publicPages > 1" aria-label="Páginas de aportaciones publicadas" class="flex flex-wrap gap-3">
          <button type="button" :disabled="busy || publicPage <= 1" @click="loadPublic(publicPage - 1)">
            Anteriores publicadas</button
          ><span>{{ publicPage }} / {{ publicPages }}</span
          ><button type="button" :disabled="busy || publicPage >= publicPages" @click="loadPublic(publicPage + 1)">
            Siguientes publicadas
          </button>
        </nav>
      </div>
      <template v-if="privateEnabled">
        <button type="button" :disabled="busy" @click="loadPrivate(1)">
          {{ audience === 'admin' ? 'Consultar cola de moderación' : 'Consultar mis aportaciones' }}
        </button>
        <form
          v-if="audience === 'customer' && confirmedProduct && !intent"
          data-contribution-submit
          class="space-y-3"
          @submit.prevent="prepareSubmit"
        >
          <fieldset :disabled="busy" class="space-y-3">
            <legend>Aportar una reseña o una pregunta</legend>
            <label class="block"
              >Tipo
              <select v-model="kind">
                <option value="question">Pregunta al equipo experto</option>
                <option value="review">Reseña de producto</option>
              </select></label
            >
            <label v-if="kind === 'review'" class="block"
              >Valoración
              <select v-model="score">
                <option v-for="n in 5" :key="n" :value="n">{{ n }} de 5</option>
              </select></label
            >
            <template v-if="kind === 'review'"
              ><p>Sin pedido comprobado se mostrará «Compra no verificada».</p>
              <button type="button" @click="loadOrders">Elegir pedido propio</button
              ><label v-if="orders.length" class="block"
                >Pedido para comprobar compra
                <select v-model="orderId">
                  <option value="">Sin prueba de compra</option>
                  <option v-for="order in orders" :key="order.id" :value="order.id">
                    Pedido {{ order.id }} · {{ order.createdAt }}
                  </option>
                </select></label
              ></template
            >
            <label class="block"
              >Título
              <input v-model="title" data-contribution-title required minlength="3" maxlength="160" class="w-full"
            /></label>
            <label class="block"
              >Contenido público propuesto
              <textarea
                v-model="body"
                data-contribution-body
                required
                minlength="10"
                maxlength="3000"
                rows="4"
                class="w-full"
              />
            </label>
            <p>
              No incluyas nombres, correos, teléfonos, datos sensibles ni números de pedido en el texto. Aportar es
              opcional y no condiciona el servicio.
            </p>
            <label class="block"
              ><input v-model="privacy" data-contribution-privacy type="checkbox" required /> Entiendo que el contenido
              podrá publicarse tras moderación.</label
            ><button type="submit">Revisar aportación</button>
          </fieldset>
        </form>
        <article v-for="item in items" :key="item.id" class="break-words space-y-2 rounded border p-3">
          <h3>{{ item.title }}</h3>
          <p>{{ stateLabel(item.state) }} · {{ originLabel(item.origin) }} · versión {{ item.version }}</p>
          <p class="whitespace-pre-wrap">{{ item.body }}</p>
          <p v-if="item.answer" class="whitespace-pre-wrap">Respuesta experta: {{ item.answer }}</p>
          <p v-if="item.reply" class="whitespace-pre-wrap">Réplica: {{ item.reply }}</p>
          <p v-if="item.kind === 'question'">
            {{ item.slaDueAt ? `Seguimiento acordado UTC: ${item.slaDueAt}` : 'Sin plazo comprometido.' }}
          </p>
          <button
            v-if="item.capabilities.canModerate || item.capabilities.canReply"
            type="button"
            :disabled="busy"
            @click="select(item)"
          >
            {{ audience === 'admin' ? 'Revisar aportación' : 'Preparar réplica' }}
          </button>
        </article>
        <nav v-if="pages > 1" aria-label="Páginas de aportaciones privadas" class="flex flex-wrap gap-3">
          <button type="button" :disabled="busy || page <= 1" @click="loadPrivate(page - 1)">Anteriores</button
          ><span>{{ page }} / {{ pages }}</span
          ><button type="button" :disabled="busy || page >= pages" @click="loadPrivate(page + 1)">Siguientes</button>
        </nav>
        <form v-if="selected && !intent" data-contribution-review class="space-y-3" @submit.prevent="prepareReview">
          <fieldset :disabled="busy" class="space-y-3">
            <legend>Revisión de {{ selected.title }}</legend>
            <template v-if="audience === 'admin'"
              ><label class="block"
                >Acción
                <select v-model="action" data-contribution-action>
                  <option value="publish">Publicar contenido revisado</option>
                  <option v-if="selected.kind === 'question'" value="answer">Responder como experto y publicar</option>
                  <option v-if="selected.kind === 'question'" value="close">Cerrar pregunta</option>
                  <option value="withdraw">Retirar proyección pública</option>
                </select></label
              ><label v-if="action === 'answer'" class="block"
                >Respuesta experta
                <textarea
                  v-model="answer"
                  data-contribution-answer
                  required
                  minlength="10"
                  maxlength="3000"
                  rows="4"
                  class="w-full"
                /></label
              ><label class="block"
                >Motivo auditado
                <textarea
                  v-model="reason"
                  data-contribution-reason
                  required
                  minlength="10"
                  maxlength="500"
                  class="w-full"
                /></label
              ><label v-if="action === 'publish' || action === 'answer'" class="block"
                >Referencia de revisión
                <input
                  v-model="reference"
                  data-contribution-reference
                  required
                  minlength="3"
                  maxlength="200"
                  class="w-full" /></label
              ><label v-if="action === 'publish' && selected.kind === 'question'" class="block"
                >Seguimiento acordado (UTC, opcional) <input v-model="dueAt" type="datetime-local" /></label
            ></template>
            <template v-else
              ><p>La réplica vuelve a moderación; no sustituye la respuesta experta.</p>
              <label class="block"
                >Réplica pública propuesta
                <textarea
                  v-model="reply"
                  required
                  minlength="3"
                  maxlength="2000"
                  rows="4"
                  class="w-full"
                /></label></template
            ><button type="submit">Revisar cambios</button>
          </fieldset>
        </form>
        <div v-if="intent" class="space-y-2 rounded border p-3" aria-live="polite">
          <h3>Confirmación explícita</h3>
          <p>
            Acción: {{ intent.action }}.
            {{
              intent.action === 'submit' || intent.action === 'reply'
                ? 'El contenido quedará pendiente de moderación.'
                : 'La proyección pública cambiará según esta revisión.'
            }}
          </p>
          <dl class="break-words">
            <template v-for="field in reviewedFields" :key="field.label"
              ><dt>{{ field.label }}</dt>
              <dd class="whitespace-pre-wrap">{{ field.value }}</dd></template
            >
          </dl>
          <p v-if="!sent">
            Comprueba el contenido y la acción antes de enviar. No cambia pagos, inventario ni envía correos.
          </p>
          <button v-if="!sent" type="button" :disabled="loading || pending" @click="send">Confirmar aportación</button
          ><button v-if="!sent" type="button" :disabled="loading" @click="cancelReview">Volver a editar</button
          ><button v-if="sent" type="button" :disabled="loading || pending" @click="recover">
            Comprobar aportación
          </button>
        </div>
      </template>
    </template>
    <p v-if="loading || preparing" role="status">Comprobando…</p>
    <p v-if="message" role="status" aria-live="polite">{{ message }}</p>
  </section>
</template>
