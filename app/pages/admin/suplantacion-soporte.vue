<script setup lang="ts">
import SupportImpersonationStart from '../../components/SupportImpersonationStart.vue'

definePageMeta({ layout: 'admin', middleware: 'support-access' })
useSeoMeta({ title: 'Ver como cliente · Admin', robots: 'noindex, nofollow' })
const route = useRoute()
const customerId = typeof route.query.customerId === 'string' ? route.query.customerId : undefined
const ticketRef = typeof route.query.ticket === 'string' ? route.query.ticket : undefined
</script>

<template>
  <AdminPage>
    <SupportImpersonationStart :customer-id="customerId" :ticket-ref="ticketRef" />
  </AdminPage>
</template>
