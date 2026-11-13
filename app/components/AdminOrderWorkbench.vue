<script setup lang="ts">
import { z } from 'zod'
import type { AdminTone } from '~/utils/adminLabels'
import OrderFulfillmentSection from './OrderFulfillmentSection.vue'
import AdminOrderExport from './AdminOrderExport.vue'
import AdminOrderViews from './AdminOrderViews.vue'
import AdminOrderBatchPreparation from './AdminOrderBatchPreparation.vue'
import { adminCapabilitiesSchema } from '~~/shared/admin-navigation'
import {
  ADMIN_ORDER_VIEW_COLUMNS,
  adminOrderViewDefinitionSchema,
  type AdminOrderViewDefinition
} from '~~/shared/admin-order-views'

const runtime = useRuntimeConfig()
const { ready, loggedIn, user, session } = useUserSession()
const navigation = useAdminNavigation()
const request = useRequestFetch()
const authority = computed(() => {
  const parsed = adminCapabilitiesSchema.safeParse(navigation.capabilities.value)
  if (
    runtime.public.serverRuntime !== 'cloudflare' ||
    !ready.value ||
    !loggedIn.value ||
    user.value?.emailVerified !== true ||
    user.value?.mfaVerified !== true ||
    navigation.status.value !== 'ready' ||
    !parsed.success ||
    parsed.data.state !== 'ready' ||
    !parsed.data.permissions.includes('administration.manage') ||
    parsed.data.identityId !== user.value.id ||
    parsed.data.sessionId !== session.value?.sessionId ||
    parsed.data.sessionVersion !== session.value?.sessionVersion
  )
    return null
  return JSON.stringify([parsed.data.identityId, parsed.data.sessionId, parsed.data.sessionVersion])
})
const values = {
  bucket: ['todos', 'por_preparar', 'por_cobrar', 'incidencia'],
  payment: ['pending', 'processing', 'authorized', 'captured', 'failed', 'cancelled', 'stock_exception'],
  order: ['awaiting_payment', 'cancelled'],
  shipping: ['pickup', 'parcel', 'own_delivery'],
  customer: ['b2c', 'b2b'],
  sort: ['id', 'createdAt', 'name', 'total'],
  direction: ['asc', 'desc']
}
const labels: Record<string, string> = {
  todos: 'Todos',
  por_preparar: 'Por preparar',
  por_cobrar: 'Esperando cobro',
  incidencia: 'Con incidencia',
  pending: 'Pendiente',
  processing: 'En curso',
  authorized: 'Autorizado',
  captured: 'Cobrado',
  failed: 'Fallido',
  cancelled: 'Cancelado',
  stock_exception: 'Incidencia de stock',
  awaiting_payment: 'Esperando cobro',
  pickup: 'Recogida en tienda',
  parcel: 'Paquetería',
  own_delivery: 'Reparto propio',
  b2c: 'Particular',
  b2b: 'Empresa',
  id: 'Pedido',
  createdAt: 'Fecha',
  name: 'Cliente',
  total: 'Total',
  asc: 'Ascendente',
  desc: 'Descendente'
}
/** Nombres legibles de lo que se pinta en las celdas (los códigos internos nunca se enseñan). */
const cellLabels: Record<string, Record<string, [string, AdminTone]>> = {
  paymentStatus: {
    pending: ['Pendiente de cobro', 'warning'],
    processing: ['Cobro en curso', 'info'],
    authorized: ['Autorizado', 'info'],
    captured: ['Cobrado', 'success'],
    failed: ['Cobro fallido', 'danger'],
    cancelled: ['Cancelado', 'neutral'],
    stock_exception: ['Incidencia de stock', 'danger']
  },
  fulfillmentStatus: {
    pending: ['Sin preparar', 'warning'],
    picking: ['En preparación', 'info'],
    packed: ['Embalado', 'info'],
    ready_for_pickup: ['Listo para recoger', 'info'],
    in_transit: ['En reparto', 'info'],
    delivered: ['Entregado', 'success'],
    exception: ['Incidencia', 'danger']
  },
  shippingMethod: {
    pickup: ['Recogida en tienda', 'neutral'],
    recogida: ['Recogida en tienda', 'neutral'],
    parcel: ['Paquetería', 'neutral'],
    paqueteria: ['Paquetería', 'neutral'],
    own_delivery: ['Reparto propio', 'neutral'],
    reparto: ['Reparto propio', 'neutral']
  },
  invoiceStatus: {
    unavailable: ['Sin factura', 'neutral'],
    pending: ['Pendiente', 'warning'],
    issued: ['Emitida', 'success']
  }
}
const filterFields = [
  { field: 'payment', label: 'Pago', any: true },
  { field: 'order', label: 'Estado del pedido', any: true },
  { field: 'shipping', label: 'Entrega', any: true },
  { field: 'customer', label: 'Tipo de cliente', any: true },
  { field: 'sort', label: 'Ordenar por', any: false },
  { field: 'direction', label: 'Sentido', any: false }
] as const
const bucketOptions = values.bucket.map((value) => ({ value, label: labels[value] ?? value }))
const defaults = () => ({
  query: '',
  bucket: 'todos',
  payment: '',
  order: '',
  shipping: '',
  customer: '',
  from: '',
  to: '',
  sort: 'createdAt',
  direction: 'desc'
})
const filters = reactive(defaults())
/** Panel desplegado bajo la barra: se mantiene montado para no perder su estado al cerrarlo. */
const panel = ref<'filters' | 'views' | 'columns' | 'export' | null>(null)
function togglePanel(name: 'filters' | 'views' | 'columns' | 'export') {
  panel.value = panel.value === name ? null : name
}
const activeFilters = computed(
  () =>
    [filters.payment, filters.order, filters.shipping, filters.customer, filters.from, filters.to].filter(Boolean)
      .length
)
type Query = {
  q: string
  page: number
  perPage: number
  bucket: string
  sortKey: string
  sortDir: string
  pagination: 'cursor'
  after?: string
  before?: string
  paymentStatus?: string
  orderStatus?: string
  shippingMethod?: string
  customerType?: string
  from?: string
  to?: string
}
const initialQuery = (): Query => ({
  q: '',
  page: 1,
  perPage: 25,
  bucket: 'todos',
  sortKey: 'createdAt',
  sortDir: 'desc',
  pagination: 'cursor'
})
let lastQuery = initialQuery()
const text = z.string().max(2000)
const rowSchema = z
  .object({
    id: z.string().uuid(),
    status: text,
    orderStatus: text,
    paymentStatus: text,
    fulfillmentStatus: text,
    inventoryStatus: text,
    invoiceStatus: text,
    name: text,
    company: text.nullable(),
    email: text,
    city: text,
    paymentMethod: text,
    shippingMethod: text,
    total: z.number().finite().nonnegative(),
    createdAt: z.string().datetime(),
    lines: z.number().int().nonnegative(),
    shipmentId: text.nullable(),
    trackingNumber: text.nullable(),
    shipmentStatus: text.nullable()
  })
  .strict()
const responseSchema = z
  .object({
    source: z.literal('cloudflare'),
    items: z.array(rowSchema).max(25),
    pagination: z
      .object({
        page: z.number().int().positive(),
        perPage: z.literal(25),
        total: z.number().int().nonnegative(),
        pages: z.number().int().nonnegative(),
        mode: z.literal('cursor'),
        nextCursor: z.string().min(1).max(8192).nullable(),
        previousCursor: z.string().min(1).max(8192).nullable()
      })
      .strict(),
    capabilities: z
      .object({
        orderStatusUpdate: z.literal(false),
        shipments: z.literal(false),
        tracking: z.literal(false),
        refunds: z.literal(false),
        returns: z.literal(false),
        invoices: z.literal(false),
        notes: z.literal(false),
        customerPreview: z.literal(false),
        paymentsRead: z.literal(true),
        inventoryRead: z.literal(true),
        fulfillmentRead: z.literal(true),
        orderHistory: z.literal(true)
      })
      .strict()
  })
  .strict()
const pageFallbackSchema = responseSchema.extend({
  pagination: z
    .object({
      page: z.literal(1),
      perPage: z.literal(25),
      total: z.number().int().nonnegative(),
      pages: z.number().int().nonnegative()
    })
    .strict()
})
const snapshot = shallowRef<z.infer<typeof responseSchema> | null>(null)
const loading = ref(false),
  failed = ref(false),
  validation = ref(false),
  fulfillmentPending = ref(false),
  viewsPending = ref(false),
  exportPending = ref(false),
  batchPending = ref(false),
  batchCompleted = ref(false)
const pending = computed(
  () => fulfillmentPending.value || viewsPending.value || exportPending.value || batchPending.value
)
const selectedRows = ref<string[]>([])
watch(
  () => JSON.stringify(filters),
  () => {
    selectedRows.value = []
    batchCompleted.value = false
  },
  { flush: 'sync' }
)
function selectRow(id: string) {
  if (pending.value || loading.value || !authority.value || !snapshot.value?.items.some((row) => row.id === id)) return
  selectedRows.value = selectedRows.value.includes(id)
    ? selectedRows.value.filter((value) => value !== id)
    : [...selectedRows.value, id]
  batchCompleted.value = false
}
function selectPage() {
  if (pending.value || loading.value || !authority.value || !snapshot.value) return
  selectedRows.value =
    selectedRows.value.length === snapshot.value.items.length ? [] : snapshot.value.items.map((row) => row.id)
  batchCompleted.value = false
}
const columns = ref<Array<(typeof ADMIN_ORDER_VIEW_COLUMNS)[number]>>([...ADMIN_ORDER_VIEW_COLUMNS])
const columnLabels = {
  createdAt: 'Fecha',
  customer: 'Cliente',
  total: 'Total',
  paymentStatus: 'Pago',
  fulfillmentStatus: 'Estado de preparación',
  shippingMethod: 'Entrega',
  invoiceStatus: 'Factura'
}
const appliedDefinition = computed(() => {
  if (!snapshot.value || loading.value || failed.value) return null
  const query = Object.fromEntries(
    Object.entries(lastQuery).filter(
      ([key]) => !['q', 'page', 'perPage', 'pagination', 'after', 'before'].includes(key)
    )
  )
  const parsed = adminOrderViewDefinitionSchema.safeParse({ ...query, columns: [...columns.value] })
  return parsed.success ? parsed.data : null
})
function applyView(raw: unknown) {
  if (!authority.value || pending.value || loading.value) return
  const parsed = adminOrderViewDefinitionSchema.safeParse(raw)
  if (!parsed.success) return
  const view: AdminOrderViewDefinition = parsed.data
  Object.assign(filters, defaults(), {
    query: '',
    bucket: view.bucket,
    sort: view.sortKey,
    direction: view.sortDir,
    payment: view.paymentStatus ?? '',
    order: view.orderStatus ?? '',
    shipping: view.shippingMethod ?? '',
    customer: view.customerType ?? '',
    from: view.from ?? '',
    to: view.to ?? ''
  })
  columns.value = [...view.columns]
  selected.value = null
  // Selecting Apply is itself explicit consent to one server-filtered GET.
  apply()
}
function toggleColumn(column: (typeof ADMIN_ORDER_VIEW_COLUMNS)[number]) {
  if (pending.value || loading.value) return
  if (columns.value.includes(column)) {
    if (columns.value.length > 1) columns.value = columns.value.filter((value) => value !== column)
  } else columns.value = ADMIN_ORDER_VIEW_COLUMNS.filter((value) => value === column || columns.value.includes(value))
}
function cell(order: z.infer<typeof rowSchema>, column: (typeof ADMIN_ORDER_VIEW_COLUMNS)[number]) {
  if (column === 'customer') return order.name
  if (column === 'total') return adminMoney(order.total)
  if (column === 'createdAt') return adminDate(order.createdAt, true)
  return cellLabels[column]?.[order[column]]?.[0] ?? adminStatusLabel(order[column])
}
function cellTone(order: z.infer<typeof rowSchema>, column: (typeof ADMIN_ORDER_VIEW_COLUMNS)[number]) {
  if (column !== 'paymentStatus' && column !== 'fulfillmentStatus' && column !== 'invoiceStatus') return null
  return cellLabels[column]?.[order[column]]?.[1] ?? adminStatusTone(order[column])
}
const shortId = (id: string) => '#' + id.slice(0, 8).toUpperCase()
const selected = ref<string | null>(null)
// lastQuery is deliberately not reactive: snapshot is the proof that this GET
// completed and its filters, rather than an editable draft, may be exported.
const appliedExportQuery = computed(() => {
  if (!snapshot.value || loading.value || failed.value) return null
  return Object.fromEntries(
    Object.entries(lastQuery)
      .filter(([key]) => !['page', 'perPage', 'pagination', 'after', 'before'].includes(key))
      .map(([key, value]) => [key, String(value)])
  )
})
let alive = true,
  epoch = 0,
  controller: AbortController | null = null
function purge() {
  epoch++
  controller?.abort()
  controller = null
  snapshot.value = null
  selected.value = null
  fulfillmentPending.value = false
  viewsPending.value = false
  exportPending.value = false
  batchPending.value = false
  batchCompleted.value = false
  selectedRows.value = []
  loading.value = false
  failed.value = false
  validation.value = false
}
async function read(query: Query) {
  if (!alive || !authority.value || loading.value || pending.value) return
  const scope = authority.value,
    generation = ++epoch
  selectedRows.value = []
  batchCompleted.value = false
  controller?.abort()
  controller = new AbortController()
  const signal = controller.signal
  lastQuery = { ...query }
  loading.value = true
  failed.value = false
  validation.value = false
  snapshot.value = null
  const current = () => alive && epoch === generation && authority.value === scope
  try {
    const endpoint: string = '/api/admin/orders'
    let raw: unknown
    try {
      raw = await request(endpoint, {
        method: 'GET',
        query: { ...query },
        retry: 0,
        cache: 'no-store',
        signal
      })
    } catch (error: unknown) {
      // La paginación por cursor exige un segundo factor registrado. Si el servidor la
      // rechaza solo por eso (p. ej. en la sesión de demostración), se usa el listado por
      // páginas que el propio servidor sí autoriza a esta sesión: primera página, sin cursores.
      const failure = error as { data?: { error?: { code?: unknown } } } | null
      if (failure?.data?.error?.code !== 'mfa_required' || query.page !== 1 || query.after || query.before) throw error
      const { pagination: _mode, after: _after, before: _before, ...plain } = query
      const page = pageFallbackSchema.parse(
        await request(endpoint, { method: 'GET', query: plain, retry: 0, cache: 'no-store', signal })
      )
      raw = { ...page, pagination: { ...page.pagination, mode: 'cursor', nextCursor: null, previousCursor: null } }
    }
    if (!current()) return
    const dto = responseSchema.parse(raw)
    if (
      dto.pagination.page !== query.page ||
      dto.pagination.pages !== Math.ceil(dto.pagination.total / 25) ||
      dto.items.length > dto.pagination.total ||
      new Set(dto.items.map((item) => item.id)).size !== dto.items.length
    )
      throw new Error('unconfirmed_queue')
    snapshot.value = dto
  } catch {
    if (current()) {
      snapshot.value = null
      failed.value = true
    }
  } finally {
    if (current()) {
      loading.value = false
      controller = null
    }
  }
}
function apply() {
  if (pending.value || loading.value || !authority.value) return
  const q = filters.query.trim()
  const validDate = (date: string) =>
    !date ||
    (/^\d{4}-\d{2}-\d{2}$/.test(date) &&
      Number.isFinite(Date.parse(date + 'T00:00:00Z')) &&
      new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) === date &&
      date <= '9999-12-30')
  if (
    q.length > 120 ||
    [...q].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ||
    !validDate(filters.from) ||
    !validDate(filters.to) ||
    (filters.from && filters.to && filters.from > filters.to) ||
    Object.entries(values).some(([key, allowed]) => {
      const value = filters[key as keyof typeof filters]
      return value !== '' && !allowed.includes(value)
    })
  ) {
    validation.value = true
    return
  }
  const query: Query = {
    q,
    page: 1,
    perPage: 25,
    bucket: filters.bucket,
    sortKey: filters.sort,
    sortDir: filters.direction,
    pagination: 'cursor'
  }
  for (const [field, key] of [
    ['payment', 'paymentStatus'],
    ['order', 'orderStatus'],
    ['shipping', 'shippingMethod'],
    ['customer', 'customerType'],
    ['from', 'from'],
    ['to', 'to']
  ] as const)
    if (filters[field]) Object.assign(query, { [key]: filters[field] })
  selected.value = null
  void read(query)
}
function reset() {
  if (pending.value || loading.value) return
  Object.assign(filters, defaults())
  selected.value = null
  void read(initialQuery())
}
/** ¿La última consulta hecha llevaba búsqueda o algún filtro? (decide el texto del listado vacío). */
function isFiltered() {
  const { q, bucket, paymentStatus, orderStatus, shippingMethod, customerType, from, to } = lastQuery
  return Boolean(
    q || bucket !== 'todos' || paymentStatus || orderStatus || shippingMethod || customerType || from || to
  )
}
function pickBucket(value: string) {
  if (pending.value || loading.value || !authority.value) return
  filters.bucket = value
  // Elegir una cola es una consulta explícita con los filtros que hay escritos.
  apply()
}
function page(delta: number) {
  if (!snapshot.value || pending.value || loading.value) return
  const next = snapshot.value.pagination.page + delta
  const cursor = delta > 0 ? snapshot.value.pagination.nextCursor : snapshot.value.pagination.previousCursor
  if (next < 1 || !cursor) return
  selected.value = null
  const { after: _after, before: _before, ...query } = lastQuery
  void read({ ...query, page: next, ...(delta > 0 ? { after: cursor } : { before: cursor }) })
}
function open(id: string) {
  if (!pending.value && !loading.value && authority.value && snapshot.value?.items.some((row) => row.id === id))
    selected.value = id
}
function close() {
  if (!pending.value) selected.value = null
}
function confirmed() {
  if (authority.value) void read(lastQuery)
}
onBeforeRouteLeave(() => (pending.value ? false : undefined))
onBeforeRouteUpdate(() => (pending.value ? false : undefined))
// The capability self-read may complete after mount. Start once on the first
// confirmed authority, not only on the watcher's immediate invocation. Later
// revocation still purges everything and requires an explicit new queue read.
let initialReadStarted = false
watch(
  authority,
  (next) => {
    purge()
    Object.assign(filters, defaults())
    columns.value = [...ADMIN_ORDER_VIEW_COLUMNS]
    lastQuery = initialQuery()
    if (next && !initialReadStarted) {
      initialReadStarted = true
      void read(initialQuery())
    }
  },
  { immediate: true, flush: 'sync' }
)
onBeforeUnmount(() => {
  alive = false
  purge()
})
</script>
<template>
  <section aria-label="Banco de preparación de pedidos" class="adm-stack min-w-0">
    <AdminEmptyState
      v-if="!authority"
      role="status"
      icon="i-lucide-lock"
      title="Confirma la sesión para ver los pedidos"
      description="Necesitas tener la sesión iniciada, el correo verificado, la verificación en dos pasos y permiso de administración."
    />
    <template v-else>
      <div class="adm-card adm-tablecard">
        <form data-wb-form class="adm-tablecard__bar" @submit.prevent="apply">
          <div class="adm-toolbar" role="search">
            <label class="adm-toolbar__search">
              <span class="sr-only">Buscar por pedido, cliente o NIF</span>
              <UIcon name="i-lucide-search" class="size-4" />
              <input
                v-model="filters.query"
                data-wb-query
                data-slot="adm-search"
                :disabled="pending || loading"
                type="search"
                placeholder="Buscar pedido, cliente o NIF"
              />
            </label>
            <AdminFilters
              :model-value="filters.bucket"
              :options="bucketOptions.map((option) => ({ ...option, disabled: pending || loading }))"
              label="Filtrar por situación del pedido"
              @update:model-value="pickBucket"
            />
            <!-- El selector equivalente a los segmentos se conserva para lectores de pantalla y automatismos. -->
            <label class="sr-only"
              >Situación del pedido<select
                v-model="filters.bucket"
                data-wb-bucket
                data-slot="adm-native"
                tabindex="-1"
                :disabled="pending || loading"
              >
                <option v-for="option in bucketOptions" :key="option.value" :value="option.value">
                  {{ option.label }}
                </option>
              </select></label
            >
            <button
              type="button"
              class="adm-btn adm-btn--secondary"
              data-wb-toggle="filters"
              :aria-expanded="panel === 'filters'"
              @click="togglePanel('filters')"
            >
              <UIcon name="i-lucide-sliders-horizontal" class="size-4" />Filtros
              <span v-if="activeFilters" class="adm-segment__count">{{ activeFilters }}</span>
            </button>
            <div class="adm-toolbar__end">
              <button
                type="button"
                class="adm-btn adm-btn--secondary"
                data-wb-toggle="views"
                :aria-expanded="panel === 'views'"
                @click="togglePanel('views')"
              >
                <UIcon name="i-lucide-bookmark" class="size-4" />Vistas
              </button>
              <button
                type="button"
                class="adm-btn adm-btn--secondary"
                data-wb-toggle="columns"
                :aria-expanded="panel === 'columns'"
                :disabled="!snapshot"
                @click="togglePanel('columns')"
              >
                <UIcon name="i-lucide-columns-3" class="size-4" />Columnas
              </button>
              <button
                type="button"
                class="adm-btn adm-btn--secondary"
                data-wb-toggle="export"
                :aria-expanded="panel === 'export'"
                :disabled="!snapshot"
                @click="togglePanel('export')"
              >
                <UIcon name="i-lucide-download" class="size-4" />Exportar
              </button>
            </div>
          </div>
          <div v-show="panel === 'filters'" class="mt-3 border-t border-[var(--border)] pt-3">
            <div class="adm-form-grid">
              <label v-for="entry in filterFields" :key="entry.field" class="adm-field">
                <span class="adm-label">{{ entry.label }}</span>
                <select
                  v-model="filters[entry.field]"
                  :data-wb-payment="entry.field === 'payment' ? '' : undefined"
                  :data-wb-order="entry.field === 'order' ? '' : undefined"
                  :data-wb-shipping="entry.field === 'shipping' ? '' : undefined"
                  :data-wb-customer="entry.field === 'customer' ? '' : undefined"
                  :data-wb-sort="entry.field === 'sort' ? '' : undefined"
                  :data-wb-direction="entry.field === 'direction' ? '' : undefined"
                  :disabled="pending || loading"
                  class="adm-input w-full"
                >
                  <option v-if="entry.any" value="">Todos</option>
                  <option v-for="option in values[entry.field]" :key="option" :value="option">
                    {{ labels[option] }}
                  </option>
                </select>
              </label>
              <label class="adm-field">
                <span class="adm-label">Desde</span>
                <input
                  v-model="filters.from"
                  data-wb-from
                  type="date"
                  :disabled="pending || loading"
                  class="adm-input w-full"
                />
              </label>
              <label class="adm-field">
                <span class="adm-label">Hasta</span>
                <input
                  v-model="filters.to"
                  data-wb-to
                  type="date"
                  :disabled="pending || loading"
                  class="adm-input w-full"
                />
              </label>
            </div>
            <div class="mt-3 flex flex-wrap justify-end gap-2">
              <button
                data-wb-reset
                type="button"
                :disabled="pending || loading"
                class="adm-btn adm-btn--secondary"
                @click="reset"
              >
                Restablecer
              </button>
              <button data-wb-apply type="submit" :disabled="pending || loading" class="adm-btn adm-btn--primary">
                Aplicar
              </button>
            </div>
          </div>
        </form>

        <div v-show="panel === 'views'" class="border-b border-[var(--border)] px-4 py-3">
          <AdminOrderViews
            :key="authority"
            :scope-key="authority"
            :enabled="Boolean(authority)"
            :pending="loading || fulfillmentPending || exportPending || batchPending"
            :applied-definition="appliedDefinition"
            @apply="applyView"
            @pending="viewsPending = $event"
          />
        </div>

        <div v-if="validation" data-wb-validation role="alert" class="border-b border-[var(--border)] px-4 py-3">
          <UAlert
            color="warning"
            variant="subtle"
            icon="i-lucide-triangle-alert"
            title="Revisa la búsqueda y las fechas"
            description="La búsqueda admite hasta 120 caracteres y la fecha «desde» no puede ser posterior a «hasta»."
          />
        </div>

        <div v-if="loading" data-wb-loading role="status" class="adm-table-skeleton" aria-busy="true">
          <span class="sr-only">Cargando pedidos…</span>
          <div v-for="line in 6" :key="line"><i /><i /><i /><i /></div>
        </div>
        <div v-else-if="failed" data-wb-error role="alert">
          <AdminEmptyState
            variant="error"
            title="No se han podido cargar los pedidos"
            description="Puede ser un fallo puntual de conexión. Los pedidos siguen ahí: vuelve a intentarlo."
          >
            <button
              data-wb-retry
              type="button"
              :disabled="pending"
              class="adm-btn adm-btn--secondary"
              @click="read(lastQuery)"
            >
              <UIcon name="i-lucide-rotate-cw" class="size-4" />Reintentar
            </button>
          </AdminEmptyState>
        </div>
        <template v-else-if="snapshot">
          <div v-show="panel === 'export'" class="border-b border-[var(--border)] px-4 py-3">
            <AdminOrderExport
              v-if="!fulfillmentPending && !viewsPending && !batchPending && appliedExportQuery"
              :scope-key="authority"
              :enabled="Boolean(authority)"
              :pending="loading || fulfillmentPending || viewsPending || batchPending"
              :applied-query="appliedExportQuery"
              @pending="exportPending = $event"
            />
            <p v-else class="adm-help">Termina la operación en curso para poder exportar.</p>
          </div>
          <fieldset v-show="panel === 'columns'" class="border-b border-[var(--border)] px-4 py-3">
            <legend class="sr-only">Columnas visibles</legend>
            <p class="adm-label">Columnas visibles</p>
            <div class="mt-2 flex flex-wrap gap-x-5 gap-y-2">
              <label v-for="column in ADMIN_ORDER_VIEW_COLUMNS" :key="column" class="adm-check"
                ><input
                  type="checkbox"
                  :data-wb-column="column"
                  :checked="columns.includes(column)"
                  :disabled="pending || loading || (columns.length === 1 && columns.includes(column))"
                  @change="toggleColumn(column)"
                />{{ columnLabels[column] }}</label
              >
            </div>
            <p class="adm-help mt-2">El número de pedido se muestra siempre.</p>
          </fieldset>

          <div v-if="selectedRows.length" class="border-b border-[var(--border)] bg-[var(--canvas)] px-4 py-3">
            <div class="adm-toolbar">
              <p data-wb-selection-count role="status" class="font-semibold text-[var(--text-strong)]">
                {{ selectedRows.length }} pedidos seleccionados
                <span class="font-normal text-[var(--text-muted)]">de esta página</span>
              </p>
              <div class="adm-toolbar__end">
                <button
                  type="button"
                  class="adm-btn adm-btn--ghost adm-btn--sm"
                  :disabled="pending || loading"
                  @click="selectPage"
                >
                  {{
                    selectedRows.length === snapshot.items.length ? 'Quitar selección' : 'Seleccionar toda la página'
                  }}
                </button>
              </div>
            </div>
            <AdminOrderBatchPreparation
              :key="authority"
              class="mt-3"
              :scope-key="authority"
              :enabled="Boolean(authority)"
              :pending="loading || fulfillmentPending || viewsPending || exportPending"
              :order-ids="selectedRows"
              @pending="batchPending = $event"
              @confirmed="batchCompleted = true"
            />
          </div>
          <div v-if="batchCompleted" class="border-b border-[var(--border)] px-4 py-3">
            <UAlert
              role="status"
              color="success"
              variant="subtle"
              icon="i-lucide-circle-check"
              title="Cambios aplicados a los pedidos seleccionados"
              description="Pulsa «Aplicar» en los filtros para ver el listado actualizado."
            />
          </div>

          <div v-if="!snapshot.items.length" data-wb-empty role="status">
            <AdminEmptyState
              v-if="snapshot.pagination.total > 0"
              compact
              title="Esta página no contiene pedidos ahora mismo"
              description="El listado ha cambiado mientras lo consultabas. Vuelve a la página anterior."
            />
            <AdminEmptyState
              v-else-if="isFiltered()"
              variant="filtered"
              title="No hay pedidos que coincidan"
              description="Prueba con otra búsqueda o quita algún filtro."
            >
              <button type="button" class="adm-btn adm-btn--secondary" :disabled="pending || loading" @click="reset">
                Quitar filtros
              </button>
            </AdminEmptyState>
            <AdminEmptyState
              v-else
              icon="i-lucide-package"
              title="No hay pedidos todavía"
              description="Los pedidos aparecerán aquí en cuanto entre el primero."
            />
          </div>
          <div
            v-show="snapshot.items.length"
            class="adm-table-wrap"
            tabindex="0"
            role="region"
            aria-label="Tabla de pedidos con desplazamiento horizontal"
          >
            <table class="adm-table">
              <caption class="sr-only">
                Pedidos que cumplen los filtros aplicados, máximo 25 por página
              </caption>
              <thead>
                <tr>
                  <th scope="col" style="width: 2.5rem">
                    <label class="adm-check"
                      ><span class="sr-only">Selección</span
                      ><input
                        data-wb-select-page
                        type="checkbox"
                        aria-label="Seleccionar pedidos de esta página"
                        :checked="Boolean(snapshot.items.length) && selectedRows.length === snapshot.items.length"
                        :indeterminate="selectedRows.length > 0 && selectedRows.length < snapshot.items.length"
                        :disabled="pending || loading || !snapshot.items.length"
                        @change="selectPage"
                    /></label>
                  </th>
                  <th scope="col">Pedido</th>
                  <th
                    v-for="column in columns"
                    :key="column"
                    scope="col"
                    :data-numeric="column === 'total' ? '' : undefined"
                  >
                    {{ columnLabels[column] }}
                  </th>
                  <th scope="col" data-numeric>Preparación</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="order in snapshot.items"
                  :key="order.id"
                  :data-selected="selectedRows.includes(order.id) || undefined"
                >
                  <td>
                    <input
                      :data-wb-select-order="order.id"
                      type="checkbox"
                      :aria-label="'Seleccionar pedido ' + shortId(order.id)"
                      :checked="selectedRows.includes(order.id)"
                      :disabled="pending || loading"
                      @change="selectRow(order.id)"
                    />
                  </td>
                  <td class="whitespace-nowrap">
                    <NuxtLink
                      :to="'/admin/pedidos/' + order.id"
                      class="font-semibold tabular-nums text-neteco-700 hover:underline"
                      :title="'Pedido ' + order.id"
                      :tabindex="pending ? -1 : undefined"
                      @click="pending && $event.preventDefault()"
                      >{{ shortId(order.id) }}</NuxtLink
                    >
                  </td>
                  <td
                    v-for="column in columns"
                    :key="column"
                    :data-numeric="column === 'total' ? '' : undefined"
                    :class="column === 'createdAt' || column === 'total' ? 'whitespace-nowrap' : 'max-w-64'"
                  >
                    <AdminBadge v-if="cellTone(order, column)" :tone="cellTone(order, column) ?? undefined">
                      {{ cell(order, column) }}
                    </AdminBadge>
                    <template v-else-if="column === 'customer'">
                      <p class="truncate font-medium text-[var(--text-strong)]">{{ order.company || order.name }}</p>
                      <p class="truncate text-xs text-[var(--text-muted)]">
                        <template v-if="order.company">{{ order.name }} · </template>{{ order.lines }}
                        {{ order.lines === 1 ? 'línea' : 'líneas'
                        }}<template v-if="order.city"> · {{ order.city }}</template>
                      </p>
                    </template>
                    <span v-else-if="column === 'total'" class="font-semibold text-[var(--text-strong)]">{{
                      cell(order, column)
                    }}</span>
                    <template v-else>{{ cell(order, column) }}</template>
                  </td>
                  <td data-numeric class="adm-table__actions">
                    <button
                      data-wb-open
                      type="button"
                      :disabled="pending || loading"
                      class="adm-btn adm-btn--secondary adm-btn--sm"
                      @click="open(order.id)"
                    >
                      Preparar
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <nav aria-label="Páginas de pedidos" class="adm-pagination">
            <p>
              {{ snapshot.pagination.total }} {{ snapshot.pagination.total === 1 ? 'pedido' : 'pedidos' }}
              <template v-if="snapshot.pagination.pages > 1">
                · página {{ snapshot.pagination.page }} de {{ snapshot.pagination.pages }}</template
              >
            </p>
            <div class="flex items-center gap-2">
              <button
                data-wb-previous
                type="button"
                class="adm-btn adm-btn--secondary adm-btn--sm"
                :disabled="pending || loading || !snapshot.pagination.previousCursor"
                @click="page(-1)"
              >
                <UIcon name="i-lucide-chevron-left" class="size-4" />Anterior
              </button>
              <button
                data-wb-next
                type="button"
                class="adm-btn adm-btn--secondary adm-btn--sm"
                :disabled="pending || loading || !snapshot.pagination.nextCursor"
                @click="page(1)"
              >
                Siguiente<UIcon name="i-lucide-chevron-right" class="size-4" />
              </button>
            </div>
          </nav>
        </template>
      </div>

      <div v-if="pending" data-wb-pending role="status">
        <UAlert
          color="warning"
          variant="subtle"
          icon="i-lucide-hourglass"
          title="Hay una operación a medias"
          description="Termínala o cancélala antes de cambiar de pedido, de filtros o de página."
        />
      </div>
      <AdminCard
        v-if="selected"
        :title="'Preparación del pedido ' + shortId(selected)"
        aria-label="Pedido abierto para preparación"
      >
        <template #actions>
          <NuxtLink :to="'/admin/pedidos/' + selected" class="adm-btn adm-btn--ghost adm-btn--sm">Ver ficha</NuxtLink>
          <button
            data-wb-close
            type="button"
            :disabled="pending"
            class="adm-btn adm-btn--secondary adm-btn--sm"
            @click="close"
          >
            <UIcon name="i-lucide-x" class="size-4" />Cerrar
          </button>
        </template>
        <OrderFulfillmentSection
          :key="authority + ':' + selected"
          :order-id="selected"
          runtime="cloudflare"
          @pending="fulfillmentPending = $event"
          @confirmed="confirmed"
        />
      </AdminCard>
    </template>
  </section>
</template>
