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
    metrics.value = await requestFetch<{ day: string; activeKeys: number; requestsToday: number }>('/api/admin/b2b-public/metrics')
  } catch {
    failed.value = true
  } finally {
    loading.value = false
  }
}
onMounted(load)
</script>
<template>
  <section aria-labelledby="developer-metrics-title">
    <h2 id="developer-metrics-title" class="text-xl font-semibold">Métricas de la API B2B</h2>
    <p v-if="loading" role="status">Cargando métricas…</p>
    <div v-else-if="failed" role="alert">
      <p>No se pudieron cargar las métricas.</p>
      <button type="button" @click="load">Reintentar</button>
    </div>
    <dl v-else-if="metrics">
      <dt>Claves activas</dt><dd>{{ metrics.activeKeys }}</dd>
      <dt>Solicitudes admitidas el {{ metrics.day }} (UTC)</dt><dd>{{ metrics.requestsToday }}</dd>
    </dl>
  </section>
</template>
