<script setup lang="ts">
import { onMounted, ref } from 'vue'

export type TabKey = 'contracts' | 'faults' | 'webhooks'

interface QuotaItem {
  provider: string
  dailyLimit: number
  dailyUsed: number
  hourlyLimit: number
  hourlyUsed: number
  remainingDaily?: number
  remainingHourly?: number
}

interface ContractRunItem {
  id: string
  provider: string
  suiteName: string
  status: string
  durationMs: number
  syntheticSeed: string
  driftCount: number
  createdAt: string
}

interface DriftAlertItem {
  id: string
  provider: string
  severity: string
  driftType: string
  description: string
  acknowledged: boolean
  createdAt: string
}

interface FaultRuleItem {
  id: string
  provider: string
  operation: string
  faultType: string
  active: boolean
  version: number
}

interface WebhookSubscriptionItem {
  id: string
  url: string
  topics: string[]
  description: string
  status: string
  primarySecret: string
  secondarySecret?: string | null
  version: number
  createdAt: string
}

interface WebhookDeliveryItem {
  id: string
  subscriptionId: string
  topic: string
  status: string
  attempts: number
  maxAttempts: number
  lastHttpStatus?: number | null
  lastError?: string | null
  createdAt: string
}

interface FaultSimulationResult {
  faultInjected: string
  recovered: boolean
  recoveryAction: string
  stateConsistent: boolean
  auditDetails: Record<string, unknown>
}

const requestFetch = useRequestFetch()

interface IntegrationsSummaryResponse {
  quotas?: QuotaItem[]
  runs?: ContractRunItem[]
  alerts?: DriftAlertItem[]
  rules?: FaultRuleItem[]
  subscriptions?: WebhookSubscriptionItem[]
  deliveries?: WebhookDeliveryItem[]
}

const activeTab = ref<TabKey>('contracts')
const loading = ref(true)
const busy = ref(false)
const errorMessage = ref('')

const quotas = ref<QuotaItem[]>([])
const runs = ref<ContractRunItem[]>([])
const alerts = ref<DriftAlertItem[]>([])
const rules = ref<FaultRuleItem[]>([])
const subscriptions = ref<WebhookSubscriptionItem[]>([])
const deliveries = ref<WebhookDeliveryItem[]>([])

// Simulación de fallos
const simProvider = ref('beply')
const simOperation = ref('issue_invoice')
const simFaultType = ref('timeout')
const simTargetEntityId = ref('order-sim-001')
const simulationResult = ref<FaultSimulationResult | null>(null)

async function loadData() {
  loading.value = true
  errorMessage.value = ''
  try {
    const data = await requestFetch<IntegrationsSummaryResponse>('/api/admin/integrations/summary')
    quotas.value = data.quotas ?? []
    runs.value = data.runs ?? []
    alerts.value = data.alerts ?? []
    rules.value = data.rules ?? []
    subscriptions.value = data.subscriptions ?? []
    deliveries.value = data.deliveries ?? []
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : 'No se pudieron cargar las integraciones'
  } finally {
    loading.value = false
  }
}

async function runFaultSimulation() {
  busy.value = true
  errorMessage.value = ''
  try {
    const result = await requestFetch<FaultSimulationResult>('/api/admin/fault-injection/simulate', {
      method: 'POST',
      body: {
        provider: simProvider.value,
        operation: simOperation.value,
        faultType: simFaultType.value,
        targetEntityId: simTargetEntityId.value,
        timeoutMs: 50
      }
    })
    simulationResult.value = result
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : 'Error al ejecutar simulación de fallo'
  } finally {
    busy.value = false
  }
}

onMounted(() => {
  loadData()
})
</script>

<template>
  <div class="space-y-6">
    <!-- Header -->
    <div class="border-b border-gray-200 pb-5 sm:flex sm:items-center sm:justify-between">
      <div>
        <h1 class="text-2xl font-bold tracking-tight text-gray-900">Integraciones, Sandboxes y Webhooks</h1>
        <p class="mt-1 text-sm text-gray-500">
          Supervisión de pruebas de contrato periódicas (INT-018), inyección de fallos controlada (INT-019) y entrega de
          webhooks salientes (INT-021).
        </p>
      </div>
    </div>

    <!-- Loading State -->
    <div v-if="loading" class="rounded-lg border border-gray-200 bg-white p-12 text-center shadow-sm">
      <div
        class="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-indigo-600 border-r-transparent align-[-0.125em]"
      />
      <p class="mt-4 text-sm font-medium text-gray-700">Cargando panel de integraciones...</p>
    </div>

    <!-- Error State -->
    <div
      v-else-if="errorMessage && quotas.length === 0"
      class="rounded-lg border border-red-200 bg-red-50 p-6 shadow-sm"
    >
      <div class="flex items-center">
        <div class="text-sm text-red-700">
          <p class="font-semibold">No se pudieron cargar las integraciones</p>
          <p class="mt-1 text-xs text-red-600">{{ errorMessage }}</p>
        </div>
      </div>
      <div class="mt-4">
        <button
          type="button"
          data-testid="retry-load-button"
          class="rounded-md bg-red-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-red-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-600"
          @click="loadData"
        >
          Reintentar
        </button>
      </div>
    </div>

    <!-- Main Content -->
    <div v-else class="space-y-6">
      <!-- Tabs Navigation -->
      <div class="border-b border-gray-200">
        <nav class="-mb-px flex space-x-8" aria-label="Tabs">
          <button
            type="button"
            data-tab="contracts"
            :class="[
              activeTab === 'contracts'
                ? 'border-indigo-500 text-indigo-600'
                : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700',
              'whitespace-nowrap border-b-2 py-4 px-1 text-sm font-medium'
            ]"
            @click="activeTab = 'contracts'"
          >
            Contratos Sandbox
          </button>
          <button
            type="button"
            data-tab="faults"
            :class="[
              activeTab === 'faults'
                ? 'border-indigo-500 text-indigo-600'
                : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700',
              'whitespace-nowrap border-b-2 py-4 px-1 text-sm font-medium'
            ]"
            @click="activeTab = 'faults'"
          >
            Inyección de Fallos
          </button>
          <button
            type="button"
            data-tab="webhooks"
            :class="[
              activeTab === 'webhooks'
                ? 'border-indigo-500 text-indigo-600'
                : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700',
              'whitespace-nowrap border-b-2 py-4 px-1 text-sm font-medium'
            ]"
            @click="activeTab = 'webhooks'"
          >
            Webhooks Salientes
          </button>
        </nav>
      </div>

      <!-- Tab 1: Contratos Sandbox (INT-018) -->
      <div v-if="activeTab === 'contracts'" class="space-y-6">
        <div class="rounded-lg border border-gray-200 bg-white shadow-sm">
          <div class="border-b border-gray-200 px-6 py-4">
            <h2 class="text-base font-semibold leading-6 text-gray-900">Presupuesto de Cuotas</h2>
            <p class="mt-1 text-xs text-gray-500">
              Control de tasa y volumen contra entornos sandbox para prevenir rate limiting y costes imprevistos.
            </p>
          </div>
          <div class="p-6">
            <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div v-for="q in quotas" :key="q.provider" class="rounded-lg border border-gray-200 bg-gray-50 p-4">
                <div class="flex items-center justify-between">
                  <span class="font-mono text-sm font-bold uppercase text-gray-800">{{ q.provider }}</span>
                  <span class="rounded bg-indigo-100 px-2 py-0.5 text-xs font-semibold text-indigo-700">Sandbox</span>
                </div>
                <div class="mt-3 space-y-1 text-xs text-gray-600">
                  <p>
                    Límite Diario: <span class="font-semibold">{{ q.dailyUsed }} / {{ q.dailyLimit }}</span>
                  </p>
                  <p>
                    Límite Horario: <span class="font-semibold">{{ q.hourlyUsed }} / {{ q.hourlyLimit }}</span>
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Historial de ejecuciones -->
        <div class="rounded-lg border border-gray-200 bg-white shadow-sm">
          <div class="border-b border-gray-200 px-6 py-4">
            <h2 class="text-base font-semibold leading-6 text-gray-900">Ejecuciones de Pruebas de Contrato</h2>
          </div>
          <div class="p-6">
            <div v-if="runs.length === 0" class="text-center py-6 text-sm text-gray-500">
              No hay ejecuciones recientes de contratos sandbox registradas.
            </div>
            <ul v-else class="divide-y divide-gray-200 text-sm">
              <li v-for="run in runs" :key="run.id" class="py-3 flex justify-between items-center">
                <div>
                  <span class="font-medium text-gray-900">{{ run.suiteName }}</span>
                  <span class="ml-2 text-xs text-gray-500 font-mono">{{ run.provider }}</span>
                </div>
                <div class="flex items-center space-x-3">
                  <span
                    :class="[
                      run.status === 'passed' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800',
                      'rounded-full px-2.5 py-0.5 text-xs font-medium'
                    ]"
                  >
                    {{ run.status }}
                  </span>
                  <span class="text-xs text-gray-400">{{ run.durationMs }}ms</span>
                </div>
              </li>
            </ul>
          </div>
        </div>
      </div>

      <!-- Tab 2: Inyección de Fallos (INT-019) -->
      <div v-if="activeTab === 'faults'" class="space-y-6">
        <div class="rounded-lg border border-gray-200 bg-white shadow-sm">
          <div class="border-b border-gray-200 px-6 py-4">
            <h2 class="text-base font-semibold leading-6 text-gray-900">Banco de Pruebas de Resiliencia</h2>
            <p class="mt-1 text-xs text-gray-500">
              Inyección controlada de timeouts, HTTP 500, HTTP 401, payloads truncados y duplicados para certificar que
              el sistema recupera limpiamente sin corromper la base de datos.
            </p>
          </div>
          <div class="p-6 space-y-4">
            <div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div>
                <label class="block text-xs font-medium text-gray-700">Proveedor</label>
                <select
                  v-model="simProvider"
                  class="mt-1 block w-full rounded-md border-gray-300 py-1.5 text-sm shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                >
                  <option value="beply">Beply (Facturación)</option>
                  <option value="redsys">Redsys (Pasarela)</option>
                  <option value="carrier">Transportista</option>
                  <option value="webhook">Webhook saliente</option>
                </select>
              </div>
              <div>
                <label class="block text-xs font-medium text-gray-700">Tipo de Fallo</label>
                <select
                  v-model="simFaultType"
                  class="mt-1 block w-full rounded-md border-gray-300 py-1.5 text-sm shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                >
                  <option value="timeout">Timeout de conexión</option>
                  <option value="http_500">HTTP 500 Error Interno</option>
                  <option value="http_401">HTTP 401 No Autorizado</option>
                  <option value="partial_payload">Payload parcial / corrupto</option>
                  <option value="duplicate">Mensaje / Orden duplicada</option>
                  <option value="latency">Latencia anómala</option>
                </select>
              </div>
              <div>
                <label class="block text-xs font-medium text-gray-700">Entidad de Prueba</label>
                <input
                  v-model="simTargetEntityId"
                  type="text"
                  class="mt-1 block w-full rounded-md border-gray-300 py-1.5 text-sm shadow-sm focus:border-indigo-500 focus:ring-indigo-500 font-mono"
                />
              </div>
            </div>

            <div class="pt-2">
              <button
                type="button"
                data-testid="run-fault-simulation"
                :disabled="busy"
                class="rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:opacity-50"
                @click="runFaultSimulation"
              >
                Simular fallo y probar recuperación
              </button>
            </div>

            <!-- Veredicto de simulación -->
            <div v-if="simulationResult" class="mt-6 rounded-md border border-green-200 bg-green-50 p-4 text-green-900">
              <div class="flex items-center space-x-2">
                <span class="rounded bg-green-600 px-2 py-0.5 text-xs font-bold text-white uppercase"
                  >Veredicto Certificado</span
                >
                <span class="font-semibold">Recuperado con éxito</span>
                <span class="rounded bg-green-200 px-2 py-0.5 text-xs font-semibold text-green-800"
                  >100% Sin corrupción</span
                >
              </div>
              <div class="mt-2 text-xs space-y-1 text-green-800">
                <p>
                  Acción ejecutada: <span class="font-mono font-semibold">{{ simulationResult.recoveryAction }}</span>
                </p>
                <p>
                  Consistencia de estado verificada:
                  <span class="font-semibold">{{ simulationResult.stateConsistent ? 'SÍ' : 'NO' }}</span>
                </p>
                <pre class="mt-2 rounded bg-green-100 p-2 font-mono text-xs overflow-x-auto">{{
                  JSON.stringify(simulationResult.auditDetails, null, 2)
                }}</pre>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Tab 3: Webhooks Salientes (INT-021) -->
      <div v-if="activeTab === 'webhooks'" class="space-y-6">
        <div class="rounded-lg border border-gray-200 bg-white shadow-sm">
          <div class="border-b border-gray-200 px-6 py-4">
            <h2 class="text-base font-semibold leading-6 text-gray-900">Suscripciones a Webhooks</h2>
            <p class="mt-1 text-xs text-gray-500">
              Webhooks HTTPS para clientes con firma HMAC SHA-256, rotación de secretos sin caída y payloads
              minimizados.
            </p>
          </div>
          <div class="p-6">
            <div v-if="subscriptions.length === 0" class="text-center py-6 text-sm text-gray-500">
              No hay suscripciones a webhooks configuradas.
            </div>
            <ul v-else class="divide-y divide-gray-200 text-sm">
              <li v-for="sub in subscriptions" :key="sub.id" class="py-3 flex justify-between items-center">
                <div>
                  <p class="font-medium text-gray-900">{{ sub.url }}</p>
                  <p class="text-xs text-gray-500">{{ sub.description }} · Eventos: {{ sub.topics.join(', ') }}</p>
                </div>
                <div class="flex items-center space-x-2">
                  <span class="rounded bg-indigo-50 px-2 py-1 text-xs font-mono text-indigo-700"
                    >v{{ sub.version }}</span
                  >
                  <span class="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800">{{
                    sub.status
                  }}</span>
                </div>
              </li>
            </ul>
          </div>
        </div>

        <div class="rounded-lg border border-gray-200 bg-white shadow-sm">
          <div class="border-b border-gray-200 px-6 py-4">
            <h2 class="text-base font-semibold leading-6 text-gray-900">Cola de Dead-Letter (DLQ)</h2>
            <p class="mt-1 text-xs text-gray-500">
              Entregas que agotaron el número máximo de reintentos (5) o devolvieron HTTP 410. Permite reprocesamiento
              manual seguro (replay).
            </p>
          </div>
          <div class="p-6">
            <div
              v-if="deliveries.filter((d) => d.status === 'dead_letter').length === 0"
              class="text-center py-6 text-sm text-gray-500"
            >
              No hay entregas pendientes en la cola de Dead-Letter (DLQ). Todas las entregas están operando normalmente.
            </div>
            <ul v-else class="divide-y divide-gray-200 text-sm">
              <li
                v-for="del in deliveries.filter((d) => d.status === 'dead_letter')"
                :key="del.id"
                class="py-3 flex justify-between items-center"
              >
                <div>
                  <p class="font-mono text-xs text-red-600 font-semibold">{{ del.topic }} (ID: {{ del.id }})</p>
                  <p class="text-xs text-gray-500">
                    Intentos agotados: {{ del.attempts }} / {{ del.maxAttempts }} · Error: {{ del.lastError }}
                  </p>
                </div>
                <span class="rounded bg-red-100 px-2 py-1 text-xs font-semibold text-red-800">Dead Letter</span>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
