<script setup lang="ts">
import AdminWarehouseAdrPanel from '~/components/AdminWarehouseAdrPanel.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Gestión de Almacén y Assets Operativos ADR · Admin' })
</script>

<template>
  <div>
    <AdminWarehouseAdrPanel />
  </div>
</template>
