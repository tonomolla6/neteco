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

/** El siguiente tramo que se puede alcanzar: la ganancia concreta de subir cantidad. */
const nextTier = computed(() => {
  const scale = breakdown.value?.scale ?? []
  return scale.find((entry) => entry.minimumQuantity > props.currentQuantity) ?? null
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
  <div
    v-if="breakdown && breakdown.scale.length > 1"
    class="rounded-[var(--radius-surface)] border border-[var(--border)] bg-[var(--surface-sunken)] p-3 text-[15px]"
  >
    <!-- Anclaje honesto: el ahorro es real y se calcula a la vista. -->
    <p v-if="nextTier" data-next-tier class="tabular font-medium text-[var(--text-strong)]">
      Desde {{ nextTier.minimumQuantity }}:
      {{ formatMoney(showNetPrices ? nextTier.unitNetCents : nextTier.unitGrossCents) }}/ud<template
        v-if="showNetPrices"
      >
        sin IVA</template
      >
      (−{{ nextTier.effectiveDiscountPercent }} %)
    </p>
    <p v-else class="font-medium text-[var(--text-strong)]">Ya tienes el mejor precio por cantidad.</p>

    <details class="mt-2">
      <summary class="cursor-pointer text-[13px] font-medium text-[var(--link)] underline">
        Ver todos los tramos
      </summary>
      <div class="mt-2 overflow-x-auto">
        <table class="w-full text-left text-[13px]">
          <caption class="sr-only">
            Precio por unidad según la cantidad,
            {{
              showNetPrices ? 'sin IVA' : 'IVA incluido'
            }}
          </caption>
          <thead class="border-b border-[var(--border-strong)] text-[var(--text-muted)]">
            <tr>
              <th scope="col" class="pb-2 font-semibold">Cantidad</th>
              <th scope="col" class="pb-2 font-semibold">Precio por unidad</th>
              <th scope="col" class="pb-2 font-semibold">Ahorro</th>
              <th scope="col" class="pb-2 text-right font-semibold">Estado</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-[var(--border)]">
            <tr
              v-for="entry in breakdown.scale"
              :key="entry.tierIndex"
              :class="entry.isActive ? 'active-tier font-semibold text-[var(--text-strong)]' : 'text-[var(--text)]'"
            >
              <td class="py-2 pr-2">
                <span v-if="entry.maximumQuantity">{{ entry.minimumQuantity }} – {{ entry.maximumQuantity }} uds</span>
                <span v-else>A partir de {{ entry.minimumQuantity }} uds</span>
                <span v-if="entry.label && entry.tierIndex > 0" class="block font-normal text-[var(--text-muted)]">
                  {{ entry.label }}
                </span>
              </td>
              <td class="tabular py-2 pr-2">
                {{ formatMoney(showNetPrices ? entry.unitNetCents : entry.unitGrossCents) }} / ud
                <span v-if="showNetPrices" class="block font-normal text-[var(--text-muted)]">
                  ({{ formatMoney(entry.unitGrossCents) }} IVA incl.)
                </span>
              </td>
              <td class="tabular py-2 pr-2">
                <span v-if="entry.effectiveDiscountPercent > 0">
                  -{{ entry.effectiveDiscountPercent }}%
                  <span class="font-normal text-[var(--text-muted)]">
                    (-{{ formatMoney(entry.effectiveUnitDiscountGrossCents) }}/ud)
                  </span>
                </span>
                <span v-else class="font-normal text-[var(--text-muted)]">Tarifa base</span>
              </td>
              <td class="py-2 text-right">
                <span v-if="entry.isActive" class="inline-flex items-center gap-1 text-[var(--stock-ok)]">
                  <UIcon name="i-lucide-check" class="size-3.5" /> Tramo aplicado
                </span>
                <span v-else class="font-normal text-[var(--text-muted)]">
                  {{
                    entry.minimumQuantity > currentQuantity ? `Faltan ${entry.minimumQuantity - currentQuantity}` : '—'
                  }}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="breakdown.nextTierIncentive" class="mt-2 text-[13px] text-[var(--text-muted)]">
        {{ breakdown.nextTierIncentive.message }}
      </p>
    </details>
  </div>
</template>
