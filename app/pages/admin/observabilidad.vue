<script setup lang="ts">
import { ref } from 'vue'
import AdminErrorBudgetReleaseGate from '~/components/AdminErrorBudgetReleaseGate.vue'
import AdminCapacityPlanningPanel from '~/components/AdminCapacityPlanningPanel.vue'
import AdminB2BContractSloPanel from '~/components/AdminB2BContractSloPanel.vue'
import AdminAiopsPanel from '~/components/AdminAiopsPanel.vue'
import AdminWarehouseRouteTelemetryPanel from '~/components/AdminWarehouseRouteTelemetryPanel.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Observabilidad, SRE y Capacidad · Admin' })

const activeTab = ref<'error_budget' | 'capacity' | 'b2b_slo' | 'aiops' | 'telemetry'>('error_budget')
</script>

<template>
  <div class="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8 space-y-6">
    <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-neutral-200 pb-5">
      <div>
        <h1 class="text-2xl font-bold tracking-tight text-neutral-900">
          Observabilidad, Fiabilidad y Planificación SRE
        </h1>
        <p class="text-sm text-neutral-600 mt-1">
          Gobierno de fiabilidad en releases (OBS-025), capacidad Cloudflare (OBS-026) y acuerdos de servicio B2B
          (OBS-028).
        </p>
      </div>

      <!-- Navigation Tabs -->
      <div class="flex rounded-lg border border-neutral-200 bg-neutral-100 p-1 text-xs font-semibold">
        <button
          class="rounded-md px-3 py-1.5 transition-colors"
          :class="
            activeTab === 'error_budget'
              ? 'bg-white text-neutral-900 shadow-sm'
              : 'text-neutral-600 hover:text-neutral-900'
          "
          @click="activeTab = 'error_budget'"
        >
          Error Budget Releases
        </button>
        <button
          class="rounded-md px-3 py-1.5 transition-colors"
          :class="
            activeTab === 'capacity' ? 'bg-white text-neutral-900 shadow-sm' : 'text-neutral-600 hover:text-neutral-900'
          "
          @click="activeTab = 'capacity'"
        >
          Capacity Planning
        </button>
        <button
          class="rounded-md px-3 py-1.5 transition-colors"
          :class="
            activeTab === 'b2b_slo' ? 'bg-white text-neutral-900 shadow-sm' : 'text-neutral-600 hover:text-neutral-900'
          "
          @click="activeTab = 'b2b_slo'"
        >
          SLO Cuentas B2B
        </button>
        <button
          class="rounded-md px-3 py-1.5 transition-colors"
          :class="
            activeTab === 'aiops' ? 'bg-white text-neutral-900 shadow-sm' : 'text-neutral-600 hover:text-neutral-900'
          "
          @click="activeTab = 'aiops'"
        >
          AIOps
        </button>
        <button
          class="rounded-md px-3 py-1.5 transition-colors"
          :class="
            activeTab === 'telemetry'
              ? 'bg-white text-neutral-900 shadow-sm'
              : 'text-neutral-600 hover:text-neutral-900'
          "
          @click="activeTab = 'telemetry'"
        >
          Telemetría Almacén
        </button>
      </div>
    </div>

    <!-- Active Tab Panel -->
    <div>
      <AdminErrorBudgetReleaseGate v-if="activeTab === 'error_budget'" />
      <AdminCapacityPlanningPanel v-else-if="activeTab === 'capacity'" />
      <AdminB2BContractSloPanel v-else-if="activeTab === 'b2b_slo'" />
      <AdminAiopsPanel v-else-if="activeTab === 'aiops'" />
      <AdminWarehouseRouteTelemetryPanel v-else-if="activeTab === 'telemetry'" />
    </div>
  </div>
</template>
