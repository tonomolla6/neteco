<script setup lang="ts">
import AdminSupportRca from '~/components/AdminSupportRca.vue'

definePageMeta({ layout: 'admin', middleware: 'support-access' })
useSeoMeta({ title: 'Causas de incidencias · Admin' })
</script>

<template>
  <AdminPage>
    <AdminSupportRca />
  </AdminPage>
</template>
