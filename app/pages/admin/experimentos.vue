<script setup lang="ts">
import AdminExperimentsDashboard from '~/components/AdminExperimentsDashboard.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Experimentos & A/B Testing · Admin' })
</script>

<template>
  <div class="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
    <AdminExperimentsDashboard />
  </div>
</template>
