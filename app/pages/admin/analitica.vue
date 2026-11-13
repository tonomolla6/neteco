<script setup lang="ts">
import { computed } from 'vue'
import AnalyticsOperationsPanel from '../../components/AnalyticsOperationsPanel.vue'
import AdminCohorts from '../../components/AdminCohorts.vue'
import AdminFunnel from '../../components/AdminFunnel.vue'
import AdminPaymentFunnel from '../../components/AdminPaymentFunnel.vue'
import AdminSeoContentDashboard from '../../components/AdminSeoContentDashboard.vue'
import AdminB2bSalesMetrics from '../../components/AdminB2bSalesMetrics.vue'
import AdminCostToServe from '../../components/AdminCostToServe.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Analítica · Admin', robots: 'noindex, nofollow, noarchive' })
const runtime = useRuntimeConfig().public.serverRuntime

type AnalyticsTab =
  'operations' | 'cohorts' | 'funnel' | 'payment_funnel' | 'seo_content' | 'b2b_sales' | 'cost_to_serve'
// El embudo de pago tiene su propia pestaña en la cabecera (`?tab=payment_funnel`), así que no se repite aquí.
const tabs: Array<{ value: AnalyticsTab; label: string; testid: string }> = [
  { value: 'operations', label: 'Cobros y visitas', testid: 'operations' },
  { value: 'funnel', label: 'Embudo de conversión', testid: 'funnel' },
  { value: 'cohorts', label: 'Clientes que repiten', testid: 'cohorts' },
  { value: 'b2b_sales', label: 'Ventas a empresas', testid: 'b2b-sales' },
  { value: 'cost_to_serve', label: 'Rentabilidad por pedido', testid: 'cost-to-serve' },
  { value: 'seo_content', label: 'Buscadores', testid: 'seo-content' }
]
const route = useRoute()
const router = useRouter()
// La pestaña activa vive en la URL: así la abre la cabecera y se puede compartir el enlace.
const activeTab = computed<AnalyticsTab>({
  get: () => {
    const requested = route.query.tab
    return requested === 'payment_funnel' || tabs.some((tab) => tab.value === requested)
      ? (requested as AnalyticsTab)
      : 'operations'
  },
  set: (value) => void router.replace({ query: value === 'operations' ? {} : { tab: value } })
})
</script>

<template>
  <AdminPage>
    <div class="adm-stack">
      <div v-if="activeTab !== 'payment_funnel'" class="adm-tabs" role="tablist" aria-label="Pestañas de analítica">
        <button
          v-for="tab in tabs"
          :key="tab.value"
          type="button"
          role="tab"
          class="adm-tab"
          :aria-selected="activeTab === tab.value"
          :data-testid="`analytics-tab-${tab.testid}`"
          @click="activeTab = tab.value"
        >
          {{ tab.label }}
        </button>
      </div>

      <div v-show="activeTab === 'operations'">
        <AdminServiceGate service="analytics"><AnalyticsOperationsPanel :runtime="runtime" /></AdminServiceGate>
      </div>
      <div v-show="activeTab === 'cohorts'">
        <AdminServiceGate service="analytics"><AdminCohorts :runtime="runtime" /></AdminServiceGate>
      </div>
      <div v-show="activeTab === 'funnel'">
        <AdminServiceGate service="analytics"><AdminFunnel :runtime="runtime" /></AdminServiceGate>
      </div>
      <div v-show="activeTab === 'payment_funnel'">
        <AdminPaymentFunnel :runtime="runtime" />
      </div>
      <div v-show="activeTab === 'seo_content'">
        <AdminSeoContentDashboard :runtime="runtime" />
      </div>
      <div v-show="activeTab === 'b2b_sales'">
        <AdminB2bSalesMetrics :runtime="runtime" />
      </div>
      <div v-show="activeTab === 'cost_to_serve'">
        <AdminCostToServe :runtime="runtime" />
      </div>
    </div>
  </AdminPage>
</template>
