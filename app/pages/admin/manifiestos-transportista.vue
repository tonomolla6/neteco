<script setup lang="ts">
import AdminCarrierManifests from '../../components/AdminCarrierManifests.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Manifiestos de transportista · Admin', robots: 'noindex, nofollow, noarchive' })
</script>

<template>
  <AdminPage>
    <AdminCarrierManifests />
  </AdminPage>
</template>
