import { z } from 'zod'
import {
  creditContractSchema,
  creditReceiptSchema,
  creditQueueInputSchema,
  creditCommandReceiptSchema,
  creditWorkflowSchema,
  type CreditContract,
  type CreditReceipt,
  type CreditQueueInput,
  type CreditCommandReceipt,
  type CreditFiscalProvider
} from '../../shared/fiscal-credit'
import { refundReconcileInputSchema, type RefundReconcileInput } from '../../shared/order-refunds'
import {
  fiscalUuid,
  fiscalHash,
  fiscalInstant,
  fiscalContractSchema,
  type PrivateFiscalStorage
} from '../../shared/fiscal-issuance'
import { guardedFiscalDatabase } from './d1-boundary'
import { checksumFiscalPdf, readFiscalPolicy, validateFiscalContract } from './issuance'
import { readRefundContract, readRefundWork } from '../refunds/operations'
import { readFinancialPolicy } from '../refunds/policies'
import {
  checked,
  hash,
  parsedJson,
  clock,
  admin,
  replay,
  commandStatement,
  eventStatement,
  guard,
  authorizationGuard,
  later,
  providerMetadata,
  providerMethod,
  RefundError,
  type RefundCommandOptions
} from '../refunds/authority'
import type { VerifiedSessionClaims } from '../catalog/authorization'
import { canonicalJson } from '../catalog/inventory'
import { prepareEmailOutboxEnqueue } from '../communications/email-outbox'
import { localFiscalBlobBytes } from './local-provider'

const sourceSchema = z
  .object({
    id: fiscalUuid,
    policy_id: fiscalUuid,
    contract_json: z.string().max(131072),
    contract_fingerprint: fiscalHash,
    provider_invoice_id: z.string().min(1).max(200),
    pdf_checksum: fiscalHash
  })
  .strict()
const workSchema = z
  .object({
    status: creditWorkflowSchema,
    generation: z
      .number()
      .int()
      .min(1)
      .max(Number.MAX_SAFE_INTEGER - 1),
    lease_until: fiscalInstant.nullable(),
    issuing_at: fiscalInstant.nullable()
  })
  .strict()
export async function readCreditContract(database: D1Database, id: string) {
  const raw = await guardedFiscalDatabase(database)
    .prepare('SELECT contract_json,contract_fingerprint FROM fiscal_credit_contracts WHERE id=?1')
    .bind(checked(fiscalUuid, id))
    .first()
  if (raw === null) throw new RefundError('not_found')
  const row = checked(
      z.object({ contract_json: z.string().max(262144), contract_fingerprint: fiscalHash }).strict(),
      raw,
      'read_unconfirmed'
    ),
    contract = checked(creditContractSchema, parsedJson(row.contract_json), 'read_unconfirmed')
  if (
    contract.creditId !== id ||
    (await hash(contract)) !== row.contract_fingerprint ||
    (await hash(contract.sourceContract)) !== contract.sourceContractFingerprint
  )
    throw new RefundError('read_unconfirmed')
  return { contract, fingerprint: row.contract_fingerprint }
}
async function work(database: D1Database, id: string) {
  const raw = await database
    .prepare('SELECT status,generation,lease_until,issuing_at FROM fiscal_credit_work WHERE credit_id=?1')
    .bind(id)
    .first()
  return checked(workSchema, raw, 'read_unconfirmed')
}
function response(
  contract: CreditContract,
  fingerprint: string,
  action: CreditCommandReceipt['action'],
  generation: number
) {
  return checked(creditCommandReceiptSchema, {
    source: 'cloudflare',
    id: contract.creditId,
    refundId: contract.refundId,
    action,
    generation,
    contractFingerprint: fingerprint,
    validationOnly: contract.validationOnly
  })
}
export function validateCreditReceipt(contract: CreditContract, fingerprint: string, raw: unknown): CreditReceipt {
  const receipt = checked(creditReceiptSchema, raw, 'receipt_unconfirmed')
  if (
    receipt.amountCents !== contract.amountCents ||
    receipt.currency !== contract.currency ||
    receipt.sourceProviderInvoiceId !== contract.sourceProviderInvoiceId ||
    receipt.contractFingerprint !== fingerprint ||
    receipt.validationOnly !== contract.validationOnly ||
    receipt.providerId === contract.sourceProviderInvoiceId
  )
    throw new RefundError('receipt_unconfirmed')
  return receipt
}
/** Explicit audited command, not automatic permission derived from refund success. */
export async function queueD1CreditNote(
  database: D1Database,
  claims: VerifiedSessionClaims,
  refundId: string,
  raw: CreditQueueInput,
  options: RefundCommandOptions = {}
): Promise<CreditCommandReceipt> {
  database = guardedFiscalDatabase(database)
  const input = checked(creditQueueInputSchema, raw),
    now = clock(options)
  await admin(database, claims, now)
  const payloadHash = await hash({ refundId, input }),
    prior = await replay(database, claims, input.idempotencyKey, 'credit_queue', payloadHash)
  if (prior !== null) {
    await admin(database, claims, now)
    return checked(creditCommandReceiptSchema, prior, 'read_unconfirmed')
  }
  const refund = await readRefundContract(database, refundId),
    refundWork = await readRefundWork(database, refundId),
    policy = await readFinancialPolicy(database, input.policyId, 'credit')
  if (!policy) throw new RefundError('policy_unavailable')
  if (refundWork.status !== 'completed') throw new RefundError('refund_unconfirmed')
  const rawSource = await database
    .prepare(
      `SELECT i.id,i.policy_id,i.contract_json,i.contract_fingerprint,r.provider_invoice_id,d.pdf_checksum FROM fiscal_invoice_intents i JOIN fiscal_issuance_work w ON w.intent_id=i.id AND w.status='completed' JOIN fiscal_provider_receipts r ON r.intent_id=i.id AND r.fiscal_status='issued' JOIN fiscal_documents d ON d.intent_id=i.id WHERE i.order_id=?1 AND i.kind='ordinary' AND i.fiscal_version=1`
    )
    .bind(refund.contract.orderId)
    .first()
  if (rawSource === null) throw new RefundError('original_invoice_unconfirmed')
  const source = checked(sourceSchema, rawSource, 'read_unconfirmed'),
    original = checked(fiscalContractSchema, parsedJson(source.contract_json), 'read_unconfirmed'),
    originalPolicy = await readFiscalPolicy(database, source.policy_id, false)
  if (!originalPolicy) throw new RefundError('original_invoice_unconfirmed')
  validateFiscalContract(original, originalPolicy)
  if (
    (await hash(original)) !== source.contract_fingerprint ||
    original.validationOnly !== refund.contract.validationOnly ||
    original.provider !== policy.provider ||
    original.environment !== policy.environment ||
    (await hash(originalPolicy.mappings)) !== (await hash(policy.mappings))
  )
    throw new RefundError('policy_or_source_mismatch')
  const id = crypto.randomUUID(),
    at = now(),
    contract = checked(creditContractSchema, {
      schemaVersion: 1,
      kind: 'credit_note',
      creditId: id,
      refundId,
      returnId: refund.contract.returnId,
      orderId: refund.contract.orderId,
      policyId: policy.id,
      policyFingerprint: policy.fingerprint,
      provider: policy.provider,
      environment: policy.environment,
      validationOnly: policy.provider === 'local_fake',
      series: policy.series,
      idempotencyKey: `credit:${id}`,
      issuedOn: at,
      reason: input.reason,
      sourceInvoiceId: source.id,
      sourceProviderInvoiceId: source.provider_invoice_id,
      sourceContractFingerprint: source.contract_fingerprint,
      sourcePdfChecksum: source.pdf_checksum,
      sourceContract: original,
      components: refund.contract.components,
      amountCents: refund.contract.amountCents,
      currency: 'EUR'
    }),
    fingerprint = await hash(contract),
    receipt = response(contract, fingerprint, 'queued', 1)
  try {
    await database.batch([
      database
        .prepare(
          'INSERT INTO fiscal_credit_contracts(id,refund_id,order_id,source_invoice_id,policy_id,contract_json,contract_fingerprint,idempotency_key,amount_gross_cents,validation_only,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)'
        )
        .bind(
          id,
          refundId,
          contract.orderId,
          source.id,
          policy.id,
          canonicalJson(contract),
          fingerprint,
          contract.idempotencyKey,
          contract.amountCents,
          contract.validationOnly ? 1 : 0,
          at
        ),
      database.prepare("INSERT INTO fiscal_credit_work(credit_id,status) VALUES(?1,'queued')").bind(id),
      database
        .prepare(
          "UPDATE refund_credit_obligations SET status='queued' WHERE refund_id=?1 AND status IN('blocked_policy','blocked_source')"
        )
        .bind(refundId),
      guard(database, "EXISTS(SELECT 1 FROM refund_credit_obligations WHERE refund_id=?1 AND status='queued')", [
        refundId
      ]),
      eventStatement(database, {
        scope: 'credit',
        target: id,
        kind: 'queued',
        actor: claims.identityId,
        generation: 1,
        reason: input.reason,
        evidenceRef: input.evidenceRef,
        now: at
      }),
      commandStatement(database, claims, input.idempotencyKey, 'credit_queue', id, payloadHash, receipt, at),
      authorizationGuard(database, claims, options)
    ])
  } catch {
    await admin(database, claims, now)
    const raced = await replay(database, claims, input.idempotencyKey, 'credit_queue', payloadHash)
    if (raced !== null) return checked(creditCommandReceiptSchema, raced, 'read_unconfirmed')
    throw new RefundError('conflict')
  }
  await admin(database, claims, now)
  return receipt
}
async function finishCredit(
  database: D1Database,
  contract: CreditContract,
  fingerprint: string,
  generation: number,
  token: string,
  receipt: CreditReceipt,
  provider: CreditFiscalProvider,
  storage: PrivateFiscalStorage,
  now: () => string,
  extra: () => D1PreparedStatement[] = () => []
) {
  const lease =
      "EXISTS(SELECT 1 FROM fiscal_credit_work WHERE credit_id=?1 AND generation=?2 AND lease_token=?3 AND status IN('issuing','reconciling') AND lease_until>strftime('%Y-%m-%dT%H:%M:%SZ','now'))",
    args = [contract.creditId, generation, token]
  await database.batch([
    guard(database, lease, args),
    database
      .prepare(
        'INSERT INTO fiscal_credit_receipts(credit_id,receipt_json,provider_invoice_id,recorded_at) SELECT ?1,?2,?3,?4 WHERE NOT EXISTS(SELECT 1 FROM fiscal_credit_receipts WHERE credit_id=?1)'
      )
      .bind(contract.creditId, canonicalJson(receipt), receipt.providerId, now()),
    guard(database, 'EXISTS(SELECT 1 FROM fiscal_credit_receipts WHERE credit_id=?1 AND receipt_json=?2)', [
      contract.creditId,
      canonicalJson(receipt)
    ])
  ])
  // Receipt is durable BEFORE PDF/R2. A later failure uses it to reconcile,
  // never makes a second external credit note.
  const download = providerMethod<[string], Uint8Array>(provider, 'downloadPdf')!
  const bytes = localFiscalBlobBytes(await download(receipt.providerId)),
    checksum = await checksumFiscalPdf(bytes),
    key = `fiscal/${contract.creditId}/${checksum}.pdf`
  await storage.put(key, bytes)
  const savedRaw = await storage.get(key),
    saved = savedRaw === null ? null : localFiscalBlobBytes(savedRaw)
  if (!saved || saved.byteLength !== bytes.byteLength || (await checksumFiscalPdf(saved)) !== checksum)
    throw new RefundError('document_storage_unconfirmed')
  const at = now(),
    sourceEvent = crypto.randomUUID(),
    email = await prepareEmailOutboxEnqueue(database, {
      sourceEventId: sourceEvent,
      eventType: 'invoice.issued',
      sourceKind: 'invoice',
      sourceId: contract.creditId,
      now: at
    })
  await database.batch([
    guard(database, lease, args),
    database
      .prepare(
        'INSERT INTO fiscal_credit_documents(credit_id,storage_key,pdf_checksum,pdf_size,created_at) VALUES(?1,?2,?3,?4,?5)'
      )
      .bind(contract.creditId, key, checksum, bytes.byteLength, at),
    database
      .prepare(
        "UPDATE fiscal_credit_work SET status='completed',completed_at=?4,lease_token=NULL,lease_until=NULL,last_error_code=NULL WHERE credit_id=?1 AND generation=?2 AND lease_token=?3"
      )
      .bind(...args, at),
    database
      .prepare("UPDATE refund_credit_obligations SET status='completed' WHERE refund_id=?1 AND status='queued'")
      .bind(contract.refundId),
    eventStatement(database, { scope: 'credit', target: contract.creditId, kind: 'completed', generation, now: at }),
    database
      .prepare(
        "INSERT INTO order_events(id,order_id,event_type,payload_json,correlation_id,created_at) VALUES(?1,?2,'invoice.issued',?3,?4,?5)"
      )
      .bind(
        sourceEvent,
        contract.orderId,
        canonicalJson({
          invoiceId: contract.creditId,
          documentKind: 'credit_note',
          refundId: contract.refundId,
          sourceInvoiceId: contract.sourceInvoiceId,
          provider: contract.provider,
          code: receipt.code,
          validationOnly: contract.validationOnly
        }),
        contract.creditId,
        at
      ),
    email.statement,
    ...extra()
  ])
}
export async function dispatchD1CreditNotes(
  database: D1Database,
  provider: CreditFiscalProvider | undefined,
  storage: PrivateFiscalStorage | undefined,
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
        "UPDATE fiscal_credit_work SET status='uncertain',lease_token=NULL,lease_until=NULL,last_error_code='issuing_lease_expired' WHERE credit_id IN(SELECT credit_id FROM fiscal_credit_work WHERE status IN('issuing','reconciling') AND lease_until<=?1 ORDER BY lease_until,credit_id LIMIT ?2) RETURNING credit_id"
      )
      .bind(now(), limit)
      .all()
  ).results
  const report = { completed: 0, uncertain: swept.length, blocked: 0, lostLease: 0 }
  if (config.enabled !== true || !provider || !storage || !config.policyId) return report
  const policy = await readFinancialPolicy(database, config.policyId, 'credit'),
    expected =
      config.appEnvironment === 'local'
        ? 'local_validation'
        : config.appEnvironment === 'preview'
          ? 'sandbox'
          : 'production'
  if (
    !policy ||
    policy.environment !== expected ||
    (policy.provider === 'local_fake' && config.localValidationEnabled !== true)
  )
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
        "UPDATE fiscal_credit_work SET status='manual_review',lease_token=NULL,lease_until=NULL,last_error_code='preparation_attempts_exhausted' WHERE credit_id IN(SELECT w.credit_id FROM fiscal_credit_work w JOIN fiscal_credit_contracts c ON c.id=w.credit_id WHERE c.policy_id=?1 AND w.attempts>=10 AND (w.status='queued' OR(w.status='leased' AND w.lease_until<=?2)) ORDER BY c.created_at,c.id LIMIT ?3) RETURNING credit_id"
      )
      .bind(policy.id, now(), limit)
      .all()
  ).results
  report.blocked += exhausted.length
  const issue = providerMethod<[CreditContract]>(provider, 'issueCreditNote')!
  const candidates = (
    await database
      .prepare(
        "SELECT c.id FROM fiscal_credit_contracts c JOIN fiscal_credit_work w ON w.credit_id=c.id WHERE c.policy_id=?1 AND (w.status='queued' OR(w.status='leased' AND w.lease_until<=?2)) ORDER BY c.created_at,c.id LIMIT ?3"
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
        "UPDATE fiscal_credit_work SET status='leased',generation=generation+1,attempts=attempts+1,lease_token=?2,lease_until=?3 WHERE credit_id=?1 AND attempts<10 AND (status='queued' OR(status='leased' AND lease_until<=?4)) RETURNING generation"
      )
      .bind(id, token, later(at, 60), at)
      .first()
    if (claimed === null) continue
    const generation = checked(
      z.object({ generation: z.number().int().min(1) }).strict(),
      claimed,
      'read_unconfirmed'
    ).generation
    try {
      const { contract, fingerprint } = await readCreditContract(database, id),
        current = await readFinancialPolicy(database, policy.id, 'credit')
      if (!current || current.fingerprint !== contract.policyFingerprint) throw new RefundError('policy_withdrawn')
      const marked = await database
        .prepare(
          "UPDATE fiscal_credit_work SET status='issuing',issuing_at=?4,lease_until=?5 WHERE credit_id=?1 AND generation=?2 AND lease_token=?3 AND status='leased' AND lease_until>strftime('%Y-%m-%dT%H:%M:%SZ','now') AND NOT EXISTS(SELECT 1 FROM financial_policy_withdrawals WHERE policy_id=?6) RETURNING credit_id"
        )
        .bind(id, generation, token, now(), later(now(), 900), policy.id)
        .first()
      if (marked === null) {
        report.lostLease++
        continue
      }
      checked(z.object({ credit_id: z.literal(id) }).strict(), marked, 'read_unconfirmed')
      const receipt = validateCreditReceipt(contract, fingerprint, await issue(contract))
      await finishCredit(database, contract, fingerprint, generation, token, receipt, provider, storage, now)
      report.completed++
    } catch {
      const changed = await database
        .prepare(
          "UPDATE fiscal_credit_work SET status=CASE WHEN issuing_at IS NULL THEN 'manual_review' ELSE 'uncertain' END,lease_token=NULL,lease_until=NULL,last_error_code='credit_outcome_unconfirmed' WHERE credit_id=?1 AND generation=?2 AND lease_token=?3 AND status IN('leased','issuing') RETURNING status"
        )
        .bind(id, generation, token)
        .first<{ status: string }>()
      if (changed === null) report.lostLease++
      else if (changed.status === 'uncertain') report.uncertain++
      else report.blocked++
    }
  }
  return report
}
export async function reconcileD1CreditNote(
  database: D1Database,
  claims: VerifiedSessionClaims,
  id: string,
  raw: RefundReconcileInput,
  provider: CreditFiscalProvider | undefined,
  storage: PrivateFiscalStorage | undefined,
  options: RefundCommandOptions = {}
) {
  database = guardedFiscalDatabase(database)
  const input = checked(refundReconcileInputSchema, raw),
    now = clock(options)
  await admin(database, claims, now)
  const payloadHash = await hash({ id, input }),
    prior = await replay(database, claims, input.idempotencyKey, 'credit_reconcile', payloadHash)
  if (prior !== null) {
    await admin(database, claims, now)
    return checked(creditCommandReceiptSchema, prior, 'read_unconfirmed')
  }
  if (!provider || !storage) throw new RefundError('reconciliation_unavailable')
  const { contract, fingerprint } = await readCreditContract(database, id),
    state = await work(database, id),
    policy = await readFinancialPolicy(database, contract.policyId, 'credit', false),
    metadata = providerMetadata(provider)
  if (
    !policy ||
    metadata.name !== contract.provider ||
    metadata.environment !== contract.environment ||
    metadata.mappingFingerprint !== (await hash(policy.mappings))
  )
    throw new RefundError('provider_configuration_unconfirmed')
  if (
    state.generation !== input.expectedGeneration ||
    !['uncertain', 'issuing', 'reconciling'].includes(state.status) ||
    (['issuing', 'reconciling'].includes(state.status) && state.lease_until !== null && state.lease_until > now())
  )
    throw new RefundError('reconciliation_not_safe')
  const token = crypto.randomUUID(),
    generation = state.generation + 1,
    at = now()
  await database.batch([
    database
      .prepare(
        "UPDATE fiscal_credit_work SET status='reconciling',generation=?3,lease_token=?4,lease_until=?5 WHERE credit_id=?1 AND generation=?2 AND (status='uncertain' OR(status IN('issuing','reconciling') AND lease_until<=?6))"
      )
      .bind(id, state.generation, generation, token, later(at, 900), at),
    guard(
      database,
      "EXISTS(SELECT 1 FROM fiscal_credit_work WHERE credit_id=?1 AND generation=?2 AND status='reconciling' AND lease_token=?3)",
      [id, generation, token]
    ),
    eventStatement(database, {
      scope: 'credit',
      target: id,
      kind: 'reconciliation_requested',
      actor: claims.identityId,
      generation,
      reason: input.reason,
      evidenceRef: input.evidenceRef,
      now: at
    }),
    authorizationGuard(database, claims, options)
  ])
  try {
    const saved = await database
      .prepare('SELECT receipt_json FROM fiscal_credit_receipts WHERE credit_id=?1')
      .bind(id)
      .first()
    let receipt: CreditReceipt
    if (saved !== null)
      receipt = validateCreditReceipt(
        contract,
        fingerprint,
        parsedJson(
          checked(z.object({ receipt_json: z.string().max(16384) }).strict(), saved, 'read_unconfirmed').receipt_json
        )
      )
    else {
      const lookup = providerMethod<[string, string]>(provider, 'lookupByExternalKey', false)
      if (!lookup) throw new RefundError('lookup_unavailable')
      await admin(database, claims, now)
      const proof = checked(
        z
          .object({
            authoritative: z.literal(true),
            externalKey: z.literal(contract.idempotencyKey),
            contractFingerprint: z.literal(fingerprint),
            receipts: z.array(creditReceiptSchema).length(1)
          })
          .strict(),
        await lookup(contract.idempotencyKey, fingerprint),
        'lookup_unconfirmed'
      )
      await admin(database, claims, now)
      receipt = validateCreditReceipt(contract, fingerprint, proof.receipts[0])
    }
    const result = response(contract, fingerprint, 'reconciled', generation)
    await admin(database, claims, now)
    await finishCredit(database, contract, fingerprint, generation, token, receipt, provider, storage, now, () => [
      commandStatement(database, claims, input.idempotencyKey, 'credit_reconcile', id, payloadHash, result, now()),
      authorizationGuard(database, claims, options)
    ])
    await admin(database, claims, now)
    return result
  } catch (failure) {
    await database
      .prepare(
        "UPDATE fiscal_credit_work SET status='uncertain',lease_token=NULL,lease_until=NULL,last_error_code='reconciliation_unconfirmed' WHERE credit_id=?1 AND generation=?2 AND lease_token=?3 AND status='reconciling'"
      )
      .bind(id, generation, token)
      .run()
    await admin(database, claims, now)
    throw failure instanceof RefundError ? failure : new RefundError('reconciliation_unconfirmed')
  }
}
