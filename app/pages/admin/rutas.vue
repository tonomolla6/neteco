<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import AdminDeliveryRoutePlanner from '../../components/AdminDeliveryRoutePlanner.vue'
import type { DeliveryDriver, DeliveryRoute, DeliveryVehicle } from '~~/shared/delivery-route-planning'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Rutas de reparto · Admin', robots: 'noindex, nofollow, noarchive' })

const requestFetch = useRequestFetch()
const toast = useToast()

/* --- Listado de rutas: la pantalla trabaja siempre sobre una ruta que existe --- */
const listStatus = ref<'loading' | 'ready' | 'error'>('loading')
const routes = ref<DeliveryRoute[]>([])
const selectedId = ref('')

const ROUTE_STATUS: Record<string, string> = {
  draft: 'borrador',
  planned: 'planificada',
  in_progress: 'en reparto',
  completed: 'completada',
  cancelled: 'cancelada'
}

function todayInMadrid(): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' })
}

/** Por defecto, la próxima ruta abierta; si no hay ninguna, la más reciente. */
function defaultRouteId(list: DeliveryRoute[]): string {
  const today = todayInMadrid()
  const upcoming = list
    .filter((route) => route.routeDate >= today && route.status !== 'completed' && route.status !== 'cancelled')
    .sort((a, b) => a.routeDate.localeCompare(b.routeDate))
  return upcoming[0]?.id ?? list[0]?.id ?? ''
}

async function loadRoutes(options: { silent?: boolean; preferId?: string } = {}) {
  if (!options.silent) listStatus.value = 'loading'
  try {
    const res = await requestFetch<{ routes?: DeliveryRoute[] }>('/api/admin/delivery-routes')
    const list = res.routes ?? []
    routes.value = list
    const wanted = options.preferId ?? selectedId.value
    selectedId.value = list.some((route) => route.id === wanted) ? wanted : defaultRouteId(list)
    listStatus.value = 'ready'
  } catch {
    if (!options.silent) listStatus.value = 'error'
  }
}

function routeLabel(route: DeliveryRoute): string {
  const stops = route.totalStops === 1 ? '1 parada' : `${route.totalStops} paradas`
  const parts = [`${adminDate(route.routeDate)}, de ${route.windowStart} a ${route.windowEnd}`]
  if (route.vehicle?.name) parts.push(route.vehicle.name)
  if (route.driver?.name) parts.push(route.driver.name)
  parts.push(stops, ROUTE_STATUS[route.status] ?? adminStatusLabel(route.status).toLowerCase())
  return parts.join(' · ')
}

function onRouteChanged(updated: DeliveryRoute) {
  routes.value = routes.value.map((route) => (route.id === updated.id ? updated : route))
}

/* --- Crear una ruta nueva --- */
const createOpen = ref(false)
const creating = ref(false)
const createError = ref('')
const vehicles = ref<DeliveryVehicle[]>([])
const drivers = ref<DeliveryDriver[]>([])
const form = reactive({ routeDate: '', windowStart: '08:00', windowEnd: '16:00', vehicleId: '', driverId: '' })

const activeVehicles = computed(() => vehicles.value.filter((vehicle) => vehicle.status === 'active'))
const activeDrivers = computed(() => drivers.value.filter((driver) => driver.status === 'active'))
const formProblem = computed(() => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.routeDate)) return 'Elige el día del reparto.'
  if (!/^\d{2}:\d{2}$/.test(form.windowStart) || !/^\d{2}:\d{2}$/.test(form.windowEnd))
    return 'Indica la hora de salida y la de fin.'
  if (form.windowEnd <= form.windowStart) return 'La hora de fin tiene que ser posterior a la de salida.'
  return ''
})

async function openCreate() {
  form.routeDate = todayInMadrid()
  form.windowStart = '08:00'
  form.windowEnd = '16:00'
  form.vehicleId = ''
  form.driverId = ''
  createError.value = ''
  createOpen.value = true
  const [vehicleList, driverList] = await Promise.all([
    requestFetch<{ vehicles?: DeliveryVehicle[] }>('/api/admin/delivery-vehicles').catch(() => null),
    requestFetch<{ drivers?: DeliveryDriver[] }>('/api/admin/delivery-drivers').catch(() => null)
  ])
  vehicles.value = vehicleList?.vehicles ?? []
  drivers.value = driverList?.drivers ?? []
}

async function createRoute() {
  if (formProblem.value || creating.value) return
  creating.value = true
  createError.value = ''
  const commandId = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `cmd-route-${Date.now()}`
  try {
    const res = await requestFetch<{ route: DeliveryRoute }>('/api/admin/delivery-routes', {
      method: 'POST',
      body: {
        routeDate: form.routeDate,
        windowStart: form.windowStart,
        windowEnd: form.windowEnd,
        ...(form.vehicleId ? { vehicleId: form.vehicleId } : {}),
        ...(form.driverId ? { driverId: form.driverId } : {}),
        commandId
      }
    })
    createOpen.value = false
    toast.add({ title: 'Ruta creada', color: 'success', icon: 'i-lucide-check' })
    await loadRoutes({ silent: true, preferId: res.route.id })
  } catch {
    createError.value = 'No se ha podido crear la ruta. Revisa los datos y vuelve a intentarlo.'
  } finally {
    creating.value = false
  }
}

onMounted(() => {
  void loadRoutes()
})
</script>

<template>
  <AdminPage>
    <template v-if="listStatus === 'ready' && routes.length" #actions>
      <AdminButton icon="i-lucide-plus" @click="openCreate">Nueva ruta</AdminButton>
    </template>

    <div class="adm-stack">
      <div v-if="listStatus === 'loading'" role="status" class="adm-card adm-table-skeleton" aria-busy="true">
        <span class="sr-only">Cargando las rutas de reparto…</span>
        <div v-for="row in 3" :key="row"><i /><i /><i /></div>
      </div>

      <AdminCard v-else-if="listStatus === 'error'">
        <div role="alert">
          <AdminEmptyState
            variant="error"
            title="No se han podido cargar las rutas de reparto"
            description="Puede ser un fallo puntual de conexión. Vuelve a intentarlo en unos segundos."
          >
            <AdminButton icon="i-lucide-rotate-cw" @click="loadRoutes()">Reintentar</AdminButton>
          </AdminEmptyState>
        </div>
      </AdminCard>

      <AdminCard v-else-if="!routes.length">
        <AdminEmptyState
          icon="i-lucide-map-pin"
          title="Todavía no hay rutas de reparto"
          description="Una ruta agrupa las entregas que hace un vehículo propio en un día. Crea la primera, añade sus paradas y el panel te ayudará a ordenarlas."
        >
          <AdminButton variant="primary" icon="i-lucide-plus" @click="openCreate">Crear la primera ruta</AdminButton>
        </AdminEmptyState>
      </AdminCard>

      <template v-else>
        <AdminCard>
          <div class="adm-toolbar">
            <label for="route-picker" class="adm-label">Ruta</label>
            <select id="route-picker" v-model="selectedId" class="adm-input w-auto min-w-0 max-w-full flex-1">
              <option v-for="route in routes" :key="route.id" :value="route.id">{{ routeLabel(route) }}</option>
            </select>
            <span class="adm-help">{{ routes.length === 1 ? '1 ruta' : `${routes.length} rutas` }}</span>
          </div>
        </AdminCard>

        <AdminDeliveryRoutePlanner
          v-if="selectedId"
          :key="selectedId"
          :route-id="selectedId"
          @changed="onRouteChanged"
          @gone="loadRoutes()"
        />
      </template>
    </div>

    <AdminDrawer
      v-model:open="createOpen"
      title="Nueva ruta de reparto"
      description="Elige el día y el horario. Las paradas se añaden después, desde la propia ruta."
    >
      <form id="route-create-form" class="adm-stack" @submit.prevent="createRoute">
        <UAlert v-if="createError" role="alert" color="error" variant="subtle" :title="createError" />
        <AdminFormField v-slot="{ id }" label="Día del reparto" required>
          <input :id="id" v-model="form.routeDate" type="date" class="adm-input" required />
        </AdminFormField>
        <div class="adm-form-grid">
          <AdminFormField v-slot="{ id }" label="Hora de salida" required>
            <input :id="id" v-model="form.windowStart" type="time" class="adm-input" required />
          </AdminFormField>
          <AdminFormField v-slot="{ id }" label="Hora de fin" required>
            <input :id="id" v-model="form.windowEnd" type="time" class="adm-input" required />
          </AdminFormField>
        </div>
        <AdminFormField
          v-slot="{ id }"
          label="Vehículo"
          :help="
            activeVehicles.length
              ? 'Opcional. Su capacidad limita el peso y los bultos de la ruta.'
              : 'Todavía no hay vehículos dados de alta: la ruta se creará sin vehículo.'
          "
        >
          <select :id="id" v-model="form.vehicleId" class="adm-input" :disabled="!activeVehicles.length">
            <option value="">Sin asignar</option>
            <option v-for="vehicle in activeVehicles" :key="vehicle.id" :value="vehicle.id">
              {{ vehicle.name }} ({{ vehicle.registrationPlate }})
            </option>
          </select>
        </AdminFormField>
        <AdminFormField
          v-slot="{ id }"
          label="Conductor"
          :help="
            activeDrivers.length
              ? 'Opcional.'
              : 'Todavía no hay conductores dados de alta: la ruta se creará sin conductor.'
          "
        >
          <select :id="id" v-model="form.driverId" class="adm-input" :disabled="!activeDrivers.length">
            <option value="">Sin asignar</option>
            <option v-for="driver in activeDrivers" :key="driver.id" :value="driver.id">{{ driver.name }}</option>
          </select>
        </AdminFormField>
        <p v-if="formProblem" class="adm-help">{{ formProblem }}</p>
      </form>
      <template #footer>
        <AdminButton @click="createOpen = false">Cancelar</AdminButton>
        <AdminButton
          variant="primary"
          type="submit"
          form="route-create-form"
          :loading="creating"
          :disabled="Boolean(formProblem)"
        >
          Crear ruta
        </AdminButton>
      </template>
    </AdminDrawer>
  </AdminPage>
</template>
