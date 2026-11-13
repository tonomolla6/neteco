<script setup lang="ts">
import AdminPackingOptimizer from '../../components/AdminPackingOptimizer.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Optimización de embalaje · Admin', robots: 'noindex, nofollow, noarchive' })
</script>

<template>
  <AdminPage>
    <AdminPackingOptimizer />
  </AdminPage>
</template>
