<script setup lang="ts">
import AdminExperimentsDashboard from '~/components/AdminExperimentsDashboard.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Pruebas A/B · Admin' })
</script>

<template>
  <AdminPage>
    <AdminExperimentsDashboard />
  </AdminPage>
</template>
