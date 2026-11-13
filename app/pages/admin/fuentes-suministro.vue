<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Elección de proveedor · Admin' })
</script>

<template>
  <AdminPage>
    <AdminSupplierSourcingPanel />
  </AdminPage>
</template>
