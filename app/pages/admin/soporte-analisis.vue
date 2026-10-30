<script setup lang="ts">
import AdminSupportContactAnalysis from '../../components/AdminSupportContactAnalysis.vue'

definePageMeta({ layout: 'admin', middleware: 'support-access' })
useSeoMeta({ title: 'Análisis de contactos · Admin', robots: 'noindex, nofollow, noarchive' })
</script>

<template>
  <div class="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
    <AdminSupportContactAnalysis />
  </div>
</template>
