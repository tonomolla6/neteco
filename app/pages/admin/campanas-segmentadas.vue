<script setup lang="ts">
import AdminTargetedCampaignsPanel from '../../components/AdminTargetedCampaignsPanel.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({
  title: 'Campañas segmentadas por cliente, empresa o sector · Admin',
  robots: 'noindex, nofollow, noarchive'
})
</script>

<template>
  <AdminPage>
    <AdminTargetedCampaignsPanel />
  </AdminPage>
</template>
