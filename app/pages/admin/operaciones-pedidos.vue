<script setup lang="ts">
import { ref } from 'vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Operaciones de Pedidos, Aprobaciones y Contingencia · Admin' })

const selectedOrderId = ref('33333333-3333-4333-8333-333333333333')
</script>

<template>
  <div class="space-y-6 p-6">
    <div class="border-b border-slate-200 pb-4">
      <h1 class="text-2xl font-bold text-slate-900">Operaciones de Pedidos y Contingencia</h1>
      <p class="text-sm text-slate-500">
        Gestión de compras B2B con PO/centro de coste, división de pedidos (split/backorders) y pasarelas de pago de
        contingencia.
      </p>
    </div>

    <!-- Payment Contingency & Market Routing -->
    <AdminPaymentContingencyPanel />

    <!-- Order-specific operations (PO Approvals and Split Shipments) -->
    <div class="space-y-6">
      <div class="flex items-center gap-4 rounded-md bg-slate-100 p-4">
        <label for="order-id-input" class="text-sm font-medium text-slate-700">ID de Pedido en Gestión:</label>
        <input
          id="order-id-input"
          v-model="selectedOrderId"
          type="text"
          class="w-96 rounded-md border-slate-300 font-mono text-sm shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
          placeholder="UUID del pedido..."
        />
      </div>

      <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <AdminOrderProcurementPanel :order-id="selectedOrderId" />
        <AdminSplitShipmentsPanel :order-id="selectedOrderId" />
      </div>
    </div>
  </div>
</template>
