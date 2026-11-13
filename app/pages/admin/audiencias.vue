<script setup lang="ts">
import AdminAudiences from '~/components/AdminAudiences.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Audiencias · Admin' })
</script>

<template>
  <AdminPage>
    <AdminAudiences />
  </AdminPage>
</template>
