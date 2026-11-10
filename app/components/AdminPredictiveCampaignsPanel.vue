<script setup lang="ts">
import { onMounted, ref } from 'vue'
import {
  validateStrictNoSedeNoHierarchy,
  type CampaignOptimizationMetrics,
  type CampaignOptimizationRule
} from '~~/shared/predictive-personalization'

const requestFetch = useRequestFetch()
const loading = ref(true)
const errorMessage = ref('')
const successMessage = ref('')

// Metrics state
const metrics = ref<CampaignOptimizationMetrics | null>(null)

// Rules state
const rules = ref<CampaignOptimizationRule[]>([])

// Create rule modal / form
const showModal = ref(false)
const ruleId = ref('')
const campaignId = ref('camp-b2b-turia-vip')
const ruleName = ref('')
const maxDiscount = ref<number>(20)
const frequencyCapDays = ref<number>(7)
const budgetCapEur = ref<number>(2000)
const autoApprovalMaxDiscount = ref<number>(10)
const validationError = ref('')

// Kill switch action loading
const togglingKillSwitch = ref<string | null>(null)

function errorText(error: unknown, fallback: string): string {
  const c = (error as { data?: { error?: { code?: string } } })?.data?.error?.code
  return c ? `${fallback} (${c})` : fallback
}

async function loadData() {
  loading.value = true
  errorMessage.value = ''
  try {
    const [metricsRes, rulesRes] = await Promise.all([
      requestFetch('/api/admin/marketing/predictive-campaigns/metrics').catch(() => null) as Promise<{
        metrics: CampaignOptimizationMetrics
      } | null>,
      requestFetch('/api/admin/marketing/predictive-campaigns/rules').catch(() => null) as Promise<{
        rules: CampaignOptimizationRule[]
      } | null>
    ])

    if (metricsRes?.metrics) {
      metrics.value = metricsRes.metrics
    }
    if (rulesRes?.rules) {
      rules.value = rulesRes.rules
    }
  } catch (error) {
    errorMessage.value = errorText(error, 'Error al cargar datos de optimización predictiva')
  } finally {
    loading.value = false
  }
}

async function handleCreateRule() {
  validationError.value = ''

  const check = validateStrictNoSedeNoHierarchy({
    name: ruleName.value,
    ruleId: ruleId.value,
    campaignId: campaignId.value
  })

  if (!check.valid) {
    validationError.value = check.reason || 'Segmentación por sede o jerarquía prohibida en Neteco.'
    return
  }

  if (maxDiscount.value > 50 || maxDiscount.value <= 0) {
    validationError.value = 'El descuento máximo no puede superar el 50% por guardrails de margen.'
    return
  }

  try {
    await requestFetch('/api/admin/marketing/predictive-campaigns/rules', {
      method: 'POST',
      body: {
        id: ruleId.value || `rule-opt-${Date.now().toString(36)}`,
        campaignId: campaignId.value,
        name: ruleName.value,
        maxDiscountPercent: Number(maxDiscount.value),
        frequencyCapDays: Number(frequencyCapDays.value),
        budgetCapCents: Math.round(Number(budgetCapEur.value) * 100),
        autoApprovalMaxDiscount: Number(autoApprovalMaxDiscount.value)
      }
    })

    showModal.value = false
    successMessage.value = 'Regla de optimización automática creada con guardrails activos.'
    ruleName.value = ''
    ruleId.value = ''
    await loadData()
  } catch (error) {
    validationError.value = errorText(error, 'Error al guardar la regla')
  }
}

async function handleToggleKillSwitch(rule: CampaignOptimizationRule) {
  togglingKillSwitch.value = rule.id
  errorMessage.value = ''
  try {
    const nextState = !rule.killSwitchActive
    await requestFetch('/api/admin/marketing/predictive-campaigns/kill-switch', {
      method: 'POST',
      body: {
        ruleId: rule.id,
        active: nextState,
        reason: nextState
          ? 'Parada de emergencia activada desde el panel de control'
          : 'Reactivación autorizada tras verificación de guardrails'
      }
    })
    rule.killSwitchActive = nextState
    rule.status = nextState ? 'killed' : 'active'
    successMessage.value = nextState
      ? `Kill switch ACTIVADO para la regla ${rule.name}. Optimización y envíos detenidos inmediatamente.`
      : `Kill switch DESACTIVADO para la regla ${rule.name}.`
  } catch (error) {
    errorMessage.value = errorText(error, 'Error al cambiar estado del kill switch')
  } finally {
    togglingKillSwitch.value = null
  }
}

onMounted(() => {
  loadData()
})
</script>

<template>
  <div class="p-6 max-w-7xl mx-auto space-y-8" role="region" aria-label="Panel de Optimización Predictiva y Guardrails">
    <!-- Header -->
    <header class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b pb-4">
      <div>
        <h1 class="text-2xl font-bold text-gray-900 dark:text-gray-100 flex items-center gap-2">
          <span>Personalización Predictiva & Optimización de Campañas</span>
          <span
            class="text-xs font-semibold px-2.5 py-0.5 rounded bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200"
          >
            MKT-037 / MKT-038
          </span>
        </h1>
        <p class="text-sm text-gray-600 dark:text-gray-400 mt-1">
          Control de sesgo, incrementalidad A/B (Holdout vs Test), guardrails de margen y kill switch de emergencia.
        </p>
      </div>
      <button
        data-test="create-rule-btn"
        class="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
        @click="showModal = true"
      >
        Nueva Regla con Guardrails
      </button>
    </header>

    <!-- Alerts -->
    <div v-if="errorMessage" data-test="error-alert" class="p-4 bg-red-50 border border-red-400 text-red-700 text-sm">
      {{ errorMessage }}
    </div>
    <div
      v-if="successMessage"
      data-test="success-alert"
      class="p-4 bg-emerald-50 border border-emerald-400 text-emerald-700 text-sm flex justify-between items-center"
    >
      <span>{{ successMessage }}</span>
      <button class="text-emerald-700 hover:underline text-xs" @click="successMessage = ''">Cerrar</button>
    </div>

    <!-- Loading State -->
    <div v-if="loading" data-test="loading-state" class="py-12 text-center text-gray-500">
      <div class="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600 mb-2"></div>
      <p>Cargando telemetría de personalización y guardrails de campañas...</p>
    </div>

    <template v-else>
      <!-- Incremental Lift Cards (MKT-037) -->
      <section aria-labelledby="metrics-heading" class="space-y-4">
        <h2 id="metrics-heading" class="text-lg font-semibold text-gray-800 dark:text-gray-200">
          Incrementalidad A/B (Holdout vs Personalización Predictiva)
        </h2>
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div class="bg-white dark:bg-gray-800 p-5 rounded-lg border shadow-sm">
            <span class="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
              >Margen Incremental Ganado</span
            >
            <div class="text-2xl font-bold text-emerald-600 dark:text-emerald-400 mt-2">
              +{{ ((metrics?.incrementalMarginLiftCents ?? 0) / 100).toFixed(2) }} €
            </div>
            <p class="text-xs text-gray-500 mt-1">Margen Test vs Grupo Holdout estático</p>
          </div>

          <div class="bg-white dark:bg-gray-800 p-5 rounded-lg border shadow-sm">
            <span class="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Lift en Conversión (CVR)</span>
            <div class="text-2xl font-bold text-indigo-600 dark:text-indigo-400 mt-2">
              +{{ (metrics?.conversionLiftPercent ?? 0).toFixed(1) }}%
            </div>
            <p class="text-xs text-gray-500 mt-1">Mejora relativa en tasa de compra</p>
          </div>

          <div class="bg-white dark:bg-gray-800 p-5 rounded-lg border shadow-sm">
            <span class="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Sesiones Grupo Test</span>
            <div class="text-2xl font-bold text-gray-900 dark:text-gray-100 mt-2">
              {{ metrics?.testImpressions ?? 0 }}
            </div>
            <p class="text-xs text-gray-500 mt-1">{{ metrics?.testConversions ?? 0 }} conversiones realizadas</p>
          </div>

          <div class="bg-white dark:bg-gray-800 p-5 rounded-lg border shadow-sm">
            <span class="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
              >Sesiones Holdout (Control)</span
            >
            <div class="text-2xl font-bold text-gray-900 dark:text-gray-100 mt-2">
              {{ metrics?.holdoutImpressions ?? 0 }}
            </div>
            <p class="text-xs text-gray-500 mt-1">{{ metrics?.holdoutConversions ?? 0 }} conversiones control</p>
          </div>
        </div>
      </section>

      <!-- Optimization Rules & Guardrails Table (MKT-038) -->
      <section aria-labelledby="rules-heading" class="space-y-4">
        <div class="flex items-center justify-between">
          <h2 id="rules-heading" class="text-lg font-semibold text-gray-800 dark:text-gray-200">
            Reglas de Optimización con Guardrails Activos
          </h2>
          <span class="text-xs text-gray-500">Tope máximo: 50% desc · Frecuencia mín: 1 impacto/7d</span>
        </div>

        <div
          v-if="rules.length === 0"
          data-test="empty-rules"
          class="p-8 text-center bg-gray-50 dark:bg-gray-800 rounded-lg border border-dashed"
        >
          <p class="text-gray-600 dark:text-gray-400">No hay reglas de optimización automáticas registradas.</p>
          <button class="mt-3 text-sm text-indigo-600 hover:underline" @click="showModal = true">
            Crear primera regla con guardrails
          </button>
        </div>

        <div v-else class="overflow-x-auto bg-white dark:bg-gray-800 rounded-lg border shadow-sm">
          <table class="min-w-full divide-y divide-gray-200 dark:divide-gray-700 text-sm">
            <thead class="bg-gray-50 dark:bg-gray-700 text-gray-500 dark:text-gray-300">
              <tr>
                <th scope="col" class="px-4 py-3 text-left font-medium">Regla / Campaña</th>
                <th scope="col" class="px-4 py-3 text-left font-medium">Tope Descuento</th>
                <th scope="col" class="px-4 py-3 text-left font-medium">Auto-Aprobación</th>
                <th scope="col" class="px-4 py-3 text-left font-medium">Cap Frecuencia</th>
                <th scope="col" class="px-4 py-3 text-left font-medium">Presupuesto</th>
                <th scope="col" class="px-4 py-3 text-left font-medium">Kill Switch</th>
                <th scope="col" class="px-4 py-3 text-right font-medium">Acción</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-200 dark:divide-gray-700">
              <tr v-for="r in rules" :key="r.id" class="hover:bg-gray-50 dark:hover:bg-gray-750">
                <td class="px-4 py-3 font-medium text-gray-900 dark:text-gray-100">
                  <div>{{ r.name }}</div>
                  <div class="text-xs text-gray-500 font-mono">{{ r.id }} ({{ r.campaignId }})</div>
                </td>
                <td class="px-4 py-3 text-gray-700 dark:text-gray-300 font-semibold">
                  Hasta {{ r.maxDiscountPercent }}%
                </td>
                <td class="px-4 py-3 text-gray-600 dark:text-gray-400">&le; {{ r.autoApprovalMaxDiscount }}% auto</td>
                <td class="px-4 py-3 text-gray-600 dark:text-gray-400">1 impacto / {{ r.frequencyCapDays }} días</td>
                <td class="px-4 py-3 text-gray-600 dark:text-gray-400 font-mono">
                  {{ (r.currentSpendCents / 100).toFixed(2) }} / {{ (r.budgetCapCents / 100).toFixed(2) }} €
                </td>
                <td class="px-4 py-3">
                  <span
                    :class="[
                      'inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold',
                      r.killSwitchActive
                        ? 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200'
                        : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200'
                    ]"
                  >
                    {{ r.killSwitchActive ? 'PARADA EMERGENCIA' : 'OPERATIVO' }}
                  </span>
                </td>
                <td class="px-4 py-3 text-right">
                  <button
                    :data-test="'kill-switch-btn-' + r.id"
                    :disabled="togglingKillSwitch === r.id"
                    :class="[
                      'px-3 py-1 text-xs font-medium rounded shadow-sm focus:outline-none',
                      r.killSwitchActive
                        ? 'bg-gray-200 hover:bg-gray-300 text-gray-800'
                        : 'bg-red-600 hover:bg-red-700 text-white'
                    ]"
                    @click="handleToggleKillSwitch(r)"
                  >
                    {{ r.killSwitchActive ? 'Reanudar' : 'Activar Kill Switch' }}
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>

    <!-- Modal Create Rule -->
    <div
      v-if="showModal"
      data-test="create-rule-modal"
      class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50"
      role="dialog"
      aria-modal="true"
    >
      <div class="bg-white dark:bg-gray-800 rounded-lg max-w-lg w-full p-6 space-y-4 shadow-xl">
        <h3 class="text-lg font-bold text-gray-900 dark:text-gray-100">Nueva Regla con Guardrails</h3>

        <div v-if="validationError" class="p-3 bg-red-50 text-red-700 text-sm rounded">
          {{ validationError }}
        </div>

        <form class="space-y-4" @submit.prevent="handleCreateRule">
          <div>
            <label class="block text-xs font-medium text-gray-700 dark:text-gray-300">Nombre de la Regla</label>
            <input
              v-model="ruleName"
              data-test="rule-name-input"
              type="text"
              required
              class="mt-1 block w-full rounded border-gray-300 shadow-sm text-sm p-2 border"
              placeholder="Ej: Auto-tune Lavanderías Industriales Q4"
            />
          </div>

          <div class="grid grid-cols-2 gap-4">
            <div>
              <label class="block text-xs font-medium text-gray-700 dark:text-gray-300">ID Regla</label>
              <input
                v-model="ruleId"
                type="text"
                class="mt-1 block w-full rounded border-gray-300 shadow-sm text-sm p-2 border font-mono"
                placeholder="rule-opt-01"
              />
            </div>
            <div>
              <label class="block text-xs font-medium text-gray-700 dark:text-gray-300">ID Campaña Destino</label>
              <input
                v-model="campaignId"
                type="text"
                required
                class="mt-1 block w-full rounded border-gray-300 shadow-sm text-sm p-2 border font-mono"
                placeholder="camp-b2b-turia-vip"
              />
            </div>
          </div>

          <div class="grid grid-cols-2 gap-4">
            <div>
              <label class="block text-xs font-medium text-gray-700 dark:text-gray-300"
                >Tope Descuento Máximo (%)</label
              >
              <input
                v-model.number="maxDiscount"
                type="number"
                min="1"
                max="50"
                required
                class="mt-1 block w-full rounded border-gray-300 shadow-sm text-sm p-2 border"
              />
            </div>
            <div>
              <label class="block text-xs font-medium text-gray-700 dark:text-gray-300"
                >Límite Auto-Aprobación (%)</label
              >
              <input
                v-model.number="autoApprovalMaxDiscount"
                type="number"
                min="1"
                max="50"
                required
                class="mt-1 block w-full rounded border-gray-300 shadow-sm text-sm p-2 border"
              />
            </div>
          </div>

          <div class="grid grid-cols-2 gap-4">
            <div>
              <label class="block text-xs font-medium text-gray-700 dark:text-gray-300">Cap Frecuencia (Días)</label>
              <input
                v-model.number="frequencyCapDays"
                type="number"
                min="1"
                max="90"
                required
                class="mt-1 block w-full rounded border-gray-300 shadow-sm text-sm p-2 border"
              />
            </div>
            <div>
              <label class="block text-xs font-medium text-gray-700 dark:text-gray-300">Presupuesto Límite (€)</label>
              <input
                v-model.number="budgetCapEur"
                type="number"
                min="10"
                required
                class="mt-1 block w-full rounded border-gray-300 shadow-sm text-sm p-2 border"
              />
            </div>
          </div>

          <div class="flex justify-end gap-3 pt-4 border-t">
            <button
              type="button"
              class="px-4 py-2 border rounded text-sm text-gray-600 hover:bg-gray-50"
              @click="showModal = false"
            >
              Cancelar
            </button>
            <button
              data-test="save-rule-btn"
              type="submit"
              class="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded text-sm font-medium"
            >
              Guardar Regla Activa
            </button>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>
