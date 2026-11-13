<script setup lang="ts">
import AdminUgcModeration from '~/components/AdminUgcModeration.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Fotos de clientes · Admin', robots: 'noindex, nofollow' })
</script>

<template>
  <AdminPage>
    <AdminUgcModeration />
  </AdminPage>
</template>
