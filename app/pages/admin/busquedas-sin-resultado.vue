<script setup lang="ts">
import AdminSearchGapProgramme from '~/components/AdminSearchGapProgramme.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Búsquedas sin resultado · Admin', robots: 'noindex, nofollow, noarchive' })
</script>

<template>
  <div>
    <AdminSearchGapProgramme />
  </div>
</template>
