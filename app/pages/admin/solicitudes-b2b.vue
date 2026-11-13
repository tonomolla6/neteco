<script setup lang="ts">
import AdminB2bRequests from '../../components/AdminB2bRequests.vue'

definePageMeta({ layout: 'admin', middleware: 'support-access' })
useSeoMeta({ title: 'Solicitudes de empresas · Admin', robots: 'noindex, nofollow, noarchive' })
</script>

<template>
  <AdminPage>
    <AdminB2bRequests />
  </AdminPage>
</template>
