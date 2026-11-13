<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { OperationalAlert, OperationalAlertSeverity, OperationalAlertArea } from '~~/shared/operational-alerts'

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
    await requestFetch<unknown, string>('/api/admin/operations/alerts', {
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

    await requestFetch<unknown, string>(`/api/admin/operations/alerts/${alertId}/${actionType.value}`, {
      method: 'POST',
      body
    })
    notice.value = ACTION_DONE[actionType.value]
    activeAlert.value = null
    actionType.value = null
    await loadAlerts()
  } catch (error) {
    errorMessage.value = errorText(error, 'Error al ejecutar la acción')
  } finally {
    busy.value = false
  }
}

const ACTION_DONE = {
  ack: 'Alerta marcada como atendida.',
  escalate: 'Alerta escalada al siguiente nivel.',
  resolve: 'Alerta resuelta.'
}
const ACTION_TITLE = { ack: 'Atender alerta', escalate: 'Escalar alerta', resolve: 'Resolver alerta' }
const SEVERITY: Record<string, [string, 'danger' | 'warning' | 'info']> = {
  critical: ['Crítica', 'danger'],
  warning: ['Aviso', 'warning'],
  info: ['Informativa', 'info']
}
const STATUS: Record<string, [string, 'danger' | 'warning' | 'info' | 'success']> = {
  open: ['Sin atender', 'danger'],
  acknowledged: ['Atendida', 'info'],
  escalated: ['Escalada', 'warning'],
  resolved: ['Resuelta', 'success']
}
const AREA: Record<string, string> = { warehouse: 'Almacén', delivery: 'Reparto', general: 'General' }
const CATEGORY: Record<string, string> = {
  chemical_spill: 'Derrame químico',
  hazard_dg_rupture: 'Rotura de mercancía peligrosa',
  temperature_breach: 'Temperatura fuera de rango',
  dock_blockage: 'Muelle bloqueado',
  vehicle_breakdown: 'Avería de vehículo',
  critical_delivery_delay: 'Retraso grave de reparto',
  general_operational: 'Incidencia general'
}
const TIER: Record<number, string> = {
  1: 'Equipo de turno',
  2: 'Jefatura de turno',
  3: 'Dirección de operaciones',
  4: 'Comité de crisis'
}
const columns = [
  { key: 'title', label: 'Alerta' },
  { key: 'severity', label: 'Gravedad' },
  { key: 'area', label: 'Zona', hideOnMobile: true },
  { key: 'status', label: 'Estado' },
  { key: 'createdAt', label: 'Fecha', hideOnMobile: true }
]
const search = ref('')
const rows = computed(() => {
  const term = search.value.toLowerCase()
  if (!term) return alerts.value
  return alerts.value.filter((alert) =>
    [alert.title, alert.description, alert.locationRef].some((text) => text.toLowerCase().includes(term))
  )
})
const filtering = computed(() => !!search.value || !!filterSeverity.value || !!filterArea.value)
function clearFilters() {
  search.value = ''
  if (filterSeverity.value || filterArea.value) {
    filterSeverity.value = ''
    filterArea.value = ''
    void loadAlerts()
  }
}

onMounted(() => {
  loadAlerts()
})
</script>

<template>
  <div class="adm-stack">
    <AdminPageActions>
      <AdminButton variant="primary" icon="i-lucide-plus" @click="showCreateModal = true">Nueva alerta</AdminButton>
    </AdminPageActions>

    <UAlert
      v-if="notice"
      role="status"
      color="success"
      variant="subtle"
      icon="i-lucide-circle-check"
      :title="notice"
      close
      @update:open="notice = ''"
    />
    <UAlert
      v-if="errorMessage"
      data-error
      role="alert"
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="errorMessage"
      :actions="[{ label: 'Reintentar', color: 'error', variant: 'outline', onClick: () => void loadAlerts() }]"
    />

    <AdminCard v-if="activeAlert && actionType" :title="ACTION_TITLE[actionType]" :description="activeAlert.title">
      <div class="adm-form-grid">
        <div v-if="actionType === 'escalate'" class="adm-field">
          <label for="alert-action-tier" class="adm-label">Escalar a</label>
          <select id="alert-action-tier" v-model="targetTier" class="adm-input">
            <option :value="2">Jefatura de turno</option>
            <option :value="3">Dirección de operaciones</option>
            <option :value="4">Comité de crisis</option>
          </select>
        </div>
        <div class="adm-field">
          <label for="alert-action-note" class="adm-label">Nota (opcional)</label>
          <input
            id="alert-action-note"
            v-model="actionNote"
            data-ack-note
            type="text"
            class="adm-input"
            placeholder="Qué se ha hecho o por qué"
          />
        </div>
      </div>
      <template #footer>
        <button type="button" class="adm-btn adm-btn--secondary" @click="closeActionModal">Cancelar</button>
        <button data-submit-ack type="button" class="adm-btn adm-btn--primary" :disabled="busy" @click="submitAction">
          Confirmar
        </button>
      </template>
    </AdminCard>

    <div :data-loading="loading ? '' : undefined" :data-empty="!loading && alerts.length === 0 ? '' : undefined">
      <AdminTable
        :rows="rows"
        :columns="columns"
        :row-key="(row) => row.id"
        :status="loading ? 'pending' : 'success'"
        :filtered="filtering"
        empty-title="No hay alertas abiertas"
        empty-description="Cuando haya una incidencia en almacén o reparto aparecerá aquí."
        empty-icon="i-lucide-bell"
        caption="Alertas de almacén y reparto"
        @clear-filters="clearFilters"
      >
        <template #toolbar>
          <AdminToolbar v-model:search="search" placeholder="Buscar alerta…">
            <label for="filter-severity" class="sr-only">Gravedad</label>
            <select id="filter-severity" v-model="filterSeverity" class="adm-input" @change="loadAlerts">
              <option value="">Cualquier gravedad</option>
              <option value="critical">Crítica</option>
              <option value="warning">Aviso</option>
              <option value="info">Informativa</option>
            </select>
            <label for="filter-area" class="sr-only">Zona</label>
            <select id="filter-area" v-model="filterArea" class="adm-input" @change="loadAlerts">
              <option value="">Todas las zonas</option>
              <option value="warehouse">Almacén</option>
              <option value="delivery">Reparto</option>
              <option value="general">General</option>
            </select>
          </AdminToolbar>
        </template>
        <template #cell-title="{ row }">
          <div class="min-w-0 max-w-xl">
            <p class="font-semibold text-[var(--text-strong)]">{{ row.title }}</p>
            <p class="adm-help whitespace-pre-line">{{ row.description }}</p>
            <p class="adm-help">
              {{ CATEGORY[row.category] ?? adminHumanize(row.category) }} · {{ row.locationRef }} · Nivel:
              {{ TIER[row.escalationTier] ?? row.escalationTier }}
            </p>
            <p v-if="row.ackNote" class="adm-help">
              <strong>Atendida:</strong> {{ row.ackNote }} ({{ adminDate(row.acknowledgedAt, true) }})
            </p>
            <p v-if="row.escalationReason" class="adm-help">
              <strong>Escalada:</strong> {{ row.escalationReason }} ({{ adminDate(row.escalatedAt, true) }})
            </p>
            <p v-if="row.resolutionNote" class="adm-help">
              <strong>Resuelta:</strong> {{ row.resolutionNote }} ({{ adminDate(row.resolvedAt, true) }})
            </p>
          </div>
        </template>
        <template #cell-severity="{ row }">
          <span class="flex flex-wrap gap-1">
            <AdminBadge :tone="SEVERITY[row.severity]?.[1] ?? 'neutral'">
              {{ SEVERITY[row.severity]?.[0] ?? adminHumanize(row.severity) }}
            </AdminBadge>
            <span v-if="row.redundantChannelDispatched" data-redundant-badge class="adm-badge adm-badge--info">
              Aviso por doble canal
            </span>
          </span>
        </template>
        <template #cell-area="{ row }">{{ AREA[row.area] ?? adminHumanize(row.area) }}</template>
        <template #cell-status="{ row }">
          <AdminBadge :tone="STATUS[row.status]?.[1] ?? 'neutral'">
            {{ STATUS[row.status]?.[0] ?? adminHumanize(row.status) }}
          </AdminBadge>
        </template>
        <template #cell-createdAt="{ row }">{{ adminDate(row.createdAt, true) }}</template>
        <template #actions="{ row }">
          <button
            v-if="row.status === 'open'"
            data-action-ack
            type="button"
            class="adm-btn adm-btn--secondary adm-btn--sm"
            @click="openAction(row, 'ack')"
          >
            Atender
          </button>
          <button
            v-if="row.status !== 'resolved'"
            data-action-escalate
            type="button"
            class="adm-btn adm-btn--secondary adm-btn--sm"
            @click="openAction(row, 'escalate')"
          >
            Escalar
          </button>
          <button
            v-if="row.status !== 'resolved'"
            data-action-resolve
            type="button"
            class="adm-btn adm-btn--secondary adm-btn--sm"
            @click="openAction(row, 'resolve')"
          >
            Resolver
          </button>
        </template>
      </AdminTable>
    </div>

    <AdminDrawer
      v-model:open="showCreateModal"
      title="Nueva alerta"
      description="Queda registrada con fecha y autor. Las críticas se avisan además por un segundo canal."
    >
      <div class="adm-stack">
        <AdminFormField v-slot="{ id }" label="Título" required>
          <input :id="id" v-model="newTitle" type="text" placeholder="Por ejemplo: derrame en el muelle 1" />
        </AdminFormField>
        <div class="grid gap-4 sm:grid-cols-2">
          <AdminFormField v-slot="{ id }" label="Zona">
            <select :id="id" v-model="newArea">
              <option value="warehouse">Almacén</option>
              <option value="delivery">Reparto</option>
              <option value="general">General</option>
            </select>
          </AdminFormField>
          <AdminFormField v-slot="{ id }" label="Gravedad">
            <select :id="id" v-model="newSeverity">
              <option value="critical">Crítica (aviso por doble canal)</option>
              <option value="warning">Aviso</option>
              <option value="info">Informativa</option>
            </select>
          </AdminFormField>
        </div>
        <AdminFormField v-slot="{ id }" label="Tipo de incidencia">
          <select :id="id" v-model="newCategory">
            <option v-for="(label, code) in CATEGORY" :key="code" :value="code">{{ label }}</option>
          </select>
        </AdminFormField>
        <AdminFormField v-slot="{ id }" label="Lugar" help="Muelle, pasillo o vehículo afectado." required>
          <input :id="id" v-model="newLocation" type="text" placeholder="Por ejemplo: muelle 1 o furgoneta 4" />
        </AdminFormField>
        <AdminFormField v-slot="{ id }" label="Descripción" required>
          <textarea :id="id" v-model="newDescription" rows="3" placeholder="Qué ha pasado y qué se necesita" />
        </AdminFormField>
      </div>
      <template #footer>
        <AdminButton @click="showCreateModal = false">Cancelar</AdminButton>
        <AdminButton
          variant="primary"
          :loading="busy"
          :disabled="!newTitle || !newDescription || !newLocation"
          @click="createAlert"
        >
          Crear alerta
        </AdminButton>
      </template>
    </AdminDrawer>
  </div>
</template>
