<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import type { AdminDeliverySurveysDashboard, ContactReason } from '../../workers/fulfillment/delivery-survey'
import { CONTACT_REASONS, CONTACT_REASON_LABELS } from '../../workers/fulfillment/delivery-survey'

defineProps<{
  runtime?: unknown
}>()

const requestFetch = useRequestFetch()

const loading = ref(true)
const error = ref<string | null>(null)
const data = ref<AdminDeliverySurveysDashboard | null>(null)

// Default range: last 30 days
const now = new Date()
const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000)

const fromDate = ref(thirtyDaysAgo.toISOString().slice(0, 10))
const toDate = ref(now.toISOString().slice(0, 10))
const selectedSegment = ref<'all' | 'particular' | 'profesional'>('all')
const selectedReason = ref<ContactReason | 'all'>('all')

// Atajos de periodo de la barra de filtros
const period = ref('30')
const PERIODS = [
  { value: '7', label: '7 días' },
  { value: '30', label: '30 días' },
  { value: '90', label: '90 días' }
]
function setPreset(value: string) {
  const end = new Date()
  const start = new Date(end.getTime() - Number(value) * 86400000)
  period.value = value
  fromDate.value = start.toISOString().slice(0, 10)
  toDate.value = end.toISOString().slice(0, 10)
  void fetchDashboard()
}
function resetFilters() {
  selectedSegment.value = 'all'
  selectedReason.value = 'all'
  void fetchDashboard()
}
function onDateChange() {
  period.value = ''
  if (fromDate.value && toDate.value) void fetchDashboard()
}

const SEGMENT_LABEL: Record<string, string> = { particular: 'Particular', profesional: 'Profesional' }
const responseColumns = [
  { key: 'orderNumber', label: 'Pedido' },
  { key: 'submittedAt', label: 'Fecha', sortable: true },
  { key: 'customerSegment', label: 'Tipo de cliente' },
  { key: 'score', label: 'Valoración', sortable: true, numeric: true },
  { key: 'arrivedGood', label: '¿Llegó bien?' },
  { key: 'contactReason', label: 'Motivo', hideOnMobile: true },
  { key: 'supportTicketPublicRef', label: 'Consulta de soporte' }
]

async function fetchDashboard() {
  loading.value = true
  error.value = null

  try {
    const fromIso = `${fromDate.value}T00:00:00Z`
    const toIso = `${toDate.value}T23:59:59Z`

    const queryParams: Record<string, string | number> = {
      from: fromIso,
      to: toIso,
      page: 1,
      perPage: 25
    }

    if (selectedSegment.value !== 'all') {
      queryParams.segment = selectedSegment.value
    }
    if (selectedReason.value !== 'all') {
      queryParams.contactReason = selectedReason.value
    }

    const response = await requestFetch<AdminDeliverySurveysDashboard>('/api/admin/fulfillment/delivery-surveys', {
      method: 'GET',
      query: queryParams
    })

    data.value = response
  } catch {
    error.value = 'No se han podido cargar las encuestas de entrega. Comprueba tus permisos de administración.'
  } finally {
    loading.value = false
  }
}

function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—'
  return `${(value * 100).toFixed(1)}%`
}

function formatScore(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—'
  return value.toFixed(1)
}

const reasonOptions = computed(() => [
  { value: 'all', label: 'Todos los motivos' },
  ...CONTACT_REASONS.map((r) => ({
    value: r,
    label: CONTACT_REASON_LABELS[r]
  }))
])

const segments = computed(() =>
  data.value
    ? [
        { key: 'particular', label: 'Particular', ...data.value.bySegment.particular },
        { key: 'profesional', label: 'Profesional', ...data.value.bySegment.profesional }
      ]
    : []
)
const scoreBreakdown = computed(() =>
  data.value
    ? ([5, 4, 3, 2, 1] as const).map((star) => ({
        label: star === 1 ? '1 estrella' : `${star} estrellas`,
        value: data.value!.scoreDistribution[star]
      }))
    : []
)

onMounted(() => {
  void fetchDashboard()
})
</script>

<template>
  <div class="adm-stack">
    <!-- Filtros: se aplican al cambiar -->
    <div class="adm-toolbar" role="search" aria-label="Filtros del informe">
      <AdminFilters :model-value="period" :options="PERIODS" label="Periodo" @update:model-value="setPreset" />
      <label for="filter-from" class="sr-only">Desde</label>
      <input id="filter-from" v-model="fromDate" type="date" class="adm-input" @change="onDateChange" />
      <label for="filter-to" class="sr-only">Hasta</label>
      <input id="filter-to" v-model="toDate" type="date" class="adm-input" @change="onDateChange" />
      <label for="filter-segment" class="sr-only">Tipo de cliente</label>
      <select
        id="filter-segment"
        v-model="selectedSegment"
        data-filter="segment"
        class="adm-input"
        @change="fetchDashboard"
      >
        <option value="all">Todos los clientes</option>
        <option value="particular">Particulares</option>
        <option value="profesional">Profesionales</option>
      </select>
      <label for="filter-reason" class="sr-only">Motivo de contacto</label>
      <select
        id="filter-reason"
        v-model="selectedReason"
        data-filter="contactReason"
        class="adm-input"
        @change="fetchDashboard"
      >
        <option v-for="opt in reasonOptions" :key="opt.value" :value="opt.value">
          {{ opt.label }}
        </option>
      </select>
      <div class="adm-toolbar__end">
        <button
          type="button"
          data-action="apply-filters"
          class="adm-btn adm-btn--secondary"
          :disabled="loading"
          @click="fetchDashboard"
        >
          <UIcon name="i-lucide-rotate-cw" class="size-4 shrink-0" :class="{ 'animate-spin': loading }" />
          Actualizar
        </button>
      </div>
    </div>

    <!-- Error -->
    <AdminCard v-if="error && !data">
      <AdminEmptyState
        compact
        variant="error"
        title="No hemos podido cargar las encuestas"
        description="Vuelve a intentarlo. Si sigue fallando, comprueba que tu usuario tiene acceso a este apartado."
      >
        <AdminButton icon="i-lucide-rotate-cw" @click="fetchDashboard">Reintentar</AdminButton>
      </AdminEmptyState>
    </AdminCard>
    <UAlert
      v-else-if="error"
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      title="No hemos podido actualizar las encuestas"
      description="Se muestran los últimos datos cargados."
      role="alert"
    />

    <!-- Aviso de muestra pequeña -->
    <UAlert
      v-if="data && !data.summary.hasSufficientSample"
      color="warning"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="`Muestra insuficiente (< ${data.minSampleThreshold} respuestas)`"
      :description="`Solo hay ${data.summary.completedSurveys} encuestas en este periodo. No se muestran porcentajes ni medias porque con tan pocas respuestas no serían fiables.`"
      role="status"
    />

    <!-- Carga inicial -->
    <div v-if="loading && !data" class="adm-grid" aria-busy="true">
      <span class="sr-only">Cargando…</span>
      <div
        v-for="row in 4"
        :key="row"
        class="h-28 animate-pulse rounded-[var(--radius-surface)] bg-[var(--surface-sunken)]"
      />
    </div>

    <template v-if="data">
      <!-- Cifras clave -->
      <section aria-label="Indicadores clave de entrega" class="adm-grid">
        <AdminStat
          label="Encuestas completadas"
          icon="i-lucide-clipboard-check"
          :value="data.summary.completedSurveys"
          :hint="`de ${data.summary.totalInvitations} enviadas · ${formatPercent(data.summary.responseRate)} de respuesta`"
        />
        <AdminStat
          label="Valoración media"
          icon="i-lucide-star"
          :value="data.summary.averageScore ? `${formatScore(data.summary.averageScore)} / 5` : '—'"
          :hint="data.summary.hasSufficientSample ? 'Muestra representativa' : 'Muestra insuficiente'"
        />
        <AdminStat
          label="Llegó todo bien"
          icon="i-lucide-package-check"
          :value="formatPercent(data.summary.arrivedGoodRate)"
          hint="Entregas sin ningún problema"
        />
        <AdminStat
          label="Entregas con incidencia"
          icon="i-lucide-triangle-alert"
          :value="formatPercent(data.summary.problemRate)"
          :hint="`${data.summary.totalTicketsCreated} consultas de soporte abiertas`"
        />
      </section>

      <div class="grid gap-5 lg:grid-cols-2">
        <!-- Particulares frente a profesionales -->
        <AdminCard title="Por tipo de cliente" aria-label="Segmentación de clientes" flush>
          <div class="adm-table-wrap">
            <table class="adm-table">
              <thead>
                <tr>
                  <th scope="col">Tipo de cliente</th>
                  <th scope="col" data-numeric>Respuestas</th>
                  <th scope="col" data-numeric>Valoración</th>
                  <th scope="col" data-numeric>Llegó bien</th>
                  <th scope="col" data-numeric>Incidencias</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="segment in segments" :key="segment.key">
                  <td class="font-medium text-[var(--text-strong)]">{{ segment.label }}</td>
                  <td data-numeric>{{ segment.count }} respuestas</td>
                  <td data-numeric>{{ formatScore(segment.averageScore) }}</td>
                  <td data-numeric>{{ formatPercent(segment.arrivedGoodRate) }}</td>
                  <td data-numeric>{{ formatPercent(segment.problemRate) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </AdminCard>

        <!-- Reparto de valoraciones -->
        <AdminCard title="Reparto de valoraciones" aria-label="Distribución de puntuaciones">
          <AdminBreakdown v-if="data.summary.completedSurveys > 0" :items="scoreBreakdown" />
          <AdminEmptyState v-else compact icon="i-lucide-star" title="Aún no hay valoraciones en este periodo" />
        </AdminCard>
      </div>

      <!-- Motivos -->
      <AdminCard
        title="Motivos indicados por los clientes"
        description="Lo que el cliente marca en la encuesta al valorar su entrega."
        aria-label="Desglose por motivo de contacto"
        flush
      >
        <AdminEmptyState v-if="!data.byReason.length" compact title="Ningún cliente ha indicado un motivo" />
        <div v-else class="adm-table-wrap">
          <table class="adm-table">
            <thead>
              <tr>
                <th scope="col">Motivo</th>
                <th scope="col" data-numeric>Casos</th>
                <th scope="col" data-numeric>Porcentaje</th>
                <th scope="col" data-numeric>Valoración media</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in data.byReason" :key="item.reason">
                <td class="font-medium text-[var(--text-strong)]">{{ item.label }}</td>
                <td data-numeric>{{ item.count }}</td>
                <td data-numeric>{{ formatPercent(item.percentage) }}</td>
                <td data-numeric>
                  <AdminBadge v-if="item.averageScore" :tone="item.averageScore >= 4 ? 'success' : 'warning'" plain>
                    {{ item.averageScore }} ★
                  </AdminBadge>
                  <template v-else>—</template>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </AdminCard>

      <!-- Respuestas recientes -->
      <AdminSection title="Respuestas recientes" aria-label="Histórico de encuestas">
        <AdminTable
          :rows="data.items"
          :columns="responseColumns"
          :row-key="(row) => row.id"
          :status="loading ? 'pending' : 'idle'"
          :filtered="selectedSegment !== 'all' || selectedReason !== 'all'"
          empty-title="No hay respuestas en este periodo"
          empty-description="Prueba con un periodo más amplio."
          empty-icon="i-lucide-clipboard-check"
          caption="Últimas encuestas de entrega respondidas"
          @clear-filters="resetFilters"
        >
          <template #cell-orderNumber="{ row }">
            <NuxtLink to="/admin/pedidos" class="font-semibold text-[var(--link)] hover:underline">
              #{{ row.orderNumber }}
            </NuxtLink>
          </template>
          <template #cell-submittedAt="{ row }">{{ adminDate(row.submittedAt) }}</template>
          <template #cell-customerSegment="{ row }">
            <AdminBadge :tone="row.customerSegment === 'profesional' ? 'info' : 'neutral'" plain>
              {{ SEGMENT_LABEL[row.customerSegment] ?? adminHumanize(row.customerSegment) }}
            </AdminBadge>
          </template>
          <template #cell-score="{ row }">
            <AdminBadge :tone="row.score >= 4 ? 'success' : row.score <= 2 ? 'danger' : 'warning'" plain>
              {{ row.score }} ★
            </AdminBadge>
          </template>
          <template #cell-arrivedGood="{ row }">
            <AdminBadge :tone="row.arrivedGood ? 'success' : 'danger'">{{ row.arrivedGood ? 'Sí' : 'No' }}</AdminBadge>
          </template>
          <template #cell-contactReason="{ row }">
            {{
              row.contactReason ? (CONTACT_REASON_LABELS[row.contactReason] ?? adminHumanize(row.contactReason)) : '—'
            }}
          </template>
          <template #cell-supportTicketPublicRef="{ row }">
            <NuxtLink
              v-if="row.supportTicketPublicRef"
              to="/admin/soporte"
              class="font-medium text-[var(--link)] hover:underline"
            >
              {{ row.supportTicketPublicRef }}
            </NuxtLink>
            <template v-else>—</template>
          </template>
        </AdminTable>
      </AdminSection>
    </template>
  </div>
</template>
