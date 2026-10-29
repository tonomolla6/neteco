import { z } from 'zod'
import type { VerifiedSessionClaims } from '../catalog/authorization'
import { guardedFiscalDatabase } from '../fiscal/d1-boundary'
import {
  supportEscalationInputSchema,
  supportRunbookInputSchema,
  supportRunbookSchema,
  supportEscalationStateSchema,
  supportEscalationReceiptSchema,
  supportEscalationSnapshotSchema,
  supportEscalationQuerySchema,
  supportEscalationListSchema,
  supportEscalationCommandSchema,
  supportEscalationIntentHash
} from '../../shared/support-escalations'
import { supportRef, supportUuid } from '../../shared/support-operations'
import {
  SupportError,
  supportChecked,
  supportClock,
  supportActor,
  authorizeSupportTicket,
  actorSql,
  actorBinds,
  type SupportActor,
  type SupportCommandOptions
} from './operations'

type Row = {
  id: string
  target_kind: 'runbook' | 'escalation'
  target_id: string
  ticket_id: string | null
  actor_id: string
  payload_hash: string
  action: string
  expected_version: number
  version: number
  input: string
  snapshot: string
  response: string
  created_at: string
}
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/)
const staffSql = `SELECT DISTINCT i.id,COALESCE(c.name,'Operador autorizado') AS label FROM identities i
 LEFT JOIN customers c ON c.id=i.customer_id WHERE i.status='active'
 AND i.email_verified_at IS NOT NULL AND i.email_verified_at<=?1 AND EXISTS(
 SELECT 1 FROM identity_roles ir JOIN role_permissions rp ON rp.role_code=ir.role_code
 WHERE ir.identity_id=i.id AND rp.permission_code='support.manage'
 AND ir.granted_at<=?1 AND (ir.expires_at IS NULL OR ir.expires_at>?1))`
async function latest(db: D1Database, kind: Row['target_kind'], id: string) {
  return db
    .prepare(
      'SELECT * FROM support_escalation_commands WHERE target_kind=? AND target_id=? ORDER BY version DESC LIMIT 1'
    )
    .bind(kind, id)
    .first<Row>()
}
function proof(row: Row) {
  try {
    const receipt = supportEscalationReceiptSchema.parse(JSON.parse(row.response))
    if (
      receipt.commandId !== row.id ||
      receipt.targetId !== row.target_id ||
      receipt.action !== row.action ||
      receipt.payloadHash !== row.payload_hash ||
      receipt.version !== row.version ||
      receipt.expectedVersion !== row.expected_version ||
      receipt.recordedAt !== row.created_at
    )
      throw new Error()
    const input = (row.target_kind === 'runbook' ? supportRunbookInputSchema : supportEscalationInputSchema).parse(
      JSON.parse(row.input)
    )
    if (input.action !== row.action || input.expectedVersion !== row.expected_version) throw new Error()
    const snapshot =
      row.target_kind === 'runbook'
        ? supportRunbookSchema.parse(JSON.parse(row.snapshot))
        : supportEscalationStateSchema.parse(JSON.parse(row.snapshot))
    if (snapshot.version !== row.version || snapshot.updatedAt !== row.created_at) throw new Error()
    if ('id' in snapshot ? snapshot.id !== row.target_id : snapshot.publicRef !== row.target_id) throw new Error()
    if ('publicRef' in snapshot && 'expectedTicketVersion' in input) {
      if (snapshot.ticketVersion !== input.expectedTicketVersion) throw new Error()
      if (input.action === 'resolve') {
        if (snapshot.state !== 'resolved' || snapshot.resolution !== input.resolution) throw new Error()
      } else if (
        snapshot.state !== 'open' ||
        snapshot.queue !== input.queue ||
        snapshot.ownerId !== input.ownerId ||
        snapshot.severity !== input.severity ||
        snapshot.nextAction !== input.nextAction ||
        snapshot.nextActionAt !== input.nextActionAt ||
        snapshot.runbook.id !== input.runbook.id ||
        snapshot.runbook.version !== input.runbook.version ||
        snapshot.resolution !== null
      )
        throw new Error()
    } else if ('id' in snapshot) {
      if (
        input.action === 'draft' &&
        (snapshot.state !== 'draft' ||
          snapshot.queue !== input.queue ||
          snapshot.title !== input.title ||
          snapshot.body !== input.body ||
          snapshot.operationalReference !== null ||
          snapshot.reviewedAt !== null ||
          snapshot.expiresAt !== null)
      )
        throw new Error()
      if (
        input.action === 'approve' &&
        (snapshot.state !== 'approved' ||
          snapshot.operationalReference !== input.operationalReference ||
          snapshot.reviewedAt !== input.reviewedAt ||
          snapshot.expiresAt !== input.expiresAt)
      )
        throw new Error()
      if (input.action === 'withdraw' && snapshot.state !== 'withdrawn') throw new Error()
    }
    return receipt
  } catch {
    throw new SupportError('history_unconfirmed')
  }
}
function data(row: Row): unknown {
  proof(row)
  return JSON.parse(row.snapshot)
}
async function proofHash(row: Row) {
  proof(row)
  if ((await supportEscalationIntentHash(row.target_id, JSON.parse(row.input))) !== row.payload_hash)
    throw new SupportError('history_unconfirmed')
}
async function release(db: D1Database, actor: SupportActor, options: { now?: string }, refs?: string | string[]) {
  const requested = typeof refs === 'string' ? [refs] : (refs ?? [])
  const row = await db
    .prepare(
      'WITH actor AS MATERIALIZED (' +
        actorSql +
        ") SELECT EXISTS(SELECT 1 FROM actor) AS authorized, NOT EXISTS(SELECT 1 FROM json_each(?7) requested LEFT JOIN support_tickets t ON t.public_ref=requested.value WHERE t.id IS NULL OR t.retention_until IS NULL OR t.retention_until<=COALESCE(?1,strftime('%Y-%m-%dT%H:%M:%SZ','now'))) AS retained"
    )
    .bind(...actorBinds(actor, options), JSON.stringify(requested))
    .first<{ authorized: number; retained: number }>()
  if (!row?.authorized) throw new SupportError('unauthenticated')
  if (!row.retained) throw new SupportError('retention_expired')
}
async function replay(
  db: D1Database,
  actor: SupportActor,
  target: string,
  key: string,
  hash: string,
  options: { now?: string }
) {
  const row = await db
    .prepare('SELECT * FROM support_escalation_commands WHERE id=? AND actor_id=?')
    .bind(key, actor.claims!.identityId)
    .first<Row>()
  if (!row) return null
  if (row.target_id !== target || row.payload_hash !== hash) throw new SupportError('idempotency_conflict')
  await proofHash(row)
  const receipt = proof(row)
  await release(db, actor, options, row.target_kind === 'escalation' ? target : undefined)
  return receipt
}
async function persist(
  db: D1Database,
  actor: SupportActor,
  target: string,
  kind: Row['target_kind'],
  ticketId: string | null,
  input: { action: string; expectedVersion: number },
  snapshot: unknown,
  key: string,
  hash: string,
  instant: string,
  options: { now?: string }
) {
  const receipt = supportEscalationReceiptSchema.parse({
      source: 'cloudflare',
      commandId: key,
      targetId: target,
      action: input.action,
      expectedVersion: input.expectedVersion,
      version: input.expectedVersion + 1,
      payloadHash: hash,
      recordedAt: instant,
      inventoryEffect: 'none',
      economicEffect: 'none',
      communicationEffect: 'none'
    }),
    guard = crypto.randomUUID()
  const liveClock = "COALESCE(?1,strftime('%Y-%m-%dT%H:%M:%SZ','now'))"
  try {
    await db.batch([
      db
        .prepare(
          'WITH actor AS MATERIALIZED (' +
            actorSql +
            ') INSERT INTO support_escalation_commands(id,target_kind,target_id,ticket_id,actor_id,payload_hash,action,expected_version,version,input,snapshot,response,created_at) SELECT ?7,?8,?9,?10,?3,?11,?12,?13,?13+1,?14,?15,?16,?17 WHERE EXISTS(SELECT 1 FROM actor) AND (?18 IS NULL OR EXISTS(SELECT 1 FROM (' +
            staffSql.replaceAll('?1', liveClock) +
            ') WHERE id=?18))' +
            ` AND (?8<>'escalation' OR EXISTS(SELECT 1 FROM support_tickets WHERE id=?10 AND version=json_extract(?14,'$.expectedTicketVersion') AND retention_until>${liveClock} AND state NOT IN ('resolved','closed')))` +
            ` AND (?8<>'escalation' OR ?12='resolve' OR EXISTS(SELECT 1 FROM support_escalation_commands r WHERE r.target_kind='runbook' AND r.target_id=json_extract(?14,'$.runbook.id') AND r.version=json_extract(?14,'$.runbook.version') AND r.version=(SELECT MAX(version) FROM support_escalation_commands WHERE target_kind='runbook' AND target_id=r.target_id) AND json_extract(r.snapshot,'$.state')='approved' AND json_extract(r.snapshot,'$.queue')=json_extract(?14,'$.queue') AND json_extract(r.snapshot,'$.expiresAt')>${liveClock}))` +
            ` AND (?12<>'approve' OR (json_extract(?14,'$.reviewedAt')<=${liveClock} AND json_extract(?14,'$.expiresAt')>${liveClock}))`
        )
        .bind(
          ...actorBinds(actor, options),
          key,
          kind,
          target,
          ticketId,
          hash,
          input.action,
          input.expectedVersion,
          JSON.stringify(input),
          JSON.stringify(snapshot),
          JSON.stringify(receipt),
          instant,
          'ownerId' in input ? input.ownerId : null
        ),
      db
        .prepare(
          'INSERT INTO support_guards(id,satisfied) SELECT ?,EXISTS(SELECT 1 FROM support_escalation_commands WHERE id=? AND actor_id=? AND target_kind=? AND target_id=? AND payload_hash=? AND response=?)'
        )
        .bind(guard, key, actor.claims!.identityId, kind, target, hash, JSON.stringify(receipt)),
      db.prepare('DELETE FROM support_guards WHERE id=?').bind(guard)
    ])
  } catch {
    const raced = await replay(db, actor, target, key, hash, options)
    if (raced) return raced
    await release(db, actor, options, kind === 'escalation' ? target : undefined)
    const current = await latest(db, kind, target)
    if ((current?.version ?? 0) !== input.expectedVersion) throw new SupportError('version_conflict')
    throw new SupportError('write_unconfirmed')
  }
  const committed = await replay(db, actor, target, key, hash, options)
  if (!committed) throw new SupportError('write_unconfirmed')
  return committed
}
export async function executeSupportRunbookCommand(
  rawDb: D1Database,
  claims: VerifiedSessionClaims | null,
  rawId: string,
  raw: unknown,
  options: SupportCommandOptions
) {
  const db = guardedFiscalDatabase(rawDb),
    now = supportClock(options.now),
    actor = await supportActor(db, claims, 'admin', now),
    id = supportChecked(supportUuid, rawId),
    input = supportChecked(supportRunbookInputSchema, raw),
    key = supportChecked(supportUuid, options.idempotencyKey),
    hash = await supportEscalationIntentHash(id, input)
  const old = await replay(db, actor, id, key, hash, options)
  if (old) return old
  const previous = await latest(db, 'runbook', id)
  if (previous) await proofHash(previous)
  if ((previous?.version ?? 0) !== input.expectedVersion) throw new SupportError('version_conflict')
  const instant = now(),
    before = previous ? supportRunbookSchema.parse(data(previous)) : null
  if (input.action !== 'draft' && before?.state !== (input.action === 'approve' ? 'draft' : 'approved'))
    throw new SupportError('invalid_transition')
  if (
    input.action === 'approve' &&
    (input.reviewedAt > instant || input.expiresAt <= instant || input.expiresAt <= input.reviewedAt)
  )
    throw new SupportError('invalid_input')
  const snapshot = supportRunbookSchema.parse(
    input.action === 'draft'
      ? {
          source: 'cloudflare',
          id,
          version: input.expectedVersion + 1,
          queue: input.queue,
          state: 'draft',
          title: input.title,
          body: input.body,
          operationalReference: null,
          reviewedAt: null,
          expiresAt: null,
          updatedAt: instant
        }
      : {
          ...before,
          version: input.expectedVersion + 1,
          state: input.action === 'approve' ? 'approved' : 'withdrawn',
          ...(input.action === 'approve'
            ? {
                operationalReference: input.operationalReference,
                reviewedAt: input.reviewedAt,
                expiresAt: input.expiresAt
              }
            : {}),
          updatedAt: instant
        }
  )
  return persist(db, actor, id, 'runbook', null, input, snapshot, key, hash, instant, options)
}
export async function executeSupportEscalationCommand(
  rawDb: D1Database,
  claims: VerifiedSessionClaims | null,
  rawRef: string,
  raw: unknown,
  options: SupportCommandOptions
) {
  const db = guardedFiscalDatabase(rawDb),
    now = supportClock(options.now),
    actor = await supportActor(db, claims, 'admin', now),
    ref = supportChecked(supportRef, rawRef),
    input = supportChecked(supportEscalationInputSchema, raw),
    key = supportChecked(supportUuid, options.idempotencyKey),
    hash = await supportEscalationIntentHash(ref, input)
  const old = await replay(db, actor, ref, key, hash, options)
  if (old) return old
  const ticket = await authorizeSupportTicket(db, actor, ref, now),
    previous = await latest(db, 'escalation', ref)
  if (previous) await proofHash(previous)
  if ((previous?.version ?? 0) !== input.expectedVersion) throw new SupportError('version_conflict')
  if (ticket.version !== input.expectedTicketVersion) throw new SupportError('ticket_version_conflict')
  if (!ticket.retention_until || ticket.retention_until <= now()) throw new SupportError('retention_expired')
  if (['resolved', 'closed'].includes(ticket.state)) throw new SupportError('invalid_transition')
  const before = previous ? supportEscalationStateSchema.parse(data(previous)) : null,
    instant = now()
  if (before?.state === 'resolved' || (!before && input.action !== 'handoff'))
    throw new SupportError('invalid_transition')
  if (input.action !== 'resolve') {
    const owner = await db
      .prepare('SELECT id FROM (' + staffSql + ') WHERE id=?2')
      .bind(instant, input.ownerId)
      .first()
    if (!owner) throw new SupportError('owner_unavailable')
    const row = await latest(db, 'runbook', input.runbook.id),
      runbook = row ? supportRunbookSchema.parse(data(row)) : null
    if (row) await proofHash(row)
    if (
      !runbook ||
      runbook.version !== input.runbook.version ||
      runbook.state !== 'approved' ||
      runbook.queue !== input.queue ||
      !runbook.expiresAt ||
      runbook.expiresAt <= instant
    )
      throw new SupportError('runbook_unavailable')
  }
  const snapshot = supportEscalationStateSchema.parse(
    input.action === 'resolve'
      ? {
          ...before,
          version: input.expectedVersion + 1,
          ticketVersion: ticket.version,
          state: 'resolved',
          resolution: input.resolution,
          updatedAt: instant
        }
      : {
          publicRef: ref,
          version: input.expectedVersion + 1,
          ticketVersion: ticket.version,
          state: 'open',
          queue: input.queue,
          ownerId: input.ownerId,
          severity: input.severity,
          runbook: input.runbook,
          nextAction: input.nextAction,
          nextActionAt: input.nextActionAt,
          resolution: null,
          createdAt: before?.createdAt ?? instant,
          updatedAt: instant
        }
  )
  return persist(db, actor, ref, 'escalation', ticket.id, input, snapshot, key, hash, instant, options)
}
export async function listSupportRunbooks(
  rawDb: D1Database,
  claims: VerifiedSessionClaims | null,
  options: { now?: string } = {}
) {
  const db = guardedFiscalDatabase(rawDb),
    actor = await supportActor(db, claims, 'admin', supportClock(options.now))
  const rows = (
    await db
      .prepare(
        "SELECT * FROM support_escalation_commands c WHERE target_kind='runbook' AND version=(SELECT MAX(version) FROM support_escalation_commands WHERE target_kind='runbook' AND target_id=c.target_id) ORDER BY target_id LIMIT 101"
      )
      .all<Row>()
  ).results
  if (rows.length > 100) throw new SupportError('read_unavailable')
  await Promise.all(rows.map(proofHash))
  const items = rows.map((row) => supportRunbookSchema.parse(data(row)))
  await release(db, actor, options)
  return { source: 'cloudflare' as const, items }
}
export async function readSupportEscalation(
  rawDb: D1Database,
  claims: VerifiedSessionClaims | null,
  rawRef: string,
  rawQuery: unknown = {},
  options: { now?: string } = {}
) {
  const db = guardedFiscalDatabase(rawDb),
    now = supportClock(options.now),
    actor = await supportActor(db, claims, 'admin', now),
    ref = supportChecked(supportRef, rawRef),
    query = supportChecked(
      z
        .object({
          page: z.coerce.number().int().min(1).max(1000000).default(1),
          perPage: z.coerce.number().int().min(1).max(25).default(25)
        })
        .strict(),
      rawQuery
    ),
    ticket = await authorizeSupportTicket(db, actor, ref, now)
  const current = await latest(db, 'escalation', ref)
  if (current) await proofHash(current)
  const history = (
    await db
      .prepare(
        "SELECT * FROM support_escalation_commands WHERE target_kind='escalation' AND target_id=? ORDER BY version DESC LIMIT ? OFFSET ?"
      )
      .bind(ref, query.perPage, (query.page - 1) * query.perPage)
      .all<Row>()
  ).results
  await Promise.all(history.map(proofHash))
  const firstVersion = (current?.version ?? 0) - (query.page - 1) * query.perPage
  if (
    history.length !== Math.min(query.perPage, Math.max(0, firstVersion)) ||
    history.some((row, index) => row.version !== firstVersion - index)
  )
    throw new SupportError('history_unconfirmed')
  const staff = (
    await db
      .prepare(staffSql + ' ORDER BY i.id LIMIT 101')
      .bind(now())
      .all<{ id: string; label: string }>()
  ).results
  if (staff.length > 100) throw new SupportError('read_unavailable')
  const runbooks = (await listSupportRunbooks(db, claims, options)).items.filter(
    (r) => r.state === 'approved' && r.expiresAt! > now()
  )
  const result = supportEscalationSnapshotSchema.parse({
    source: 'cloudflare',
    publicRef: ref,
    ticketVersion: ticket.version,
    escalation: current ? data(current) : null,
    history: history.map((row) => ({
      receipt: proof(row),
      actorId: row.actor_id,
      reason: supportEscalationInputSchema.parse(JSON.parse(row.input)).reason,
      snapshot: data(row)
    })),
    page: query.page,
    perPage: query.perPage,
    total: current?.version ?? 0,
    staff,
    runbooks
  })
  await release(db, actor, options, ref)
  return result
}
export async function listSupportEscalations(
  rawDb: D1Database,
  claims: VerifiedSessionClaims | null,
  rawQuery: unknown = {},
  options: { now?: string } = {}
) {
  const db = guardedFiscalDatabase(rawDb),
    actor = await supportActor(db, claims, 'admin', supportClock(options.now)),
    query = supportChecked(supportEscalationQuerySchema, rawQuery),
    owner = query.owner === 'me' ? actor.claims!.identityId : query.owner
  const predicate = `target_kind='escalation' AND version=(SELECT MAX(version) FROM support_escalation_commands WHERE target_kind='escalation' AND target_id=c.target_id) AND EXISTS(SELECT 1 FROM support_tickets t WHERE t.id=c.ticket_id AND t.retention_until>COALESCE(?1,strftime('%Y-%m-%dT%H:%M:%SZ','now'))) AND (?2 IS NULL OR json_extract(snapshot,'$.queue')=?2) AND (?3 IS NULL OR json_extract(snapshot,'$.state')=?3) AND (?4 IS NULL OR json_extract(snapshot,'$.severity')=?4) AND (?5 IS NULL OR json_extract(snapshot,'$.ownerId')=?5)`
  const binds = [options.now ?? null, query.queue ?? null, query.state ?? null, query.severity ?? null, owner ?? null]
  const count = await db
    .prepare('SELECT COUNT(*) AS total FROM support_escalation_commands c WHERE ' + predicate)
    .bind(...binds)
    .first<{ total: number }>()
  const rows = (
    await db
      .prepare(
        'SELECT * FROM support_escalation_commands c WHERE ' +
          predicate +
          ' ORDER BY created_at DESC,id DESC LIMIT ?6 OFFSET ?7'
      )
      .bind(...binds, query.perPage, (query.page - 1) * query.perPage)
      .all<Row>()
  ).results
  await Promise.all(rows.map(proofHash))
  const result = supportEscalationListSchema.parse({
    source: 'cloudflare',
    items: rows.map(data),
    page: query.page,
    perPage: query.perPage,
    total: count?.total ?? 0
  })
  await release(
    db,
    actor,
    options,
    rows.map((row) => row.target_id)
  )
  return result
}
export async function readSupportEscalationCommand(
  rawDb: D1Database,
  claims: VerifiedSessionClaims | null,
  rawTarget: string,
  rawKey: string,
  rawHash: string,
  options: { now?: string } = {}
) {
  const db = guardedFiscalDatabase(rawDb),
    now = supportClock(options.now),
    actor = await supportActor(db, claims, 'admin', now),
    target = supportChecked(z.union([supportRef, supportUuid]), rawTarget),
    key = supportChecked(supportUuid, rawKey),
    hash = supportChecked(hashSchema, rawHash)
  if (target.startsWith('SOP-')) await authorizeSupportTicket(db, actor, target, now)
  const receipt = await replay(db, actor, target, key, hash, options)
  if (!receipt) await release(db, actor, options, target.startsWith('SOP-') ? target : undefined)
  return supportEscalationCommandSchema.parse(
    receipt
      ? { source: 'cloudflare', outcome: 'applied', receipt }
      : { source: 'cloudflare', outcome: 'unknown', receipt: null }
  )
}
