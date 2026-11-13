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
const WIDGETS: Record<string, [string, string]> = {
  mandatory_alerts: ['Avisos obligatorios', 'Avisos de seguridad que todo el equipo debe ver.'],
  operational_critical_alerts: ['Incidencias críticas', 'Roturas de stock, incidentes químicos y bloqueos.'],
  orders_summary: ['Resumen de pedidos', 'Pedidos del día por estado.'],
  orders_recent_table: ['Últimos pedidos', 'Tabla con los pedidos más recientes.'],
  shipping_exceptions: ['Incidencias de envío', 'Envíos retrasados o con problemas.'],
  inventory_low_stock: ['Stock bajo', 'Productos por debajo de su mínimo.'],
  sales_summary: ['Resumen de ventas', 'Ventas del periodo y comparación.'],
  support_queue: ['Consultas pendientes', 'Consultas de clientes por responder.'],
  returns_pending: ['Devoluciones pendientes', 'Devoluciones por recibir o resolver.'],
  campaigns_active: ['Campañas activas', 'Campañas en curso y su resultado.'],
  catalog_quality: ['Calidad del catálogo', 'Fichas incompletas o por revisar.'],
  finance_summary: ['Cobros y facturación', 'Cobros pendientes y facturas emitidas.']
}
const widgetName = (id: string) => WIDGETS[id]?.[0] ?? adminHumanize(id)
const widgetHint = (id: string) => WIDGETS[id]?.[1] ?? ''
const ROLE_NAMES: Record<string, string> = {
  content_manager: 'Gestor de contenidos',
  finance_analyst: 'Analista financiero'
}
const roleName = (code: string) => ROLE_NAMES[code] ?? adminRoleLabel(code)
const viewToDelete = ref<RoleSavedView | null>(null)
const confirmDelete = computed({
  get: () => viewToDelete.value !== null,
  set: (open: boolean) => {
    if (!open) viewToDelete.value = null
  }
})
async function confirmDeleteView() {
  const view = viewToDelete.value
  viewToDelete.value = null
  if (view) await deleteView(view)
}
const newViewName = ref('')
const newViewScope = ref<'role_shared' | 'personal'>('role_shared')
const newViewIsDefault = ref(false)

function extractErrorCode(err: unknown, fallback: string): string {
  const code = (err as { data?: { error?: { code?: string } } })?.data?.error?.code
  return code ? `${fallback}. Vuelve a intentarlo.` : fallback
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
  <div class="adm-stack">
    <AdminPageActions>
      <label for="role-select" class="adm-label">Perfil</label>
      <select id="role-select" v-model="selectedRole" class="adm-input" @change="onRoleChange">
        <option v-for="r in SYSTEM_ROLE_CODES" :key="r" :value="r">{{ roleName(r) }}</option>
      </select>
      <AdminButton variant="primary" :loading="saving" :disabled="!currentConfig" @click="saveLayout">
        Guardar cambios
      </AdminButton>
    </AdminPageActions>

    <UAlert
      v-if="errorMessage"
      role="alert"
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="errorMessage"
    />
    <UAlert
      v-if="successMessage"
      role="status"
      color="success"
      variant="subtle"
      icon="i-lucide-circle-check"
      :title="successMessage"
    />

    <AdminCard
      title="Bloques del panel"
      :description="`Lo que ve el perfil «${roleName(selectedRole)}» al entrar, en este orden.`"
      flush
    >
      <div v-if="loading && !currentConfig" class="adm-table-skeleton" aria-busy="true">
        <div v-for="row in 4" :key="row"><i /><i /><i /></div>
      </div>
      <AdminEmptyState
        v-else-if="!currentConfig"
        variant="error"
        title="No se ha podido cargar el panel de este perfil"
      >
        <AdminButton icon="i-lucide-rotate-cw" @click="loadDashboardConfig">Reintentar</AdminButton>
      </AdminEmptyState>
      <ul v-else class="adm-list">
        <li v-for="(w, idx) in currentConfig.widgets" :key="w.widgetId" :class="!w.visible && 'opacity-60'">
          <span class="adm-list__index">{{ idx + 1 }}</span>
          <div class="min-w-0 flex-1">
            <p class="adm-list__title">
              {{ widgetName(w.widgetId) }}
              <AdminBadge v-if="isWidgetMandatory(w.widgetId)" tone="warning" plain>Siempre visible</AdminBadge>
            </p>
            <p v-if="widgetHint(w.widgetId)" class="adm-help">{{ widgetHint(w.widgetId) }}</p>
          </div>
          <label class="adm-check">
            <input
              type="checkbox"
              :checked="w.visible"
              :disabled="isWidgetMandatory(w.widgetId)"
              @change="toggleWidget(w)"
            />
            Visible
          </label>
          <AdminButton
            size="sm"
            icon="i-lucide-arrow-up"
            label="Subir"
            :disabled="idx === 0"
            @click="moveWidget(idx, 'up')"
          />
          <AdminButton
            size="sm"
            icon="i-lucide-arrow-down"
            label="Bajar"
            :disabled="idx === currentConfig.widgets.length - 1"
            @click="moveWidget(idx, 'down')"
          />
        </li>
      </ul>
      <template #footer>
        <span class="adm-help mr-auto">
          Los avisos de seguridad y las incidencias críticas no se pueden ocultar a ningún perfil.
        </span>
      </template>
    </AdminCard>

    <AdminCard title="Vistas guardadas de pedidos" description="Filtros y columnas que este perfil puede reutilizar.">
      <template #actions>
        <AdminButton size="sm" icon="i-lucide-plus" @click="showNewViewModal = true">Guardar vista actual</AdminButton>
      </template>
      <div class="flex flex-wrap items-center gap-2">
        <button type="button" class="adm-chip" :aria-pressed="!activeViewId" @click="activeViewId = null">
          Vista predeterminada
        </button>
        <span v-for="v in savedViews" :key="v.id" class="adm-chip" :data-active="activeViewId === v.id || undefined">
          <button type="button" :aria-pressed="activeViewId === v.id" @click="activeViewId = v.id">
            {{ v.name }}<template v-if="v.isDefault"> · por defecto</template>
          </button>
          <button type="button" :aria-label="`Archivar la vista ${v.name}`" @click="viewToDelete = v">
            <UIcon name="i-lucide-x" class="size-3.5" />
          </button>
        </span>
      </div>
    </AdminCard>

    <AdminDrawer v-model:open="showNewViewModal" title="Guardar vista de pedidos">
      <div class="adm-stack">
        <AdminFormField v-slot="{ id }" label="Nombre de la vista" required>
          <input :id="id" v-model="newViewName" type="text" placeholder="Por ejemplo: pedidos urgentes" />
        </AdminFormField>
        <fieldset class="adm-field">
          <legend class="adm-label">Quién puede usarla</legend>
          <label class="adm-check"
            ><input v-model="newViewScope" type="radio" value="role_shared" /> Todo el perfil</label
          >
          <label class="adm-check"><input v-model="newViewScope" type="radio" value="personal" /> Solo yo</label>
        </fieldset>
        <label class="adm-check">
          <input v-model="newViewIsDefault" type="checkbox" /> Usar como vista predeterminada
        </label>
      </div>
      <template #footer>
        <AdminButton @click="showNewViewModal = false">Cancelar</AdminButton>
        <AdminButton variant="primary" :disabled="!newViewName.trim()" @click="createView">Guardar vista</AdminButton>
      </template>
    </AdminDrawer>

    <AdminConfirm
      v-model:open="confirmDelete"
      title="Archivar vista"
      :description="`La vista «${viewToDelete?.name ?? ''}» dejará de estar disponible para este perfil.`"
      confirm-label="Archivar"
      danger
      @confirm="confirmDeleteView"
    />
  </div>
</template>
