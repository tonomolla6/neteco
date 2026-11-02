<script setup lang="ts">
import AdminPurchaseOrders from '~/components/AdminPurchaseOrders.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Pedidos de compra · Admin', robots: 'noindex, nofollow, noarchive' })
</script>

<template>
  <div>
    <AdminPurchaseOrders />
  </div>
</template>
