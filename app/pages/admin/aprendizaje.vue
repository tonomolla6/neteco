<script setup lang="ts">
import AdminLearningCentre from '~/components/AdminLearningCentre.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Centro de aprendizaje · Admin', robots: 'noindex, nofollow, noarchive' })
</script>

<template>
  <div>
    <AdminLearningCentre />
  </div>
</template>
