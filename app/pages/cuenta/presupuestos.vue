<script setup lang="ts">
import SalesQuotesPanel from '~/components/SalesQuotesPanel.vue'
definePageMeta({ layout: 'cuenta', middleware: 'auth' })
useSeoMeta({ title: 'Mis presupuestos', robots: 'noindex, nofollow' })
</script>
<template><SalesQuotesPanel audience="customer" /></template>
