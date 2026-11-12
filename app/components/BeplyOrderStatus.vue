<script setup lang="ts">
import { computed } from 'vue'
import { beplyOrderViewSchema, type BeplyOrderView } from '~~/shared/beply-orders'

/** Parent supplies an authorized private response and clears it on every
 * account/order change, as it already does for OrderTrackingPanel. */
const props = defineProps<{ view: BeplyOrderView | null; pending?: boolean; failed?: boolean }>()
const snapshot = computed(() => {
  if (props.pending || props.failed) return null
  const checked = beplyOrderViewSchema.safeParse(props.view)
  return checked.success ? checked.data : null
})
const date = (instant: string) =>
  new Intl.DateTimeFormat('es-ES', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Europe/Madrid'
  }).format(new Date(instant))
</script>

<template>
  <section aria-label="Estado y documentación del pedido" class="space-y-3 rounded-2xl border border-slate-200 p-5">
    <h3 class="font-semibold">Estado y documentación del pedido</h3>
    <p v-if="pending" role="status">Consultando el pedido…</p>
    <p v-else-if="failed || !snapshot" role="status">No se ha podido consultar el estado del pedido.</p>
    <template v-else>
      <p class="font-medium">{{ snapshot.stateLabel ?? 'Pendiente de confirmación' }}</p>
      <p v-if="snapshot.expectedDeliveryAt">Fecha prevista: {{ date(snapshot.expectedDeliveryAt) }}</p>
      <ul v-if="snapshot.shipments.length" aria-label="Envíos">
        <li v-for="shipment in snapshot.shipments" :key="shipment.parcelIndex">
          {{ shipment.carrier }} · Seguimiento: {{ shipment.trackingNumber }} · Envío: {{ shipment.shipmentNumber }}
        </li>
      </ul>
      <p v-if="snapshot.erp?.served">Pedido servido</p>
      <p v-if="snapshot.erp?.deliveryNoteIds.length">Albarán generado</p>
      <p v-if="snapshot.erp?.invoiceIds.length">Facturado</p>
      <p v-if="snapshot.status !== 'synced' || snapshot.syncedVersion !== snapshot.version" role="status">
        Pendiente de actualizar la documentación del pedido.
      </p>
      <p v-if="snapshot.erpCheckedAt" class="text-sm text-slate-600">
        Última consulta: {{ date(snapshot.erpCheckedAt) }}
      </p>
    </template>
  </section>
</template>
