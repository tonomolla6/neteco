<script setup lang="ts">
import { ref } from 'vue'
import AnalyticsOperationsPanel from '../../components/AnalyticsOperationsPanel.vue'
import AdminCohorts from '../../components/AdminCohorts.vue'
import AdminFunnel from '../../components/AdminFunnel.vue'
import AdminPaymentFunnel from '../../components/AdminPaymentFunnel.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Analítica · Admin', robots: 'noindex, nofollow, noarchive' })
const runtime = useRuntimeConfig().public.serverRuntime

const activeTab = ref<'operations' | 'cohorts' | 'funnel' | 'payment_funnel'>('operations')
</script>

<template>
  <div class="space-y-6">
    <div class="border-b border-slate-200">
      <nav class="-mb-px flex space-x-6" aria-label="Pestañas de analítica">
        <button
          type="button"
          :class="[
            'border-b-2 py-3 px-1 text-sm font-medium transition-colors',
            activeTab === 'operations'
              ? 'border-emerald-600 text-emerald-600'
              : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-700'
          ]"
          data-testid="analytics-tab-operations"
          @click="activeTab = 'operations'"
        >
          Operaciones
        </button>
        <button
          type="button"
          :class="[
            'border-b-2 py-3 px-1 text-sm font-medium transition-colors',
            activeTab === 'cohorts'
              ? 'border-emerald-600 text-emerald-600'
              : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-700'
          ]"
          data-testid="analytics-tab-cohorts"
          @click="activeTab = 'cohorts'"
        >
          Cohortes (DAT-014)
        </button>
        <button
          type="button"
          :class="[
            'border-b-2 py-3 px-1 text-sm font-medium transition-colors',
            activeTab === 'funnel'
              ? 'border-emerald-600 text-emerald-600'
              : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-700'
          ]"
          data-testid="analytics-tab-funnel"
          @click="activeTab = 'funnel'"
        >
          Embudo (DAT-015)
        </button>
        <button
          type="button"
          :class="[
            'border-b-2 py-3 px-1 text-sm font-medium transition-colors',
            activeTab === 'payment_funnel'
              ? 'border-emerald-600 text-emerald-600'
              : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-700'
          ]"
          data-testid="analytics-tab-payment-funnel"
          @click="activeTab = 'payment_funnel'"
        >
          Funnel de pagos (PAY-018)
        </button>
      </nav>
    </div>

    <div v-show="activeTab === 'operations'">
      <AnalyticsOperationsPanel :runtime="runtime" />
    </div>
    <div v-show="activeTab === 'cohorts'">
      <AdminCohorts :runtime="runtime" />
    </div>
    <div v-show="activeTab === 'funnel'">
      <AdminFunnel :runtime="runtime" />
    </div>
    <div v-show="activeTab === 'payment_funnel'">
      <AdminPaymentFunnel :runtime="runtime" />
    </div>
  </div>
</template>
