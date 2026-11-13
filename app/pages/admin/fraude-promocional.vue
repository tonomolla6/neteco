<script setup lang="ts">
import AdminPromoFraudCases from '../../components/AdminPromoFraudCases.vue'
definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Fraude promocional', robots: 'noindex, nofollow' })
</script>

<template>
  <AdminPage>
    <AdminPromoFraudCases />
  </AdminPage>
</template>
