<script setup lang="ts">
import AdminSendTimeOptimizationPanel from '../../components/AdminSendTimeOptimizationPanel.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Mejor hora de envío · Admin', robots: 'noindex, nofollow, noarchive' })
</script>

<template>
  <AdminPage>
    <AdminSendTimeOptimizationPanel />
  </AdminPage>
</template>
