<script setup lang="ts">
import { ref, onMounted, watch } from 'vue'
import type { SearchAnalyticsDashboardResponse } from '../../workers/analytics/search-analytics'

defineProps<{
  runtime?: unknown
}>()

const requestFetch = useRequestFetch()

const loading = ref(true)
const error = ref<string | null>(null)
const data = ref<SearchAnalyticsDashboardResponse | null>(null)

// Default range: last 30 days
const now = new Date()
const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000)

const fromDate = ref(thirtyDaysAgo.toISOString().slice(0, 10))
const toDate = ref(now.toISOString().slice(0, 10))
const selectedDevice = ref<'all' | 'desktop' | 'mobile' | 'tablet' | 'unknown'>('all')
const selectedSegment = ref<'all' | 'anonymous' | 'customer' | 'professional'>('all')

async function fetchDashboard() {
  loading.value = true
  error.value = null

  try {
    const fromIso = `${fromDate.value}T00:00:00Z`
    const toIso = `${toDate.value}T23:59:59Z`

    const response = await requestFetch<SearchAnalyticsDashboardResponse>('/api/admin/analytics/search', {
      method: 'GET',
      query: {
        from: fromIso,
        to: toIso,
        device: selectedDevice.value,
        segment: selectedSegment.value,
        page: 1,
        perPage: 50
      }
    })

    data.value = response
  } catch {
    error.value = 'No se ha podido cargar la analítica de búsqueda. Comprueba tus permisos de administración.'
  } finally {
    loading.value = false
  }
}

function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—'
  return `${(value * 100).toFixed(1)}%`
}

// Atajos de periodo y aplicación automática al cambiar cualquier filtro.
const period = ref('30')
const periodOptions = [
  { value: '7', label: '7 días' },
  { value: '30', label: '30 días' },
  { value: '90', label: '90 días' }
]
watch(period, (value) => {
  const days = Number(value)
  if (!days) return
  const end = new Date()
  fromDate.value = new Date(end.getTime() - days * 86400000).toISOString().slice(0, 10)
  toDate.value = end.toISOString().slice(0, 10)
})
function customPeriod() {
  period.value = ''
}
watch([fromDate, toDate, selectedDevice, selectedSegment], () => {
  if (fromDate.value && toDate.value) void fetchDashboard()
})

const queryColumns = [
  { key: 'term', label: 'Búsqueda' },
  { key: 'searches', label: 'Veces buscada', numeric: true, sortable: true },
  { key: 'clicks', label: 'Clics', numeric: true, sortable: true, hideOnMobile: true },
  { key: 'ctr', label: '% con clic', numeric: true },
  { key: 'addToCart', label: 'Al carrito', numeric: true, sortable: true, hideOnMobile: true },
  { key: 'addToCartRate', label: '% al carrito', numeric: true }
]
const zeroColumns = [
  { key: 'term', label: 'Búsqueda' },
  { key: 'zeroResults', label: 'Veces sin resultado', numeric: true, sortable: true }
]

onMounted(() => {
  void fetchDashboard()
})
</script>

<template>
  <div class="adm-stack">
    <AdminPageActions>
      <AdminButton to="/admin/busqueda" icon="i-lucide-sliders-horizontal">Ajustar el buscador</AdminButton>
    </AdminPageActions>

    <div class="adm-toolbar" role="search" aria-label="Filtros de la analítica de búsqueda">
      <AdminFilters v-model="period" :options="periodOptions" label="Periodo" />
      <label for="filter-from" class="sr-only">Desde</label>
      <input id="filter-from" v-model="fromDate" type="date" class="adm-input w-auto" @change="customPeriod" />
      <label for="filter-to" class="sr-only">Hasta</label>
      <input id="filter-to" v-model="toDate" type="date" class="adm-input w-auto" @change="customPeriod" />
      <label for="filter-device" class="sr-only">Dispositivo</label>
      <select id="filter-device" v-model="selectedDevice" data-filter="device" class="adm-input w-auto">
        <option value="all">Todos los dispositivos</option>
        <option value="desktop">Ordenador</option>
        <option value="mobile">Móvil</option>
        <option value="tablet">Tableta</option>
        <option value="unknown">Otro o desconocido</option>
      </select>
      <label for="filter-segment" class="sr-only">Tipo de cliente</label>
      <select id="filter-segment" v-model="selectedSegment" data-filter="segment" class="adm-input w-auto">
        <option value="all">Todos los clientes</option>
        <option value="anonymous">Visitante sin cuenta</option>
        <option value="customer">Cliente particular</option>
        <option value="professional">Cliente profesional</option>
      </select>
      <div class="adm-toolbar__end">
        <button
          type="button"
          data-action="apply-filters"
          class="adm-btn adm-btn--secondary"
          :disabled="loading"
          @click="fetchDashboard"
        >
          <UIcon name="i-lucide-rotate-cw" class="size-4 shrink-0" />
          Actualizar
        </button>
      </div>
    </div>

    <AdminCard v-if="error" role="alert">
      <AdminEmptyState compact variant="error" title="No hemos podido cargar las búsquedas" :description="error">
        <AdminButton icon="i-lucide-rotate-cw" @click="fetchDashboard">Reintentar</AdminButton>
      </AdminEmptyState>
    </AdminCard>

    <div v-if="loading && !data" role="status" class="adm-grid">
      <span class="sr-only">Cargando analítica de búsqueda…</span>
      <div
        v-for="row in 4"
        :key="row"
        class="h-28 animate-pulse rounded-[var(--radius-surface)] bg-[var(--surface-sunken)]"
        aria-hidden="true"
      />
    </div>

    <template v-else-if="data && !error">
      <div class="adm-grid" :aria-busy="loading">
        <AdminStat
          label="Búsquedas"
          icon="i-lucide-search"
          :value="data.summary.totalSearches.toLocaleString('es-ES')"
          hint="En el periodo elegido"
        />
        <AdminStat
          label="Sin resultado"
          icon="i-lucide-search-x"
          :value="data.summary.totalZeroResults.toLocaleString('es-ES')"
          :hint="`${
            data.summary.totalSearches > 0
              ? ((data.summary.totalZeroResults / data.summary.totalSearches) * 100).toFixed(1)
              : '0'
          } % del total`"
        />
        <AdminStat
          label="Búsquedas con clic"
          icon="i-lucide-mouse-pointer-click"
          :value="formatPercent(data.summary.globalCtr)"
          :hint="
            data.summary.globalCtr === null
              ? `${data.summary.totalClicks} clics · menos de 20 búsquedas`
              : `${data.summary.totalClicks} clics en resultados`
          "
        />
        <AdminStat
          label="Búsquedas que acaban en el carrito"
          icon="i-lucide-shopping-cart"
          :value="formatPercent(data.summary.globalAddToCartRate)"
          :hint="
            data.summary.globalAddToCartRate === null
              ? `${data.summary.totalAddToCart} añadidos · menos de 20 búsquedas`
              : `${data.summary.totalAddToCart} productos añadidos`
          "
        />
      </div>

      <AdminSection
        title="Lo más buscado"
        description="Los porcentajes solo se calculan cuando un término suma al menos 20 búsquedas; con menos, la cifra no sería fiable."
      >
        <AdminTable
          :rows="data.topQueries"
          :columns="queryColumns"
          :row-key="(row) => row.term"
          :status="loading ? 'pending' : 'idle'"
          empty-title="Sin búsquedas en este periodo"
          empty-description="Prueba con un periodo más amplio o quita algún filtro."
          empty-icon="i-lucide-search"
          caption="Términos más buscados por los clientes"
        >
          <template #cell-term="{ row }">
            <span class="font-medium text-[var(--text-strong)]">{{ row.term }}</span>
          </template>
          <template #cell-ctr="{ row }">
            <template v-if="row.hasSufficientSample">{{ formatPercent(row.ctr) }}</template>
            <span v-else class="text-[var(--text-muted)]" title="Menos de 20 búsquedas: muestra insuficiente">—</span>
          </template>
          <template #cell-addToCartRate="{ row }">
            <template v-if="row.hasSufficientSample">{{ formatPercent(row.addToCartRate) }}</template>
            <span v-else class="text-[var(--text-muted)]" title="Menos de 20 búsquedas: muestra insuficiente">—</span>
          </template>
        </AdminTable>
      </AdminSection>

      <AdminSection
        title="Búsquedas sin resultado"
        description="El cliente no encontró ningún producto. Añade un sinónimo o una regla para que encuentre lo que busca."
      >
        <AdminTable
          :rows="data.zeroResultQueries"
          :columns="zeroColumns"
          :row-key="(row) => row.term"
          :status="loading ? 'pending' : 'idle'"
          empty-title="Ninguna búsqueda se quedó sin resultado"
          empty-description="En este periodo todos los términos buscados devolvieron productos."
          empty-icon="i-lucide-circle-check"
          caption="Términos buscados que no devolvieron productos"
        >
          <template #cell-term="{ row }">
            <span class="font-medium text-[var(--text-strong)]">{{ row.term }}</span>
          </template>
          <template #actions="{ row }">
            <AdminButton size="sm" :to="row.synonymUrl" icon="i-lucide-arrow-left-right">Crear sinónimo</AdminButton>
            <AdminButton size="sm" :to="row.merchandisingUrl" icon="i-lucide-sparkles">Crear regla</AdminButton>
          </template>
        </AdminTable>
      </AdminSection>
    </template>
  </div>
</template>
