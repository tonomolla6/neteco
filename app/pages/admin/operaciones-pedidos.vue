<script setup lang="ts">
import { ref } from 'vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Operaciones de pedidos · Admin' })

const selectedOrderId = ref('33333333-3333-4333-8333-333333333333')
/** El pedido que se está consultando: solo cambia al pulsar «Ver pedido». */
const appliedOrderId = ref(selectedOrderId.value)
function applyOrder() {
  const next = selectedOrderId.value.trim()
  if (next) appliedOrderId.value = next
}
</script>

<template>
  <AdminPage>
    <div class="adm-stack">
      <AdminPaymentContingencyPanel />

      <AdminSection title="Compra de empresa y envíos parciales de un pedido">
        <template #actions>
          <form class="adm-toolbar" role="search" @submit.prevent="applyOrder">
            <label class="adm-toolbar__search" for="order-id-input">
              <span class="sr-only">Identificador del pedido</span>
              <UIcon name="i-lucide-search" class="size-4" />
              <input
                id="order-id-input"
                v-model="selectedOrderId"
                data-slot="adm-search"
                type="search"
                placeholder="Identificador del pedido"
              />
            </label>
            <AdminButton type="submit">Ver pedido</AdminButton>
          </form>
        </template>

        <div class="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <AdminOrderProcurementPanel :key="`compra-${appliedOrderId}`" :order-id="appliedOrderId" />
          <AdminSplitShipmentsPanel :key="`envios-${appliedOrderId}`" :order-id="appliedOrderId" />
        </div>
      </AdminSection>
    </div>
  </AdminPage>
</template>
