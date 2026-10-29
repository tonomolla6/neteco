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

onMounted(() => {
  void fetchDashboard()
})
</script>

<template>
  <div class="space-y-6">
    <!-- Header -->
    <header class="flex flex-wrap items-center justify-between gap-4 border-b border-[var(--border-subtle)] pb-4">
      <div>
        <h1 class="text-2xl font-bold tracking-tight text-[var(--text-strong)]">Encuestas de entrega</h1>
        <p class="text-sm text-[var(--text-muted)]">
          Evaluación voluntaria de la experiencia postentrega y detección temprana de incidencias.
        </p>
      </div>
      <div class="flex items-center gap-2">
        <button
          type="button"
          class="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-raised)] px-3 py-1.5 text-xs font-medium text-[var(--text-strong)] hover:bg-[var(--surface-hover)] focus:outline-none"
          :disabled="loading"
          @click="fetchDashboard"
        >
          <UIcon name="i-lucide-refresh-cw" class="size-3.5" :class="{ 'animate-spin': loading }" />
          Actualizar
        </button>
      </div>
    </header>

    <!-- Filter Bar -->
    <section
      aria-label="Filtros del informe"
      class="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-raised)] p-4 shadow-sm"
    >
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <div>
          <label for="filter-from" class="block text-xs font-medium text-[var(--text-muted)]">Desde</label>
          <input
            id="filter-from"
            v-model="fromDate"
            type="date"
            class="mt-1 block w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-base)] px-2.5 py-1.5 text-sm text-[var(--text-strong)] focus:border-neteco-600 focus:outline-none"
          />
        </div>

        <div>
          <label for="filter-to" class="block text-xs font-medium text-[var(--text-muted)]">Hasta</label>
          <input
            id="filter-to"
            v-model="toDate"
            type="date"
            class="mt-1 block w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-base)] px-2.5 py-1.5 text-sm text-[var(--text-strong)] focus:border-neteco-600 focus:outline-none"
          />
        </div>

        <div>
          <label for="filter-segment" class="block text-xs font-medium text-[var(--text-muted)]">Segmento</label>
          <select
            id="filter-segment"
            v-model="selectedSegment"
            data-filter="segment"
            class="mt-1 block w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-base)] px-2.5 py-1.5 text-sm text-[var(--text-strong)] focus:border-neteco-600 focus:outline-none"
          >
            <option value="all">Todos los clientes</option>
            <option value="particular">Cliente particular</option>
            <option value="profesional">Cliente profesional (B2B)</option>
          </select>
        </div>

        <div>
          <label for="filter-reason" class="block text-xs font-medium text-[var(--text-muted)]"
            >Motivo de contacto</label
          >
          <select
            id="filter-reason"
            v-model="selectedReason"
            data-filter="contactReason"
            class="mt-1 block w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-base)] px-2.5 py-1.5 text-sm text-[var(--text-strong)] focus:border-neteco-600 focus:outline-none"
          >
            <option v-for="opt in reasonOptions" :key="opt.value" :value="opt.value">
              {{ opt.label }}
            </option>
          </select>
        </div>

        <div class="flex items-end">
          <button
            type="button"
            data-action="apply-filters"
            class="w-full rounded-lg bg-neteco-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-neteco-500 focus:outline-none"
            :disabled="loading"
            @click="fetchDashboard"
          >
            Aplicar filtros
          </button>
        </div>
      </div>
    </section>

    <!-- Error message -->
    <div v-if="error" role="alert" class="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
      {{ error }}
    </div>

    <!-- Threshold Alert -->
    <aside
      v-if="data && !data.summary.hasSufficientSample"
      role="status"
      class="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"
    >
      <UIcon name="i-lucide-alert-triangle" class="mt-0.5 size-5 shrink-0 text-amber-600" />
      <div>
        <p class="font-semibold">Muestra insuficiente (&lt; {{ data.minSampleThreshold }} respuestas)</p>
        <p class="text-xs text-amber-800">
          Se han registrado {{ data.summary.completedSurveys }} encuestas en este periodo. Los porcentajes y medias
          agregadas están suprimidos para proteger la representatividad estadística.
        </p>
      </div>
    </aside>

    <!-- Loading State -->
    <div v-if="loading && !data" class="flex justify-center py-12">
      <UIcon name="i-lucide-loader-2" class="size-8 animate-spin text-neteco-600" />
    </div>

    <!-- Main Content -->
    <template v-if="data">
      <!-- KPI Cards Grid -->
      <section aria-label="Indicadores clave de entrega" class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div class="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-raised)] p-5 shadow-sm">
          <p class="text-xs font-medium text-[var(--text-muted)]">Encuestas completadas</p>
          <div class="mt-2 flex items-baseline gap-2">
            <span class="text-2xl font-bold text-[var(--text-strong)]">{{ data.summary.completedSurveys }}</span>
            <span class="text-xs text-[var(--text-muted)]">de {{ data.summary.totalInvitations }} enviadas</span>
          </div>
          <p class="mt-1 text-xs text-[var(--text-muted)]">
            Tasa de respuesta: <span class="font-semibold">{{ formatPercent(data.summary.responseRate) }}</span>
          </p>
        </div>

        <div class="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-raised)] p-5 shadow-sm">
          <p class="text-xs font-medium text-[var(--text-muted)]">Valoración media (1-5)</p>
          <div class="mt-2 flex items-baseline gap-2">
            <span class="text-2xl font-bold text-[var(--text-strong)]">{{
              formatScore(data.summary.averageScore)
            }}</span>
            <span v-if="data.summary.averageScore" class="text-xs text-amber-600">/ 5 ★</span>
          </div>
          <p class="mt-1 text-xs text-[var(--text-muted)]">
            <span v-if="data.summary.hasSufficientSample" class="text-emerald-700 font-medium"
              >Muestra representativa</span
            >
            <span v-else class="text-amber-700">Muestra insuficiente</span>
          </p>
        </div>

        <div class="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-raised)] p-5 shadow-sm">
          <p class="text-xs font-medium text-[var(--text-muted)]">¿Llegó todo bien?</p>
          <div class="mt-2 flex items-baseline gap-2">
            <span class="text-2xl font-bold text-[var(--text-strong)]">{{
              formatPercent(data.summary.arrivedGoodRate)
            }}</span>
          </div>
          <p class="mt-1 text-xs text-[var(--text-muted)]">Entregas conformes sin incidencias reportadas</p>
        </div>

        <div class="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-raised)] p-5 shadow-sm">
          <p class="text-xs font-medium text-[var(--text-muted)]">Incidencias y soporte</p>
          <div class="mt-2 flex items-baseline gap-2">
            <span
              class="text-2xl font-bold"
              :class="
                data.summary.problemRate && data.summary.problemRate > 0.05
                  ? 'text-red-700'
                  : 'text-[var(--text-strong)]'
              "
            >
              {{ formatPercent(data.summary.problemRate) }}
            </span>
          </div>
          <p class="mt-1 text-xs text-[var(--text-muted)]">
            {{ data.summary.totalTicketsCreated }} tickets vinculados sin duplicados
          </p>
        </div>
      </section>

      <!-- Segment Comparison & Score Histogram -->
      <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <!-- Segment Comparison -->
        <section
          aria-label="Segmentación de clientes"
          class="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-raised)] p-5 shadow-sm"
        >
          <h2 class="text-base font-semibold text-[var(--text-strong)]">Comparativa por segmento</h2>
          <p class="text-xs text-[var(--text-muted)]">
            Diferenciación entre consumidores particulares y clientes profesionales B2B.
          </p>

          <div class="mt-4 grid grid-cols-2 gap-4">
            <div class="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-base)] p-4">
              <div class="flex items-center justify-between">
                <span class="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">Particular</span>
                <span class="rounded bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-800">B2C</span>
              </div>
              <p class="mt-2 text-xl font-bold text-[var(--text-strong)]">
                {{ data.bySegment.particular.count }}
                <span class="text-xs font-normal text-[var(--text-muted)]">respuestas</span>
              </p>
              <div class="mt-3 space-y-1 text-xs text-[var(--text-muted)]">
                <div class="flex justify-between">
                  <span>Media:</span>
                  <span class="font-semibold text-[var(--text-strong)]">{{
                    formatScore(data.bySegment.particular.averageScore)
                  }}</span>
                </div>
                <div class="flex justify-between">
                  <span>Llegó bien:</span>
                  <span class="font-semibold text-[var(--text-strong)]">{{
                    formatPercent(data.bySegment.particular.arrivedGoodRate)
                  }}</span>
                </div>
                <div class="flex justify-between">
                  <span>Incidencias:</span>
                  <span class="font-semibold text-[var(--text-strong)]">{{
                    formatPercent(data.bySegment.particular.problemRate)
                  }}</span>
                </div>
              </div>
            </div>

            <div class="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-base)] p-4">
              <div class="flex items-center justify-between">
                <span class="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">Profesional</span>
                <span class="rounded bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800">B2B</span>
              </div>
              <p class="mt-2 text-xl font-bold text-[var(--text-strong)]">
                {{ data.bySegment.profesional.count }}
                <span class="text-xs font-normal text-[var(--text-muted)]">respuestas</span>
              </p>
              <div class="mt-3 space-y-1 text-xs text-[var(--text-muted)]">
                <div class="flex justify-between">
                  <span>Media:</span>
                  <span class="font-semibold text-[var(--text-strong)]">{{
                    formatScore(data.bySegment.profesional.averageScore)
                  }}</span>
                </div>
                <div class="flex justify-between">
                  <span>Llegó bien:</span>
                  <span class="font-semibold text-[var(--text-strong)]">{{
                    formatPercent(data.bySegment.profesional.arrivedGoodRate)
                  }}</span>
                </div>
                <div class="flex justify-between">
                  <span>Incidencias:</span>
                  <span class="font-semibold text-[var(--text-strong)]">{{
                    formatPercent(data.bySegment.profesional.problemRate)
                  }}</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        <!-- Score Distribution Histogram -->
        <section
          aria-label="Distribución de puntuaciones"
          class="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-raised)] p-5 shadow-sm"
        >
          <h2 class="text-base font-semibold text-[var(--text-strong)]">Distribución de valoraciones</h2>
          <p class="text-xs text-[var(--text-muted)]">Desglose de notas de 1 a 5 estrellas.</p>

          <div class="mt-4 space-y-2">
            <div v-for="star in [5, 4, 3, 2, 1] as const" :key="star" class="flex items-center gap-3 text-xs">
              <span class="w-12 font-medium text-[var(--text-strong)]">{{ star }} estrellas</span>
              <div class="h-3 flex-1 overflow-hidden rounded-full bg-[var(--surface-sunken)]">
                <div
                  class="h-full rounded-full transition-all duration-300"
                  :class="star >= 4 ? 'bg-emerald-500' : star === 3 ? 'bg-amber-500' : 'bg-red-500'"
                  :style="{
                    width:
                      data.summary.completedSurveys > 0
                        ? `${(data.scoreDistribution[star] / data.summary.completedSurveys) * 100}%`
                        : '0%'
                  }"
                />
              </div>
              <span class="w-10 text-right font-medium text-[var(--text-muted)]">
                {{ data.scoreDistribution[star] }}
              </span>
            </div>
          </div>
        </section>
      </div>

      <!-- Contact Reason Breakdown -->
      <section
        aria-label="Desglose por motivo de contacto"
        class="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-raised)] p-5 shadow-sm"
      >
        <h2 class="text-base font-semibold text-[var(--text-strong)]">Motivos de contacto y logística</h2>
        <p class="text-xs text-[var(--text-muted)]">
          Catálogo estable de motivos seleccionados por los clientes en la encuesta.
        </p>

        <div class="mt-4 overflow-x-auto">
          <table class="w-full text-left text-sm">
            <thead class="border-b border-[var(--border-subtle)] text-xs text-[var(--text-muted)]">
              <tr>
                <th scope="col" class="pb-2 font-medium">Motivo</th>
                <th scope="col" class="pb-2 font-medium">Casos</th>
                <th scope="col" class="pb-2 font-medium">Porcentaje</th>
                <th scope="col" class="pb-2 font-medium">Puntuación media</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-[var(--border-subtle)]">
              <tr v-for="item in data.byReason" :key="item.reason" class="hover:bg-[var(--surface-hover)]">
                <td class="py-2.5 font-medium text-[var(--text-strong)]">{{ item.label }}</td>
                <td class="py-2.5">{{ item.count }}</td>
                <td class="py-2.5">{{ formatPercent(item.percentage) }}</td>
                <td class="py-2.5">
                  <span
                    v-if="item.averageScore"
                    class="font-medium"
                    :class="item.averageScore >= 4 ? 'text-emerald-700' : 'text-amber-700'"
                  >
                    {{ item.averageScore }} ★
                  </span>
                  <span v-else class="text-[var(--text-muted)]">—</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- Recent Responses Table -->
      <section
        aria-label="Histórico de encuestas"
        class="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-raised)] p-5 shadow-sm"
      >
        <h2 class="text-base font-semibold text-[var(--text-strong)]">Respuestas recientes</h2>
        <p class="text-xs text-[var(--text-muted)]">
          Últimas valoraciones registradas con enlace directo a pedidos y soporte.
        </p>

        <div v-if="data.items.length === 0" class="py-8 text-center text-sm text-[var(--text-muted)]">
          No hay respuestas para el periodo y filtros seleccionados.
        </div>

        <div v-else class="mt-4 overflow-x-auto">
          <table class="w-full text-left text-sm">
            <thead class="border-b border-[var(--border-subtle)] text-xs text-[var(--text-muted)]">
              <tr>
                <th scope="col" class="pb-2 font-medium">Pedido</th>
                <th scope="col" class="pb-2 font-medium">Fecha</th>
                <th scope="col" class="pb-2 font-medium">Segmento</th>
                <th scope="col" class="pb-2 font-medium">Puntuación</th>
                <th scope="col" class="pb-2 font-medium">¿Llegó bien?</th>
                <th scope="col" class="pb-2 font-medium">Motivo</th>
                <th scope="col" class="pb-2 font-medium">Ticket de soporte</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-[var(--border-subtle)]">
              <tr v-for="row in data.items" :key="row.id" class="hover:bg-[var(--surface-hover)]">
                <td class="py-2.5 font-mono text-xs font-semibold text-[var(--text-strong)]">
                  <NuxtLink :to="`/admin/pedidos`" class="text-neteco-700 hover:underline">
                    {{ row.orderNumber }}
                  </NuxtLink>
                </td>
                <td class="py-2.5 text-xs text-[var(--text-muted)]">
                  {{ new Date(row.submittedAt).toLocaleDateString('es-ES') }}
                </td>
                <td class="py-2.5 text-xs capitalize">
                  <span
                    class="rounded px-2 py-0.5 font-medium"
                    :class="
                      row.customerSegment === 'profesional'
                        ? 'bg-blue-100 text-blue-800'
                        : 'bg-neutral-100 text-neutral-800'
                    "
                  >
                    {{ row.customerSegment }}
                  </span>
                </td>
                <td class="py-2.5">
                  <span
                    class="font-bold"
                    :class="row.score >= 4 ? 'text-emerald-700' : row.score <= 2 ? 'text-red-700' : 'text-amber-700'"
                  >
                    {{ row.score }} ★
                  </span>
                </td>
                <td class="py-2.5 text-xs">
                  <span v-if="row.arrivedGood" class="font-medium text-emerald-700">Sí</span>
                  <span v-else class="font-medium text-red-700">No</span>
                </td>
                <td class="py-2.5 text-xs text-[var(--text-muted)]">
                  {{ row.contactReason ? (CONTACT_REASON_LABELS[row.contactReason] ?? row.contactReason) : '—' }}
                </td>
                <td class="py-2.5 text-xs">
                  <NuxtLink
                    v-if="row.supportTicketPublicRef"
                    :to="`/admin/soporte`"
                    class="font-mono font-medium text-neteco-700 hover:underline"
                  >
                    {{ row.supportTicketPublicRef }}
                  </NuxtLink>
                  <span v-else class="text-[var(--text-muted)]">—</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>
  </div>
</template>
