<script setup lang="ts">
defineProps<{
  profile: {
    market: string
    currency: string
    version: number
    goodsTaxBps: number
    shippingTaxBps: number
    termsVersion: string
  }
  presentment: { currency: string; goodsTaxMinor: number; shippingGrossMinor: number; totalMinor: number }
  format: (cents: number, currency: string) => string
}>()
</script>

<template>
  <div
    data-testid="checkout-market-summary"
    role="region"
    aria-label="Condiciones del mercado de destino"
    class="mt-2 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700"
  >
    <p class="font-semibold text-slate-900">
      Mercado {{ profile.market }} · Divisa {{ profile.currency }} · Versión v{{ profile.version }}
    </p>
    <p class="mt-1" data-testid="checkout-market-tax">
      Impuestos aplicables ({{ (profile.goodsTaxBps / 100).toFixed(2) }}%):
      {{ format(presentment.goodsTaxMinor, presentment.currency) }}
    </p>
    <p class="mt-0.5" data-testid="checkout-market-shipping">
      Envío internacional ({{ (profile.shippingTaxBps / 100).toFixed(2) }}% imp. incl.):
      {{ format(presentment.shippingGrossMinor, presentment.currency) }}
    </p>
    <p class="mt-0.5" data-testid="checkout-market-terms">
      Versión de términos del mercado: <span class="font-mono">{{ profile.termsVersion }}</span>
    </p>
    <p class="mt-1 font-semibold text-slate-900" data-testid="checkout-market-total">
      Total en divisa de destino:
      {{ format(presentment.totalMinor, presentment.currency) }}
    </p>
  </div>
</template>
