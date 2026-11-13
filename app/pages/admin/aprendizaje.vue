<script setup lang="ts">
import AdminLearningCentre from '~/components/AdminLearningCentre.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Formación · Admin', robots: 'noindex, nofollow, noarchive' })
</script>

<template>
  <AdminPage>
    <AdminLearningCentre />
  </AdminPage>
</template>
