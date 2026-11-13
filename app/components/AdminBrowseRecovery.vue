<script setup lang="ts">
import { ref, onMounted } from 'vue'
import type { BrowseRecoveryPolicy, BrowseIncrementalityMetrics } from '~~/shared/browse-abandonment'

const requestFetch = useRequestFetch()

const loading = ref(false)
const saving = ref(false)
const errorMessage = ref('')
const successMessage = ref('')

const policy = ref<BrowseRecoveryPolicy>({
  id: 'global',
  version: 1,
  enabled: true,
  abandonmentWindowMinutes: 120,
  cooldownHours: 72,
  holdoutPercent: 20,
  attributionWindowDays: 7,
  updatedAt: '2026-01-01T00:00:00Z',
  updatedBy: '00000000-0000-4000-8000-000000000000'
})

const metrics = ref<BrowseIncrementalityMetrics | null>(null)

async function loadData() {
  loading.value = true
  errorMessage.value = ''
  try {
    const policyRes = await requestFetch<{ policy?: BrowseRecoveryPolicy }>('/api/admin/browse-recovery/policy')
    if (policyRes?.policy) {
      policy.value = { ...policyRes.policy }
    }
    const metricsRes = await requestFetch<{ metrics?: BrowseIncrementalityMetrics }>(
      '/api/admin/browse-recovery/metrics'
    )
    if (metricsRes?.metrics) {
      metrics.value = metricsRes.metrics
    }
  } catch (err: unknown) {
    errorMessage.value =
      err instanceof Error ? err.message : 'No se han podido cargar los datos de recuperación de visitas.'
  } finally {
    loading.value = false
  }
}

async function savePolicy() {
  saving.value = true
  errorMessage.value = ''
  successMessage.value = ''
  try {
    const res = await requestFetch<{ policy?: BrowseRecoveryPolicy }>('/api/admin/browse-recovery/policy', {
      method: 'PUT',
      body: {
        expectedVersion: policy.value.version,
        enabled: policy.value.enabled,
        abandonmentWindowMinutes: Number(policy.value.abandonmentWindowMinutes),
        cooldownHours: Number(policy.value.cooldownHours),
        holdoutPercent: Number(policy.value.holdoutPercent),
        attributionWindowDays: Number(policy.value.attributionWindowDays)
      }
    })
    if (res?.policy) {
      policy.value = { ...res.policy }
      successMessage.value = 'Política de navegación guardada con éxito (v' + res.policy.version + ')'
    }
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : 'No se han podido guardar los ajustes.'
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
    />
    <UAlert
      v-if="successMessage"
      role="status"
      color="success"
      variant="subtle"
      icon="i-lucide-circle-check"
      :title="successMessage"
    />

    <AdminSection
      v-if="metrics"
      title="Resultado de los recordatorios"
      description="Compara a quienes recibieron el recordatorio con el grupo de control, que no lo recibió."
    >
      <template #actions>
        <AdminBadge
          :tone="metrics.lift.statisticallySignificant ? 'success' : 'neutral'"
          data-testid="significance-badge"
        >
          {{ metrics.lift.statisticallySignificant ? 'Resultado fiable' : 'Aún faltan datos' }}
        </AdminBadge>
      </template>
      <div class="adm-grid">
        <div class="adm-card adm-stat">
          <p class="adm-stat__label">Recordatorios enviados</p>
          <p class="adm-stat__value" data-testid="treatment-exposures">{{ metrics.treatment.exposures }}</p>
          <p class="adm-stat__foot">
            {{ metrics.treatment.conversions }} compras ·
            {{ (metrics.treatment.conversionRate * 100).toLocaleString('es-ES', { maximumFractionDigits: 2 }) }} %
          </p>
        </div>
        <div class="adm-card adm-stat">
          <p class="adm-stat__label">Grupo de control</p>
          <p class="adm-stat__value" data-testid="control-exposures">{{ metrics.control.exposures }}</p>
          <p class="adm-stat__foot">
            {{ metrics.control.conversions }} compras ·
            {{ (metrics.control.conversionRate * 100).toLocaleString('es-ES', { maximumFractionDigits: 2 }) }} %
          </p>
        </div>
        <div class="adm-card adm-stat">
          <p class="adm-stat__label">Mejora frente al grupo de control</p>
          <p class="adm-stat__value" data-testid="relative-lift">
            {{ metrics.lift.relativeLiftPercent > 0 ? '+' : '' }}{{ metrics.lift.relativeLiftPercent.toFixed(1) }}%
          </p>
          <p class="adm-stat__foot">
            <span
              class="adm-stat__delta"
              :class="metrics.lift.relativeLiftPercent >= 0 ? 'adm-stat__delta--up' : 'adm-stat__delta--down'"
            >
              {{ adminMoney(metrics.lift.incrementalRevenueGrossCents) }}
            </span>
            <span>de ventas adicionales</span>
          </p>
        </div>
      </div>
    </AdminSection>

    <AdminCard
      title="Ajustes de los recordatorios"
      description="Se envían solo a clientes que han dado su consentimiento y han visto productos sin comprar."
    >
      <template #actions>
        <AdminButton size="sm" icon="i-lucide-rotate-cw" :loading="loading" @click="loadData">Actualizar</AdminButton>
      </template>
      <p v-if="loading" role="status" class="sr-only">Cargando ajustes y resultados…</p>
      <div class="adm-stack">
        <label class="adm-check">
          <input v-model="policy.enabled" type="checkbox" data-testid="browse-enabled-input" />
          Enviar recordatorios automáticamente
        </label>
        <div class="adm-form-grid">
          <AdminFormField
            v-slot="{ id }"
            label="Espera antes de enviar (minutos)"
            help="Tiempo sin actividad para considerar que la visita se ha abandonado."
          >
            <input
              :id="id"
              v-model.number="policy.abandonmentWindowMinutes"
              type="number"
              min="15"
              max="1440"
              class="adm-input"
              data-testid="abandonment-window-input"
            />
          </AdminFormField>
          <AdminFormField
            v-slot="{ id }"
            label="Descanso entre recordatorios (horas)"
            help="Tiempo mínimo antes de volver a escribir al mismo cliente."
          >
            <input
              :id="id"
              v-model.number="policy.cooldownHours"
              type="number"
              min="1"
              max="720"
              class="adm-input"
              data-testid="cooldown-hours-input"
            />
          </AdminFormField>
          <AdminFormField
            v-slot="{ id }"
            label="Grupo de control (%)"
            help="Clientes que no reciben recordatorio, para medir si funciona."
          >
            <input
              :id="id"
              v-model.number="policy.holdoutPercent"
              type="number"
              min="0"
              max="50"
              class="adm-input"
              data-testid="holdout-percent-input"
            />
          </AdminFormField>
          <AdminFormField
            v-slot="{ id }"
            label="Periodo de medición (días)"
            help="Días tras el recordatorio en los que una compra cuenta como resultado."
          >
            <input
              :id="id"
              v-model.number="policy.attributionWindowDays"
              type="number"
              min="1"
              max="30"
              class="adm-input"
              data-testid="attribution-window-input"
            />
          </AdminFormField>
        </div>
        <p class="adm-help">
          Por privacidad, los productos y categorías sensibles (biocidas de uso médico, desinfectantes clínicos…) nunca
          se incluyen en estos recordatorios.
        </p>
      </div>
      <template #footer>
        <button
          type="button"
          class="adm-btn adm-btn--primary"
          :disabled="saving"
          data-testid="save-browse-policy-button"
          @click="savePolicy"
        >
          {{ saving ? 'Guardando…' : 'Guardar ajustes' }}
        </button>
      </template>
    </AdminCard>
  </div>
</template>
