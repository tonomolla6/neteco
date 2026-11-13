<script setup lang="ts">
import AdminBrowseRecovery from '~/components/AdminBrowseRecovery.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Recuperación de visitas · Admin', robots: 'noindex, nofollow, noarchive' })
</script>

<template>
  <AdminPage>
    <AdminBrowseRecovery />
  </AdminPage>
</template>
