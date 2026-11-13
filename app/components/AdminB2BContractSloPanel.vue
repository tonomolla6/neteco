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
  standard: 'Estándar (99,5 %)',
  premium_b2b: 'Prémium (99,9 %)',
  enterprise_vip: 'Gran cuenta (99,95 %)'
}
const contractStatusLabels: Record<B2BContract['status'], string> = {
  draft: 'Borrador',
  operational_check_pending: 'Pendiente de comprobar',
  active: 'Activo',
  suspended_capacity: 'Suspendido por falta de capacidad',
  terminated: 'Finalizado'
}
const contractStatusTones: Record<B2BContract['status'], 'neutral' | 'warning' | 'success' | 'danger'> = {
  draft: 'neutral',
  operational_check_pending: 'warning',
  active: 'success',
  suspended_capacity: 'danger',
  terminated: 'neutral'
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
    errorMessage.value =
      err instanceof Error ? err.message : 'No se han podido cargar los contratos. Vuelve a intentarlo.'
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
      successMessage.value = `Capacidad comprobada. El contrato ${res.contract.contractRef} queda activo.`
    } else {
      errorMessage.value = `Capacidad insuficiente: ${res.contract.operationalCheckNotes || 'no se cumplen los requisitos del acuerdo'}.`
    }
    await loadContracts()
    selectedContract.value = contracts.value.find((c) => c.id === contract.id) || null
  } catch (err: unknown) {
    errorMessage.value =
      err instanceof Error ? err.message : 'No se ha podido comprobar la capacidad. Vuelve a intentarlo.'
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
      successMessage.value = `Informe de ${reportMonth.value} generado: el acuerdo se ha cumplido.`
    } else {
      errorMessage.value = `En ${reportMonth.value} no se ha cumplido el acuerdo. Compensación acumulada: ${adminMoney(res.report.penaltyCreditCents)}.`
    }
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : 'No se ha podido generar el informe. Vuelve a intentarlo.'
  } finally {
    reporting.value = false
  }
}

onMounted(() => {
  loadContracts()
})
</script>

<template>
  <div class="adm-stack">
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
      title="Contratos con empresas"
      description="Lo que nos hemos comprometido a cumplir con cada empresa. Elige un contrato para ver su informe mensual."
      flush
    >
      <div v-if="loading && !contracts.length" class="adm-table-skeleton" aria-busy="true">
        <span class="sr-only">Cargando…</span>
        <div v-for="row in 4" :key="row"><i /><i /><i /><i /></div>
      </div>
      <AdminEmptyState
        v-else-if="contracts.length === 0 && errorMessage"
        variant="error"
        title="No se han podido cargar los contratos"
        description="Comprueba la conexión y vuelve a intentarlo."
      >
        <AdminButton icon="i-lucide-rotate-cw" @click="loadContracts">Reintentar</AdminButton>
      </AdminEmptyState>
      <AdminEmptyState
        v-else-if="contracts.length === 0"
        title="No hay contratos con compromisos de servicio"
        description="Aparecerán aquí cuando una empresa tenga un acuerdo de servicio propio."
        icon="i-lucide-handshake"
      />
      <div v-else class="adm-table-wrap">
        <table class="adm-table">
          <thead>
            <tr>
              <th scope="col">Contrato</th>
              <th scope="col">Empresa</th>
              <th scope="col">Nivel</th>
              <th scope="col" data-numeric>Disponibilidad</th>
              <th scope="col" data-numeric>Velocidad de respuesta</th>
              <th scope="col" data-numeric>Respuesta de soporte</th>
              <th scope="col">Estado</th>
              <th scope="col"><span class="sr-only">Acciones</span></th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="c in contracts"
              :key="c.id"
              class="cursor-pointer"
              :data-selected="selectedContract?.id === c.id || undefined"
              @click="selectedContract = c"
            >
              <td class="font-semibold text-[var(--text-strong)]">{{ c.contractRef }}</td>
              <td>{{ c.companyName }}</td>
              <td>{{ tierLabels[c.tierCode] || adminHumanize(c.tierCode) }}</td>
              <td data-numeric>{{ (c.availabilityTarget * 100).toFixed(2) }} %</td>
              <td data-numeric>&lt; {{ c.apiP95LatencyTargetMs }} ms</td>
              <td data-numeric>&lt; {{ c.supportResponseTargetMin }} min</td>
              <td>
                <AdminBadge :tone="contractStatusTones[c.status]">{{ contractStatusLabels[c.status] }}</AdminBadge>
              </td>
              <td class="adm-table__actions">
                <button
                  v-if="!c.operationalCapacityVerified || c.status !== 'active'"
                  type="button"
                  :disabled="verifying"
                  class="adm-btn adm-btn--secondary adm-btn--sm"
                  @click.stop="handleVerifyCapacity(c)"
                >
                  Comprobar capacidad
                </button>
                <AdminBadge v-else tone="success" plain>Comprobado</AdminBadge>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </AdminCard>

    <AdminCard
      v-if="selectedContract"
      :title="`Informe mensual: ${selectedContract.companyName}`"
      description="Tiempo sin servicio del mes (sin contar las paradas justificadas) y compensación que corresponde."
    >
      <template #actions>
        <label class="sr-only" for="b2b-report-month">Mes del informe</label>
        <input id="b2b-report-month" v-model="reportMonth" type="month" />
        <button type="button" :disabled="reporting" class="adm-btn adm-btn--primary" @click="handleGenerateReport">
          {{ reporting ? 'Calculando…' : 'Generar informe' }}
        </button>
      </template>

      <AdminEmptyState
        v-if="!report"
        compact
        title="Elige un mes y genera el informe"
        icon="i-lucide-file-chart-column"
      />
      <div v-else class="adm-stack">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <span class="font-semibold text-[var(--text-strong)]">
            {{ report.reportMonth }} · contrato {{ selectedContract.contractRef }}
          </span>
          <AdminBadge
            :tone="
              report.alertLevel === 'nominal'
                ? 'success'
                : report.alertLevel === 'warning_risk_of_breach'
                  ? 'warning'
                  : 'danger'
            "
          >
            {{
              report.alertLevel === 'nominal'
                ? 'Se cumple'
                : report.alertLevel === 'warning_risk_of_breach'
                  ? 'En riesgo de incumplir'
                  : 'Incumplido'
            }}
          </AdminBadge>
        </div>
        <div class="adm-grid">
          <AdminStat
            label="Disponibilidad conseguida"
            :value="`${(report.availabilityAchieved * 100).toFixed(3)} %`"
            :hint="`Objetivo: ${(report.targetAvailability * 100).toFixed(2)} % · ${report.availabilityCompliant ? 'cumplido' : 'no cumplido'}`"
          />
          <AdminStat
            label="Tiempo sin servicio computable"
            :value="`${report.netChargeableDowntimeMinutes} min`"
            :hint="`${report.totalDowntimeMinutes} min en total, ${report.excludedDowntimeMinutes} min justificados`"
          />
          <AdminStat
            label="Velocidad de respuesta"
            :value="`${report.latencyP95AchievedMs} ms`"
            :hint="`${report.latencyCompliant ? 'Cumplida' : 'No cumplida'} · soporte: ${report.supportCompliant ? 'cumplido' : 'no cumplido'} · envíos: ${report.fulfillmentCompliant ? 'cumplido' : 'no cumplido'}`"
          />
          <AdminStat
            label="Compensación al cliente"
            :value="adminMoney(report.penaltyCreditCents)"
            :hint="report.penaltyCreditCents > 0 ? 'A descontar por incumplimiento' : 'Sin compensación'"
          />
        </div>
      </div>
    </AdminCard>
  </div>
</template>
