<script setup lang="ts">
import type { OrderSummary } from '~/composables/useAccount'

definePageMeta({ middleware: 'auth', layout: 'cuenta' })
useSeoMeta({ title: 'Mis pedidos', robots: 'noindex, nofollow' })

const { data, refresh, status } = await useFetch<unknown>('/api/orders', { method: 'GET' })
const cancellationCloudflare = useRuntimeConfig().public.serverRuntime === 'cloudflare'
const cancellationOwners = ref<string[]>([])
const reorderActivity = ref(false)
const cancellationPending = computed(() => cancellationCloudflare && cancellationOwners.value.length > 0)
function onCancellationPending(id: string, value: boolean) {
  if (!cancellationCloudflare) return
  cancellationOwners.value = value
    ? [...new Set([...cancellationOwners.value, id])]
    : cancellationOwners.value.filter((owner) => owner !== id)
}
function confirmCancellationNavigation() {
  return (
    !cancellationPending.value ||
    (import.meta.client &&
      window.confirm(
        'Hay una cancelación pendiente de confirmar. Su recuperación sólo está disponible en esta pestaña; si sales perderás su intención y clave. ¿Quieres salir?'
      ))
  )
}
onBeforeRouteLeave(confirmCancellationNavigation)
onBeforeRouteUpdate(confirmCancellationNavigation)
function beforeCancellationUnload(event: BeforeUnloadEvent) {
  if (cancellationPending.value) {
    event.preventDefault()
    event.returnValue = ''
  }
}
onMounted(() => window.addEventListener('beforeunload', beforeCancellationUnload))
onBeforeUnmount(() => window.removeEventListener('beforeunload', beforeCancellationUnload))
async function cancellationConfirmed(id: string) {
  if (!active || !cancellationCloudflare || !confirmedOrders.value?.some((order) => order.id === id) || pendingRead)
    return
  onCancellationPending(id, false)
  pendingRead = true
  retryingRead.value = true
  failedRead.value = false
  const request = ++generation
  try {
    await refresh()
  } catch {
    if (active && request === generation) failedRead.value = true
  } finally {
    if (active && request === generation) {
      pendingRead = false
      retryingRead.value = false
    }
  }
}

function plainOwn(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  const keys = Reflect.ownKeys(value)
  return (
    (prototype === Object.prototype || prototype === null) &&
    keys.length <= 16 &&
    keys.every((key) => {
      if (typeof key !== 'string') return false
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      return !!descriptor && descriptor.enumerable && Object.hasOwn(descriptor, 'value')
    })
  )
}
function validInstant(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(value)) return false
  const parsed = new Date(value)
  return (
    Number.isFinite(parsed.getTime()) &&
    (parsed.toISOString() === value || parsed.toISOString().replace('.000Z', 'Z') === value)
  )
}
function readOrders(value: unknown): OrderSummary[] | null {
  if (!plainOwn(value) || !Object.hasOwn(value, 'orders') || !Array.isArray(value.orders)) return null
  const list = value.orders
  if (
    Object.getPrototypeOf(list) !== Array.prototype ||
    list.length > 200 ||
    Reflect.ownKeys(list).length !== list.length + 1
  )
    return null
  const orders: OrderSummary[] = []
  const ids = new Set<string>()
  for (let index = 0; index < list.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(list, String(index))
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return null
    const order: unknown = descriptor.value
    if (
      !plainOwn(order) ||
      !['id', 'status', 'total', 'createdAt', 'lines'].every((key) => Object.hasOwn(order, key)) ||
      typeof order.id !== 'string' ||
      !order.id ||
      order.id.length > 256 ||
      order.id.trim() !== order.id ||
      ids.has(order.id) ||
      [...order.id].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ||
      typeof order.status !== 'string' ||
      !Object.hasOwn(ORDER_STATUS, order.status) ||
      typeof order.total !== 'number' ||
      !Number.isSafeInteger(order.total) ||
      order.total < 0 ||
      typeof order.lines !== 'number' ||
      !Number.isSafeInteger(order.lines) ||
      order.lines < 0 ||
      !validInstant(order.createdAt) ||
      ['invoiceAvailable', 'fullDetailAvailable'].some(
        (key) => Object.hasOwn(order, key) && typeof order[key] !== 'boolean'
      )
    )
      return null
    ids.add(order.id)
    const summary: OrderSummary = {
      id: order.id,
      status: order.status,
      total: order.total,
      createdAt: order.createdAt,
      lines: order.lines
    }
    if (Object.hasOwn(order, 'invoiceAvailable') && typeof order.invoiceAvailable === 'boolean')
      summary.invoiceAvailable = order.invoiceAvailable
    if (Object.hasOwn(order, 'fullDetailAvailable') && typeof order.fullDetailAvailable === 'boolean')
      summary.fullDetailAvailable = order.fullDetailAvailable
    orders.push(summary)
  }
  return orders
}
const retryingRead = ref(false)
const failedRead = ref(false)
let active = true
let pendingRead = false
let pendingReorder = false
let generation = 0
let reorderOrderId: string | null = null
const confirmedOrders = computed(() =>
  !pendingRead && !retryingRead.value && !failedRead.value && status.value === 'success' ? readOrders(data.value) : null
)
const readState = computed(() =>
  retryingRead.value || status.value === 'idle' || status.value === 'pending'
    ? 'loading'
    : confirmedOrders.value !== null
      ? 'success'
      : 'error'
)
async function retryRead() {
  if (!active || pendingRead || readState.value !== 'error') return
  pendingRead = true
  retryingRead.value = true
  failedRead.value = false
  const request = ++generation
  try {
    await refresh()
  } catch {
    if (active && request === generation) failedRead.value = true
  } finally {
    if (active && request === generation) {
      pendingRead = false
      retryingRead.value = false
    }
  }
}

const dialog = useTemplateRef('dialog')
const notice = ref('')
const query = ref('')
/**
 * Pestañas como las de «Mis pedidos» de Amazon: grupos que el cliente entiende, no los trece
 * estados internos. «Para devolver» es la entrada del bloque Devoluciones de la portada.
 */
const ORDER_TABS = [
  { value: 'todos', label: 'Todos', statuses: null },
  {
    value: 'en-curso',
    label: 'En curso',
    statuses: [
      'pendiente_pago',
      'procesando_pago',
      'pago_fallido',
      'incidencia_stock',
      'pendiente_transferencia',
      'pagado',
      'preparando',
      'listo_recogida',
      'enviado'
    ]
  },
  { value: 'entregados', label: 'Entregados', statuses: ['entregado'] },
  {
    value: 'devolver',
    label: 'Para devolver',
    statuses: ['enviado', 'entregado', 'listo_recogida', 'reembolso_parcial']
  },
  { value: 'cancelados', label: 'Cancelados', statuses: ['cancelado', 'reembolsado', 'reembolso_parcial'] }
] as const
const route = useRoute()
const initialTab = ORDER_TABS.find((tab) => tab.value === route.query.estado)?.value ?? 'todos'
const statusFilter = ref<string>(initialTab)
const activeTab = computed(() => ORDER_TABS.find((tab) => tab.value === statusFilter.value) ?? ORDER_TABS[0])
function tabCount(tab: (typeof ORDER_TABS)[number]) {
  const all = confirmedOrders.value ?? []
  return tab.statuses
    ? all.filter((order) => (tab.statuses as readonly string[]).includes(order.status)).length
    : all.length
}

const orders = computed(() => {
  const term = query.value.trim().toLowerCase()
  const statuses = activeTab.value.statuses as readonly string[] | null
  return (confirmedOrders.value ?? []).filter((order) => {
    const matchesStatus = !statuses || statuses.includes(order.status)
    const matchesTerm = !term || order.id.toLowerCase().includes(term)
    return matchesStatus && matchesTerm
  })
})

async function startReorder(id: unknown) {
  if (
    cancellationPending.value ||
    !active ||
    pendingReorder ||
    pendingRead ||
    readState.value !== 'success' ||
    typeof id !== 'string' ||
    !confirmedOrders.value?.some((order) => order.id === id) ||
    !dialog.value
  )
    return
  pendingReorder = true
  reorderOrderId = id
  notice.value = ''
  try {
    await dialog.value.start(id)
  } catch {
    /* The existing dialog owns the safe GET error/retry state. */
  } finally {
    if (active) pendingReorder = false
  }
}
function onAdded(count: number) {
  if (
    !active ||
    readState.value !== 'success' ||
    !reorderOrderId ||
    !confirmedOrders.value?.some((order) => order.id === reorderOrderId) ||
    !Number.isSafeInteger(count) ||
    count < 1
  )
    return
  notice.value = `${count} ${count === 1 ? 'referencia añadida' : 'referencias añadidas'} al carrito.`
}
onBeforeUnmount(() => {
  active = false
  ++generation
  reorderOrderId = null
})
</script>

<template>
  <div :aria-busy="readState === 'loading'">
    <UiPageHeader
      title="Mis pedidos"
      :count="readState === 'success' ? confirmedOrders?.length : undefined"
      count-label="en total"
      description="Sigue tus envíos, repite una compra, descarga la factura o solicita una devolución."
    />

    <AccountFeedback v-if="readState === 'success'" :notice="notice" />

    <div
      v-if="readState === 'success' && confirmedOrders?.length"
      class="mb-5 flex flex-col gap-3 border-b border-[var(--border)] lg:flex-row lg:items-end lg:justify-between"
    >
      <div
        role="tablist"
        aria-label="Filtrar pedidos"
        class="-mb-px flex gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <button
          v-for="tab in ORDER_TABS"
          :key="tab.value"
          type="button"
          role="tab"
          :aria-selected="statusFilter === tab.value"
          :disabled="cancellationPending"
          class="flex min-h-11 shrink-0 items-center gap-1.5 border-b-2 px-3 text-[15px] font-medium transition-colors"
          :class="
            statusFilter === tab.value
              ? 'border-[var(--action)] text-[var(--text-strong)]'
              : 'border-transparent text-[var(--link)] hover:text-[var(--action-hover)]'
          "
          @click="statusFilter = tab.value"
        >
          {{ tab.label }}
          <span class="tabular text-xs text-[var(--text-muted)]">{{ tabCount(tab) }}</span>
        </button>
      </div>
      <UInput
        v-model="query"
        :disabled="cancellationPending"
        icon="i-lucide-search"
        placeholder="Buscar por número de pedido"
        aria-label="Buscar por número de pedido"
        class="w-full pb-2 lg:w-72"
      />
    </div>
    <p
      v-if="readState === 'success' && statusFilter === 'devolver' && orders.length"
      class="mb-4 rounded-[var(--radius-control)] border border-neteco-200 bg-neteco-50 px-4 py-3 text-sm text-[var(--text)]"
    >
      Elige el pedido y pulsa <strong>Devolver productos</strong>. Si eres consumidor, tienes 14 días naturales desde la
      entrega.
      <NuxtLink to="/devoluciones" class="font-medium text-[var(--link)] underline"
        >Cómo funcionan las devoluciones</NuxtLink
      >
    </p>

    <div v-if="readState === 'loading'" role="status" class="space-y-3">
      <p class="sr-only">Cargando tus pedidos.</p>
      <div
        v-for="row in 4"
        :key="row"
        class="h-24 animate-pulse rounded-[var(--radius-surface)] bg-[var(--surface-sunken)]"
        aria-hidden="true"
      />
    </div>

    <UiSurface v-else-if="readState === 'error'" padding="none" role="alert">
      <UiEmptyState
        variant="error"
        title="No hemos podido cargar tus pedidos"
        description="Vuelve a intentar la consulta para obtener tus pedidos actualizados."
      >
        <UButton type="button" icon="i-lucide-rotate-cw" :disabled="retryingRead" @click="retryRead"
          >Reintentar</UButton
        >
      </UiEmptyState>
    </UiSurface>

    <UiSurface v-else-if="!confirmedOrders?.length" padding="none">
      <UiEmptyState
        icon="i-lucide-package"
        title="Todavía no tienes pedidos"
        description="Cuando hagas tu primer pedido aparecerá aquí y podrás consultar su contenido o volver a pedirlo."
      >
        <UButton to="/catalogo" icon="i-lucide-arrow-right" trailing>Ver el catálogo</UButton>
      </UiEmptyState>
    </UiSurface>

    <UiSurface v-else-if="!orders.length" padding="none">
      <UiEmptyState
        variant="filtered"
        icon="i-lucide-filter"
        title="No hay pedidos en esta vista"
        description="Prueba con otro número o vuelve a ver todos tus pedidos."
      >
        <UButton
          color="neutral"
          variant="outline"
          @click="
            () => {
              query = ''
              statusFilter = 'todos'
            }
          "
        >
          Ver todos los pedidos
        </UButton>
      </UiEmptyState>
    </UiSurface>

    <div v-else class="space-y-4">
      <AccountOrderRow
        v-for="order in orders"
        :key="order.id"
        :order="order"
        :operation-pending="
          cancellationCloudflare && (reorderActivity || cancellationOwners.some((id) => id !== order.id))
        "
        :navigation-managed="cancellationCloudflare"
        @reorder="startReorder"
        @pending="onCancellationPending(order.id, $event)"
        @confirmed="cancellationConfirmed"
      />
    </div>

    <ReorderDialog
      v-if="readState === 'success' && confirmedOrders?.length"
      :key="JSON.stringify(confirmedOrders?.map((order) => order.id))"
      ref="dialog"
      @added="onAdded"
      @activity="reorderActivity = $event"
    />
  </div>
</template>
