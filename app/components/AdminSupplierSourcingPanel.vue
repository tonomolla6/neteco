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

const STRATEGY_LABELS: Record<string, string> = {
  best_margin: 'Mayor margen',
  lowest_cost: 'Menor coste de compra',
  shortest_lead_time: 'Entrega más rápida',
  preferred: 'Proveedor preferente'
}
const strategyLabel = (code: string) => STRATEGY_LABELS[code] ?? adminHumanize(code)

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
    loadError.value = err instanceof Error ? err.message : 'Comprueba la conexión y vuelve a intentarlo.'
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
        selectionReason: `Criterio «${strategyLabel(selectedStrategy.value)}» aplicado desde el panel de compras`
      }
    })
    decisions.value.unshift(res)
    actionType.value = 'success'
    actionMessage.value = `Elección de proveedor registrada (margen: ${res.marginPercent}%).`
  } catch (err: unknown) {
    actionType.value = 'error'
    actionMessage.value =
      err instanceof Error ? err.message : 'No se ha podido registrar la elección. Vuelve a intentarlo.'
  }
}

onMounted(() => {
  loadSourcingData()
})
</script>

<template>
  <div class="adm-stack supplier-sourcing-panel">
    <AdminPageActions>
      <AdminButton
        variant="primary"
        icon="i-lucide-check"
        :disabled="offerings.length === 0"
        @click="handleRecordDecision"
      >
        Registrar elección de proveedor
      </AdminButton>
    </AdminPageActions>

    <UAlert
      v-if="actionMessage"
      role="alert"
      :color="actionType === 'success' ? 'success' : 'error'"
      variant="subtle"
      :icon="actionType === 'success' ? 'i-lucide-circle-check' : 'i-lucide-triangle-alert'"
      :title="actionMessage"
    />

    <AdminCard
      title="Proveedores disponibles"
      description="Compara coste, plazo y margen de cada proveedor para el precio de venta indicado."
      flush
    >
      <div class="adm-tablecard__bar">
        <div class="adm-toolbar">
          <label for="pvp-input" class="adm-label">Precio de venta (€)</label>
          <input
            id="pvp-input"
            v-model="retailPriceEuros"
            type="number"
            step="0.01"
            class="adm-input w-28 text-right"
          />
          <label for="strategy-select" class="adm-label">Criterio de elección</label>
          <select id="strategy-select" v-model="selectedStrategy" class="adm-input">
            <option value="best_margin">Mayor margen</option>
            <option value="lowest_cost">Menor coste de compra</option>
            <option value="shortest_lead_time">Entrega más rápida</option>
            <option value="preferred">Proveedor preferente</option>
          </select>
        </div>
      </div>
      <div v-if="loading" class="adm-table-skeleton" role="status" aria-busy="true">
        <span class="sr-only">Cargando proveedores…</span>
        <div v-for="row in 3" :key="row"><i /><i /><i /><i /></div>
      </div>
      <AdminEmptyState
        v-else-if="loadError"
        variant="error"
        title="No se han podido cargar los proveedores"
        :description="loadError"
      >
        <AdminButton icon="i-lucide-rotate-cw" @click="loadSourcingData">Reintentar</AdminButton>
      </AdminEmptyState>
      <AdminEmptyState
        v-else-if="!evaluatedOfferings.length"
        icon="i-lucide-truck"
        title="Ningún proveedor ofrece este producto"
        description="Cuando un proveedor lo incluya en su tarifa, aparecerá aquí para compararlo."
      />
      <div v-else class="adm-table-wrap">
        <table class="adm-table">
          <thead>
            <tr>
              <th scope="col">Referencia del proveedor</th>
              <th scope="col" data-numeric>Plazo de entrega</th>
              <th scope="col" data-numeric>Coste</th>
              <th scope="col" data-numeric>Margen</th>
              <th scope="col" data-numeric>Margen %</th>
              <th scope="col" data-numeric>Pedido mínimo</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="off in evaluatedOfferings" :key="off.id">
              <td>
                <span class="font-semibold text-[var(--text-strong)]">{{ off.supplierSku }}</span>
                <AdminBadge v-if="off.isPreferred" tone="info" plain class="ml-2">Preferente</AdminBadge>
              </td>
              <td data-numeric>{{ off.leadTimeDays }} días</td>
              <td data-numeric>{{ adminMoney(off.costCents) }}</td>
              <td data-numeric :class="!off.isViable && 'font-semibold text-red-700'">
                {{ adminMoney(off.marginCents) }}
              </td>
              <td data-numeric>
                <AdminBadge :tone="!off.isViable ? 'danger' : off.marginPercent >= 20 ? 'success' : 'warning'">
                  {{ off.marginPercent.toFixed(1) }}%
                </AdminBadge>
              </td>
              <td data-numeric>{{ off.minOrderQuantity }} ud.</td>
            </tr>
          </tbody>
        </table>
      </div>
    </AdminCard>

    <AdminCard
      v-if="!loading && !loadError && decisions.length > 0"
      title="Elecciones anteriores"
      description="Qué proveedor se eligió cada vez y por qué."
      flush
    >
      <ul class="adm-list">
        <li v-for="dec in decisions" :key="dec.id">
          <div class="min-w-0 flex-1">
            <p class="adm-list__title">{{ strategyLabel(dec.strategy) }}</p>
            <p class="adm-help break-words">{{ adminDate(dec.createdAt, true) }} · {{ dec.selectionReason }}</p>
          </div>
          <div class="text-right">
            <p class="font-semibold text-[var(--text-strong)]">
              Margen: {{ dec.marginPercent }}% ({{ adminMoney(dec.marginCents) }})
            </p>
            <p class="adm-help">Coste: {{ adminMoney(dec.costCents) }} · entrega en {{ dec.leadTimeDays }} días</p>
          </div>
        </li>
      </ul>
    </AdminCard>
  </div>
</template>
