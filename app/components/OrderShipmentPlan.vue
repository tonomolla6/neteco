<script setup lang="ts">
import type { OrderLine, OrderShipmentPlan } from '~/composables/useAccount'
import { formatDeliveryDate } from '~~/shared/delivery-promise'

/**
 * Los envíos de un pedido, como en «Mis pedidos» de Amazon: cada envío con su fecha
 * prevista, su estado y los productos que lleva.
 *
 * El plan es el que el cliente aceptó al comprar (todo junto o un envío por plazo). El
 * estado de cada envío se deduce del estado del pedido: nunca se afirma una salida o una
 * entrega que el pedido no haya registrado.
 */
const props = withDefaults(
  defineProps<{
    plan: OrderShipmentPlan
    lines: OrderLine[]
    /** Estado público del pedido (`pagado`, `enviado`, `entregado`…). */
    status: string
    /** Con miniaturas grandes en el listado de pedidos; compacto en el detalle. */
    size?: 'md' | 'lg'
  }>(),
  { size: 'lg' }
)

const linesBySku = computed(() => new Map(props.lines.map((line) => [line.sku, line])))
const total = computed(() => props.plan.shipments.length)

function eta(shipment: OrderShipmentPlan['shipments'][number]) {
  if (!shipment.to && !shipment.from) return null
  if (shipment.from && shipment.to && shipment.from !== shipment.to)
    return `entre el ${formatDeliveryDate(shipment.from)} y el ${formatDeliveryDate(shipment.to)}`
  return `el ${formatDeliveryDate((shipment.to ?? shipment.from)!)}`
}

/** Estado que se enseña en cada envío, deducido del estado confirmado del pedido. */
function state(shipment: OrderShipmentPlan['shipments'][number]) {
  const later = shipment.index > 0 && shipment.leadDays > 0
  switch (props.status) {
    case 'entregado':
      return { label: 'Entregado', color: 'success' as const, icon: 'i-lucide-check-check' }
    case 'enviado':
      return later && total.value > 1
        ? { label: 'Pendiente de salir', color: 'neutral' as const, icon: 'i-lucide-clock' }
        : { label: 'En camino', color: 'info' as const, icon: 'i-lucide-truck' }
    case 'listo_recogida':
      return { label: 'Listo para recoger', color: 'success' as const, icon: 'i-lucide-package-check' }
    case 'pagado':
    case 'preparando':
      return later
        ? { label: 'Sale cuando llegue al almacén', color: 'neutral' as const, icon: 'i-lucide-clock' }
        : { label: 'En preparación', color: 'info' as const, icon: 'i-lucide-package' }
    case 'cancelado':
    case 'reembolsado':
      return { label: 'Cancelado', color: 'error' as const, icon: 'i-lucide-circle-x' }
    default:
      return { label: 'Se prepara al confirmar el pago', color: 'warning' as const, icon: 'i-lucide-clock' }
  }
}
</script>

<template>
  <div data-order-shipments class="space-y-4">
    <p v-if="total > 1" class="text-sm text-[var(--text-muted)]">
      Elegiste recibirlo en {{ total }} envíos: lo que está en el almacén sale antes.
    </p>
    <section
      v-for="shipment in plan.shipments"
      :key="shipment.index"
      :aria-label="`Envío ${shipment.index + 1} de ${total}`"
      class="rounded-[var(--radius-surface)] border border-[var(--border)]"
    >
      <header
        class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-[var(--border)] bg-[var(--surface-sunken)] px-3 py-2.5 sm:px-4"
      >
        <div class="min-w-0">
          <p v-if="total > 1" class="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
            Envío {{ shipment.index + 1 }} de {{ total }}
          </p>
          <p class="font-semibold text-[var(--text-strong)]">
            <template v-if="status === 'entregado'">Entregado</template>
            <template v-else-if="eta(shipment)">Llega {{ eta(shipment) }}</template>
            <template v-else>Fecha de entrega por confirmar</template>
          </p>
        </div>
        <UBadge :color="state(shipment).color" :icon="state(shipment).icon" variant="subtle">
          {{ state(shipment).label }}
        </UBadge>
      </header>
      <ul class="space-y-3 px-3 py-3 sm:px-4">
        <li v-for="item in shipment.lines" :key="item.sku" class="flex items-start gap-3 sm:gap-4">
          <OrderLineThumb v-if="linesBySku.get(item.sku)" :line="linesBySku.get(item.sku)!" :size="size" />
          <div class="min-w-0 flex-1">
            <component
              :is="linesBySku.get(item.sku)?.slug ? 'NuxtLink' : 'p'"
              :to="
                linesBySku.get(item.sku)?.slug
                  ? `/producto/${linesBySku.get(item.sku)!.slug}?sku=${encodeURIComponent(item.sku)}`
                  : undefined
              "
              class="line-clamp-2 font-medium"
              :class="
                linesBySku.get(item.sku)?.slug ? 'text-[var(--link)] hover:underline' : 'text-[var(--text-strong)]'
              "
            >
              {{ linesBySku.get(item.sku)?.name ?? `Ref. ${item.sku}` }}
            </component>
            <p class="mt-0.5 text-sm text-[var(--text-muted)]">
              <template v-if="linesBySku.get(item.sku)?.format">{{ linesBySku.get(item.sku)!.format }} · </template>Ref.
              {{ item.sku }}
            </p>
            <p class="tabular mt-0.5 text-sm text-[var(--text)]">
              {{ item.quantity }} {{ item.quantity === 1 ? 'unidad' : 'unidades' }}
            </p>
          </div>
        </li>
      </ul>
    </section>
  </div>
</template>
