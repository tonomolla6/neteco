<script setup lang="ts">
import AdminSupportRca from '~/components/AdminSupportRca.vue'

definePageMeta({ layout: 'admin', middleware: 'support-access' })
useSeoMeta({ title: 'RCA Incidencias Operativas · Admin' })
</script>

<template>
  <div class="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
    <AdminSupportRca />
  </div>
</template>
