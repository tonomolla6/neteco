<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import BundleConfigurator from '../components/bundles/BundleConfigurator.vue'
import type { BundleDetailView } from '~~/shared/bundles'

const requestFetch = useRequestFetch()

useSeoMeta({
  title: 'Kits de higiene y limpieza por sector',
  description:
    'Kits preconfigurados de celulosa, químicos y consumibles profesionales para hostelería, industria alimentaria, clínicas y oficinas.'
})

const selectedSector = ref('')
const selectedTask = ref('')
const loading = ref(true)
const unavailable = ref(false)
const error = ref<string | null>(null)
const bundles = ref<BundleDetailView[]>([])

const sectors = [
  { value: '', label: 'Todos los sectores' },
  { value: 'hosteleria', label: 'Hostelería y Restauración' },
  { value: 'automocion', label: 'Automoción y Talleres' },
  { value: 'sanitario', label: 'Sanitario y Clínicas' },
  { value: 'industrial', label: 'Industria' },
  { value: 'oficinas', label: 'Oficinas y Despachos' },
  { value: 'colectividades', label: 'Colectividades y Educación' }
]

async function loadBundles() {
  loading.value = true
  error.value = null
  unavailable.value = false
  try {
    const params = new URLSearchParams()
    if (selectedSector.value) params.set('sector', selectedSector.value)
    if (selectedTask.value) params.set('task', selectedTask.value)

    const query = params.toString() ? `?${params.toString()}` : ''
    const res = (await requestFetch(`/api/bundles${query}`)) as { items: BundleDetailView[] }
    bundles.value = res.items || []
  } catch (cause: unknown) {
    const err = cause as {
      statusCode?: number
      status?: number
      response?: { status?: number }
      data?: { error?: { code?: string } }
    } | null
    const status = err?.statusCode ?? err?.status ?? err?.response?.status
    const code = err?.data?.error?.code
    if (status === 404 || status === 503 || code === 'feature_disabled') {
      unavailable.value = true
    } else {
      error.value = 'No se pudieron cargar los kits en este momento.'
    }
  } finally {
    loading.value = false
  }
}

watch([selectedSector, selectedTask], () => {
  loadBundles()
})

onMounted(() => {
  loadBundles()
})
</script>

<template>
  <div class="kits-page max-w-7xl mx-auto px-4 py-8 space-y-8">
    <div class="border-b pb-6">
      <h1 class="text-2xl font-bold tracking-tight text-gray-900 sm:text-3xl">Kits profesionales</h1>
      <p class="mt-2 text-base text-gray-600 max-w-3xl">
        Soluciones integradas por sector y tarea de limpieza técnica. Configura las cantidades deseadas, verifica la
        disponibilidad inmediata en nuestro almacén y ahorra frente a la compra suelta de componentes individuales.
      </p>
    </div>

    <!-- Filters -->
    <div class="flex flex-wrap items-center gap-4 bg-gray-50 p-4 rounded-lg">
      <div class="w-full sm:w-auto">
        <label for="sector-select" class="block text-xs font-semibold text-gray-700 uppercase mb-1">Sector:</label>
        <select
          id="sector-select"
          v-model="selectedSector"
          class="border rounded px-3 py-2 text-sm bg-white focus:ring-blue-500 focus:border-blue-500 w-full"
        >
          <option v-for="s in sectors" :key="s.value" :value="s.value">
            {{ s.label }}
          </option>
        </select>
      </div>
    </div>

    <!-- Loading State -->
    <div v-if="loading" class="py-16 text-center text-gray-500 text-sm">Cargando kits y disponibilidad de stock...</div>

    <!-- Unavailable State (404/disabled) -->
    <div
      v-else-if="unavailable"
      class="py-16 text-center text-gray-500 text-sm bg-white border border-gray-200 rounded-lg"
    >
      Esta sección estará disponible próximamente.
    </div>

    <!-- Error State -->
    <div v-else-if="error" class="bg-red-50 text-red-700 p-4 rounded text-sm">
      {{ error }}
    </div>

    <!-- Empty State -->
    <div v-else-if="bundles.length === 0" class="py-16 text-center text-gray-500 text-sm bg-white border rounded">
      No hay kits disponibles para el filtro seleccionado en este momento.
    </div>

    <!-- Bundles Grid -->
    <div v-else class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
      <BundleConfigurator v-for="b in bundles" :key="b.id" :bundle="b" />
    </div>
  </div>
</template>
