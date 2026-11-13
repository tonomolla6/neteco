<script setup lang="ts">
import AdminOperationalAlertsPanel from '../../components/AdminOperationalAlertsPanel.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Alertas operativas · Admin', robots: 'noindex, nofollow, noarchive' })
</script>

<template>
  <AdminPage>
    <AdminOperationalAlertsPanel />
  </AdminPage>
</template>
