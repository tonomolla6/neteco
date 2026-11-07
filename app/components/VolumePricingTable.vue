<script setup lang="ts">
import { calculateVolumePricingBreakdown, type VolumePriceTierWithMultiple } from '~~/shared/volume-pricing-scale'

const props = withDefaults(
  defineProps<{
    baseGrossCents: number
    taxRateBasisPoints?: number
    tiers: VolumePriceTierWithMultiple[]
    currentQuantity?: number
    showNetPrices?: boolean
  }>(),
  {
    taxRateBasisPoints: 2100,
    currentQuantity: 1,
    showNetPrices: false
  }
)

const breakdown = computed(() => {
  if (!props.tiers || !props.tiers.length) return null
  try {
    return calculateVolumePricingBreakdown({
      baseGrossCents: props.baseGrossCents,
      quantity: props.currentQuantity,
      taxRateBasisPoints: props.taxRateBasisPoints,
      tiers: props.tiers
    })
  } catch {
    return null
  }
})

function formatMoney(cents: number): string {
  return new Intl.NumberFormat('es-ES', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(cents / 100)
}
</script>

<template>
  <div v-if="breakdown && breakdown.scale.length > 1" class="rounded-xl border border-emerald-200 bg-emerald-50/60 p-4">
    <div class="flex items-center justify-between pb-2">
      <h3 class="text-sm font-bold text-emerald-950">Escalas de descuento por volumen</h3>
      <span class="text-xs text-emerald-800">Precios con IVA incluido</span>
    </div>

    <!-- Tabla verificada antes de compra -->
    <div class="mt-2 overflow-x-auto">
      <table class="w-full text-left text-xs sm:text-sm">
        <thead class="border-b border-emerald-200 text-emerald-900">
          <tr>
            <th scope="col" class="pb-2 font-semibold">Cantidad / Tramo</th>
            <th scope="col" class="pb-2 font-semibold">Precio unitario</th>
            <th scope="col" class="pb-2 font-semibold">Descuento efectivo</th>
            <th scope="col" class="pb-2 font-semibold text-right">Estado</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-emerald-100">
          <tr
            v-for="entry in breakdown.scale"
            :key="entry.tierIndex"
            :class="[
              entry.isActive
                ? 'active-tier bg-emerald-100/70 font-medium text-emerald-950'
                : 'text-slate-700 hover:bg-emerald-50/80'
            ]"
            class="transition-colors"
          >
            <td class="py-2.5 pr-2">
              <span v-if="entry.maximumQuantity"> {{ entry.minimumQuantity }} – {{ entry.maximumQuantity }} uds </span>
              <span v-else> A partir de {{ entry.minimumQuantity }} uds </span>
              <span v-if="entry.label && entry.tierIndex > 0" class="block text-xs text-slate-500">
                {{ entry.label }}
              </span>
            </td>
            <td class="py-2.5 pr-2">
              <div class="font-semibold">
                {{ formatMoney(showNetPrices ? entry.unitNetCents : entry.unitGrossCents) }} / ud
              </div>
              <div v-if="showNetPrices" class="text-xs text-slate-500">
                ({{ formatMoney(entry.unitGrossCents) }} IVA incl.)
              </div>
            </td>
            <td class="py-2.5 pr-2">
              <span
                v-if="entry.effectiveDiscountPercent > 0"
                class="inline-flex items-center gap-1 font-semibold text-emerald-700"
              >
                -{{ entry.effectiveDiscountPercent }}%
                <span class="text-xs font-normal text-slate-600">
                  (-{{ formatMoney(entry.effectiveUnitDiscountGrossCents) }}/ud)
                </span>
              </span>
              <span v-else class="text-slate-400">Tarifa base</span>
            </td>
            <td class="py-2.5 text-right">
              <span
                v-if="entry.isActive"
                class="inline-flex items-center rounded-full bg-emerald-700 px-2.5 py-0.5 text-xs font-semibold text-white"
              >
                Tramo aplicado
              </span>
              <span v-else class="text-xs text-slate-400">
                {{
                  entry.minimumQuantity > currentQuantity ? `Faltan ${entry.minimumQuantity - currentQuantity}` : '—'
                }}
              </span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Sugerencia / incentivo del siguiente tramo -->
    <div
      v-if="breakdown.nextTierIncentive"
      class="mt-3 rounded-lg border border-emerald-300 bg-white p-2.5 text-xs text-emerald-900 shadow-xs"
    >
      <span class="font-bold text-emerald-800">Oportunidad de ahorro:</span>
      {{ breakdown.nextTierIncentive.message }}
    </div>
  </div>
</template>
