<script setup lang="ts">
import type { AdminOrderSummary } from '~~/shared/types/admin'

defineProps<{ items: AdminOrderSummary[]; loading?: boolean; error?: string }>()
const emit = defineEmits<{
  status: [order: AdminOrderSummary, event: Event]
  createShipment: [order: AdminOrderSummary]
  syncTracking: [order: AdminOrderSummary]
  cancelShipment: [order: AdminOrderSummary]
}>()
</script>

<template>
  <div class="adm-card adm-tablecard">
    <div v-if="error" class="adm-empty adm-empty--compact adm-empty--error">
      <span class="adm-empty__icon"><UIcon name="i-lucide-triangle-alert" class="size-5" /></span>
      <p role="alert" class="adm-empty__title">{{ error }}</p>
    </div>
    <div v-else-if="loading" role="status" class="adm-table-skeleton" aria-busy="true">
      <span class="sr-only">Cargando pedidos…</span>
      <div v-for="line in 6" :key="line"><i /><i /><i /><i /></div>
    </div>
    <AdminEmptyState
      v-else-if="!items.length"
      icon="i-lucide-package"
      title="Todavía no hay pedidos."
      description="Los pedidos aparecerán aquí en cuanto entre el primero."
    />
    <div v-else class="adm-table-wrap">
      <table class="adm-table min-w-[820px]">
        <thead>
          <tr>
            <th scope="col">Pedido</th>
            <th scope="col">Fecha</th>
            <th scope="col">Cliente</th>
            <th scope="col" data-numeric>Líneas</th>
            <th scope="col" data-numeric>Total</th>
            <th scope="col">Estado</th>
            <th scope="col">Envío</th>
            <th scope="col" data-numeric><span class="sr-only">Ver</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="order in items" :key="order.id">
            <td class="whitespace-nowrap font-semibold tabular-nums text-[var(--text-strong)]" :title="order.id">
              #{{ order.id.slice(0, 8).toUpperCase() }}
            </td>
            <td class="whitespace-nowrap">{{ formatDate(order.createdAt) }}</td>
            <td>
              <p class="font-medium text-[var(--text-strong)]">
                {{ order.name }}<template v-if="order.company"> · {{ order.company }}</template>
              </p>
              <p class="text-xs text-[var(--text-muted)]">{{ order.email }} · {{ order.city }}</p>
            </td>
            <td data-numeric>{{ order.lines }}</td>
            <td data-numeric class="font-semibold text-[var(--text-strong)]">{{ formatPrice(order.total) }}</td>
            <td>
              <select
                :value="order.status"
                :aria-label="`Estado del pedido ${order.id}`"
                class="adm-input"
                @change="emit('status', order, $event)"
              >
                <option v-for="(state, key) in ORDER_STATUS" :key="key" :value="key">{{ state.label }}</option>
              </select>
            </td>
            <td>
              <div v-if="order.shipmentId" class="flex items-center gap-1">
                <AdminButton
                  :to="`/api/admin/shipments/${order.shipmentId}/label`"
                  target="_blank"
                  size="sm"
                  icon="i-lucide-printer"
                  >{{ order.trackingNumber ?? 'Etiqueta' }}</AdminButton
                >
                <AdminButton
                  v-if="!['cancelled', 'delivered'].includes(order.shipmentStatus ?? '')"
                  size="sm"
                  variant="ghost"
                  icon="i-lucide-rotate-cw"
                  label="Actualizar seguimiento"
                  @click="emit('syncTracking', order)"
                />
                <AdminButton
                  v-if="!['cancelled', 'delivered'].includes(order.shipmentStatus ?? '')"
                  size="sm"
                  variant="danger-soft"
                  icon="i-lucide-x"
                  :label="`Cancelar el envío del pedido ${order.id}`"
                  @click="emit('cancelShipment', order)"
                />
                <AdminBadge v-if="order.shipmentStatus === 'cancelled'" tone="danger">Cancelado</AdminBadge>
              </div>
              <AdminButton
                v-else-if="['pagado', 'preparando'].includes(order.status) && order.shippingMethod !== 'recogida'"
                size="sm"
                icon="i-lucide-truck"
                @click="emit('createShipment', order)"
                >Crear envío</AdminButton
              >
              <span v-else class="text-[var(--text-muted)]">—</span>
            </td>
            <td data-numeric>
              <AdminButton
                :to="`/admin/pedidos/${order.id}`"
                size="sm"
                variant="ghost"
                icon="i-lucide-arrow-right"
                label="Abrir el pedido"
              />
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
