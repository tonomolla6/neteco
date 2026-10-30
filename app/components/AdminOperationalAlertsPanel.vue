<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { OperationalAlert, OperationalAlertSeverity, OperationalAlertArea } from '../../shared/operational-alerts'

const requestFetch = useRequestFetch()
const loading = ref(true)
const busy = ref(false)
const errorMessage = ref('')
const notice = ref('')

const alerts = ref<OperationalAlert[]>([])
const filterSeverity = ref<string>('')
const filterArea = ref<string>('')

// Form states
const showCreateModal = ref(false)
const newArea = ref<OperationalAlertArea>('warehouse')
const newSeverity = ref<OperationalAlertSeverity>('critical')
const newCategory = ref<string>('chemical_spill')
const newTitle = ref('')
const newDescription = ref('')
const newLocation = ref('')

// Action modal states
const activeAlert = ref<OperationalAlert | null>(null)
const actionType = ref<'ack' | 'escalate' | 'resolve' | null>(null)
const actionNote = ref('')
const targetTier = ref<number>(2)

function errorText(error: unknown, fallback: string): string {
  const code = (error as { data?: { error?: { code?: string } } })?.data?.error?.code
  return code ? `${fallback} (${code})` : fallback
}

async function loadAlerts() {
  loading.value = true
  errorMessage.value = ''
  try {
    const params = new URLSearchParams()
    if (filterSeverity.value) params.set('severity', filterSeverity.value)
    if (filterArea.value) params.set('area', filterArea.value)

    const url = `/api/admin/operations/alerts${params.toString() ? '?' + params.toString() : ''}`
    const res = (await requestFetch(url)) as { items: OperationalAlert[]; total: number }
    alerts.value = res?.items ?? []
  } catch (error) {
    errorMessage.value = errorText(error, 'Error al cargar las alertas operativas')
  } finally {
    loading.value = false
  }
}

async function createAlert() {
  if (!newTitle.value || !newDescription.value || !newLocation.value) return
  busy.value = true
  errorMessage.value = ''
  try {
    const alertId = crypto.randomUUID()
    const commandId = crypto.randomUUID()
    await requestFetch('/api/admin/operations/alerts', {
      method: 'POST',
      body: {
        alertId,
        commandId,
        area: newArea.value,
        severity: newSeverity.value,
        category: newCategory.value,
        title: newTitle.value,
        description: newDescription.value,
        locationRef: newLocation.value
      }
    })
    notice.value = 'Alerta operativa registrada correctamente.'
    showCreateModal.value = false
    newTitle.value = ''
    newDescription.value = ''
    newLocation.value = ''
    await loadAlerts()
  } catch (error) {
    errorMessage.value = errorText(error, 'Error al crear la alerta')
  } finally {
    busy.value = false
  }
}

function closeActionModal() {
  activeAlert.value = null
  actionType.value = null
}

function openAction(alert: OperationalAlert, type: 'ack' | 'escalate' | 'resolve') {
  activeAlert.value = alert
  actionType.value = type
  actionNote.value = ''
  targetTier.value = Math.min(alert.escalationTier + 1, 4)
}

async function submitAction() {
  if (!activeAlert.value || !actionType.value) return
  busy.value = true
  errorMessage.value = ''
  try {
    const alertId = activeAlert.value.id
    const commandId = crypto.randomUUID()
    const version = activeAlert.value.version

    const body: Record<string, unknown> = { commandId, expectedVersion: version }
    if (actionType.value === 'ack') {
      body.ackNote = actionNote.value || 'Acuse de recibo registrado'
    } else if (actionType.value === 'escalate') {
      body.targetTier = targetTier.value
      body.escalationReason = actionNote.value || 'Escalado operativo'
    } else if (actionType.value === 'resolve') {
      body.resolutionNote = actionNote.value || 'Incidencia resuelta'
    }

    await requestFetch(`/api/admin/operations/alerts/${alertId}/${actionType.value}`, {
      method: 'POST',
      body
    })
    notice.value = `Acción ${actionType.value} ejecutada con éxito.`
    activeAlert.value = null
    actionType.value = null
    await loadAlerts()
  } catch (error) {
    errorMessage.value = errorText(error, 'Error al ejecutar la acción')
  } finally {
    busy.value = false
  }
}

onMounted(() => {
  loadAlerts()
})
</script>

<template>
  <div class="space-y-6">
    <!-- Header -->
    <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
      <div>
        <h2 class="text-lg font-bold text-neutral-900">Alertas Operativas (Almacén y Reparto)</h2>
        <p class="text-sm text-neutral-600">
          Canal redundante para excepciones críticas, ciclo de vida con acuse/escalado y canales auditables (COM-019).
        </p>
      </div>
      <button
        class="inline-flex items-center rounded-md bg-rose-600 px-3.5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-rose-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-600"
        @click="showCreateModal = true"
      >
        + Nueva Alerta Operativa
      </button>
    </div>

    <!-- Feedback notices -->
    <div v-if="notice" class="rounded-md bg-emerald-50 p-4 text-sm text-emerald-800 border border-emerald-200">
      {{ notice }}
    </div>
    <div
      v-if="errorMessage"
      data-error
      class="rounded-md bg-rose-50 p-4 text-sm text-rose-800 border border-rose-200 flex items-center justify-between"
    >
      <span>{{ errorMessage }}</span>
      <button class="underline font-semibold" @click="loadAlerts">Reintentar</button>
    </div>

    <!-- Filters -->
    <div class="flex flex-wrap gap-4 items-center bg-neutral-50 p-3 rounded-lg border border-neutral-200 text-sm">
      <div class="flex items-center gap-2">
        <label for="filter-severity" class="font-medium text-neutral-700">Severidad:</label>
        <select
          id="filter-severity"
          v-model="filterSeverity"
          class="rounded border-neutral-300 py-1 px-2 text-sm"
          @change="loadAlerts"
        >
          <option value="">Todas</option>
          <option value="critical">Crítica</option>
          <option value="warning">Aviso</option>
          <option value="info">Informativa</option>
        </select>
      </div>

      <div class="flex items-center gap-2">
        <label for="filter-area" class="font-medium text-neutral-700">Área:</label>
        <select
          id="filter-area"
          v-model="filterArea"
          class="rounded border-neutral-300 py-1 px-2 text-sm"
          @change="loadAlerts"
        >
          <option value="">Todas</option>
          <option value="warehouse">Almacén</option>
          <option value="delivery">Reparto</option>
          <option value="general">General</option>
        </select>
      </div>
    </div>

    <!-- Loading state -->
    <div v-if="loading" data-loading class="py-12 text-center text-sm text-neutral-500">
      Cargando alertas operativas...
    </div>

    <!-- Empty state -->
    <div
      v-else-if="alerts.length === 0"
      data-empty
      class="rounded-lg border-2 border-dashed border-neutral-200 p-8 text-center text-sm text-neutral-500"
    >
      No hay alertas operativas activas que coincidan con los filtros seleccionados.
    </div>

    <!-- Alerts List -->
    <div v-else class="space-y-4">
      <div
        v-for="alert in alerts"
        :key="alert.id"
        class="rounded-lg border p-5 shadow-sm transition-all"
        :class="{
          'border-rose-300 bg-rose-50/40': alert.severity === 'critical',
          'border-amber-300 bg-amber-50/40': alert.severity === 'warning',
          'border-neutral-200 bg-white': alert.severity === 'info'
        }"
      >
        <div class="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
          <div class="space-y-1">
            <div class="flex flex-wrap items-center gap-2">
              <span
                class="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wider"
                :class="{
                  'bg-rose-100 text-rose-800': alert.severity === 'critical',
                  'bg-amber-100 text-amber-800': alert.severity === 'warning',
                  'bg-blue-100 text-blue-800': alert.severity === 'info'
                }"
              >
                {{ alert.severity }}
              </span>

              <span
                v-if="alert.redundantChannelDispatched"
                data-redundant-badge
                class="inline-flex items-center rounded-full bg-purple-100 text-purple-800 px-2.5 py-0.5 text-xs font-semibold"
              >
                Canal Redundante Activo
              </span>

              <span class="text-xs font-medium text-neutral-500 uppercase">
                {{ alert.area }} · {{ alert.category }} · Ref: {{ alert.locationRef }}
              </span>

              <span class="text-xs text-neutral-400"> v{{ alert.version }} · Nivel {{ alert.escalationTier }} </span>
            </div>

            <h3 class="text-base font-semibold text-neutral-900">{{ alert.title }}</h3>
            <p class="text-sm text-neutral-700 whitespace-pre-line">{{ alert.description }}</p>

            <div v-if="alert.ackNote" class="text-xs text-neutral-600 bg-neutral-100 p-2 rounded mt-2">
              <span class="font-semibold">Acuse:</span> {{ alert.ackNote }} (a las {{ alert.acknowledgedAt }})
            </div>
            <div v-if="alert.escalationReason" class="text-xs text-amber-800 bg-amber-50 p-2 rounded mt-2">
              <span class="font-semibold">Escalado:</span> {{ alert.escalationReason }} (a las {{ alert.escalatedAt }})
            </div>
            <div v-if="alert.resolutionNote" class="text-xs text-emerald-800 bg-emerald-50 p-2 rounded mt-2">
              <span class="font-semibold">Resolución:</span> {{ alert.resolutionNote }} (a las {{ alert.resolvedAt }})
            </div>
          </div>

          <!-- Actions -->
          <div class="flex sm:flex-col gap-2 shrink-0">
            <button
              v-if="alert.status === 'open'"
              data-action-ack
              class="rounded bg-white px-3 py-1.5 text-xs font-medium text-neutral-700 shadow-sm border border-neutral-300 hover:bg-neutral-50"
              @click="openAction(alert, 'ack')"
            >
              Reconocer
            </button>
            <button
              v-if="alert.status !== 'resolved'"
              data-action-escalate
              class="rounded bg-white px-3 py-1.5 text-xs font-medium text-amber-700 shadow-sm border border-amber-300 hover:bg-amber-50"
              @click="openAction(alert, 'escalate')"
            >
              Escalar
            </button>
            <button
              v-if="alert.status !== 'resolved'"
              data-action-resolve
              class="rounded bg-white px-3 py-1.5 text-xs font-medium text-emerald-700 shadow-sm border border-emerald-300 hover:bg-emerald-50"
              @click="openAction(alert, 'resolve')"
            >
              Resolver
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Create Alert Modal -->
    <div v-if="showCreateModal" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div class="w-full max-w-lg rounded-xl bg-white p-6 shadow-xl space-y-4">
        <h3 class="text-lg font-bold text-neutral-900">Registrar Alerta Operativa</h3>
        <p class="text-xs text-neutral-500">
          Las alertas son registradas de forma auditable. Se prohíbe el uso de grupos personales no auditables (art.
          aceptación COM-019).
        </p>

        <div class="space-y-3 text-sm">
          <div>
            <label class="block font-medium text-neutral-700">Título</label>
            <input
              v-model="newTitle"
              type="text"
              class="w-full rounded border-neutral-300 p-2 text-sm border"
              placeholder="p.ej. Derrame químico muelle 1"
            />
          </div>

          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block font-medium text-neutral-700">Área</label>
              <select v-model="newArea" class="w-full rounded border-neutral-300 p-2 text-sm border">
                <option value="warehouse">Almacén</option>
                <option value="delivery">Reparto</option>
                <option value="general">General</option>
              </select>
            </div>
            <div>
              <label class="block font-medium text-neutral-700">Severidad</label>
              <select v-model="newSeverity" class="w-full rounded border-neutral-300 p-2 text-sm border">
                <option value="critical">Crítica (Redundante)</option>
                <option value="warning">Aviso</option>
                <option value="info">Informativa</option>
              </select>
            </div>
          </div>

          <div>
            <label class="block font-medium text-neutral-700">Categoría</label>
            <select v-model="newCategory" class="w-full rounded border-neutral-300 p-2 text-sm border">
              <option value="chemical_spill">Derrame químico / vertido</option>
              <option value="hazard_dg_rupture">Rotura mercancía peligrosa (ADR)</option>
              <option value="temperature_breach">Incumplimiento térmico</option>
              <option value="dock_blockage">Bloqueo de muelle</option>
              <option value="vehicle_breakdown">Avería de vehículo</option>
              <option value="critical_delivery_delay">Retraso crítico de reparto</option>
              <option value="general_operational">Operativa general</option>
            </select>
          </div>

          <div>
            <label class="block font-medium text-neutral-700">Ubicación / Referencia</label>
            <input
              v-model="newLocation"
              type="text"
              class="w-full rounded border-neutral-300 p-2 text-sm border"
              placeholder="p.ej. DOCK-01 o VEH-04"
            />
          </div>

          <div>
            <label class="block font-medium text-neutral-700">Descripción detallada</label>
            <textarea
              v-model="newDescription"
              rows="3"
              class="w-full rounded border-neutral-300 p-2 text-sm border"
              placeholder="Describe la incidencia operativa..."
            ></textarea>
          </div>
        </div>

        <div class="flex justify-end gap-2 pt-2">
          <button
            class="rounded px-4 py-2 text-sm text-neutral-700 hover:bg-neutral-100"
            @click="showCreateModal = false"
          >
            Cancelar
          </button>
          <button
            class="rounded bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-500 disabled:opacity-50"
            :disabled="busy || !newTitle || !newDescription || !newLocation"
            @click="createAlert"
          >
            Emitir Alerta
          </button>
        </div>
      </div>
    </div>

    <!-- Action Modal (Ack / Escalate / Resolve) -->
    <div v-if="activeAlert && actionType" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div class="w-full max-w-md rounded-xl bg-white p-6 shadow-xl space-y-4">
        <h3 class="text-lg font-bold text-neutral-900">
          {{
            actionType === 'ack' ? 'Reconocer Alerta' : actionType === 'escalate' ? 'Escalar Alerta' : 'Resolver Alerta'
          }}
        </h3>
        <p class="text-xs text-neutral-500">
          Alerta: {{ activeAlert.title }} (Versión actual CAS: {{ activeAlert.version }})
        </p>

        <div v-if="actionType === 'escalate'" class="space-y-1">
          <label class="block text-sm font-medium text-neutral-700">Nivel de escalado</label>
          <select v-model="targetTier" class="w-full rounded border-neutral-300 p-2 text-sm border">
            <option :value="2">Nivel 2 (Jefatura de turno)</option>
            <option :value="3">Nivel 3 (Dirección de operaciones)</option>
            <option :value="4">Nivel 4 (Comité de crisis)</option>
          </select>
        </div>

        <div class="space-y-1">
          <label class="block text-sm font-medium text-neutral-700">Nota / Motivo</label>
          <input
            v-model="actionNote"
            data-ack-note
            type="text"
            class="w-full rounded border-neutral-300 p-2 text-sm border"
            placeholder="Introduce los detalles de la acción..."
          />
        </div>

        <div class="flex justify-end gap-2 pt-2">
          <button class="rounded px-4 py-2 text-sm text-neutral-700 hover:bg-neutral-100" @click="closeActionModal">
            Cancelar
          </button>
          <button
            data-submit-ack
            class="rounded bg-neutral-900 px-4 py-2 text-sm font-semibold text-white hover:bg-neutral-800 disabled:opacity-50"
            :disabled="busy"
            @click="submitAction"
          >
            Confirmar
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
