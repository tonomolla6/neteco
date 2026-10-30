import type { ZodType } from 'zod'
import { z } from 'zod'
import {
  PROMO_FRAUD_KINDS,
  PROMO_FRAUD_SIGNAL_RETENTION_DAYS,
  PROMO_FRAUD_WINDOW_DAYS,
  appealInputSchema,
  appealResolutionInputSchema,
  assessInputSchema,
  caseDecisionInputSchema,
  evaluatePromoFraud,
  isPromoBenefitBlocked,
  normalizePromoSignal,
  type PromoFraudDecision,
  type PromoFraudKind,
  type PromoFraudStatus
} from '../../shared/promo-fraud'
import { authorizeD1Session, type VerifiedSessionClaims } from '../catalog/authorization'
import { activeOrderCustomerId } from '../catalog/customer-orders'
import { adminExistsSql, hmacSha256Hex, plusDays, isUniqueViolation, payloadHash } from './controls-common'

/** SEC-036. Governed promotional / referral fraud cases. `assessPromoFraud` is a SERVER entry point
 * (checkout / referral attribution): the customer, the signals and the clock are supplied by trusted
 * server code, never by an HTTP body. Reviews and appeals are CAS-versioned, audited append-only and
 * written atomically (one D1 batch) with the live authority re-checked inside the write. */
export class PromoFraudError extends Error {
  constructor(
    readonly code:
      | 'invalid_input'
      | 'unauthenticated'
      | 'email_unverified'
      | 'mfa_required'
      | 'forbidden'
      | 'not_found'
      | 'version_conflict'
      | 'invalid_transition'
      | 'idempotency_conflict'
      | 'already_assessed'
      | 'customer_not_found'
      | 'self_review'
      | 'same_reviewer'
      | 'appeal_not_allowed'
      | 'security_configuration_missing'
  ) {
    super(code)
    this.name = 'PromoFraudError'
  }
}
const fail = (code: PromoFraudError['code']): never => {
  throw new PromoFraudError(code)
}
const clock = (now?: string) => {
  const value = now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value) || new Date(value).toISOString().replace('.000Z', 'Z') !== value)
    fail('invalid_input')
  return value
}
const uuid = z.string().uuid()
function parse<T>(schema: ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) return fail('invalid_input')
  return parsed.data
}

export interface PromoFraudCaseView {
  id: string
  context: 'referral' | 'promotion'
  refId: string
  customerId: string
  decision: PromoFraudDecision
  score: number
  exceededKinds: PromoFraudKind[]
  status: PromoFraudStatus
  version: number
  decidedBy: string | null
  decidedAt: string | null
  decisionNote: string | null
  createdAt: string
  updatedAt: string
  appealStatus: 'pending' | 'accepted' | 'rejected' | null
}
interface CaseRow {
  id: string
  context: 'referral' | 'promotion'
  ref_id: string
  customer_id: string
  payload_hash: string
  decision: PromoFraudDecision
  score: number
  exceeded_kinds: string
  status: PromoFraudStatus
  version: number
  decided_by: string | null
  decided_at: string | null
  decision_note: string | null
  created_at: string
  updated_at: string
  appeal_status: 'pending' | 'accepted' | 'rejected' | null
}
const CASE_SELECT = `SELECT c.*, (SELECT a.status FROM promo_fraud_appeals a WHERE a.case_id=c.id) AS appeal_status FROM promo_fraud_cases c`
const toView = (row: CaseRow): PromoFraudCaseView => ({
  id: row.id,
  context: row.context,
  refId: row.ref_id,
  customerId: row.customer_id,
  decision: row.decision,
  score: row.score,
  exceededKinds: JSON.parse(row.exceeded_kinds) as PromoFraudKind[],
  status: row.status,
  version: row.version,
  decidedBy: row.decided_by,
  decidedAt: row.decided_at,
  decisionNote: row.decision_note,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  appealStatus: row.appeal_status
})
const readCase = (database: D1Database, id: string) =>
  database.prepare(`${CASE_SELECT} WHERE c.id=?1`).bind(id).first<CaseRow>()

async function authorizeAdmin(database: D1Database, claims: VerifiedSessionClaims, now: string) {
  const result = await authorizeD1Session(database, claims, 'administration.manage', { now, requireMfa: true })
  if (!result.allowed) fail(result.code)
  return claims.identityId
}

/** ---- assessment (server entry point) ---- */
export async function assessPromoFraud(
  database: D1Database,
  rawInput: unknown,
  context: { now?: string; pepper: string }
): Promise<{ case: PromoFraudCaseView; replayed: boolean }> {
  const input = parse(assessInputSchema, rawInput)
  const now = clock(context.now)
  if (typeof context.pepper !== 'string' || context.pepper.length < 32) fail('security_configuration_missing')
  const hashes: Array<{ id: string; k: PromoFraudKind; h: string }> = []
  for (const kind of PROMO_FRAUD_KINDS) {
    const raw = input.signals[kind]
    if (raw === undefined) continue
    const normalized = normalizePromoSignal(kind, raw)
    if (!normalized) fail('invalid_input')
    hashes.push({ id: crypto.randomUUID(), k: kind, h: await hmacSha256Hex(context.pepper, `${kind}:${normalized}`) })
  }
  const hash = await payloadHash('promo-fraud-assess', {
    context: input.context,
    refId: input.refId,
    customerId: input.customerId,
    signals: hashes.map(({ k, h }) => [k, h])
  })
  const replay = async () => {
    const row = await database.prepare(`${CASE_SELECT} WHERE c.command_id=?1`).bind(input.commandId).first<CaseRow>()
    if (!row) return null
    if (row.payload_hash !== hash) fail('idempotency_conflict')
    return { case: toView(row), replayed: true }
  }
  const prior = await replay()
  if (prior) return prior

  const since = plusDays(now, -PROMO_FRAUD_WINDOW_DAYS)
  // One bounded read: distinct OTHER customers that shared each signal inside the window.
  // Known limit: this read and the batch below are not one transaction, so two customers assessed at the
  // same instant can both see zero sharing. Review of later cases and the 30 day window mitigate it.
  const shared = await database
    .prepare(
      `SELECT s.kind AS kind, count(DISTINCT s.customer_id) AS n FROM promo_fraud_signals s
       WHERE s.created_at>=?1 AND s.customer_id<>?2
         AND EXISTS(SELECT 1 FROM json_each(?3) j WHERE json_extract(j.value,'$.k')=s.kind AND json_extract(j.value,'$.h')=s.signal_hash)
       GROUP BY s.kind`
    )
    .bind(since, input.customerId, JSON.stringify(hashes.map(({ k, h }) => ({ k, h }))))
    .all<{ kind: PromoFraudKind; n: number }>()
  const counts: Partial<Record<PromoFraudKind, number>> = {}
  for (const row of shared.results) counts[row.kind] = row.n
  const verdict = evaluatePromoFraud(counts)
  const caseId = crypto.randomUUID()
  const status: PromoFraudStatus = verdict.decision === 'clear' ? 'closed' : 'open'
  try {
    await database.batch([
      database
        .prepare(
          `INSERT INTO promo_fraud_cases(id,command_id,payload_hash,context,ref_id,customer_id,decision,score,exceeded_kinds,shared_counts,status,version,created_at,updated_at)
           VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,1,?12,?12)`
        )
        .bind(
          caseId,
          input.commandId,
          hash,
          input.context,
          input.refId,
          input.customerId,
          verdict.decision,
          verdict.score,
          JSON.stringify(verdict.exceededKinds),
          JSON.stringify(counts),
          status,
          now
        ),
      database
        .prepare(
          `INSERT INTO promo_fraud_signals(id,case_id,customer_id,kind,signal_hash,created_at)
           SELECT json_extract(value,'$.id'),?1,?2,json_extract(value,'$.k'),json_extract(value,'$.h'),?3 FROM json_each(?4)`
        )
        .bind(caseId, input.customerId, now, JSON.stringify(hashes)),
      database
        .prepare(
          `INSERT INTO promo_fraud_events(id,case_id,action,actor_identity_id,detail,created_at) VALUES(?1,?2,'assessed',NULL,?3,?4)`
        )
        .bind(
          crypto.randomUUID(),
          caseId,
          JSON.stringify({ decision: verdict.decision, score: verdict.score, exceededKinds: verdict.exceededKinds }),
          now
        )
    ])
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    if (/FOREIGN KEY/i.test(message)) return fail('customer_not_found')
    if (isUniqueViolation(error)) {
      const winner = await replay()
      if (winner) return winner
      if (/promo_fraud_cases\.context|ref_id/.test(message)) return fail('already_assessed')
      return fail('idempotency_conflict')
    }
    throw error
  }
  return { case: toView((await readCase(database, caseId))!), replayed: false }
}

/** ---- benefit gate (server callers: referral settlement, checkout) ---- */
export async function getPromoFraudBenefitGates(
  database: D1Database,
  context: 'referral' | 'promotion',
  refIds: readonly string[]
): Promise<Map<string, { blocked: boolean; caseId: string | null; status: PromoFraudStatus | null }>> {
  const refs = parse(z.array(z.string().regex(/^[A-Za-z0-9._:-]{1,120}$/)).max(100), [...refIds])
  const gates = new Map<string, { blocked: boolean; caseId: string | null; status: PromoFraudStatus | null }>()
  if (!refs.length) return gates
  const { results } = await database
    .prepare(
      `SELECT c.ref_id, c.id, c.decision, c.status FROM promo_fraud_cases c
       WHERE c.context=?1 AND c.ref_id IN(SELECT value FROM json_each(?2))`
    )
    .bind(context, JSON.stringify(refs))
    .all<{ ref_id: string; id: string; decision: PromoFraudDecision; status: PromoFraudStatus }>()
  const byRef = new Map(results.map((row) => [row.ref_id, row]))
  for (const ref of refs) {
    const row = byRef.get(ref)
    gates.set(
      ref,
      row
        ? { blocked: isPromoBenefitBlocked(row.decision, row.status), caseId: row.id, status: row.status }
        : { blocked: false, caseId: null, status: null }
    )
  }
  return gates
}

/** ---- administrative review ---- */
export async function listPromoFraudCases(
  database: D1Database,
  claims: VerifiedSessionClaims,
  query: { filter?: 'pending' | 'all'; limit?: number },
  context: { now?: string } = {}
): Promise<PromoFraudCaseView[]> {
  const parsed = parse(
    z
      .object({
        filter: z.enum(['pending', 'all']).default('pending'),
        limit: z.number().int().min(1).max(200).default(50)
      })
      .strict(),
    query
  )
  const now = clock(context.now)
  await authorizeAdmin(database, claims, now)
  const { results } = await database
    .prepare(`${CASE_SELECT} WHERE (?1='all' OR c.status IN('open','appealed')) ORDER BY c.created_at,c.rowid LIMIT ?2`)
    .bind(parsed.filter, parsed.limit)
    .all<CaseRow>()
  await authorizeAdmin(database, claims, now)
  return results.map(toView)
}

export async function readPromoFraudCase(
  database: D1Database,
  claims: VerifiedSessionClaims,
  id: string,
  context: { now?: string } = {}
) {
  parse(uuid, id)
  const now = clock(context.now)
  await authorizeAdmin(database, claims, now)
  const [cases, events, appeals] = await database.batch([
    database.prepare(`${CASE_SELECT} WHERE c.id=?1`).bind(id),
    database
      .prepare(
        `SELECT action, actor_identity_id AS actorIdentityId, detail, created_at AS createdAt FROM promo_fraud_events WHERE case_id=?1 ORDER BY created_at, rowid`
      )
      .bind(id),
    database
      .prepare(
        `SELECT id, status, statement, created_at AS createdAt, resolved_by AS resolvedBy, resolved_at AS resolvedAt, resolution_note AS resolutionNote FROM promo_fraud_appeals WHERE case_id=?1`
      )
      .bind(id)
  ])
  await authorizeAdmin(database, claims, now)
  const row = (cases!.results as CaseRow[])[0]
  if (!row) return fail('not_found')
  return {
    case: toView(row),
    events: (
      events!.results as Array<{ action: string; actorIdentityId: string | null; detail: string; createdAt: string }>
    ).map((event) => ({ ...event, detail: JSON.parse(event.detail) as unknown })),
    appeal: ((appeals!.results as Array<Record<string, unknown>>)[0] ?? null) as {
      id: string
      status: string
      statement: string
      createdAt: string
    } | null
  }
}

const selfIdentitySql = (actor: string, caseAlias: string) =>
  `EXISTS(SELECT 1 FROM identities me WHERE me.id=${actor} AND me.customer_id IS NOT NULL AND me.customer_id=${caseAlias}.customer_id)`

export async function decidePromoFraudCase(
  database: D1Database,
  claims: VerifiedSessionClaims,
  id: string,
  rawInput: unknown,
  context: { now?: string } = {}
): Promise<PromoFraudCaseView> {
  parse(uuid, id)
  const input = parse(caseDecisionInputSchema, rawInput)
  const now = clock(context.now)
  const actor = await authorizeAdmin(database, claims, now)
  const target: PromoFraudStatus = input.outcome === 'release' ? 'released' : 'upheld'
  const row = await readCase(database, id)
  if (!row) return fail('not_found')
  if (
    row.version === input.expectedVersion + 1 &&
    row.status === target &&
    row.decided_by === actor &&
    row.decision_note === input.note
  )
    return toView(row) // exact repeat of an applied decision
  if (row.status !== 'open') return fail('invalid_transition')
  if (row.version !== input.expectedVersion) return fail('version_conflict')
  const self = await database
    .prepare(`SELECT ${selfIdentitySql('?1', 'c')} AS own FROM promo_fraud_cases c WHERE c.id=?2`)
    .bind(actor, id)
    .first<{ own: number }>()
  if (self?.own) return fail('self_review')
  await database.batch([
    database
      .prepare(
        `UPDATE promo_fraud_cases SET status=?3, version=version+1, decided_by=?4, decided_at=?5, decision_note=?6, updated_at=?5
         WHERE id=?1 AND version=?2 AND status='open' AND ${adminExistsSql('?4', '?5')} AND NOT ${selfIdentitySql('?4', 'promo_fraud_cases')}`
      )
      .bind(id, input.expectedVersion, target, actor, now, input.note),
    database
      .prepare(
        `INSERT INTO promo_fraud_events(id,case_id,action,actor_identity_id,detail,created_at)
         SELECT ?1,?2,?3,?4,?5,?6 WHERE EXISTS(SELECT 1 FROM promo_fraud_cases WHERE id=?2 AND version=?7 AND status=?3 AND decided_by=?4)
           AND NOT EXISTS(SELECT 1 FROM promo_fraud_events WHERE case_id=?2 AND action=?3)`
      )
      .bind(
        crypto.randomUUID(),
        id,
        target,
        actor,
        JSON.stringify({ note: input.note }),
        now,
        input.expectedVersion + 1
      )
  ])
  const after = (await readCase(database, id))!
  if (after.version === input.expectedVersion + 1 && after.status === target && after.decided_by === actor)
    return toView(after)
  await authorizeAdmin(database, claims, now)
  if (after.status !== 'open') return fail('invalid_transition')
  return fail('version_conflict')
}

/** ---- customer appeal ---- */
export async function listCustomerPromoFraudCases(
  database: D1Database,
  claims: VerifiedSessionClaims,
  context: { now?: string } = {}
) {
  const now = clock(context.now)
  const customerId = await activeOrderCustomerId(database, claims, now)
  if (!customerId) return fail('unauthenticated')
  const { results } = await database
    .prepare(`${CASE_SELECT} WHERE c.customer_id=?1 AND c.decision<>'clear' ORDER BY c.created_at DESC,c.id LIMIT 50`)
    .bind(customerId)
    .all<CaseRow>()
  if ((await activeOrderCustomerId(database, claims, now)) !== customerId) return fail('unauthenticated')
  return results.map((row) => ({
    id: row.id,
    context: row.context,
    refId: row.ref_id,
    status: row.status,
    version: row.version,
    benefitBlocked: isPromoBenefitBlocked(row.decision, row.status),
    canAppeal: row.status === 'upheld' || (row.status === 'open' && row.decision === 'hold'),
    appealStatus: row.appeal_status,
    createdAt: row.created_at,
    decidedAt: row.decided_at
  }))
}

export async function submitPromoFraudAppeal(
  database: D1Database,
  claims: VerifiedSessionClaims,
  id: string,
  rawInput: unknown,
  context: { now?: string } = {}
): Promise<PromoFraudCaseView> {
  parse(uuid, id)
  const input = parse(appealInputSchema, rawInput)
  const now = clock(context.now)
  const customerId = await activeOrderCustomerId(database, claims, now)
  if (!customerId) return fail('unauthenticated')
  // A customer can only ever see and appeal its own case; anything else is simply not found.
  const row = await database
    .prepare(`${CASE_SELECT} WHERE c.id=?1 AND c.customer_id=?2`)
    .bind(id, customerId)
    .first<CaseRow>()
  if (!row) return fail('not_found')
  if (!(row.status === 'upheld' || (row.status === 'open' && row.decision === 'hold')))
    return fail('appeal_not_allowed')
  if (row.version !== input.caseVersion) return fail('version_conflict')
  const appealId = crypto.randomUUID()
  try {
    await database.batch([
      database
        .prepare(
          `INSERT INTO promo_fraud_appeals(id,case_id,customer_id,statement,status,created_at)
           SELECT ?1,?2,?3,?4,'pending',?5 WHERE EXISTS(SELECT 1 FROM promo_fraud_cases c WHERE c.id=?2 AND c.customer_id=?3 AND c.version=?6
             AND (c.status='upheld' OR (c.status='open' AND c.decision='hold')))
             AND EXISTS(SELECT 1 FROM auth_sessions s JOIN identities i ON i.id=s.identity_id
               JOIN customers cu ON cu.id=i.customer_id AND cu.status='active'
               WHERE s.id=?7 AND s.identity_id=?8 AND s.session_version=?9 AND i.session_version=s.session_version
                 AND i.status='active' AND i.email_verified_at IS NOT NULL AND s.revoked_at IS NULL
                 AND s.created_at<=?5 AND s.expires_at>?5 AND cu.id=?3)`
        )
        .bind(
          appealId,
          id,
          customerId,
          input.statement,
          now,
          input.caseVersion,
          claims.sessionId,
          claims.identityId,
          claims.sessionVersion
        ),
      database
        .prepare(
          `UPDATE promo_fraud_cases SET status='appealed', version=version+1, updated_at=?3
           WHERE id=?1 AND version=?2 AND (status='upheld' OR (status='open' AND decision='hold'))
             AND EXISTS(SELECT 1 FROM promo_fraud_appeals WHERE id=?4 AND case_id=?1)`
        )
        .bind(id, input.caseVersion, now, appealId),
      database
        .prepare(
          `INSERT INTO promo_fraud_events(id,case_id,action,actor_identity_id,detail,created_at)
           SELECT ?1,?2,'appeal_submitted',?3,'{}',?4 WHERE EXISTS(SELECT 1 FROM promo_fraud_cases WHERE id=?2 AND status='appealed' AND version=?5)
             AND EXISTS(SELECT 1 FROM promo_fraud_appeals WHERE id=?6)
             AND NOT EXISTS(SELECT 1 FROM promo_fraud_events WHERE case_id=?2 AND action='appeal_submitted')`
        )
        .bind(crypto.randomUUID(), id, claims.identityId, now, input.caseVersion + 1, appealId)
    ])
  } catch (error) {
    if (isUniqueViolation(error)) return fail('appeal_not_allowed')
    throw error
  }
  const after = (await readCase(database, id))!
  const appeal = await database.prepare('SELECT 1 AS ok FROM promo_fraud_appeals WHERE id=?1').bind(appealId).first()
  if (appeal && after.status === 'appealed') return toView(after)
  if ((await activeOrderCustomerId(database, claims, now)) !== customerId) return fail('unauthenticated')
  return fail(after.version !== input.caseVersion ? 'version_conflict' : 'appeal_not_allowed')
}

export async function resolvePromoFraudAppeal(
  database: D1Database,
  claims: VerifiedSessionClaims,
  id: string,
  rawInput: unknown,
  context: { now?: string } = {}
): Promise<PromoFraudCaseView> {
  parse(uuid, id)
  const input = parse(appealResolutionInputSchema, rawInput)
  const now = clock(context.now)
  const actor = await authorizeAdmin(database, claims, now)
  const row = await readCase(database, id)
  if (!row) return fail('not_found')
  if (row.status !== 'appealed' || row.appeal_status !== 'pending') return fail('invalid_transition')
  if (row.version !== input.expectedVersion) return fail('version_conflict')
  // Four eyes: the reviewer who made the original decision cannot also decide its appeal.
  if (row.decided_by === actor) return fail('same_reviewer')
  const self = await database
    .prepare(`SELECT ${selfIdentitySql('?1', 'c')} AS own FROM promo_fraud_cases c WHERE c.id=?2`)
    .bind(actor, id)
    .first<{ own: number }>()
  if (self?.own) return fail('self_review')
  const appealStatus = input.outcome === 'accept' ? 'accepted' : 'rejected'
  const caseStatus: PromoFraudStatus = input.outcome === 'accept' ? 'appeal_accepted' : 'appeal_rejected'
  const action = input.outcome === 'accept' ? 'appeal_accepted' : 'appeal_rejected'
  await database.batch([
    database
      .prepare(
        `UPDATE promo_fraud_appeals SET status=?2, resolved_by=?3, resolved_at=?4, resolution_note=?5
         WHERE case_id=?1 AND status='pending' AND ${adminExistsSql('?3', '?4')}
           AND EXISTS(SELECT 1 FROM promo_fraud_cases c WHERE c.id=?1 AND c.status='appealed' AND c.version=?6
             AND (c.decided_by IS NULL OR c.decided_by<>?3) AND NOT ${selfIdentitySql('?3', 'c')})`
      )
      .bind(id, appealStatus, actor, now, input.note, input.expectedVersion),
    database
      .prepare(
        `UPDATE promo_fraud_cases SET status=?3, version=version+1, updated_at=?4
         WHERE id=?1 AND version=?2 AND status='appealed'
           AND EXISTS(SELECT 1 FROM promo_fraud_appeals WHERE case_id=?1 AND status=?5 AND resolved_by=?6)`
      )
      .bind(id, input.expectedVersion, caseStatus, now, appealStatus, actor),
    database
      .prepare(
        `INSERT INTO promo_fraud_events(id,case_id,action,actor_identity_id,detail,created_at)
         SELECT ?1,?2,?3,?4,?5,?6 WHERE EXISTS(SELECT 1 FROM promo_fraud_cases WHERE id=?2 AND status=?7 AND version=?8)
           AND NOT EXISTS(SELECT 1 FROM promo_fraud_events WHERE case_id=?2 AND action=?3)`
      )
      .bind(
        crypto.randomUUID(),
        id,
        action,
        actor,
        JSON.stringify({ note: input.note }),
        now,
        caseStatus,
        input.expectedVersion + 1
      )
  ])
  const after = (await readCase(database, id))!
  if (after.status === caseStatus && after.version === input.expectedVersion + 1) return toView(after)
  await authorizeAdmin(database, claims, now)
  return fail(after.status !== 'appealed' ? 'invalid_transition' : 'version_conflict')
}

/** Retention of pseudonymised signals. Cases and the audit trail are kept; signals of unresolved cases too. */
export async function purgePromoFraudSignals(database: D1Database, context: { now?: string }) {
  const now = clock(context.now)
  const cutoff = plusDays(now, -PROMO_FRAUD_SIGNAL_RETENTION_DAYS)
  const { results } = await database
    .prepare(
      `DELETE FROM promo_fraud_signals WHERE created_at<?1
         AND case_id NOT IN(SELECT id FROM promo_fraud_cases WHERE status IN('open','appealed')) RETURNING id`
    )
    .bind(cutoff)
    .all<{ id: string }>()
  return { deleted: results.length }
}
