<script setup lang="ts">
import AdminSearchAnalytics from '../../components/AdminSearchAnalytics.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Analítica de búsqueda · Admin', robots: 'noindex, nofollow, noarchive' })
const runtime = useRuntimeConfig().public.serverRuntime
</script>

<template>
  <AdminSearchAnalytics :runtime="runtime" />
</template>
