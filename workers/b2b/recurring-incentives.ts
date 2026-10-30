import {
  computeSettlementCalculation,
  createIncentiveAgreementSchema,
  type CreateIncentiveAgreementInput,
  type IncentiveAgreement,
  type IncentiveSettlement,
  type VolumeTier
} from '../../shared/recurring-incentives'

export class RecurringIncentiveError extends Error {
  constructor(
    readonly code:
      | 'forbidden'
      | 'unauthorized'
      | 'not_found'
      | 'agreement_conflict'
      | 'settlement_already_exists'
      | 'version_conflict'
      | 'invalid_input'
  ) {
    super(code)
    this.name = 'RecurringIncentiveError'
  }
}

export async function requireAdmin(db: D1Database, actorId: string): Promise<void> {
  const row = await db
    .prepare(
      `SELECT 1 as ok FROM identities i
       JOIN identity_roles ir ON ir.identity_id = i.id
       JOIN role_permissions rp ON rp.role_code = ir.role_code
       WHERE i.id = ?1 AND i.status = 'active' AND rp.permission_code = 'administration.manage'
         AND (ir.expires_at IS NULL OR ir.expires_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`
    )
    .bind(actorId)
    .first<{ ok: number }>()

  if (!row?.ok) throw new RecurringIncentiveError('forbidden')
}

export async function createIncentiveAgreementAdmin(
  db: D1Database,
  args: { actorId: string; input: CreateIncentiveAgreementInput; now: string }
): Promise<IncentiveAgreement> {
  await requireAdmin(db, args.actorId)

  const parsed = createIncentiveAgreementSchema.safeParse(args.input)
  if (!parsed.success) throw new RecurringIncentiveError('invalid_input')

  const existing = await db
    .prepare(
      `SELECT id FROM b2b_recurring_incentive_agreements
       WHERE company_id = ?1 AND period_frequency = ?2`
    )
    .bind(parsed.data.companyId, parsed.data.periodFrequency)
    .first<{ id: string }>()

  if (existing) throw new RecurringIncentiveError('agreement_conflict')

  const id = `agr-${crypto.randomUUID()}`
  await db
    .prepare(
      `INSERT INTO b2b_recurring_incentive_agreements (
        id, company_id, contract_ref, contract_terms_version, contract_signed_at,
        period_frequency, volume_tiers_json, min_gross_margin_basis_points,
        sla_punctual_payment_required, sla_min_avg_order_net_cents, sla_einvoice_required,
        fiscal_notes, fiscal_vat_treatment, fiscal_review_status, status, version, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 'pending_review', ?14, 1, ?15, ?16)`
    )
    .bind(
      id,
      parsed.data.companyId,
      parsed.data.contractRef,
      parsed.data.contractTermsVersion,
      parsed.data.contractSignedAt,
      parsed.data.periodFrequency,
      JSON.stringify(parsed.data.volumeTiers),
      parsed.data.minGrossMarginBasisPoints ?? 2000,
      parsed.data.slaPunctualPaymentRequired ? 1 : 0,
      parsed.data.slaMinAvgOrderNetCents ?? 0,
      parsed.data.slaEinvoiceRequired ? 1 : 0,
      parsed.data.fiscalNotes,
      parsed.data.fiscalVatTreatment ?? 'credit_note_art80_liva',
      parsed.data.status ?? 'active',
      args.now,
      args.now
    )
    .run()

  return {
    id,
    companyId: parsed.data.companyId,
    contractRef: parsed.data.contractRef,
    contractTermsVersion: parsed.data.contractTermsVersion,
    contractSignedAt: parsed.data.contractSignedAt,
    periodFrequency: parsed.data.periodFrequency,
    volumeTiers: parsed.data.volumeTiers,
    minGrossMarginBasisPoints: parsed.data.minGrossMarginBasisPoints ?? 2000,
    slaPunctualPaymentRequired: parsed.data.slaPunctualPaymentRequired ?? true,
    slaMinAvgOrderNetCents: parsed.data.slaMinAvgOrderNetCents ?? 0,
    slaEinvoiceRequired: parsed.data.slaEinvoiceRequired ?? true,
    fiscalNotes: parsed.data.fiscalNotes,
    fiscalVatTreatment: parsed.data.fiscalVatTreatment ?? 'credit_note_art80_liva',
    fiscalReviewStatus: 'pending_review',
    fiscalReviewedBy: null,
    fiscalReviewedAt: null,
    status: parsed.data.status ?? 'active',
    version: 1,
    createdAt: args.now,
    updatedAt: args.now
  }
}

export async function getIncentiveAgreementByCompany(
  db: D1Database,
  companyId: string
): Promise<IncentiveAgreement | null> {
  const row = await db
    .prepare(
      `SELECT id, company_id, contract_ref, contract_terms_version, contract_signed_at,
              period_frequency, volume_tiers_json, min_gross_margin_basis_points,
              sla_punctual_payment_required, sla_min_avg_order_net_cents, sla_einvoice_required,
              fiscal_notes, fiscal_vat_treatment, fiscal_review_status, fiscal_reviewed_by,
              fiscal_reviewed_at, status, version, created_at, updated_at
       FROM b2b_recurring_incentive_agreements WHERE company_id = ?1 AND status = 'active'`
    )
    .bind(companyId)
    .first<{
      id: string
      company_id: string
      contract_ref: string
      contract_terms_version: string
      contract_signed_at: string
      period_frequency: 'quarterly' | 'annual'
      volume_tiers_json: string
      min_gross_margin_basis_points: number
      sla_punctual_payment_required: number
      sla_min_avg_order_net_cents: number
      sla_einvoice_required: number
      fiscal_notes: string
      fiscal_vat_treatment: 'credit_note_art80_liva' | 'commercial_discount_subsequent_invoice'
      fiscal_review_status: 'pending_review' | 'fiscal_approved' | 'fiscal_rejected'
      fiscal_reviewed_by: string | null
      fiscal_reviewed_at: string | null
      status: 'draft' | 'active' | 'suspended' | 'terminated'
      version: number
      created_at: string
      updated_at: string
    }>()

  if (!row) return null

  return {
    id: row.id,
    companyId: row.company_id,
    contractRef: row.contract_ref,
    contractTermsVersion: row.contract_terms_version,
    contractSignedAt: row.contract_signed_at,
    periodFrequency: row.period_frequency,
    volumeTiers: JSON.parse(row.volume_tiers_json || '[]'),
    minGrossMarginBasisPoints: row.min_gross_margin_basis_points,
    slaPunctualPaymentRequired: row.sla_punctual_payment_required === 1,
    slaMinAvgOrderNetCents: row.sla_min_avg_order_net_cents,
    slaEinvoiceRequired: row.sla_einvoice_required === 1,
    fiscalNotes: row.fiscal_notes,
    fiscalVatTreatment: row.fiscal_vat_treatment,
    fiscalReviewStatus: row.fiscal_review_status,
    fiscalReviewedBy: row.fiscal_reviewed_by,
    fiscalReviewedAt: row.fiscal_reviewed_at,
    status: row.status,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export async function evaluatePeriodSettlementAdmin(
  db: D1Database,
  args: {
    actorId: string
    agreementId: string
    settlementPeriod: string
    periodStart: string
    periodEnd: string
    marginAchievedBasisPoints: number
    slaPaymentMet: boolean
    slaOrderSizeMet: boolean
    slaEinvoiceMet: boolean
    now: string
  }
): Promise<IncentiveSettlement> {
  await requireAdmin(db, args.actorId)

  const agreement = await db
    .prepare(
      `SELECT id, company_id, volume_tiers_json, min_gross_margin_basis_points,
              sla_punctual_payment_required, sla_min_avg_order_net_cents, sla_einvoice_required
       FROM b2b_recurring_incentive_agreements WHERE id = ?1`
    )
    .bind(args.agreementId)
    .first<{
      id: string
      company_id: string
      volume_tiers_json: string
      min_gross_margin_basis_points: number
      sla_punctual_payment_required: number
      sla_min_avg_order_net_cents: number
      sla_einvoice_required: number
    }>()

  if (!agreement) throw new RecurringIncentiveError('not_found')

  const existing = await db
    .prepare(
      `SELECT id FROM b2b_recurring_incentive_settlements
       WHERE agreement_id = ?1 AND settlement_period = ?2`
    )
    .bind(args.agreementId, args.settlementPeriod)
    .first<{ id: string }>()

  if (existing) throw new RecurringIncentiveError('settlement_already_exists')

  // Calculate qualifying turnover from customer orders
  const company = await db
    .prepare(`SELECT customer_id FROM companies WHERE id = ?1`)
    .bind(agreement.company_id)
    .first<{ customer_id: string }>()

  const customerId = company?.customer_id ?? ''

  const orderSum = await db
    .prepare(
      `SELECT COALESCE(SUM(total_net_cents), 0) as total_net
       FROM orders
       WHERE customer_id = ?1`
    )
    .bind(customerId)
    .first<{ total_net: number }>()

  const qualifyingTurnoverNetCents = orderSum?.total_net ?? 0
  const volumeTiers: VolumeTier[] = JSON.parse(agreement.volume_tiers_json || '[]')

  const calc = computeSettlementCalculation({
    qualifyingTurnoverNetCents,
    volumeTiers,
    marginAchievedBasisPoints: args.marginAchievedBasisPoints,
    minGrossMarginBasisPoints: agreement.min_gross_margin_basis_points,
    slaPaymentMet: args.slaPaymentMet,
    slaOrderSizeMet: args.slaOrderSizeMet,
    slaEinvoiceMet: args.slaEinvoiceMet
  })

  const settlementId = `stl-${crypto.randomUUID()}`

  await db
    .prepare(
      `INSERT INTO b2b_recurring_incentive_settlements (
        id, agreement_id, company_id, settlement_period, period_start, period_end,
        qualifying_turnover_net_cents, margin_achieved_basis_points, margin_threshold_met,
        sla_payment_met, sla_order_size_met, sla_einvoice_met, sla_conditions_all_met,
        applied_rebate_basis_points, rebate_net_cents, vat_tax_rate_percent, vat_tax_cents,
        total_credit_gross_cents, settlement_status, version, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, 21, ?16, ?17, 'calculated', 1, ?18, ?19)`
    )
    .bind(
      settlementId,
      args.agreementId,
      agreement.company_id,
      args.settlementPeriod,
      args.periodStart,
      args.periodEnd,
      qualifyingTurnoverNetCents,
      args.marginAchievedBasisPoints,
      calc.marginThresholdMet ? 1 : 0,
      args.slaPaymentMet ? 1 : 0,
      args.slaOrderSizeMet ? 1 : 0,
      args.slaEinvoiceMet ? 1 : 0,
      calc.slaConditionsAllMet ? 1 : 0,
      calc.appliedRebateBasisPoints,
      calc.rebateNetCents,
      calc.vatTaxCents,
      calc.totalCreditGrossCents,
      args.now,
      args.now
    )
    .run()

  return {
    id: settlementId,
    agreementId: args.agreementId,
    companyId: agreement.company_id,
    settlementPeriod: args.settlementPeriod,
    periodStart: args.periodStart,
    periodEnd: args.periodEnd,
    qualifyingTurnoverNetCents,
    marginAchievedBasisPoints: args.marginAchievedBasisPoints,
    marginThresholdMet: calc.marginThresholdMet,
    slaPaymentMet: args.slaPaymentMet,
    slaOrderSizeMet: args.slaOrderSizeMet,
    slaEinvoiceMet: args.slaEinvoiceMet,
    slaConditionsAllMet: calc.slaConditionsAllMet,
    appliedRebateBasisPoints: calc.appliedRebateBasisPoints,
    rebateNetCents: calc.rebateNetCents,
    vatTaxRatePercent: 21,
    vatTaxCents: calc.vatTaxCents,
    totalCreditGrossCents: calc.totalCreditGrossCents,
    settlementStatus: 'calculated',
    creditNoteRef: null,
    fiscalApprovalIdentityId: null,
    fiscalApprovalAt: null,
    notes: null,
    version: 1,
    createdAt: args.now,
    updatedAt: args.now
  }
}

export async function approveFiscalSettlementAdmin(
  db: D1Database,
  args: {
    actorId: string
    settlementId: string
    creditNoteRef: string
    notes?: string
    version: number
    now: string
  }
): Promise<IncentiveSettlement> {
  await requireAdmin(db, args.actorId)

  const settlement = await db
    .prepare(
      `SELECT id, agreement_id, company_id, settlement_period, period_start, period_end,
              qualifying_turnover_net_cents, margin_achieved_basis_points, margin_threshold_met,
              sla_payment_met, sla_order_size_met, sla_einvoice_met, sla_conditions_all_met,
              applied_rebate_basis_points, rebate_net_cents, vat_tax_rate_percent, vat_tax_cents,
              total_credit_gross_cents, settlement_status, credit_note_ref, version, created_at, updated_at
       FROM b2b_recurring_incentive_settlements WHERE id = ?1`
    )
    .bind(args.settlementId)
    .first<{
      id: string
      agreement_id: string
      company_id: string
      settlement_period: string
      period_start: string
      period_end: string
      qualifying_turnover_net_cents: number
      margin_achieved_basis_points: number
      margin_threshold_met: number
      sla_payment_met: number
      sla_order_size_met: number
      sla_einvoice_met: number
      sla_conditions_all_met: number
      applied_rebate_basis_points: number
      rebate_net_cents: number
      vat_tax_rate_percent: number
      vat_tax_cents: number
      total_credit_gross_cents: number
      settlement_status: 'calculated' | 'approved' | 'credit_issued' | 'rejected'
      credit_note_ref: string | null
      version: number
      created_at: string
      updated_at: string
    }>()

  if (!settlement) throw new RecurringIncentiveError('not_found')

  // CAS concurrency check
  if (settlement.version !== args.version) {
    throw new RecurringIncentiveError('version_conflict')
  }

  const nextVersion = settlement.version + 1
  await db
    .prepare(
      `UPDATE b2b_recurring_incentive_settlements
       SET settlement_status = 'approved', credit_note_ref = ?1, fiscal_approval_identity_id = ?2,
           fiscal_approval_at = ?3, notes = ?4, version = ?5, updated_at = ?3
       WHERE id = ?6 AND version = ?7`
    )
    .bind(args.creditNoteRef, args.actorId, args.now, args.notes ?? null, nextVersion, args.settlementId, args.version)
    .run()

  return {
    id: settlement.id,
    agreementId: settlement.agreement_id,
    companyId: settlement.company_id,
    settlementPeriod: settlement.settlement_period,
    periodStart: settlement.period_start,
    periodEnd: settlement.period_end,
    qualifyingTurnoverNetCents: settlement.qualifying_turnover_net_cents,
    marginAchievedBasisPoints: settlement.margin_achieved_basis_points,
    marginThresholdMet: settlement.margin_threshold_met === 1,
    slaPaymentMet: settlement.sla_payment_met === 1,
    slaOrderSizeMet: settlement.sla_order_size_met === 1,
    slaEinvoiceMet: settlement.sla_einvoice_met === 1,
    slaConditionsAllMet: settlement.sla_conditions_all_met === 1,
    appliedRebateBasisPoints: settlement.applied_rebate_basis_points,
    rebateNetCents: settlement.rebate_net_cents,
    vatTaxRatePercent: settlement.vat_tax_rate_percent,
    vatTaxCents: settlement.vat_tax_cents,
    totalCreditGrossCents: settlement.total_credit_gross_cents,
    settlementStatus: 'approved',
    creditNoteRef: args.creditNoteRef,
    fiscalApprovalIdentityId: args.actorId,
    fiscalApprovalAt: args.now,
    notes: args.notes ?? null,
    version: nextVersion,
    createdAt: settlement.created_at,
    updatedAt: args.now
  }
}

export async function getCustomerIncentiveOverview(
  db: D1Database,
  args: { customerId: string }
): Promise<{
  agreement: IncentiveAgreement
  currentPeriodTurnoverNetCents: number
  settlements: IncentiveSettlement[]
} | null> {
  const company = await db
    .prepare(`SELECT id FROM companies WHERE customer_id = ?1`)
    .bind(args.customerId)
    .first<{ id: string }>()

  if (!company?.id) return null

  const agreement = await getIncentiveAgreementByCompany(db, company.id)
  if (!agreement) return null

  const orderSum = await db
    .prepare(
      `SELECT COALESCE(SUM(total_net_cents), 0) as total_net
       FROM orders WHERE customer_id = ?1`
    )
    .bind(args.customerId)
    .first<{ total_net: number }>()

  const currentPeriodTurnoverNetCents = orderSum?.total_net ?? 0

  const settlementsRows = await db
    .prepare(
      `SELECT id, agreement_id, company_id, settlement_period, period_start, period_end,
              qualifying_turnover_net_cents, margin_achieved_basis_points, margin_threshold_met,
              sla_payment_met, sla_order_size_met, sla_einvoice_met, sla_conditions_all_met,
              applied_rebate_basis_points, rebate_net_cents, vat_tax_rate_percent, vat_tax_cents,
              total_credit_gross_cents, settlement_status, credit_note_ref, fiscal_approval_identity_id,
              fiscal_approval_at, notes, version, created_at, updated_at
       FROM b2b_recurring_incentive_settlements
       WHERE company_id = ?1 ORDER BY created_at DESC`
    )
    .bind(company.id)
    .all<{
      id: string
      agreement_id: string
      company_id: string
      settlement_period: string
      period_start: string
      period_end: string
      qualifying_turnover_net_cents: number
      margin_achieved_basis_points: number
      margin_threshold_met: number
      sla_payment_met: number
      sla_order_size_met: number
      sla_einvoice_met: number
      sla_conditions_all_met: number
      applied_rebate_basis_points: number
      rebate_net_cents: number
      vat_tax_rate_percent: number
      vat_tax_cents: number
      total_credit_gross_cents: number
      settlement_status: 'calculated' | 'approved' | 'credit_issued' | 'rejected'
      credit_note_ref: string | null
      fiscal_approval_identity_id: string | null
      fiscal_approval_at: string | null
      notes: string | null
      version: number
      created_at: string
      updated_at: string
    }>()

  const settlements: IncentiveSettlement[] = (settlementsRows.results ?? []).map((s) => ({
    id: s.id,
    agreementId: s.agreement_id,
    companyId: s.company_id,
    settlementPeriod: s.settlement_period,
    periodStart: s.period_start,
    periodEnd: s.period_end,
    qualifyingTurnoverNetCents: s.qualifying_turnover_net_cents,
    marginAchievedBasisPoints: s.margin_achieved_basis_points,
    marginThresholdMet: s.margin_threshold_met === 1,
    slaPaymentMet: s.sla_payment_met === 1,
    slaOrderSizeMet: s.sla_order_size_met === 1,
    slaEinvoiceMet: s.sla_einvoice_met === 1,
    slaConditionsAllMet: s.sla_conditions_all_met === 1,
    appliedRebateBasisPoints: s.applied_rebate_basis_points,
    rebateNetCents: s.rebate_net_cents,
    vatTaxRatePercent: s.vat_tax_rate_percent,
    vatTaxCents: s.vat_tax_cents,
    totalCreditGrossCents: s.total_credit_gross_cents,
    settlementStatus: s.settlement_status,
    creditNoteRef: s.credit_note_ref,
    fiscalApprovalIdentityId: s.fiscal_approval_identity_id,
    fiscalApprovalAt: s.fiscal_approval_at,
    notes: s.notes,
    version: s.version,
    createdAt: s.created_at,
    updatedAt: s.updated_at
  }))

  return {
    agreement,
    currentPeriodTurnoverNetCents,
    settlements
  }
}
