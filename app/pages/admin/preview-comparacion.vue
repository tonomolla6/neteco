<script setup lang="ts">
import AdminPreviewVisualComparison from '../../components/AdminPreviewVisualComparison.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({
  title: 'Comparar cambios · Admin',
  robots: 'noindex, nofollow, noarchive'
})
</script>

<template>
  <AdminPage>
    <AdminPreviewVisualComparison />
  </AdminPage>
</template>
