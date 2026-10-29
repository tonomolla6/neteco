<script setup lang="ts">
import AdminCarrierManifests from '../../components/AdminCarrierManifests.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Manifiestos de transportista · Admin', robots: 'noindex, nofollow, noarchive' })
</script>

<template>
  <div class="space-y-6">
    <h1 class="text-xl font-bold text-slate-900">Manifiestos y recogidas</h1>
    <AdminCarrierManifests />
  </div>
</template>
