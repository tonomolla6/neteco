<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import type { ConveniencePoint, ConveniencePointNetwork } from '~~/shared/shipping-convenience-points'

const props = defineProps<{
  postalCode: string
  modelValue?: ConveniencePoint | null
}>()

const emit = defineEmits<{
  (e: 'update:modelValue' | 'select', value: ConveniencePoint): void
}>()

const requestFetch = useRequestFetch()

const loading = ref(false)
const error = ref<string | null>(null)
const points = ref<ConveniencePoint[]>([])
const selectedNetwork = ref<ConveniencePointNetwork | 'all'>('all')

const filteredPoints = computed(() => {
  if (selectedNetwork.value === 'all') return points.value
  return points.value.filter((p) => p.network === selectedNetwork.value)
})

const selected = computed(() => props.modelValue ?? null)

async function fetchPoints() {
  if (!props.postalCode || !/^\d{5}$/.test(props.postalCode)) {
    points.value = []
    return
  }

  loading.value = true
  error.value = null

  try {
    const query: Record<string, string> = { postalCode: props.postalCode }
    if (selectedNetwork.value !== 'all') {
      query.network = selectedNetwork.value
    }

    const response = await requestFetch<{
      points: ConveniencePoint[]
      total: number
      postalCode: string
    }>('/api/shipping/convenience-points', {
      method: 'GET',
      query
    })

    points.value = response.points || []
  } catch {
    error.value = 'No se han podido cargar los puntos de conveniencia. Por favor, inténtalo de nuevo.'
  } finally {
    loading.value = false
  }
}

function selectPoint(point: ConveniencePoint) {
  emit('update:modelValue', point)
  emit('select', point)
}

function filterNetwork(network: ConveniencePointNetwork | 'all') {
  selectedNetwork.value = network
  void fetchPoints()
}

function networkLabel(network: ConveniencePointNetwork): string {
  switch (network) {
    case 'inpost':
      return 'InPost Punto Pack'
    case 'correos':
      return 'Correos CityPaq'
    case 'seur':
      return 'SEUR Pickup'
    case 'gls':
      return 'GLS ParcelShop'
    default:
      return network
  }
}

watch(
  () => props.postalCode,
  () => {
    void fetchPoints()
  }
)

onMounted(() => {
  void fetchPoints()
})
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center justify-between border-b border-slate-200 pb-3">
      <div>
        <h3 class="text-base font-semibold text-slate-900">Puntos de conveniencia y Lockers</h3>
        <p class="text-xs text-slate-500">Recoge tu pedido en un punto cercano a tu código postal ({{ postalCode }})</p>
      </div>

      <!-- Network Filter Tabs -->
      <div class="flex items-center space-x-1 rounded-lg bg-slate-100 p-1 text-xs">
        <button
          type="button"
          :class="[
            'rounded px-2.5 py-1 font-medium transition-colors',
            selectedNetwork === 'all' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
          ]"
          @click="filterNetwork('all')"
        >
          Todos
        </button>
        <button
          type="button"
          :class="[
            'rounded px-2.5 py-1 font-medium transition-colors',
            selectedNetwork === 'inpost' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
          ]"
          @click="filterNetwork('inpost')"
        >
          InPost
        </button>
        <button
          type="button"
          :class="[
            'rounded px-2.5 py-1 font-medium transition-colors',
            selectedNetwork === 'correos' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
          ]"
          @click="filterNetwork('correos')"
        >
          Correos
        </button>
      </div>
    </div>

    <!-- Loading State -->
    <div
      v-if="loading"
      role="status"
      aria-live="polite"
      class="flex items-center justify-center p-8 text-sm text-slate-500"
    >
      <svg
        class="mr-2 h-5 w-5 animate-spin text-slate-400"
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
      >
        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
        <path
          class="opacity-75"
          fill="currentColor"
          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
        ></path>
      </svg>
      Buscando puntos de conveniencia...
    </div>

    <!-- Error State -->
    <div v-else-if="error" role="alert" class="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
      {{ error }}
    </div>

    <!-- Empty State -->
    <div
      v-else-if="filteredPoints.length === 0"
      role="alert"
      class="rounded-lg border border-slate-200 bg-slate-50 p-6 text-center text-sm text-slate-600"
    >
      No hemos encontrado puntos de conveniencia disponibles en el código postal {{ postalCode }}.
    </div>

    <!-- Points List (Accessible radiogroup) -->
    <div
      v-else
      role="radiogroup"
      aria-label="Puntos de recogida y lockers disponibles"
      class="grid grid-cols-1 gap-3 sm:grid-cols-2"
    >
      <div
        v-for="point in filteredPoints"
        :key="point.id"
        role="radio"
        :aria-checked="selected?.id === point.id"
        tabindex="0"
        :class="[
          'relative cursor-pointer rounded-lg border p-4 transition-all focus:outline-none focus:ring-2 focus:ring-neteco-500',
          selected?.id === point.id
            ? 'border-neteco-600 bg-neteco-50/30 ring-1 ring-neteco-600'
            : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50'
        ]"
        @click="selectPoint(point)"
        @keydown.space.prevent="selectPoint(point)"
        @keydown.enter.prevent="selectPoint(point)"
      >
        <div class="flex items-start justify-between">
          <div class="space-y-1">
            <div class="flex items-center space-x-2">
              <span
                class="inline-flex items-center rounded px-2 py-0.5 text-xs font-medium"
                :class="point.hasLocker ? 'bg-emerald-100 text-emerald-800' : 'bg-blue-100 text-blue-800'"
              >
                {{ point.hasLocker ? 'Locker 24/7' : 'Punto de recogida' }}
              </span>
              <span class="text-xs font-medium text-slate-500">
                {{ networkLabel(point.network) }}
              </span>
            </div>

            <h4 class="text-sm font-semibold text-slate-900">
              {{ point.name }}
            </h4>
            <p class="text-xs text-slate-600">{{ point.streetAddress }}, {{ point.postalCode }} {{ point.city }}</p>
          </div>

          <div
            class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border"
            :class="selected?.id === point.id ? 'border-neteco-600 bg-neteco-600' : 'border-slate-300 bg-white'"
          >
            <div v-if="selected?.id === point.id" class="h-2 w-2 rounded-full bg-white"></div>
          </div>
        </div>

        <div v-if="point.acceptsReturns" class="mt-3 border-t border-slate-100 pt-2">
          <span class="text-[11px] text-slate-500"> Admite devoluciones de paquetes </span>
        </div>
      </div>
    </div>
  </div>
</template>
