<script setup lang="ts">
import { ref, onMounted } from 'vue'
import type { RecommendationEnginePolicy, RecommendationMetrics } from '~~/shared/recommendation-engine'

const requestFetch = useRequestFetch()

const loading = ref(false)
const saving = ref(false)
const errorMessage = ref('')
const successMessage = ref('')

const policy = ref<RecommendationEnginePolicy>({
  id: 'global',
  version: 1,
  weightCompatibility: 40,
  weightSector: 25,
  weightCopurchase: 25,
  weightMargin: 10,
  marginFloorBasisPoints: 1500,
  maxPerCategory: 2,
  manualFallbackProductIds: [],
  updatedAt: '2026-01-01T00:00:00Z',
  updatedBy: '00000000-0000-4000-8000-000000000000'
})

const manualFallbackText = ref('')
const metrics = ref<RecommendationMetrics | null>(null)

async function loadData() {
  loading.value = true
  errorMessage.value = ''
  try {
    const policyRes = await requestFetch<{ policy?: RecommendationEnginePolicy }>('/api/admin/recommendations/policy')
    if (policyRes?.policy) {
      policy.value = { ...policyRes.policy }
      manualFallbackText.value = (policyRes.policy.manualFallbackProductIds ?? []).join(', ')
    }
    const metricsRes = await requestFetch<{ metrics?: RecommendationMetrics }>('/api/admin/recommendations/metrics')
    if (metricsRes?.metrics) {
      metrics.value = metricsRes.metrics
    }
  } catch (err: unknown) {
    errorMessage.value =
      err instanceof Error ? err.message : 'No se han podido cargar las recomendaciones. Vuelve a intentarlo.'
  } finally {
    loading.value = false
  }
}

async function savePolicy() {
  saving.value = true
  errorMessage.value = ''
  successMessage.value = ''
  try {
    const fallbacks = manualFallbackText.value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)

    const res = await requestFetch<{ policy?: RecommendationEnginePolicy }>('/api/admin/recommendations/policy', {
      method: 'PUT',
      body: {
        expectedVersion: policy.value.version,
        weightCompatibility: Number(policy.value.weightCompatibility),
        weightSector: Number(policy.value.weightSector),
        weightCopurchase: Number(policy.value.weightCopurchase),
        weightMargin: Number(policy.value.weightMargin),
        marginFloorBasisPoints: Number(policy.value.marginFloorBasisPoints),
        maxPerCategory: Number(policy.value.maxPerCategory),
        manualFallbackProductIds: fallbacks
      }
    })
    if (res?.policy) {
      policy.value = { ...res.policy }
      successMessage.value =
        'Configuración del motor de recomendaciones guardada con éxito (v' + res.policy.version + ')'
    }
  } catch (err: unknown) {
    errorMessage.value =
      err instanceof Error ? err.message : 'No se han podido guardar los cambios. Vuelve a intentarlo.'
  } finally {
    saving.value = false
  }
}

onMounted(() => {
  loadData()
})
</script>

<template>
  <div class="adm-stack">
    <UAlert
      v-if="errorMessage"
      role="alert"
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="errorMessage"
      :actions="[{ label: 'Reintentar', color: 'neutral', variant: 'outline', onClick: () => void loadData() }]"
    />
    <UAlert
      v-if="successMessage"
      role="status"
      color="success"
      variant="subtle"
      icon="i-lucide-circle-check"
      :title="successMessage"
    />

    <AdminSection v-if="metrics" :title="`Resultados de los últimos ${metrics.periodDays} días`">
      <div class="adm-grid">
        <div class="adm-card adm-stat">
          <p class="adm-stat__label">Veces mostradas</p>
          <p class="adm-stat__value" data-testid="metric-impressions">{{ metrics.impressions }}</p>
        </div>
        <div class="adm-card adm-stat">
          <p class="adm-stat__label">Clics</p>
          <p class="adm-stat__value" data-testid="metric-clicks">
            {{ metrics.clicks }}
            <span class="text-xs font-normal text-[var(--text-muted)]"
              >({{ (metrics.clickThroughRate * 100).toFixed(2) }}%)</span
            >
          </p>
          <p class="adm-stat__foot">
            <span
              >{{ metrics.byOrigin.rule.clicks }} automáticas · {{ metrics.byOrigin.manualFallback.clicks }} de
              reserva</span
            >
          </p>
        </div>
        <div class="adm-card adm-stat">
          <p class="adm-stat__label">Compras</p>
          <p class="adm-stat__value" data-testid="metric-conversions">
            {{ metrics.conversions }}
            <span class="text-xs font-normal text-[var(--text-muted)]"
              >({{ (metrics.conversionRate * 100).toFixed(2) }}%)</span
            >
          </p>
          <p class="adm-stat__foot">
            <span
              >{{ metrics.byOrigin.rule.conversions }} automáticas ·
              {{ metrics.byOrigin.manualFallback.conversions }} de reserva</span
            >
          </p>
        </div>
        <div class="adm-card adm-stat">
          <p class="adm-stat__label">Ventas atribuidas</p>
          <p class="adm-stat__value" data-testid="metric-revenue">
            {{ adminMoney(metrics.attributedRevenueGrossCents) }}
          </p>
        </div>
      </div>
    </AdminSection>

    <AdminCard
      title="Qué pesa más al recomendar"
      description="Reparte la importancia de cada criterio de 0 a 100. Cuanto más alto, más influye en los productos sugeridos."
    >
      <template #actions>
        <AdminButton size="sm" icon="i-lucide-rotate-cw" :loading="loading" @click="loadData">Recargar</AdminButton>
      </template>
      <div class="adm-stack">
        <div class="adm-form-grid">
          <AdminFormField v-slot="{ id }" label="Productos compatibles" help="Que se puedan usar juntos.">
            <input
              :id="id"
              v-model.number="policy.weightCompatibility"
              type="number"
              min="0"
              max="100"
              data-testid="weight-compatibility-input"
            />
          </AdminFormField>
          <AdminFormField v-slot="{ id }" label="Sector del cliente" help="Lo habitual en su tipo de negocio.">
            <input
              :id="id"
              v-model.number="policy.weightSector"
              type="number"
              min="0"
              max="100"
              data-testid="weight-sector-input"
            />
          </AdminFormField>
          <AdminFormField
            v-slot="{ id }"
            label="Se compran juntos"
            help="Lo que otros clientes añaden al mismo pedido."
          >
            <input
              :id="id"
              v-model.number="policy.weightCopurchase"
              type="number"
              min="0"
              max="100"
              data-testid="weight-copurchase-input"
            />
          </AdminFormField>
          <AdminFormField v-slot="{ id }" label="Margen" help="Productos que dejan más beneficio.">
            <input
              :id="id"
              v-model.number="policy.weightMargin"
              type="number"
              min="0"
              max="100"
              data-testid="weight-margin-input"
            />
          </AdminFormField>
        </div>
      </div>
    </AdminCard>

    <AdminCard title="Límites y variedad">
      <div class="adm-form-grid">
        <AdminFormField
          v-slot="{ id }"
          label="Margen mínimo"
          help="En centésimas de punto: 1500 equivale al 15 %. Los productos por debajo no se recomiendan."
        >
          <input
            :id="id"
            v-model.number="policy.marginFloorBasisPoints"
            type="number"
            min="0"
            max="5000"
            data-testid="margin-floor-input"
          />
        </AdminFormField>
        <AdminFormField
          v-slot="{ id }"
          label="Máximo de productos por categoría"
          help="Evita que todas las sugerencias sean del mismo tipo."
        >
          <input
            :id="id"
            v-model.number="policy.maxPerCategory"
            type="number"
            min="1"
            max="10"
            data-testid="max-per-category-input"
          />
        </AdminFormField>
        <AdminFormField
          v-slot="{ id }"
          class="sm:col-span-full"
          label="Productos de reserva"
          help="Identificadores separados por comas. Se usan, en este orden, cuando no hay suficientes recomendaciones automáticas."
        >
          <input
            :id="id"
            v-model="manualFallbackText"
            type="text"
            placeholder="prod-bayetas, prod-guantes"
            data-testid="manual-fallback-input"
          />
        </AdminFormField>
      </div>
      <template #footer>
        <button
          type="button"
          class="adm-btn adm-btn--primary"
          :disabled="saving"
          data-testid="save-recommendation-policy-button"
          @click="savePolicy"
        >
          {{ saving ? 'Guardando…' : 'Guardar cambios' }}
        </button>
      </template>
    </AdminCard>
  </div>
</template>
