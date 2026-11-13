<script setup lang="ts">
import AdminSupportContactAnalysis from '../../components/AdminSupportContactAnalysis.vue'

definePageMeta({ layout: 'admin', middleware: 'support-access' })
useSeoMeta({ title: 'Análisis de contactos · Admin', robots: 'noindex, nofollow, noarchive' })
</script>

<template>
  <AdminPage>
    <AdminSupportContactAnalysis />
  </AdminPage>
</template>
