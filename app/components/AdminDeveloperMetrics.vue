<script setup lang="ts">
import { onMounted, ref } from 'vue'
const requestFetch = useRequestFetch()
const loading = ref(true)
const failed = ref(false)
const metrics = ref<{ day: string; activeKeys: number; requestsToday: number } | null>(null)
async function load() {
  loading.value = true
  failed.value = false
  metrics.value = null
  try {
    metrics.value = await requestFetch<{ day: string; activeKeys: number; requestsToday: number }>(
      '/api/admin/b2b-public/metrics'
    )
  } catch {
    failed.value = true
  } finally {
    loading.value = false
  }
}
onMounted(load)
</script>
<template>
  <AdminSection aria-label="Uso de la API para empresas" title="Uso de la API para empresas">
    <p v-if="loading" role="status" class="adm-help">Cargando métricas…</p>
    <div v-else-if="failed" role="alert">
      <AdminEmptyState
        variant="error"
        compact
        title="No se pudieron cargar las métricas"
        description="Comprueba la conexión y vuelve a intentarlo."
      >
        <button type="button" class="adm-btn adm-btn--secondary" @click="load">Reintentar</button>
      </AdminEmptyState>
    </div>
    <div v-else-if="metrics" class="adm-grid">
      <AdminStat label="Claves activas" :value="metrics.activeKeys" icon="i-lucide-key-round" />
      <AdminStat
        label="Solicitudes admitidas hoy"
        :value="metrics.requestsToday"
        :hint="`Día ${metrics.day} (hora universal)`"
        icon="i-lucide-activity"
      />
    </div>
  </AdminSection>
</template>
