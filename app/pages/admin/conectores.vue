<script setup lang="ts">
import AdminConnectorsMarketplace from '~/components/AdminConnectorsMarketplace.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Marketplace de Conectores · Admin', robots: 'noindex, nofollow' })
</script>

<template>
  <div class="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
    <AdminConnectorsMarketplace />
  </div>
</template>
