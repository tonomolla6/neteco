<script setup lang="ts">
import { ref } from 'vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Asistente IA y Enriquecimiento · Admin' })

type Tab = 'assistant' | 'catalog' | 'media'
const activeTab = ref<Tab>('assistant')
</script>

<template>
  <div class="space-y-6">
    <div class="border-b border-gray-200 pb-5 dark:border-gray-800">
      <h1 class="text-2xl font-bold tracking-tight text-gray-900 dark:text-gray-100">
        Inteligencia Artificial y Copilotos de Administración
      </h1>
      <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
        Herramientas de asistencia supervisada: citas de datos, generación con fuentes verificables y enriquecimiento visual sin invención de envases.
      </p>

      <!-- Tabs Navigation -->
      <nav class="mt-4 flex space-x-4">
        <button
          type="button"
          class="rounded-lg px-3.5 py-2 text-sm font-medium transition"
          :class="[
            activeTab === 'assistant'
              ? 'bg-blue-600 text-white shadow-sm dark:bg-blue-500'
              : 'text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'
          ]"
          @click="activeTab = 'assistant'"
        >
          Asistente de Administración (ADM-032)
        </button>
        <button
          type="button"
          class="rounded-lg px-3.5 py-2 text-sm font-medium transition"
          :class="[
            activeTab === 'catalog'
              ? 'bg-blue-600 text-white shadow-sm dark:bg-blue-500'
              : 'text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'
          ]"
          @click="activeTab = 'catalog'"
        >
          Generación de Catálogo (ADM-033)
        </button>
        <button
          type="button"
          class="rounded-lg px-3.5 py-2 text-sm font-medium transition"
          :class="[
            activeTab === 'media'
              ? 'bg-blue-600 text-white shadow-sm dark:bg-blue-500'
              : 'text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'
          ]"
          @click="activeTab = 'media'"
        >
          Enriquecimiento Visual (MED-023)
        </button>
      </nav>
    </div>

    <!-- Active Panel -->
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
</template>
