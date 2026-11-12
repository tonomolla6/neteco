<script setup lang="ts">
/** Desglose del resumen: subtotal, descuento, envío, IVA y total, en euros o en la divisa del mercado. */
defineProps<{
  subtotalLabel: string
  subtotalCents: number
  discountCents: number | null
  shippingLabel: string
  shippingText: string
  taxText: string
  totalText: string
}>()
</script>

<template>
  <dl class="mt-4 space-y-2 border-t border-slate-100 pt-4 text-sm">
    <div class="flex justify-between">
      <dt class="text-slate-500">{{ subtotalLabel }}</dt>
      <dd data-testid="checkout-subtotal">{{ formatPrice(subtotalCents) }}</dd>
    </div>
    <div
      v-if="discountCents !== null"
      class="flex justify-between gap-3 text-sm"
      data-testid="checkout-coupon-discount"
    >
      <dt>
        Descuento aplicado (IVA incluido)<span class="block text-xs text-slate-500">Ya incluido en el total</span>
      </dt>
      <dd class="shrink-0">{{ formatPrice(discountCents) }}</dd>
    </div>
    <div class="flex justify-between gap-3">
      <dt class="min-w-0 truncate text-slate-500">Envío · {{ shippingLabel }}</dt>
      <dd class="shrink-0">{{ shippingText }}</dd>
    </div>
    <div class="flex justify-between text-xs text-slate-500">
      <dt>IVA incluido según producto y servicio</dt>
      <dd>{{ taxText }}</dd>
    </div>
    <div class="flex justify-between border-t border-slate-100 pt-3">
      <dt class="text-base font-semibold">Total</dt>
      <dd data-testid="checkout-total" class="text-xl font-bold">{{ totalText }}</dd>
    </div>
  </dl>
</template>
