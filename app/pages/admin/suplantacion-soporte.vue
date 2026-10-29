<script setup lang="ts">
import SupportImpersonationStart from '../../components/SupportImpersonationStart.vue'

definePageMeta({ layout: 'admin', middleware: 'support-access' })
useSeoMeta({ title: 'Suplantación de soporte · Admin', robots: 'noindex, nofollow' })
const route = useRoute()
const customerId = typeof route.query.customerId === 'string' ? route.query.customerId : undefined
const ticketRef = typeof route.query.ticket === 'string' ? route.query.ticket : undefined
</script>

<template>
  <div class="space-y-6">
    <UiPageHeader title="Suplantación de soporte" description="Sesión corta, auditada y siempre visible." />
    <UiSurface>
      <SupportImpersonationStart :customer-id="customerId" :ticket-ref="ticketRef" />
    </UiSurface>
  </div>
</template>
