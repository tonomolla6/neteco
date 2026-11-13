<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Escaneo de almacén · Panel NETECO' })
</script>

<template>
  <AdminPage>
    <AdminWarehouseScanPanel />
  </AdminPage>
</template>
