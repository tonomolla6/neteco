<script setup lang="ts">
import { ref } from 'vue'
import AdminThirdPartyValuePanel from '~/components/AdminThirdPartyValuePanel.vue'
import AdminB2BCacheStatsPanel from '~/components/AdminB2BCacheStatsPanel.vue'
import AdminEdgePersonalizationPanel from '~/components/AdminEdgePersonalizationPanel.vue'

definePageMeta({ layout: 'admin', middleware: 'support-access' })
useSeoMeta({ title: 'Rendimiento por valor · Admin' })

const tabs = [
  { key: 'third_parties', label: 'Terceros por valor' },
  { key: 'b2b_cache', label: 'Caché B2B' },
  { key: 'edge', label: 'Personalización en el borde' }
] as const
const active = ref<(typeof tabs)[number]['key']>('third_parties')
</script>

<template>
  <div class="mx-auto max-w-7xl space-y-6 px-4 py-8 sm:px-6 lg:px-8">
    <div class="border-b border-neutral-200 pb-5">
      <h1 class="text-2xl font-bold tracking-tight text-neutral-900">Rendimiento por valor</h1>
      <p class="mt-1 text-sm text-neutral-600">
        Terceros (PER-022), caché de catálogo B2B (PER-023) y personalización limitada (PER-025).
      </p>
      <div
        class="mt-4 flex flex-wrap gap-1 rounded-lg border border-neutral-200 bg-neutral-100 p-1 text-xs font-semibold"
        role="tablist"
      >
        <button
          v-for="tab in tabs"
          :key="tab.key"
          type="button"
          role="tab"
          :aria-selected="active === tab.key"
          class="rounded-md px-3 py-1.5"
          :class="
            active === tab.key ? 'bg-white text-neutral-900 shadow-sm' : 'text-neutral-600 hover:text-neutral-900'
          "
          @click="active = tab.key"
        >
          {{ tab.label }}
        </button>
      </div>
    </div>
    <AdminThirdPartyValuePanel v-if="active === 'third_parties'" />
    <AdminB2BCacheStatsPanel v-else-if="active === 'b2b_cache'" />
    <AdminEdgePersonalizationPanel v-else />
  </div>
</template>
