import {
  supportMacroCommandSchema,
  supportMacroContentSchema,
  supportMacroSnapshotSchema,
  supportMacroSelectionSchema,
  supportMacroReceiptSchema,
  supportMacroLibrarySchema,
  supportMacroPreviewSchema
} from '../../shared/support-macros'
import { supportUuid, supportKey, supportInstant } from '../../shared/support-operations'
import { z } from 'zod'
import type { VerifiedSessionClaims } from '../catalog/authorization'
import { canonicalJson, sha256Hex } from '../catalog/inventory'
import { guardedFiscalDatabase } from '../fiscal/d1-boundary'
import {
  SupportError,
  supportChecked,
  supportClock,
  supportActor,
  authorizeSupportActor,
  authorizeSupportTicket,
  actorSql,
  actorBinds,
  type SupportCommandOptions
} from './operations'

type Row = {
  id: string
  macro_id: string
  actor_id: string
  action: string
  version: number
  state: 'draft' | 'approved' | 'withdrawn'
  snapshot: string
  input: string
  response: string
  payload_hash: string
  created_at: string
}
async function latest(database: D1Database, id: string) {
  return database
    .prepare('SELECT * FROM support_macro_commands WHERE macro_id=? ORDER BY version DESC LIMIT 1')
    .bind(id)
    .first<Row>()
}
function snapshot(row: Row) {
  try {
    return supportMacroSnapshotSchema.parse(JSON.parse(row.snapshot))
  } catch {
    throw new SupportError('history_unconfirmed')
  }
}
function receipt(row: Row) {
  try {
    const result = supportMacroReceiptSchema.parse(JSON.parse(row.response))
    if (
      result.commandId !== row.id ||
      result.macroId !== row.macro_id ||
      result.version !== row.version ||
      result.state !== row.state
    )
      throw new Error()
    return result
  } catch {
    throw new SupportError('history_unconfirmed')
  }
}
function storedInput(row: Row) {
  try {
    return supportMacroCommandSchema.parse(JSON.parse(row.input))
  } catch {
    throw new SupportError('history_unconfirmed')
  }
}
export async function executeSupportMacroCommand(
  rawDatabase: D1Database,
  claims: VerifiedSessionClaims | null,
  id: string,
  raw: unknown,
  options: SupportCommandOptions
) {
  const database = guardedFiscalDatabase(rawDatabase),
    now = supportClock(options.now),
    actor = await supportActor(database, claims, 'admin', now),
    macroId = supportChecked(supportUuid, id),
    input = supportChecked(supportMacroCommandSchema, raw),
    key = supportChecked(supportKey, options.idempotencyKey),
    hash = await sha256Hex(canonicalJson({ macroId, input }))
  async function replay() {
    const row = await database
      .prepare('SELECT * FROM support_macro_commands WHERE actor_id=? AND idempotency_key=?')
      .bind(claims!.identityId, key)
      .first<Row>()
    if (!row) return null
    if (row.payload_hash !== hash || row.macro_id !== macroId) throw new SupportError('idempotency_conflict')
    snapshot(row)
    await authorizeSupportActor(database, actor, now)
    return receipt(row)
  }
  const existing = await replay()
  if (existing) return existing
  const previous = await latest(database, macroId)
  if ((previous?.version ?? 0) !== input.expectedVersion) throw new SupportError('version_conflict')
  const instant = now()
  let data: ReturnType<typeof supportMacroSnapshotSchema.parse>
  if (input.action === 'draft')
    data = {
      content: supportChecked(supportMacroContentSchema, {
        title: input.title,
        body: input.body,
        tone: input.tone,
        personalizations: input.personalizations
      }),
      review: null
    }
  else {
    if (!previous || previous.state !== (input.action === 'approve' ? 'draft' : 'approved'))
      throw new SupportError('invalid_transition')
    data = snapshot(previous)
    if (input.action === 'approve') {
      if (input.reviewedAt > instant || input.expiresAt <= instant || input.expiresAt <= input.reviewedAt)
        throw new SupportError('invalid_input')
      data.review = {
        operationalReference: input.operationalReference,
        legalReference: input.legalReference,
        reviewedAt: input.reviewedAt,
        expiresAt: input.expiresAt
      }
    }
  }
  const commandId = crypto.randomUUID(),
    state = input.action === 'approve' ? 'approved' : input.action === 'withdraw' ? 'withdrawn' : 'draft'
  const result = supportMacroReceiptSchema.parse({
    source: 'cloudflare',
    commandId,
    macroId,
    version: input.expectedVersion + 1,
    state,
    updated: true
  })
  await authorizeSupportActor(database, actor, now)
  const guard = crypto.randomUUID()
  try {
    await database.batch([
      database
        .prepare(
          'WITH actor AS MATERIALIZED (' +
            actorSql +
            ') INSERT INTO support_macro_commands(id,macro_id,actor_id,idempotency_key,payload_hash,action,expected_version,version,state,input,snapshot,response,created_at) SELECT ?7,?8,?3,?9,?10,?11,?12,?12+1,?13,?14,?15,?16,?17 WHERE EXISTS(SELECT 1 FROM actor)'
        )
        .bind(
          ...actorBinds(actor, options),
          commandId,
          macroId,
          key,
          hash,
          input.action,
          input.expectedVersion,
          state,
          canonicalJson(input),
          canonicalJson(data),
          canonicalJson(result),
          instant
        ),
      database
        .prepare(
          'INSERT INTO support_guards(id,satisfied) SELECT ?1,EXISTS(SELECT 1 FROM support_macro_commands WHERE id=?2)'
        )
        .bind(guard, commandId),
      database.prepare('DELETE FROM support_guards WHERE id=?').bind(guard)
    ])
  } catch {
    await authorizeSupportActor(database, actor, now)
    const retried = await replay()
    if (retried) return retried
    if (((await latest(database, macroId))?.version ?? 0) !== input.expectedVersion)
      throw new SupportError('version_conflict')
    throw new SupportError('write_unconfirmed')
  }
  await authorizeSupportActor(database, actor, now)
  const committed = await replay()
  if (!committed || committed.commandId !== commandId) throw new SupportError('write_unconfirmed')
  return committed
}

/** Bounded keyset library (one latest snapshot each), plus explicit detail history windows. */
export async function listSupportMacros(
  rawDatabase: D1Database,
  claims: VerifiedSessionClaims | null,
  options: { now?: string; macroId?: string; afterMacroId?: string; beforeVersion?: number } = {}
) {
  const page = supportChecked(
    z
      .object({
        now: supportInstant.optional(),
        macroId: supportUuid.optional(),
        afterMacroId: supportUuid.optional(),
        beforeVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional()
      })
      .strict()
      .refine((v) => !(v.macroId && v.afterMacroId) && (v.beforeVersion === undefined || v.macroId !== undefined)),
    options
  )
  const database = guardedFiscalDatabase(rawDatabase),
    now = supportClock(options.now),
    actor = await supportActor(database, claims, 'admin', now)
  const current = (
    await database
      .prepare(
        'SELECT * FROM support_macro_commands c WHERE version=(SELECT MAX(version) FROM support_macro_commands WHERE macro_id=c.macro_id) AND (?1 IS NULL OR macro_id=?1) AND (?2 IS NULL OR macro_id>?2) ORDER BY macro_id LIMIT 51'
      )
      .bind(page.macroId ?? null, page.afterMacroId ?? null)
      .all<Row>()
  ).results
  await authorizeSupportActor(database, actor, now)
  const histories =
    page.macroId && current.length
      ? (
          await database
            .prepare(
              'SELECT * FROM support_macro_commands WHERE macro_id=?1 AND (?2 IS NULL OR version<?2) ORDER BY version DESC LIMIT 20'
            )
            .bind(page.macroId, page.beforeVersion ?? null)
            .all<Row>()
        ).results
      : current.slice(0, 50)
  const macros = current.slice(0, 50).map((row) => {
    const data = snapshot(row)
    receipt(row)
    const history = histories
      .filter((r) => r.macro_id === row.macro_id)
      .map((r) => ({
        commandId: r.id,
        version: r.version,
        state: r.state,
        actorId: r.actor_id,
        reason: storedInput(r).reason,
        createdAt: r.created_at,
        snapshot: snapshot(r)
      }))
    const firstVersion = page.beforeVersion === undefined ? row.version : Math.min(row.version, page.beforeVersion - 1)
    if (
      history.length !== Math.min(page.macroId ? 20 : 1, firstVersion) ||
      history.some((r, i) => r.version !== firstVersion - i)
    )
      throw new SupportError('history_unconfirmed')
    return {
      macroId: row.macro_id,
      version: row.version,
      revisionId: row.id,
      state: row.state === 'approved' && data.review && data.review.expiresAt <= now() ? 'expired' : row.state,
      snapshot: data,
      history,
      historyTruncated: row.version > history.length,
      historyNextBefore: history.length && history.at(-1)!.version > 1 ? history.at(-1)!.version : null
    }
  })
  await authorizeSupportActor(database, actor, now)
  return supportMacroLibrarySchema.parse({
    source: 'cloudflare',
    macros,
    truncated: current.length > 50,
    nextMacroId: current.length > 50 ? current[49]!.macro_id : null
  })
}
export async function previewSupportMacro(
  rawDatabase: D1Database,
  claims: VerifiedSessionClaims | null,
  ref: string,
  raw: unknown,
  options: { now?: string } = {}
) {
  const database = guardedFiscalDatabase(rawDatabase),
    now = supportClock(options.now),
    actor = await supportActor(database, claims, 'admin', now),
    selection = supportChecked(supportMacroSelectionSchema, raw)
  const ticket = await authorizeSupportTicket(database, actor, ref, now)
  if (ticket.retention_until && ticket.retention_until <= now()) throw new SupportError('retention_expired')
  if (['resolved', 'closed'].includes(ticket.state)) throw new SupportError('invalid_transition')
  const row = await latest(database, selection.macroId)
  if (!row || row.id !== selection.revisionId || row.state !== 'approved') throw new SupportError('invalid_transition')
  const data = snapshot(row)
  if (!data.review || data.review.expiresAt <= now()) throw new SupportError('invalid_transition')
  const fields = data.content.personalizations,
    values = selection.personalizations
  if (Object.keys(values).some((key) => !fields.some((f) => f.key === key))) throw new SupportError('invalid_input')
  for (const field of fields) {
    const value = values[field.key] ?? ''
    if (
      (field.required && value.trim().length < 3) ||
      value !== value.trim() ||
      /[{}]/.test(value) ||
      [...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
    )
      throw new SupportError('invalid_input')
  }
  const variables: Record<string, string> = {
    'ticket.reference': ticket.public_ref,
    'ticket.category': ticket.category,
    'ticket.state': ticket.state
  }
  const message = data.content.body.replace(/\{\{([^{}]+)\}\}/g, (_, token: string) =>
    token.startsWith('personal.') ? (values[token.slice(9)] ?? '') : variables[token]!
  )
  if (message.length > 5000 || !message.trim()) throw new SupportError('invalid_input')
  await authorizeSupportActor(database, actor, now)
  const current = await latest(database, selection.macroId)
  if (current?.id !== row.id || data.review.expiresAt <= now()) throw new SupportError('invalid_transition')
  const freshTicket = await authorizeSupportTicket(database, actor, ref, now)
  if (freshTicket.version !== ticket.version) throw new SupportError('version_conflict')
  return supportMacroPreviewSchema.parse({
    source: 'cloudflare',
    publicRef: ref,
    ticketVersion: ticket.version,
    message,
    selection,
    review: data.review
  })
}
