<script setup lang="ts">
import AdminRecommendationEngine from '~/components/AdminRecommendationEngine.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Recomendaciones · Admin', robots: 'noindex, nofollow, noarchive' })
</script>

<template>
  <AdminPage>
    <AdminRecommendationEngine />
  </AdminPage>
</template>
