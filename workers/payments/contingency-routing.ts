import type {
  ContingencyRoutingRule,
  ContingencyToggleInput,
  PaymentRouteDecision,
  UnifiedSettlementInput,
  UnifiedSettlementRecord
} from '../../shared/payment-contingency'

export async function getContingencyRoutingRule(
  database: D1Database,
  marketCode: string
): Promise<ContingencyRoutingRule | null> {
  const row = await database
    .prepare('SELECT * FROM payment_contingency_routing WHERE market_code = ?1')
    .bind(marketCode)
    .first<{
      id: string
      market_code: string
      primary_provider: 'redsys' | 'euro_contingency'
      alternative_provider: 'redsys' | 'euro_contingency'
      active_provider: 'redsys' | 'euro_contingency'
      contingency_active: number
      contingency_reason: string | null
      contingency_activated_at: string | null
      contingency_activated_by: string | null
      failure_count_window: number
      circuit_state: 'closed' | 'open' | 'half_open'
      version: number
      created_at: string
      updated_at: string
    }>()

  if (!row) return null

  return {
    id: row.id,
    marketCode: row.market_code,
    primaryProvider: row.primary_provider,
    alternativeProvider: row.alternative_provider,
    activeProvider: row.active_provider,
    contingencyActive: row.contingency_active === 1,
    contingencyReason: row.contingency_reason,
    contingencyActivatedAt: row.contingency_activated_at,
    contingencyActivatedBy: row.contingency_activated_by,
    failureCountWindow: row.failure_count_window,
    circuitState: row.circuit_state,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export async function determinePaymentProviderRoute(
  database: D1Database,
  input: { marketCode?: string; orderId: string }
): Promise<PaymentRouteDecision> {
  const market = input.marketCode ?? 'ES'
  let rule = await getContingencyRoutingRule(database, market)

  if (!rule && market !== 'ES') {
    rule = await getContingencyRoutingRule(database, 'ES')
  }

  if (!rule) {
    return {
      selectedProvider: 'redsys',
      isContingency: false,
      contingencyReason: null,
      circuitState: 'closed'
    }
  }

  const isContingency = rule.contingencyActive || rule.circuitState === 'open'
  const selectedProvider = isContingency ? rule.alternativeProvider : rule.activeProvider

  return {
    selectedProvider,
    isContingency,
    contingencyReason: rule.contingencyReason,
    circuitState: rule.circuitState
  }
}

export async function toggleContingencyRouting(
  database: D1Database,
  input: ContingencyToggleInput & { actorId: string; now: string }
): Promise<ContingencyRoutingRule> {
  const existing = await getContingencyRoutingRule(database, input.marketCode)
  if (!existing) {
    throw new Error('route_rule_not_found')
  }

  if (existing.version !== input.expectedVersion) {
    throw new Error('conflict: expected version mismatch')
  }

  const nextVersion = existing.version + 1
  const newActiveProvider = input.activateContingency ? existing.alternativeProvider : existing.primaryProvider

  await database
    .prepare(
      `
      UPDATE payment_contingency_routing
      SET contingency_active = ?1,
          active_provider = ?2,
          contingency_reason = ?3,
          contingency_activated_at = ?4,
          contingency_activated_by = ?5,
          version = ?6,
          updated_at = ?7
      WHERE market_code = ?8 AND version = ?9
    `
    )
    .bind(
      input.activateContingency ? 1 : 0,
      newActiveProvider,
      input.reason,
      input.now,
      input.actorId,
      nextVersion,
      input.now,
      input.marketCode,
      existing.version
    )
    .run()

  const updated = await getContingencyRoutingRule(database, input.marketCode)
  if (!updated) throw new Error('update_failed')
  if (updated.version !== nextVersion) {
    throw new Error('conflict: expected version mismatch')
  }
  return updated
}

export async function recordUnifiedPaymentSettlement(
  database: D1Database,
  input: UnifiedSettlementInput & { now: string }
): Promise<UnifiedSettlementRecord> {
  const existing = await database
    .prepare('SELECT * FROM payment_unified_settlement_reconciliation WHERE provider = ?1 AND provider_reference = ?2')
    .bind(input.provider, input.providerReference)
    .first<{
      id: string
      intent_id: string
      order_id: string
      provider: 'redsys' | 'euro_contingency'
      provider_reference: string
      amount_cents: number
      currency: 'EUR'
      status: 'authorized' | 'captured' | 'refunded' | 'settled' | 'discrepancy'
      payload_hash: string
      settled_at: string | null
      reconciled_at: string
      created_at: string
    }>()

  if (existing) {
    if (
      existing.payload_hash === input.payloadHash &&
      existing.amount_cents === input.amountCents &&
      existing.order_id === input.orderId
    ) {
      return {
        id: existing.id,
        intentId: existing.intent_id,
        orderId: existing.order_id,
        provider: existing.provider,
        providerReference: existing.provider_reference,
        amountCents: existing.amount_cents,
        currency: existing.currency,
        status: existing.status,
        payloadHash: existing.payload_hash,
        settledAt: existing.settled_at,
        reconciledAt: existing.reconciled_at,
        createdAt: existing.created_at
      }
    }
    throw new Error('conflict: settlement reference already exists with different payload or amount')
  }

  const id = crypto.randomUUID()
  const settledAt = input.settledAt ?? input.now

  await database
    .prepare(
      `
      INSERT INTO payment_unified_settlement_reconciliation (
        id, intent_id, order_id, provider, provider_reference,
        amount_cents, currency, status, payload_hash, settled_at,
        reconciled_at, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)
    `
    )
    .bind(
      id,
      input.intentId,
      input.orderId,
      input.provider,
      input.providerReference,
      input.amountCents,
      input.currency,
      input.status,
      input.payloadHash,
      settledAt,
      input.now
    )
    .run()

  return {
    id,
    intentId: input.intentId,
    orderId: input.orderId,
    provider: input.provider,
    providerReference: input.providerReference,
    amountCents: input.amountCents,
    currency: input.currency,
    status: input.status,
    payloadHash: input.payloadHash,
    settledAt,
    reconciledAt: input.now,
    createdAt: input.now
  }
}

export async function listUnifiedPaymentReconciliations(
  database: D1Database,
  filter?: { orderId?: string }
): Promise<UnifiedSettlementRecord[]> {
  let query = 'SELECT * FROM payment_unified_settlement_reconciliation'
  const params: unknown[] = []

  if (filter?.orderId) {
    query += ' WHERE order_id = ?1'
    params.push(filter.orderId)
  }
  query += ' ORDER BY reconciled_at DESC'

  const res = await database
    .prepare(query)
    .bind(...params)
    .all<{
      id: string
      intent_id: string
      order_id: string
      provider: 'redsys' | 'euro_contingency'
      provider_reference: string
      amount_cents: number
      currency: 'EUR'
      status: 'authorized' | 'captured' | 'refunded' | 'settled' | 'discrepancy'
      payload_hash: string
      settled_at: string | null
      reconciled_at: string
      created_at: string
    }>()

  return (res.results ?? []).map((r) => ({
    id: r.id,
    intentId: r.intent_id,
    orderId: r.order_id,
    provider: r.provider,
    providerReference: r.provider_reference,
    amountCents: r.amount_cents,
    currency: r.currency,
    status: r.status,
    payloadHash: r.payload_hash,
    settledAt: r.settled_at,
    reconciledAt: r.reconciled_at,
    createdAt: r.created_at
  }))
}
