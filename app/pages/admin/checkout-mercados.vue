<script setup lang="ts">
import AdminCheckoutMarket from '../../components/AdminCheckoutMarket.vue'
definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Checkout por mercado · Admin', robots: 'noindex, nofollow' })
</script>
<template>
  <AdminPage>
    <AdminCheckoutMarket />
  </AdminPage>
</template>
