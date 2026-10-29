<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import EventRegistrationCard from '../components/events/EventRegistrationCard.vue'
import type { EventItemView } from '../../shared/events'

const requestFetch = useRequestFetch()

const selectedType = ref('')
const selectedSector = ref('')
const loading = ref(true)
const error = ref<string | null>(null)
const events = ref<EventItemView[]>([])

const types = [
  { value: '', label: 'Todos los formatos' },
  { value: 'webinar', label: 'Webinars Online' },
  { value: 'demo', label: 'Demostraciones Prácticas' },
  { value: 'local_event', label: 'Eventos Locales Presenciales' }
]

const sectors = [
  { value: '', label: 'Todos los sectores' },
  { value: 'hosteleria', label: 'Hostelería y Restauración' },
  { value: 'automocion', label: 'Automoción y Talleres' },
  { value: 'sanitario', label: 'Sanitario y Clínicas' },
  { value: 'industrial', label: 'Industria' },
  { value: 'oficinas', label: 'Oficinas' },
  { value: 'colectividades', label: 'Colectividades' }
]

async function loadEvents() {
  loading.value = true
  error.value = null
  try {
    const params = new URLSearchParams()
    if (selectedType.value) params.set('type', selectedType.value)
    if (selectedSector.value) params.set('sector', selectedSector.value)

    const query = params.toString() ? `?${params.toString()}` : ''
    const res = (await requestFetch(`/api/events${query}`)) as { items: EventItemView[] }
    events.value = res.items || []
  } catch {
    error.value = 'No se pudieron cargar los eventos en este momento.'
  } finally {
    loading.value = false
  }
}

watch([selectedType, selectedSector], () => {
  loadEvents()
})

onMounted(() => {
  loadEvents()
})
</script>

<template>
  <div class="eventos-page max-w-7xl mx-auto px-4 py-8 space-y-8">
    <div class="border-b pb-6">
      <h1 class="text-3xl font-extrabold text-gray-900 tracking-tight">Webinars, Demos Técnicas y Eventos</h1>
      <p class="text-base text-gray-600 mt-2 max-w-3xl">
        Formación especializada para equipos de limpieza profesional, normativas de higiene química, demostraciones de
        maquinaria y protocolos APPCC. Reserva tu plaza con recordatorios personalizados o consulta grabaciones y
        subtítulos accesibles.
      </p>
    </div>

    <!-- Filters -->
    <div class="flex flex-wrap items-center gap-4 bg-gray-50 p-4 rounded-lg">
      <div>
        <label for="type-select" class="block text-xs font-semibold text-gray-700 uppercase mb-1">Formato:</label>
        <select
          id="type-select"
          v-model="selectedType"
          class="border rounded px-3 py-2 text-sm bg-white focus:ring-blue-500 focus:border-blue-500"
        >
          <option v-for="t in types" :key="t.value" :value="t.value">
            {{ t.label }}
          </option>
        </select>
      </div>

      <div>
        <label for="sector-select" class="block text-xs font-semibold text-gray-700 uppercase mb-1">Sector:</label>
        <select
          id="sector-select"
          v-model="selectedSector"
          class="border rounded px-3 py-2 text-sm bg-white focus:ring-blue-500 focus:border-blue-500"
        >
          <option v-for="s in sectors" :key="s.value" :value="s.value">
            {{ s.label }}
          </option>
        </select>
      </div>
    </div>

    <!-- Loading State -->
    <div v-if="loading" class="py-16 text-center text-gray-500 text-sm">Cargando agenda de eventos técnicos...</div>

    <!-- Error State -->
    <div v-else-if="error" class="bg-red-50 text-red-700 p-4 rounded text-sm">
      {{ error }}
    </div>

    <!-- Empty State -->
    <div v-else-if="events.length === 0" class="py-16 text-center text-gray-500 text-sm bg-white border rounded">
      No hay sesiones programadas en este momento para los criterios seleccionados.
    </div>

    <!-- Events Grid -->
    <div v-else class="grid grid-cols-1 md:grid-cols-2 gap-6">
      <EventRegistrationCard v-for="ev in events" :key="ev.id" :event="ev" />
    </div>
  </div>
</template>
