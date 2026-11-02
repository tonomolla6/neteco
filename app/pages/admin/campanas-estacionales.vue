<script setup lang="ts">
import {
  SECTOR_LABELS,
  SEASON_LABELS,
  type SectorType,
  type SeasonType,
  type SeasonalSectorCampaign,
  type CoordinationCheckResult
} from '~~/shared/seasonal-campaigns'

definePageMeta({
  layout: 'admin',
  title: 'Campañas Estacionales por Sector'
})

interface CalendarFeedResponse {
  year: number
  sectorsRepresented: SectorType[]
  campaigns: Array<
    SeasonalSectorCampaign & {
      coordination: CoordinationCheckResult
      hasPostmortem: boolean
    }
  >
}

const currentYear = new Date().getFullYear()
const selectedYear = ref(currentYear)
const selectedSector = ref<SectorType | ''>('')
const selectedSeason = ref<SeasonType | ''>('')

const queryParams = computed(() => {
  const p: Record<string, string> = { year: String(selectedYear.value) }
  if (selectedSector.value) p.sector = selectedSector.value
  if (selectedSeason.value) p.season = selectedSeason.value
  return p
})

const {
  data: feedData,
  status,
  error,
  refresh
} = await useFetch<CalendarFeedResponse>('/api/admin/seasonal-campaigns/calendar', { query: queryParams })

const campaigns = computed(() => feedData.value?.campaigns ?? [])

function formatEuros(cents: number): string {
  return new Intl.NumberFormat('es-ES', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 0
  }).format(cents / 100)
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' })
  } catch {
    return iso
  }
}
</script>

<template>
  <div class="space-y-6">
    <!-- Header -->
    <div class="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 pb-4">
      <div>
        <h1 class="text-2xl font-bold tracking-tight text-slate-900">Calendario de Campañas Estacionales por Sector</h1>
        <p class="mt-1 text-sm text-slate-500">
          Coordinación integral de necesidad, ventana, inventario, logística, contenido, margen y postmortem por campaña
          (MKT-032).
        </p>
      </div>

      <!-- Filtros -->
      <div class="flex flex-wrap items-center gap-3">
        <select
          v-model="selectedYear"
          class="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm shadow-xs focus:border-neteco-600 focus:outline-hidden"
          aria-label="Filtrar por año"
        >
          <option :value="2025">2025</option>
          <option :value="2026">2026</option>
          <option :value="2027">2027</option>
          <option :value="2028">2028</option>
        </select>

        <select
          v-model="selectedSector"
          class="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm shadow-xs focus:border-neteco-600 focus:outline-hidden"
          aria-label="Filtrar por sector"
        >
          <option value="">Todos los sectores</option>
          <option v-for="(label, key) in SECTOR_LABELS" :key="key" :value="key">
            {{ label }}
          </option>
        </select>

        <select
          v-model="selectedSeason"
          class="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm shadow-xs focus:border-neteco-600 focus:outline-hidden"
          aria-label="Filtrar por estación"
        >
          <option value="">Todas las estaciones</option>
          <option v-for="(label, key) in SEASON_LABELS" :key="key" :value="key">
            {{ label }}
          </option>
        </select>

        <button
          type="button"
          class="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
          @click="refresh()"
        >
          Actualizar
        </button>
      </div>
    </div>

    <!-- Estados de carga / error -->
    <div v-if="status === 'pending'" class="py-12 text-center text-sm text-slate-500">
      Cargando calendario de campañas estacionales...
    </div>

    <div v-else-if="error" class="rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-800">
      Error al cargar el calendario: {{ error.message }}
    </div>

    <div v-else-if="!campaigns.length" class="rounded-2xl border border-dashed border-slate-300 p-12 text-center">
      <h3 class="text-base font-semibold text-slate-900">No hay campañas para los filtros seleccionados</h3>
      <p class="mt-1 text-sm text-slate-500">
        Prueba a cambiar el sector, la estación o el año en los selectores superiores.
      </p>
    </div>

    <!-- Lista y cuadrícula de campañas coordinadas -->
    <div v-else class="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <div
        v-for="camp in campaigns"
        :key="camp.id"
        class="rounded-2xl border border-slate-200 bg-white p-6 shadow-xs transition-shadow hover:shadow-md"
      >
        <!-- Header de la campaña -->
        <div class="flex items-start justify-between gap-3">
          <div>
            <div class="flex flex-wrap items-center gap-2">
              <span class="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-700">
                {{ SECTOR_LABELS[camp.sector] }}
              </span>
              <span class="rounded-full bg-blue-50 px-2.5 py-0.5 text-xs font-semibold text-blue-700">
                {{ SEASON_LABELS[camp.season] }} {{ camp.year }}
              </span>
              <span
                class="rounded-full px-2.5 py-0.5 text-xs font-semibold uppercase"
                :class="[
                  camp.status === 'active'
                    ? 'bg-emerald-100 text-emerald-800'
                    : camp.status === 'completed'
                      ? 'bg-purple-100 text-purple-800'
                      : 'bg-amber-100 text-amber-800'
                ]"
              >
                {{ camp.status }}
              </span>
            </div>
            <h2 class="mt-2 text-lg font-bold text-slate-900">{{ camp.name }}</h2>
            <p class="font-mono text-xs text-slate-500">{{ camp.code }}</p>
          </div>

          <!-- Indicador de los 6 Pilares Coordinados -->
          <div class="text-right">
            <span
              class="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-bold"
              :class="[
                camp.coordination.isFullyCoordinated
                  ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                  : 'bg-amber-50 text-amber-800 border border-amber-200'
              ]"
            >
              {{ camp.coordination.isFullyCoordinated ? '✓ 6/6 Pilares Coordinados' : '⚠ Incompleto' }}
            </span>
          </div>
        </div>

        <!-- Los 6 Pilares Coordinados -->
        <div class="mt-5 space-y-3 rounded-xl bg-slate-50 p-4 text-xs">
          <!-- Pilar 1: Necesidad -->
          <div>
            <span class="font-semibold text-slate-900">1. Necesidad / Justificación:</span>
            <p class="mt-0.5 text-slate-600">{{ camp.need.needJustification }}</p>
          </div>

          <!-- Pilar 2: Ventana -->
          <div class="flex flex-wrap gap-4 border-t border-slate-200/60 pt-2">
            <div>
              <span class="font-semibold text-slate-700">Aprovisionamiento:</span>
              <span class="ml-1 text-slate-600">{{ formatDate(camp.window.procurementStartAt) }}</span>
            </div>
            <div>
              <span class="font-semibold text-slate-700">Ventana comercial:</span>
              <span class="ml-1 text-slate-600">
                {{ formatDate(camp.window.windowStartAt) }} – {{ formatDate(camp.window.windowEndAt) }}
              </span>
            </div>
          </div>

          <!-- Pilar 3: Inventario -->
          <div class="border-t border-slate-200/60 pt-2">
            <span class="font-semibold text-slate-900">3. Inventario coordinado:</span>
            <span class="ml-1 text-slate-600">
              {{ camp.inventory.items.length }} productos planificados (Buffer: {{ camp.inventory.bufferPercentage }}%)
            </span>
            <div class="mt-1 flex flex-wrap gap-1.5">
              <span
                v-for="item in camp.inventory.items"
                :key="item.sku"
                class="rounded bg-white px-2 py-0.5 font-mono text-[11px] text-slate-700 border border-slate-200"
              >
                {{ item.sku }}: {{ item.plannedUnits }} uds
              </span>
            </div>
          </div>

          <!-- Pilar 4: Logística -->
          <div class="border-t border-slate-200/60 pt-2">
            <span class="font-semibold text-slate-900">4. Logística:</span>
            <span class="ml-1 text-slate-600">
              Perfiles: {{ camp.logistics.allowedProfiles.join(', ') }} · Plazo máx:
              {{ camp.logistics.maxLeadTimeDays }} días
            </span>
            <p v-if="camp.logistics.carrierNotes" class="mt-0.5 italic text-slate-500">
              Nota carrier: {{ camp.logistics.carrierNotes }}
            </p>
          </div>

          <!-- Pilar 5: Contenido -->
          <div class="border-t border-slate-200/60 pt-2">
            <span class="font-semibold text-slate-900">5. Contenido:</span>
            <span class="ml-1 text-slate-600">
              Landing: /{{ camp.content.landingSlug || '—' }} · Slots: {{ camp.content.bannerSlots.join(', ') || '—' }}
            </span>
          </div>

          <!-- Pilar 6: Margen & Presupuesto -->
          <div class="flex flex-wrap gap-4 border-t border-slate-200/60 pt-2">
            <div>
              <span class="font-semibold text-slate-700">Objetivo facturación:</span>
              <span class="ml-1 font-bold text-slate-900">{{ formatEuros(camp.margin.targetRevenueCents) }}</span>
            </div>
            <div>
              <span class="font-semibold text-slate-700">Margen mín:</span>
              <span class="ml-1 font-bold text-slate-900"
                >{{ (camp.margin.minMarginBasisPoints / 100).toFixed(1) }}%</span
              >
            </div>
            <div>
              <span class="font-semibold text-slate-700">Presupuesto máx:</span>
              <span class="ml-1 text-slate-600">{{ formatEuros(camp.margin.budgetLimitCents) }}</span>
            </div>
          </div>
        </div>

        <!-- Postmortem por campaña -->
        <div v-if="camp.hasPostmortem || camp.status === 'completed'" class="mt-4 border-t border-slate-100 pt-3">
          <div class="flex items-center justify-between">
            <span class="text-xs font-bold text-slate-700">
              Postmortem de campaña:
              <span v-if="camp.hasPostmortem" class="text-emerald-700 font-semibold">Completado y registrado</span>
              <span v-else class="text-amber-700 font-semibold">Pendiente de registro</span>
            </span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
