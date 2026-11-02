<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  calculateMargin,
  type SupplierProductOffering,
  type SourcingDecision,
  type SourcingStrategy
} from '~~/shared/supplier-sourcing'

const props = withDefaults(
  defineProps<{
    variantId?: string
    defaultRetailPriceCents?: number
  }>(),
  {
    variantId: 'var-default-100',
    defaultRetailPriceCents: 2500
  }
)

const requestFetch = useRequestFetch()

const loading = ref(true)
const loadError = ref<string | null>(null)
const actionMessage = ref<string | null>(null)
const actionType = ref<'success' | 'error'>('success')

const retailPriceEuros = ref((props.defaultRetailPriceCents / 100).toFixed(2))
const retailPriceCents = computed(() => Math.round(Number(retailPriceEuros.value || 0) * 100))

const offerings = ref<SupplierProductOffering[]>([])
const decisions = ref<SourcingDecision[]>([])
const selectedStrategy = ref<SourcingStrategy>('best_margin')

const evaluatedOfferings = computed(() => {
  return offerings.value.map((off) => {
    const margin = calculateMargin(retailPriceCents.value, off.costCents)
    return {
      ...off,
      marginCents: margin.marginCents,
      marginPercent: margin.marginPercent,
      markupPercent: margin.markupPercent,
      isViable: margin.isViable
    }
  })
})

async function loadSourcingData() {
  loading.value = true
  loadError.value = null
  try {
    const [offRes, decRes] = await Promise.all([
      requestFetch(`/api/admin/supplier-sourcing/offerings?variantId=${encodeURIComponent(props.variantId)}`),
      requestFetch(`/api/admin/supplier-sourcing/decisions?variantId=${encodeURIComponent(props.variantId)}`)
    ])
    offerings.value = Array.isArray(offRes) ? offRes : []
    decisions.value = Array.isArray(decRes) ? decRes : []
  } catch (err: unknown) {
    loadError.value = err instanceof Error ? err.message : 'Error al cargar fuentes de suministro'
  } finally {
    loading.value = false
  }
}

async function handleRecordDecision() {
  actionMessage.value = null
  try {
    const res = await requestFetch<SourcingDecision>('/api/admin/supplier-sourcing/decision', {
      method: 'POST',
      body: {
        variantId: props.variantId,
        retailPriceCents: retailPriceCents.value,
        strategy: selectedStrategy.value,
        selectionReason: `Estrategia ${selectedStrategy.value} ejecutada desde panel de compras`
      }
    })
    decisions.value.unshift(res)
    actionType.value = 'success'
    actionMessage.value = `Decisión de suministro registrada con trazabilidad (Margen: ${res.marginPercent}%).`
  } catch (err: unknown) {
    actionType.value = 'error'
    actionMessage.value = err instanceof Error ? err.message : 'Error al registrar decisión de suministro'
  }
}

onMounted(() => {
  loadSourcingData()
})
</script>

<template>
  <div
    class="supplier-sourcing-panel p-6 bg-white dark:bg-zinc-900 rounded-xl shadow-sm border border-zinc-200 dark:border-zinc-800"
  >
    <header class="mb-6 flex flex-wrap justify-between items-center gap-4">
      <div>
        <h2 class="text-xl font-bold text-zinc-900 dark:text-zinc-100">
          Multi-Proveedor y Selección de Suministro Trazable (CAT-021)
        </h2>
        <p class="text-sm text-zinc-600 dark:text-zinc-400 mt-1">
          Variante: <span class="font-mono font-semibold">{{ variantId }}</span> | Ofertas activas:
          {{ offerings.length }}
        </p>
      </div>

      <!-- Retail Price Input for Margin Calculation -->
      <div
        class="flex items-center gap-2 bg-zinc-50 dark:bg-zinc-800 p-2 rounded-lg border border-zinc-200 dark:border-zinc-700"
      >
        <label for="pvp-input" class="text-xs font-semibold text-zinc-700 dark:text-zinc-300">PVP Catálogo (€):</label>
        <input
          id="pvp-input"
          v-model="retailPriceEuros"
          type="number"
          step="0.01"
          class="w-24 px-2 py-1 text-sm font-bold text-right rounded border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900"
        />
      </div>
    </header>

    <!-- Strategy Selection and Action -->
    <div
      class="mb-6 p-4 bg-zinc-50 dark:bg-zinc-800/40 rounded-lg border border-zinc-200 dark:border-zinc-700 flex flex-wrap justify-between items-center gap-4"
    >
      <div class="flex items-center gap-3">
        <label for="strategy-select" class="text-xs font-semibold text-zinc-700 dark:text-zinc-300">
          Estrategia de Suministro:
        </label>
        <select
          id="strategy-select"
          v-model="selectedStrategy"
          class="text-sm px-3 py-1.5 rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900"
        >
          <option value="best_margin">Mayor Margen Comercial</option>
          <option value="lowest_cost">Menor Coste de Compra</option>
          <option value="shortest_lead_time">Menor Plazo de Entrega (Lead Time)</option>
          <option value="preferred">Proveedor Preferente</option>
        </select>
      </div>

      <button
        type="button"
        class="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-medium rounded-lg text-sm transition disabled:opacity-50"
        :disabled="offerings.length === 0"
        @click="handleRecordDecision"
      >
        Registrar Selección Trazable
      </button>
    </div>

    <!-- Alert / Feedback -->
    <div
      v-if="actionMessage"
      class="mb-6 p-3 rounded-lg text-sm"
      :class="{
        'bg-emerald-50 text-emerald-800 border border-emerald-200': actionType === 'success',
        'bg-rose-50 text-rose-800 border border-rose-200': actionType === 'error'
      }"
      role="alert"
    >
      {{ actionMessage }}
    </div>

    <!-- Loading / Error -->
    <div v-if="loading" class="py-12 text-center text-zinc-500" role="status">Cargando fuentes de suministro...</div>
    <div v-else-if="loadError" class="py-12 text-center text-rose-600">
      {{ loadError }}
    </div>

    <!-- Offerings Table -->
    <div v-else class="space-y-6">
      <div>
        <h3 class="text-sm font-bold uppercase text-zinc-500 mb-3">Fuentes de Suministro Disponibles</h3>
        <div class="overflow-x-auto">
          <table class="w-full text-left text-sm border-collapse">
            <thead>
              <tr class="border-b border-zinc-200 dark:border-zinc-700 text-zinc-500 text-xs uppercase">
                <th class="py-2.5 px-3">SKU Proveedor</th>
                <th class="py-2.5 px-3">Lead Time</th>
                <th class="py-2.5 px-3">Coste Proveedor</th>
                <th class="py-2.5 px-3">Margen Bruto</th>
                <th class="py-2.5 px-3">Margen %</th>
                <th class="py-2.5 px-3">Estado</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-zinc-200 dark:divide-zinc-800">
              <tr v-for="off in evaluatedOfferings" :key="off.id" class="hover:bg-zinc-50 dark:hover:bg-zinc-800/40">
                <td class="py-3 px-3 font-mono font-medium">
                  {{ off.supplierSku }}
                  <span v-if="off.isPreferred" class="ml-1.5 px-1.5 py-0.5 bg-blue-100 text-blue-800 rounded text-xs">
                    Preferente
                  </span>
                </td>
                <td class="py-3 px-3">
                  <span class="font-semibold">{{ off.leadTimeDays }}</span> días
                </td>
                <td class="py-3 px-3 font-semibold text-zinc-900 dark:text-zinc-100">
                  {{ (off.costCents / 100).toFixed(2) }}€
                </td>
                <td
                  class="py-3 px-3"
                  :class="off.isViable ? 'text-emerald-600 font-semibold' : 'text-rose-600 font-bold'"
                >
                  {{ (off.marginCents / 100).toFixed(2) }}€
                </td>
                <td class="py-3 px-3">
                  <span
                    class="px-2 py-0.5 rounded text-xs font-bold"
                    :class="off.marginPercent >= 20 ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'"
                  >
                    {{ off.marginPercent.toFixed(1) }}%
                  </span>
                </td>
                <td class="py-3 px-3 text-xs text-zinc-500">MOQ: {{ off.minOrderQuantity }} ud(s)</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Traceability Decision History -->
      <div v-if="decisions.length > 0">
        <h3 class="text-sm font-bold uppercase text-zinc-500 mb-3">Historial Trazable de Decisiones de Suministro</h3>
        <div class="space-y-3">
          <div
            v-for="dec in decisions"
            :key="dec.id"
            class="p-4 rounded-lg bg-zinc-50 dark:bg-zinc-800/60 border border-zinc-200 dark:border-zinc-700 text-xs"
          >
            <div class="flex justify-between items-start gap-4">
              <div>
                <span class="font-bold text-zinc-900 dark:text-zinc-100"
                  >Estrategia: {{ dec.strategy.toUpperCase() }}</span
                >
                <span class="ml-2 text-zinc-500">({{ dec.createdAt }})</span>
                <p class="mt-1 text-zinc-700 dark:text-zinc-300">{{ dec.selectionReason }}</p>
              </div>
              <div class="text-right">
                <div class="font-bold text-emerald-600 text-sm">
                  Margen: {{ dec.marginPercent }}% ({{ (dec.marginCents / 100).toFixed(2) }}€)
                </div>
                <div class="text-zinc-500">
                  Coste: {{ (dec.costCents / 100).toFixed(2) }}€ | Lead time: {{ dec.leadTimeDays }}d
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
