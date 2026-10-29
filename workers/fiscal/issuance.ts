import { z } from 'zod'
import {
  fiscalContractSchema,
  fiscalMappingsSchema,
  fiscalPolicyInputSchema,
  fiscalReceiptSchema,
  fiscalReconcileInputSchema,
  fiscalUuid,
  fiscalInstant,
  fiscalReason,
  FISCAL_MAX_PDF_BYTES,
  type FiscalContract,
  type FiscalPolicy,
  type FiscalReceipt,
  type OrdinaryFiscalProvider,
  type PrivateFiscalStorage,
  type FiscalReconcileInput
} from '../../shared/fiscal-issuance'
import { catalogPolicyOwnJson } from '../../shared/catalog-publication-policy'
import { authorizeD1Session, type VerifiedSessionClaims } from '../catalog/authorization'
import { canonicalJson, sha256Hex, isCanonicalInventoryInstant } from '../catalog/inventory'
import { splitGross, roundRatio } from '../../server/domain/money'
import { prepareEmailOutboxEnqueue } from '../communications/email-outbox'
import { fiscalBatchEvidence, guardedFiscalDatabase, FiscalD1EvidenceError } from './d1-boundary'

export class FiscalIssuanceError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'FiscalIssuanceError'
  }
}
function parsed<T>(schema: { parse(value: unknown): T }, value: unknown): T {
  try {
    return schema.parse(catalogPolicyOwnJson(value))
  } catch {
    throw new FiscalIssuanceError('invalid_input')
  }
}
export function fiscalClock(initial: string) {
  if (!isCanonicalInventoryInstant(initial)) throw new FiscalIssuanceError('invalid_instant')
  const initialMs = Date.parse(initial),
    started = Date.now()
  return () => new Date(initialMs + Math.max(0, Date.now() - started)).toISOString().replace(/\.\d{3}Z$/, 'Z')
}
function after(now: string, seconds: number) {
  return new Date(Date.parse(now) + seconds * 1000).toISOString().replace('.000Z', 'Z')
}
async function admin(database: D1Database, claims: VerifiedSessionClaims, now: string) {
  const result = await authorizeD1Session(database, claims, 'administration.manage', { now, requireMfa: true })
  if (!result.allowed) throw new FiscalIssuanceError(result.code)
  if (result.identityId !== claims.identityId || result.sessionId !== claims.sessionId)
    throw new FiscalD1EvidenceError()
}
/** Fresh authorization is also part of each mutating SQL transaction. */
function authPredicate(identity = '?1', session = '?2', version = '?3', now = '?4') {
  // SQL observes execution time, not an authorization timestamp captured before
  // an awaited D1 call. Tests override SQLite's clock in their adapter only.
  // Retain the original bound slot for the audited instant, but deliberately
  // never use it as the SQL decision clock (NULLIF(x,x) is always NULL).
  now = `COALESCE(NULLIF(${now},${now}),strftime('%Y-%m-%dT%H:%M:%SZ','now'))`
  return `EXISTS(SELECT 1 FROM auth_sessions s JOIN identities i ON i.id=s.identity_id
    JOIN identity_roles r ON r.identity_id=i.id JOIN role_permissions p ON p.role_code=r.role_code
    WHERE i.id=${identity} AND s.id=${session} AND s.identity_id=i.id AND s.session_version=${version}
      AND i.session_version=s.session_version AND i.status IN ('active','pending')
      AND i.email_verified_at IS NOT NULL AND i.email_verified_at<=${now} AND s.mfa_verified=1
      AND s.revoked_at IS NULL AND s.created_at<=${now} AND s.expires_at>${now}
      AND r.granted_at<=${now} AND (r.expires_at IS NULL OR r.expires_at>${now})
      AND p.permission_code='administration.manage')`
}
function guard(database: D1Database, condition: string, bindings: unknown[]) {
  return database
    .prepare(`INSERT INTO fiscal_atomic_guards(id,passed) SELECT 1,0 WHERE NOT (${condition})`)
    .bind(...bindings)
}
const commandKey = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value))
    throw new FiscalIssuanceError('invalid_input')
  return value
}
async function priorCommand(
  database: D1Database,
  claims: VerifiedSessionClaims,
  key: string,
  kind: string,
  hash: string
) {
  const row = await database
    .prepare(
      'SELECT target_id,command_kind,payload_hash FROM fiscal_admin_commands WHERE actor_id=?1 AND command_key=?2'
    )
    .bind(claims.identityId, key)
    .first<{ target_id: string; command_kind: string; payload_hash: string }>()
  if (row) {
    try {
      z.object({
        target_id: fiscalUuid,
        command_kind: z.enum(['policy_approve', 'policy_withdraw', 'invoice_queue']),
        payload_hash: z.string().regex(/^[0-9a-f]{64}$/)
      })
        .strict()
        .parse(row)
    } catch {
      throw new FiscalD1EvidenceError()
    }
  }
  if (row && (row.command_kind !== kind || row.payload_hash !== hash))
    throw new FiscalIssuanceError('idempotency_conflict')
  return row
}
function commandUniqueFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const message = Object.getOwnPropertyDescriptor(error, 'message')?.value
  if (typeof message !== 'string') return false
  const exact = 'UNIQUE constraint failed: fiscal_admin_commands.actor_id, fiscal_admin_commands.command_key'
  return (
    message === exact ||
    message === `D1_ERROR: ${exact}: SQLITE_CONSTRAINT` ||
    message === `D1_ERROR: ${exact}: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_PRIMARYKEY)`
  )
}
async function commitAdminBatch(
  database: D1Database,
  statements: D1PreparedStatement[],
  claims: VerifiedSessionClaims,
  key: string,
  kind: string,
  hash: string,
  now: () => string
): Promise<string | null> {
  try {
    await confirmedBatch(database, statements)
    return null
  } catch (error) {
    if (error instanceof FiscalD1EvidenceError) throw error
    await admin(database, claims, now())
    if (!commandUniqueFailure(error)) throw error
    const previous = await priorCommand(database, claims, key, kind, hash)
    if (!previous) throw new FiscalIssuanceError('idempotency_conflict')
    await admin(database, claims, now())
    return previous.target_id
  }
}
function adminCommand(
  database: D1Database,
  claims: VerifiedSessionClaims,
  key: string,
  kind: string,
  target: string,
  hash: string,
  now: string
) {
  return database
    .prepare(
      `INSERT INTO fiscal_admin_commands(actor_id,command_key,command_kind,target_id,payload_hash,created_at)
    VALUES (?1,?2,?3,?4,?5,?6)`
    )
    .bind(claims.identityId, key, kind, target, hash, now)
}
async function confirmedBatch(database: D1Database, statements: D1PreparedStatement[]) {
  const results = await database.batch(statements)
  return fiscalBatchEvidence(results, statements.length)
}
export async function fiscalMappingFingerprint(mappings: unknown): Promise<string> {
  return sha256Hex(canonicalJson(parsed(fiscalMappingsSchema, mappings)))
}
export async function approveFiscalPolicy(
  database: D1Database,
  claims: VerifiedSessionClaims,
  input: unknown,
  options: { now: string }
): Promise<FiscalPolicy> {
  database = guardedFiscalDatabase(database)
  const now = fiscalClock(options.now),
    policy = parsed(fiscalPolicyInputSchema, input)
  await admin(database, claims, now())
  const fingerprint = await sha256Hex(canonicalJson(policy))
  const previous = await priorCommand(database, claims, policy.idempotencyKey, 'policy_approve', fingerprint)
  if (previous) {
    await admin(database, claims, now())
    const saved = await readFiscalPolicy(database, previous.target_id, false)
    await admin(database, claims, now())
    if (!saved) throw new FiscalIssuanceError('commit_unconfirmed')
    return saved
  }
  const id = crypto.randomUUID(),
    instant = now()
  await admin(database, claims, instant)
  const raced = await commitAdminBatch(
    database,
    [
      database
        .prepare(
          `INSERT INTO fiscal_issuance_policies(id,policy_json,fingerprint,provider,environment,actor_id,approved_at)
      SELECT ?5,?6,?7,?8,?9,?1,?4 WHERE ${authPredicate()}`
        )
        .bind(
          claims.identityId,
          claims.sessionId,
          claims.sessionVersion,
          instant,
          id,
          canonicalJson(policy),
          fingerprint,
          policy.provider,
          policy.environment
        ),
      database
        .prepare(
          `INSERT INTO fiscal_issuance_events(id,policy_id,event_type,actor_id,reason,evidence_ref,created_at)
      SELECT ?1,id,'policy_approved',actor_id,?3,?4,approved_at FROM fiscal_issuance_policies WHERE id=?2`
        )
        .bind(crypto.randomUUID(), id, policy.reason, policy.evidenceRef),
      adminCommand(database, claims, policy.idempotencyKey, 'policy_approve', id, fingerprint, instant),
      guard(database, `${authPredicate()} AND EXISTS(SELECT 1 FROM fiscal_issuance_policies WHERE id=?5)`, [
        claims.identityId,
        claims.sessionId,
        claims.sessionVersion,
        instant,
        id
      ])
    ],
    claims,
    policy.idempotencyKey,
    'policy_approve',
    fingerprint,
    now
  )
  if (raced) {
    const saved = await readFiscalPolicy(database, raced, false)
    await admin(database, claims, now())
    if (!saved) throw new FiscalD1EvidenceError()
    return saved
  }
  await admin(database, claims, now())
  return { ...policy, id, approvedAt: instant, fingerprint }
}
export async function readFiscalPolicy(database: D1Database, id: string, active = true): Promise<FiscalPolicy | null> {
  database = guardedFiscalDatabase(database)
  const row = await database
    .prepare(
      `SELECT id,policy_json,fingerprint,approved_at FROM fiscal_issuance_policies
    WHERE id=?1 ${active ? 'AND NOT EXISTS(SELECT 1 FROM fiscal_policy_withdrawals WHERE policy_id=id)' : ''}`
    )
    .bind(id)
    .first<{ id: string; policy_json: string; fingerprint: string; approved_at: string }>()
  if (!row) return null
  try {
    z.object({
      id: z.literal(id),
      policy_json: z.string().min(1).max(16384),
      fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
      approved_at: fiscalInstant
    })
      .strict()
      .parse(row)
  } catch {
    throw new FiscalD1EvidenceError()
  }
  let policy
  try {
    policy = fiscalPolicyInputSchema.parse(JSON.parse(row.policy_json))
  } catch {
    throw new FiscalIssuanceError('policy_invalid')
  }
  if ((await sha256Hex(canonicalJson(policy))) !== row.fingerprint) throw new FiscalIssuanceError('policy_drift')
  return { ...policy, id: row.id, approvedAt: row.approved_at, fingerprint: row.fingerprint }
}
export async function withdrawFiscalPolicy(
  database: D1Database,
  claims: VerifiedSessionClaims,
  policyId: string,
  reason: unknown,
  options: { now: string; idempotencyKey: string }
): Promise<void> {
  database = guardedFiscalDatabase(database)
  const now = fiscalClock(options.now),
    id = parsed(fiscalUuid, policyId),
    why = parsed(fiscalReason, reason)
  await admin(database, claims, now())
  const key = commandKey(options.idempotencyKey),
    hash = await sha256Hex(canonicalJson({ policyId: id, reason: why }))
  if (await priorCommand(database, claims, key, 'policy_withdraw', hash)) {
    await admin(database, claims, now())
    return
  }
  if (!(await readFiscalPolicy(database, id, false))) throw new FiscalIssuanceError('not_found')
  const instant = now()
  await commitAdminBatch(
    database,
    [
      database
        .prepare(
          `INSERT INTO fiscal_policy_withdrawals(policy_id,actor_id,reason,created_at)
      SELECT ?5,?1,?6,?4 WHERE ${authPredicate()} ON CONFLICT(policy_id) DO NOTHING`
        )
        .bind(claims.identityId, claims.sessionId, claims.sessionVersion, instant, id, why),
      database
        .prepare(
          `INSERT INTO fiscal_issuance_events(id,policy_id,event_type,actor_id,reason,created_at)
      SELECT ?1,policy_id,'policy_withdrawn',actor_id,reason,created_at FROM fiscal_policy_withdrawals
      WHERE policy_id=?2 AND NOT EXISTS(SELECT 1 FROM fiscal_issuance_events WHERE policy_id=?2 AND event_type='policy_withdrawn')`
        )
        .bind(crypto.randomUUID(), id),
      adminCommand(database, claims, key, 'policy_withdraw', id, hash, instant),
      guard(database, `${authPredicate()} AND EXISTS(SELECT 1 FROM fiscal_policy_withdrawals WHERE policy_id=?5)`, [
        claims.identityId,
        claims.sessionId,
        claims.sessionVersion,
        instant,
        id
      ])
    ],
    claims,
    key,
    'policy_withdraw',
    hash,
    now
  )
  await admin(database, claims, now())
}

/** ONLY historical contractual tables; not products, current prices, tax classes or live shipping rates. */
export async function fiscalContractFromOrder(
  database: D1Database,
  eventId: string,
  policy: FiscalPolicy
): Promise<FiscalContract> {
  database = guardedFiscalDatabase(database)
  const row = await database
    .prepare(
      `SELECT o.*,b.recipient_name,b.company_name,b.nif,b.line1,b.line2,
    b.city,b.province,b.postal_code,b.country_code,q.options_json,e.amount_gross_cents AS captured,
    e.created_at AS captured_at FROM fiscal_outbox_events e JOIN orders o ON o.id=e.order_id
    JOIN order_billing_address b ON b.order_id=o.id JOIN shipping_quotes q ON q.id=o.shipping_quote_id
    JOIN order_payment_states p ON p.order_id=o.id AND p.status='paid' AND p.active_intent_id=e.payment_intent_id
    JOIN payment_intents payment ON payment.id=e.payment_intent_id AND payment.status='captured'
    WHERE e.id=?1 AND e.event_type='invoice.evaluate.requested' AND e.schema_version=1
      AND o.status<>'cancelled' AND e.currency=o.currency AND e.amount_gross_cents=o.total_gross_cents
      AND p.paid_gross_cents=e.amount_gross_cents AND payment.amount_gross_cents=e.amount_gross_cents`
    )
    .bind(eventId)
    .first<Record<string, unknown>>()
  if (!row) throw new FiscalIssuanceError('order_not_facturable')
  const sourceCents = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
  try {
    z.object({
      id: fiscalUuid,
      currency: z.literal('EUR'),
      total_net_cents: sourceCents,
      total_tax_cents: sourceCents,
      total_gross_cents: sourceCents,
      shipping_net_cents: sourceCents,
      shipping_tax_cents: sourceCents,
      shipping_gross_cents: sourceCents,
      shipping_method_code: z.enum(['pickup', 'own_delivery', 'parcel']),
      shipping_rate_version: z.number().int().min(1),
      shipping_eta_min_days: z.number().int().min(0),
      shipping_eta_max_days: z.number().int().min(0),
      contact_email: z.string(),
      recipient_name: z.string(),
      company_name: z.string().nullable(),
      nif: z.string().nullable(),
      line1: z.string(),
      line2: z.string().nullable(),
      city: z.string(),
      province: z.string(),
      postal_code: z.string(),
      country_code: z.literal('ES'),
      options_json: z.string().max(131072),
      captured: sourceCents,
      captured_at: fiscalInstant
    })
      .passthrough()
      .parse(row)
  } catch {
    throw new FiscalD1EvidenceError()
  }
  const lines = (
    await database
      .prepare(
        `SELECT line_index,sku,name,quantity,unit_gross_cents,net_cents,tax_cents,
    gross_cents,tax_rate_basis_points FROM order_lines WHERE order_id=?1 ORDER BY line_index LIMIT 101`
      )
      .bind(row.id)
      .all<Record<string, unknown>>()
  ).results
  try {
    z.array(
      z
        .object({
          line_index: z.number().int().min(0),
          sku: z.string(),
          name: z.string(),
          quantity: z.number().int().min(1),
          unit_gross_cents: sourceCents,
          net_cents: sourceCents,
          tax_cents: sourceCents,
          gross_cents: sourceCents,
          tax_rate_basis_points: z.number().int().min(0).max(10000)
        })
        .strict()
    )
      .max(101)
      .parse(lines)
  } catch {
    throw new FiscalD1EvidenceError()
  }
  if (
    lines.length > 100 ||
    lines.some(
      (line) => Number(line.quantity) > 999 || String(line.sku).length > 160 || String(line.name).length > 500
    ) ||
    Number(row.total_gross_cents) > 1000000000
  )
    throw new FiscalIssuanceError('snapshot_exceeds_provider_limits')
  let options: Record<string, unknown>[]
  try {
    const raw: unknown = JSON.parse(String(row.options_json))
    if (!Array.isArray(raw) || raw.length > 100) throw Error()
    options = raw
  } catch {
    throw new FiscalIssuanceError('shipping_snapshot_invalid')
  }
  const matching = options.filter(
    (option) =>
      option &&
      typeof option === 'object' &&
      option.methodCode === row.shipping_method_code &&
      option.rateVersion === row.shipping_rate_version &&
      option.netCents === row.shipping_net_cents &&
      option.taxCents === row.shipping_tax_cents &&
      option.grossCents === row.shipping_gross_cents &&
      option.etaMinDays === row.shipping_eta_min_days &&
      option.etaMaxDays === row.shipping_eta_max_days &&
      option.currency === 'EUR'
  )
  const rates = [...new Set(matching.map((option) => option.taxRateBasisPoints))]
  if (rates.length !== 1) throw new FiscalIssuanceError('shipping_snapshot_ambiguous')
  const contract = parsed(fiscalContractSchema, {
    schemaVersion: 1,
    fiscalVersion: 1,
    kind: 'ordinary',
    orderId: row.id,
    orderNumber: row.id,
    series: policy.series,
    issuedOn: row.captured_at,
    currency: row.currency,
    paymentMethod: 'redsys',
    idempotencyKey: `invoice:${row.id}:v1`,
    policyId: policy.id,
    policyFingerprint: policy.fingerprint,
    provider: policy.provider,
    environment: policy.environment,
    validationOnly: policy.provider === 'local_fake',
    customer: {
      externalKey: row.id,
      legalName: row.company_name ?? row.buyer_company_name ?? row.recipient_name,
      ...((row.nif ?? row.buyer_tax_id) ? { taxId: row.nif ?? row.buyer_tax_id } : {}),
      email: row.contact_email,
      ...(row.contact_phone ? { phone: row.contact_phone } : {}),
      address: {
        line1: row.line1,
        ...(row.line2 ? { line2: row.line2 } : {}),
        postalCode: row.postal_code,
        city: row.city,
        region: row.province,
        countryCode: row.country_code
      }
    },
    lines: lines.map((line) => {
      // Keep the provider wire's base BEFORE discount. Beply subtracts
      // discountNetCents from lineNetCents; the captured totals are AFTER it.
      const baseNetCents = splitGross(
        Number(line.unit_gross_cents) * Number(line.quantity),
        Number(line.tax_rate_basis_points)
      ).netCents
      return {
        lineIndex: line.line_index,
        sku: line.sku,
        description: line.name,
        quantity: line.quantity,
        unitGrossCents: line.unit_gross_cents,
        unitNetCents: roundRatio(BigInt(baseNetCents), BigInt(Number(line.quantity))),
        lineNetCents: baseNetCents,
        discountNetCents: baseNetCents - Number(line.net_cents),
        netCents: line.net_cents,
        taxCents: line.tax_cents,
        grossCents: line.gross_cents,
        taxRateBasisPoints: line.tax_rate_basis_points
      }
    }),
    shippingNetCents: row.shipping_net_cents,
    shippingTaxCents: row.shipping_tax_cents,
    shippingGrossCents: row.shipping_gross_cents,
    shippingTaxRateBasisPoints: rates[0],
    totalNetCents: row.total_net_cents,
    totalTaxCents: row.total_tax_cents,
    totalGrossCents: row.total_gross_cents
  })
  validateFiscalContract(contract, policy)
  return contract
}
export function validateFiscalContract(contract: FiscalContract, policy: FiscalPolicy): void {
  if (
    contract.policyId !== policy.id ||
    contract.policyFingerprint !== policy.fingerprint ||
    contract.provider !== policy.provider ||
    contract.environment !== policy.environment ||
    contract.series !== policy.series ||
    contract.validationOnly !== (policy.provider === 'local_fake')
  )
    throw new FiscalIssuanceError('contract_policy_mismatch')
  let net = contract.shippingNetCents,
    tax = contract.shippingTaxCents,
    gross = contract.shippingGrossCents
  const shippingTax = roundRatio(
    BigInt(contract.shippingNetCents) * BigInt(contract.shippingTaxRateBasisPoints),
    10000n
  )
  if (shippingTax !== contract.shippingTaxCents || contract.shippingGrossCents !== net + tax)
    throw new FiscalIssuanceError('shipping_amount_mismatch')
  const rateCodes = policy.mappings.taxes
  if (!Object.hasOwn(rateCodes, String(contract.shippingTaxRateBasisPoints)))
    throw new FiscalIssuanceError('tax_mapping_missing')
  contract.lines.forEach((line, index) => {
    const expected = splitGross(line.grossCents, line.taxRateBasisPoints)
    const baseGrossCents = line.quantity * line.unitGrossCents
    const baseNetCents = splitGross(baseGrossCents, line.taxRateBasisPoints).netCents
    if (
      line.lineIndex !== index ||
      line.grossCents > baseGrossCents ||
      line.netCents !== expected.netCents ||
      line.taxCents !== expected.taxCents ||
      line.lineNetCents !== baseNetCents ||
      line.lineNetCents - line.discountNetCents !== line.netCents ||
      !Object.hasOwn(rateCodes, String(line.taxRateBasisPoints))
    )
      throw new FiscalIssuanceError('line_amount_mismatch')
    net += line.netCents
    tax += line.taxCents
    gross += line.grossCents
  })
  if (net !== contract.totalNetCents || tax !== contract.totalTaxCents || gross !== contract.totalGrossCents)
    throw new FiscalIssuanceError('order_amount_mismatch')
}
export async function queueFiscalInvoice(
  database: D1Database,
  claims: VerifiedSessionClaims,
  input: { eventId: string; policyId: string; idempotencyKey: string; now: string }
) {
  database = guardedFiscalDatabase(database)
  const now = fiscalClock(input.now),
    policyId = parsed(fiscalUuid, input.policyId)
  if (typeof input.eventId !== 'string' || !/^invoice-evaluation:[0-9a-f-]{36}$/.test(input.eventId))
    throw new FiscalIssuanceError('invalid_input')
  await admin(database, claims, now())
  const key = commandKey(input.idempotencyKey),
    commandHash = await sha256Hex(canonicalJson({ eventId: input.eventId, policyId }))
  const previous = await priorCommand(database, claims, key, 'invoice_queue', commandHash)
  if (previous) {
    await admin(database, claims, now())
    return { intentId: previous.target_id, replayed: true }
  }
  const policy = await readFiscalPolicy(database, policyId)
  if (!policy || policy.approvedAt > now()) throw new FiscalIssuanceError('blocked_policy')
  const contract = await fiscalContractFromOrder(database, input.eventId, policy)
  const json = canonicalJson(contract),
    fingerprint = await sha256Hex(json)
  const existing = await database
    .prepare('SELECT id,contract_fingerprint FROM fiscal_invoice_intents WHERE event_id=?1')
    .bind(input.eventId)
    .first<{ id: string; contract_fingerprint: string }>()
  if (existing) {
    await admin(database, claims, now())
    if (existing.contract_fingerprint !== fingerprint) throw new FiscalIssuanceError('intent_conflict')
    const replayAt = now()
    await commitAdminBatch(
      database,
      [
        adminCommand(database, claims, key, 'invoice_queue', existing.id, commandHash, replayAt),
        guard(database, authPredicate(), [claims.identityId, claims.sessionId, claims.sessionVersion, replayAt])
      ],
      claims,
      key,
      'invoice_queue',
      commandHash,
      now
    )
    await admin(database, claims, now())
    return { intentId: existing.id, replayed: true }
  }
  const id = crypto.randomUUID(),
    instant = now()
  await admin(database, claims, instant)
  await commitAdminBatch(
    database,
    [
      database
        .prepare(
          `INSERT INTO fiscal_evaluation_inbox(event_id,order_id,received_at)
        SELECT e.id,e.order_id,?4 FROM fiscal_outbox_events e JOIN order_payment_states p ON p.order_id=e.order_id
        WHERE e.id=?5 AND e.order_id=?6 AND e.event_type='invoice.evaluate.requested' AND e.schema_version=1
          AND p.status='paid' AND p.paid_gross_cents=e.amount_gross_cents AND e.amount_gross_cents=?7
          AND ${authPredicate()} AND NOT EXISTS(SELECT 1 FROM fiscal_policy_withdrawals WHERE policy_id=?8)
        ON CONFLICT(event_id) DO NOTHING`
        )
        .bind(
          claims.identityId,
          claims.sessionId,
          claims.sessionVersion,
          instant,
          input.eventId,
          contract.orderId,
          contract.totalGrossCents,
          policy.id
        ),
      database
        .prepare(
          `INSERT INTO fiscal_invoice_intents(id,event_id,order_id,fiscal_version,kind,policy_id,provider,
      validation_only,contract_json,contract_fingerprint,idempotency_key,amount_gross_cents,currency,created_at)
      SELECT ?5,?6,?7,1,'ordinary',?8,?9,?10,?11,?12,?13,?14,'EUR',?4
      WHERE ${authPredicate()} AND EXISTS(SELECT 1 FROM fiscal_evaluation_inbox WHERE event_id=?6 AND order_id=?7)
        AND NOT EXISTS(SELECT 1 FROM fiscal_policy_withdrawals WHERE policy_id=?8)
        AND EXISTS(SELECT 1 FROM order_payment_states WHERE order_id=?7 AND status='paid' AND paid_gross_cents=?14)
      ON CONFLICT(event_id) DO NOTHING`
        )
        .bind(
          claims.identityId,
          claims.sessionId,
          claims.sessionVersion,
          instant,
          id,
          input.eventId,
          contract.orderId,
          policy.id,
          policy.provider,
          contract.validationOnly ? 1 : 0,
          json,
          fingerprint,
          contract.idempotencyKey,
          contract.totalGrossCents
        ),
      database
        .prepare(
          `INSERT INTO fiscal_issuance_work(intent_id,status,available_at)
      SELECT id,'queued',created_at FROM fiscal_invoice_intents WHERE id=?1`
        )
        .bind(id),
      database
        .prepare(
          `UPDATE fiscal_outbox_delivery SET status='ready',available_at=?2,last_error_code=NULL
        WHERE event_id=?1 AND status='blocked_policy' AND EXISTS(SELECT 1 FROM fiscal_invoice_intents WHERE event_id=?1)`
        )
        .bind(input.eventId, instant),
      database
        .prepare(
          `INSERT INTO fiscal_issuance_events(id,intent_id,event_type,actor_id,generation,created_at)
      SELECT ?1,id,'queued',?3,1,created_at FROM fiscal_invoice_intents WHERE id=?2`
        )
        .bind(crypto.randomUUID(), id, claims.identityId),
      database
        .prepare(
          `INSERT INTO fiscal_admin_commands(actor_id,command_key,command_kind,target_id,payload_hash,created_at)
      SELECT ?1,?2,'invoice_queue',id,?3,?4 FROM fiscal_invoice_intents WHERE event_id=?5 AND contract_fingerprint=?6`
        )
        .bind(claims.identityId, key, commandHash, instant, input.eventId, fingerprint),
      guard(
        database,
        `${authPredicate()} AND EXISTS(SELECT 1 FROM fiscal_invoice_intents i JOIN fiscal_issuance_work w ON w.intent_id=i.id
      WHERE i.event_id=?5 AND i.contract_fingerprint=?6)`,
        [claims.identityId, claims.sessionId, claims.sessionVersion, instant, input.eventId, fingerprint]
      )
    ],
    claims,
    key,
    'invoice_queue',
    commandHash,
    now
  )
  const saved = await database
    .prepare('SELECT id FROM fiscal_invoice_intents WHERE event_id=?1')
    .bind(input.eventId)
    .first<{ id: string }>()
  if (!saved) throw new FiscalIssuanceError('commit_unconfirmed')
  await admin(database, claims, now())
  return { intentId: saved.id, replayed: saved.id !== id }
}
interface IntentRow {
  id: string
  order_id: string
  policy_id: string
  provider: 'local_fake' | 'beply'
  contract_json: string
  contract_fingerprint: string
  amount_gross_cents: number
}
async function intent(database: D1Database, id: string): Promise<IntentRow | null> {
  const row = await database
    .prepare(
      'SELECT id,order_id,policy_id,provider,contract_json,contract_fingerprint,amount_gross_cents FROM fiscal_invoice_intents WHERE id=?1'
    )
    .bind(id)
    .first<IntentRow>()
  if (row === null) return null
  try {
    return z
      .object({
        id: z.literal(id),
        order_id: fiscalUuid,
        policy_id: fiscalUuid,
        provider: z.enum(['local_fake', 'beply']),
        contract_json: z.string().min(1).max(131072),
        contract_fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
        amount_gross_cents: z.number().int().min(1).max(1000000000)
      })
      .strict()
      .parse(row)
  } catch {
    throw new FiscalD1EvidenceError()
  }
}
async function validatedIntent(
  database: D1Database,
  row: IntentRow,
  provider: OrdinaryFiscalProvider,
  appEnvironment: string,
  active = true
) {
  let contract: FiscalContract
  try {
    contract = fiscalContractSchema.parse(JSON.parse(row.contract_json))
  } catch {
    throw new FiscalIssuanceError('contract_invalid')
  }
  if ((await sha256Hex(canonicalJson(contract))) !== row.contract_fingerprint)
    throw new FiscalIssuanceError('contract_drift')
  const policy = await readFiscalPolicy(database, row.policy_id, active)
  if (!policy) throw new FiscalIssuanceError('blocked_policy')
  validateFiscalContract(contract, policy)
  if (
    provider.name !== policy.provider ||
    provider.environment !== policy.environment ||
    provider.mappingFingerprint !== (await fiscalMappingFingerprint(policy.mappings)) ||
    (provider.name === 'local_fake' && appEnvironment !== 'local')
  )
    throw new FiscalIssuanceError('provider_configuration_mismatch')
  return contract
}
export async function checksumFiscalPdf(bytes: Uint8Array): Promise<string> {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength < 16 ||
    bytes.byteLength > FISCAL_MAX_PDF_BYTES ||
    new TextDecoder().decode(bytes.subarray(0, 8)).match(/^%PDF-(?:1\.[0-9]|2\.0)/) === null ||
    !new TextDecoder().decode(bytes.subarray(Math.max(0, bytes.length - 1024))).includes('%%EOF')
  )
    throw new FiscalIssuanceError('pdf_invalid')
  const owned = Uint8Array.from(bytes),
    digest = await crypto.subtle.digest('SHA-256', owned)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
function validatedReceipt(raw: unknown, row: IntentRow): FiscalReceipt {
  let receipt: FiscalReceipt
  try {
    receipt = parsed(fiscalReceiptSchema, raw)
  } catch {
    throw new FiscalIssuanceError('provider_receipt_invalid')
  }
  if (receipt.amountCents !== row.amount_gross_cents) throw new FiscalIssuanceError('provider_amount_mismatch')
  return receipt
}
interface Fence {
  token: string
  generation: number
  status: 'issuing' | 'reconciling'
}
async function recordReceipt(
  database: D1Database,
  row: IntentRow,
  receipt: FiscalReceipt,
  fence: Fence,
  now: string,
  claims?: VerifiedSessionClaims
) {
  const statements = [
    database
      .prepare(
        `INSERT INTO fiscal_provider_receipts(intent_id,provider,provider_invoice_id,code,fiscal_status,
      amount_gross_cents,currency,contract_fingerprint,recorded_at)
      SELECT ?1,?2,?3,?4,?5,?6,'EUR',?7,?8 WHERE EXISTS(SELECT 1 FROM fiscal_issuance_work
        WHERE intent_id=?1 AND status=?9 AND lease_token=?10 AND generation=?11 AND lease_until>?8)
      ON CONFLICT(intent_id) DO NOTHING`
      )
      .bind(
        row.id,
        row.provider,
        receipt.providerId,
        receipt.code,
        receipt.status,
        receipt.amountCents,
        row.contract_fingerprint,
        now,
        fence.status,
        fence.token,
        fence.generation
      ),
    guard(
      database,
      `EXISTS(SELECT 1 FROM fiscal_provider_receipts r JOIN fiscal_issuance_work w ON w.intent_id=r.intent_id
      WHERE r.intent_id=?1 AND r.provider_invoice_id=?2 AND r.code=?3 AND r.fiscal_status=?4
      AND r.amount_gross_cents=?5 AND r.contract_fingerprint=?6 AND w.status=?7 AND w.lease_token=?8
      AND w.generation=?9 AND w.lease_until>?10)`,
      [
        row.id,
        receipt.providerId,
        receipt.code,
        receipt.status,
        receipt.amountCents,
        row.contract_fingerprint,
        fence.status,
        fence.token,
        fence.generation,
        now
      ]
    )
  ]
  if (claims)
    statements.push(guard(database, authPredicate(), [claims.identityId, claims.sessionId, claims.sessionVersion, now]))
  await confirmedBatch(database, statements)
}
async function complete(
  database: D1Database,
  row: IntentRow,
  receipt: FiscalReceipt,
  fence: Fence,
  storage: PrivateFiscalStorage,
  bytes: Uint8Array,
  now: () => string,
  reconciliation?: { claims: VerifiedSessionClaims; input: FiscalReconcileInput; payloadHash: string }
) {
  const copied = Uint8Array.from(bytes),
    checksum = await checksumFiscalPdf(copied),
    key = `fiscal/${row.id}/${checksum}.pdf`
  await storage.put(key, copied)
  if (reconciliation) await admin(database, reconciliation.claims, now())
  const instant = now(),
    eventId = crypto.randomUUID()
  const email = await prepareEmailOutboxEnqueue(database, {
    sourceEventId: eventId,
    sourceKind: 'invoice',
    sourceId: row.id,
    eventType: 'invoice.issued',
    now: instant
  })
  const statements = [
    database
      .prepare(
        `INSERT INTO fiscal_documents(id,intent_id,order_id,storage_key,pdf_checksum,pdf_size,created_at)
      SELECT ?1,?1,?2,?3,?4,?5,?6 WHERE EXISTS(SELECT 1 FROM fiscal_issuance_work
        WHERE intent_id=?1 AND status=?7 AND lease_token=?8 AND generation=?9 AND lease_until>?6)`
      )
      .bind(row.id, row.order_id, key, checksum, copied.length, instant, fence.status, fence.token, fence.generation),
    database
      .prepare(
        `UPDATE fiscal_issuance_work SET status='completed',completed_at=?4,lease_token=NULL,
      lease_until=NULL,last_error_code=NULL WHERE intent_id=?1 AND status=?5 AND lease_token=?2 AND generation=?3
      AND lease_until>?4 AND EXISTS(SELECT 1 FROM fiscal_documents WHERE intent_id=?1) RETURNING intent_id`
      )
      .bind(row.id, fence.token, fence.generation, instant, fence.status),
    database
      .prepare(
        `INSERT INTO order_events(id,order_id,event_type,payload_json,correlation_id,created_at)
      SELECT ?1,?2,'invoice.issued',?3,?4,?5 WHERE EXISTS(SELECT 1 FROM fiscal_documents WHERE intent_id=?4)`
      )
      .bind(
        eventId,
        row.order_id,
        canonicalJson({
          invoiceId: row.id,
          provider: row.provider,
          code: receipt.code,
          validationOnly: row.provider === 'local_fake'
        }),
        row.id,
        instant
      ),
    email.statement,
    database
      .prepare(
        `INSERT INTO fiscal_issuance_events(id,intent_id,event_type,actor_id,reason,evidence_ref,generation,created_at)
      SELECT ?1,?2,?3,?4,?5,?6,?7,?8 WHERE EXISTS(SELECT 1 FROM fiscal_documents WHERE intent_id=?2)`
      )
      .bind(
        crypto.randomUUID(),
        row.id,
        reconciliation ? 'reconciled' : 'completed',
        reconciliation?.claims.identityId ?? null,
        reconciliation?.input.reason ?? null,
        reconciliation?.input.evidenceRef ?? null,
        fence.generation,
        instant
      )
  ]
  if (reconciliation) {
    const { claims, input, payloadHash } = reconciliation
    statements.push(
      database
        .prepare(
          `INSERT INTO fiscal_reconciliation_commands(intent_id,command_key,payload_hash,actor_id,outcome,created_at)
      VALUES (?1,?2,?3,?4,'completed',?5)`
        )
        .bind(row.id, input.idempotencyKey, payloadHash, claims.identityId, instant)
    )
    statements.push(
      guard(database, authPredicate(), [claims.identityId, claims.sessionId, claims.sessionVersion, instant])
    )
  }
  statements.push(
    guard(
      database,
      `EXISTS(SELECT 1 FROM fiscal_issuance_work w JOIN fiscal_documents d ON d.intent_id=w.intent_id
    JOIN order_events e ON e.id=?2 JOIN email_outbox_events email ON email.source_event_id=e.id
    WHERE w.intent_id=?1 AND w.status='completed' AND w.generation=?3 AND e.order_id=?4
      AND email.event_type='invoice.issued' AND email.source_id=?1)`,
      [row.id, eventId, fence.generation, row.order_id]
    )
  )
  await confirmedBatch(database, statements)
}
async function quarantine(database: D1Database, id: string, fence: Fence, code: string) {
  await confirmedBatch(database, [
    database
      .prepare(
        `UPDATE fiscal_issuance_work SET status='uncertain',lease_token=NULL,lease_until=NULL,last_error_code=?4
      WHERE intent_id=?1 AND status=?5 AND lease_token=?2 AND generation=?3 RETURNING intent_id`
      )
      .bind(id, fence.token, fence.generation, code, fence.status)
    // The state-transition trigger persists the event atomically, including
    // crash-sweep transitions. No second independently acknowledged insert.
  ])
}
export interface FiscalDispatchReport {
  completed: number
  uncertain: number
  blocked: number
  lostLease: number
  disabled: boolean
}
/** No default provider/config. No issuing marker is ever automatically reissued. */
export async function dispatchFiscalIssuance(
  database: D1Database,
  provider: OrdinaryFiscalProvider | undefined,
  storage: PrivateFiscalStorage | undefined,
  config: {
    now: string
    limit?: number
    appEnvironment: 'local' | 'preview' | 'production'
    allowProviderIssuance?: boolean
    /** Server-owned runtime selection. Never consume another policy's work. */
    policyId?: string
  }
): Promise<FiscalDispatchReport> {
  database = guardedFiscalDatabase(database)
  const now = fiscalClock(config.now),
    limit = config.limit ?? 25
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new FiscalIssuanceError('invalid_limit')
  if (config.policyId !== undefined && !fiscalUuid.safeParse(config.policyId).success)
    throw new FiscalIssuanceError('invalid_input')
  const report: FiscalDispatchReport = {
    completed: 0,
    uncertain: 0,
    blocked: 0,
    lostLease: 0,
    disabled: config.allowProviderIssuance !== true
  }
  const stale = await database
    .prepare(
      `UPDATE fiscal_issuance_work SET status='uncertain',lease_token=NULL,lease_until=NULL,
    last_error_code='issuing_lease_expired' WHERE intent_id IN(SELECT intent_id FROM fiscal_issuance_work
      WHERE status IN('issuing','reconciling') AND lease_until<=?1 ORDER BY lease_until,intent_id LIMIT ?2) RETURNING intent_id`
    )
    .bind(now(), limit)
    .all<{ intent_id: string }>()
  report.uncertain += stale.results.length
  if (report.disabled) return report
  if (!provider || !storage) throw new FiscalIssuanceError('provider_unavailable')
  const exhausted = await database
    .prepare(
      `UPDATE fiscal_issuance_work SET status='manual_review',lease_token=NULL,
    lease_until=NULL,last_error_code='preparation_attempts_exhausted' WHERE intent_id IN(
      SELECT intent_id FROM fiscal_issuance_work WHERE attempts>=10 AND (status='queued' OR(status='leased' AND lease_until<=?1))
      AND (?3 IS NULL OR EXISTS(SELECT 1 FROM fiscal_invoice_intents i WHERE i.id=intent_id AND i.policy_id=?3))
      ORDER BY available_at,intent_id LIMIT ?2) RETURNING intent_id`
    )
    .bind(now(), limit, config.policyId ?? null)
    .all()
  report.blocked += exhausted.results.length
  const candidates = (
    await database
      .prepare(
        `SELECT intent_id FROM fiscal_issuance_work WHERE attempts<10 AND
    ((status='queued' AND available_at<=?1) OR (status='leased' AND lease_until<=?1))
    AND (?3 IS NULL OR EXISTS(SELECT 1 FROM fiscal_invoice_intents i WHERE i.id=intent_id AND i.policy_id=?3))
    ORDER BY available_at,intent_id LIMIT ?2`
      )
      .bind(now(), limit, config.policyId ?? null)
      .all<{ intent_id: string }>()
  ).results
  for (const { intent_id: id } of candidates) {
    if (!fiscalUuid.safeParse(id).success) throw new FiscalD1EvidenceError()
    const token = crypto.randomUUID(),
      instant = now()
    const claimed = await database
      .prepare(
        `UPDATE fiscal_issuance_work SET status='leased',lease_token=?2,lease_until=?3,
      generation=generation+1,attempts=attempts+1 WHERE intent_id=?1 AND attempts<10 AND
      ((status='queued' AND available_at<=?4) OR (status='leased' AND lease_until<=?4)) RETURNING generation,attempts`
      )
      .bind(id, token, after(instant, 60), instant)
      .first<{ generation: number; attempts: number }>()
    if (!claimed) continue
    try {
      z.object({
        generation: z.number().int().min(2).max(Number.MAX_SAFE_INTEGER),
        attempts: z.number().int().min(1).max(10)
      })
        .strict()
        .parse(claimed)
    } catch {
      throw new FiscalD1EvidenceError()
    }
    const fence: Fence = { token, generation: claimed.generation, status: 'issuing' }
    let row: IntentRow | null, contract: FiscalContract
    try {
      row = await intent(database, id)
      if (!row) throw new FiscalIssuanceError('intent_missing')
      contract = await validatedIntent(database, row, provider, config.appEnvironment)
      const markerInstant = now()
      await confirmedBatch(database, [
        database
          .prepare(
            `UPDATE fiscal_issuance_work SET status='issuing',issuing_at=?4,lease_until=?5,last_error_code=NULL
          WHERE intent_id=?1 AND status='leased' AND lease_token=?2 AND generation=?3 AND lease_until>?4
            AND NOT EXISTS(SELECT 1 FROM fiscal_policy_withdrawals WHERE policy_id=?6)
          RETURNING intent_id`
          )
          .bind(id, token, claimed.generation, markerInstant, after(markerInstant, 900), row.policy_id),
        database
          .prepare(
            `INSERT INTO fiscal_issuance_events(id,intent_id,event_type,generation,created_at)
          SELECT ?1,intent_id,'issuing',generation,?3 FROM fiscal_issuance_work
          WHERE intent_id=?2 AND status='issuing' AND lease_token=?4 AND generation=?5`
          )
          .bind(crypto.randomUUID(), id, markerInstant, token, claimed.generation),
        guard(
          database,
          `EXISTS(SELECT 1 FROM fiscal_issuance_work WHERE intent_id=?1 AND status='issuing'
          AND lease_token=?2 AND generation=?3 AND lease_until>?4)`,
          [id, token, claimed.generation, markerInstant]
        )
      ])
    } catch (error) {
      if (error instanceof FiscalD1EvidenceError) throw error
      const changed = await database
        .prepare(
          `UPDATE fiscal_issuance_work SET status='manual_review',lease_token=NULL,lease_until=NULL,
        last_error_code='preparation_blocked' WHERE intent_id=?1 AND status='leased' AND lease_token=?2 AND generation=?3 RETURNING intent_id`
        )
        .bind(id, token, claimed.generation)
        .first()
      if (changed) report.blocked++
      else report.lostLease++
      continue
    }
    let errorCode = 'provider_outcome_unknown'
    try {
      const raw = await provider.issueInvoice(contract!)
      errorCode = 'provider_receipt_invalid'
      const receipt = validatedReceipt(raw, row!)
      errorCode = 'provider_ack_failed'
      await recordReceipt(database, row!, receipt, fence, now())
      errorCode = 'pdf_unavailable'
      const bytes = await provider.downloadPdf(receipt.providerId)
      errorCode = 'pdf_invalid'
      await checksumFiscalPdf(bytes)
      errorCode = 'completion_unconfirmed'
      await complete(database, row!, receipt, fence, storage, bytes, now)
      report.completed++
    } catch {
      try {
        await quarantine(database, id, fence, errorCode)
      } catch {
        /* Marker stays durable and non-retryable. */
      }
      report.uncertain++
    }
  }
  return report
}

/** Reconciliation is evidence recovery, never a second issue call. An absent
 * or unverified external-key lookup does NOT prove an in-flight issue failed. */
export async function reconcileFiscalInvoice(
  database: D1Database,
  claims: VerifiedSessionClaims,
  intentId: string,
  input: unknown,
  provider: OrdinaryFiscalProvider,
  storage: PrivateFiscalStorage,
  options: { now: string; appEnvironment: 'local' | 'preview' | 'production' }
): Promise<{ outcome: 'completed' | 'blocked'; replayed: boolean }> {
  database = guardedFiscalDatabase(database)
  const now = fiscalClock(options.now),
    id = parsed(fiscalUuid, intentId),
    command = parsed(fiscalReconcileInputSchema, input)
  await admin(database, claims, now())
  const payloadHash = await sha256Hex(canonicalJson(command))
  const previous = await database
    .prepare(
      'SELECT payload_hash,actor_id,outcome FROM fiscal_reconciliation_commands WHERE intent_id=?1 AND command_key=?2'
    )
    .bind(id, command.idempotencyKey)
    .first<{ payload_hash: string; actor_id: string; outcome: 'completed' | 'blocked' }>()
  if (previous) {
    await admin(database, claims, now())
    if (previous.payload_hash !== payloadHash || previous.actor_id !== claims.identityId)
      throw new FiscalIssuanceError('idempotency_conflict')
    return { outcome: previous.outcome, replayed: true }
  }
  const row = await intent(database, id)
  if (!row) throw new FiscalIssuanceError('not_found')
  const contract = await validatedIntent(database, row, provider, options.appEnvironment, false)
  const token = crypto.randomUUID(),
    instant = now()
  await admin(database, claims, instant)
  const results = await confirmedBatch(database, [
    database
      .prepare(
        `UPDATE fiscal_issuance_work SET status='reconciling',generation=generation+1,lease_token=?6,lease_until=?7
      WHERE intent_id=?5 AND generation=?8 AND (status='uncertain' OR (status='reconciling' AND lease_until<=?4))
        AND ${authPredicate()} RETURNING generation`
      )
      .bind(
        claims.identityId,
        claims.sessionId,
        claims.sessionVersion,
        instant,
        id,
        token,
        after(instant, 900),
        command.expectedGeneration
      ),
    database
      .prepare(
        `INSERT INTO fiscal_issuance_events(id,intent_id,event_type,actor_id,reason,evidence_ref,generation,created_at)
      SELECT ?1,intent_id,'reconciliation_started',?3,?4,?5,generation,?6 FROM fiscal_issuance_work
      WHERE intent_id=?2 AND status='reconciling' AND lease_token=?7`
      )
      .bind(crypto.randomUUID(), id, claims.identityId, command.reason, command.evidenceRef, instant, token),
    guard(
      database,
      `EXISTS(SELECT 1 FROM fiscal_issuance_work WHERE intent_id=?1 AND status='reconciling' AND lease_token=?2)`,
      [id, token]
    )
  ]).catch(() => {
    throw new FiscalIssuanceError('version_conflict')
  })
  const generation = results[0]?.results?.[0] as { generation: number } | undefined
  if (!generation || !Number.isSafeInteger(generation.generation)) throw new FiscalIssuanceError('commit_unconfirmed')
  const fence: Fence = { token, generation: generation.generation, status: 'reconciling' }
  let receipt: FiscalReceipt | null = null,
    errorCode = 'lookup_unavailable'
  try {
    const saved = await database
      .prepare(
        `SELECT provider_invoice_id AS providerId,code,fiscal_status AS status,
      amount_gross_cents AS amountCents,currency FROM fiscal_provider_receipts WHERE intent_id=?1`
      )
      .bind(id)
      .first()
    if (saved) receipt = validatedReceipt(saved, row)
    else if (provider.lookupByExternalKey) {
      const evidence = await provider.lookupByExternalKey(contract.idempotencyKey, row.contract_fingerprint)
      await admin(database, claims, now())
      if (
        !evidence ||
        evidence.authoritative !== true ||
        evidence.externalKey !== contract.idempotencyKey ||
        evidence.contractFingerprint !== row.contract_fingerprint ||
        !Array.isArray(evidence.receipts) ||
        evidence.receipts.length !== 1
      )
        throw new FiscalIssuanceError('lookup_ambiguous')
      receipt = validatedReceipt(evidence.receipts[0], row)
    }
    await admin(database, claims, now())
    if (!receipt) throw new FiscalIssuanceError('lookup_unavailable')
    errorCode = 'receipt_reconciliation_failed'
    await recordReceipt(database, row, receipt, fence, now(), claims)
    const bytes = await provider.downloadPdf(receipt.providerId)
    await admin(database, claims, now())
    errorCode = 'pdf_reconciliation_failed'
    await complete(database, row, receipt, fence, storage, bytes, now, { claims, input: command, payloadHash })
    await admin(database, claims, now())
    return { outcome: 'completed', replayed: false }
  } catch (error) {
    if (
      error instanceof FiscalIssuanceError &&
      ['unauthenticated', 'forbidden', 'email_unverified', 'mfa_required'].includes(error.code)
    )
      throw error
    await admin(database, claims, now())
    const blockedAt = now()
    await confirmedBatch(database, [
      database
        .prepare(
          `UPDATE fiscal_issuance_work SET status='uncertain',lease_token=NULL,lease_until=NULL,last_error_code=?6
        WHERE intent_id=?5 AND status='reconciling' AND lease_token=?7 AND generation=?8 AND lease_until>?4
          AND ${authPredicate()} RETURNING intent_id`
        )
        .bind(
          claims.identityId,
          claims.sessionId,
          claims.sessionVersion,
          blockedAt,
          id,
          errorCode,
          token,
          fence.generation
        ),
      database
        .prepare(
          `INSERT INTO fiscal_reconciliation_commands(intent_id,command_key,payload_hash,actor_id,outcome,created_at)
        SELECT ?1,?2,?3,?4,'blocked',?5 WHERE EXISTS(SELECT 1 FROM fiscal_issuance_work
          WHERE intent_id=?1 AND status='uncertain' AND generation=?6)`
        )
        .bind(id, command.idempotencyKey, payloadHash, claims.identityId, blockedAt, fence.generation),
      database
        .prepare(
          `INSERT INTO fiscal_issuance_events(id,intent_id,event_type,actor_id,reason,evidence_ref,generation,error_code,created_at)
        SELECT ?1,?2,'reconciliation_blocked',?3,?4,?5,?6,?7,?8 WHERE EXISTS(SELECT 1 FROM fiscal_reconciliation_commands
          WHERE intent_id=?2 AND command_key=?9)`
        )
        .bind(
          crypto.randomUUID(),
          id,
          claims.identityId,
          command.reason,
          command.evidenceRef,
          fence.generation,
          errorCode,
          blockedAt,
          command.idempotencyKey
        ),
      guard(
        database,
        `${authPredicate()} AND EXISTS(SELECT 1 FROM fiscal_reconciliation_commands WHERE intent_id=?5 AND command_key=?6)`,
        [claims.identityId, claims.sessionId, claims.sessionVersion, blockedAt, id, command.idempotencyKey]
      )
    ]).catch(() => {
      throw new FiscalIssuanceError('version_conflict')
    })
    await admin(database, claims, now())
    return { outcome: 'blocked', replayed: false }
  }
}
