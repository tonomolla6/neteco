<script setup lang="ts">
import {
  SEASON_LABELS,
  type SectorType,
  type SeasonType,
  type SeasonalSectorCampaign,
  type CoordinationCheckResult
} from '~~/shared/seasonal-campaigns'

definePageMeta({
  layout: 'admin',
  middleware: 'admin',
  title: 'Campañas estacionales por sector'
})

useSeoMeta({
  title: 'Campañas estacionales · Administración',
  robots: 'noindex, nofollow'
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

type SeasonalCampaignRow = CalendarFeedResponse['campaigns'][number]

/** Nombres en español llano: las etiquetas compartidas vienen con mayúsculas de título. */
const SECTOR_NAMES: Record<SectorType, string> = {
  horeca: 'Hostelería y restauración',
  healthcare: 'Sanidad, clínicas y residencias',
  education: 'Centros educativos',
  industrial: 'Industria y talleres',
  facility_services: 'Empresas de limpieza',
  food_processing: 'Industria agroalimentaria',
  general_b2b: 'Comercio y oficinas'
}
const SEASON_NAMES: Record<SeasonType, string> = { ...SEASON_LABELS, custom: 'Especial' }
const STATUS_NAMES: Record<string, string> = {
  draft: 'Borrador',
  planned: 'Planificada',
  active: 'Activa',
  paused: 'En pausa',
  completed: 'Finalizada',
  cancelled: 'Cancelada'
}
const STATUS_TONES: Record<string, 'neutral' | 'success' | 'warning' | 'info'> = {
  planned: 'info',
  active: 'success',
  paused: 'warning'
}
const PROFILE_NAMES: Record<string, string> = {
  parcel: 'Paquetería',
  pallet: 'Palé',
  adr: 'Mercancías peligrosas'
}
const years = [2025, 2026, 2027, 2028]

const search = ref('')
const rows = computed(() => {
  const term = search.value.toLowerCase()
  return term
    ? campaigns.value.filter((camp) => camp.name.toLowerCase().includes(term) || camp.code.toLowerCase().includes(term))
    : campaigns.value
})
const hasFilters = computed(() => Boolean(search.value || selectedSector.value || selectedSeason.value))
function clearFilters() {
  search.value = ''
  selectedSector.value = ''
  selectedSeason.value = ''
}
const columns = [
  { key: 'name', label: 'Campaña', sortable: true },
  { key: 'sector', label: 'Sector', hideOnMobile: true },
  { key: 'season', label: 'Temporada', hideOnMobile: true },
  { key: 'window', label: 'Venta', value: (row: SeasonalCampaignRow) => row.window.windowStartAt, sortable: true },
  {
    key: 'target',
    label: 'Objetivo',
    numeric: true,
    sortable: true,
    hideOnMobile: true,
    value: (row: SeasonalCampaignRow) => row.margin.targetRevenueCents
  },
  { key: 'coordination', label: 'Preparación' },
  { key: 'status', label: 'Estado' }
]
const summary = computed(() => ({
  total: campaigns.value.length,
  active: campaigns.value.filter((camp) => camp.status === 'active').length,
  incomplete: campaigns.value.filter((camp) => !camp.coordination.isFullyCoordinated).length,
  target: campaigns.value.reduce((sum, camp) => sum + camp.margin.targetRevenueCents, 0)
}))

const selected = shallowRef<SeasonalCampaignRow | null>(null)
const detailOpen = computed({
  get: () => selected.value !== null,
  set: (open: boolean) => {
    if (!open) selected.value = null
  }
})

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
  <AdminPage>
    <div class="adm-stack">
      <div class="adm-grid">
        <AdminStat label="Campañas del año" :value="summary.total" icon="i-lucide-calendar-range" />
        <AdminStat label="Activas ahora" :value="summary.active" icon="i-lucide-megaphone" />
        <AdminStat
          label="Con preparación incompleta"
          :value="summary.incomplete"
          icon="i-lucide-list-checks"
          hint="Les falta stock, logística, contenido o margen"
        />
        <AdminStat label="Objetivo de facturación" :value="formatEuros(summary.target)" icon="i-lucide-target" />
      </div>

      <AdminTable
        :rows="rows"
        :columns="columns"
        :row-key="(row) => row.id"
        :status="status"
        :filtered="hasFilters"
        :error-message="error ? 'No hemos podido cargar el calendario de campañas. Vuelve a intentarlo.' : undefined"
        empty-title="No hay campañas estacionales este año"
        empty-description="Prueba con otro año en el selector de la barra."
        empty-icon="i-lucide-calendar-range"
        class="[&_tbody_tr]:cursor-pointer"
        @row-click="(row) => (selected = row)"
        @retry="refresh()"
        @clear-filters="clearFilters"
      >
        <template #toolbar>
          <AdminToolbar v-model:search="search" placeholder="Buscar campaña…">
            <select v-model="selectedYear" class="adm-input w-auto" aria-label="Filtrar por año">
              <option v-for="year in years" :key="year" :value="year">{{ year }}</option>
            </select>
            <select v-model="selectedSector" class="adm-input w-auto" aria-label="Filtrar por sector">
              <option value="">Todos los sectores</option>
              <option v-for="(name, key) in SECTOR_NAMES" :key="key" :value="key">{{ name }}</option>
            </select>
            <select v-model="selectedSeason" class="adm-input w-auto" aria-label="Filtrar por estación">
              <option value="">Todas las estaciones</option>
              <option v-for="(name, key) in SEASON_NAMES" :key="key" :value="key">{{ name }}</option>
            </select>
            <template #actions>
              <AdminButton icon="i-lucide-rotate-cw" :loading="status === 'pending'" @click="refresh()">
                Actualizar
              </AdminButton>
            </template>
          </AdminToolbar>
        </template>
        <template #cell-name="{ row }">
          <p class="font-semibold text-[var(--text-strong)]">{{ row.name }}</p>
          <p class="adm-help">{{ row.code }}</p>
        </template>
        <template #cell-sector="{ row }">{{ SECTOR_NAMES[row.sector] }}</template>
        <template #cell-season="{ row }">{{ SEASON_NAMES[row.season] }} {{ row.year }}</template>
        <template #cell-window="{ row }">
          {{ formatDate(row.window.windowStartAt) }} – {{ formatDate(row.window.windowEndAt) }}
        </template>
        <template #cell-target="{ row }">{{ formatEuros(row.margin.targetRevenueCents) }}</template>
        <template #cell-coordination="{ row }">
          <AdminBadge :tone="row.coordination.isFullyCoordinated ? 'success' : 'warning'">
            {{ row.coordination.isFullyCoordinated ? 'Completa' : 'Incompleta' }}
          </AdminBadge>
        </template>
        <template #cell-status="{ row }">
          <AdminBadge :tone="STATUS_TONES[row.status] ?? 'neutral'">
            {{ STATUS_NAMES[row.status] ?? adminHumanize(row.status) }}
          </AdminBadge>
        </template>
        <template #actions="{ row }">
          <AdminButton size="sm" variant="ghost" @click="selected = row">Ver plan</AdminButton>
        </template>
      </AdminTable>

      <AdminDrawer
        v-model:open="detailOpen"
        wide
        :title="selected?.name ?? 'Campaña'"
        :description="
          selected ? `${SECTOR_NAMES[selected.sector]} · ${SEASON_NAMES[selected.season]} ${selected.year}` : undefined
        "
      >
        <div v-if="selected" class="adm-stack">
          <div class="flex flex-wrap items-center gap-2">
            <AdminBadge :tone="STATUS_TONES[selected.status] ?? 'neutral'">
              {{ STATUS_NAMES[selected.status] ?? adminHumanize(selected.status) }}
            </AdminBadge>
            <AdminBadge :tone="selected.coordination.isFullyCoordinated ? 'success' : 'warning'">
              {{ selected.coordination.isFullyCoordinated ? 'Preparación completa' : 'Preparación incompleta' }}
            </AdminBadge>
            <AdminBadge
              v-if="selected.hasPostmortem || selected.status === 'completed'"
              :tone="selected.hasPostmortem ? 'success' : 'warning'"
            >
              {{ selected.hasPostmortem ? 'Balance final registrado' : 'Balance final pendiente' }}
            </AdminBadge>
          </div>

          <AdminCard title="Por qué se hace">
            <p>{{ selected.need.needJustification }}</p>
          </AdminCard>

          <AdminCard title="Fechas">
            <dl class="grid gap-3 sm:grid-cols-2">
              <div>
                <dt class="adm-help">Inicio de compras a proveedores</dt>
                <dd>{{ formatDate(selected.window.procurementStartAt) }}</dd>
              </div>
              <div>
                <dt class="adm-help">Periodo de venta</dt>
                <dd>{{ formatDate(selected.window.windowStartAt) }} – {{ formatDate(selected.window.windowEndAt) }}</dd>
              </div>
            </dl>
          </AdminCard>

          <AdminCard
            title="Stock previsto"
            :description="`${selected.inventory.items.length} ${selected.inventory.items.length === 1 ? 'producto' : 'productos'} con un ${selected.inventory.bufferPercentage} % de margen de seguridad.`"
            flush
          >
            <ul class="adm-list">
              <li v-for="item in selected.inventory.items" :key="item.sku">
                <span class="min-w-0 flex-1 truncate">{{ item.sku }}</span>
                <span class="tabular-nums">{{ item.plannedUnits.toLocaleString('es-ES') }} uds.</span>
              </li>
            </ul>
          </AdminCard>

          <AdminCard title="Envíos">
            <dl class="grid gap-3 sm:grid-cols-2">
              <div>
                <dt class="adm-help">Tipos de envío</dt>
                <dd>
                  {{
                    selected.logistics.allowedProfiles.map((profile) => PROFILE_NAMES[profile] ?? profile).join(', ')
                  }}
                </dd>
              </div>
              <div>
                <dt class="adm-help">Plazo máximo de entrega</dt>
                <dd>{{ selected.logistics.maxLeadTimeDays }} días</dd>
              </div>
              <div v-if="selected.logistics.carrierNotes" class="sm:col-span-2">
                <dt class="adm-help">Notas para el transportista</dt>
                <dd>{{ selected.logistics.carrierNotes }}</dd>
              </div>
            </dl>
          </AdminCard>

          <AdminCard title="Contenido en la tienda">
            <dl class="grid gap-3 sm:grid-cols-2">
              <div>
                <dt class="adm-help">Página de la campaña</dt>
                <dd>{{ selected.content.landingSlug ? `/${selected.content.landingSlug}` : '—' }}</dd>
              </div>
              <div>
                <dt class="adm-help">Espacios de banner</dt>
                <dd>{{ selected.content.bannerSlots.join(', ') || '—' }}</dd>
              </div>
            </dl>
          </AdminCard>

          <AdminCard title="Objetivos económicos">
            <dl class="grid gap-3 sm:grid-cols-3">
              <div>
                <dt class="adm-help">Facturación objetivo</dt>
                <dd class="font-semibold text-[var(--text-strong)]">
                  {{ formatEuros(selected.margin.targetRevenueCents) }}
                </dd>
              </div>
              <div>
                <dt class="adm-help">Margen mínimo</dt>
                <dd class="font-semibold text-[var(--text-strong)]">
                  {{
                    (selected.margin.minMarginBasisPoints / 100).toLocaleString('es-ES', { maximumFractionDigits: 1 })
                  }}
                  %
                </dd>
              </div>
              <div>
                <dt class="adm-help">Presupuesto máximo</dt>
                <dd>{{ formatEuros(selected.margin.budgetLimitCents) }}</dd>
              </div>
            </dl>
          </AdminCard>
        </div>
        <template #footer>
          <AdminButton @click="detailOpen = false">Cerrar</AdminButton>
        </template>
      </AdminDrawer>
    </div>
  </AdminPage>
</template>
