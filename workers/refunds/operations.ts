import { z } from 'zod'
import {
  refundPlanInputSchema,
  refundConfirmInputSchema,
  refundReconcileInputSchema,
  refundContractSchema,
  refundReceiptSchema,
  refundCommandReceiptSchema,
  refundWorkflowSchema,
  refundCents,
  refundCardCents,
  type RefundContract,
  type RefundPlanInput,
  type RefundConfirmInput,
  type RefundReconcileInput,
  type RefundCommandReceipt,
  type RefundReceipt,
  type GovernedRefundProvider
} from '../../shared/order-refunds'
import { fiscalUuid, fiscalHash, fiscalInstant } from '../../shared/fiscal-issuance'
import type { VerifiedSessionClaims } from '../catalog/authorization'
import { canonicalJson } from '../catalog/inventory'
import { guardedFiscalDatabase } from '../fiscal/d1-boundary'
import { readD1AdminReturn } from '../returns/operations'
import { prepareEmailOutboxEnqueue } from '../communications/email-outbox'
import { roundRatio } from '../../server/domain/money'
import { safeRecordRefundAnomalySignal } from '../auth/security-anomalies'
import { readFinancialPolicy } from './policies'
import { capturedSource, captureMatchesPolicy } from './source'
import { allocateRefundTender } from '../../shared/refund-tender'
import { storeCreditOnlyReceipt, storeCreditRestitutionStatements } from './store-credit-restitution'
import {
  admin,
  checked,
  clock,
  hash,
  replay,
  commandStatement,
  eventStatement,
  guard,
  authorizationGuard,
  RefundError,
  later,
  parsedJson,
  providerMetadata,
  providerMethod,
  type RefundCommandOptions
} from './authority'

export { RefundError } from './authority'
const allocationSchema = z
  .object({
    line_index: z.number().int().nullable(),
    quantity: z.number().int().min(1),
    unit_offset: z.number().int().min(0),
    gross_cents: refundCents,
    net_cents: refundCents,
    tax_cents: refundCents,
    return_id: fiscalUuid,
    component: z.enum(['line', 'shipping'])
  })
  .strict()
const workSchema = z
  .object({
    status: refundWorkflowSchema,
    generation: z
      .number()
      .int()
      .min(1)
      .max(Number.MAX_SAFE_INTEGER - 1),
    attempts: z.number().int().min(0).max(10),
    lease_token: fiscalUuid.nullable(),
    lease_until: fiscalInstant.nullable(),
    submitted_at: fiscalInstant.nullable(),
    confirmed_by: fiscalUuid.nullable(),
    confirmed_at: fiscalInstant.nullable(),
    completed_at: fiscalInstant.nullable(),
    last_error_code: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,79}$/)
      .nullable()
  })
  .strict()
export async function readRefundContract(database: D1Database, id: string) {
  database = guardedFiscalDatabase(database)
  checked(fiscalUuid, id)
  const raw = await database
    .prepare('SELECT contract_json,contract_fingerprint FROM refund_contracts WHERE id=?1')
    .bind(id)
    .first()
  if (raw === null) throw new RefundError('not_found')
  const row = checked(
    z.object({ contract_json: z.string().max(131072), contract_fingerprint: fiscalHash }).strict(),
    raw,
    'read_unconfirmed'
  )
  const contract = checked(refundContractSchema, parsedJson(row.contract_json), 'read_unconfirmed')
  if (contract.refundId !== id || (await hash(contract)) !== row.contract_fingerprint)
    throw new RefundError('read_unconfirmed')
  return { contract, fingerprint: row.contract_fingerprint }
}
export async function readRefundWork(database: D1Database, id: string) {
  const raw = await guardedFiscalDatabase(database)
    .prepare(
      'SELECT status,generation,attempts,lease_token,lease_until,submitted_at,confirmed_by,confirmed_at,completed_at,last_error_code FROM refund_work WHERE refund_id=?1'
    )
    .bind(id)
    .first()
  if (raw === null) throw new RefundError('read_unconfirmed')
  return checked(workSchema, raw, 'read_unconfirmed')
}
function receipt(
  contract: RefundContract,
  fingerprint: string,
  action: RefundCommandReceipt['action'],
  generation: number
): RefundCommandReceipt {
  return checked(refundCommandReceiptSchema, {
    source: 'cloudflare',
    id: contract.refundId,
    action,
    generation,
    contractFingerprint: fingerprint,
    validationOnly: contract.validationOnly,
    inventoryEffect: 'none'
  })
}
function portion(net: number, tax: number, gross: number) {
  if (gross < 1 || gross > net + tax) throw new RefundError('amount_unavailable')
  const allocatedNet = Math.min(net, Math.max(gross - tax, roundRatio(BigInt(gross) * BigInt(net), BigInt(net + tax))))
  return { grossCents: gross, netCents: allocatedNet, taxCents: gross - allocatedNet }
}
function freeOffset(allocations: z.infer<typeof allocationSchema>[], quantity: number, purchased: number) {
  let offset = 0
  for (const allocation of [...allocations].sort((a, b) => a.unit_offset - b.unit_offset)) {
    if (offset + quantity <= allocation.unit_offset) return offset
    offset = Math.max(offset, allocation.unit_offset + allocation.quantity)
  }
  if (offset + quantity > purchased) throw new RefundError('quantity_unavailable')
  return offset
}
function slice(value: number, offset: number, quantity: number, total: number) {
  return Number(
    (BigInt(value) * BigInt(offset + quantity)) / BigInt(total) - (BigInt(value) * BigInt(offset)) / BigInt(total)
  )
}
async function commandRace(
  database: D1Database,
  claims: VerifiedSessionClaims,
  key: string,
  kind: string,
  payloadHash: string,
  now: () => string,
  failure: unknown
): Promise<RefundCommandReceipt> {
  await admin(database, claims, now)
  const raced = await replay(database, claims, key, kind, payloadHash)
  if (raced !== null) return checked(refundCommandReceiptSchema, raced, 'read_unconfirmed')
  if (failure instanceof RefundError) throw failure
  throw new RefundError('conflict')
}
export async function planD1Refund(
  database: D1Database,
  claims: VerifiedSessionClaims,
  raw: RefundPlanInput,
  options: RefundCommandOptions = {}
): Promise<RefundCommandReceipt> {
  database = guardedFiscalDatabase(database)
  const input = checked(refundPlanInputSchema, raw),
    now = clock(options)
  await admin(database, claims, now)
  const payloadHash = await hash(input),
    prior = await replay(database, claims, input.idempotencyKey, 'refund_plan', payloadHash)
  if (prior !== null) {
    await admin(database, claims, now)
    return checked(refundCommandReceiptSchema, prior, 'read_unconfirmed')
  }
  const policy = await readFinancialPolicy(database, input.policyId, 'refund')
  if (!policy) throw new RefundError('policy_unavailable')
  const returned = await readD1AdminReturn(database, claims, input.returnPublicRef, {
    page: 1,
    perPage: 50,
    ...(options.now === undefined ? {} : { now: options.now })
  })
  if (
    returned.state !== 'resolution_ready' ||
    !returned.readiness.ready ||
    returned.version !== input.expectedReturnVersion
  )
    throw new RefundError('return_unconfirmed')
  const source = await capturedSource(database, returned.orderId)
  captureMatchesPolicy(source.capture, policy)
  const allocations = checked(
    z.array(allocationSchema).max(999),
    (
      await database
        .prepare(
          `SELECT a.line_index,a.quantity,a.unit_offset,a.gross_cents,a.net_cents,a.tax_cents,c.return_id,a.component FROM refund_allocations a JOIN refund_contracts c ON c.id=a.refund_id JOIN refund_work w ON w.refund_id=c.id WHERE c.order_id=?1 AND w.status<>'cancelled' ORDER BY a.line_index,a.unit_offset LIMIT 1000`
        )
        .bind(returned.orderId)
        .all()
    ).results,
    'read_unconfirmed'
  )
  const components: RefundContract['components'] = []
  for (const selection of input.lines) {
    const original = source.lines.find((line) => line.line_index === selection.lineIndex),
      rmaLine = returned.lines.find((line) => line.lineIndex === selection.lineIndex)
    if (!original || !rmaLine) throw new RefundError('line_not_found')
    const existing = allocations.filter((line) => line.component === 'line' && line.line_index === selection.lineIndex)
    if (
      selection.quantity +
        existing.filter((line) => line.return_id === returned.id).reduce((sum, line) => sum + line.quantity, 0) >
      rmaLine.inspectedQuantity
    )
      throw new RefundError('quantity_unavailable')
    const offset = freeOffset(existing, selection.quantity, original.quantity),
      net = slice(original.net_cents, offset, selection.quantity, original.quantity),
      tax = slice(original.tax_cents, offset, selection.quantity, original.quantity)
    const amounts = portion(net, tax, selection.amountCents ?? net + tax)
    components.push({
      component: 'line',
      lineIndex: selection.lineIndex,
      quantity: selection.quantity,
      unitOffset: offset,
      sku: original.sku,
      description: original.name,
      ...amounts,
      taxRateBasisPoints: original.tax_rate_basis_points
    })
  }
  if (input.shippingCents !== undefined) {
    if (policy.shipping !== 'explicit_amount') throw new RefundError('shipping_not_approved')
    const priorShipping = allocations.filter((allocation) => allocation.component === 'shipping'),
      net = source.row.shipping_net_cents - priorShipping.reduce((sum, item) => sum + item.net_cents, 0),
      tax = source.row.shipping_tax_cents - priorShipping.reduce((sum, item) => sum + item.tax_cents, 0)
    components.push({
      component: 'shipping',
      lineIndex: null,
      quantity: 1,
      unitOffset: 0,
      sku: 'SHIPPING',
      description: 'Rectificación de gastos de envío',
      ...portion(net, tax, input.shippingCents),
      taxRateBasisPoints: source.shippingRate
    })
  }
  const amount = components.reduce((sum, line) => sum + line.grossCents, 0),
    held = allocations.reduce((sum, line) => sum + line.gross_cents, 0)
  if (amount > policy.maximumRefundCents || amount + held > source.capture.capturedCents + source.storeCreditCents)
    throw new RefundError('amount_unavailable')
  // PRI-018: an order paid partly with store credit refunds card and credit by the rule of
  // shared/refund-tender.ts; 0153 re-checks both budgets atomically against concurrent planners.
  let tender: RefundContract['tender']
  if (source.storeCreditCents > 0) {
    const heldCard = checked(
      z.object({ card: refundCents }).strict(),
      await database
        .prepare(
          "SELECT COALESCE(SUM(COALESCE(json_extract(c.contract_json,'$.tender.cardCents'),c.amount_gross_cents)),0) AS card FROM refund_contracts c JOIN refund_work w ON w.refund_id=c.id WHERE c.order_id=?1 AND w.status<>'cancelled'"
        )
        .bind(returned.orderId)
        .first(),
      'read_unconfirmed'
    ).card
    try {
      tender = allocateRefundTender({
        cardCapturedCents: source.capture.capturedCents,
        storeCreditCents: source.storeCreditCents,
        heldCardCents: heldCard,
        heldStoreCreditCents: held - heldCard,
        amountCents: amount
      })
    } catch {
      throw new RefundError('amount_unavailable')
    }
  }
  const id = crypto.randomUUID(),
    at = now(),
    contract = checked(refundContractSchema, {
      schemaVersion: 1,
      refundId: id,
      orderId: returned.orderId,
      returnId: returned.id,
      returnPublicRef: returned.publicRef,
      returnVersion: returned.version,
      policyId: policy.id,
      policyFingerprint: policy.fingerprint,
      provider: policy.provider,
      environment: policy.environment,
      validationOnly: policy.provider === 'local_fake',
      idempotencyKey: `refund:${id}`,
      reason: input.reason,
      evidenceRef: input.evidenceRef,
      createdAt: at,
      capture: source.capture,
      contact: { email: source.row.contact_email, name: source.row.contact_name },
      sourceHash: source.sourceHash,
      components,
      amountCents: amount,
      ...(tender ? { tender } : {}),
      currency: 'EUR',
      inventoryEffect: 'none',
      custody: 'non_sellable'
    }),
    fingerprint = await hash(contract),
    response = receipt(contract, fingerprint, 'planned', 1)
  await admin(database, claims, now)
  try {
    await database.batch([
      database
        .prepare(
          'INSERT INTO refund_contracts(id,order_id,payment_intent_id,return_id,return_version,policy_id,planned_by,contract_json,contract_fingerprint,idempotency_key,amount_gross_cents,validation_only,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)'
        )
        .bind(
          id,
          contract.orderId,
          contract.capture.paymentIntentId,
          contract.returnId,
          contract.returnVersion,
          contract.policyId,
          claims.identityId,
          canonicalJson(contract),
          fingerprint,
          contract.idempotencyKey,
          amount,
          contract.validationOnly ? 1 : 0,
          at
        ),
      database
        .prepare("INSERT INTO refund_work(refund_id,status,generation) VALUES(?1,'awaiting_confirmation',1)")
        .bind(id),
      ...components.map((line, index) =>
        database
          .prepare(
            'INSERT INTO refund_allocations(refund_id,component_index,component,line_index,quantity,unit_offset,gross_cents,net_cents,tax_cents) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)'
          )
          .bind(
            id,
            index,
            line.component,
            line.lineIndex,
            line.quantity,
            line.unitOffset,
            line.grossCents,
            line.netCents,
            line.taxCents
          )
      ),
      eventStatement(database, {
        scope: 'refund',
        target: id,
        kind: 'planned',
        actor: claims.identityId,
        generation: 1,
        reason: input.reason,
        evidenceRef: input.evidenceRef,
        now: at
      }),
      commandStatement(database, claims, input.idempotencyKey, 'refund_plan', id, payloadHash, response, at),
      guard(database, '(SELECT sum(gross_cents) FROM refund_allocations WHERE refund_id=?1)=?2', [id, amount]),
      authorizationGuard(database, claims, options)
    ])
  } catch (failure) {
    return commandRace(database, claims, input.idempotencyKey, 'refund_plan', payloadHash, now, failure)
  }
  await admin(database, claims, now)
  // SEC-035: alert-only; a failing signal store never changes the planned refund.
  await safeRecordRefundAnomalySignal(database, {
    actorId: claims.identityId,
    sessionId: claims.sessionId,
    refundId: id,
    orderId: returned.orderId,
    stage: 'plan',
    sourceCommandId: input.idempotencyKey,
    grossCents: amount,
    ipHash: options.ipHash ?? null,
    thresholds: options.anomalyThresholds,
    occurredAt: at
  })
  return response
}
export async function confirmD1Refund(
  database: D1Database,
  claims: VerifiedSessionClaims,
  id: string,
  raw: RefundConfirmInput,
  options: RefundCommandOptions = {}
): Promise<RefundCommandReceipt> {
  database = guardedFiscalDatabase(database)
  const input = checked(refundConfirmInputSchema, raw),
    now = clock(options)
  await admin(database, claims, now)
  const payloadHash = await hash({ id, input }),
    prior = await replay(database, claims, input.idempotencyKey, 'refund_confirm', payloadHash)
  if (prior !== null) {
    await admin(database, claims, now)
    return checked(refundCommandReceiptSchema, prior, 'read_unconfirmed')
  }
  const { contract, fingerprint } = await readRefundContract(database, id),
    work = await readRefundWork(database, id),
    policy = await readFinancialPolicy(database, contract.policyId, 'refund')
  if (!policy || policy.fingerprint !== contract.policyFingerprint) throw new RefundError('policy_unavailable')
  if (
    work.status !== 'awaiting_confirmation' ||
    work.generation !== input.expectedGeneration ||
    fingerprint !== input.contractFingerprint
  )
    throw new RefundError('version_conflict')
  const planned = await database.prepare('SELECT planned_by FROM refund_contracts WHERE id=?1').bind(id).first()
  const plannedBy = checked(z.object({ planned_by: fiscalUuid }).strict(), planned, 'read_unconfirmed').planned_by
  if (policy.approvalMode === 'distinct_actor' && plannedBy === claims.identityId)
    throw new RefundError('distinct_approver_required')
  const at = now(),
    response = receipt(contract, fingerprint, 'confirmed', work.generation + 1)
  try {
    await database.batch([
      database
        .prepare(
          "UPDATE refund_work SET status='queued',generation=generation+1,confirmed_by=?3,confirmed_at=?4 WHERE refund_id=?1 AND generation=?2 AND status='awaiting_confirmation' AND NOT EXISTS(SELECT 1 FROM financial_policy_withdrawals WHERE policy_id=?5)"
        )
        .bind(id, work.generation, claims.identityId, at, contract.policyId),
      eventStatement(database, {
        scope: 'refund',
        target: id,
        kind: 'confirmed',
        actor: claims.identityId,
        generation: response.generation,
        reason: input.reason,
        evidenceRef: input.evidenceRef,
        now: at
      }),
      commandStatement(database, claims, input.idempotencyKey, 'refund_confirm', id, payloadHash, response, at),
      guard(
        database,
        "EXISTS(SELECT 1 FROM refund_work WHERE refund_id=?1 AND generation=?2 AND status='queued' AND confirmed_by=?3)",
        [id, response.generation, claims.identityId]
      ),
      authorizationGuard(database, claims, options)
    ])
  } catch (failure) {
    return commandRace(database, claims, input.idempotencyKey, 'refund_confirm', payloadHash, now, failure)
  }
  await admin(database, claims, now)
  await safeRecordRefundAnomalySignal(database, {
    actorId: claims.identityId,
    sessionId: claims.sessionId,
    refundId: id,
    orderId: contract.orderId,
    stage: 'confirm',
    sourceCommandId: input.idempotencyKey,
    grossCents: contract.amountCents,
    ipHash: options.ipHash ?? null,
    thresholds: options.anomalyThresholds,
    occurredAt: at
  })
  return response
}
export async function cancelD1Refund(
  database: D1Database,
  claims: VerifiedSessionClaims,
  id: string,
  raw: RefundReconcileInput,
  options: RefundCommandOptions = {}
): Promise<RefundCommandReceipt> {
  database = guardedFiscalDatabase(database)
  const input = checked(refundReconcileInputSchema, raw),
    now = clock(options)
  await admin(database, claims, now)
  const payloadHash = await hash({ id, input }),
    prior = await replay(database, claims, input.idempotencyKey, 'refund_cancel', payloadHash)
  if (prior !== null) {
    await admin(database, claims, now)
    return checked(refundCommandReceiptSchema, prior, 'read_unconfirmed')
  }
  const { contract, fingerprint } = await readRefundContract(database, id),
    work = await readRefundWork(database, id)
  if (
    !['awaiting_confirmation', 'queued', 'leased', 'manual_review'].includes(work.status) ||
    work.submitted_at !== null ||
    work.generation !== input.expectedGeneration
  )
    throw new RefundError('cancellation_not_safe')
  const at = now(),
    response = receipt(contract, fingerprint, 'cancelled', work.generation + 1)
  try {
    await database.batch([
      database
        .prepare(
          "UPDATE refund_work SET status='cancelled',generation=generation+1,lease_token=NULL,lease_until=NULL WHERE refund_id=?1 AND generation=?2 AND submitted_at IS NULL AND status IN('awaiting_confirmation','queued','leased','manual_review')"
        )
        .bind(id, work.generation),
      eventStatement(database, {
        scope: 'refund',
        target: id,
        kind: 'cancelled',
        actor: claims.identityId,
        generation: response.generation,
        reason: input.reason,
        evidenceRef: input.evidenceRef,
        now: at
      }),
      commandStatement(database, claims, input.idempotencyKey, 'refund_cancel', id, payloadHash, response, at),
      guard(database, "EXISTS(SELECT 1 FROM refund_work WHERE refund_id=?1 AND generation=?2 AND status='cancelled')", [
        id,
        response.generation
      ]),
      authorizationGuard(database, claims, options)
    ])
  } catch (failure) {
    return commandRace(database, claims, input.idempotencyKey, 'refund_cancel', payloadHash, now, failure)
  }
  await admin(database, claims, now)
  return response
}
export function validateRefundReceipt(contract: RefundContract, fingerprint: string, raw: unknown): RefundReceipt {
  const value = checked(refundReceiptSchema, raw, 'receipt_unconfirmed')
  if (
    value.amountCents !== refundCardCents(contract) ||
    value.currency !== contract.currency ||
    value.merchantOrder !== contract.capture.merchantOrder ||
    value.contractFingerprint !== fingerprint ||
    value.validationOnly !== contract.validationOnly
  )
    throw new RefundError('receipt_unconfirmed')
  return value
}
export async function completeRefund(
  database: D1Database,
  id: string,
  generation: number,
  token: string,
  raw: RefundReceipt,
  now: string,
  extra: D1PreparedStatement[] = []
) {
  database = guardedFiscalDatabase(database)
  const { contract, fingerprint } = await readRefundContract(database, id),
    value = validateRefundReceipt(contract, fingerprint, raw),
    sourceEvent = crypto.randomUUID()
  const restitution =
    value.status === 'succeeded' && (contract.tender?.storeCreditCents ?? 0) > 0
      ? await storeCreditRestitutionStatements(
          database,
          contract,
          checked(fiscalUuid, (await readRefundWork(database, id)).confirmed_by, 'read_unconfirmed'),
          now
        )
      : []
  const email =
    value.status === 'succeeded'
      ? await prepareEmailOutboxEnqueue(database, {
          sourceEventId: sourceEvent,
          eventType: 'refund.succeeded.email',
          sourceKind: 'refund',
          sourceId: id,
          now
        })
      : null
  await database.batch([
    guard(
      database,
      "EXISTS(SELECT 1 FROM refund_work WHERE refund_id=?1 AND generation=?2 AND lease_token=?3 AND status IN('submitting','reconciling') AND lease_until>strftime('%Y-%m-%dT%H:%M:%SZ','now'))",
      [id, generation, token]
    ),
    database
      .prepare(
        'INSERT INTO refund_receipts(refund_id,status,receipt_json,recorded_at) SELECT ?1,?2,?3,?4 WHERE NOT EXISTS(SELECT 1 FROM refund_receipts WHERE refund_id=?1 AND status=?2)'
      )
      .bind(id, value.status, canonicalJson(value), now),
    guard(database, 'EXISTS(SELECT 1 FROM refund_receipts WHERE refund_id=?1 AND status=?2 AND receipt_json=?3)', [
      id,
      value.status,
      canonicalJson(value)
    ]),
    database
      .prepare(
        'UPDATE refund_work SET status=?4,lease_token=NULL,lease_until=NULL,completed_at=?5,last_error_code=NULL WHERE refund_id=?1 AND generation=?2 AND lease_token=?3'
      )
      .bind(
        id,
        generation,
        token,
        value.status === 'succeeded' ? 'completed' : 'pending_provider',
        value.status === 'succeeded' ? now : null
      ),
    eventStatement(database, {
      scope: 'refund',
      target: id,
      kind: value.status === 'succeeded' ? 'completed' : 'provider_pending',
      generation,
      now
    }),
    ...(value.status === 'succeeded'
      ? [
          database
            .prepare(
              "INSERT INTO order_events(id,order_id,event_type,payload_json,correlation_id,created_at) VALUES(?1,?2,'refund.succeeded',?3,?4,?5)"
            )
            .bind(
              sourceEvent,
              contract.orderId,
              canonicalJson({
                refundId: id,
                returnId: contract.returnId,
                amountCents: contract.amountCents,
                validationOnly: contract.validationOnly
              }),
              id,
              now
            ),
          database
            .prepare('INSERT INTO refund_credit_obligations(refund_id,source_event_id,created_at) VALUES(?1,?2,?3)')
            .bind(id, sourceEvent, now),
          email!.statement,
          ...restitution
        ]
      : []),
    ...extra
  ])
}
export async function dispatchD1Refunds(
  database: D1Database,
  provider: GovernedRefundProvider | undefined,
  config: {
    now: string
    appEnvironment: 'local' | 'preview' | 'production'
    policyId?: string
    enabled?: boolean
    localValidationEnabled?: boolean
    limit?: number
  }
) {
  database = guardedFiscalDatabase(database)
  const now = clock({ now: config.now }),
    limit = config.limit ?? 25
  checked(z.enum(['local', 'preview', 'production']), config.appEnvironment)
  if (config.policyId !== undefined) checked(fiscalUuid, config.policyId)
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RefundError('invalid_input')
  const swept = (
    await database
      .prepare(
        "UPDATE refund_work SET status='uncertain',lease_token=NULL,lease_until=NULL,last_error_code='submission_lease_expired' WHERE refund_id IN(SELECT refund_id FROM refund_work WHERE status IN('submitting','reconciling') AND lease_until<=?1 ORDER BY lease_until,refund_id LIMIT ?2) RETURNING refund_id"
      )
      .bind(now(), limit)
      .all()
  ).results
  const report = { completed: 0, pending: 0, uncertain: swept.length, blocked: 0, lostLease: 0 }
  if (config.enabled !== true || !provider || !config.policyId) return report
  const policy = await readFinancialPolicy(database, config.policyId, 'refund')
  if (!policy) return report
  const expected =
    config.appEnvironment === 'local'
      ? 'local_validation'
      : config.appEnvironment === 'preview'
        ? 'sandbox'
        : 'production'
  if (policy.environment !== expected || (policy.provider === 'local_fake' && config.localValidationEnabled !== true))
    return report
  const metadata = providerMetadata(provider)
  if (
    metadata.name !== policy.provider ||
    metadata.environment !== policy.environment ||
    metadata.mappingFingerprint !== (await hash(policy.mappings))
  )
    throw new RefundError('provider_configuration_unconfirmed')
  const exhausted = (
    await database
      .prepare(
        "UPDATE refund_work SET status='manual_review',lease_token=NULL,lease_until=NULL,last_error_code='preparation_attempts_exhausted' WHERE refund_id IN(SELECT w.refund_id FROM refund_work w JOIN refund_contracts c ON c.id=w.refund_id WHERE c.policy_id=?1 AND w.attempts>=10 AND (w.status='queued' OR(w.status='leased' AND w.lease_until<=?2)) ORDER BY c.created_at,c.id LIMIT ?3) RETURNING refund_id"
      )
      .bind(policy.id, now(), limit)
      .all()
  ).results
  report.blocked += exhausted.length
  const submit = providerMethod<[RefundContract]>(provider, 'refund')!
  const candidates = (
    await database
      .prepare(
        "SELECT c.id FROM refund_contracts c JOIN refund_work w ON w.refund_id=c.id WHERE c.policy_id=?1 AND (w.status='queued' OR(w.status='leased' AND w.lease_until<=?2)) ORDER BY c.created_at,c.id LIMIT ?3"
      )
      .bind(policy.id, now(), limit)
      .all()
  ).results
  for (const row of candidates) {
    const id = checked(z.object({ id: fiscalUuid }).strict(), row, 'read_unconfirmed').id,
      token = crypto.randomUUID(),
      at = now()
    const claimed = await database
      .prepare(
        "UPDATE refund_work SET status='leased',generation=generation+1,attempts=attempts+1,lease_token=?2,lease_until=?3 WHERE refund_id=?1 AND attempts<10 AND (status='queued' OR(status='leased' AND lease_until<=?4)) RETURNING generation"
      )
      .bind(id, token, later(at, 60), at)
      .first()
    if (claimed === null) continue
    const generation = checked(
      z.object({ generation: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) }).strict(),
      claimed,
      'read_unconfirmed'
    ).generation
    let submitted = false
    try {
      const { contract, fingerprint } = await readRefundContract(database, id),
        current = await readFinancialPolicy(database, policy.id, 'refund'),
        source = await capturedSource(database, contract.orderId)
      if (!current || current.fingerprint !== contract.policyFingerprint || source.sourceHash !== contract.sourceHash)
        throw new RefundError('source_or_policy_withdrawn')
      captureMatchesPolicy(source.capture, current)
      submitted = true // A lost marker acknowledgement is quarantined, never returned to a retryable state.
      const marked = await database
        .prepare(
          "UPDATE refund_work SET status='submitting',submitted_at=?4,lease_until=?5 WHERE refund_id=?1 AND generation=?2 AND lease_token=?3 AND status='leased' AND lease_until>strftime('%Y-%m-%dT%H:%M:%SZ','now') AND NOT EXISTS(SELECT 1 FROM financial_policy_withdrawals WHERE policy_id=?6) RETURNING refund_id"
        )
        .bind(id, generation, token, now(), later(now(), 900), policy.id)
        .first()
      if (marked === null) {
        report.lostLease++
        continue
      }
      checked(z.object({ refund_id: z.literal(id) }).strict(), marked, 'read_unconfirmed')
      submitted = true
      // A refund whose card share is 0 is store credit only: the provider is never called.
      const value = validateRefundReceipt(
        contract,
        fingerprint,
        refundCardCents(contract) === 0 ? storeCreditOnlyReceipt(contract, fingerprint) : await submit(contract)
      )
      await completeRefund(database, id, generation, token, value, now())
      if (value.status === 'succeeded') report.completed++
      else report.pending++
    } catch {
      const changed = await database
        .prepare(
          "UPDATE refund_work SET status=CASE WHEN submitted_at IS NOT NULL THEN 'uncertain' ELSE 'manual_review' END,lease_token=NULL,lease_until=NULL,last_error_code=?4 WHERE refund_id=?1 AND generation=?2 AND lease_token=?3 AND status IN('leased','submitting') RETURNING refund_id,status"
        )
        .bind(id, generation, token, submitted ? 'provider_outcome_unknown' : 'preparation_unconfirmed')
        .first<{ refund_id: string; status: string }>()
      if (changed === null) report.lostLease++
      else if (changed.status === 'uncertain') report.uncertain++
      else report.blocked++
    }
  }
  return report
}
/** Privileged evidence lookup only. Never calls refund(), even if the remote
 * provider lacks lookup or reports no match. Pending/uncertain budgets stay held. */
export async function reconcileD1Refund(
  database: D1Database,
  claims: VerifiedSessionClaims,
  id: string,
  raw: RefundReconcileInput,
  provider: GovernedRefundProvider | undefined,
  options: RefundCommandOptions = {}
) {
  database = guardedFiscalDatabase(database)
  const input = checked(refundReconcileInputSchema, raw),
    now = clock(options)
  await admin(database, claims, now)
  const payloadHash = await hash({ id, input }),
    prior = await replay(database, claims, input.idempotencyKey, 'refund_reconcile', payloadHash)
  if (prior !== null) {
    await admin(database, claims, now)
    return checked(refundCommandReceiptSchema, prior, 'read_unconfirmed')
  }
  const { contract, fingerprint } = await readRefundContract(database, id),
    work = await readRefundWork(database, id)
  if (
    !['uncertain', 'pending_provider', 'submitting', 'reconciling'].includes(work.status) ||
    work.generation !== input.expectedGeneration ||
    (['submitting', 'reconciling'].includes(work.status) && work.lease_until !== null && work.lease_until > now())
  )
    throw new RefundError('reconciliation_not_safe')
  const token = crypto.randomUUID(),
    generation = work.generation + 1,
    at = now()
  try {
    await database.batch([
      database
        .prepare(
          "UPDATE refund_work SET status='reconciling',generation=?3,lease_token=?4,lease_until=?5 WHERE refund_id=?1 AND generation=?2 AND submitted_at IS NOT NULL AND (status IN('uncertain','pending_provider') OR(status IN('submitting','reconciling') AND lease_until<=?6))"
        )
        .bind(id, work.generation, generation, token, later(at, 900), at),
      eventStatement(database, {
        scope: 'refund',
        target: id,
        kind: 'reconciliation_requested',
        actor: claims.identityId,
        generation,
        reason: input.reason,
        evidenceRef: input.evidenceRef,
        now: at
      }),
      guard(
        database,
        "EXISTS(SELECT 1 FROM refund_work WHERE refund_id=?1 AND generation=?2 AND status='reconciling' AND lease_token=?3)",
        [id, generation, token]
      ),
      authorizationGuard(database, claims, options)
    ])
  } catch {
    throw new RefundError('version_conflict')
  }
  let value: RefundReceipt | undefined
  try {
    const stored = await database
      .prepare("SELECT receipt_json FROM refund_receipts WHERE refund_id=?1 AND status='succeeded'")
      .bind(id)
      .first()
    if (stored !== null)
      value = validateRefundReceipt(
        contract,
        fingerprint,
        parsedJson(
          checked(z.object({ receipt_json: z.string().max(16384) }).strict(), stored, 'read_unconfirmed').receipt_json
        )
      )
    else if (refundCardCents(contract) === 0) value = storeCreditOnlyReceipt(contract, fingerprint)
    else if (provider) {
      const lookup = providerMethod<[string, string]>(provider, 'lookupByExternalKey', false)
      if (!lookup) throw new RefundError('lookup_unavailable')
      const metadata = providerMetadata(provider),
        policy = await readFinancialPolicy(database, contract.policyId, 'refund', false)
      if (
        !policy ||
        metadata.name !== contract.provider ||
        metadata.environment !== contract.environment ||
        metadata.mappingFingerprint !== (await hash(policy.mappings))
      )
        throw new RefundError('provider_configuration_unconfirmed')
      await admin(database, claims, now)
      const proof = checked(
        z
          .object({
            authoritative: z.literal(true),
            externalKey: z.literal(contract.idempotencyKey),
            contractFingerprint: z.literal(fingerprint),
            receipts: z.array(refundReceiptSchema).length(1)
          })
          .strict(),
        await lookup(contract.idempotencyKey, fingerprint),
        'lookup_unconfirmed'
      )
      await admin(database, claims, now)
      value = validateRefundReceipt(contract, fingerprint, proof.receipts[0])
    }
    if (!value) throw new RefundError('lookup_unavailable')
    await admin(database, claims, now)
    const response = receipt(contract, fingerprint, value.status === 'succeeded' ? 'reconciled' : 'blocked', generation)
    await completeRefund(database, id, generation, token, value, now(), [
      eventStatement(database, {
        scope: 'refund',
        target: id,
        kind: 'reconciliation_confirmed',
        actor: claims.identityId,
        generation,
        reason: input.reason,
        evidenceRef: input.evidenceRef,
        now: now()
      }),
      commandStatement(database, claims, input.idempotencyKey, 'refund_reconcile', id, payloadHash, response, now()),
      authorizationGuard(database, claims, options)
    ])
    await admin(database, claims, now)
    return response
  } catch (failure) {
    // Keep the reservation and prevent blind resubmission, including revocation
    // during lookup or a failure to commit the now-known remote outcome.
    await database
      .prepare(
        "UPDATE refund_work SET status='uncertain',lease_token=NULL,lease_until=NULL,last_error_code='reconciliation_unconfirmed' WHERE refund_id=?1 AND generation=?2 AND lease_token=?3 AND status='reconciling'"
      )
      .bind(id, generation, token)
      .run()
    await admin(database, claims, now)
    if (failure instanceof RefundError) throw failure
    throw new RefundError('reconciliation_unconfirmed')
  }
}
