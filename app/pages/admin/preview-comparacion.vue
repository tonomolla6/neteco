<script setup lang="ts">
import AdminPreviewVisualComparison from '../../components/AdminPreviewVisualComparison.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({
  title: 'Comparación visual de preview y regresión · Admin',
  robots: 'noindex, nofollow, noarchive'
})
</script>

<template>
  <AdminPreviewVisualComparison />
</template>
