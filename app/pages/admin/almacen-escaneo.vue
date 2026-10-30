<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Panel de Almacén — Modo Escaneo · Admin' })
</script>

<template>
  <div>
    <AdminWarehouseScanPanel />
  </div>
</template>
