<script setup lang="ts">
import AdminSeoTechnicalPanel from '~/components/AdminSeoTechnicalPanel.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'SEO · Admin' })
</script>

<template>
  <AdminPage>
    <AdminSeoTechnicalPanel />
  </AdminPage>
</template>
