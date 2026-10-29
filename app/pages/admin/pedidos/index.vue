<script setup lang="ts">
import type { AdminOrderSummary } from '~~/shared/types/admin'
import type { Column } from '~/components/ui/DataTable.vue'
import AdminOrderWorkbench from '~/components/AdminOrderWorkbench.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Pedidos · Admin' })

/**
 * Listado operativo de pedidos.
 *
 * La versión anterior era una tabla sin búsqueda, sin filtros, sin orden, sin
 * paginación, sin selección múltiple y sin recuento, con el estado del pedido
 * editable como un `<select>` suelto en cada fila y el motivo del cambio pedido con
 * `window.prompt()`.
 *
 * Aquí el estado se lee en la tabla y se cambia desde una acción explícita, con un
 * diálogo que dice qué pedido, de qué estado a cuál, y valida el motivo en su sitio.
 */
const toast = useToast()
const cloudflare = useRuntimeConfig().public.serverRuntime === 'cloudflare'

const query = ref('')
const page = ref(1)
const perPage = 25
const bucket = ref<'todos' | 'por_preparar' | 'por_cobrar' | 'incidencia'>('todos')
const sortKey = ref('createdAt')
const sortDir = ref<'asc' | 'desc'>('desc')
const selected = ref<string[]>([])
const requestQuery = computed(() => ({
  q: query.value,
  page: page.value,
  perPage,
  bucket: bucket.value,
  sortKey: sortKey.value,
  sortDir: sortDir.value
}))
const {
  data,
  refresh,
  status: fetchStatus
} = cloudflare
  ? { data: ref(null), refresh: async () => {}, status: ref('idle') }
  : await useFetch<{
      items: AdminOrderSummary[]
      pagination?: { total: number; page: number; perPage: number; pages: number }
      capabilities?: { orderStatusUpdate: boolean; shipments: boolean; tracking: boolean; fulfillmentRead?: boolean }
    }>('/api/admin/orders', { query: requestQuery })
const canChangeState = computed(() => data.value?.capabilities?.orderStatusUpdate ?? !data.value?.pagination)
const canShip = computed(() => data.value?.capabilities?.shipments ?? !data.value?.pagination)
const canReadPreparation = computed(() => data.value?.capabilities?.fulfillmentRead === true || canShip.value)

const BUCKETS = computed(() => [
  { label: 'Todos', value: 'todos' },
  { label: 'Por preparar', value: 'por_preparar', disabled: !canReadPreparation.value },
  { label: 'Esperando cobro', value: 'por_cobrar' },
  { label: 'Con incidencia', value: 'incidencia' }
])

const filtered = computed(() => {
  if (data.value?.pagination) return data.value.items
  const term = query.value.toLowerCase()
  const rows = (data.value?.items ?? []).filter((order) => {
    const matchesBucket =
      bucket.value === 'todos' ||
      (bucket.value === 'por_preparar' &&
        order.paymentStatus === 'captured' &&
        order.fulfillmentStatus === 'pending') ||
      (bucket.value === 'por_cobrar' && order.paymentStatus === 'pending') ||
      (bucket.value === 'incidencia' && ['cancelado', 'reembolso_parcial', 'reembolsado'].includes(order.status))
    const matchesTerm =
      !term ||
      order.id.toLowerCase().includes(term) ||
      order.name.toLowerCase().includes(term) ||
      order.email.toLowerCase().includes(term) ||
      (order.company ?? '').toLowerCase().includes(term)
    return matchesBucket && matchesTerm
  })

  const direction = sortDir.value === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    const key = sortKey.value as keyof AdminOrderSummary
    const left = a[key]
    const right = b[key]
    if (typeof left === 'number' && typeof right === 'number') return (left - right) * direction
    return String(left).localeCompare(String(right), 'es') * direction
  })
})

const paged = computed(() =>
  data.value?.pagination ? filtered.value : filtered.value.slice((page.value - 1) * perPage, page.value * perPage)
)
const total = computed(() => data.value?.pagination?.total ?? filtered.value.length)
watch([query, bucket], () => (page.value = 1))
watch([sortKey, sortDir], () => (page.value = 1))
watch(page, () => {
  selected.value = []
})

const columns: Column<AdminOrderSummary>[] = [
  { key: 'id', label: 'Pedido', sortable: true },
  { key: 'createdAt', label: 'Fecha', sortable: true },
  { key: 'name', label: 'Cliente', sortable: true },
  { key: 'total', label: 'Total', numeric: true, sortable: true },
  { key: 'status', label: 'Estado' },
  { key: 'shipment', label: 'Expedición', hideOnMobile: true }
]

/* --- Cambio de estado, explícito --------------------------------------- */
const changing = ref<AdminOrderSummary | null>(null)
const nextStatus = ref('')
const reason = ref('')
const saving = ref(false)
const reasonError = computed(() =>
  reason.value.trim().length && reason.value.trim().length < 3 ? 'El motivo necesita al menos 3 caracteres.' : ''
)

const statusOptions = computed(() =>
  Object.entries(ORDER_STATUS).map(([value, meta]) => ({ label: meta.label, value }))
)

function startChange(order: AdminOrderSummary) {
  if (!canChangeState.value) return
  changing.value = order
  nextStatus.value = order.status
  reason.value = ''
}

async function confirmChange() {
  const order = changing.value
  if (!canChangeState.value || !order || reason.value.trim().length < 3 || nextStatus.value === order.status) return
  saving.value = true
  try {
    await $fetch(`/api/admin/orders/${order.id}`, {
      method: 'PUT',
      body: { status: nextStatus.value, reason: reason.value.trim() }
    })
    toast.add({
      title: `${order.id} → ${ORDER_STATUS[nextStatus.value]?.label ?? nextStatus.value}`,
      icon: 'i-lucide-check',
      color: 'success'
    })
    changing.value = null
    await refresh()
  } catch (error) {
    toast.add({
      title: apiErrorMessage(error, 'No se ha podido cambiar el estado'),
      color: 'error',
      icon: 'i-lucide-alert-circle'
    })
  } finally {
    saving.value = false
  }
}

/* --- Expedición --------------------------------------------------------- */
const shipping = ref<AdminOrderSummary | null>(null)
const serviceCode = ref('')

function startShipment(order: AdminOrderSummary) {
  if (!canShip.value) return
  shipping.value = order
  serviceCode.value = order.shippingMethod === 'reparto' ? 'OWN-DAY' : 'STANDARD-PARCEL'
}

async function confirmShipment() {
  const order = shipping.value
  if (!canShip.value || !order || !serviceCode.value.trim()) return
  saving.value = true
  try {
    await $fetch(`/api/admin/orders/${order.id}/shipment`, {
      method: 'POST',
      body: { serviceCode: serviceCode.value.trim() }
    })
    toast.add({ title: `Expedición creada para ${order.id}`, color: 'success', icon: 'i-lucide-truck' })
    shipping.value = null
    await refresh()
  } catch (error) {
    toast.add({ title: apiErrorMessage(error, 'No se ha podido crear la expedición'), color: 'error' })
  } finally {
    saving.value = false
  }
}

async function syncTracking(order: AdminOrderSummary) {
  if (data.value?.capabilities?.tracking === false) return
  try {
    await $fetch(`/api/admin/shipments/${order.shipmentId}/tracking`, { method: 'POST' })
    toast.add({ title: 'Seguimiento actualizado', color: 'success' })
    await refresh()
  } catch (error) {
    toast.add({ title: apiErrorMessage(error, 'No se ha podido sincronizar'), color: 'error' })
  }
}

function meta(status: string) {
  return ORDER_STATUS[status] ?? ORDER_STATUS.pendiente_pago!
}
</script>

<template>
  <AdminOrderWorkbench v-if="cloudflare" />
  <div v-else>
    <UiPageHeader
      title="Pedidos"
      :count="total"
      :count-label="total === 1 ? 'pedido' : 'pedidos'"
      description="Estado de cobro, preparación y expedición de cada pedido."
    />

    <UiDataTable
      v-model:selected="selected"
      :rows="paged"
      :columns="columns"
      :row-key="(row) => row.id"
      :status="fetchStatus === 'pending' ? 'pending' : fetchStatus === 'error' ? 'error' : 'idle'"
      :total="total"
      :page="page"
      :per-page="perPage"
      selectable
      search-placeholder="Buscar por pedido, cliente o email"
      empty-title="Todavía no hay pedidos"
      empty-description="Los pedidos aparecerán aquí en cuanto entre el primero."
      error-message="No hemos podido cargar los pedidos."
      @search="(value) => (query = value)"
      @sort="({ key, direction }) => ((sortKey = key), (sortDir = direction))"
      @update:page="(value) => (page = value)"
      @retry="refresh()"
    >
      <template #filters>
        <USelect v-model="bucket" :items="BUCKETS" class="w-56" aria-label="Filtrar por situación" />
      </template>

      <template #bulk-actions>
        <UButton size="xs" color="neutral" variant="outline" icon="i-lucide-printer" disabled>
          Imprimir etiquetas
        </UButton>
        <UButton size="xs" color="neutral" variant="outline" icon="i-lucide-download" disabled>Exportar</UButton>
      </template>

      <template #cell-id="{ row }">
        <NuxtLink :to="`/admin/pedidos/${row.id}`" class="tabular font-medium text-neteco-700 hover:underline">
          {{ row.id }}
        </NuxtLink>
      </template>

      <template #cell-createdAt="{ row }">
        <span class="text-[var(--text-muted)]">{{ formatDate(row.createdAt) }}</span>
      </template>

      <template #cell-name="{ row }">
        <p class="font-medium text-[var(--text-strong)]">
          {{ row.company || row.name }}
        </p>
        <p class="max-w-[18rem] truncate text-xs text-[var(--text-muted)]">
          {{ formatPlace(row.city) }} · {{ row.lines }} {{ row.lines === 1 ? 'línea' : 'líneas' }}
        </p>
      </template>

      <template #cell-total="{ row }">
        <span class="font-semibold">{{ formatPrice(row.total) }}</span>
      </template>

      <template #cell-status="{ row }">
        <UBadge :color="meta(row.status).color" :icon="meta(row.status).icon" variant="subtle">
          {{ meta(row.status).label }}
        </UBadge>
      </template>

      <template #cell-shipment="{ row }">
        <div v-if="row.shipmentId" class="flex items-center gap-1">
          <UButton
            :to="`/api/admin/shipments/${row.shipmentId}/label`"
            target="_blank"
            external
            size="xs"
            variant="soft"
            icon="i-lucide-printer"
          >
            {{ row.trackingNumber ?? 'Etiqueta' }}
          </UButton>
          <UButton
            size="xs"
            color="neutral"
            variant="ghost"
            icon="i-lucide-refresh-cw"
            aria-label="Actualizar seguimiento"
            @click="syncTracking(row)"
          />
        </div>
        <UButton
          v-else-if="canShip"
          size="xs"
          color="neutral"
          variant="outline"
          icon="i-lucide-truck"
          @click="startShipment(row)"
        >
          Crear
        </UButton>
        <span v-else class="text-xs text-[var(--text-muted)]">No disponible</span>
      </template>

      <template #row-actions="{ row }">
        <UButton
          v-if="canChangeState"
          size="xs"
          color="neutral"
          variant="outline"
          icon="i-lucide-pencil"
          :aria-label="`Cambiar el estado del pedido ${row.id}`"
          @click="startChange(row)"
        >
          <span class="sr-only md:not-sr-only">Estado</span>
        </UButton>
        <UButton
          :to="`/admin/pedidos/${row.id}`"
          size="xs"
          color="neutral"
          variant="ghost"
          icon="i-lucide-arrow-right"
          :aria-label="`Abrir la ficha del pedido ${row.id}`"
        />
      </template>
    </UiDataTable>
    <p v-if="data?.capabilities && !canShip" class="mt-3 text-sm text-[var(--text-muted)]">
      Consulta de pedidos y cobros. La expedición y los cambios de estado no están habilitados en este entorno.
    </p>

    <UModal
      :open="Boolean(changing)"
      title="Cambiar el estado del pedido"
      @update:open="(value) => !value && (changing = null)"
    >
      <template #body>
        <div v-if="changing" class="space-y-4">
          <p class="text-[var(--text)]">
            Pedido <span class="tabular font-semibold">{{ changing.id }}</span> de
            <span class="font-semibold">{{ changing.name }}</span
            >, por <span class="tabular font-semibold">{{ formatPrice(changing.total) }}</span
            >.
          </p>

          <div class="flex items-center gap-3 rounded-[var(--radius-surface)] bg-[var(--surface-sunken)] p-3">
            <UBadge :color="meta(changing.status).color" variant="subtle">{{ meta(changing.status).label }}</UBadge>
            <UIcon name="i-lucide-arrow-right" class="size-4 text-[var(--text-muted)]" />
            <UBadge :color="meta(nextStatus).color" variant="subtle">{{ meta(nextStatus).label }}</UBadge>
          </div>

          <UFormField label="Nuevo estado" required>
            <USelect v-model="nextStatus" :items="statusOptions" class="w-full" />
          </UFormField>

          <UFormField
            label="Motivo del cambio"
            required
            hint="Queda registrado en la auditoría con tu usuario"
            :error="reasonError"
          >
            <UTextarea
              v-model="reason"
              class="w-full"
              :rows="2"
              placeholder="Por ejemplo: cobro confirmado por transferencia"
            />
          </UFormField>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="changing = null">Cancelar</UButton>
          <UButton
            :disabled="reason.trim().length < 3 || nextStatus === changing?.status"
            :loading="saving"
            @click="confirmChange"
          >
            Cambiar estado
          </UButton>
        </div>
      </template>
    </UModal>

    <UModal :open="Boolean(shipping)" title="Crear expedición" @update:open="(value) => !value && (shipping = null)">
      <template #body>
        <div v-if="shipping" class="space-y-4">
          <p class="text-[var(--text)]">
            Pedido <span class="tabular font-semibold">{{ shipping.id }}</span> ·
            {{ SHIPPING_METHODS.find((m) => m.value === shipping!.shippingMethod)?.label ?? shipping.shippingMethod }}
          </p>
          <UFormField label="Código de servicio cotizado" required>
            <UInput v-model="serviceCode" class="w-full font-mono" />
          </UFormField>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="shipping = null">Cancelar</UButton>
          <UButton :disabled="!serviceCode.trim()" :loading="saving" @click="confirmShipment">
            Crear expedición
          </UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
