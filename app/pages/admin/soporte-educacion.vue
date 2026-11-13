<script setup lang="ts">
import AdminSupportEducation from '../../components/AdminSupportEducation.vue'

definePageMeta({ layout: 'admin', middleware: 'support-access' })
useSeoMeta({ title: 'Respuestas y guías · Admin', robots: 'noindex, nofollow, noarchive' })
</script>

<template>
  <AdminPage>
    <AdminSupportEducation />
  </AdminPage>
</template>
