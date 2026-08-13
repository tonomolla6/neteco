<script setup lang="ts">
import type { AdminOrderSummary } from '~~/shared/types/admin'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Pedidos · Admin' })

const {
  data,
  refresh,
  status: fetchStatus,
  error: fetchError
} = await useFetch<{ items: AdminOrderSummary[] }>('/api/admin/orders')
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

    <AdminOrderTable
      :items="items"
      :loading="fetchStatus === 'pending'"
      :error="fetchError ? 'No se han podido cargar los pedidos.' : undefined"
      @status="setStatus"
      @create-shipment="createShipment"
      @sync-tracking="syncTracking"
      @cancel-shipment="cancelShipment"
    />
  </div>
</template>
