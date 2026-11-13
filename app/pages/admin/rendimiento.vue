<script setup lang="ts">
import { ref } from 'vue'
import AdminThirdPartyValuePanel from '~/components/AdminThirdPartyValuePanel.vue'
import AdminB2BCacheStatsPanel from '~/components/AdminB2BCacheStatsPanel.vue'
import AdminEdgePersonalizationPanel from '~/components/AdminEdgePersonalizationPanel.vue'

definePageMeta({ layout: 'admin', middleware: 'support-access' })
useSeoMeta({ title: 'Velocidad de la tienda · Admin' })

const tabs = [
  { value: 'third_parties', label: 'Servicios externos' },
  { value: 'b2b_cache', label: 'Caché para profesionales' },
  { value: 'edge', label: 'Contenido por tipo de cliente' }
]
const active = ref('third_parties')
</script>

<template>
  <AdminPage>
    <div class="adm-stack">
      <AdminTabs v-model="active" :tabs="tabs" label="Apartados de velocidad de la tienda" />
      <AdminThirdPartyValuePanel v-if="active === 'third_parties'" />
      <AdminB2BCacheStatsPanel v-else-if="active === 'b2b_cache'" />
      <AdminEdgePersonalizationPanel v-else />
    </div>
  </AdminPage>
</template>
