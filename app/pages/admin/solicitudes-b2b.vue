<script setup lang="ts">
import AdminB2bRequests from '../../components/AdminB2bRequests.vue'

definePageMeta({ layout: 'admin', middleware: 'support-access' })
useSeoMeta({ title: 'Solicitudes B2B · Admin', robots: 'noindex, nofollow, noarchive' })
</script>

<template>
  <div class="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
    <AdminB2bRequests />
  </div>
</template>
