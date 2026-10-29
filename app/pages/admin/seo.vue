<script setup lang="ts">
import AdminSeoTechnicalPanel from '~/components/AdminSeoTechnicalPanel.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'SEO Técnico, Rastreo & Búsqueda IA · Admin' })
</script>

<template>
  <div class="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
    <AdminSeoTechnicalPanel />
  </div>
</template>
