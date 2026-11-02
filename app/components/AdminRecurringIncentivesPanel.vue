<script setup lang="ts">
import { onMounted, ref } from 'vue'
import {
  SPANISH_LIVA_RAPPEL_FISCAL_CLAUSE,
  type IncentiveAgreement,
  type IncentiveSettlement
} from '~~/shared/recurring-incentives'

const props = defineProps<{
  companyId: string
}>()

const requestFetch = useRequestFetch()
const loading = ref(true)
const errorMessage = ref('')
const agreement = ref<IncentiveAgreement | null>(null)
const settlements = ref<IncentiveSettlement[]>([])

// Fiscal Approval Form State
const activeSettlement = ref<IncentiveSettlement | null>(null)
const creditNoteRef = ref('')
const approvalNotes = ref('')
const approving = ref(false)

function errorText(error: unknown, fallback: string): string {
  const c = (error as { data?: { error?: { code?: string } } })?.data?.error?.code
  return c ? `${fallback} (${c})` : fallback
}

async function loadData() {
  loading.value = true
  errorMessage.value = ''
  try {
    const res = (await requestFetch(`/api/admin/b2b/recurring-incentives/agreements/${props.companyId}`)) as {
      agreement: IncentiveAgreement
    }
    agreement.value = res?.agreement ?? null
  } catch (error) {
    errorMessage.value = errorText(error, 'Error al cargar el acuerdo de incentivos')
  } finally {
    loading.value = false
  }
}

async function approveSettlement() {
  if (!activeSettlement.value || !creditNoteRef.value.trim()) return
  approving.value = true
  try {
    await requestFetch(`/api/admin/b2b/recurring-incentives/settlements/${activeSettlement.value.id}/approve`, {
      method: 'POST',
      body: {
        creditNoteRef: creditNoteRef.value.trim(),
        notes: approvalNotes.value.trim() || undefined,
        version: activeSettlement.value.version
      }
    })
    activeSettlement.value = null
    await loadData()
  } catch (error) {
    errorMessage.value = errorText(error, 'Error al aprobar la liquidación fiscal')
  } finally {
    approving.value = false
  }
}

onMounted(() => {
  loadData()
})
</script>

<template>
  <div class="admin-recurring-incentives-panel p-6 max-w-5xl mx-auto space-y-6">
    <header class="border-b pb-4">
      <h1 class="text-2xl font-bold text-slate-900">Incentivos por Recurrencia B2B (MKT-036)</h1>
      <p class="text-sm text-slate-600 mt-1">
        Beneficio basado en volumen, margen y SLA. Sin puntos opacos. Contrato y fiscalidad formalmente revisados.
      </p>
    </header>

    <!-- Fiscal Legal Note Alert -->
    <div class="bg-blue-50 border-l-4 border-blue-500 p-4 rounded text-xs text-blue-900">
      <span class="font-bold">Marco Tributario Aplicable:</span>
      <p class="mt-0.5">{{ SPANISH_LIVA_RAPPEL_FISCAL_CLAUSE }}</p>
    </div>

    <!-- Loading & Error -->
    <div v-if="loading" class="p-8 text-center text-slate-500 animate-pulse">Cargando acuerdo de rappel B2B...</div>
    <div v-else-if="errorMessage" class="p-4 bg-red-50 border border-red-200 rounded text-red-700 text-sm">
      {{ errorMessage }}
    </div>

    <!-- Agreement Content -->
    <div v-else-if="agreement" class="space-y-6">
      <div class="bg-white border rounded p-6 shadow-sm space-y-4">
        <div class="flex items-center justify-between border-b pb-3">
          <div>
            <span class="text-xs font-mono text-slate-500">Contrato: {{ agreement.contractRef }}</span>
            <h2 class="text-lg font-bold text-slate-900">
              Acuerdo de Rappel Trimestral (Versión {{ agreement.contractTermsVersion }})
            </h2>
          </div>
          <span
            :class="[
              'text-xs px-2.5 py-1 rounded font-semibold uppercase',
              agreement.fiscalReviewStatus === 'fiscal_approved'
                ? 'bg-green-100 text-green-800'
                : 'bg-amber-100 text-amber-800'
            ]"
          >
            Fiscal: {{ agreement.fiscalReviewStatus }}
          </span>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
          <div class="p-3 bg-slate-50 rounded border">
            <span class="text-xs text-slate-500 block">Suelo de margen bruto</span>
            <span class="font-bold text-slate-800">{{ agreement.minGrossMarginBasisPoints / 100 }}%</span>
          </div>
          <div class="p-3 bg-slate-50 rounded border">
            <span class="text-xs text-slate-500 block">Condiciones SLA</span>
            <span class="font-medium text-slate-800">
              Pago puntual: {{ agreement.slaPunctualPaymentRequired ? 'Sí' : 'No' }} | Factura-e:
              {{ agreement.slaEinvoiceRequired ? 'Sí' : 'No' }}
            </span>
          </div>
          <div class="p-3 bg-slate-50 rounded border">
            <span class="text-xs text-slate-500 block">Tratamiento de IVA</span>
            <span class="font-medium text-slate-800 font-mono text-xs">
              {{ agreement.fiscalVatTreatment }}
            </span>
          </div>
        </div>

        <div class="border-t pt-3">
          <h3 class="text-xs font-bold text-slate-700 uppercase tracking-wide mb-2">
            Tramos por volumen (Turnover Tiers)
          </h3>
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <div
              v-for="(tier, idx) in agreement.volumeTiers"
              :key="idx"
              class="p-2.5 bg-slate-50 border rounded text-xs flex justify-between items-center"
            >
              <span>A partir de €{{ (tier.minVolumeCents / 100).toLocaleString() }}</span>
              <span class="font-bold text-blue-700">{{ tier.rebatePercentBasisPoints / 100 }}% rappel</span>
            </div>
          </div>
        </div>

        <div class="border-t pt-3 text-xs text-slate-600">
          <strong>Notas fiscales:</strong> {{ agreement.fiscalNotes }}
        </div>

        <!-- Settlements and Fiscal Approval Section -->
        <div v-if="settlements.length" class="border-t pt-4 space-y-3">
          <h3 class="text-xs font-bold text-slate-700 uppercase tracking-wide">Liquidaciones Periódicas de Rappel</h3>
          <div
            v-for="stl in settlements"
            :key="stl.id"
            class="p-3 bg-slate-50 border rounded text-xs flex justify-between items-center"
          >
            <div>
              <span class="font-bold text-slate-800">{{ stl.settlementPeriod }}</span
              >: €{{ (stl.rebateNetCents / 100).toFixed(2) }} neto + 21% IVA (€{{ (stl.vatTaxCents / 100).toFixed(2) }})
              = €{{ (stl.totalCreditGrossCents / 100).toFixed(2) }} total
              <span v-if="stl.creditNoteRef" class="ml-2 font-mono text-slate-500">(Ref: {{ stl.creditNoteRef }})</span>
            </div>
            <button
              v-if="stl.settlementStatus === 'calculated'"
              class="px-2.5 py-1 bg-green-600 hover:bg-green-700 text-white rounded font-medium"
              @click="activeSettlement = stl"
            >
              Aprobar fiscalmente
            </button>
          </div>
        </div>

        <!-- Approval Action Box -->
        <div v-if="activeSettlement" class="p-4 bg-amber-50 border border-amber-200 rounded space-y-3">
          <h4 class="text-sm font-bold text-amber-900">
            Aprobar Abono Fiscal para {{ activeSettlement.settlementPeriod }}
          </h4>
          <input
            v-model="creditNoteRef"
            type="text"
            placeholder="Referencia de factura rectificativa (ej: ABONO-2026-01)"
            class="border rounded p-2 text-xs w-full"
          />
          <input
            v-model="approvalNotes"
            type="text"
            placeholder="Notas de fiscalidad / revisión"
            class="border rounded p-2 text-xs w-full"
          />
          <div class="flex justify-end gap-2">
            <button class="px-3 py-1 text-xs text-slate-600" @click="activeSettlement = null">Cancelar</button>
            <button
              :disabled="approving || !creditNoteRef.trim()"
              class="px-3 py-1 bg-green-600 text-white text-xs rounded font-medium"
              @click="approveSettlement"
            >
              {{ approving ? 'Guardando...' : 'Confirmar aprobación' }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Empty State -->
    <div v-else class="p-8 text-center bg-slate-50 border rounded text-slate-500">
      No se ha encontrado ningún acuerdo de incentivos activo para esta empresa.
    </div>
  </div>
</template>
