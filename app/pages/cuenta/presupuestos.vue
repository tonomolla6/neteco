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
  <div class="space-y-8">
    <SalesQuotesPanel audience="customer" @confirmed="onConfirmed" />
    <PayGoldLinkPanel :receipt="paymentReceipt" />
  </div>
</template>
