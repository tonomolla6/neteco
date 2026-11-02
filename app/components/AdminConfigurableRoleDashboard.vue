<script setup lang="ts">
import { ref, onMounted } from 'vue'
import {
  SYSTEM_ROLE_CODES,
  MANDATORY_WIDGET_IDS,
  type RoleDashboardConfig,
  type RoleDashboardWidgetConfig,
  type RoleSavedView
} from '~~/shared/role-dashboard-config'

const requestFetch = useRequestFetch()

const selectedRole = ref<string>('order_manager')
const loading = ref(false)
const saving = ref(false)
const errorMessage = ref('')
const successMessage = ref('')

const currentConfig = ref<RoleDashboardConfig | null>(null)
const savedViews = ref<RoleSavedView[]>([])
const activeViewId = ref<string | null>(null)

// New view creation modal
const showNewViewModal = ref(false)
const newViewName = ref('')
const newViewScope = ref<'role_shared' | 'personal'>('role_shared')
const newViewIsDefault = ref(false)

function extractErrorCode(err: unknown, fallback: string): string {
  const code = (err as { data?: { error?: { code?: string } } })?.data?.error?.code
  return code ? `Error: ${code}` : fallback
}

async function loadDashboardConfig() {
  loading.value = true
  errorMessage.value = ''
  try {
    const res = (await requestFetch(`/api/admin/dashboard/config?role=${selectedRole.value}`)) as RoleDashboardConfig
    currentConfig.value = res
  } catch (err: unknown) {
    errorMessage.value = extractErrorCode(err, 'Error al cargar la configuración del panel')
  } finally {
    loading.value = false
  }
}

async function loadSavedViews() {
  try {
    const res = (await requestFetch(`/api/admin/dashboard/views?role=${selectedRole.value}&viewType=orders`)) as {
      views: RoleSavedView[]
    }
    savedViews.value = res.views
    const defaultView = savedViews.value.find((v) => v.isDefault)
    if (defaultView) {
      activeViewId.value = defaultView.id
    }
  } catch {
    // ignore
  }
}

function isWidgetMandatory(widgetId: string): boolean {
  return (MANDATORY_WIDGET_IDS as readonly string[]).includes(widgetId)
}

function toggleWidget(widget: RoleDashboardWidgetConfig) {
  if (isWidgetMandatory(widget.widgetId)) {
    // Invariant: mandatory alerts cannot be hidden
    errorMessage.value = 'Las alertas obligatorias no se pueden ocultar bajo ninguna circunstancia.'
    widget.visible = true
    return
  }
  widget.visible = !widget.visible
}

function moveWidget(index: number, direction: 'up' | 'down') {
  if (!currentConfig.value) return
  const targetIndex = direction === 'up' ? index - 1 : index + 1
  if (targetIndex < 0 || targetIndex >= currentConfig.value.widgets.length) return

  const item = currentConfig.value.widgets[index]
  if (!item) return
  currentConfig.value.widgets.splice(index, 1)
  currentConfig.value.widgets.splice(targetIndex, 0, item)

  // Re-number orders
  currentConfig.value.widgets.forEach((w, idx) => {
    w.order = idx + 1
  })
}

async function saveLayout() {
  if (!currentConfig.value) return
  saving.value = true
  errorMessage.value = ''
  successMessage.value = ''
  try {
    const res = (await requestFetch('/api/admin/dashboard/role-config', {
      method: 'PUT',
      body: {
        commandId: crypto.randomUUID(),
        roleCode: selectedRole.value,
        expectedVersion: currentConfig.value.version,
        widgets: currentConfig.value.widgets,
        columnPreferences: currentConfig.value.columnPreferences
      }
    })) as RoleDashboardConfig
    currentConfig.value = res
    successMessage.value = 'Configuración de panel guardada con éxito.'
  } catch (err: unknown) {
    errorMessage.value = extractErrorCode(err, 'Error al guardar la configuración')
  } finally {
    saving.value = false
  }
}

async function createView() {
  if (!newViewName.value.trim()) return
  try {
    await requestFetch('/api/admin/dashboard/views', {
      method: 'POST',
      body: {
        commandId: crypto.randomUUID(),
        roleCode: selectedRole.value,
        viewType: 'orders',
        name: newViewName.value.trim(),
        scope: newViewScope.value,
        isDefault: newViewIsDefault.value,
        definition: {
          columns: currentConfig.value?.columnPreferences?.ordersTable ?? ['createdAt', 'customer', 'total']
        }
      }
    })
    showNewViewModal.value = false
    newViewName.value = ''
    await loadSavedViews()
  } catch (err: unknown) {
    errorMessage.value = extractErrorCode(err, 'Error al guardar la vista')
  }
}

async function deleteView(view: RoleSavedView) {
  try {
    await requestFetch(`/api/admin/dashboard/views/${view.id}?expectedVersion=${view.version}`, {
      method: 'DELETE'
    })
    if (activeViewId.value === view.id) {
      activeViewId.value = null
    }
    await loadSavedViews()
  } catch (err: unknown) {
    errorMessage.value = extractErrorCode(err, 'Error al eliminar la vista')
  }
}

async function onRoleChange() {
  await loadDashboardConfig()
  await loadSavedViews()
}

onMounted(() => {
  void loadDashboardConfig()
  void loadSavedViews()
})
</script>

<template>
  <div class="admin-role-dashboard p-4 space-y-6 max-w-7xl mx-auto" aria-label="Panel Configurable por Rol">
    <!-- Header -->
    <header class="flex flex-wrap items-center justify-between gap-4 border-b pb-4">
      <div>
        <h1 class="text-2xl font-bold text-gray-900">Panel Configurable por Rol</h1>
        <p class="text-sm text-gray-600">
          ADM-025: Widgets, columnas y vistas guardadas sin ocultar alertas obligatorias.
        </p>
      </div>

      <!-- Role Selector -->
      <div class="flex items-center gap-2">
        <label for="role-select" class="text-sm font-semibold text-gray-700">Rol Activo:</label>
        <select
          id="role-select"
          v-model="selectedRole"
          class="px-3 py-1.5 border rounded-lg text-sm bg-white font-medium"
          @change="onRoleChange"
        >
          <option v-for="r in SYSTEM_ROLE_CODES" :key="r" :value="r">
            {{ r.toUpperCase() }}
          </option>
        </select>
      </div>
    </header>

    <!-- MANDATORY ALERTS BANNER (Always Present & Visible) -->
    <section
      aria-label="Alertas obligatorias del sistema"
      class="p-4 bg-red-50 border-2 border-red-400 rounded-lg shadow-sm"
    >
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2">
          <span
            class="inline-flex items-center justify-center w-6 h-6 rounded-full bg-red-600 text-white font-bold text-xs"
            >!</span
          >
          <h2 class="text-base font-bold text-red-900">Canal de Alertas Obligatorias y Críticas</h2>
        </div>
        <span class="px-2.5 py-0.5 rounded text-xs font-bold bg-red-200 text-red-900 uppercase"
          >Obligatorio por Gobernanza</span
        >
      </div>
      <p class="text-xs text-red-800 mt-1">
        Las alertas operativas, incidentes químicos, rupturas de stock críticas y avisos de seguridad permanecen fijas e
        inmutables para todos los roles.
      </p>
    </section>

    <!-- Feedback messages -->
    <div v-if="errorMessage" role="alert" class="p-3 bg-red-100 border border-red-300 text-red-800 rounded text-sm">
      {{ errorMessage }}
    </div>
    <div
      v-if="successMessage"
      role="status"
      class="p-3 bg-green-100 border border-green-300 text-green-800 rounded text-sm"
    >
      {{ successMessage }}
    </div>

    <!-- Saved Views Section -->
    <section class="bg-gray-50 p-4 rounded-lg border space-y-3" aria-label="Vistas Guardadas">
      <div class="flex items-center justify-between">
        <h2 class="text-sm font-bold text-gray-800">Vistas Guardadas para Pedidos</h2>
        <button
          type="button"
          class="px-3 py-1 bg-blue-600 text-white rounded text-xs font-medium hover:bg-blue-700 transition"
          @click="showNewViewModal = true"
        >
          + Guardar Vista Actual
        </button>
      </div>

      <div class="flex flex-wrap gap-2 items-center">
        <button
          type="button"
          :class="[
            'px-3 py-1.5 rounded-full text-xs font-medium border transition',
            !activeViewId ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-700 hover:bg-gray-100'
          ]"
          @click="activeViewId = null"
        >
          Vista Predeterminada
        </button>

        <div
          v-for="v in savedViews"
          :key="v.id"
          class="inline-flex items-center rounded-full border bg-white pl-3 pr-1 py-0.5 text-xs font-medium"
          :class="activeViewId === v.id ? 'border-blue-500 ring-1 ring-blue-500' : 'border-gray-300'"
        >
          <button type="button" class="mr-1 text-gray-800" @click="activeViewId = v.id">
            {{ v.name }}
            <span v-if="v.isDefault" class="text-[10px] text-blue-600 font-bold ml-1">(Default)</span>
          </button>
          <button
            type="button"
            class="text-gray-400 hover:text-red-600 p-1"
            title="Archivar vista"
            @click="deleteView(v)"
          >
            ×
          </button>
        </div>
      </div>
    </section>

    <!-- Widgets Layout Configurator -->
    <section v-if="currentConfig" class="space-y-4" aria-label="Configuración de Widgets">
      <div class="flex items-center justify-between border-b pb-2">
        <h2 class="text-lg font-bold text-gray-900">Disposición de Widgets para el Rol ({{ selectedRole }})</h2>
        <button
          type="button"
          class="px-4 py-2 bg-green-600 hover:bg-green-700 text-white font-medium text-sm rounded shadow transition"
          :disabled="saving"
          @click="saveLayout"
        >
          {{ saving ? 'Guardando…' : 'Guardar Disposición' }}
        </button>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <div
          v-for="(w, idx) in currentConfig.widgets"
          :key="w.widgetId"
          class="p-4 rounded-lg border bg-white shadow-sm flex flex-col justify-between"
          :class="{
            'border-red-300 bg-red-50/20 ring-1 ring-red-300': isWidgetMandatory(w.widgetId),
            'opacity-60': !w.visible
          }"
        >
          <div>
            <div class="flex items-center justify-between">
              <span class="text-xs font-mono font-bold text-gray-500">#{{ w.order }}</span>
              <span
                v-if="isWidgetMandatory(w.widgetId)"
                class="px-2 py-0.5 rounded text-[10px] font-bold bg-red-100 text-red-800 uppercase"
              >
                Alerta Obligatoria
              </span>
            </div>

            <h3 class="font-bold text-gray-900 text-sm mt-1">{{ w.widgetId }}</h3>
            <p v-if="isWidgetMandatory(w.widgetId)" class="text-xs text-red-700 mt-1">
              Protección obligatoria: Este widget no se puede ocultar para garantizar la seguridad operativa.
            </p>
          </div>

          <div class="mt-4 pt-3 border-t flex items-center justify-between text-xs">
            <!-- Visibility checkbox -->
            <label class="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                :checked="w.visible"
                :disabled="isWidgetMandatory(w.widgetId)"
                class="rounded text-blue-600 disabled:opacity-50"
                @change="toggleWidget(w)"
              />
              <span :class="isWidgetMandatory(w.widgetId) ? 'font-bold text-red-800' : 'text-gray-700'">
                {{ isWidgetMandatory(w.widgetId) ? 'Siempre Visible (Bloqueado)' : w.visible ? 'Visible' : 'Oculto' }}
              </span>
            </label>

            <!-- Reorder buttons -->
            <div class="flex gap-1">
              <button
                type="button"
                class="p-1 border rounded hover:bg-gray-100 disabled:opacity-30"
                :disabled="idx === 0"
                @click="moveWidget(idx, 'up')"
              >
                ▲
              </button>
              <button
                type="button"
                class="p-1 border rounded hover:bg-gray-100 disabled:opacity-30"
                :disabled="idx === currentConfig.widgets.length - 1"
                @click="moveWidget(idx, 'down')"
              >
                ▼
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- Modal for new view -->
    <div v-if="showNewViewModal" class="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
      <div class="bg-white rounded-lg p-6 max-w-md w-full space-y-4">
        <h3 class="text-lg font-bold text-gray-900">Guardar Nueva Vista de Pedidos</h3>
        <div>
          <label class="block text-xs font-semibold text-gray-700 mb-1">Nombre de la Vista:</label>
          <input
            v-model="newViewName"
            type="text"
            class="w-full px-3 py-1.5 border rounded text-sm"
            placeholder="Ej: Pedidos Urgentes Químicos"
          />
        </div>
        <div class="flex items-center gap-4 text-xs">
          <label class="flex items-center gap-1">
            <input v-model="newViewScope" type="radio" value="role_shared" /> Compartida con el rol
          </label>
          <label class="flex items-center gap-1">
            <input v-model="newViewScope" type="radio" value="personal" /> Solo personal
          </label>
        </div>
        <div>
          <label class="flex items-center gap-1 text-xs">
            <input v-model="newViewIsDefault" type="checkbox" /> Establecer como vista predeterminada
          </label>
        </div>
        <div class="flex justify-end gap-2 pt-2">
          <button type="button" class="px-3 py-1.5 border rounded text-sm" @click="showNewViewModal = false">
            Cancelar
          </button>
          <button
            type="button"
            class="px-3 py-1.5 bg-blue-600 text-white rounded text-sm font-medium"
            @click="createView"
          >
            Guardar Vista
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
