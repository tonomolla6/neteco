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
  }>
}>('/api/admin/orders')

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
</script>

<template>
  <div>
    <UiPageHeader title="Hoy" description="Lo que está bloqueado y espera una decisión.">
      <template #actions>
        <UButton color="neutral" variant="outline" icon="i-lucide-rotate-cw" @click="refreshDashboard()"
          >Actualizar</UButton
        >
        <UButton v-if="node" to="/admin/productos/nuevo" icon="i-lucide-plus">Nuevo producto</UButton>
      </template>
    </UiPageHeader>

    <!-- Cola de trabajo: los dos montones que hay que vaciar cada día -->
    <div class="grid gap-4 grid-cols-1 sm:grid-cols-2">
      <NuxtLink
        to="/admin/pedidos"
        class="rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--surface)] p-5 transition-colors hover:border-neteco-300"
      >
        <div class="flex items-center gap-2 text-[var(--text-muted)]">
          <UIcon name="i-lucide-package-check" class="size-4" />
          <span class="text-sm font-medium">Pagados y sin expedir</span>
        </div>
        <p class="tabular mt-2 font-display text-4xl font-bold text-[var(--text-strong)]">{{ readyToShip ?? '—' }}</p>
        <p class="mt-1 text-sm text-[var(--text-muted)]">
          {{
            readyToShip === null
              ? 'Expedición no disponible en este entorno'
              : readyToShip
                ? 'Listos para preparar en almacén'
                : 'Nada pendiente de preparar'
          }}
        </p>
      </NuxtLink>

      <NuxtLink
        to="/admin/pedidos"
        class="rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--surface)] p-5 transition-colors hover:border-neteco-300"
      >
        <div class="flex items-center gap-2 text-[var(--text-muted)]">
          <UIcon name="i-lucide-hourglass" class="size-4" />
          <span class="text-sm font-medium">Esperando cobro</span>
        </div>
        <p class="tabular mt-2 font-display text-4xl font-bold text-[var(--text-strong)]">
          {{ statsStatus === 'error' ? '—' : (awaitingPayment ?? '—') }}
        </p>
        <p class="mt-1 text-sm text-[var(--text-muted)]">
          {{
            awaitingPayment === null || statsStatus === 'error'
              ? 'Recuento no disponible'
              : awaitingPayment
                ? 'Pedidos sin pago confirmado'
                : 'No hay pedidos esperando cobro'
          }}
        </p>
      </NuxtLink>
    </div>

    <!-- Excepciones -->
    <section class="mt-8">
      <div class="flex flex-wrap items-baseline justify-between gap-3 pb-3">
        <h2 class="text-lg font-bold text-[var(--text-strong)]">Excepciones</h2>
        <p v-if="hasObservedExceptions" class="text-sm text-[var(--text-muted)]">
          Comprobado a las
          {{
            new Date(ops!.generatedAt).toLocaleTimeString('es-ES', {
              hour: '2-digit',
              minute: '2-digit',
              timeZone: 'Europe/Madrid'
            })
          }}
        </p>
      </div>

      <div v-if="status === 'pending'" class="grid gap-3 grid-cols-1 sm:grid-cols-2">
        <div
          v-for="row in 4"
          :key="row"
          class="h-24 animate-pulse rounded-[var(--radius-panel)] bg-[var(--surface-sunken)]"
        />
      </div>

      <UiSurface v-else-if="status === 'error'" padding="none">
        <UiEmptyState
          variant="error"
          title="No hemos podido comprobar el estado de la tienda"
          description="Sin este dato no se puede saber qué está bloqueado. Vuelve a intentarlo."
        >
          <UButton icon="i-lucide-rotate-cw" @click="refresh()">Reintentar</UButton>
        </UiEmptyState>
      </UiSurface>

      <UiSurface v-else-if="!hasObservedExceptions" padding="none">
        <UiEmptyState
          icon="i-lucide-circle-help"
          title="Estado de los procesos no disponible"
          description="No hay contadores de incidencias verificables. No se puede confirmar que todo esté resuelto."
        >
          <UButton icon="i-lucide-rotate-cw" @click="refresh()">Reintentar</UButton>
        </UiEmptyState>
      </UiSurface>

      <UiSurface v-else-if="!active.length" padding="none">
        <UiEmptyState
          icon="i-lucide-circle-check"
          :title="cloudflare ? 'Sin incidencias en los procesos observados' : 'No hay nada bloqueado'"
          :description="
            cloudflare
              ? 'Revisados únicamente los contadores disponibles. Consulta Operaciones para conocer los procesos sin cobertura.'
              : 'Ningún reembolso atascado, ninguna transferencia sin conciliar y ningún ticket fuera de plazo.'
          "
        />
      </UiSurface>

      <div v-else class="grid gap-3 grid-cols-1 sm:grid-cols-2">
        <NuxtLink
          v-for="item in active"
          :key="item.key"
          :to="item.to"
          class="flex items-start gap-4 rounded-[var(--radius-panel)] border bg-[var(--surface)] p-4 transition-colors"
          :class="
            item.severity === 'critical'
              ? 'border-red-200 hover:border-red-400'
              : 'border-amber-200 hover:border-amber-400'
          "
        >
          <span
            class="tabular flex size-11 shrink-0 items-center justify-center rounded-[var(--radius-surface)] text-lg font-bold"
            :class="item.severity === 'critical' ? 'bg-red-50 text-red-800' : 'bg-amber-50 text-amber-900'"
          >
            {{ ops!.summary[item.key] }}
          </span>
          <div class="min-w-0">
            <p class="font-semibold text-[var(--text-strong)]">{{ item.label }}</p>
            <p class="mt-0.5 text-sm text-[var(--text-muted)]">{{ item.hint }}</p>
          </div>
        </NuxtLink>
      </div>

      <p v-if="criticalCount" class="mt-3 text-sm text-[var(--text-muted)]">
        {{ criticalCount }} {{ criticalCount === 1 ? 'excepción crítica' : 'excepciones críticas' }}: cuestan dinero o
        incumplen un plazo comprometido.
      </p>
    </section>

    <!-- El inventario del catálogo pasa al final: es contexto, no una tarea -->
    <section class="mt-8">
      <h2 class="pb-3 text-lg font-bold text-[var(--text-strong)]">Catálogo</h2>
      <div class="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        <NuxtLink
          v-for="card in catalogue"
          :key="card.label"
          :to="card.to"
          class="rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--surface)] px-4 py-3 transition-colors hover:border-neteco-300"
        >
          <p class="tabular font-display text-2xl font-bold text-[var(--text-strong)]">{{ card.value ?? '—' }}</p>
          <p class="text-sm text-[var(--text-muted)]">{{ card.label }}</p>
        </NuxtLink>
      </div>
    </section>
  </div>
</template>
