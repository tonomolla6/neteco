<script setup lang="ts">
import AdminDeliverySurveys from '~/components/AdminDeliverySurveys.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Encuestas de entrega · Admin', robots: 'noindex, nofollow' })
</script>

<template>
  <AdminDeliverySurveys />
</template>
