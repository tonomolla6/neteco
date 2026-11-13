<script setup lang="ts">
import AdminQualityAssuranceSuite from '~/components/AdminQualityAssuranceSuite.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Pruebas · Admin', robots: 'noindex, nofollow, noarchive' })
</script>

<template>
  <AdminPage>
    <AdminQualityAssuranceSuite />
  </AdminPage>
</template>
