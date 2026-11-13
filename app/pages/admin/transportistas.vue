<script setup lang="ts">
import AdminCarrierScorecard from '../../components/AdminCarrierScorecard.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Transportistas · Admin', robots: 'noindex, nofollow, noarchive' })
const runtime = useRuntimeConfig().public.serverRuntime
</script>

<template>
  <AdminPage>
    <AdminCarrierScorecard :runtime="runtime" />
  </AdminPage>
</template>
