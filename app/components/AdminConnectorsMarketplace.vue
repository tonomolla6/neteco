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
    alert('Error al cambiar estado: ' + extractErrorCode(err, 'desconocido'))
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
</script>

<template>
  <div class="space-y-6">
    <header class="border-b pb-4">
      <h1 class="text-2xl font-bold tracking-tight text-neutral-900">Marketplace Interno de Conectores</h1>
      <p class="mt-1 text-sm text-neutral-600">
        Ecosistema gobernado de integraciones oficiales (ERP, operadores logísticos, CRM, pasarelas y webhooks). Sin
        plugins arbitrarios, con auditoría y rotación estricta de credenciales.
      </p>
    </header>

    <!-- Estado de Carga -->
    <div v-if="loading" role="status" class="py-12 text-center text-neutral-600">
      <p class="text-base font-medium">Cargando marketplace de conectores…</p>
    </div>

    <!-- Estado de Error -->
    <div
      v-else-if="loadError"
      role="alert"
      class="rounded-lg border border-red-200 bg-red-50 p-6 text-center text-red-700"
    >
      <p class="font-semibold">Error al cargar conectores</p>
      <p class="mt-1 text-sm">{{ loadError }}</p>
      <button
        type="button"
        class="mt-4 inline-flex items-center rounded-md bg-red-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-500"
        @click="loadData"
      >
        Reintentar
      </button>
    </div>

    <!-- Contenido Principal -->
    <div v-else class="space-y-6">
      <!-- Selector de pestañas -->
      <nav class="flex space-x-4 border-b border-neutral-200 pb-2" aria-label="Secciones del marketplace">
        <button
          type="button"
          :class="[
            currentTab === 'catalog'
              ? 'border-indigo-600 text-indigo-600 font-semibold'
              : 'border-transparent text-neutral-500 hover:text-neutral-700',
            'border-b-2 px-3 py-2 text-sm'
          ]"
          @click="currentTab = 'catalog'"
        >
          Catálogo Gobernado ({{ catalog.length }})
        </button>
        <button
          type="button"
          :class="[
            currentTab === 'installations'
              ? 'border-indigo-600 text-indigo-600 font-semibold'
              : 'border-transparent text-neutral-500 hover:text-neutral-700',
            'border-b-2 px-3 py-2 text-sm'
          ]"
          @click="currentTab = 'installations'"
        >
          Conectores Instalados ({{ activeInstallations.length }})
        </button>
      </nav>

      <!-- Pestaña 1: Catálogo -->
      <section v-if="currentTab === 'catalog'" aria-labelledby="catalog-heading" class="space-y-4">
        <h2 id="catalog-heading" class="sr-only">Catálogo de conectores certificados</h2>

        <!-- Filtros y búsqueda -->
        <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div class="flex-1 max-w-sm">
            <label for="catalog-search" class="sr-only">Buscar conectores</label>
            <input
              id="catalog-search"
              v-model="searchQuery"
              type="search"
              placeholder="Buscar por conector o descripción…"
              class="w-full rounded-md border border-neutral-300 px-3 py-1.5 text-sm shadow-sm"
            />
          </div>
          <div>
            <label for="catalog-category" class="mr-2 text-sm text-neutral-600">Categoría:</label>
            <select
              id="catalog-category"
              v-model="categoryFilter"
              class="rounded-md border border-neutral-300 px-3 py-1.5 text-sm shadow-sm"
            >
              <option value="all">Todas las categorías</option>
              <option value="erp">ERP & Facturación</option>
              <option value="carrier">Logística & Transportistas</option>
              <option value="crm">CRM & Clientes</option>
              <option value="webhook">Webhooks</option>
              <option value="payment">Pasarelas de Pago</option>
            </select>
          </div>
        </div>

        <!-- Lista vacía de búsqueda -->
        <div v-if="filteredCatalog.length === 0" role="status" class="py-8 text-center text-neutral-500">
          <p>No hay conectores disponibles para esta búsqueda o filtro.</p>
        </div>

        <!-- Rejilla de conectores del catálogo -->
        <div v-else class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <article
            v-for="connector in filteredCatalog"
            :key="connector.id"
            class="flex flex-col justify-between rounded-lg border border-neutral-200 bg-white p-5 shadow-sm"
          >
            <div>
              <div class="flex items-center justify-between gap-2">
                <span
                  class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium uppercase"
                  :class="[
                    connector.governance_status === 'approved'
                      ? 'bg-green-100 text-green-800'
                      : connector.governance_status === 'in_review'
                        ? 'bg-yellow-100 text-yellow-800'
                        : 'bg-neutral-100 text-neutral-800'
                  ]"
                >
                  {{ connector.governance_status }}
                </span>
                <span class="text-xs text-neutral-500">v{{ connector.version }}</span>
              </div>
              <h3 class="mt-2 text-base font-semibold text-neutral-900">{{ connector.name }}</h3>
              <p class="mt-1 text-sm text-neutral-600">{{ connector.description }}</p>

              <div class="mt-3 text-xs text-neutral-500 space-y-1">
                <p><strong>Tipo:</strong> {{ connector.provider_type }}</p>
                <p><strong>Scopes:</strong> {{ connector.allowed_scopes.join(', ') }}</p>
              </div>
            </div>

            <div class="mt-4 border-t pt-3 flex justify-end">
              <button
                v-if="connector.governance_status === 'approved'"
                type="button"
                class="rounded bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500"
                @click="openInstallModal(connector)"
              >
                Instalar Conector
              </button>
              <span v-else class="text-xs text-neutral-400 italic">Pendiente de aprobación</span>
            </div>
          </article>
        </div>
      </section>

      <!-- Pestaña 2: Instalaciones -->
      <section v-else aria-labelledby="installations-heading" class="space-y-6">
        <h2 id="installations-heading" class="sr-only">Conectores instalados y gobernanza de secretos</h2>

        <div v-if="activeInstallations.length === 0" role="status" class="py-8 text-center text-neutral-500">
          <p>No hay conectores activos instalados actualmente.</p>
        </div>

        <div v-else class="space-y-4">
          <article
            v-for="inst in activeInstallations"
            :key="inst.id"
            class="rounded-lg border border-neutral-200 bg-white p-5 shadow-sm"
          >
            <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b pb-3">
              <div>
                <h3 class="text-lg font-semibold text-neutral-900">{{ inst.display_name }}</h3>
                <p class="text-xs text-neutral-500">
                  ID: {{ inst.id }} · Conector: {{ inst.connector_name }} (v{{ inst.version }})
                </p>
              </div>
              <div class="flex items-center gap-2">
                <span
                  class="rounded-full px-2.5 py-0.5 text-xs font-medium"
                  :class="[inst.status === 'active' ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-800']"
                >
                  {{ inst.status === 'active' ? 'Activo' : 'Pausado' }}
                </span>
                <button
                  type="button"
                  class="rounded border border-neutral-300 px-2 py-1 text-xs font-medium hover:bg-neutral-50"
                  @click="togglePause(inst)"
                >
                  {{ inst.status === 'active' ? 'Pausar' : 'Reanudar' }}
                </button>
              </div>
            </div>

            <!-- Scopes concedidos -->
            <div class="mt-3">
              <span class="text-xs font-semibold text-neutral-700">Scopes otorgados:</span>
              <div class="mt-1 flex flex-wrap gap-1">
                <span
                  v-for="sc in inst.granted_scopes"
                  :key="sc"
                  class="rounded bg-neutral-100 px-2 py-0.5 text-xs text-neutral-700 font-mono"
                >
                  {{ sc }}
                </span>
              </div>
            </div>

            <!-- Secretos gobernados (enmascarados) -->
            <div class="mt-3">
              <span class="text-xs font-semibold text-neutral-700">Secretos gobernados:</span>
              <ul v-if="inst.secrets.length > 0" class="mt-1 space-y-1">
                <li
                  v-for="sec in inst.secrets"
                  :key="sec.secretKey"
                  class="flex items-center justify-between text-xs text-neutral-600 bg-neutral-50 rounded px-2 py-1"
                >
                  <span class="font-mono font-medium">{{ sec.secretKey }}:</span>
                  <span class="font-mono text-neutral-800">{{ sec.maskedPreview }}</span>
                  <span class="text-neutral-400">v{{ sec.version }}</span>
                </li>
              </ul>
              <p v-else class="text-xs text-neutral-400 italic mt-1">Sin secretos configurados.</p>
            </div>

            <!-- Acciones -->
            <div class="mt-4 flex flex-wrap items-center justify-between gap-2 border-t pt-3">
              <div class="flex gap-2">
                <button
                  type="button"
                  class="rounded bg-indigo-50 px-3 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-100"
                  @click="openMetricsModal(inst)"
                >
                  Telemetría & Métricas
                </button>
                <button
                  type="button"
                  class="rounded border border-neutral-300 px-3 py-1.5 text-xs font-medium hover:bg-neutral-50"
                  @click="openRotateModal(inst)"
                >
                  Rotar Secreto
                </button>
              </div>
              <div>
                <button
                  type="button"
                  class="rounded border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100"
                  @click="openUninstallModal(inst)"
                >
                  Desinstalación Limpia
                </button>
              </div>
            </div>
          </article>
        </div>

        <!-- Historial de desinstalaciones -->
        <div v-if="uninstalledHistory.length > 0" class="mt-8 border-t pt-4">
          <h3 class="text-sm font-semibold text-neutral-700">Histórico de Conectores Desinstalados</h3>
          <ul class="mt-2 divide-y divide-neutral-200 rounded border border-neutral-200 bg-neutral-50">
            <li
              v-for="uninst in uninstalledHistory"
              :key="uninst.id"
              class="p-3 text-xs text-neutral-600 flex justify-between items-center"
            >
              <span>{{ uninst.display_name }} ({{ uninst.connector_name }})</span>
              <span class="text-neutral-400">Desinstalado limpiamente el {{ uninst.uninstalled_at }}</span>
            </li>
          </ul>
        </div>
      </section>
    </div>

    <!-- Modal de Instalación -->
    <div
      v-if="selectedConnector"
      role="dialog"
      aria-labelledby="install-modal-title"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    >
      <div class="w-full max-w-lg rounded-lg bg-white p-6 shadow-xl space-y-4">
        <h3 id="install-modal-title" class="text-lg font-bold text-neutral-900">
          Instalar {{ selectedConnector.name }}
        </h3>
        <p class="text-xs text-neutral-500">
          Seleccione los scopes de permisos que se concederán a este conector. No se permite la ejecución de plugins
          arbitrarios.
        </p>

        <div v-if="installError" role="alert" class="rounded bg-red-50 p-2 text-xs text-red-700">
          {{ installError }}
        </div>

        <div class="space-y-3">
          <div>
            <label for="inst-name" class="block text-xs font-medium text-neutral-700">Nombre de la instancia</label>
            <input
              id="inst-name"
              v-model="installDisplayName"
              type="text"
              class="mt-1 w-full rounded border border-neutral-300 p-2 text-sm"
            />
          </div>

          <div>
            <span class="block text-xs font-medium text-neutral-700">Scopes gobernados a conceder:</span>
            <div class="mt-1 space-y-1">
              <label
                v-for="sc in selectedConnector.allowed_scopes"
                :key="sc"
                class="flex items-center gap-2 text-xs text-neutral-700"
              >
                <input v-model="installSelectedScopes" type="checkbox" :value="sc" class="rounded" />
                <span class="font-mono">{{ sc }}</span>
              </label>
            </div>
          </div>

          <div v-if="(selectedConnector.config_schema_json?.declaredSecrets?.length ?? 0) > 0">
            <span class="block text-xs font-medium text-neutral-700">Credenciales requeridas:</span>
            <div v-for="secKey in selectedConnector.config_schema_json.declaredSecrets" :key="secKey" class="mt-1">
              <label :for="'sec-' + secKey" class="block text-xs text-neutral-600 font-mono">{{ secKey }}:</label>
              <input
                :id="'sec-' + secKey"
                v-model="installSecrets[secKey]"
                type="password"
                placeholder="Introduzca clave o token (mínimo 8 caracteres)"
                class="mt-0.5 w-full rounded border border-neutral-300 p-1.5 text-sm font-mono"
              />
            </div>
          </div>
        </div>

        <div class="flex justify-end gap-2 border-t pt-3">
          <button
            type="button"
            class="rounded border border-neutral-300 px-3 py-1.5 text-xs font-medium"
            @click="closeInstallModal"
          >
            Cancelar
          </button>
          <button
            type="button"
            :disabled="installSubmitting"
            class="rounded bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
            @click="submitInstall"
          >
            {{ installSubmitting ? 'Instalando…' : 'Confirmar Instalación' }}
          </button>
        </div>
      </div>
    </div>

    <!-- Modal de Rotación de Secreto -->
    <div
      v-if="rotatingInstallation"
      role="dialog"
      aria-labelledby="rotate-modal-title"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    >
      <div class="w-full max-w-md rounded-lg bg-white p-6 shadow-xl space-y-4">
        <h3 id="rotate-modal-title" class="text-lg font-bold text-neutral-900">
          Rotar Secreto para {{ rotatingInstallation.display_name }}
        </h3>
        <p class="text-xs text-neutral-500">
          La rotación actualizará la versión de la credencial con verificación CAS y registrará una entrada en la
          auditoría inmutable.
        </p>

        <div v-if="rotateError" role="alert" class="rounded bg-red-50 p-2 text-xs text-red-700">
          {{ rotateError }}
        </div>

        <div class="space-y-3">
          <div>
            <label for="rot-key" class="block text-xs font-medium text-neutral-700">Clave del secreto:</label>
            <input
              id="rot-key"
              v-model="rotateSecretKey"
              type="text"
              class="mt-1 w-full rounded border border-neutral-300 p-2 text-sm font-mono"
            />
          </div>
          <div>
            <label for="rot-val" class="block text-xs font-medium text-neutral-700">Nuevo valor del secreto:</label>
            <input
              id="rot-val"
              v-model="rotateSecretValue"
              type="password"
              placeholder="Mínimo 8 caracteres"
              class="mt-1 w-full rounded border border-neutral-300 p-2 text-sm font-mono"
            />
          </div>
        </div>

        <div class="flex justify-end gap-2 border-t pt-3">
          <button
            type="button"
            class="rounded border border-neutral-300 px-3 py-1.5 text-xs font-medium"
            @click="closeRotateModal"
          >
            Cancelar
          </button>
          <button
            type="button"
            :disabled="rotateSubmitting"
            class="rounded bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
            @click="submitRotateSecret"
          >
            {{ rotateSubmitting ? 'Rotando…' : 'Rotar Credencial' }}
          </button>
        </div>
      </div>
    </div>

    <!-- Modal de Desinstalación Limpia -->
    <div
      v-if="uninstallingInstallation"
      role="dialog"
      aria-labelledby="uninstall-modal-title"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    >
      <div class="w-full max-w-md rounded-lg bg-white p-6 shadow-xl space-y-4">
        <h3 id="uninstall-modal-title" class="text-lg font-bold text-red-700">
          Desinstalación Limpia: {{ uninstallingInstallation.display_name }}
        </h3>
        <p class="text-xs text-neutral-600">
          Esta acción <strong>destruirá todos los secretos</strong> almacenados para este conector, revocará todos los
          scopes de permisos concedidos y marcará la instalación como desinstalada de forma permanente.
        </p>

        <div v-if="uninstallError" role="alert" class="rounded bg-red-50 p-2 text-xs text-red-700">
          {{ uninstallError }}
        </div>

        <div>
          <label for="uninst-reason" class="block text-xs font-medium text-neutral-700"
            >Motivo de la desinstalación:</label
          >
          <input
            id="uninst-reason"
            v-model="uninstallReason"
            type="text"
            placeholder="Ej: Migración o desactivación de servicio"
            class="mt-1 w-full rounded border border-neutral-300 p-2 text-sm"
          />
        </div>

        <div class="flex justify-end gap-2 border-t pt-3">
          <button
            type="button"
            class="rounded border border-neutral-300 px-3 py-1.5 text-xs font-medium"
            @click="closeUninstallModal"
          >
            Cancelar
          </button>
          <button
            type="button"
            :disabled="uninstallSubmitting"
            class="rounded bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-500 disabled:opacity-50"
            @click="submitUninstall"
          >
            {{ uninstallSubmitting ? 'Desinstalando…' : 'Confirmar y Purgar Secretos' }}
          </button>
        </div>
      </div>
    </div>

    <!-- Modal de Métricas y Telemetría -->
    <div
      v-if="metricsInstallation"
      role="dialog"
      aria-labelledby="metrics-modal-title"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    >
      <div class="w-full max-w-xl rounded-lg bg-white p-6 shadow-xl space-y-4">
        <div class="flex items-center justify-between border-b pb-2">
          <h3 id="metrics-modal-title" class="text-lg font-bold text-neutral-900">
            Telemetría: {{ metricsInstallation.display_name }}
          </h3>
          <button type="button" class="text-neutral-400 hover:text-neutral-600 text-sm" @click="closeMetricsModal">
            ✕
          </button>
        </div>

        <div v-if="metricsLoading" role="status" class="py-6 text-center text-xs text-neutral-500">
          Cargando telemetría del conector…
        </div>

        <div v-else-if="metricsSummary" class="space-y-4">
          <dl class="grid grid-cols-2 gap-4 sm:grid-cols-4 rounded bg-neutral-50 p-4 text-center">
            <div>
              <dt class="text-xs text-neutral-500">Invocaciones</dt>
              <dd class="mt-1 text-lg font-bold text-neutral-900">{{ metricsSummary.totalInvocations }}</dd>
            </div>
            <div>
              <dt class="text-xs text-neutral-500">Éxitos</dt>
              <dd class="mt-1 text-lg font-bold text-green-700">{{ metricsSummary.successCount }}</dd>
            </div>
            <div>
              <dt class="text-xs text-neutral-500">Tasa de Error</dt>
              <dd class="mt-1 text-lg font-bold text-amber-700">{{ (metricsSummary.errorRate * 100).toFixed(1) }}%</dd>
            </div>
            <div>
              <dt class="text-xs text-neutral-500">Latencia p95</dt>
              <dd class="mt-1 text-lg font-bold text-neutral-900">{{ metricsSummary.p95LatencyMs }} ms</dd>
            </div>
          </dl>

          <div class="text-xs text-neutral-600 space-y-1">
            <p><strong>Última invocación:</strong> {{ metricsSummary.lastInvokedAt ?? 'Nunca' }}</p>
            <p><strong>Último éxito:</strong> {{ metricsSummary.lastSuccessAt ?? 'Ninguno' }}</p>
            <p v-if="metricsSummary.lastErrorAt" class="text-red-600">
              <strong>Último fallo:</strong> {{ metricsSummary.lastErrorAt }} ({{
                metricsSummary.lastErrorCode ?? 'desconocido'
              }})
            </p>
          </div>

          <div class="rounded border p-3 space-y-2">
            <span class="text-xs font-semibold text-neutral-700">Verificación en vivo:</span>
            <div class="flex items-center gap-3">
              <button
                type="button"
                :disabled="dispatchSubmitting || metricsInstallation.status !== 'active'"
                class="rounded bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
                @click="triggerTestDispatch"
              >
                {{ dispatchSubmitting ? 'Probando…' : 'Lanzar Despacho de Prueba' }}
              </button>
              <span v-if="dispatchFeedback" class="text-xs font-mono text-neutral-700">{{ dispatchFeedback }}</span>
            </div>
          </div>
        </div>

        <div class="flex justify-end border-t pt-3">
          <button
            type="button"
            class="rounded border border-neutral-300 px-3 py-1.5 text-xs font-medium"
            @click="closeMetricsModal"
          >
            Cerrar
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
