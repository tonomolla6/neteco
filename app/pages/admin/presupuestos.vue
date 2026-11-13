<script setup lang="ts">
import SalesQuotesPanel from '~/components/SalesQuotesPanel.vue'
definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Presupuestos · Admin', robots: 'noindex, nofollow' })
</script>
<template>
  <AdminPage>
    <SalesQuotesPanel audience="admin" />
  </AdminPage>
</template>
