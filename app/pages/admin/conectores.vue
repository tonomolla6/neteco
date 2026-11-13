<script setup lang="ts">
import AdminConnectorsMarketplace from '~/components/AdminConnectorsMarketplace.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Catálogo de conectores · Admin', robots: 'noindex, nofollow' })
</script>

<template>
  <AdminPage>
    <AdminConnectorsMarketplace />
  </AdminPage>
</template>
