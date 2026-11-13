<script setup lang="ts">
import AdminProductRecall from '../../components/AdminProductRecall.vue'
definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Retiradas de producto · Admin', robots: 'noindex, nofollow, noarchive' })
</script>
<template>
  <AdminPage>
    <AdminProductRecall />
  </AdminPage>
</template>
