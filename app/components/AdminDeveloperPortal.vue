<script setup lang="ts">
import { computed, ref } from 'vue'
import { developerTemplates, filterDeveloperServices } from '~~/shared/developer-portal-catalog'

const query = ref('')
const services = computed(() => filterDeveloperServices(query.value))
</script>

<template>
  <div class="adm-stack">
    <AdminCard aria-labelledby="services-title" flush>
      <template #title><span id="services-title">Catálogo de servicios</span></template>
      <template #actions>
        <label for="service-search" class="sr-only">Buscar servicio</label>
        <input id="service-search" v-model="query" type="search" class="adm-input" placeholder="Buscar servicio…" />
      </template>
      <div v-if="services.length === 0" role="status">
        <AdminEmptyState variant="filtered" compact title="Sin servicios para esta búsqueda" />
      </div>
      <ul v-else class="adm-list">
        <li v-for="service in services" :key="service.id">
          <div class="min-w-0 flex-1">
            <h3 class="adm-list__title">{{ service.name }}</h3>
            <p class="adm-help">{{ service.owner }} · Responsable pendiente de confirmar</p>
            <p class="adm-help">
              Documentación: <code>{{ service.documentation }}</code> · Procedimiento:
              <code>{{ service.runbook }}</code>
            </p>
          </div>
          <AdminBadge tone="neutral" plain>Métricas no conectadas: {{ service.metricDescription }}</AdminBadge>
        </li>
      </ul>
    </AdminCard>
    <AdminSection aria-labelledby="templates-title" title="Plantillas">
      <div class="adm-grid">
        <AdminCard v-for="template in developerTemplates" :key="template.id" :title="template.title">
          <ol class="list-decimal space-y-1 pl-5">
            <li v-for="step in template.steps" :key="step">{{ step }}</li>
          </ol>
        </AdminCard>
      </div>
    </AdminSection>
  </div>
</template>
