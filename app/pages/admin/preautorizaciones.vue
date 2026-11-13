<script setup lang="ts">
import AdminPaymentPreauthorizations from '~/components/AdminPaymentPreauthorizations.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Preautorizaciones · Admin', robots: 'noindex, nofollow, noarchive' })
</script>

<template>
  <AdminPage>
    <div>
      <AdminPaymentPreauthorizations />
    </div>
  </AdminPage>
</template>
