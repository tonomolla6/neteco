<script setup lang="ts">
import { ref } from 'vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Asistente de IA · Admin' })

type Tab = 'assistant' | 'catalog' | 'media'
const activeTab = ref<Tab>('assistant')
const tabs: Array<{ value: Tab; label: string }> = [
  { value: 'assistant', label: 'Asistente' },
  { value: 'catalog', label: 'Textos de producto' },
  { value: 'media', label: 'Imágenes' }
]
</script>

<template>
  <AdminPage>
    <div class="adm-stack">
      <AdminTabs
        :model-value="activeTab"
        :tabs="tabs"
        label="Apartados del asistente"
        @update:model-value="activeTab = $event as Tab"
      />

      <div v-show="activeTab === 'assistant'">
        <AdminAiAssistant />
      </div>

      <div v-show="activeTab === 'catalog'">
        <AdminCatalogAiGeneration />
      </div>

      <div v-show="activeTab === 'media'">
        <AdminMediaAiEnrichment />
      </div>
    </div>
  </AdminPage>
</template>
