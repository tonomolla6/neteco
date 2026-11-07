<script setup lang="ts">
import { ref, onMounted } from 'vue'

const requestFetch = useRequestFetch()

interface B2BContract {
  id: string
  customerId: string
  companyName: string
  contractRef: string
  tierCode: 'standard' | 'premium_b2b' | 'enterprise_vip'
  availabilityTarget: number
  apiP95LatencyTargetMs: number
  supportResponseTargetMin: number
  dispatchLeadTargetHours: number
  status: 'draft' | 'operational_check_pending' | 'active' | 'suspended_capacity' | 'terminated'
  operationalCapacityVerified: boolean
  operationalCheckNotes?: string | null
  billingPeriodStart: string
  billingPeriodEnd: string
  version: number
}

interface ComplianceReport {
  id: string
  contractId: string
  reportMonth: string
  availabilityAchieved: number
  targetAvailability: number
  availabilityCompliant: boolean
  latencyP95AchievedMs: number
  latencyCompliant: boolean
  supportCompliant: boolean
  fulfillmentCompliant: boolean
  overallCompliant: boolean
  totalDowntimeMinutes: number
  excludedDowntimeMinutes: number
  netChargeableDowntimeMinutes: number
  penaltyCreditCents: number
  alertLevel: 'nominal' | 'warning_risk_of_breach' | 'breached'
  generatedAt: string
}

const loading = ref(false)
const verifying = ref(false)
const reporting = ref(false)
const errorMessage = ref('')
const successMessage = ref('')

const contracts = ref<B2BContract[]>([])
const selectedContract = ref<B2BContract | null>(null)
const report = ref<ComplianceReport | null>(null)

const reportMonth = ref('2026-10')

const tierLabels: Record<string, string> = {
  standard: 'B2B Estándar (99.5%)',
  premium_b2b: 'B2B Premium (99.9%)',
  enterprise_vip: 'B2B Enterprise VIP (99.95%)'
}

async function loadContracts() {
  loading.value = true
  errorMessage.value = ''
  try {
    const res = (await requestFetch('/api/admin/observability/b2b-slo/contracts')) as { contracts: B2BContract[] }
    contracts.value = res?.contracts ?? []
    if (contracts.value[0] && !selectedContract.value) {
      selectedContract.value = contracts.value[0]
    }
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : 'Error al cargar contratos B2B'
  } finally {
    loading.value = false
  }
}

async function handleVerifyCapacity(contract: B2BContract) {
  verifying.value = true
  errorMessage.value = ''
  successMessage.value = ''
  try {
    const res = (await requestFetch('/api/admin/observability/b2b-slo/contracts/verify-capacity', {
      method: 'POST',
      body: {
        commandId: crypto.randomUUID(),
        idempotencyKey: `verify-${Date.now()}-${contract.id}`,
        contractId: contract.id,
        expectedVersion: contract.version,
        capacityAssessment: {
          errorBudgetHealthy: true,
          currentHeadroomPercent: 28.0,
          hasDedicatedManager: true
        }
      }
    })) as { contract: B2BContract }

    if (res.contract.status === 'active') {
      successMessage.value = `Capacidad operativa validada. Contrato ${res.contract.contractRef} ACTIVADO.`
    } else {
      errorMessage.value = `Capacidad insuficiente: ${res.contract.operationalCheckNotes || 'No se cumplen requisitos del SLA'}.`
    }
    await loadContracts()
    selectedContract.value = contracts.value.find((c) => c.id === contract.id) || null
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : 'Error al verificar capacidad operativa'
  } finally {
    verifying.value = false
  }
}

async function handleGenerateReport() {
  if (!selectedContract.value) return
  reporting.value = true
  errorMessage.value = ''
  successMessage.value = ''
  try {
    const res = (await requestFetch('/api/admin/observability/b2b-slo/reports', {
      method: 'POST',
      body: {
        commandId: crypto.randomUUID(),
        idempotencyKey: `rep-${Date.now()}-${selectedContract.value.id}-${reportMonth.value}`,
        contractId: selectedContract.value.id,
        reportMonth: reportMonth.value
      }
    })) as { report: ComplianceReport }

    report.value = res.report
    if (res.report.overallCompliant) {
      successMessage.value = `Informe mensual ${reportMonth.value} generado: Contrato en CUMPLIMIENTO de SLA.`
    } else {
      errorMessage.value = `Alerta de Incumplimiento: Se han detectado violaciones de SLA en ${reportMonth.value}. Penalización acumulada: ${(res.report.penaltyCreditCents / 100).toFixed(2)} €.`
    }
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : 'Error al generar informe mensual de SLA'
  } finally {
    reporting.value = false
  }
}

onMounted(() => {
  loadContracts()
})
</script>

<template>
  <div class="space-y-6">
    <!-- Messages -->
    <div v-if="errorMessage" role="alert" class="rounded bg-red-100 p-3 text-sm text-red-700">
      {{ errorMessage }}
    </div>
    <div v-if="successMessage" role="status" class="rounded bg-emerald-100 p-3 text-sm text-emerald-700">
      {{ successMessage }}
    </div>

    <!-- Contracts Table -->
    <div class="rounded-lg border border-neutral-200 bg-white p-5 shadow-sm">
      <div class="flex items-center justify-between mb-4">
        <div>
          <h3 class="text-base font-semibold text-neutral-900">
            Contratos B2B y Niveles de Servicio Acordados (SLA / SLO)
          </h3>
          <p class="text-xs text-neutral-600">
            Promesas operativas medibles, control de capacidad operativa previa y exclusiones auditadas.
          </p>
        </div>
      </div>

      <div v-if="loading" class="text-sm text-neutral-500 py-4 text-center">Cargando acuerdos contractuales B2B...</div>
      <div v-else-if="contracts.length === 0" class="text-sm text-neutral-500 py-4 text-center">
        No se han registrado contratos B2B con SLA específico.
      </div>
      <div v-else class="overflow-x-auto">
        <table class="min-w-full divide-y divide-neutral-200 text-left text-xs">
          <thead>
            <tr class="bg-neutral-50 text-neutral-600 font-medium">
              <th class="px-3 py-2">Ref. Contrato</th>
              <th class="px-3 py-2">Empresa</th>
              <th class="px-3 py-2">Tier SLA</th>
              <th class="px-3 py-2">Disponibilidad SLO</th>
              <th class="px-3 py-2">Latencia P95</th>
              <th class="px-3 py-2">Soporte Max</th>
              <th class="px-3 py-2">Estado</th>
              <th class="px-3 py-2">Acción</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-neutral-100">
            <tr
              v-for="c in contracts"
              :key="c.id"
              class="cursor-pointer hover:bg-neutral-50/80"
              :class="selectedContract?.id === c.id ? 'bg-blue-50/40' : ''"
              @click="selectedContract = c"
            >
              <td class="px-3 py-2 font-mono font-bold text-neutral-900">{{ c.contractRef }}</td>
              <td class="px-3 py-2 font-medium">{{ c.companyName }}</td>
              <td class="px-3 py-2">{{ tierLabels[c.tierCode] || c.tierCode }}</td>
              <td class="px-3 py-2 font-semibold text-emerald-700">{{ (c.availabilityTarget * 100).toFixed(2) }}%</td>
              <td class="px-3 py-2">&lt; {{ c.apiP95LatencyTargetMs }} ms</td>
              <td class="px-3 py-2">&lt; {{ c.supportResponseTargetMin }} min</td>
              <td class="px-3 py-2">
                <span
                  class="px-2 py-0.5 rounded text-xs font-semibold"
                  :class="{
                    'bg-emerald-100 text-emerald-800': c.status === 'active',
                    'bg-amber-100 text-amber-800': c.status === 'operational_check_pending',
                    'bg-red-100 text-red-800': c.status === 'suspended_capacity'
                  }"
                >
                  {{
                    c.status === 'active'
                      ? 'Activo'
                      : c.status === 'operational_check_pending'
                        ? 'Verificación Pendiente'
                        : 'Capacidad Suspendida'
                  }}
                </span>
              </td>
              <td class="px-3 py-2">
                <button
                  v-if="!c.operationalCapacityVerified || c.status !== 'active'"
                  :disabled="verifying"
                  class="rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                  @click.stop="handleVerifyCapacity(c)"
                >
                  Verificar Capacidad
                </button>
                <span v-else class="text-xs text-emerald-700 font-semibold">Validado</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Monthly Compliance Report & Proactive Alerting Section -->
    <div v-if="selectedContract" class="rounded-lg border border-neutral-200 bg-white p-5 shadow-sm">
      <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
        <div>
          <h4 class="text-base font-semibold text-neutral-900">
            Reporting Mensual y Alertas de SLA: {{ selectedContract.companyName }}
          </h4>
          <p class="text-xs text-neutral-600">
            Cálculo de indisponibilidad neta (descontando exclusiones auditadas) y penalizaciones contractuales.
          </p>
        </div>

        <div class="flex items-center gap-2">
          <input
            v-model="reportMonth"
            type="month"
            class="rounded border border-neutral-300 px-2.5 py-1 text-xs focus:outline-none"
          />
          <button
            :disabled="reporting"
            class="rounded bg-neutral-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-neutral-800 disabled:opacity-50"
            @click="handleGenerateReport"
          >
            {{ reporting ? 'Calculando...' : 'Generar Informe' }}
          </button>
        </div>
      </div>

      <!-- Compliance Report Result Card -->
      <div
        v-if="report"
        class="rounded-lg border p-4 text-xs"
        :class="{
          'border-emerald-300 bg-emerald-50/50': report.alertLevel === 'nominal',
          'border-amber-300 bg-amber-50/50': report.alertLevel === 'warning_risk_of_breach',
          'border-red-300 bg-red-50/50': report.alertLevel === 'breached'
        }"
      >
        <div class="flex items-center justify-between pb-3 border-b border-neutral-200/60 mb-3">
          <span class="font-bold text-sm text-neutral-900">
            Informe Periodo {{ report.reportMonth }} (Contrato {{ selectedContract.contractRef }})
          </span>
          <span
            class="px-2.5 py-1 rounded-full font-bold text-xs"
            :class="{
              'bg-emerald-100 text-emerald-800': report.alertLevel === 'nominal',
              'bg-amber-100 text-amber-800': report.alertLevel === 'warning_risk_of_breach',
              'bg-red-100 text-red-800': report.alertLevel === 'breached'
            }"
          >
            {{
              report.alertLevel === 'nominal'
                ? 'Conforme (Nominal)'
                : report.alertLevel === 'warning_risk_of_breach'
                  ? 'Alerta: Riesgo de Violación de SLA'
                  : 'Incumplimiento (SLA Breached)'
            }}
          </span>
        </div>

        <div class="grid gap-3 sm:grid-cols-4 text-neutral-800">
          <div>
            <span class="block text-neutral-500">Disponibilidad Conseguida:</span>
            <strong class="text-sm" :class="report.availabilityCompliant ? 'text-emerald-700' : 'text-red-700'">
              {{ (report.availabilityAchieved * 100).toFixed(3) }}%
            </strong>
            <span class="text-neutral-500 block">Objetivo: {{ (report.targetAvailability * 100).toFixed(2) }}%</span>
          </div>

          <div>
            <span class="block text-neutral-500">Downtime Bruto / Excluido:</span>
            <span class="font-medium"
              >{{ report.totalDowntimeMinutes }} min / -{{ report.excludedDowntimeMinutes }} min</span
            >
            <span class="block text-neutral-500 font-semibold"
              >Neto Computable: {{ report.netChargeableDowntimeMinutes }} min</span
            >
          </div>

          <div>
            <span class="block text-neutral-500">Latencia API P95:</span>
            <span class="font-medium" :class="report.latencyCompliant ? 'text-emerald-700' : 'text-red-700'">
              {{ report.latencyP95AchievedMs }} ms
            </span>
            <span class="block text-neutral-500">
              Soporte: {{ report.supportCompliant ? 'OK' : 'Breached' }} | Despacho:
              {{ report.fulfillmentCompliant ? 'OK' : 'Breached' }}
            </span>
          </div>

          <div>
            <span class="block text-neutral-500">Penalización / Crédito B2B:</span>
            <strong
              class="text-sm font-mono"
              :class="report.penaltyCreditCents > 0 ? 'text-red-700' : 'text-neutral-800'"
            >
              {{ (report.penaltyCreditCents / 100).toFixed(2) }} €
            </strong>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
