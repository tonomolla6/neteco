<script setup lang="ts">
import { computed, ref } from 'vue'
import type { BundleDetailView } from '../../../shared/bundles'

const props = defineProps<{
  bundle: BundleDetailView
}>()

const emit = defineEmits<{
  (e: 'update:quantity', qty: number): void
  (e: 'add-to-cart', payload: { bundleId: string; quantity: number; customQuantities: Record<string, number> }): void
}>()

const kitQuantity = ref(1)
const customQuantities = ref<Record<string, number>>({})

// Initialize custom quantities from defaults
for (const item of props.bundle.items) {
  customQuantities.value[item.variantId] = item.defaultQuantity
}

const sectorLabels: Record<string, string> = {
  hosteleria: 'Hostelería',
  automocion: 'Automoción',
  sanitario: 'Sanitario',
  industrial: 'Industrial',
  oficinas: 'Oficinas',
  colectividades: 'Colectividades',
  general: 'General'
}

const taskLabels: Record<string, string> = {
  desengrase_profundo: 'Desengrase Profundo',
  desinfeccion_superficies: 'Desinfección de Superficies',
  lavado_vehiculos: 'Lavado de Vehículos',
  lavavajillas_automatico: 'Lavavajillas Automático',
  higiene_manos: 'Higiene de Manos',
  limpieza_general: 'Limpieza General',
  mantenimiento_suelos: 'Mantenimiento de Suelos'
}

function formatCents(cents: number): string {
  return (cents / 100).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €'
}

const equivalentStandaloneCents = computed(() => {
  let sum = 0
  for (const item of props.bundle.items) {
    const qty = customQuantities.value[item.variantId] ?? item.defaultQuantity
    sum += item.unitPriceCents * qty
  }
  return sum * kitQuantity.value
})

const defaultStandaloneSum = computed(() => {
  let sum = 0
  for (const item of props.bundle.items) {
    sum += item.unitPriceCents * item.defaultQuantity
  }
  return sum
})

const discountRatio = computed(() => {
  if (defaultStandaloneSum.value <= 0) return 0
  return Math.max(0, (defaultStandaloneSum.value - props.bundle.bundlePriceCents) / defaultStandaloneSum.value)
})

const bundlePriceCents = computed(() => {
  let unitConfiguredSum = 0
  for (const item of props.bundle.items) {
    const qty = customQuantities.value[item.variantId] ?? item.defaultQuantity
    unitConfiguredSum += item.unitPriceCents * qty
  }
  const unitBundlePrice = Math.round(unitConfiguredSum * (1 - discountRatio.value))
  return unitBundlePrice * kitQuantity.value
})

const savingsCents = computed(() => {
  return Math.max(0, equivalentStandaloneCents.value - bundlePriceCents.value)
})

const savingsPercent = computed(() => {
  if (equivalentStandaloneCents.value <= 0) return 0
  return Math.round((savingsCents.value / equivalentStandaloneCents.value) * 1000) / 10
})

const taxCents = computed(() => {
  let taxSum = 0
  for (const item of props.bundle.items) {
    const qty = customQuantities.value[item.variantId] ?? item.defaultQuantity
    const lineGross = item.unitPriceCents * qty * kitQuantity.value
    const lineNet = Math.round(lineGross / (1 + item.taxRate))
    taxSum += lineGross - lineNet
  }
  return taxSum
})

const totalPriceCents = computed(() => bundlePriceCents.value + taxCents.value)

function incrementKit() {
  if (kitQuantity.value < props.bundle.maxAvailableKits) {
    kitQuantity.value++
    emit('update:quantity', kitQuantity.value)
  }
}

function decrementKit() {
  if (kitQuantity.value > 1) {
    kitQuantity.value--
    emit('update:quantity', kitQuantity.value)
  }
}

function updateComponentQty(variantId: string, delta: number, min: number, max: number) {
  const current = customQuantities.value[variantId] ?? 1
  const updated = Math.min(max, Math.max(min, current + delta))
  customQuantities.value[variantId] = updated
}

function handleAddToCart() {
  emit('add-to-cart', {
    bundleId: props.bundle.id,
    quantity: kitQuantity.value,
    customQuantities: customQuantities.value
  })
}
</script>

<template>
  <div class="bundle-card border rounded-lg p-6 bg-white shadow-sm hover:shadow-md transition">
    <div class="flex items-center justify-between mb-4">
      <span class="inline-block bg-blue-100 text-blue-800 text-xs px-2.5 py-0.5 rounded-full font-semibold">
        {{ sectorLabels[bundle.sector] || bundle.sector }}
      </span>
      <span class="text-xs text-gray-500 font-medium">
        {{ taskLabels[bundle.task] || bundle.task }}
      </span>
    </div>

    <h2 class="text-xl font-bold text-gray-900 mb-2">{{ bundle.title }}</h2>
    <p class="text-gray-600 text-sm mb-4">{{ bundle.description }}</p>

    <!-- Component list -->
    <div class="border-t border-b py-3 mb-4 space-y-2">
      <h3 class="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">Componentes del Kit:</h3>
      <div
        v-for="item in bundle.items"
        :key="item.id"
        class="flex items-center justify-between text-sm py-1 border-b border-gray-100 last:border-0"
      >
        <div class="flex-1 pr-2">
          <p class="font-medium text-gray-800">{{ item.productTitle }}</p>
          <p class="text-xs text-gray-500">Ref: {{ item.variantSku }} · {{ item.variantName }}</p>
        </div>
        <div class="flex items-center gap-2">
          <button
            type="button"
            class="px-2 py-0.5 text-xs bg-gray-100 border rounded hover:bg-gray-200"
            :disabled="(customQuantities[item.variantId] || item.defaultQuantity) <= item.minQuantity"
            aria-label="Disminuir componente"
            @click="updateComponentQty(item.variantId, -1, item.minQuantity, item.maxQuantity)"
          >
            -
          </button>
          <span class="text-xs font-semibold w-6 text-center">
            {{ customQuantities[item.variantId] || item.defaultQuantity }}
          </span>
          <button
            type="button"
            class="px-2 py-0.5 text-xs bg-gray-100 border rounded hover:bg-gray-200"
            :disabled="(customQuantities[item.variantId] || item.defaultQuantity) >= item.maxQuantity"
            aria-label="Aumentar componente"
            @click="updateComponentQty(item.variantId, 1, item.minQuantity, item.maxQuantity)"
          >
            +
          </button>
        </div>
      </div>
    </div>

    <!-- Stock indicator -->
    <div class="mb-4">
      <div v-if="bundle.maxAvailableKits > 0" class="flex items-center text-green-700 text-xs font-medium">
        <span class="w-2 h-2 rounded-full bg-green-500 mr-2"></span>
        <span>{{ bundle.maxAvailableKits }} kits disponibles</span>
      </div>
      <div v-else class="flex items-center text-red-600 text-xs font-medium">
        <span class="w-2 h-2 rounded-full bg-red-500 mr-2"></span>
        <span>Agotado</span>
      </div>
    </div>

    <!-- Pricing, Standalone Comparison & Savings -->
    <div class="bg-gray-50 p-4 rounded-md mb-4 space-y-1 text-sm">
      <div class="flex justify-between text-gray-500">
        <span>Compra equivalente suelta:</span>
        <span class="line-through">{{ formatCents(equivalentStandaloneCents) }}</span>
      </div>
      <div class="flex justify-between font-bold text-gray-900 text-lg">
        <span>Precio del Kit:</span>
        <span class="text-blue-700">{{ formatCents(bundlePriceCents) }}</span>
      </div>
      <div class="flex justify-between text-xs text-gray-500">
        <span>IVA estimado:</span>
        <span>{{ formatCents(taxCents) }}</span>
      </div>
      <div class="flex justify-between font-semibold text-xs text-gray-800 pt-1 border-t">
        <span>Total IVA incluido:</span>
        <span>{{ formatCents(totalPriceCents) }}</span>
      </div>
      <div
        v-if="savingsCents > 0"
        class="mt-2 pt-2 border-t flex justify-between items-center text-green-700 font-bold text-sm"
      >
        <span>Ahorro del kit:</span>
        <span class="bg-green-100 text-green-800 text-xs px-2 py-1 rounded">
          Ahorras {{ formatCents(savingsCents) }} ({{ savingsPercent }}%)
        </span>
      </div>
    </div>

    <!-- Quantity Stepper & CTA -->
    <div class="flex items-center gap-3">
      <div class="flex items-center border rounded">
        <button
          type="button"
          data-testid="decrement-kit-qty"
          class="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-700 font-bold"
          :disabled="kitQuantity <= 1"
          aria-label="Disminuir kits"
          @click="decrementKit"
        >
          -
        </button>
        <span class="px-3 py-1.5 font-semibold text-sm">{{ kitQuantity }}</span>
        <button
          type="button"
          data-testid="increment-kit-qty"
          class="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-700 font-bold"
          :disabled="kitQuantity >= bundle.maxAvailableKits"
          aria-label="Aumentar kits"
          @click="incrementKit"
        >
          +
        </button>
      </div>

      <button
        type="button"
        class="flex-1 bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 px-4 rounded text-sm transition disabled:opacity-50 disabled:cursor-not-allowed"
        :disabled="bundle.maxAvailableKits <= 0 || kitQuantity > bundle.maxAvailableKits"
        @click="handleAddToCart"
      >
        Añadir Kit al Carrito
      </button>
    </div>
  </div>
</template>
