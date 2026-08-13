<script setup lang="ts">
import type { AdminOrderSummary } from '~~/shared/types/admin'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Pedidos · Admin' })

const { data, refresh } = await useFetch<{ items: AdminOrderSummary[] }>('/api/admin/orders')
const items = computed(() => data.value?.items ?? [])

const toast = useToast()
async function setStatus(order: AdminOrderSummary, event: Event) {
  const status = (event.target as HTMLSelectElement).value
  const reason = window.prompt(
    `Motivo obligatorio para cambiar ${order.id} a ${ORDER_STATUS[status]?.label ?? status}:`
  )
  if (!reason?.trim() || reason.trim().length < 3) {
    toast.add({ title: 'El cambio necesita un motivo de al menos 3 caracteres', color: 'warning' })
    refresh()
    return
  }
  try {
    await $fetch(`/api/admin/orders/${order.id}`, { method: 'PUT', body: { status, reason: reason.trim() } })
    toast.add({
      title: `Pedido ${order.id} → ${ORDER_STATUS[status]?.label ?? status}`,
      icon: 'i-lucide-check',
      color: 'success'
    })
    refresh()
  } catch (error) {
    toast.add({
      title: apiErrorMessage(error, 'No se ha podido cambiar el estado'),
      color: 'error',
      icon: 'i-lucide-alert-circle'
    })
    refresh()
  }
}

async function createShipment(order: AdminOrderSummary) {
  const suggested = order.shippingMethod === 'reparto' ? 'OWN-DAY' : 'STANDARD-PARCEL'
  const serviceCode = window.prompt('Código de servicio cotizado:', suggested)?.trim()
  if (!serviceCode) return
  try {
    await $fetch(`/api/admin/orders/${order.id}/shipment`, { method: 'POST', body: { serviceCode } })
    toast.add({ title: `Expedición creada para ${order.id}`, color: 'success', icon: 'i-lucide-truck' })
    await refresh()
  } catch (error) {
    toast.add({ title: apiErrorMessage(error, 'No se ha podido crear la expedición'), color: 'error' })
  }
}

async function syncTracking(order: AdminOrderSummary) {
  try {
    await $fetch(`/api/admin/shipments/${order.shipmentId}/tracking`, { method: 'POST' })
    toast.add({ title: 'Tracking sincronizado', color: 'success' })
    await refresh()
  } catch (error) {
    toast.add({ title: apiErrorMessage(error, 'No se ha podido sincronizar'), color: 'error' })
  }
}

async function cancelShipment(order: AdminOrderSummary) {
  const reason = window.prompt(`Motivo para cancelar la expedición de ${order.id}:`)?.trim()
  if (!reason || reason.length < 3) {
    toast.add({ title: 'La cancelación necesita un motivo de al menos 3 caracteres', color: 'warning' })
    return
  }
  try {
    await $fetch(`/api/admin/shipments/${order.shipmentId}/cancel`, { method: 'POST', body: { reason } })
    toast.add({ title: `Expedición de ${order.id} cancelada`, color: 'success' })
    await refresh()
  } catch (error) {
    toast.add({ title: apiErrorMessage(error, 'No se ha podido cancelar la expedición'), color: 'error' })
  }
}
</script>

<template>
  <div>
    <h1 class="text-2xl font-bold text-slate-900">Pedidos</h1>

    <div class="mt-4 overflow-x-auto rounded-2xl border border-slate-200 bg-white">
      <table class="w-full min-w-[820px] text-sm">
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
          <tr v-for="o in items" :key="o.id" class="border-b border-slate-100 last:border-0 hover:bg-slate-50">
            <td class="px-4 py-2.5 font-mono text-xs text-slate-700">{{ o.id }}</td>
            <td class="px-4 py-2.5 text-slate-600">{{ formatDate(o.createdAt) }}</td>
            <td class="px-4 py-2.5">
              <p class="font-medium text-slate-800">
                {{ o.name }}<template v-if="o.company"> · {{ o.company }}</template>
              </p>
              <p class="text-xs text-slate-500">{{ o.email }} · {{ o.city }}</p>
            </td>
            <td class="px-4 py-2.5 text-center text-slate-600">{{ o.lines }}</td>
            <td class="px-4 py-2.5 text-right font-medium text-slate-800">{{ formatPrice(o.total) }}</td>
            <td class="px-4 py-2.5">
              <select
                :value="o.status"
                :aria-label="`Estado del pedido ${o.id}`"
                class="rounded-lg border border-slate-300 bg-white px-2 py-1 text-sm text-slate-700 focus:border-neteco-500 focus:outline-none"
                @change="setStatus(o, $event)"
              >
                <option v-for="(s, key) in ORDER_STATUS" :key="key" :value="key">{{ s.label }}</option>
              </select>
            </td>
            <td class="px-4 py-2.5">
              <div v-if="o.shipmentId" class="flex items-center gap-1">
                <UButton
                  :to="`/api/admin/shipments/${o.shipmentId}/label`"
                  target="_blank"
                  size="xs"
                  variant="soft"
                  icon="i-lucide-printer"
                >
                  {{ o.trackingNumber ?? 'Etiqueta' }}
                </UButton>
                <UButton
                  v-if="!['cancelled', 'delivered'].includes(o.shipmentStatus ?? '')"
                  size="xs"
                  variant="ghost"
                  icon="i-lucide-refresh-cw"
                  aria-label="Sincronizar tracking"
                  @click="syncTracking(o)"
                />
                <UButton
                  v-if="!['cancelled', 'delivered'].includes(o.shipmentStatus ?? '')"
                  size="xs"
                  color="error"
                  variant="ghost"
                  icon="i-lucide-x"
                  :aria-label="`Cancelar expedición ${o.id}`"
                  @click="cancelShipment(o)"
                />
                <UBadge v-if="o.shipmentStatus === 'cancelled'" size="xs" color="error" variant="soft">
                  Cancelada
                </UBadge>
              </div>
              <UButton
                v-else-if="['pagado', 'preparando'].includes(o.status) && o.shippingMethod !== 'recogida'"
                size="xs"
                variant="outline"
                icon="i-lucide-truck"
                @click="createShipment(o)"
              >
                Crear
              </UButton>
              <span v-else class="text-slate-400">—</span>
            </td>
            <td class="px-4 py-2.5 text-right">
              <UButton
                :to="`/pedido/${o.id}`"
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
  </div>
</template>
