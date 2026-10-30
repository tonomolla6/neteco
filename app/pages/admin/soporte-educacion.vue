<script setup lang="ts">
import AdminSupportEducation from '../../components/AdminSupportEducation.vue'

definePageMeta({ layout: 'admin', middleware: 'support-access' })
useSeoMeta({ title: 'Asistente y educación de soporte · Admin', robots: 'noindex, nofollow, noarchive' })
</script>

<template>
  <div class="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
    <AdminSupportEducation />
  </div>
</template>
