<script setup lang="ts">
import AdminWarehouseAdrPanel from '~/components/AdminWarehouseAdrPanel.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Mercancías peligrosas · Panel NETECO' })
</script>

<template>
  <AdminPage>
    <AdminWarehouseAdrPanel />
  </AdminPage>
</template>
