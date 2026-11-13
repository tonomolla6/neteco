<script setup lang="ts">
import AdminPricingRules from '~/components/AdminPricingRules.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Reglas de precios y envío · Admin', robots: 'noindex, nofollow, noarchive' })
</script>

<template>
  <AdminPage>
    <AdminPricingRules />
  </AdminPage>
</template>
