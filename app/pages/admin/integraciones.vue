<script setup lang="ts">
import AdminIntegrationsDashboard from '~/components/AdminIntegrationsDashboard.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Integraciones, Sandboxes y Webhooks · Admin', robots: 'noindex, nofollow' })
</script>

<template>
  <div class="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
    <AdminIntegrationsDashboard />
  </div>
</template>
