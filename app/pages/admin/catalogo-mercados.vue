<script setup lang="ts">
import AdminMarketCatalog from '../../components/AdminMarketCatalog.vue'
definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Catálogo por mercado y envíos internacionales · Admin', robots: 'noindex, nofollow, noarchive' })
</script>
<template>
  <AdminPage>
    <AdminMarketCatalog />
  </AdminPage>
</template>
