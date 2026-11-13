<script setup lang="ts">
import { ref } from 'vue'
import AdminErrorBudgetReleaseGate from '~/components/AdminErrorBudgetReleaseGate.vue'
import AdminCapacityPlanningPanel from '~/components/AdminCapacityPlanningPanel.vue'
import AdminB2BContractSloPanel from '~/components/AdminB2BContractSloPanel.vue'
import AdminAiopsPanel from '~/components/AdminAiopsPanel.vue'
import AdminWarehouseRouteTelemetryPanel from '~/components/AdminWarehouseRouteTelemetryPanel.vue'
import AdminAnomalyDetectionPanel from '~/components/AdminAnomalyDetectionPanel.vue'
import AdminGameDayPanel from '~/components/AdminGameDayPanel.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Supervisión · Admin' })

type ObservabilityTab = 'error_budget' | 'capacity' | 'b2b_slo' | 'aiops' | 'telemetry' | 'anomalies' | 'game_day'
const activeTab = ref<ObservabilityTab>('error_budget')
const tabs: Array<{ value: ObservabilityTab; label: string }> = [
  { value: 'error_budget', label: 'Disponibilidad' },
  { value: 'capacity', label: 'Capacidad' },
  { value: 'b2b_slo', label: 'Compromisos con empresas' },
  { value: 'aiops', label: 'Diagnóstico asistido' },
  { value: 'telemetry', label: 'Almacén y rutas' },
  { value: 'anomalies', label: 'Anomalías' },
  { value: 'game_day', label: 'Simulacros' }
]
</script>

<template>
  <AdminPage>
    <div class="adm-stack">
      <AdminTabs v-model="activeTab" :tabs="tabs" label="Apartados de supervisión" />
      <AdminErrorBudgetReleaseGate v-if="activeTab === 'error_budget'" />
      <AdminCapacityPlanningPanel v-else-if="activeTab === 'capacity'" />
      <AdminB2BContractSloPanel v-else-if="activeTab === 'b2b_slo'" />
      <AdminAiopsPanel v-else-if="activeTab === 'aiops'" />
      <AdminWarehouseRouteTelemetryPanel v-else-if="activeTab === 'telemetry'" />
      <AdminAnomalyDetectionPanel v-else-if="activeTab === 'anomalies'" />
      <AdminGameDayPanel v-else-if="activeTab === 'game_day'" />
    </div>
  </AdminPage>
</template>
