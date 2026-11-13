<script setup lang="ts">
import SalesQuotesPanel from '~/components/SalesQuotesPanel.vue'
import PayGoldLinkPanel from '~/components/PayGoldLinkPanel.vue'
import type { SalesQuoteReceipt } from '~~/shared/sales-quotes'
definePageMeta({ layout: 'cuenta', middleware: 'auth' })
useSeoMeta({ title: 'Mis presupuestos', robots: 'noindex, nofollow' })
const paymentReceipt = ref<SalesQuoteReceipt | null>(null)
function onConfirmed(receipt: SalesQuoteReceipt) {
  paymentReceipt.value = receipt.action === 'convert' && receipt.orderId ? receipt : null
}
</script>
<template>
  <div class="space-y-6">
    <UiPageHeader
      title="Presupuestos"
      description="Consulta los presupuestos que te hemos preparado y conviértelos en pedido cuando te encajen."
    />
    <div class="account-card account-embedded">
      <SalesQuotesPanel audience="customer" @confirmed="onConfirmed" />
    </div>
    <div class="account-card">
      <PayGoldLinkPanel :receipt="paymentReceipt" />
    </div>
    <UiSurface tone="sunken" padding="sm">
      <p class="text-sm text-[var(--text)]">
        ¿Necesitas un presupuesto nuevo? Pídelo desde
        <NuxtLink to="/cuenta/solicitudes-b2b">Solicitudes de empresa</NuxtLink> o
        <NuxtLink to="/contacto">escríbenos</NuxtLink>.
      </p>
    </UiSurface>
  </div>
</template>
