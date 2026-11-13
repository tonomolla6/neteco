<script setup lang="ts">
import AdminIntegrationsDashboard from '~/components/AdminIntegrationsDashboard.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Integraciones y avisos web · Admin', robots: 'noindex, nofollow' })
</script>

<template>
  <AdminPage>
    <AdminIntegrationsDashboard />
  </AdminPage>
</template>
