<script setup lang="ts">
import AdminPredictiveCampaignsPanel from '../../components/AdminPredictiveCampaignsPanel.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({
  title: 'Personalización Predictiva y Guardrails de Campañas · Admin',
  robots: 'noindex, nofollow, noarchive'
})
</script>

<template>
  <AdminPredictiveCampaignsPanel />
</template>
