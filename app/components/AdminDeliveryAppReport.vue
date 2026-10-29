<script setup lang="ts">
import { ref } from 'vue'
import { opsErrorMessage } from '../utils/shipping-ops-errors'

interface Report {
  route: { id: string; status: string; version: number; routeDate: string }
  events: Array<{
    commandId: string
    kind: string
    stopId: string | null
    driverId: string
    occurredAt: string
    receivedAt: string
  }>
  incidents: Array<{ id: string; stopId: string; category: string; note: string; occurredAt: string }>
  pods: Array<{
    stopId: string
    method: string
    receivedBy: string
    capturedAt: string
    hasEvidence: boolean
    evidenceSha256: string | null
    evidenceBytes: number | null
  }>
}

const requestFetch = useRequestFetch()
const routeId = ref('')
const loading = ref(false)
const error = ref<string | null>(null)
const report = ref<Report | null>(null)

async function load() {
  const id = routeId.value.trim()
  if (!id) return
  loading.value = true
  error.value = null
  report.value = null
  try {
    report.value = (await requestFetch<Report>(
      `/api/admin/delivery-app/routes/${encodeURIComponent(id)}/report`
    )) as Report
  } catch (caught) {
    error.value = opsErrorMessage(caught)
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
    <h2 class="text-lg font-semibold text-slate-900">Actividad de la app de reparto</h2>
    <form class="flex flex-wrap items-end gap-3" @submit.prevent="load">
      <label class="text-sm font-medium text-slate-700">
        Identificador de ruta
        <input
          v-model="routeId"
          data-test="route-id"
          maxlength="36"
          class="mt-1 block rounded-md border border-slate-300 px-2 py-1.5"
        />
      </label>
      <button type="submit" class="rounded-lg bg-neteco-600 px-3.5 py-2 text-sm font-medium text-white">
        Ver actividad
      </button>
    </form>

    <p v-if="!report && !loading && !error" class="text-sm text-slate-500">
      Introduce el identificador de una ruta para ver eventos, incidencias y pruebas de entrega.
    </p>
    <div v-if="loading" role="status" aria-live="polite" class="text-sm text-slate-500">Cargando actividad...</div>
    <p v-if="error" role="alert" class="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
      {{ error }}
    </p>

    <template v-if="report">
      <p class="text-sm text-slate-700">
        Ruta {{ report.route.id }} · {{ report.route.routeDate }} · {{ report.route.status }}
      </p>
      <section aria-labelledby="inc-title">
        <h3 id="inc-title" class="font-medium">Incidencias</h3>
        <p v-if="!report.incidents.length" class="text-sm text-slate-500">Sin incidencias.</p>
        <ul class="text-sm">
          <li v-for="i in report.incidents" :key="i.id">
            {{ i.occurredAt }} · parada {{ i.stopId }} · {{ i.category }}: {{ i.note }}
          </li>
        </ul>
      </section>
      <section aria-labelledby="pod-title">
        <h3 id="pod-title" class="font-medium">Pruebas de entrega</h3>
        <p v-if="!report.pods.length" class="text-sm text-slate-500">Sin pruebas de entrega.</p>
        <ul class="text-sm">
          <li v-for="p in report.pods" :key="p.stopId">
            Parada {{ p.stopId }} · {{ p.method }} · recibe {{ p.receivedBy }} · {{ p.capturedAt }}
            <a
              v-if="p.hasEvidence"
              :data-test="`evidence-${p.stopId}`"
              :href="`/api/admin/delivery-app/stops/${p.stopId}/evidence`"
              target="_blank"
              rel="noopener"
              class="underline"
              >Ver evidencia</a
            >
          </li>
        </ul>
      </section>
      <section aria-labelledby="ev-title">
        <h3 id="ev-title" class="font-medium">Registro de eventos</h3>
        <ul class="text-sm">
          <li v-for="e in report.events" :key="e.commandId">
            {{ e.receivedAt }} · {{ e.kind }}{{ e.stopId ? ` · parada ${e.stopId}` : '' }} (dispositivo:
            {{ e.occurredAt }})
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>
