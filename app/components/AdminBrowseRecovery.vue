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
    const policyRes = await requestFetch('/api/admin/browse-recovery/policy')
    if (policyRes?.policy) {
      policy.value = { ...policyRes.policy }
    }
    const metricsRes = await requestFetch('/api/admin/browse-recovery/metrics')
    if (metricsRes?.metrics) {
      metrics.value = metricsRes.metrics
    }
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : 'Error al cargar datos de recuperación de navegación'
  } finally {
    loading.value = false
  }
}

async function savePolicy() {
  saving.value = true
  errorMessage.value = ''
  successMessage.value = ''
  try {
    const res = await requestFetch('/api/admin/browse-recovery/policy', {
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
    errorMessage.value = err instanceof Error ? err.message : 'Error al guardar la política'
  } finally {
    saving.value = false
  }
}

onMounted(() => {
  loadData()
})
</script>

<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between">
      <div>
        <h2 class="text-lg font-bold text-neutral-900">Automatización de Navegación Abandonada (MKT-014)</h2>
        <p class="text-xs text-neutral-500">
          Recuperación consentida con protección de categorías sensibles y medición de incrementalidad por grupo de
          control.
        </p>
      </div>
      <button
        type="button"
        class="rounded-md bg-neutral-100 px-3 py-1.5 text-xs font-semibold text-neutral-700 hover:bg-neutral-200"
        :disabled="loading"
        @click="loadData"
      >
        Recargar
      </button>
    </div>

    <!-- Feedback messages -->
    <div v-if="loading" role="status" class="rounded-lg bg-neutral-100 p-4 text-sm text-neutral-600">
      Cargando configuración y métricas de navegación...
    </div>

    <div v-if="errorMessage" role="alert" class="rounded-lg bg-red-50 p-4 text-sm text-red-800">
      {{ errorMessage }}
    </div>

    <div v-if="successMessage" role="status" class="rounded-lg bg-green-50 p-4 text-sm text-green-800">
      {{ successMessage }}
    </div>

    <!-- Policy Card -->
    <div class="rounded-lg border border-neutral-200 bg-white p-6 shadow-sm space-y-4">
      <h3 class="text-sm font-semibold text-neutral-900">Política de Recuperación y Holdout Experimental</h3>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
        <label class="flex items-center space-x-2">
          <input
            v-model="policy.enabled"
            type="checkbox"
            class="rounded border-neutral-300 text-blue-600"
            data-testid="browse-enabled-input"
          />
          <span class="font-medium text-neutral-700">Automatización activa</span>
        </label>

        <div>
          <label class="block text-xs font-medium text-neutral-600 mb-1"> Ventana de abandono (minutos) </label>
          <input
            v-model.number="policy.abandonmentWindowMinutes"
            type="number"
            min="15"
            max="1440"
            class="w-full rounded-md border border-neutral-300 px-3 py-1.5 text-sm"
            data-testid="abandonment-window-input"
          />
        </div>

        <div>
          <label class="block text-xs font-medium text-neutral-600 mb-1"> Cooldown / Cap de frecuencia (horas) </label>
          <input
            v-model.number="policy.cooldownHours"
            type="number"
            min="1"
            max="720"
            class="w-full rounded-md border border-neutral-300 px-3 py-1.5 text-sm"
            data-testid="cooldown-hours-input"
          />
        </div>

        <div>
          <label class="block text-xs font-medium text-neutral-600 mb-1"> Grupo de Control Holdout (%) </label>
          <input
            v-model.number="policy.holdoutPercent"
            type="number"
            min="0"
            max="50"
            class="w-full rounded-md border border-neutral-300 px-3 py-1.5 text-sm"
            data-testid="holdout-percent-input"
          />
        </div>

        <div>
          <label class="block text-xs font-medium text-neutral-600 mb-1"> Ventana de atribución (días) </label>
          <input
            v-model.number="policy.attributionWindowDays"
            type="number"
            min="1"
            max="30"
            class="w-full rounded-md border border-neutral-300 px-3 py-1.5 text-sm"
            data-testid="attribution-window-input"
          />
        </div>

        <div class="flex items-end">
          <button
            type="button"
            class="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
            :disabled="saving"
            data-testid="save-browse-policy-button"
            @click="savePolicy"
          >
            {{ saving ? 'Guardando...' : 'Guardar Política' }}
          </button>
        </div>
      </div>

      <div class="rounded-md bg-amber-50 p-3 text-xs text-amber-800">
        <strong>Protección de Privacidad:</strong> Productos y categorías sensibles (biocidas médicos, desinfectantes
        clínicos, etc.) quedan estrictamente suprimidos para evitar revelación no consentida de hábitos.
      </div>
    </div>

    <!-- Incrementality Metrics Card -->
    <div v-if="metrics" class="rounded-lg border border-neutral-200 bg-white p-6 shadow-sm space-y-4">
      <div class="flex items-center justify-between">
        <h3 class="text-sm font-semibold text-neutral-900">Medición de Incrementalidad (Treatment vs Control)</h3>
        <span
          class="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium"
          :class="
            metrics.lift.statisticallySignificant ? 'bg-green-100 text-green-800' : 'bg-neutral-100 text-neutral-600'
          "
          data-testid="significance-badge"
        >
          {{ metrics.lift.statisticallySignificant ? 'Estadísticamente significativo' : 'Muestra preliminar' }}
        </span>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div class="rounded-md border border-neutral-100 bg-neutral-50 p-4">
          <p class="text-xs font-medium text-neutral-500">Tratamiento (Enviados)</p>
          <p class="text-xl font-bold text-neutral-900" data-testid="treatment-exposures">
            {{ metrics.treatment.exposures }}
          </p>
          <p class="text-xs text-neutral-600 mt-1">
            Conversiones: {{ metrics.treatment.conversions }} (CVR:
            {{ (metrics.treatment.conversionRate * 100).toFixed(2) }}%)
          </p>
        </div>

        <div class="rounded-md border border-neutral-100 bg-neutral-50 p-4">
          <p class="text-xs font-medium text-neutral-500">Control (Holdout)</p>
          <p class="text-xl font-bold text-neutral-900" data-testid="control-exposures">
            {{ metrics.control.exposures }}
          </p>
          <p class="text-xs text-neutral-600 mt-1">
            Conversiones: {{ metrics.control.conversions }} (CVR:
            {{ (metrics.control.conversionRate * 100).toFixed(2) }}%)
          </p>
        </div>

        <div class="rounded-md border border-neutral-100 bg-neutral-50 p-4">
          <p class="text-xs font-medium text-neutral-500">Lift Incremental Estimado</p>
          <p
            class="text-xl font-bold"
            :class="metrics.lift.relativeLiftPercent >= 0 ? 'text-green-600' : 'text-red-600'"
            data-testid="relative-lift"
          >
            {{ metrics.lift.relativeLiftPercent > 0 ? '+' : '' }}{{ metrics.lift.relativeLiftPercent.toFixed(1) }}%
          </p>
          <p class="text-xs text-neutral-600 mt-1">
            Ingresos incrementales: {{ (metrics.lift.incrementalRevenueGrossCents / 100).toFixed(2) }} €
          </p>
        </div>
      </div>
    </div>
  </div>
</template>
