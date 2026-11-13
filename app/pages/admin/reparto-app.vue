<script setup lang="ts">
import AdminDeliveryAppReport from '../../components/AdminDeliveryAppReport.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'App de reparto · Admin', robots: 'noindex, nofollow, noarchive' })
</script>

<template>
  <AdminPage>
    <AdminDeliveryAppReport />
  </AdminPage>
</template>
