<script setup lang="ts">
import AdminDeliverySurveys from '~/components/AdminDeliverySurveys.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Encuestas de entrega · Panel NETECO', robots: 'noindex, nofollow' })
</script>

<template>
  <AdminPage>
    <AdminDeliverySurveys />
  </AdminPage>
</template>
