<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Tarifas de proveedores · Admin' })
</script>

<template>
  <AdminPage>
    <AdminSupplierFeedComparison />
  </AdminPage>
</template>
