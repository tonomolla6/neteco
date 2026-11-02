<script setup lang="ts">
import AdminBrowseRecovery from '~/components/AdminBrowseRecovery.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Recuperación de Navegación · Admin', robots: 'noindex, nofollow, noarchive' })
</script>

<template>
  <div class="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
    <AdminBrowseRecovery />
  </div>
</template>
