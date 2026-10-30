<script setup lang="ts">
import AdminUgcModeration from '~/components/AdminUgcModeration.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Moderación UGC y Fotos · Admin', robots: 'noindex, nofollow' })
</script>

<template>
  <main class="p-6">
    <AdminUgcModeration />
  </main>
</template>
