<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { ConnectorMetricsSummary } from '~~/shared/connector-marketplace'

export interface CatalogConnector {
  id: string
  name: string
  category: string
  description: string
  version: string
  provider_type: string
  allowed_scopes: string[]
  config_schema_json: {
    endpointUrl?: string
    timeoutMs?: number
    declaredSecrets?: string[]
  }
  governance_status: 'draft' | 'in_review' | 'approved' | 'rejected' | 'deprecated'
  review_notes?: string
}

export interface InstalledConnector {
  id: string
  connector_id: string
  connector_name: string
  category: string
  provider_type: string
  display_name: string
  status: 'active' | 'paused' | 'uninstalled'
  granted_scopes: string[]
  config_json: Record<string, unknown>
  version: number
  secrets: Array<{
    secretKey: string
    maskedPreview: string
    version: number
  }>
  installed_at: string
  uninstalled_at?: string
}

const requestFetch = useRequestFetch()

const loading = ref(true)
const loadError = ref<string | null>(null)
const catalog = ref<CatalogConnector[]>([])
const installations = ref<InstalledConnector[]>([])

// View selection
const currentTab = ref<'catalog' | 'installations'>('catalog')
const searchQuery = ref('')
const categoryFilter = ref('all')

// Install dialog state
const selectedConnector = ref<CatalogConnector | null>(null)
const installDisplayName = ref('')
const installSelectedScopes = ref<string[]>([])
const installSecrets = ref<Record<string, string>>({})
const installSubmitting = ref(false)
const installError = ref<string | null>(null)

// Rotate secret dialog state
const rotatingInstallation = ref<InstalledConnector | null>(null)
const rotateSecretKey = ref('')
const rotateSecretValue = ref('')
const rotateSubmitting = ref(false)
const rotateError = ref<string | null>(null)

// Uninstall dialog state
const uninstallingInstallation = ref<InstalledConnector | null>(null)
const uninstallReason = ref('')
const uninstallSubmitting = ref(false)
const uninstallError = ref<string | null>(null)

// Metrics dialog state
const metricsInstallation = ref<InstalledConnector | null>(null)
const metricsLoading = ref(false)
const metricsSummary = ref<ConnectorMetricsSummary | null>(null)
const dispatchSubmitting = ref(false)
const dispatchFeedback = ref<string | null>(null)

function extractErrorCode(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'data' in err) {
    const data = (err as { data?: { error?: { code?: string } } }).data
    if (data?.error?.code) return data.error.code
  }
  return fallback
}

async function loadData() {
  loading.value = true
  loadError.value = null
  try {
    const [catRes, instRes] = await Promise.all([
      requestFetch<{ items: CatalogConnector[] }>('/api/admin/connectors/catalog'),
      requestFetch<{ items: InstalledConnector[] }>('/api/admin/connectors/installations')
    ])
    catalog.value = catRes.items ?? []
    installations.value = instRes.items ?? []
  } catch (err: unknown) {
    loadError.value = extractErrorCode(err, 'No se pudo conectar con el servicio de conectores.')
  } finally {
    loading.value = false
  }
}

onMounted(loadData)

const filteredCatalog = computed(() => {
  return catalog.value.filter((item) => {
    const matchCat = categoryFilter.value === 'all' || item.category === categoryFilter.value
    const matchQuery =
      searchQuery.value.trim() === '' ||
      item.name.toLowerCase().includes(searchQuery.value.toLowerCase()) ||
      item.description.toLowerCase().includes(searchQuery.value.toLowerCase())
    return matchCat && matchQuery
  })
})

const activeInstallations = computed(() => {
  return installations.value.filter((i) => i.status !== 'uninstalled')
})

const uninstalledHistory = computed(() => {
  return installations.value.filter((i) => i.status === 'uninstalled')
})

function openInstallModal(connector: CatalogConnector) {
  selectedConnector.value = connector
  installDisplayName.value = connector.name
  installSelectedScopes.value = [...connector.allowed_scopes]
  installSecrets.value = {}
  for (const s of connector.config_schema_json?.declaredSecrets ?? []) {
    installSecrets.value[s] = ''
  }
  installError.value = null
}

function closeInstallModal() {
  selectedConnector.value = null
  installError.value = null
}

async function submitInstall() {
  if (!selectedConnector.value) return
  if (installSelectedScopes.value.length === 0) {
    installError.value = 'Debe seleccionar al menos un scope gobernado.'
    return
  }

  installSubmitting.value = true
  installError.value = null
  try {
    await requestFetch('/api/admin/connectors/installations', {
      method: 'POST',
      headers: {
        'idempotency-key': crypto.randomUUID()
      },
      body: {
        connectorId: selectedConnector.value.id,
        displayName: installDisplayName.value.trim() || selectedConnector.value.name,
        grantedScopes: installSelectedScopes.value,
        config: {},
        secrets: installSecrets.value
      }
    })
    closeInstallModal()
    await loadData()
    currentTab.value = 'installations'
  } catch (err: unknown) {
    installError.value = extractErrorCode(err, 'Error al instalar conector')
  } finally {
    installSubmitting.value = false
  }
}

async function togglePause(inst: InstalledConnector) {
  actionError.value = null
  const nextAction = inst.status === 'active' ? 'pause' : 'resume'
  try {
    await requestFetch(`/api/admin/connectors/installations/${inst.id}/configure`, {
      method: 'POST',
      headers: {
        'idempotency-key': crypto.randomUUID()
      },
      body: {
        action: nextAction,
        expectedVersion: inst.version
      }
    })
    await loadData()
  } catch (err: unknown) {
    actionError.value = extractErrorCode(err, 'desconocido')
  }
}

function openRotateModal(inst: InstalledConnector) {
  rotatingInstallation.value = inst
  rotateSecretKey.value = inst.secrets[0]?.secretKey ?? 'api_key'
  rotateSecretValue.value = ''
  rotateError.value = null
}

function closeRotateModal() {
  rotatingInstallation.value = null
  rotateError.value = null
}

async function submitRotateSecret() {
  if (!rotatingInstallation.value) return
  if (!rotateSecretValue.value || rotateSecretValue.value.length < 8) {
    rotateError.value = 'El nuevo secreto debe tener al menos 8 caracteres.'
    return
  }
  rotateSubmitting.value = true
  rotateError.value = null
  try {
    await requestFetch(`/api/admin/connectors/installations/${rotatingInstallation.value.id}/secrets`, {
      method: 'POST',
      headers: {
        'idempotency-key': crypto.randomUUID()
      },
      body: {
        action: 'rotate_secret',
        secretKey: rotateSecretKey.value,
        secretValue: rotateSecretValue.value,
        expectedVersion: rotatingInstallation.value.version
      }
    })
    closeRotateModal()
    await loadData()
  } catch (err: unknown) {
    rotateError.value = extractErrorCode(err, 'Error al rotar secreto')
  } finally {
    rotateSubmitting.value = false
  }
}

function openUninstallModal(inst: InstalledConnector) {
  uninstallingInstallation.value = inst
  uninstallReason.value = ''
  uninstallError.value = null
}

function closeUninstallModal() {
  uninstallingInstallation.value = null
  uninstallError.value = null
}

async function submitUninstall() {
  if (!uninstallingInstallation.value) return
  uninstallSubmitting.value = true
  uninstallError.value = null
  try {
    await requestFetch(`/api/admin/connectors/installations/${uninstallingInstallation.value.id}/uninstall`, {
      method: 'POST',
      headers: {
        'idempotency-key': crypto.randomUUID()
      },
      body: {
        action: 'uninstall',
        expectedVersion: uninstallingInstallation.value.version,
        reason: uninstallReason.value.trim() || 'Desinstalación limpia manual'
      }
    })
    closeUninstallModal()
    await loadData()
  } catch (err: unknown) {
    uninstallError.value = extractErrorCode(err, 'Error en desinstalación')
  } finally {
    uninstallSubmitting.value = false
  }
}

async function openMetricsModal(inst: InstalledConnector) {
  metricsInstallation.value = inst
  metricsLoading.value = true
  metricsSummary.value = null
  dispatchFeedback.value = null
  try {
    const res = await requestFetch<{ summary: ConnectorMetricsSummary }>(
      `/api/admin/connectors/installations/${inst.id}/metrics`
    )
    metricsSummary.value = res.summary
  } catch (err: unknown) {
    dispatchFeedback.value = 'Error al cargar telemetría: ' + extractErrorCode(err, 'desconocido')
  } finally {
    metricsLoading.value = false
  }
}

function closeMetricsModal() {
  metricsInstallation.value = null
  metricsSummary.value = null
  dispatchFeedback.value = null
}

async function triggerTestDispatch() {
  if (!metricsInstallation.value) return
  dispatchSubmitting.value = true
  dispatchFeedback.value = null
  try {
    const reqScope = metricsInstallation.value.granted_scopes[0] ?? 'orders.read'
    const res = await requestFetch<{ status: string; latencyMs: number }>(
      `/api/admin/connectors/installations/${metricsInstallation.value.id}/dispatch`,
      {
        method: 'POST',
        body: {
          operation: 'test_health_sync',
          payload: { ping: true },
          requiredScope: reqScope
        }
      }
    )
    dispatchFeedback.value = `Despacho correcto (${res.latencyMs} ms)`
    // Recargar métricas
    const updated = await requestFetch<{ summary: ConnectorMetricsSummary }>(
      `/api/admin/connectors/installations/${metricsInstallation.value.id}/metrics`
    )
    metricsSummary.value = updated.summary
  } catch (err: unknown) {
    dispatchFeedback.value = 'Fallo de despacho: ' + extractErrorCode(err, 'error')
  } finally {
    dispatchSubmitting.value = false
  }
}

// ── Presentación: nombres legibles y estado de los paneles ────────────────
const actionError = ref<string | null>(null)
const tabs = computed(() => [
  { value: 'catalog', label: 'Disponibles', count: catalog.value.length },
  { value: 'installations', label: 'Instalados', count: activeInstallations.value.length }
])
const CATEGORIES: Record<string, string> = {
  erp: 'Facturación y gestión',
  carrier: 'Logística y transportistas',
  crm: 'Clientes',
  webhook: 'Avisos web',
  payment: 'Pasarelas de pago'
}
const categoryLabel = (code: string) => CATEGORIES[code] ?? adminHumanize(code)
const PROVIDERS: Record<string, string> = {
  internal_adapter: 'Integrado en la tienda',
  rest_sync: 'Sincronización con servicio externo',
  webhook: 'Aviso web',
  outbound_webhook: 'Aviso web saliente'
}
const providerLabel = (code: string) => PROVIDERS[code] ?? adminHumanize(code)
const GOVERNANCE: Record<string, [string, 'neutral' | 'success' | 'warning' | 'danger']> = {
  draft: ['Borrador', 'neutral'],
  in_review: ['En revisión', 'warning'],
  approved: ['Aprobado', 'success'],
  rejected: ['Rechazado', 'danger'],
  deprecated: ['Retirado', 'neutral']
}
const SCOPE_RESOURCES: Record<string, string> = {
  orders: 'pedidos',
  inventory: 'existencias',
  customers: 'clientes',
  products: 'productos',
  catalog: 'catálogo',
  shipments: 'envíos',
  payments: 'pagos',
  invoices: 'facturas'
}
const SCOPE_ACTIONS: Record<string, string> = {
  read: 'Consultar',
  read_masked: 'Consultar (datos personales ocultos)',
  write: 'Modificar',
  manage: 'Gestionar'
}
function scopeLabel(scope: string) {
  const [resource = '', action = ''] = scope.split('.')
  const verb = SCOPE_ACTIONS[action]
  const name = SCOPE_RESOURCES[resource]
  if (!verb || !name) return adminHumanize(scope.replace(/\./g, ' '))
  const [main, note] = verb.split(' (')
  return note ? `${main} ${name} (${note}` : `${main} ${name}`
}
const SECRETS: Record<string, string> = {
  api_key: 'Clave de acceso',
  client_secret: 'Clave secreta',
  client_id: 'Identificador de cliente',
  token: 'Clave de acceso',
  access_token: 'Clave de acceso',
  webhook_secret: 'Clave de firma de avisos',
  signing_secret: 'Clave de firma',
  password: 'Contraseña',
  username: 'Usuario'
}
const secretLabel = (key: string) => SECRETS[key] ?? adminHumanize(key)
/** Los fallos llegan a veces como código interno: se enseña siempre una frase legible. */
function readable(message: string | null, fallback: string) {
  if (!message) return ''
  return /^[A-Za-z0-9_.:-]+$/.test(message) ? fallback : message
}
function drawerModel(isOpen: () => boolean, close: () => void) {
  return computed({
    get: isOpen,
    set: (open: boolean) => {
      if (!open) close()
    }
  })
}
const installOpen = drawerModel(() => selectedConnector.value !== null, closeInstallModal)
const rotateOpen = drawerModel(() => rotatingInstallation.value !== null, closeRotateModal)
const uninstallOpen = drawerModel(() => uninstallingInstallation.value !== null, closeUninstallModal)
const metricsOpen = drawerModel(() => metricsInstallation.value !== null, closeMetricsModal)
function feedbackLabel(message: string) {
  if (message.startsWith('Despacho correcto')) return message.replace('Despacho correcto', 'El servicio responde')
  if (message.startsWith('Error al cargar')) return 'No se ha podido cargar la actividad de este conector.'
  return 'La prueba ha fallado: el servicio no ha respondido correctamente.'
}
</script>

<template>
  <div class="adm-stack">
    <div v-if="loading" role="status" class="adm-card">
      <div class="adm-table-skeleton" aria-busy="true">
        <span class="sr-only">Cargando conectores…</span>
        <div v-for="row in 4" :key="row"><i /><i /><i /></div>
      </div>
    </div>

    <div v-else-if="loadError" role="alert" class="adm-card">
      <AdminEmptyState
        variant="error"
        title="No se han podido cargar los conectores"
        :description="
          readable(loadError, 'El servicio de conectores no responde. Vuelve a intentarlo en unos minutos.')
        "
      >
        <button type="button" class="adm-btn adm-btn--secondary" @click="loadData">Reintentar</button>
      </AdminEmptyState>
    </div>

    <template v-else>
      <AdminTabs
        :model-value="currentTab"
        :tabs="tabs"
        label="Apartados de conectores"
        @update:model-value="currentTab = $event === 'installations' ? 'installations' : 'catalog'"
      />

      <UAlert
        v-if="actionError"
        role="alert"
        color="error"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        title="No se ha podido cambiar el estado del conector"
        :description="readable(actionError, 'Vuelve a intentarlo. Si el problema sigue, recarga la página.')"
        :close="true"
        @update:open="actionError = null"
      />

      <!-- Conectores disponibles -->
      <section v-if="currentTab === 'catalog'" aria-labelledby="catalog-heading" class="adm-stack">
        <h2 id="catalog-heading" class="sr-only">Conectores disponibles</h2>

        <div class="adm-toolbar" role="search">
          <label class="adm-toolbar__search" for="catalog-search">
            <span class="sr-only">Buscar conectores</span>
            <UIcon name="i-lucide-search" class="size-4" />
            <input
              id="catalog-search"
              v-model="searchQuery"
              type="search"
              placeholder="Buscar conector…"
              data-slot="adm-search"
            />
          </label>
          <label for="catalog-category" class="sr-only">Categoría</label>
          <select id="catalog-category" v-model="categoryFilter" class="adm-input">
            <option value="all">Todas las categorías</option>
            <option value="erp">Facturación y gestión</option>
            <option value="carrier">Logística y transportistas</option>
            <option value="crm">Clientes</option>
            <option value="webhook">Avisos web</option>
            <option value="payment">Pasarelas de pago</option>
          </select>
        </div>

        <div v-if="filteredCatalog.length === 0" role="status" class="adm-card">
          <AdminEmptyState
            :variant="searchQuery || categoryFilter !== 'all' ? 'filtered' : 'empty'"
            icon="i-lucide-plug"
            title="No hay conectores disponibles"
            description="Prueba con otra búsqueda o cambia de categoría."
          />
        </div>

        <div v-else class="adm-grid">
          <AdminCard v-for="connector in filteredCatalog" :key="connector.id" as="article">
            <template #title>{{ connector.name }}</template>
            <template #actions>
              <AdminBadge :tone="GOVERNANCE[connector.governance_status]?.[1] ?? 'neutral'">
                {{ GOVERNANCE[connector.governance_status]?.[0] ?? adminHumanize(connector.governance_status) }}
              </AdminBadge>
            </template>
            <p>{{ connector.description }}</p>
            <dl class="adm-help mt-3 space-y-1">
              <div>
                <dt class="inline font-semibold">Categoría:</dt>
                <dd class="inline">{{ categoryLabel(connector.category) }}</dd>
              </div>
              <div>
                <dt class="inline font-semibold">Tipo:</dt>
                <dd class="inline">{{ providerLabel(connector.provider_type) }} · versión {{ connector.version }}</dd>
              </div>
              <div>
                <dt class="inline font-semibold">Podrá:</dt>
                <dd class="inline">{{ connector.allowed_scopes.map(scopeLabel).join(', ') }}</dd>
              </div>
            </dl>
            <template #footer>
              <button
                v-if="connector.governance_status === 'approved'"
                type="button"
                class="adm-btn adm-btn--secondary adm-btn--sm"
                @click="openInstallModal(connector)"
              >
                Instalar conector
              </button>
              <span v-else class="adm-help">Pendiente de aprobación</span>
            </template>
          </AdminCard>
        </div>
      </section>

      <!-- Conectores instalados -->
      <section v-else aria-labelledby="installations-heading" class="adm-stack">
        <h2 id="installations-heading" class="sr-only">Conectores instalados</h2>

        <div v-if="activeInstallations.length === 0" role="status" class="adm-card">
          <AdminEmptyState
            icon="i-lucide-plug"
            title="Todavía no hay conectores instalados"
            description="Elige uno en «Disponibles» para conectarlo con la tienda."
          >
            <button type="button" class="adm-btn adm-btn--secondary" @click="currentTab = 'catalog'">
              Ver conectores disponibles
            </button>
          </AdminEmptyState>
        </div>

        <template v-else>
          <AdminCard v-for="inst in activeInstallations" :key="inst.id" as="article">
            <template #title>{{ inst.display_name }}</template>
            <template #actions>
              <AdminBadge :tone="inst.status === 'active' ? 'success' : 'warning'">
                {{ inst.status === 'active' ? 'Activo' : 'En pausa' }}
              </AdminBadge>
              <button type="button" class="adm-btn adm-btn--secondary adm-btn--sm" @click="togglePause(inst)">
                {{ inst.status === 'active' ? 'Pausar' : 'Reanudar' }}
              </button>
            </template>
            <p class="adm-help">
              {{ inst.connector_name }} · {{ categoryLabel(inst.category) }} · instalado el
              {{ adminDate(inst.installed_at) }}
            </p>
            <div class="mt-3 grid gap-4 sm:grid-cols-2">
              <div>
                <p class="adm-label">Permisos concedidos</p>
                <div class="mt-1 flex flex-wrap gap-1.5">
                  <AdminBadge v-for="sc in inst.granted_scopes" :key="sc" plain>{{ scopeLabel(sc) }}</AdminBadge>
                </div>
              </div>
              <div>
                <p class="adm-label">Claves guardadas</p>
                <ul v-if="inst.secrets.length > 0" class="mt-1 space-y-1">
                  <li v-for="sec in inst.secrets" :key="sec.secretKey" class="flex flex-wrap items-center gap-2">
                    <span>{{ secretLabel(sec.secretKey) }}</span>
                    <code class="text-xs">{{ sec.maskedPreview }}</code>
                    <span v-if="sec.version > 1" class="adm-help">renovada {{ sec.version - 1 }} veces</span>
                  </li>
                </ul>
                <p v-else class="adm-help mt-1">Sin claves guardadas.</p>
              </div>
            </div>
            <template #footer>
              <button type="button" class="adm-btn adm-btn--secondary adm-btn--sm" @click="openMetricsModal(inst)">
                Ver actividad
              </button>
              <button type="button" class="adm-btn adm-btn--secondary adm-btn--sm" @click="openRotateModal(inst)">
                Cambiar clave
              </button>
              <button
                type="button"
                class="adm-btn adm-btn--danger-soft adm-btn--sm ml-auto"
                @click="openUninstallModal(inst)"
              >
                Desinstalar
              </button>
            </template>
          </AdminCard>
        </template>

        <AdminCard v-if="uninstalledHistory.length > 0" title="Conectores desinstalados" flush>
          <ul class="adm-list">
            <li v-for="uninst in uninstalledHistory" :key="uninst.id">
              <div class="min-w-0 flex-1">
                <p class="adm-list__title">{{ uninst.display_name }}</p>
                <p class="adm-help">{{ uninst.connector_name }}</p>
              </div>
              <span class="adm-help">Desinstalado el {{ adminDate(uninst.uninstalled_at) }}</span>
            </li>
          </ul>
        </AdminCard>
      </section>
    </template>

    <!-- Instalar -->
    <AdminDrawer
      v-model:open="installOpen"
      :title="`Instalar ${selectedConnector?.name ?? ''}`"
      description="Elige qué podrá hacer este conector en la tienda y escribe sus claves de acceso."
    >
      <div v-if="selectedConnector" class="adm-stack">
        <UAlert
          v-if="installError"
          role="alert"
          color="error"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          :title="
            readable(installError, 'No se ha podido instalar el conector. Revisa los datos y vuelve a intentarlo.')
          "
        />
        <div class="adm-field">
          <label for="inst-name" class="adm-label">Nombre para identificarlo</label>
          <input id="inst-name" v-model="installDisplayName" type="text" class="adm-input" />
        </div>
        <fieldset class="adm-field">
          <legend class="adm-label">Permisos que se le conceden</legend>
          <label v-for="sc in selectedConnector.allowed_scopes" :key="sc" class="adm-check">
            <input v-model="installSelectedScopes" type="checkbox" :value="sc" />
            {{ scopeLabel(sc) }}
          </label>
        </fieldset>
        <template v-if="(selectedConnector.config_schema_json?.declaredSecrets?.length ?? 0) > 0">
          <div v-for="secKey in selectedConnector.config_schema_json.declaredSecrets" :key="secKey" class="adm-field">
            <label :for="'sec-' + secKey" class="adm-label">{{ secretLabel(secKey) }}</label>
            <input :id="'sec-' + secKey" v-model="installSecrets[secKey]" type="password" class="adm-input" />
            <p class="adm-help">Mínimo 8 caracteres. Se guarda cifrada y no vuelve a mostrarse.</p>
          </div>
        </template>
      </div>
      <template #footer>
        <button type="button" class="adm-btn adm-btn--secondary" @click="closeInstallModal">Cancelar</button>
        <button type="button" class="adm-btn adm-btn--primary" :disabled="installSubmitting" @click="submitInstall">
          {{ installSubmitting ? 'Instalando…' : 'Instalar' }}
        </button>
      </template>
    </AdminDrawer>

    <!-- Cambiar clave -->
    <AdminDrawer
      v-model:open="rotateOpen"
      :title="`Cambiar clave de ${rotatingInstallation?.display_name ?? ''}`"
      description="La clave anterior deja de usarse en cuanto guardes. El cambio queda anotado en el registro de actividad."
    >
      <div v-if="rotatingInstallation" class="adm-stack">
        <UAlert
          v-if="rotateError"
          role="alert"
          color="error"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          :title="readable(rotateError, 'No se ha podido cambiar la clave. Vuelve a intentarlo.')"
        />
        <div class="adm-field">
          <label for="rot-key" class="adm-label">Clave que se cambia</label>
          <select
            v-if="rotatingInstallation.secrets.length > 0"
            id="rot-key"
            v-model="rotateSecretKey"
            class="adm-input"
          >
            <option v-for="sec in rotatingInstallation.secrets" :key="sec.secretKey" :value="sec.secretKey">
              {{ secretLabel(sec.secretKey) }}
            </option>
          </select>
          <input v-else id="rot-key" v-model="rotateSecretKey" type="text" class="adm-input" />
        </div>
        <div class="adm-field">
          <label for="rot-val" class="adm-label">Nuevo valor</label>
          <input id="rot-val" v-model="rotateSecretValue" type="password" class="adm-input" />
          <p class="adm-help">Mínimo 8 caracteres.</p>
        </div>
      </div>
      <template #footer>
        <button type="button" class="adm-btn adm-btn--secondary" @click="closeRotateModal">Cancelar</button>
        <button type="button" class="adm-btn adm-btn--primary" :disabled="rotateSubmitting" @click="submitRotateSecret">
          {{ rotateSubmitting ? 'Guardando…' : 'Guardar clave nueva' }}
        </button>
      </template>
    </AdminDrawer>

    <!-- Desinstalar -->
    <AdminConfirm
      v-model:open="uninstallOpen"
      :title="`Desinstalar ${uninstallingInstallation?.display_name ?? ''}`"
      description="Se borrarán todas las claves guardadas de este conector y se le retirarán sus permisos. No se puede deshacer."
      confirm-label="Desinstalar y borrar claves"
      danger
      :loading="uninstallSubmitting"
      @confirm="submitUninstall"
    >
      <div class="adm-stack">
        <UAlert
          v-if="uninstallError"
          role="alert"
          color="error"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          :title="readable(uninstallError, 'No se ha podido desinstalar. Vuelve a intentarlo.')"
        />
        <div class="adm-field">
          <label for="uninst-reason" class="adm-label">Motivo (opcional)</label>
          <input
            id="uninst-reason"
            v-model="uninstallReason"
            type="text"
            class="adm-input"
            placeholder="Por ejemplo: cambio de proveedor"
          />
        </div>
      </div>
    </AdminConfirm>

    <!-- Actividad -->
    <AdminDrawer v-model:open="metricsOpen" :title="`Actividad de ${metricsInstallation?.display_name ?? ''}`" wide>
      <div v-if="metricsInstallation" class="adm-stack">
        <p v-if="metricsLoading" role="status" class="adm-help">Cargando actividad del conector…</p>

        <template v-else-if="metricsSummary">
          <div class="grid grid-cols-2 gap-3">
            <AdminStat label="Usos" :value="metricsSummary.totalInvocations" />
            <AdminStat label="Correctos" :value="metricsSummary.successCount" />
            <AdminStat label="Fallos" :value="`${(metricsSummary.errorRate * 100).toFixed(1)} %`" />
            <AdminStat
              label="Tiempo de respuesta"
              :value="`${metricsSummary.p95LatencyMs} ms`"
              hint="En 95 de cada 100 usos"
            />
          </div>
          <dl class="adm-help space-y-1">
            <div>
              <dt class="inline font-semibold">Último uso:</dt>
              <dd class="inline">
                {{ metricsSummary.lastInvokedAt ? adminDate(metricsSummary.lastInvokedAt, true) : 'Nunca' }}
              </dd>
            </div>
            <div>
              <dt class="inline font-semibold">Último uso correcto:</dt>
              <dd class="inline">
                {{ metricsSummary.lastSuccessAt ? adminDate(metricsSummary.lastSuccessAt, true) : 'Ninguno' }}
              </dd>
            </div>
            <div v-if="metricsSummary.lastErrorAt">
              <dt class="inline font-semibold">Último fallo:</dt>
              <dd class="inline">{{ adminDate(metricsSummary.lastErrorAt, true) }}</dd>
            </div>
          </dl>
          <AdminCard title="Comprobar conexión" description="Envía una prueba al servicio para confirmar que responde.">
            <button
              type="button"
              class="adm-btn adm-btn--secondary"
              :disabled="dispatchSubmitting || metricsInstallation.status !== 'active'"
              @click="triggerTestDispatch"
            >
              {{ dispatchSubmitting ? 'Probando…' : 'Enviar prueba' }}
            </button>
            <p v-if="metricsInstallation.status !== 'active'" class="adm-help mt-2">
              Reanuda el conector para poder probarlo.
            </p>
          </AdminCard>
        </template>

        <UAlert
          v-if="dispatchFeedback"
          role="status"
          :color="dispatchFeedback.startsWith('Despacho correcto') ? 'success' : 'error'"
          variant="subtle"
          :icon="dispatchFeedback.startsWith('Despacho correcto') ? 'i-lucide-circle-check' : 'i-lucide-triangle-alert'"
          :title="feedbackLabel(dispatchFeedback)"
        />
      </div>
      <template #footer>
        <button type="button" class="adm-btn adm-btn--secondary" @click="closeMetricsModal">Cerrar</button>
      </template>
    </AdminDrawer>
  </div>
</template>
