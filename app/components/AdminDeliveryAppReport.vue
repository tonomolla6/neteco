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

const shortId = (id: string) => (id.length > 12 ? `#${id.slice(0, 8).toUpperCase()}` : id)
const routeStatusLabel: Record<string, string> = {
  draft: 'Borrador',
  planned: 'Planificada',
  in_progress: 'En reparto',
  completed: 'Completada',
  cancelled: 'Cancelada'
}
const incidentLabel: Record<string, string> = {
  customer_absent: 'Cliente ausente',
  wrong_address: 'Dirección incorrecta',
  access_blocked: 'Acceso bloqueado',
  damaged_parcel: 'Bulto dañado',
  refused: 'Entrega rechazada',
  vehicle_issue: 'Avería del vehículo',
  other: 'Otra incidencia'
}
const podMethodLabel: Record<string, string> = {
  signature: 'Firma',
  photo: 'Fotografía',
  neighbour: 'Entregado a un vecino'
}
const eventLabel: Record<string, string> = {
  start_route: 'Inicio de ruta',
  start: 'Salida hacia la parada',
  deliver: 'Entrega realizada',
  fail: 'Entrega fallida',
  incident: 'Incidencia',
  complete_route: 'Fin de ruta'
}

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
  <div class="adm-stack">
    <form class="adm-toolbar" aria-label="Consultar una ruta" @submit.prevent="load">
      <input
        v-model="routeId"
        data-test="route-id"
        maxlength="36"
        class="adm-input"
        placeholder="Identificador de la ruta"
        aria-label="Identificador de la ruta"
      />
      <button type="submit" class="adm-btn adm-btn--primary">Ver actividad</button>
    </form>

    <div v-if="loading" role="status" aria-live="polite" class="adm-help">Cargando actividad…</div>
    <AdminCard v-else-if="error">
      <div role="alert">
        <AdminEmptyState compact variant="error" title="No se ha podido cargar la actividad" :description="error">
          <AdminButton icon="i-lucide-rotate-cw" @click="load()">Reintentar</AdminButton>
        </AdminEmptyState>
      </div>
    </AdminCard>
    <AdminCard v-else-if="!report">
      <AdminEmptyState
        compact
        icon="i-lucide-smartphone"
        title="Consulta la actividad de una ruta"
        description="Introduce el identificador de una ruta para ver eventos, incidencias y pruebas de entrega."
      />
    </AdminCard>

    <template v-if="report">
      <div class="adm-grid">
        <AdminStat
          label="Ruta"
          :value="shortId(report.route.id)"
          :hint="`${adminDate(report.route.routeDate)} · ${routeStatusLabel[report.route.status] ?? adminStatusLabel(report.route.status)}`"
        />
        <AdminStat label="Incidencias" :value="report.incidents.length" />
        <AdminStat label="Pruebas de entrega" :value="report.pods.length" />
        <AdminStat label="Eventos registrados" :value="report.events.length" />
      </div>

      <AdminCard flush aria-labelledby="inc-title">
        <template #title><span id="inc-title">Incidencias</span></template>
        <AdminEmptyState v-if="!report.incidents.length" compact icon="i-lucide-circle-check" title="Sin incidencias" />
        <ul v-else class="adm-list">
          <li v-for="i in report.incidents" :key="i.id">
            <div class="min-w-0 flex-1">
              <p class="adm-list__title">{{ incidentLabel[i.category] ?? adminHumanize(i.category) }}</p>
              <p class="adm-help">{{ i.note }}</p>
            </div>
            <span class="adm-help">Parada {{ shortId(i.stopId) }} · {{ adminDate(i.occurredAt, true) }}</span>
          </li>
        </ul>
      </AdminCard>

      <AdminCard flush aria-labelledby="pod-title">
        <template #title><span id="pod-title">Pruebas de entrega</span></template>
        <AdminEmptyState
          v-if="!report.pods.length"
          compact
          icon="i-lucide-file-signature"
          title="Sin pruebas de entrega"
        />
        <ul v-else class="adm-list">
          <li v-for="p in report.pods" :key="p.stopId">
            <div class="min-w-0 flex-1">
              <p class="adm-list__title">Recibe {{ p.receivedBy }}</p>
              <p class="adm-help">
                Parada {{ shortId(p.stopId) }} · {{ podMethodLabel[p.method] ?? adminHumanize(p.method) }} ·
                {{ adminDate(p.capturedAt, true) }}
              </p>
            </div>
            <a
              v-if="p.hasEvidence"
              :data-test="`evidence-${p.stopId}`"
              :href="`/api/admin/delivery-app/stops/${p.stopId}/evidence`"
              target="_blank"
              rel="noopener"
              class="adm-btn adm-btn--secondary adm-btn--sm"
              >Ver evidencia</a
            >
          </li>
        </ul>
      </AdminCard>

      <AdminCard flush aria-labelledby="ev-title">
        <template #title><span id="ev-title">Registro de eventos</span></template>
        <AdminEmptyState v-if="!report.events.length" compact icon="i-lucide-list" title="Sin eventos registrados" />
        <ul v-else class="adm-list">
          <li v-for="e in report.events" :key="e.commandId">
            <p class="adm-list__title min-w-0 flex-1">
              {{ eventLabel[e.kind] ?? adminHumanize(e.kind) }}{{ e.stopId ? ` · parada ${shortId(e.stopId)}` : '' }}
            </p>
            <span class="adm-help">
              Recibido {{ adminDate(e.receivedAt, true) }} · en el móvil {{ adminDate(e.occurredAt, true) }}
            </span>
          </li>
        </ul>
      </AdminCard>
    </template>
  </div>
</template>
