<script setup lang="ts">
import AdminConfigurableRoleDashboard from '../../components/AdminConfigurableRoleDashboard.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({
  title: 'Panel configurable por rol · Admin',
  robots: 'noindex, nofollow, noarchive'
})
</script>

<template>
  <AdminPage>
    <AdminConfigurableRoleDashboard />
  </AdminPage>
</template>
