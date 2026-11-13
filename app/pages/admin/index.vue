<script setup lang="ts">
import type { AdminStats } from '~~/shared/types/admin'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Panel de administración' })
const serverRuntime = useRuntimeConfig().public.serverRuntime
const cloudflare = serverRuntime === 'cloudflare'
const node = serverRuntime === 'node'

/**
 * Panel de excepciones (UI-004).
 *
 * La versión anterior mostraba cinco contadores de inventario —cuántos productos,
 * cuántas variantes, cuántas familias— y debajo un bloque de documentación técnica
 * explicando `npm run db:migrate` y `npm run db:backup`, que ocupaba el 70 % de la
 * pantalla principal del panel.
 *
 * Contar productos no es una tarea. Quien abre el panel a las ocho de la mañana
 * necesita saber **qué está bloqueado y espera una decisión suya**. Ese dato ya lo
 * calculaba `GET /api/admin/operations`, pero vivía enterrado en el decimotercer
 * enlace del menú. Aquí es lo primero de la pantalla, y cada excepción lleva al
 * sitio donde se resuelve.
 */
const {
  data: stats,
  refresh: refreshStats,
  status: statsStatus
} = await useFetch<
  AdminStats & {
    source?: string
    awaitingPayment?: number
    paidOrders?: number
    readyToShip?: number | null
    capabilities?: { shipments: boolean }
  }
>('/api/admin/stats')
const {
  data: ops,
  status,
  refresh
} = await useFetch<{
  source?: string
  summary: {
    queueDepth: number
    deadLetters: number | null
    supportOverdue: number | null
    fiscalExceptions: number
    staleRefunds: number | null
    inventoryExceptions: number | null
    staleShipments: number | null
    communicationFailures: number | null
    bankTransfersPendingReview: number | null
    emailDeliveryExceptions?: number
  }
  capabilities?: Record<string, boolean>
  generatedAt: string
}>('/api/admin/operations')

const {
  data: orders,
  refresh: refreshOrders,
  status: ordersStatus
} = await useFetch<{
  items: Array<{
    id: string
    status: string
    paymentStatus: string
    fulfillmentStatus: string
    total: number
    createdAt: string
    name?: string | null
    company?: string | null
  }>
  pagination?: { total: number }
}>('/api/admin/orders', { query: { perPage: 100 } })

/**
 * Cada excepción declara su umbral de gravedad y dónde se resuelve.
 * `critical` es lo que cuesta dinero o incumple un plazo; `warning` es lo que
 * conviene mirar hoy. Sin esta distinción, «3» y «300» se leen igual.
 */
const EXCEPTIONS = [
  {
    key: 'bankTransfersPendingReview' as const,
    label: 'Transferencias por conciliar',
    hint: 'Cobros recibidos que nadie ha casado con su pedido',
    to: '/admin/operaciones',
    severity: 'critical' as const
  },
  {
    key: 'staleRefunds' as const,
    label: 'Reembolsos atascados',
    hint: 'Solicitados hace más de 30 minutos y sin procesar',
    to: '/admin/devoluciones',
    severity: 'critical' as const
  },
  {
    key: 'fiscalExceptions' as const,
    label: 'Facturas con incidencia',
    hint: 'Falladas o pendientes de validación fiscal',
    to: '/admin/operaciones',
    severity: 'critical' as const
  },
  {
    key: 'supportOverdue' as const,
    label: 'Soporte fuera de plazo',
    hint: 'Tickets que han pasado su compromiso de respuesta',
    to: '/admin/soporte',
    severity: 'critical' as const
  },
  {
    key: 'staleShipments' as const,
    label: 'Envíos sin movimiento',
    hint: 'Más de 48 h sin cambio de estado del transportista',
    to: '/admin/pedidos',
    severity: 'warning' as const
  },
  {
    key: 'inventoryExceptions' as const,
    label: 'Incidencias de inventario',
    hint: 'Saldos, reservas o pedidos que requieren revisión',
    to: '/admin/operaciones',
    severity: 'warning' as const
  },
  {
    key: 'deadLetters' as const,
    label: 'Mensajes muertos en cola',
    hint: 'Procesos que han agotado sus reintentos',
    to: '/admin/operaciones',
    severity: 'warning' as const
  },
  {
    key: 'emailDeliveryExceptions' as const,
    label: 'Entrega de emails bloqueada',
    hint: 'Eventos de correo que requieren revisión del transporte',
    to: '/admin/operaciones',
    severity: 'warning' as const
  },
  {
    key: 'communicationFailures' as const,
    label: 'Emails rebotados',
    hint: 'Rebotes y quejas de las últimas 24 h',
    to: '/admin/operaciones',
    severity: 'warning' as const
  }
]

function observedCount(key: (typeof EXCEPTIONS)[number]['key']): number | null {
  if (status.value !== 'success' || !ops.value || (!node && (!cloudflare || ops.value.source !== 'cloudflare')))
    return null
  const capability = ops.value.capabilities?.[key]
  if (cloudflare ? capability !== true : capability === false) return null
  const count = ops.value.summary?.[key]
  return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : null
}
const hasObservedExceptions = computed(() => EXCEPTIONS.some((item) => observedCount(item.key) !== null))
const active = computed(() => EXCEPTIONS.filter((item) => (observedCount(item.key) ?? 0) > 0))
const criticalCount = computed(() => active.value.filter((item) => item.severity === 'critical').length)

const statsVerified = computed(
  () =>
    statsStatus.value === 'success' && !!stats.value && (node || (cloudflare && stats.value.source === 'cloudflare'))
)
function statCount(key: keyof AdminStats | 'awaitingPayment' | 'readyToShip'): number | null {
  if (!statsVerified.value) return null
  const count = stats.value?.[key]
  return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : null
}
const awaitingPayment = computed(() => {
  const observed = statCount('awaitingPayment')
  if (!node || stats.value?.capabilities) return observed
  return (
    observed ??
    (statsVerified.value && ordersStatus.value === 'success'
      ? (orders.value?.items.filter((order) => order.paymentStatus === 'pending').length ?? null)
      : null)
  )
})
const readyToShip = computed(() => {
  // No D1 fulfillment queue exists in this stage. A DTO flag cannot enable it.
  if (!node || stats.value?.capabilities?.shipments === false) return null
  return (
    statCount('readyToShip') ??
    (statsVerified.value && ordersStatus.value === 'success'
      ? (orders.value?.items.filter(
          (order) => order.paymentStatus === 'captured' && order.fulfillmentStatus === 'pending'
        ).length ?? null)
      : null)
  )
})
async function refreshDashboard() {
  await Promise.all([refresh(), refreshStats(), refreshOrders()])
}

const catalogue = computed(() => [
  { label: 'Productos', value: statCount('products'), to: '/admin/productos' },
  { label: 'Referencias', value: statCount('variants'), to: '/admin/productos' },
  { label: 'Familias', value: statCount('categories'), to: '/admin/categorias' },
  { label: 'Clientes', value: statCount('users'), to: '/admin/clientes' }
])

/* ── Ventas: se calculan sobre los pedidos reales más recientes (hasta 100). ── */
const navigation = useAdminNavigation()
const DAY = 86_400_000
const dayKey = (value: number | string) => new Date(value).toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' })
const ordersReady = computed(() => ordersStatus.value === 'success' && Array.isArray(orders.value?.items))
const valid = computed(() =>
  (orders.value?.items ?? []).filter((order) => !['cancelado', 'cancelled'].includes(order.status))
)
/** El periodo alcanza hasta donde llega la muestra cargada; si hay más pedidos se avisa. */
const partial = computed(() => (orders.value?.pagination?.total ?? 0) > (orders.value?.items.length ?? 0))
const now = useState('admin-home-now', () => Date.now())
function period(from: number, to: number) {
  const rows = valid.value.filter((order) => {
    const time = Date.parse(order.createdAt)
    return time >= from && time < to
  })
  const sales = rows.reduce((sum, order) => sum + order.total, 0)
  const buyers = new Set(rows.map((order) => order.company || order.name || order.id))
  return { orders: rows.length, sales, ticket: rows.length ? sales / rows.length : null, buyers: buyers.size }
}
const week = computed(() => period(now.value - 7 * DAY, now.value + DAY))
const previousWeek = computed(() => period(now.value - 14 * DAY, now.value - 7 * DAY))
const today = computed(() => {
  const key = dayKey(now.value)
  const rows = valid.value.filter((order) => dayKey(order.createdAt) === key)
  return { orders: rows.length, sales: rows.reduce((sum, order) => sum + order.total, 0) }
})
function change(current: number | null, before: number | null) {
  return current === null || before === null || before === 0 ? null : (current - before) / before
}
const kpis = computed(() => {
  if (!ordersReady.value) return null
  return [
    {
      label: 'Ventas, últimos 7 días',
      icon: 'i-lucide-banknote',
      value: adminMoney(week.value.sales),
      delta: change(week.value.sales, previousWeek.value.sales),
      hint: `Hoy: ${adminMoney(today.value.sales)}`
    },
    {
      label: 'Pedidos, últimos 7 días',
      icon: 'i-lucide-receipt-text',
      value: week.value.orders.toLocaleString('es-ES'),
      delta: change(week.value.orders, previousWeek.value.orders),
      hint: `Hoy: ${today.value.orders}`
    },
    {
      label: 'Ticket medio',
      icon: 'i-lucide-shopping-basket',
      value: week.value.ticket === null ? '—' : adminMoney(week.value.ticket),
      delta: change(week.value.ticket, previousWeek.value.ticket),
      hint: 'Por pedido'
    },
    {
      label: 'Clientes que han comprado',
      icon: 'i-lucide-users',
      value: week.value.buyers.toLocaleString('es-ES'),
      delta: change(week.value.buyers, previousWeek.value.buyers),
      hint: statCount('users') === null ? '' : `${statCount('users')} cuentas en total`
    }
  ]
})
const salesByDay = computed(() => {
  const totals = new Map<string, number>()
  for (const order of valid.value) {
    const key = dayKey(order.createdAt)
    totals.set(key, (totals.get(key) ?? 0) + order.total)
  }
  return Array.from({ length: 30 }, (_, index) => {
    const date = new Date(now.value - (29 - index) * DAY)
    return {
      label: date.toLocaleDateString('es-ES', { day: 'numeric', month: 'short', timeZone: 'Europe/Madrid' }),
      detail: date.toLocaleDateString('es-ES', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        timeZone: 'Europe/Madrid'
      }),
      value: totals.get(dayKey(date.getTime())) ?? 0
    }
  })
})
const monthSales = computed(() => salesByDay.value.reduce((sum, day) => sum + day.value, 0))
const byStatus = computed(() => {
  const counts = new Map<string, number>()
  for (const order of orders.value?.items ?? []) counts.set(order.status, (counts.get(order.status) ?? 0) + 1)
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([status, value]) => ({ label: ORDER_STATUS[status]?.label ?? adminStatusLabel(status), value }))
})
const latest = computed(() => (orders.value?.items ?? []).slice(0, 8))
const STATUS_TONE: Record<string, 'neutral' | 'success' | 'warning' | 'danger' | 'info'> = {
  warning: 'warning',
  success: 'success',
  error: 'danger',
  info: 'info',
  primary: 'info',
  neutral: 'neutral'
}
const orderColumns = [
  { key: 'id', label: 'Pedido' },
  { key: 'customer', label: 'Cliente', hideOnMobile: true },
  { key: 'createdAt', label: 'Fecha', hideOnMobile: true },
  { key: 'status', label: 'Estado' },
  { key: 'total', label: 'Importe', numeric: true }
]
const tasks = computed(() =>
  [
    {
      label: 'Pedidos por preparar',
      hint: 'Pagados y pendientes de expedir',
      value: readyToShip.value,
      to: '/admin/pedidos',
      icon: 'i-lucide-package-check'
    },
    {
      label: 'Pedidos esperando cobro',
      hint: 'Sin pago confirmado',
      value: statsStatus.value === 'error' ? null : awaitingPayment.value,
      to: '/admin/pedidos',
      icon: 'i-lucide-hourglass'
    },
    ...active.value.map((item) => ({
      label: item.label,
      hint: item.hint,
      value: observedCount(item.key),
      to: item.to,
      icon: item.severity === 'critical' ? 'i-lucide-octagon-alert' : 'i-lucide-triangle-alert',
      severity: item.severity
    }))
  ].filter((task) => task.value !== null)
)
const shortcuts = computed(() =>
  navigation.tree.value
    .filter((section) => section.id !== 'inicio')
    .map((section) => ({
      ...section,
      links: section.items.map((item) => ({ label: item.label, to: item.tabs[0]!.to }))
    }))
)
</script>

<template>
  <AdminPage>
    <template #actions>
      <AdminButton icon="i-lucide-rotate-cw" @click="refreshDashboard()">Actualizar</AdminButton>
      <AdminButton v-if="node" variant="primary" to="/admin/productos/nuevo" icon="i-lucide-plus">
        Nuevo producto
      </AdminButton>
      <AdminButton v-else variant="primary" to="/admin/pedidos" icon="i-lucide-receipt-text">Ver pedidos</AdminButton>
    </template>

    <div class="adm-stack">
      <!-- Cifras clave de la semana frente a la anterior -->
      <div v-if="kpis" class="adm-grid">
        <AdminStat
          v-for="kpi in kpis"
          :key="kpi.label"
          :label="kpi.label"
          :icon="kpi.icon"
          :value="kpi.value"
          :delta="kpi.delta"
          :hint="kpi.hint"
        />
      </div>
      <div v-else-if="ordersStatus === 'pending'" class="adm-grid" aria-hidden="true">
        <div
          v-for="row in 4"
          :key="row"
          class="h-28 animate-pulse rounded-[var(--radius-surface)] bg-[var(--surface-sunken)]"
        />
      </div>
      <AdminCard v-else>
        <AdminEmptyState
          compact
          variant="error"
          title="No hemos podido cargar las ventas"
          description="Vuelve a intentarlo en unos segundos."
        >
          <AdminButton icon="i-lucide-rotate-cw" @click="refreshOrders()">Reintentar</AdminButton>
        </AdminEmptyState>
      </AdminCard>

      <div class="grid gap-5 xl:grid-cols-3">
        <AdminCard
          class="xl:col-span-2"
          title="Ventas por día"
          :description="`Últimos 30 días · ${adminMoney(monthSales)}${partial ? ' · calculado sobre los 100 pedidos más recientes' : ''}`"
        >
          <AdminChart
            :points="salesByDay"
            :format="(value: number) => adminMoney(value)"
            summary="Ventas diarias de los últimos 30 días, impuestos incluidos."
          />
        </AdminCard>

        <AdminCard title="Pedidos por estado" description="Sobre los pedidos más recientes">
          <AdminBreakdown v-if="byStatus.length" :items="byStatus" />
          <AdminEmptyState v-else compact icon="i-lucide-receipt-text" title="Aún no hay pedidos" />
        </AdminCard>
      </div>

      <div class="grid gap-5 xl:grid-cols-3">
        <div class="xl:col-span-2">
          <AdminSection title="Últimos pedidos">
            <template #actions>
              <AdminButton size="sm" to="/admin/pedidos">Ver todos</AdminButton>
            </template>
            <AdminTable
              :rows="latest"
              :columns="orderColumns"
              :row-key="(row) => row.id"
              :row-to="(row) => `/admin/pedidos/${row.id}`"
              :status="ordersStatus === 'pending' ? 'pending' : ordersStatus === 'error' ? 'error' : 'idle'"
              :per-page="8"
              empty-title="Aún no hay pedidos"
              empty-description="Cuando entre el primer pedido aparecerá aquí."
              empty-icon="i-lucide-receipt-text"
              caption="Últimos pedidos recibidos"
              @retry="refreshOrders()"
            >
              <template #cell-id="{ row }">
                <NuxtLink
                  :to="`/admin/pedidos/${row.id}`"
                  class="font-semibold whitespace-nowrap text-[var(--link)] hover:underline"
                >
                  #{{ row.id.slice(0, 8).toUpperCase() }}
                </NuxtLink>
              </template>
              <template #cell-customer="{ row }">{{ row.company || row.name || '—' }}</template>
              <template #cell-createdAt="{ row }">
                <span class="whitespace-nowrap">{{ adminDate(row.createdAt, true) }}</span>
              </template>
              <template #cell-status="{ row }">
                <AdminBadge :tone="STATUS_TONE[ORDER_STATUS[row.status]?.color ?? 'neutral'] ?? 'neutral'">
                  {{ ORDER_STATUS[row.status]?.label ?? adminStatusLabel(row.status) }}
                </AdminBadge>
              </template>
              <template #cell-total="{ row }">
                <span class="whitespace-nowrap">{{ adminMoney(row.total) }}</span>
              </template>
            </AdminTable>
          </AdminSection>
        </div>

        <AdminSection title="Tareas pendientes">
          <template v-if="hasObservedExceptions" #actions>
            <span class="adm-help">
              Comprobado a las
              {{
                new Date(ops!.generatedAt).toLocaleTimeString('es-ES', {
                  hour: '2-digit',
                  minute: '2-digit',
                  timeZone: 'Europe/Madrid'
                })
              }}
            </span>
          </template>
          <AdminCard flush>
            <AdminEmptyState
              v-if="status === 'error'"
              compact
              variant="error"
              title="No hemos podido comprobar el estado de la tienda"
              description="Sin este dato no se sabe qué está bloqueado."
            >
              <AdminButton icon="i-lucide-rotate-cw" @click="refresh()">Reintentar</AdminButton>
            </AdminEmptyState>
            <template v-else>
              <ul class="adm-tasks">
                <li v-for="task in tasks" :key="task.label">
                  <NuxtLink :to="task.to" class="adm-task">
                    <span
                      class="adm-task__count"
                      :data-tone="!task.value ? 'none' : 'severity' in task ? task.severity : 'info'"
                    >
                      {{ task.value }}
                    </span>
                    <span class="min-w-0 flex-1">
                      <span class="adm-task__label">{{ task.label }}</span>
                      <span class="adm-task__hint">{{ task.hint }}</span>
                    </span>
                    <UIcon name="i-lucide-chevron-right" class="size-4 shrink-0 text-[var(--text-muted)]" />
                  </NuxtLink>
                </li>
              </ul>
              <AdminEmptyState
                v-if="!tasks.length"
                compact
                icon="i-lucide-circle-check"
                title="Nada pendiente"
                description="No hay pedidos ni incidencias esperando una decisión."
              />
              <p v-else-if="!active.length && hasObservedExceptions" class="adm-tasks__note">
                <UIcon name="i-lucide-circle-check" class="size-4 text-emerald-700" />
                Sin incidencias en los procesos revisados.
              </p>
              <p v-if="criticalCount" class="adm-tasks__note">
                {{ criticalCount }}
                {{ criticalCount === 1 ? 'incidencia crítica' : 'incidencias críticas' }}: cuestan dinero o incumplen un
                plazo.
              </p>
            </template>
          </AdminCard>
        </AdminSection>
      </div>

      <AdminSection title="Catálogo y clientes">
        <div class="adm-grid">
          <AdminStat
            v-for="card in catalogue"
            :key="card.label"
            :label="card.label"
            :value="card.value"
            :to="card.to"
          />
        </div>
      </AdminSection>

      <AdminSection v-if="shortcuts.length" title="Accesos rápidos" description="Todas las secciones del panel.">
        <div class="adm-shortcuts">
          <AdminCard v-for="section in shortcuts" :key="section.id">
            <p class="adm-shortcuts__title"><UIcon :name="section.icon" class="size-4" />{{ section.label }}</p>
            <ul>
              <li v-for="link in section.links" :key="link.to">
                <NuxtLink :to="link.to">{{ link.label }}</NuxtLink>
              </li>
            </ul>
          </AdminCard>
        </div>
      </AdminSection>
    </div>
  </AdminPage>
</template>
