<script setup lang="ts">
import AdminCategoryMerchandising from '../../components/AdminCategoryMerchandising.vue'
definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Orden de categorías', robots: 'noindex, nofollow' })
</script>

<template><AdminCategoryMerchandising /></template>
