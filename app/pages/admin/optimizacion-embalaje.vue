<script setup lang="ts">
import AdminPackingOptimizer from '../../components/AdminPackingOptimizer.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Optimización de embalaje · Admin', robots: 'noindex, nofollow, noarchive' })
</script>

<template>
  <div class="space-y-6">
    <h1 class="text-xl font-bold text-slate-900">Embalaje</h1>
    <AdminPackingOptimizer />
  </div>
</template>
