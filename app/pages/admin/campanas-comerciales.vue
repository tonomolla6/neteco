<script setup lang="ts">
import AdminCommercialCampaignManager from '../../components/AdminCommercialCampaignManager.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({
  title: 'Gestor de campañas y calendario comercial · Admin',
  robots: 'noindex, nofollow, noarchive'
})
</script>

<template>
  <AdminCommercialCampaignManager />
</template>
