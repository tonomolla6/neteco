<script setup lang="ts">
import { computed, ref } from 'vue'
import { developerTemplates, filterDeveloperServices } from '../../shared/developer-portal-catalog'

const query = ref('')
const services = computed(() => filterDeveloperServices(query.value))
</script>

<template>
  <div class="space-y-8">
    <section aria-labelledby="services-title">
      <h2 id="services-title" class="text-xl font-semibold">Catálogo de servicios</h2>
      <label for="service-search" class="block mt-4">Buscar servicio</label>
      <input id="service-search" v-model="query" type="search" class="border rounded p-2" />
      <p v-if="services.length === 0" role="status">Sin servicios para esta búsqueda.</p>
      <ul v-else class="mt-4 space-y-4">
        <li v-for="service in services" :key="service.id" class="border rounded p-4">
          <h3 class="font-semibold">{{ service.name }}</h3>
          <p>{{ service.owner }} — Responsable pendiente de confirmar</p>
          <p>
            Documentación en el repositorio: <code>{{ service.documentation }}</code>
          </p>
          <p>
            Runbook en el repositorio: <code>{{ service.runbook }}</code>
          </p>
          <p>Métricas no conectadas: {{ service.metricDescription }}</p>
        </li>
      </ul>
    </section>
    <section aria-labelledby="templates-title">
      <h2 id="templates-title" class="text-xl font-semibold">Plantillas</h2>
      <div v-for="template in developerTemplates" :key="template.id" class="mt-4">
        <h3 class="font-semibold">{{ template.title }}</h3>
        <ol class="list-decimal pl-6">
          <li v-for="step in template.steps" :key="step">{{ step }}</li>
        </ol>
      </div>
    </section>
  </div>
</template>
