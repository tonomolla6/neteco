import { z } from 'zod'
import { refundPolicyInputSchema, type RefundPolicy, type RefundPolicyInput } from '../../shared/order-refunds'
import { creditPolicyInputSchema, type CreditPolicy, type CreditPolicyInput } from '../../shared/fiscal-credit'
import { fiscalUuid, fiscalHash, fiscalInstant, fiscalReason } from '../../shared/fiscal-issuance'
import { canonicalJson } from '../catalog/inventory'
import { guardedFiscalDatabase } from '../fiscal/d1-boundary'
import type { VerifiedSessionClaims } from '../catalog/authorization'
import {
  admin,
  checked,
  clock,
  hash,
  replay,
  commandStatement,
  eventStatement,
  authorizationGuard,
  RefundError,
  type RefundCommandOptions
} from './authority'

type Scope = 'refund' | 'credit'
const rowSchema = z
  .object({
    id: fiscalUuid,
    policy_json: z.string().max(16384),
    fingerprint: fiscalHash,
    approved_at: fiscalInstant,
    withdrawn: z.union([z.literal(0), z.literal(1)])
  })
  .strict()
export async function readFinancialPolicy(
  database: D1Database,
  id: string,
  scope: 'refund',
  current?: boolean
): Promise<RefundPolicy | null>
export async function readFinancialPolicy(
  database: D1Database,
  id: string,
  scope: 'credit',
  current?: boolean
): Promise<CreditPolicy | null>
export async function readFinancialPolicy(
  database: D1Database,
  id: string,
  scope: Scope,
  current = true
): Promise<RefundPolicy | CreditPolicy | null> {
  database = guardedFiscalDatabase(database)
  checked(fiscalUuid, id)
  const raw = await database
    .prepare(
      `SELECT p.id,p.policy_json,p.fingerprint,p.approved_at,EXISTS(SELECT 1 FROM financial_policy_withdrawals w WHERE w.policy_id=p.id) AS withdrawn FROM financial_policies p WHERE p.id=?1 AND p.scope=?2`
    )
    .bind(id, scope)
    .first()
  if (raw === null) return null
  const row = checked(rowSchema, raw, 'read_unconfirmed')
  if (current && row.withdrawn === 1) return null
  let input: RefundPolicyInput | CreditPolicyInput
  try {
    input =
      scope === 'refund'
        ? checked(refundPolicyInputSchema, JSON.parse(row.policy_json), 'read_unconfirmed')
        : checked(creditPolicyInputSchema, JSON.parse(row.policy_json), 'read_unconfirmed')
  } catch {
    throw new RefundError('read_unconfirmed')
  }
  if ((await hash({ scope, input })) !== row.fingerprint) throw new RefundError('read_unconfirmed')
  return { ...input, id: row.id, approvedAt: row.approved_at, fingerprint: row.fingerprint }
}
async function approve(
  database: D1Database,
  claims: VerifiedSessionClaims,
  scope: Scope,
  input: RefundPolicyInput | CreditPolicyInput,
  options: RefundCommandOptions
) {
  database = guardedFiscalDatabase(database)
  const now = clock(options)
  await admin(database, claims, now)
  const payloadHash = await hash({ scope, input }),
    kind = `policy_approve_${scope}`
  const prior = await replay(database, claims, input.idempotencyKey, kind, payloadHash)
  if (prior !== null) {
    await admin(database, claims, now)
    return prior
  }
  const id = crypto.randomUUID(),
    at = now(),
    response = { ...input, id, fingerprint: payloadHash, approvedAt: at }
  try {
    await database.batch([
      database
        .prepare(
          'INSERT INTO financial_policies(id,scope,policy_json,fingerprint,actor_id,approved_at) VALUES(?1,?2,?3,?4,?5,?6)'
        )
        .bind(id, scope, canonicalJson(input), payloadHash, claims.identityId, at),
      eventStatement(database, {
        scope: 'policy',
        target: id,
        kind: 'approved',
        actor: claims.identityId,
        now: at,
        reason: input.reason,
        evidenceRef: input.evidenceRef
      }),
      commandStatement(database, claims, input.idempotencyKey, kind, id, payloadHash, response, at),
      authorizationGuard(database, claims, options)
    ])
  } catch (failure) {
    await admin(database, claims, now)
    const raced = await replay(database, claims, input.idempotencyKey, kind, payloadHash)
    if (raced !== null) return raced
    throw failure instanceof RefundError ? failure : new RefundError('conflict')
  }
  await admin(database, claims, now)
  return response
}
export async function approveRefundPolicy(
  database: D1Database,
  claims: VerifiedSessionClaims,
  raw: RefundPolicyInput,
  options: RefundCommandOptions = {}
): Promise<RefundPolicy> {
  const input = checked(refundPolicyInputSchema, raw)
  const value = await approve(database, claims, 'refund', input, options)
  const metadata = checked(
    z.object({ id: fiscalUuid, fingerprint: fiscalHash, approvedAt: fiscalInstant }).passthrough(),
    value,
    'read_unconfirmed'
  )
  return {
    ...checked(refundPolicyInputSchema, { ...input }),
    id: metadata.id,
    fingerprint: metadata.fingerprint,
    approvedAt: metadata.approvedAt
  }
}
export async function approveCreditPolicy(
  database: D1Database,
  claims: VerifiedSessionClaims,
  raw: CreditPolicyInput,
  options: RefundCommandOptions = {}
): Promise<CreditPolicy> {
  const input = checked(creditPolicyInputSchema, raw)
  const value = await approve(database, claims, 'credit', input, options)
  const metadata = checked(
    z.object({ id: fiscalUuid, fingerprint: fiscalHash, approvedAt: fiscalInstant }).passthrough(),
    value,
    'read_unconfirmed'
  )
  return { ...input, id: metadata.id, fingerprint: metadata.fingerprint, approvedAt: metadata.approvedAt }
}
export async function withdrawFinancialPolicy(
  database: D1Database,
  claims: VerifiedSessionClaims,
  policyId: string,
  reason: string,
  idempotencyKey: string,
  options: RefundCommandOptions = {}
) {
  database = guardedFiscalDatabase(database)
  checked(fiscalUuid, policyId)
  checked(fiscalReason, reason)
  const now = clock(options)
  await admin(database, claims, now)
  const payloadHash = await hash({ policyId, reason }),
    prior = await replay(database, claims, idempotencyKey, 'policy_withdraw', payloadHash)
  if (prior !== null) {
    await admin(database, claims, now)
    return prior
  }
  const response = { policyId, withdrawn: true },
    at = now()
  try {
    await database.batch([
      database
        .prepare('INSERT INTO financial_policy_withdrawals(policy_id,actor_id,reason,created_at) VALUES(?1,?2,?3,?4)')
        .bind(policyId, claims.identityId, reason, at),
      eventStatement(database, {
        scope: 'policy',
        target: policyId,
        kind: 'withdrawn',
        actor: claims.identityId,
        reason,
        now: at
      }),
      commandStatement(database, claims, idempotencyKey, 'policy_withdraw', policyId, payloadHash, response, at),
      authorizationGuard(database, claims, options)
    ])
  } catch (failure) {
    await admin(database, claims, now)
    const raced = await replay(database, claims, idempotencyKey, 'policy_withdraw', payloadHash)
    if (raced !== null) return raced
    throw failure instanceof RefundError ? failure : new RefundError('conflict')
  }
  await admin(database, claims, now)
  return response
}
