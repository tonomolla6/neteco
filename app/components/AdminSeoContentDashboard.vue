<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { SeoContentDashboardResponse, SeoDevice } from '~~/shared/seo-content-dashboard'

const props = defineProps<{ runtime: unknown }>()
const { ready, loggedIn, user } = useUserSession()
const requestFetch = useRequestFetch()

const fromDate = ref('')
const toDate = ref('')
const selectedDevice = ref<SeoDevice>('all')
const landingFilter = ref('')
const queryFilter = ref('')

const loading = ref(false)
const error = ref<string | null>(null)
const data = ref<SeoContentDashboardResponse | null>(null)

const isAuthorized = computed(() => {
  return (
    props.runtime === 'cloudflare' &&
    ready.value === true &&
    loggedIn.value === true &&
    user.value?.emailVerified === true &&
    user.value?.mfaVerified === true
  )
})

function formatEuros(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || Number.isNaN(cents)) return '0,00 €'
  return `${(cents / 100).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`
}

function formatPercent(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || Number.isNaN(rate)) return '0,0%'
  return `${(rate * 100).toFixed(1)}%`
}

function formatInteger(num: number | null | undefined): string {
  if (num === null || num === undefined || Number.isNaN(num)) return '0'
  return num.toLocaleString('es-ES')
}

async function fetchDashboard() {
  if (!isAuthorized.value) return
  loading.value = true
  error.value = null

  try {
    const params = new URLSearchParams()
    if (fromDate.value) params.set('from', fromDate.value)
    if (toDate.value) params.set('to', toDate.value)
    if (selectedDevice.value && selectedDevice.value !== 'all') params.set('device', selectedDevice.value)
    if (landingFilter.value) params.set('landingPath', landingFilter.value)
    if (queryFilter.value) params.set('query', queryFilter.value)

    const response = await requestFetch<SeoContentDashboardResponse>(
      `/api/admin/seo/dashboard${params.toString() ? `?${params.toString()}` : ''}`,
      { method: 'GET' }
    )
    data.value = response
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : 'Error al cargar el panel de SEO y contenido'
  } finally {
    loading.value = false
  }
}

const preset = ref('')
const presetOptions = [
  { value: '7', label: '7 días' },
  { value: '30', label: '30 días' },
  { value: '90', label: '90 días' }
]
watch(preset, (value) => {
  if (!value) return
  const end = new Date()
  fromDate.value = new Date(end.getTime() - Number(value) * 86_400_000).toISOString().slice(0, 10)
  toDate.value = end.toISOString().slice(0, 10)
  void fetchDashboard()
})
function onDateChange() {
  preset.value = ''
  void fetchDashboard()
}
const formatReturn = (value: number) => (value > 0 ? `${value.toFixed(2)}x` : '—')
type LandingRow = SeoContentDashboardResponse['landingPages'][number]
type QueryRow = SeoContentDashboardResponse['queries'][number]
const landingColumns = [
  { key: 'landingPath', label: 'Página' },
  { key: 'impressions', label: 'Apariciones', numeric: true, sortable: true },
  { key: 'clicks', label: 'Clics', numeric: true, sortable: true },
  { key: 'ctr', label: '% de clics', numeric: true, sortable: true, hideOnMobile: true },
  { key: 'avgPosition', label: 'Posición media', numeric: true, sortable: true, hideOnMobile: true },
  { key: 'assistedRevenueNetCents', label: 'Ventas atribuidas', numeric: true, sortable: true },
  { key: 'contentCostCents', label: 'Coste', numeric: true, sortable: true, hideOnMobile: true },
  { key: 'seoRoi', label: 'Retorno', numeric: true, sortable: true, hideOnMobile: true }
]
const queryColumns = [
  { key: 'query', label: 'Búsqueda' },
  { key: 'impressions', label: 'Apariciones', numeric: true, sortable: true },
  { key: 'clicks', label: 'Clics', numeric: true, sortable: true },
  { key: 'ctr', label: '% de clics', numeric: true, sortable: true, hideOnMobile: true },
  { key: 'avgPosition', label: 'Posición media', numeric: true, sortable: true, hideOnMobile: true },
  { key: 'assistedOrdersCount', label: 'Pedidos', numeric: true, sortable: true },
  { key: 'assistedRevenueNetCents', label: 'Ventas atribuidas', numeric: true, sortable: true }
]

onMounted(() => {
  if (isAuthorized.value) {
    void fetchDashboard()
  }
})
</script>

<template>
  <div class="adm-stack">
    <AdminCard v-if="!isAuthorized">
      <AdminEmptyState
        icon="i-lucide-lock"
        title="Los datos de buscadores no están disponibles ahora"
        description="Necesitas la sesión iniciada, el correo verificado y la verificación en dos pasos, y solo se pueden consultar en la tienda publicada."
      />
    </AdminCard>
    <template v-else>
      <form class="adm-toolbar" role="search" aria-label="Filtros de buscadores" @submit.prevent="fetchDashboard">
        <label class="adm-toolbar__search">
          <span class="sr-only">Buscar una búsqueda concreta</span>
          <UIcon name="i-lucide-search" class="size-4" />
          <input
            id="seo-query-filter"
            v-model="queryFilter"
            type="search"
            placeholder="Filtrar por búsqueda…"
            data-slot="adm-search"
          />
        </label>
        <AdminFilters v-model="preset" :options="presetOptions" label="Periodo" />
        <label for="seo-from-date" class="adm-help">Desde</label>
        <input id="seo-from-date" v-model="fromDate" type="date" class="adm-input w-auto" @change="onDateChange" />
        <label for="seo-to-date" class="adm-help">Hasta</label>
        <input id="seo-to-date" v-model="toDate" type="date" class="adm-input w-auto" @change="onDateChange" />
        <label for="seo-device-filter" class="sr-only">Dispositivo</label>
        <select
          id="seo-device-filter"
          v-model="selectedDevice"
          data-testid="seo-filter-device"
          class="adm-input w-auto"
          @change="fetchDashboard"
        >
          <option value="all">Todos los dispositivos</option>
          <option value="desktop">Ordenador</option>
          <option value="mobile">Móvil</option>
          <option value="tablet">Tableta</option>
        </select>
        <button
          type="submit"
          class="sr-only"
          tabindex="-1"
          data-testid="seo-filter-submit"
          @click.prevent="fetchDashboard"
        >
          Aplicar filtros
        </button>
        <div class="adm-toolbar__end">
          <button
            type="button"
            class="adm-btn adm-btn--secondary"
            :disabled="loading"
            data-testid="seo-refresh"
            @click="fetchDashboard"
          >
            <UIcon name="i-lucide-rotate-cw" class="size-4" :class="loading && 'animate-spin'" />Actualizar
          </button>
        </div>
      </form>

      <AdminCard v-if="error">
        <AdminEmptyState
          variant="error"
          title="No hemos podido cargar los datos de buscadores"
          description="Vuelve a intentarlo en unos segundos."
        >
          <AdminButton icon="i-lucide-rotate-cw" @click="fetchDashboard">Reintentar</AdminButton>
        </AdminEmptyState>
      </AdminCard>

      <div v-else-if="loading && !data" class="adm-grid" aria-busy="true">
        <span class="sr-only">Cargando los datos de buscadores…</span>
        <div
          v-for="row in 6"
          :key="row"
          class="h-28 animate-pulse rounded-[var(--radius-surface)] bg-[var(--surface-sunken)]"
        />
      </div>

      <template v-if="data">
        <p class="adm-help flex flex-wrap items-center gap-x-2 gap-y-1">
          <AdminBadge :tone="data.syncStatus.status === 'synced' ? 'success' : 'warning'">
            {{ data.syncStatus.status === 'synced' ? 'Datos al día' : 'Actualización pendiente' }}
          </AdminBadge>
          <span v-if="data.syncStatus.dataThroughDate">
            Datos hasta el {{ adminDate(data.syncStatus.dataThroughDate) }}
          </span>
          <span v-if="data.syncStatus.lastSyncAt">
            · Última actualización: {{ adminDate(data.syncStatus.lastSyncAt, true) }}
          </span>
        </p>

        <div class="adm-grid">
          <div class="adm-card adm-stat">
            <p class="adm-stat__label"><UIcon name="i-lucide-eye" class="size-4" />Apariciones en buscadores</p>
            <p class="adm-stat__value" data-testid="seo-kpi-impressions">
              {{ formatInteger(data.summary.totalImpressions) }}
            </p>
            <p class="adm-stat__foot">Veces que la tienda salió en los resultados</p>
          </div>
          <div class="adm-card adm-stat">
            <p class="adm-stat__label"><UIcon name="i-lucide-mouse-pointer-click" class="size-4" />Clics</p>
            <p class="adm-stat__value" data-testid="seo-kpi-clicks">{{ formatInteger(data.summary.totalClicks) }}</p>
            <p class="adm-stat__foot">{{ formatPercent(data.summary.overallCtr) }} de las apariciones</p>
          </div>
          <AdminStat
            label="Posición media"
            icon="i-lucide-list-ordered"
            :value="data.summary.avgPosition > 0 ? data.summary.avgPosition.toFixed(1) : '—'"
            hint="Puesto en la página de resultados"
          />
          <div class="adm-card adm-stat">
            <p class="adm-stat__label"><UIcon name="i-lucide-banknote" class="size-4" />Ventas atribuidas</p>
            <p class="adm-stat__value" data-testid="seo-kpi-assisted-revenue">
              {{ formatEuros(data.summary.assistedRevenueNetCents) }}
            </p>
            <p class="adm-stat__foot">{{ data.summary.assistedOrdersCount }} pedidos llegados desde buscadores</p>
          </div>
          <div class="adm-card adm-stat">
            <p class="adm-stat__label"><UIcon name="i-lucide-pen-line" class="size-4" />Coste del contenido</p>
            <p class="adm-stat__value" data-testid="seo-kpi-content-cost">
              {{ formatEuros(data.summary.totalContentCostCents) }}
            </p>
            <p class="adm-stat__foot">Redacción y actualización</p>
          </div>
          <div class="adm-card adm-stat">
            <p class="adm-stat__label"><UIcon name="i-lucide-trending-up" class="size-4" />Retorno</p>
            <p class="adm-stat__value" data-testid="seo-kpi-roi">{{ formatReturn(data.summary.seoRoi) }}</p>
            <p class="adm-stat__foot">Ventas atribuidas por cada euro de contenido</p>
          </div>
        </div>

        <AdminSection title="Páginas por las que entran los clientes">
          <AdminTable
            data-testid="seo-landings-table"
            :rows="data.landingPages"
            :columns="landingColumns"
            :row-key="(row: LandingRow) => row.landingPath"
            :per-page="15"
            empty-title="Sin páginas en este periodo"
            empty-description="Todavía no hay visitas desde buscadores con estos filtros."
            empty-icon="i-lucide-file-search"
            caption="Páginas de entrada desde buscadores"
          >
            <template #cell-landingPath="{ row }">
              <span class="block max-w-xs truncate font-semibold text-[var(--text-strong)]" :title="row.landingPath">
                {{ row.landingPath }}
              </span>
            </template>
            <template #cell-impressions="{ row }">{{ formatInteger(row.impressions) }}</template>
            <template #cell-clicks="{ row }">{{ formatInteger(row.clicks) }}</template>
            <template #cell-ctr="{ row }">{{ formatPercent(row.ctr) }}</template>
            <template #cell-avgPosition="{ row }">{{ row.avgPosition.toFixed(1) }}</template>
            <template #cell-assistedRevenueNetCents="{ row }">
              {{ formatEuros(row.assistedRevenueNetCents) }}
            </template>
            <template #cell-contentCostCents="{ row }">{{ formatEuros(row.contentCostCents) }}</template>
            <template #cell-seoRoi="{ row }">{{ formatReturn(row.seoRoi) }}</template>
          </AdminTable>
        </AdminSection>

        <AdminSection title="Qué buscan antes de llegar a la tienda">
          <AdminTable
            data-testid="seo-queries-table"
            :rows="data.queries"
            :columns="queryColumns"
            :row-key="(row: QueryRow) => row.query"
            :per-page="15"
            :filtered="Boolean(queryFilter)"
            empty-title="Sin búsquedas en este periodo"
            empty-description="Todavía no hay búsquedas registradas con estos filtros."
            empty-icon="i-lucide-search"
            caption="Búsquedas en buscadores que llevan a la tienda"
            @clear-filters="((queryFilter = ''), fetchDashboard())"
          >
            <template #cell-query="{ row }">
              <span class="font-semibold text-[var(--text-strong)]">{{ row.query }}</span>
            </template>
            <template #cell-impressions="{ row }">{{ formatInteger(row.impressions) }}</template>
            <template #cell-clicks="{ row }">{{ formatInteger(row.clicks) }}</template>
            <template #cell-ctr="{ row }">{{ formatPercent(row.ctr) }}</template>
            <template #cell-avgPosition="{ row }">{{ row.avgPosition.toFixed(1) }}</template>
            <template #cell-assistedRevenueNetCents="{ row }">
              {{ formatEuros(row.assistedRevenueNetCents) }}
            </template>
          </AdminTable>
        </AdminSection>
      </template>
    </template>
  </div>
</template>
