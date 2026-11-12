<script setup lang="ts">
export interface DeliveryMethodRate {
  label: string
  netCents: number
  taxRateBasisPoints: number
  estimatedDeliveryTo: string | null
  etaStatus?: 'estimated' | 'unknown'
  etaReason?: string
}

const props = defineProps<{
  methods: ReadonlyArray<{ value: string; label: string; desc: string }>
  rateFor: (method: string) => DeliveryMethodRate | undefined
  freeShippingLabel?: string
  cloudflare: boolean
  loading: boolean
  error: string
}>()
const method = defineModel<string>({ required: true })

function grossCents(rate: DeliveryMethodRate) {
  return rate.netCents + Math.round((rate.netCents * rate.taxRateBasisPoints) / 10_000)
}
const rate = (value: string) => props.rateFor(value)
</script>

<template>
  <div data-checkout-delivery-methods>
    <fieldset class="mt-5 space-y-2">
      <legend class="sr-only">Selecciona el método de entrega</legend>
      <label
        v-for="m in methods"
        :key="m.value"
        class="flex cursor-pointer items-center justify-between gap-3 rounded-xl border-2 px-4 py-3 transition"
        :class="
          method === m.value ? 'border-neteco-500 ring-1 ring-neteco-500' : 'border-slate-200 hover:border-neteco-300'
        "
      >
        <span class="flex items-center gap-3">
          <input v-model="method" type="radio" :value="m.value" class="accent-neteco-500" />
          <span>
            <span class="block font-medium text-slate-800">{{ m.label }}</span>
            <span class="block text-xs text-slate-500">
              {{ rate(m.value)?.label ?? m.desc }}
              <template v-if="!rate(m.value) && m.value === 'envio' && freeShippingLabel">
                · {{ freeShippingLabel.toLowerCase() }}
              </template>
              <template v-if="rate(m.value)?.estimatedDeliveryTo">
                <template v-if="rate(m.value)!.etaStatus === 'estimated'"
                  >· estimado {{ rate(m.value)!.estimatedDeliveryTo!.split('-').reverse().join('/') }} (no
                  garantizado)</template
                >
                <template v-else
                  >· antes del {{ new Date(rate(m.value)!.estimatedDeliveryTo!).toLocaleDateString('es-ES') }}</template
                >
              </template>
              <template v-else-if="cloudflare && rate(m.value)">
                <template v-if="rate(m.value)!.etaReason === 'lead_time_unknown'"
                  >· plazo de disponibilidad pendiente</template
                >
                <template v-else-if="rate(m.value)!.etaReason === 'no_operating_window'"
                  >· sin ventana operativa estimable</template
                >
                <template v-else>· pendiente de calendario operativo</template>
              </template>
            </span>
          </span>
        </span>
        <span class="font-semibold text-slate-800">
          <template v-if="rate(m.value)">
            {{ rate(m.value)!.netCents ? formatPrice(grossCents(rate(m.value)!)) : 'Gratis' }}
          </template>
          <template v-else>Por calcular</template>
        </span>
      </label>
    </fieldset>
    <p v-if="loading" role="status" aria-live="polite" class="mt-3 text-sm text-slate-500">
      Calculando disponibilidad y fecha…
    </p>
    <p v-if="error" role="alert" class="mt-3 text-sm text-red-700">{{ error }}</p>
  </div>
</template>
