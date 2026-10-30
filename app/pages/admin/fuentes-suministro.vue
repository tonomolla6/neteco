<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Multi-Proveedor y Fuentes de Suministro · Admin' })
</script>

<template>
  <div class="p-6">
    <AdminSupplierSourcingPanel />
  </div>
</template>
