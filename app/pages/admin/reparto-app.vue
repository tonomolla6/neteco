<script setup lang="ts">
import AdminDeliveryAppReport from '../../components/AdminDeliveryAppReport.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Actividad de reparto · Admin', robots: 'noindex, nofollow, noarchive' })
</script>

<template>
  <div class="space-y-6">
    <h1 class="text-xl font-bold text-slate-900">App de reparto</h1>
    <AdminDeliveryAppReport />
  </div>
</template>
