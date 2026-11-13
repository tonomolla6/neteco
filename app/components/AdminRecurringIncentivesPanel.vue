<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
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
  return c ? `${fallback}. Vuelve a intentarlo.` : fallback
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

const FISCAL_REVIEW: Record<string, [string, 'success' | 'warning' | 'danger']> = {
  pending_review: ['Revisión fiscal pendiente', 'warning'],
  fiscal_approved: ['Revisión fiscal aprobada', 'success'],
  fiscal_rejected: ['Revisión fiscal rechazada', 'danger']
}
const VAT_TREATMENT: Record<string, string> = {
  credit_note_art80_liva: 'Factura rectificativa (abono)',
  commercial_discount_subsequent_invoice: 'Descuento en la factura siguiente'
}
const SETTLEMENT_STATUS: Record<string, [string, 'neutral' | 'success' | 'warning' | 'danger' | 'info']> = {
  calculated: ['Pendiente de aprobar', 'warning'],
  approved: ['Aprobada', 'success'],
  credit_issued: ['Abono emitido', 'success'],
  rejected: ['Rechazada', 'danger']
}
const percent = (basisPoints: number) =>
  `${(basisPoints / 100).toLocaleString('es-ES', { maximumFractionDigits: 2 })} %`
const settlementColumns = [
  { key: 'settlementPeriod', label: 'Periodo' },
  { key: 'rebateNetCents', label: 'Descuento', numeric: true },
  { key: 'vatTaxCents', label: 'IVA', numeric: true, hideOnMobile: true },
  { key: 'totalCreditGrossCents', label: 'Total a abonar', numeric: true },
  { key: 'creditNoteRef', label: 'Factura rectificativa', hideOnMobile: true },
  { key: 'settlementStatus', label: 'Estado' }
]
const approvalOpen = computed({
  get: () => activeSettlement.value !== null,
  set: (open: boolean) => {
    if (!open) activeSettlement.value = null
  }
})

onMounted(() => {
  loadData()
})
</script>

<template>
  <div class="admin-recurring-incentives-panel adm-stack">
    <div v-if="loading" class="adm-card adm-table-skeleton" aria-busy="true">
      <span class="sr-only">Cargando el acuerdo de descuentos por volumen…</span>
      <div v-for="row in 4" :key="row"><i /><i /><i /></div>
    </div>
    <UAlert
      v-else-if="errorMessage"
      role="alert"
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="errorMessage"
    />

    <template v-else-if="agreement">
      <div class="adm-grid">
        <AdminStat
          label="Margen bruto mínimo"
          :value="percent(agreement.minGrossMarginBasisPoints)"
          hint="El descuento nunca lo rebaja"
          icon="i-lucide-shield-check"
        />
        <AdminStat
          label="Pago puntual"
          :value="agreement.slaPunctualPaymentRequired ? 'Obligatorio' : 'No se exige'"
          hint="Condición para cobrar el descuento"
          icon="i-lucide-calendar-check"
        />
        <AdminStat
          label="Factura electrónica"
          :value="agreement.slaEinvoiceRequired ? 'Obligatoria' : 'No se exige'"
          hint="Condición para cobrar el descuento"
          icon="i-lucide-file-text"
        />
        <AdminStat
          label="Cómo se abona"
          :value="VAT_TREATMENT[agreement.fiscalVatTreatment] ?? adminHumanize(agreement.fiscalVatTreatment)"
          hint="Con el IVA desglosado"
          icon="i-lucide-receipt"
        />
      </div>

      <AdminCard
        title="Acuerdo de descuento trimestral por volumen"
        :description="`Contrato ${agreement.contractRef} · versión ${agreement.contractTermsVersion} de las condiciones`"
      >
        <template #actions>
          <AdminBadge :tone="FISCAL_REVIEW[agreement.fiscalReviewStatus]?.[1] ?? 'neutral'">
            {{ FISCAL_REVIEW[agreement.fiscalReviewStatus]?.[0] ?? adminHumanize(agreement.fiscalReviewStatus) }}
          </AdminBadge>
        </template>
        <div class="adm-stack">
          <div>
            <h3 class="adm-label">Tramos por volumen de compra</h3>
            <ul class="mt-2 grid gap-2 sm:grid-cols-3">
              <li
                v-for="(tier, idx) in agreement.volumeTiers"
                :key="idx"
                class="flex items-center justify-between gap-2 rounded-[var(--radius-control)] border border-[var(--border)] bg-[var(--surface-sunken)] px-3 py-2"
              >
                <span>Desde {{ adminMoney(tier.minVolumeCents) }}</span>
                <span class="font-semibold text-[var(--text-strong)]">
                  {{ percent(tier.rebatePercentBasisPoints) }}
                </span>
              </li>
            </ul>
          </div>
          <p v-if="agreement.fiscalNotes">
            <span class="adm-label">Notas fiscales</span>
            {{ agreement.fiscalNotes }}
          </p>
        </div>
        <template #footer>
          <p class="adm-help mr-auto"><strong>Marco tributario:</strong> {{ SPANISH_LIVA_RAPPEL_FISCAL_CLAUSE }}</p>
        </template>
      </AdminCard>

      <AdminSection
        v-if="settlements.length"
        title="Liquidaciones del descuento"
        description="Importe a abonar al cliente en cada periodo."
      >
        <AdminTable :rows="settlements" :columns="settlementColumns" :row-key="(row) => row.id">
          <template #cell-rebateNetCents="{ row }">{{ adminMoney(row.rebateNetCents) }}</template>
          <template #cell-vatTaxCents="{ row }">{{ adminMoney(row.vatTaxCents) }}</template>
          <template #cell-totalCreditGrossCents="{ row }">{{ adminMoney(row.totalCreditGrossCents) }}</template>
          <template #cell-creditNoteRef="{ row }">{{ row.creditNoteRef ?? '—' }}</template>
          <template #cell-settlementStatus="{ row }">
            <AdminBadge :tone="SETTLEMENT_STATUS[row.settlementStatus]?.[1] ?? 'neutral'">
              {{ SETTLEMENT_STATUS[row.settlementStatus]?.[0] ?? adminHumanize(row.settlementStatus) }}
            </AdminBadge>
          </template>
          <template #actions="{ row }">
            <AdminButton v-if="row.settlementStatus === 'calculated'" size="sm" @click="activeSettlement = row">
              Aprobar
            </AdminButton>
          </template>
        </AdminTable>
      </AdminSection>
    </template>

    <div v-else class="adm-card">
      <AdminEmptyState
        icon="i-lucide-handshake"
        title="Esta empresa no tiene acuerdo de descuentos por volumen"
        description="Comprueba el identificador de la empresa o crea el acuerdo desde su contrato."
      />
    </div>

    <AdminDrawer
      v-model:open="approvalOpen"
      :title="`Aprobar el abono de ${activeSettlement?.settlementPeriod ?? ''}`"
      description="Al aprobar se registra la factura rectificativa con la que se abona el descuento."
    >
      <div v-if="activeSettlement" class="adm-stack">
        <dl class="grid grid-cols-3 gap-3">
          <div>
            <dt class="adm-help">Descuento</dt>
            <dd>{{ adminMoney(activeSettlement.rebateNetCents) }}</dd>
          </div>
          <div>
            <dt class="adm-help">IVA</dt>
            <dd>{{ adminMoney(activeSettlement.vatTaxCents) }}</dd>
          </div>
          <div>
            <dt class="adm-help">Total a abonar</dt>
            <dd class="font-semibold text-[var(--text-strong)]">
              {{ adminMoney(activeSettlement.totalCreditGrossCents) }}
            </dd>
          </div>
        </dl>
        <AdminFormField v-slot="{ id }" label="Número de la factura rectificativa" required>
          <input :id="id" v-model="creditNoteRef" type="text" placeholder="Por ejemplo: ABONO-2026-01" />
        </AdminFormField>
        <AdminFormField v-slot="{ id }" label="Notas de la revisión fiscal">
          <input :id="id" v-model="approvalNotes" type="text" />
        </AdminFormField>
      </div>
      <template #footer>
        <AdminButton @click="activeSettlement = null">Cancelar</AdminButton>
        <AdminButton
          variant="primary"
          :loading="approving"
          :disabled="!creditNoteRef.trim()"
          @click="approveSettlement"
        >
          Confirmar aprobación
        </AdminButton>
      </template>
    </AdminDrawer>
  </div>
</template>
