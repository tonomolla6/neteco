<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Revisión de Feeds de Proveedores · Admin' })
</script>

<template>
  <div class="p-6">
    <AdminSupplierFeedComparison />
  </div>
</template>
