<script setup lang="ts">
import AdminSendTimeOptimizationPanel from '../../components/AdminSendTimeOptimizationPanel.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Optimización de envíos (Send-Time) · Admin', robots: 'noindex, nofollow, noarchive' })
</script>

<template>
  <div class="space-y-6">
    <AdminSendTimeOptimizationPanel />
  </div>
</template>
