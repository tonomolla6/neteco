<script setup lang="ts">
import AdminRecommendationEngine from '~/components/AdminRecommendationEngine.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Motor de Recomendaciones · Admin', robots: 'noindex, nofollow, noarchive' })
</script>

<template>
  <div class="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
    <AdminRecommendationEngine />
  </div>
</template>
