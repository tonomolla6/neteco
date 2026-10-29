<script setup lang="ts">
import AnalyticsOperationsPanel from '../../components/AnalyticsOperationsPanel.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Analítica · Admin', robots: 'noindex, nofollow, noarchive' })
const runtime = useRuntimeConfig().public.serverRuntime
</script>

<template>
  <AnalyticsOperationsPanel :runtime="runtime" />
</template>
