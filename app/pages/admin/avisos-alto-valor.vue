<script setup lang="ts">
import AdminHighValueMessages from '../../components/AdminHighValueMessages.vue'
definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Avisos importantes · Admin', robots: 'noindex, nofollow' })
</script>
<template>
  <AdminPage>
    <AdminHighValueMessages />
  </AdminPage>
</template>
