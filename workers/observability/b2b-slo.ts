import {
  type B2BSlaTierCode,
  type B2BContractStatus,
  type CreateB2BContractSloInput,
  type VerifyOperationalCapacityInput,
  type RecordB2BSloEventInput,
  type RecordB2BExclusionInput,
  type GenerateComplianceReportInput,
  type B2BContractSloRecord,
  type B2BComplianceReport,
  type B2BAlertLevel,
  createB2BContractSloSchema,
  verifyOperationalCapacitySchema,
  recordB2BSloEventSchema,
  recordB2BExclusionSchema,
  generateComplianceReportSchema,
  B2BContractSloError
} from '../../shared/b2b-contract-slo'
import type { VerifiedSessionClaims } from '../catalog/authorization'

export interface B2BSloOperationOptions {
  now?: string
}

function getIsoNow(options?: B2BSloOperationOptions): string {
  if (options?.now) return options.now
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

async function sha256Hex(content: string): Promise<string> {
  const encoded = new TextEncoder().encode(content)
  const hashBuf = await crypto.subtle.digest('SHA-256', encoded)
  return Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** Scale a non-negative decimal using integer arithmetic and half-up rounding. */
function decimalScaledRounded(value: number, scale: bigint): number {
  if (!Number.isFinite(value) || value < 0) throw new B2BContractSloError('invalid_input', 400, 'Invalid penalty')
  const [mantissa, exponentText] = value.toString().toLowerCase().split('e')
  const [whole, fraction = ''] = mantissa!.split('.')
  const exponent = Number(exponentText ?? 0) - fraction.length
  let numerator = BigInt(`${whole}${fraction}`) * scale
  let denominator = 1n
  if (exponent >= 0) numerator *= 10n ** BigInt(exponent)
  else denominator = 10n ** BigInt(-exponent)
  const rounded = (numerator + denominator / 2n) / denominator
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER))
    throw new B2BContractSloError('invalid_input', 400, 'Penalty too large')
  return Number(rounded)
}

export async function createD1B2BContractSlo(
  database: D1Database,
  claims: VerifiedSessionClaims,
  rawInput: CreateB2BContractSloInput,
  options?: B2BSloOperationOptions
): Promise<B2BContractSloRecord> {
  const parsed = createB2BContractSloSchema.safeParse(rawInput)
  if (!parsed.success) {
    throw new B2BContractSloError('invalid_input', 400, parsed.error.message)
  }
  const input = parsed.data
  const now = getIsoNow(options)

  const payloadHash = await sha256Hex(
    JSON.stringify({
      customerId: input.customerId,
      contractRef: input.contractRef,
      tierCode: input.tierCode,
      start: input.billingPeriodStart,
      end: input.billingPeriodEnd
    })
  )

  const existingCommand = await database
    .prepare(
      `SELECT payload_hash, receipt_json FROM b2b_contract_slo_commands
       WHERE actor_id = ?1 AND idempotency_key = ?2`
    )
    .bind(claims.identityId, input.idempotencyKey)
    .first<{ payload_hash: string; receipt_json: string }>()

  if (existingCommand) {
    if (existingCommand.payload_hash !== payloadHash) {
      throw new B2BContractSloError('idempotency_conflict', 409, 'Idempotency conflict for B2B contract creation')
    }
    return JSON.parse(existingCommand.receipt_json)
  }

  // Fetch tier definitions
  const tier = await database
    .prepare(`SELECT * FROM b2b_account_sla_tiers WHERE tier_code = ?1`)
    .bind(input.tierCode)
    .first<{
      tier_code: B2BSlaTierCode
      availability_slo_target: number
      api_p95_latency_ms: number
      support_response_max_minutes: number
      dispatch_lead_hours: number
    }>()

  if (!tier) {
    throw new B2BContractSloError('tier_not_found', 404, `SLA tier ${input.tierCode} not found`)
  }

  const contractId = crypto.randomUUID()
  const contract: B2BContractSloRecord = {
    id: contractId,
    customerId: input.customerId,
    companyName: input.companyName,
    contractRef: input.contractRef,
    tierCode: input.tierCode,
    availabilityTarget: tier.availability_slo_target,
    apiP95LatencyTargetMs: tier.api_p95_latency_ms,
    supportResponseTargetMin: tier.support_response_max_minutes,
    dispatchLeadTargetHours: tier.dispatch_lead_hours,
    status: 'operational_check_pending',
    operationalCapacityVerified: false,
    operationalCheckNotes: null,
    billingPeriodStart: input.billingPeriodStart,
    billingPeriodEnd: input.billingPeriodEnd,
    createdBy: claims.identityId,
    version: 1,
    createdAt: now,
    updatedAt: now
  }

  await database.batch([
    database
      .prepare(
        `INSERT INTO b2b_contract_slos (
          id, customer_id, company_name, contract_ref, tier_code,
          availability_target, api_p95_latency_target_ms, support_response_target_min,
          dispatch_lead_target_hours, status, operational_capacity_verified,
          operational_check_notes, billing_period_start, billing_period_end,
          created_by, version, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)`
      )
      .bind(
        contractId,
        contract.customerId,
        contract.companyName,
        contract.contractRef,
        contract.tierCode,
        contract.availabilityTarget,
        contract.apiP95LatencyTargetMs,
        contract.supportResponseTargetMin,
        contract.dispatchLeadTargetHours,
        contract.status,
        0,
        contract.operationalCheckNotes,
        contract.billingPeriodStart,
        contract.billingPeriodEnd,
        claims.identityId,
        1,
        now,
        now
      ),
    database
      .prepare(
        `INSERT INTO b2b_contract_slo_commands (
          command_id, actor_id, action, idempotency_key, expected_version,
          result_version, payload_hash, input_json, receipt_json, created_at
        ) VALUES (?1, ?2, 'create_contract', ?3, 0, 1, ?4, ?5, ?6, ?7)`
      )
      .bind(
        input.commandId,
        claims.identityId,
        input.idempotencyKey,
        payloadHash,
        JSON.stringify(input),
        JSON.stringify(contract),
        now
      )
  ])

  return contract
}

export async function verifyD1OperationalCapacity(
  database: D1Database,
  claims: VerifiedSessionClaims,
  rawInput: VerifyOperationalCapacityInput,
  options?: B2BSloOperationOptions
): Promise<B2BContractSloRecord> {
  const parsed = verifyOperationalCapacitySchema.safeParse(rawInput)
  if (!parsed.success) {
    throw new B2BContractSloError('invalid_input', 400, parsed.error.message)
  }
  const input = parsed.data
  const now = getIsoNow(options)

  const payloadHash = await sha256Hex(
    JSON.stringify({
      contractId: input.contractId,
      expectedVersion: input.expectedVersion,
      assessment: input.capacityAssessment
    })
  )

  const existingCommand = await database
    .prepare(
      `SELECT payload_hash, receipt_json FROM b2b_contract_slo_commands
       WHERE actor_id = ?1 AND idempotency_key = ?2`
    )
    .bind(claims.identityId, input.idempotencyKey)
    .first<{ payload_hash: string; receipt_json: string }>()

  if (existingCommand) {
    if (existingCommand.payload_hash !== payloadHash) {
      throw new B2BContractSloError('idempotency_conflict', 409, 'Idempotency conflict for operational capacity check')
    }
    return JSON.parse(existingCommand.receipt_json)
  }

  const existing = await database
    .prepare(`SELECT * FROM b2b_contract_slos WHERE id = ?1`)
    .bind(input.contractId)
    .first<{
      id: string
      customer_id: string
      company_name: string
      contract_ref: string
      tier_code: B2BSlaTierCode
      availability_target: number
      api_p95_latency_target_ms: number
      support_response_target_min: number
      dispatch_lead_target_hours: number
      status: B2BContractStatus
      operational_capacity_verified: number
      operational_check_notes: string | null
      billing_period_start: string
      billing_period_end: string
      created_by: string
      version: number
      created_at: string
      updated_at: string
    }>()

  if (!existing) {
    throw new B2BContractSloError('not_found', 404, 'Contract not found')
  }

  if (existing.version !== input.expectedVersion) {
    throw new B2BContractSloError(
      'concurrency_conflict',
      409,
      `Version mismatch: expected ${input.expectedVersion}, got ${existing.version}`
    )
  }

  const tier = await database
    .prepare(`SELECT * FROM b2b_account_sla_tiers WHERE tier_code = ?1`)
    .bind(existing.tier_code)
    .first<{
      tier_code: B2BSlaTierCode
      required_dedicated_manager: number
      required_min_headroom_percent: number
    }>()

  const requiredHeadroom = tier?.required_min_headroom_percent ?? 20.0
  const requiresManager = (tier?.required_dedicated_manager ?? 0) === 1

  const failureReasons: string[] = []
  if (!input.capacityAssessment.errorBudgetHealthy) {
    failureReasons.push('error_budget_exhausted_or_paused')
  }
  if (input.capacityAssessment.currentHeadroomPercent < requiredHeadroom) {
    failureReasons.push(
      `headroom_${input.capacityAssessment.currentHeadroomPercent.toFixed(1)}_below_${requiredHeadroom}%`
    )
  }
  if (requiresManager && !input.capacityAssessment.hasDedicatedManager) {
    failureReasons.push('missing_dedicated_account_manager')
  }

  const isCapacityValid = failureReasons.length === 0
  const nextStatus: B2BContractStatus = isCapacityValid ? 'active' : 'suspended_capacity'
  const notes = isCapacityValid
    ? 'Capacidad operativa verificada y confirmada para cumplimiento de SLA'
    : `insufficient_operational_capacity: ${failureReasons.join(', ')}`

  const newVersion = existing.version + 1
  const updated: B2BContractSloRecord = {
    id: existing.id,
    customerId: existing.customer_id,
    companyName: existing.company_name,
    contractRef: existing.contract_ref,
    tierCode: existing.tier_code,
    availabilityTarget: existing.availability_target,
    apiP95LatencyTargetMs: existing.api_p95_latency_target_ms,
    supportResponseTargetMin: existing.support_response_target_min,
    dispatchLeadTargetHours: existing.dispatch_lead_target_hours,
    status: nextStatus,
    operationalCapacityVerified: isCapacityValid,
    operationalCheckNotes: notes,
    billingPeriodStart: existing.billing_period_start,
    billingPeriodEnd: existing.billing_period_end,
    createdBy: existing.created_by,
    version: newVersion,
    createdAt: existing.created_at,
    updatedAt: now
  }

  await database.batch([
    database
      .prepare(
        `UPDATE b2b_contract_slos
         SET status = ?2,
             operational_capacity_verified = ?3,
             operational_check_notes = ?4,
             version = ?5,
             updated_at = ?6
         WHERE id = ?1 AND version = ?7`
      )
      .bind(input.contractId, nextStatus, isCapacityValid ? 1 : 0, notes, newVersion, now, input.expectedVersion),
    database
      .prepare(
        `INSERT INTO b2b_contract_slo_commands (
          command_id, actor_id, action, idempotency_key, expected_version,
          result_version, payload_hash, input_json, receipt_json, created_at
        ) VALUES (?1, ?2, 'verify_operational_capacity', ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
      )
      .bind(
        input.commandId,
        claims.identityId,
        input.idempotencyKey,
        input.expectedVersion,
        newVersion,
        payloadHash,
        JSON.stringify(input),
        JSON.stringify(updated),
        now
      )
  ])

  return updated
}

export async function recordD1B2BSloEvent(
  database: D1Database,
  claims: VerifiedSessionClaims,
  rawInput: RecordB2BSloEventInput,
  options?: B2BSloOperationOptions
): Promise<{ id: string; contractId: string; eventDate: string }> {
  const parsed = recordB2BSloEventSchema.safeParse(rawInput)
  if (!parsed.success) {
    throw new B2BContractSloError('invalid_input', 400, parsed.error.message)
  }
  const input = parsed.data
  const now = getIsoNow(options)

  const payloadHash = await sha256Hex(
    JSON.stringify({
      contractId: input.contractId,
      eventDate: input.eventDate,
      journey: input.serviceJourney,
      total: input.totalTransactions,
      success: input.successfulTransactions,
      p95: input.p95LatencyMs,
      downtime: input.downtimeMinutes
    })
  )

  const existingCommand = await database
    .prepare(
      `SELECT payload_hash, receipt_json FROM b2b_contract_slo_commands
       WHERE actor_id = ?1 AND idempotency_key = ?2`
    )
    .bind(claims.identityId, input.idempotencyKey)
    .first<{ payload_hash: string; receipt_json: string }>()

  if (existingCommand) {
    if (existingCommand.payload_hash !== payloadHash) {
      throw new B2BContractSloError('idempotency_conflict', 409, 'Idempotency conflict for SLO event record')
    }
    return JSON.parse(existingCommand.receipt_json)
  }

  const eventId = crypto.randomUUID()
  const receipt = {
    id: eventId,
    contractId: input.contractId,
    eventDate: input.eventDate
  }

  await database.batch([
    database
      .prepare(
        `INSERT INTO b2b_slo_event_records (
          id, contract_id, event_date, service_journey, total_transactions,
          successful_transactions, p95_latency_ms, downtime_minutes,
          support_tickets_count, support_breaches_count,
          fulfillment_dispatches_count, fulfillment_delays_count, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`
      )
      .bind(
        eventId,
        input.contractId,
        input.eventDate,
        input.serviceJourney,
        input.totalTransactions,
        input.successfulTransactions,
        input.p95LatencyMs,
        input.downtimeMinutes,
        input.supportTicketsCount,
        input.supportBreachesCount,
        input.fulfillmentDispatchesCount,
        input.fulfillmentDelaysCount,
        now
      ),
    database
      .prepare(
        `INSERT INTO b2b_contract_slo_commands (
          command_id, actor_id, action, idempotency_key, expected_version,
          result_version, payload_hash, input_json, receipt_json, created_at
        ) VALUES (?1, ?2, 'record_slo_event', ?3, 0, 1, ?4, ?5, ?6, ?7)`
      )
      .bind(
        input.commandId,
        claims.identityId,
        input.idempotencyKey,
        payloadHash,
        JSON.stringify(input),
        JSON.stringify(receipt),
        now
      )
  ])

  return receipt
}

export async function recordD1B2BExclusion(
  database: D1Database,
  claims: VerifiedSessionClaims,
  rawInput: RecordB2BExclusionInput,
  options?: B2BSloOperationOptions
): Promise<{ id: string; contractId: string; excludedDowntimeMinutes: number }> {
  const parsed = recordB2BExclusionSchema.safeParse(rawInput)
  if (!parsed.success) {
    throw new B2BContractSloError('invalid_input', 400, parsed.error.message)
  }
  const input = parsed.data
  const now = getIsoNow(options)

  const payloadHash = await sha256Hex(
    JSON.stringify({
      contractId: input.contractId,
      reason: input.reasonCategory,
      start: input.startTime,
      end: input.endTime,
      excludedMinutes: input.excludedDowntimeMinutes,
      justification: input.justification
    })
  )

  const existingCommand = await database
    .prepare(
      `SELECT payload_hash, receipt_json FROM b2b_contract_slo_commands
       WHERE actor_id = ?1 AND idempotency_key = ?2`
    )
    .bind(claims.identityId, input.idempotencyKey)
    .first<{ payload_hash: string; receipt_json: string }>()

  if (existingCommand) {
    if (existingCommand.payload_hash !== payloadHash) {
      throw new B2BContractSloError('idempotency_conflict', 409, 'Idempotency conflict for B2B exclusion')
    }
    return JSON.parse(existingCommand.receipt_json)
  }

  const exclusionId = crypto.randomUUID()
  const receipt = {
    id: exclusionId,
    contractId: input.contractId,
    excludedDowntimeMinutes: input.excludedDowntimeMinutes
  }

  await database.batch([
    database
      .prepare(
        `INSERT INTO b2b_slo_exclusions (
          id, contract_id, reason_category, start_time, end_time,
          excluded_downtime_minutes, justification, approved_by, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
      )
      .bind(
        exclusionId,
        input.contractId,
        input.reasonCategory,
        input.startTime,
        input.endTime,
        input.excludedDowntimeMinutes,
        input.justification,
        claims.identityId,
        now
      ),
    database
      .prepare(
        `INSERT INTO b2b_contract_slo_commands (
          command_id, actor_id, action, idempotency_key, expected_version,
          result_version, payload_hash, input_json, receipt_json, created_at
        ) VALUES (?1, ?2, 'record_exclusion', ?3, 0, 1, ?4, ?5, ?6, ?7)`
      )
      .bind(
        input.commandId,
        claims.identityId,
        input.idempotencyKey,
        payloadHash,
        JSON.stringify(input),
        JSON.stringify(receipt),
        now
      )
  ])

  return receipt
}

export async function generateD1ComplianceReport(
  database: D1Database,
  claims: VerifiedSessionClaims,
  rawInput: GenerateComplianceReportInput,
  options?: B2BSloOperationOptions
): Promise<B2BComplianceReport> {
  const parsed = generateComplianceReportSchema.safeParse(rawInput)
  if (!parsed.success) {
    throw new B2BContractSloError('invalid_input', 400, parsed.error.message)
  }
  const input = parsed.data
  const now = getIsoNow(options)

  const payloadHash = await sha256Hex(
    JSON.stringify({
      contractId: input.contractId,
      month: input.reportMonth
    })
  )

  const existingCommand = await database
    .prepare(
      `SELECT payload_hash, receipt_json FROM b2b_contract_slo_commands
       WHERE actor_id = ?1 AND idempotency_key = ?2`
    )
    .bind(claims.identityId, input.idempotencyKey)
    .first<{ payload_hash: string; receipt_json: string }>()

  if (existingCommand) {
    if (existingCommand.payload_hash !== payloadHash) {
      throw new B2BContractSloError(
        'idempotency_conflict',
        409,
        'Idempotency conflict for compliance report generation'
      )
    }
    const receipt = JSON.parse(existingCommand.receipt_json) as B2BComplianceReport & { penaltyCreditEur?: number }
    // Historical command receipts are immutable; convert their old currency unit on replay.
    if (receipt.penaltyCreditEur !== undefined) {
      const { penaltyCreditEur, ...rest } = receipt
      return { ...rest, penaltyCreditCents: decimalScaledRounded(penaltyCreditEur, 100n) }
    }
    return receipt
  }

  const contract = await database
    .prepare(`SELECT * FROM b2b_contract_slos WHERE id = ?1`)
    .bind(input.contractId)
    .first<{
      id: string
      tier_code: B2BSlaTierCode
      availability_target: number
      api_p95_latency_target_ms: number
      support_response_target_min: number
      dispatch_lead_target_hours: number
    }>()

  if (!contract) {
    throw new B2BContractSloError('not_found', 404, 'Contract not found')
  }

  const tier = await database
    .prepare(`SELECT * FROM b2b_account_sla_tiers WHERE tier_code = ?1`)
    .bind(contract.tier_code)
    .first<{ penalty_credit_percent_per_breach: number }>()

  const penaltyPercent = tier?.penalty_credit_percent_per_breach ?? 0

  // Aggregate events for the month
  const events = await database
    .prepare(
      `SELECT sum(downtime_minutes) as gross_downtime,
              max(p95_latency_ms) as max_p95_latency,
              sum(support_breaches_count) as total_support_breaches,
              sum(fulfillment_delays_count) as total_fulfillment_delays
       FROM b2b_slo_event_records
       WHERE contract_id = ?1 AND event_date LIKE ?2`
    )
    .bind(input.contractId, `${input.reportMonth}%`)
    .first<{
      gross_downtime: number | null
      max_p95_latency: number | null
      total_support_breaches: number | null
      total_fulfillment_delays: number | null
    }>()

  // Aggregate exclusions
  const exclusions = await database
    .prepare(
      `SELECT sum(excluded_downtime_minutes) as total_excluded
       FROM b2b_slo_exclusions
       WHERE contract_id = ?1 AND start_time LIKE ?2`
    )
    .bind(input.contractId, `${input.reportMonth}%`)
    .first<{ total_excluded: number | null }>()

  const grossDowntime = events?.gross_downtime ?? 0
  const excludedDowntime = exclusions?.total_excluded ?? 0
  const netDowntime = Math.max(0, grossDowntime - excludedDowntime)

  // Standard month duration: calculate actual days in month
  const [yearStr, monthStr] = input.reportMonth.split('-')
  const daysInMonth = new Date(Number(yearStr), Number(monthStr), 0).getDate()
  const totalPeriodMinutes = daysInMonth * 24 * 60

  const availabilityAchieved = totalPeriodMinutes > 0 ? (totalPeriodMinutes - netDowntime) / totalPeriodMinutes : 1.0
  const availabilityCompliant = availabilityAchieved >= contract.availability_target

  const latencyP95Achieved = events?.max_p95_latency ?? 0
  const latencyCompliant = latencyP95Achieved <= contract.api_p95_latency_target_ms

  const supportCompliant = (events?.total_support_breaches ?? 0) === 0
  const fulfillmentCompliant = (events?.total_fulfillment_delays ?? 0) === 0

  const overallCompliant = availabilityCompliant && latencyCompliant && supportCompliant && fulfillmentCompliant

  const allowedDowntimeMinutes = totalPeriodMinutes * (1 - contract.availability_target)
  let alertLevel: B2BAlertLevel = 'nominal'

  if (!overallCompliant) {
    alertLevel = 'breached'
  } else if (netDowntime > allowedDowntimeMinutes * 0.7) {
    alertLevel = 'warning_risk_of_breach'
  }

  // Base contract fee for credit calculation: e.g. 1500 EUR standard B2B account volume
  const penaltyCreditCents = overallCompliant ? 0 : decimalScaledRounded(penaltyPercent, 1500n)

  const reportId = crypto.randomUUID()
  const report: B2BComplianceReport = {
    id: reportId,
    contractId: input.contractId,
    reportMonth: input.reportMonth,
    availabilityAchieved: Number(availabilityAchieved.toFixed(5)),
    targetAvailability: contract.availability_target,
    availabilityCompliant,
    latencyP95AchievedMs: latencyP95Achieved,
    latencyCompliant,
    supportCompliant,
    fulfillmentCompliant,
    overallCompliant,
    totalDowntimeMinutes: grossDowntime,
    excludedDowntimeMinutes: excludedDowntime,
    netChargeableDowntimeMinutes: netDowntime,
    penaltyCreditCents,
    alertLevel,
    generatedAt: now
  }

  await database.batch([
    database
      .prepare(
        `INSERT INTO b2b_slo_compliance_reports (
          id, contract_id, report_month, availability_achieved, target_availability,
          availability_compliant, latency_p95_achieved_ms, latency_compliant,
          support_compliant, fulfillment_compliant, overall_compliant,
          total_downtime_minutes, excluded_downtime_minutes,
          net_chargeable_downtime_minutes, penalty_credit_cents, alert_level,
          generated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)`
      )
      .bind(
        reportId,
        report.contractId,
        report.reportMonth,
        report.availabilityAchieved,
        report.targetAvailability,
        report.availabilityCompliant ? 1 : 0,
        report.latencyP95AchievedMs,
        report.latencyCompliant ? 1 : 0,
        report.supportCompliant ? 1 : 0,
        report.fulfillmentCompliant ? 1 : 0,
        report.overallCompliant ? 1 : 0,
        report.totalDowntimeMinutes,
        report.excludedDowntimeMinutes,
        report.netChargeableDowntimeMinutes,
        report.penaltyCreditCents,
        report.alertLevel,
        now
      ),
    database
      .prepare(
        `INSERT INTO b2b_contract_slo_commands (
          command_id, actor_id, action, idempotency_key, expected_version,
          result_version, payload_hash, input_json, receipt_json, created_at
        ) VALUES (?1, ?2, 'generate_compliance_report', ?3, 0, 1, ?4, ?5, ?6, ?7)`
      )
      .bind(
        input.commandId,
        claims.identityId,
        input.idempotencyKey,
        payloadHash,
        JSON.stringify(input),
        JSON.stringify(report),
        now
      )
  ])

  return report
}

export async function readD1B2BContractSlo(database: D1Database, id: string): Promise<B2BContractSloRecord | null> {
  const row = await database.prepare(`SELECT * FROM b2b_contract_slos WHERE id = ?1`).bind(id).first<{
    id: string
    customer_id: string
    company_name: string
    contract_ref: string
    tier_code: B2BSlaTierCode
    availability_target: number
    api_p95_latency_target_ms: number
    support_response_target_min: number
    dispatch_lead_target_hours: number
    status: B2BContractStatus
    operational_capacity_verified: number
    operational_check_notes: string | null
    billing_period_start: string
    billing_period_end: string
    created_by: string
    version: number
    created_at: string
    updated_at: string
  }>()

  if (!row) return null
  return {
    id: row.id,
    customerId: row.customer_id,
    companyName: row.company_name,
    contractRef: row.contract_ref,
    tierCode: row.tier_code,
    availabilityTarget: row.availability_target,
    apiP95LatencyTargetMs: row.api_p95_latency_target_ms,
    supportResponseTargetMin: row.support_response_target_min,
    dispatchLeadTargetHours: row.dispatch_lead_target_hours,
    status: row.status,
    operationalCapacityVerified: row.operational_capacity_verified === 1,
    operationalCheckNotes: row.operational_check_notes,
    billingPeriodStart: row.billing_period_start,
    billingPeriodEnd: row.billing_period_end,
    createdBy: row.created_by,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export async function listD1B2BContractSlos(database: D1Database, limit = 50): Promise<B2BContractSloRecord[]> {
  const rows = await database
    .prepare(`SELECT * FROM b2b_contract_slos ORDER BY created_at DESC LIMIT ?1`)
    .bind(limit)
    .all<{
      id: string
      customer_id: string
      company_name: string
      contract_ref: string
      tier_code: B2BSlaTierCode
      availability_target: number
      api_p95_latency_target_ms: number
      support_response_target_min: number
      dispatch_lead_target_hours: number
      status: B2BContractStatus
      operational_capacity_verified: number
      operational_check_notes: string | null
      billing_period_start: string
      billing_period_end: string
      created_by: string
      version: number
      created_at: string
      updated_at: string
    }>()

  return (rows.results ?? []).map((row) => ({
    id: row.id,
    customerId: row.customer_id,
    companyName: row.company_name,
    contractRef: row.contract_ref,
    tierCode: row.tier_code,
    availabilityTarget: row.availability_target,
    apiP95LatencyTargetMs: row.api_p95_latency_target_ms,
    supportResponseTargetMin: row.support_response_target_min,
    dispatchLeadTargetHours: row.dispatch_lead_target_hours,
    status: row.status,
    operationalCapacityVerified: row.operational_capacity_verified === 1,
    operationalCheckNotes: row.operational_check_notes,
    billingPeriodStart: row.billing_period_start,
    billingPeriodEnd: row.billing_period_end,
    createdBy: row.created_by,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }))
}
