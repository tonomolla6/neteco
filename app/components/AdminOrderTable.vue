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
  <div class="mt-4 overflow-x-auto rounded-2xl border border-slate-200 bg-white">
    <p v-if="error" role="alert" class="px-4 py-8 text-center text-red-700">{{ error }}</p>
    <p v-else-if="loading" role="status" class="px-4 py-8 text-center text-slate-500">Cargando pedidos…</p>
    <table v-else class="w-full min-w-[820px] text-sm">
      <thead>
        <tr class="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
          <th class="px-4 py-3">Pedido</th>
          <th class="px-4 py-3">Fecha</th>
          <th class="px-4 py-3">Cliente</th>
          <th class="px-4 py-3 text-center">Líneas</th>
          <th class="px-4 py-3 text-right">Total</th>
          <th class="px-4 py-3">Estado</th>
          <th class="px-4 py-3">Expedición</th>
          <th class="px-4 py-3 text-right">Ver</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="order in items" :key="order.id" class="border-b border-slate-100 last:border-0 hover:bg-slate-50">
          <td class="px-4 py-2.5 font-mono text-xs text-slate-700">{{ order.id }}</td>
          <td class="px-4 py-2.5 text-slate-600">{{ formatDate(order.createdAt) }}</td>
          <td class="px-4 py-2.5">
            <p class="font-medium text-slate-800">
              {{ order.name }}<template v-if="order.company"> · {{ order.company }}</template>
            </p>
            <p class="text-xs text-slate-500">{{ order.email }} · {{ order.city }}</p>
          </td>
          <td class="px-4 py-2.5 text-center text-slate-600">{{ order.lines }}</td>
          <td class="px-4 py-2.5 text-right font-medium text-slate-800">{{ formatPrice(order.total) }}</td>
          <td class="px-4 py-2.5">
            <select
              :value="order.status"
              :aria-label="`Estado del pedido ${order.id}`"
              class="rounded-lg border border-slate-300 bg-white px-2 py-1 text-sm text-slate-700 focus:border-neteco-500 focus:outline-none"
              @change="emit('status', order, $event)"
            >
              <option v-for="(state, key) in ORDER_STATUS" :key="key" :value="key">{{ state.label }}</option>
            </select>
          </td>
          <td class="px-4 py-2.5">
            <div v-if="order.shipmentId" class="flex items-center gap-1">
              <UButton
                :to="`/api/admin/shipments/${order.shipmentId}/label`"
                target="_blank"
                size="xs"
                variant="soft"
                icon="i-lucide-printer"
                >{{ order.trackingNumber ?? 'Etiqueta' }}</UButton
              >
              <UButton
                v-if="!['cancelled', 'delivered'].includes(order.shipmentStatus ?? '')"
                size="xs"
                variant="ghost"
                icon="i-lucide-refresh-cw"
                aria-label="Sincronizar tracking"
                @click="emit('syncTracking', order)"
              />
              <UButton
                v-if="!['cancelled', 'delivered'].includes(order.shipmentStatus ?? '')"
                size="xs"
                color="error"
                variant="ghost"
                icon="i-lucide-x"
                :aria-label="`Cancelar expedición ${order.id}`"
                @click="emit('cancelShipment', order)"
              />
              <UBadge v-if="order.shipmentStatus === 'cancelled'" size="xs" color="error" variant="soft">
                Cancelada
              </UBadge>
            </div>
            <UButton
              v-else-if="['pagado', 'preparando'].includes(order.status) && order.shippingMethod !== 'recogida'"
              size="xs"
              variant="outline"
              icon="i-lucide-truck"
              @click="emit('createShipment', order)"
              >Crear</UButton
            >
            <span v-else class="text-slate-400">—</span>
          </td>
          <td class="px-4 py-2.5 text-right">
            <UButton
              :to="`/pedido/${order.id}`"
              target="_blank"
              size="xs"
              variant="soft"
              icon="i-lucide-external-link"
              aria-label="Ver pedido"
            />
          </td>
        </tr>
        <tr v-if="!items.length">
          <td colspan="8" class="px-4 py-10 text-center text-slate-500">Todavía no hay pedidos.</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
