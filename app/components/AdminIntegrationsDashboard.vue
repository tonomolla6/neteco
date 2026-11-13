<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

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

// ── Presentación ───────────────────────────────────────────────────────────
const PROVIDERS: Record<string, string> = {
  beply: 'Facturación (Beply)',
  redsys: 'Pagos con tarjeta (Redsys)',
  carrier: 'Transportista',
  webhook: 'Avisos web'
}
const providerLabel = (code: string) => PROVIDERS[code] ?? adminHumanize(code)
const RUN_STATUS: Record<string, [string, 'success' | 'danger' | 'warning' | 'neutral']> = {
  passed: ['Superada', 'success'],
  failed: ['Fallida', 'danger'],
  running: ['En curso', 'warning'],
  skipped: ['Omitida', 'neutral']
}
const topicLabel = (topic: string) => adminHumanize(topic.replace(/\./g, ' '))
const failedDeliveries = computed(() => deliveries.value.filter((d) => d.status === 'dead_letter'))
const shortId = (id: string) => `#${id.slice(0, 8).toUpperCase()}`
const tabs: Array<{ value: TabKey; label: string }> = [
  { value: 'contracts', label: 'Pruebas de conexión' },
  { value: 'faults', label: 'Simulación de fallos' },
  { value: 'webhooks', label: 'Avisos web' }
]
</script>

<template>
  <div class="adm-stack">
    <div v-if="loading" class="adm-card" role="status">
      <div class="adm-table-skeleton" aria-busy="true">
        <span class="sr-only">Cargando panel de integraciones…</span>
        <div v-for="row in 4" :key="row"><i /><i /><i /></div>
      </div>
    </div>

    <div v-else-if="errorMessage && quotas.length === 0" class="adm-card">
      <AdminEmptyState
        variant="error"
        title="No se pudieron cargar las integraciones"
        description="El servicio no ha respondido. Vuelve a intentarlo en unos minutos."
      >
        <button type="button" data-testid="retry-load-button" class="adm-btn adm-btn--secondary" @click="loadData">
          Reintentar
        </button>
      </AdminEmptyState>
    </div>

    <template v-else>
      <div class="adm-tabs" role="tablist" aria-label="Apartados de integraciones">
        <button
          v-for="entry in tabs"
          :key="entry.value"
          type="button"
          role="tab"
          class="adm-tab"
          :data-tab="entry.value"
          :aria-selected="activeTab === entry.value"
          @click="activeTab = entry.value"
        >
          {{ entry.label }}
        </button>
      </div>

      <UAlert
        v-if="errorMessage"
        role="alert"
        color="error"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        title="No se ha podido completar la operación"
        description="Vuelve a intentarlo. Si el problema sigue, recarga la página."
      />

      <!-- Pruebas de conexión -->
      <div v-if="activeTab === 'contracts'" class="adm-stack">
        <AdminSection
          title="Uso de los entornos de pruebas"
          description="Cuántas llamadas de prueba se han hecho a cada servicio y cuál es su límite."
        >
          <div class="adm-grid">
            <AdminStat
              v-for="q in quotas"
              :key="q.provider"
              :label="providerLabel(q.provider)"
              :value="`${q.dailyUsed} / ${q.dailyLimit}`"
              :hint="`Hoy · ${q.hourlyUsed} de ${q.hourlyLimit} en la última hora`"
            />
          </div>
        </AdminSection>

        <AdminCard title="Últimas pruebas de conexión" flush>
          <AdminEmptyState
            v-if="runs.length === 0"
            compact
            icon="i-lucide-flask-conical"
            title="Todavía no se ha hecho ninguna prueba"
            description="Aquí verás el resultado de las comprobaciones automáticas con cada servicio."
          />
          <ul v-else class="adm-list">
            <li v-for="run in runs" :key="run.id">
              <div class="min-w-0 flex-1">
                <p class="adm-list__title">{{ run.suiteName }}</p>
                <p class="adm-help">
                  {{ providerLabel(run.provider) }} · {{ adminDate(run.createdAt, true) }} · {{ run.durationMs }} ms
                </p>
              </div>
              <AdminBadge v-if="run.driftCount > 0" tone="warning" plain>
                {{ run.driftCount }} {{ run.driftCount === 1 ? 'cambio detectado' : 'cambios detectados' }}
              </AdminBadge>
              <AdminBadge :tone="RUN_STATUS[run.status]?.[1] ?? 'neutral'">
                {{ RUN_STATUS[run.status]?.[0] ?? adminStatusLabel(run.status) }}
              </AdminBadge>
            </li>
          </ul>
        </AdminCard>
      </div>

      <!-- Simulación de fallos -->
      <div v-if="activeTab === 'faults'" class="adm-stack">
        <AdminCard
          title="Simular un fallo"
          description="Provoca un fallo controlado en un servicio externo para comprobar que la tienda se recupera sin perder ni duplicar datos."
        >
          <div class="adm-stack">
            <div class="adm-form-grid">
              <AdminFormField v-slot="{ id }" label="Servicio">
                <select :id="id" v-model="simProvider" class="adm-input">
                  <option value="beply">Facturación (Beply)</option>
                  <option value="redsys">Pagos con tarjeta (Redsys)</option>
                  <option value="carrier">Transportista</option>
                  <option value="webhook">Aviso web saliente</option>
                </select>
              </AdminFormField>
              <AdminFormField v-slot="{ id }" label="Tipo de fallo">
                <select :id="id" v-model="simFaultType" class="adm-input">
                  <option value="timeout">El servicio no responde a tiempo</option>
                  <option value="http_500">El servicio devuelve un error interno</option>
                  <option value="http_401">El servicio rechaza las credenciales</option>
                  <option value="partial_payload">La respuesta llega incompleta</option>
                  <option value="duplicate">El mensaje llega duplicado</option>
                  <option value="latency">El servicio responde muy lento</option>
                </select>
              </AdminFormField>
              <AdminFormField
                v-slot="{ id }"
                label="Referencia de prueba"
                help="Identificador ficticio sobre el que se simula el fallo."
              >
                <input :id="id" v-model="simTargetEntityId" type="text" class="adm-input" />
              </AdminFormField>
            </div>
            <div>
              <button
                type="button"
                data-testid="run-fault-simulation"
                :disabled="busy"
                class="adm-btn adm-btn--primary"
                @click="runFaultSimulation"
              >
                Simular fallo y probar recuperación
              </button>
            </div>

            <UAlert
              v-if="simulationResult"
              role="status"
              :color="simulationResult.recovered && simulationResult.stateConsistent ? 'success' : 'error'"
              variant="subtle"
              :icon="
                simulationResult.recovered && simulationResult.stateConsistent
                  ? 'i-lucide-circle-check'
                  : 'i-lucide-triangle-alert'
              "
              :title="simulationResult.recovered ? 'Recuperado con éxito' : 'La tienda no se ha recuperado sola'"
            >
              <template #description>
                <p>
                  {{
                    simulationResult.stateConsistent
                      ? 'Los datos han quedado correctos, sin pérdidas ni duplicados.'
                      : 'Los datos han quedado inconsistentes: revisa el detalle.'
                  }}
                </p>
                <p>Acción aplicada: {{ adminHumanize(simulationResult.recoveryAction) }}</p>
                <details class="mt-2">
                  <summary class="cursor-pointer">Detalle técnico</summary>
                  <pre
                    class="mt-2 overflow-x-auto rounded-[var(--radius-control)] bg-[var(--surface-sunken)] p-2 text-xs"
                    >{{ JSON.stringify(simulationResult.auditDetails, null, 2) }}</pre>
                </details>
              </template>
            </UAlert>
          </div>
        </AdminCard>
      </div>

      <!-- Avisos web -->
      <div v-if="activeTab === 'webhooks'" class="adm-stack">
        <AdminCard
          title="Destinos de avisos"
          description="Direcciones de clientes a las que la tienda avisa automáticamente cuando ocurre algo (por ejemplo, un pedido nuevo)."
          flush
        >
          <AdminEmptyState
            v-if="subscriptions.length === 0"
            compact
            icon="i-lucide-send"
            title="No hay destinos de avisos configurados"
          />
          <ul v-else class="adm-list">
            <li v-for="sub in subscriptions" :key="sub.id">
              <div class="min-w-0 flex-1">
                <p class="adm-list__title break-all">{{ sub.url }}</p>
                <p class="adm-help">{{ sub.description }} · avisa de: {{ sub.topics.map(topicLabel).join(', ') }}</p>
              </div>
              <AdminBadge :status="sub.status" />
            </li>
          </ul>
        </AdminCard>

        <AdminCard
          title="Avisos fallidos"
          description="Avisos que no se pudieron entregar después de varios intentos."
          flush
        >
          <AdminEmptyState
            v-if="failedDeliveries.length === 0"
            compact
            icon="i-lucide-circle-check"
            title="No hay avisos fallidos"
            description="Todos los avisos se están entregando con normalidad."
          />
          <ul v-else class="adm-list">
            <li v-for="del in failedDeliveries" :key="del.id">
              <div class="min-w-0 flex-1">
                <p class="adm-list__title">{{ topicLabel(del.topic) }} · {{ shortId(del.id) }}</p>
                <p class="adm-help">
                  {{ del.attempts }} de {{ del.maxAttempts }} intentos
                  <template v-if="del.lastHttpStatus"> · respuesta {{ del.lastHttpStatus }}</template>
                  · {{ adminDate(del.createdAt, true) }}
                </p>
              </div>
              <AdminBadge tone="danger">No entregado</AdminBadge>
            </li>
          </ul>
        </AdminCard>
      </div>
    </template>
  </div>
</template>
