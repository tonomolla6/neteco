<script setup lang="ts">
import { z } from 'zod'
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
  processing: 'Procesando',
  authorized: 'Autorizado',
  captured: 'Captura registrada',
  failed: 'Fallido',
  cancelled: 'Cancelado',
  stock_exception: 'Incidencia de stock',
  awaiting_payment: 'Esperando pago',
  pickup: 'Recogida',
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
  if (column === 'total') return (order.total / 100).toLocaleString('es-ES', { style: 'currency', currency: 'EUR' })
  if (column === 'createdAt') return new Date(order.createdAt).toLocaleString('es-ES', { timeZone: 'UTC' }) + ' UTC'
  return labels[order[column]] ?? order[column]
}
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
    const raw: unknown = await request(endpoint, {
      method: 'GET',
      query: { ...query },
      retry: 0,
      cache: 'no-store',
      signal
    })
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
  <section aria-label="Banco de preparación de pedidos" class="min-w-0 space-y-5">
    <h1 class="text-2xl font-semibold">Pedidos · banco de preparación</h1>
    <p class="text-sm">
      Filtra la cola y abre un pedido para confirmar su preparación. Pertenecer a la cola no autoriza una transición.
    </p>
    <p v-if="!authority" role="status">Confirma la sesión, el correo, MFA y los permisos para consultar pedidos.</p>
    <template v-else>
      <AdminOrderViews
        :key="authority"
        :scope-key="authority"
        :enabled="Boolean(authority)"
        :pending="loading || fulfillmentPending || exportPending || batchPending"
        :applied-definition="appliedDefinition"
        @apply="applyView"
        @pending="viewsPending = $event"
      />
      <form data-wb-form class="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-4" @submit.prevent="apply">
        <label class="min-w-0"
          >Pedido, cliente o NIF/CIF<input
            v-model="filters.query"
            data-wb-query
            :disabled="pending || loading"
            type="search"
            class="w-full min-w-0 rounded border p-2"
        /></label>
        <label v-for="(options, field) in values" :key="field" class="min-w-0">
          {{
            {
              bucket: 'Cola',
              payment: 'Estado de pago',
              order: 'Estado de pedido',
              shipping: 'Entrega',
              customer: 'Tipo de cliente',
              sort: 'Ordenar por',
              direction: 'Dirección'
            }[field]
          }}
          <select
            v-model="filters[field]"
            :data-wb-bucket="field === 'bucket' ? '' : undefined"
            :data-wb-payment="field === 'payment' ? '' : undefined"
            :data-wb-order="field === 'order' ? '' : undefined"
            :data-wb-shipping="field === 'shipping' ? '' : undefined"
            :data-wb-customer="field === 'customer' ? '' : undefined"
            :data-wb-sort="field === 'sort' ? '' : undefined"
            :data-wb-direction="field === 'direction' ? '' : undefined"
            :disabled="pending || loading"
            class="w-full min-w-0 rounded border p-2"
          >
            <option v-if="['payment', 'order', 'shipping', 'customer'].includes(field)" value="">Todos</option>
            <option v-for="option in options" :key="option" :value="option">{{ labels[option] }}</option>
          </select>
        </label>
        <label
          >Desde<input
            v-model="filters.from"
            data-wb-from
            type="date"
            :disabled="pending || loading"
            class="w-full min-w-0 rounded border p-2"
        /></label>
        <label
          >Hasta<input
            v-model="filters.to"
            data-wb-to
            type="date"
            :disabled="pending || loading"
            class="w-full min-w-0 rounded border p-2"
        /></label>
        <div class="flex flex-wrap items-end gap-2">
          <button data-wb-apply type="submit" :disabled="pending || loading" class="rounded border px-4 py-2">
            Aplicar filtros</button
          ><button
            data-wb-reset
            type="button"
            :disabled="pending || loading"
            class="rounded border px-4 py-2"
            @click="reset"
          >
            Restablecer
          </button>
        </div>
      </form>
      <p v-if="validation" data-wb-validation role="alert">
        Revisa la búsqueda y el intervalo de fechas antes de consultar.
      </p>
      <p v-if="loading" data-wb-loading role="status">Confirmando cola de pedidos…</p>
      <div v-else-if="failed" data-wb-error role="alert">
        No se ha podido confirmar la cola de pedidos. No se interpreta como una cola vacía.
        <button data-wb-retry type="button" :disabled="pending" class="underline" @click="read(lastQuery)">
          Reintentar consulta
        </button>
      </div>
      <template v-else-if="snapshot">
        <AdminOrderExport
          v-if="!fulfillmentPending && !viewsPending && !batchPending && appliedExportQuery"
          :scope-key="authority"
          :enabled="Boolean(authority)"
          :pending="loading || fulfillmentPending || viewsPending || batchPending"
          :applied-query="appliedExportQuery"
          @pending="exportPending = $event"
        />
        <p>
          {{ snapshot.pagination.total }} pedidos · Página {{ snapshot.pagination.page }} de
          {{ snapshot.pagination.pages }}
        </p>
        <p v-if="!snapshot.items.length" data-wb-empty role="status">
          {{
            snapshot.pagination.total > 0
              ? 'Esta página no contiene pedidos actualmente. Los resultados pueden cambiar; vuelve a la página anterior para consultar los pedidos actuales.'
              : 'No hay pedidos para estos filtros confirmados.'
          }}
        </p>
        <p v-if="selectedRows.length" data-wb-selection-count role="status">
          {{ selectedRows.length }} pedidos seleccionados de esta página · no se seleccionan todos los resultados.
        </p>
        <AdminOrderBatchPreparation
          v-if="selectedRows.length"
          :key="authority"
          :scope-key="authority"
          :enabled="Boolean(authority)"
          :pending="loading || fulfillmentPending || viewsPending || exportPending"
          :order-ids="selectedRows"
          @pending="batchPending = $event"
          @confirmed="batchCompleted = true"
        />
        <p v-if="batchCompleted" role="status">
          Resultados del grupo confirmados. Consulta la cola explícitamente para actualizar los estados de los pedidos.
        </p>
        <fieldset class="flex flex-wrap gap-3">
          <legend>Columnas visibles · el enlace al pedido siempre permanece</legend>
          <label v-for="column in ADMIN_ORDER_VIEW_COLUMNS" :key="column"
            ><input
              type="checkbox"
              :data-wb-column="column"
              :checked="columns.includes(column)"
              :disabled="pending || loading || (columns.length === 1 && columns.includes(column))"
              @change="toggleColumn(column)"
            />{{ columnLabels[column] }}</label
          >
        </fieldset>
        <div
          class="max-w-full overflow-x-auto"
          tabindex="0"
          role="region"
          aria-label="Tabla de pedidos con desplazamiento horizontal"
        >
          <table class="w-full border-collapse text-left text-sm">
            <caption class="sr-only">
              Pedidos de los filtros confirmados, máximo 25 por página
            </caption>
            <thead>
              <tr>
                <th scope="col">
                  <label
                    >Selección<input
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
                <th v-for="column in columns" :key="column" scope="col">{{ columnLabels[column] }}</th>
                <th scope="col">Preparación</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="order in snapshot.items" :key="order.id" class="border-b align-top">
                <td class="p-2">
                  <input
                    :data-wb-select-order="order.id"
                    type="checkbox"
                    :aria-label="'Seleccionar pedido ' + order.id"
                    :checked="selectedRows.includes(order.id)"
                    :disabled="pending || loading"
                    @change="selectRow(order.id)"
                  />
                </td>
                <th scope="row" class="max-w-52 break-all p-2 font-normal">
                  <NuxtLink
                    :to="'/admin/pedidos/' + order.id"
                    class="block break-all underline"
                    :tabindex="pending ? -1 : undefined"
                    @click="pending && $event.preventDefault()"
                    >Pedido {{ order.id }}</NuxtLink
                  >
                </th>
                <td v-for="column in columns" :key="column" class="max-w-52 break-words p-2">
                  {{ cell(order, column) }}
                </td>
                <td class="p-2">
                  <button
                    data-wb-open
                    type="button"
                    :disabled="pending || loading"
                    class="rounded border px-4 py-2"
                    @click="open(order.id)"
                  >
                    Abrir preparación
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <nav aria-label="Páginas de pedidos" class="flex flex-wrap gap-3">
          <button
            data-wb-previous
            type="button"
            :disabled="pending || loading || !snapshot.pagination.previousCursor"
            @click="page(-1)"
          >
            Anterior</button
          ><button
            data-wb-next
            type="button"
            :disabled="pending || loading || !snapshot.pagination.nextCursor"
            @click="page(1)"
          >
            Siguiente
          </button>
        </nav>
      </template>
      <p v-if="pending" data-wb-pending role="status">
        Hay una intención pendiente. Confírmala, cancélala antes de enviarla o recupera su resultado antes de cambiar de
        contexto.
      </p>
      <section
        v-if="selected"
        class="min-w-0 space-y-3 rounded-xl border p-4"
        aria-label="Pedido abierto para preparación"
      >
        <h2 class="break-all font-semibold">Preparación de {{ selected }}</h2>
        <button data-wb-close type="button" :disabled="pending" class="rounded border px-4 py-2" @click="close">
          Cerrar preparación
        </button>
        <OrderFulfillmentSection
          :key="authority + ':' + selected"
          :order-id="selected"
          runtime="cloudflare"
          @pending="fulfillmentPending = $event"
          @confirmed="confirmed"
        />
      </section>
    </template>
  </section>
</template>
