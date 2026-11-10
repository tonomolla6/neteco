import { z } from 'zod'
import {
  supportContactInputSchema,
  supportAdminInputSchema,
  supportCustomerReplySchema,
  supportReceiptSchema,
  supportAdminTicketSchema,
  supportCustomerTicketSchema,
  supportAdminListSchema,
  supportCustomerListSchema,
  supportPolicySchema,
  supportUuid,
  supportKey,
  supportRef,
  supportInstant,
  allowedSupportTransition,
  type SupportPolicy,
  type SupportReceipt
} from '../../shared/support-operations'
import { catalogPolicyOwnJson } from '../../shared/catalog-publication-policy'
import { authorizeD1Session, type VerifiedSessionClaims } from '../catalog/authorization'
import { activeOrderCustomerId } from '../catalog/customer-orders'
import { canonicalJson, sha256Hex } from '../catalog/inventory'
import { guardedFiscalDatabase } from '../fiscal/d1-boundary'
import { prepareEmailOutboxEnqueue } from '../communications/email-outbox'
import { readSupportContext } from './context'
import { previewSupportMacro } from './macros'

export class SupportError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'SupportError'
  }
}
export function supportChecked<T, I>(schema: z.ZodType<T, I>, raw: unknown): T {
  let owned: unknown
  try {
    owned = catalogPolicyOwnJson(raw)
  } catch {
    throw new SupportError('invalid_input')
  }
  const parsed = schema.safeParse(owned)
  if (!parsed.success) throw new SupportError('invalid_input')
  return parsed.data
}
export interface SupportActor {
  kind: 'admin' | 'customer' | 'anonymous'
  claims: VerifiedSessionClaims | null
  customerId: string | null
  key: string
}
export interface SupportCommandOptions {
  idempotencyKey: string
  now?: string
  policy?: SupportPolicy | null
}
export interface SupportPage {
  page: number
  perPage: number
  q?: string
  state?: string
  category?: string
  owner?: string
}
export function supportClock(now?: string) {
  if (now !== undefined && !supportInstant.safeParse(now).success) throw new SupportError('invalid_input')
  const started = Date.now()
  return () =>
    new Date(now === undefined ? Date.now() : Date.parse(now) + Math.max(0, Date.now() - started))
      .toISOString()
      .replace(/\.\d{3}Z$/, 'Z')
}
export async function supportActor(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  kind: 'admin' | 'customer',
  now: () => string
): Promise<SupportActor> {
  if (
    !claims ||
    !supportUuid.safeParse(claims.identityId).success ||
    !supportUuid.safeParse(claims.sessionId).success ||
    !Number.isSafeInteger(claims.sessionVersion) ||
    claims.sessionVersion < 1
  )
    throw new SupportError('unauthenticated')
  const customerId = kind === 'customer' ? await activeOrderCustomerId(database, claims, now()) : null
  if (kind === 'customer' && !customerId) throw new SupportError('unauthenticated')
  const actor: SupportActor = { kind, claims, customerId, key: 'identity:' + claims.identityId }
  await authorizeSupportActor(database, actor, now)
  return actor
}
export async function authorizeSupportActor(database: D1Database, actor: SupportActor, now: () => string) {
  if (actor.kind === 'anonymous') {
    if (!/^anonymous:[0-9a-f]{64}$/.test(actor.key) || actor.claims !== null || actor.customerId !== null)
      throw new SupportError('unauthenticated')
    return
  }
  if (!actor.claims || actor.key !== 'identity:' + actor.claims.identityId) throw new SupportError('unauthenticated')
  if (actor.kind === 'admin') {
    const result = await authorizeD1Session(database, actor.claims, 'support.manage', { now: now(), requireMfa: true })
    if (!result.allowed) throw new SupportError(result.code)
  } else if ((await activeOrderCustomerId(database, actor.claims, now())) !== actor.customerId)
    throw new SupportError('unauthenticated')
}
const instantSql = "COALESCE(?1,strftime('%Y-%m-%dT%H:%M:%SZ','now'))"
export const actorSql =
  'SELECT i.id,i.customer_id FROM auth_sessions s JOIN identities i ON i.id=s.identity_id ' +
  'WHERE s.id=?2 AND s.identity_id=?3 AND s.session_version=?4 AND i.session_version=s.session_version ' +
  'AND s.revoked_at IS NULL AND s.created_at<=' +
  instantSql +
  ' AND s.expires_at>' +
  instantSql +
  " AND i.status IN ('active','pending') AND i.email_verified_at IS NOT NULL AND i.email_verified_at<=" +
  instantSql +
  ' AND ((?5 IS NULL AND s.mfa_verified=1 AND EXISTS(SELECT 1 FROM identity_roles r JOIN role_permissions p ON p.role_code=r.role_code ' +
  "WHERE r.identity_id=i.id AND p.permission_code='support.manage' AND r.granted_at<=" +
  instantSql +
  ' AND (r.expires_at IS NULL OR r.expires_at>' +
  instantSql +
  "))) OR (?5 IS NOT NULL AND i.status='active' " +
  "AND i.customer_id=?5 AND EXISTS(SELECT 1 FROM customers WHERE id=?5 AND status='active'))) " +
  'UNION ALL SELECT NULL,NULL WHERE ?6=1'
export function actorBinds(actor: SupportActor, options: { now?: string }) {
  return [
    options.now ?? null,
    actor.claims?.sessionId ?? null,
    actor.claims?.identityId ?? null,
    actor.claims?.sessionVersion ?? null,
    actor.customerId,
    actor.kind === 'anonymous' ? 1 : 0
  ]
}
const staffSql =
  "SELECT i.id,COALESCE(c.name,'Operador autorizado') AS label FROM identities i LEFT JOIN customers c ON c.id=i.customer_id " +
  "WHERE i.status='active' AND i.email_verified_at IS NOT NULL AND i.email_verified_at<=?1 " +
  'AND EXISTS(SELECT 1 FROM identity_roles r JOIN role_permissions p ON p.role_code=r.role_code WHERE r.identity_id=i.id ' +
  "AND p.permission_code='support.manage' AND r.granted_at<=?1 AND (r.expires_at IS NULL OR r.expires_at>?1))"
type TicketRow = {
  id: string
  public_ref: string
  customer_id: string | null
  order_id: string | null
  category: string
  subject: string
  requester: string
  declared_order_reference: string | null
  product_slug: string | null
  category_slug: string | null
  state: string
  priority: string
  owner_id: string | null
  next_action_at: string | null
  sla_due_at: string | null
  policy: string | null
  retention_until: string | null
  version: number
  last_command_id: string
  created_at: string
  updated_at: string
}
function summary(row: TicketRow, instant?: string) {
  const expired = instant !== undefined && row.retention_until !== null && row.retention_until <= instant
  return {
    publicRef: row.public_ref,
    category: row.category,
    subject: expired ? 'Contenido restringido por conservación' : row.subject,
    state: row.state,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    nextActionAt: row.next_action_at,
    slaDueAt: row.sla_due_at,
    policy: row.policy === null ? null : supportPolicySchema.parse(JSON.parse(row.policy)),
    retentionUntil: row.retention_until,
    identityStatus: row.customer_id ? 'verified_customer' : 'unverified_contact',
    orderId: expired ? null : row.order_id,
    productSlug: expired ? null : row.product_slug,
    categorySlug: expired ? null : row.category_slug
  }
}
function snapshot(row: TicketRow) {
  return {
    customerId: row.customer_id,
    orderId: row.order_id,
    priority: row.priority,
    ownerId: row.owner_id,
    nextActionAt: row.next_action_at,
    slaDueAt: row.sla_due_at
  }
}
async function history(database: D1Database, row: TicketRow) {
  const proof = await database
    .prepare(
      'SELECT (SELECT count(*) FROM support_commands WHERE ticket_id=?1) AS commands,' +
        '(SELECT count(*) FROM support_events WHERE ticket_id=?1) AS events,' +
        'EXISTS(SELECT 1 FROM support_commands c JOIN support_events e ON e.id=c.id ' +
        'WHERE c.id=?2 AND c.ticket_id=?1 AND c.result_version=?3 AND c.to_state=?4 AND c.created_at=?5 ' +
        'AND e.ticket_id=c.ticket_id AND e.state=c.to_state AND e.type=c.action AND e.actor_id IS c.actor_id) AS coherent'
    )
    .bind(row.id, row.last_command_id, row.version, row.state, row.updated_at)
    .first<{ commands: number; events: number; coherent: number }>()
  if (!proof || proof.commands !== row.version || proof.events !== row.version || proof.coherent !== 1)
    throw new SupportError('history_unconfirmed')
}
export async function authorizeSupportTicket(
  database: D1Database,
  actor: SupportActor,
  ref: string,
  now: () => string
) {
  if (!supportRef.safeParse(ref).success) throw new SupportError('not_found')
  await authorizeSupportActor(database, actor, now)
  if (actor.kind === 'anonymous') throw new SupportError('guest_verification_required')
  const row = await database
    .prepare('SELECT * FROM support_tickets WHERE public_ref=?1 AND (?2 IS NULL OR customer_id=?2)')
    .bind(ref, actor.customerId)
    .first<TicketRow>()
  if (!row) throw new SupportError('not_found')
  await history(database, row)
  await authorizeSupportActor(database, actor, now)
  return row
}
export function supportAttachmentStagingStatement(
  database: D1Database,
  actor: SupportActor,
  input: {
    id: string
    ticketId: string
    version: number
    key: string
    hash: string
    objectKey: string
    checksum: string
    filename: string
    mimeType: string
    byteSize: number
    visibility: 'public' | 'internal'
    createdAt: string
  },
  options: { now?: string }
) {
  return database
    .prepare(
      'WITH actor AS MATERIALIZED (' +
        actorSql +
        ') INSERT INTO support_attachments(' +
        'id,ticket_id,actor_id,idempotency_key,payload_hash,object_key,checksum,filename,mime_type,byte_size,visibility,created_at) ' +
        'SELECT ?7,?8,?3,?9,?10,?11,?12,?13,?14,?15,?16,?17 WHERE EXISTS(SELECT 1 FROM actor) ' +
        'AND EXISTS(SELECT 1 FROM support_tickets WHERE id=?8 AND version=?18 AND (?5 IS NULL OR customer_id=?5)) ' +
        "AND (?5 IS NULL OR ?16='public')"
    )
    .bind(
      ...actorBinds(actor, options),
      input.id,
      input.ticketId,
      input.key,
      input.hash,
      input.objectKey,
      input.checksum,
      input.filename,
      input.mimeType,
      input.byteSize,
      input.visibility,
      input.createdAt,
      input.version
    )
}
function assertPage(page: SupportPage) {
  if (
    !Number.isSafeInteger(page.page) ||
    page.page < 1 ||
    page.page > 1000000 ||
    !Number.isSafeInteger(page.perPage) ||
    page.perPage < 1 ||
    page.perPage > 50
  )
    throw new SupportError('invalid_input')
}
async function replay(database: D1Database, actor: SupportActor, key: string, hash: string, ref?: string) {
  const row = await database
    .prepare(
      'SELECT public_ref,payload_hash,response,id,ticket_id,result_version FROM support_commands WHERE actor_key=? AND idempotency_key=?'
    )
    .bind(actor.key, key)
    .first<{
      public_ref: string
      payload_hash: string
      response: string
      id: string
      ticket_id: string
      result_version: number
    }>()
  if (!row) return null
  if (row.payload_hash !== hash || (ref !== undefined && row.public_ref !== ref))
    throw new SupportError('idempotency_conflict')
  const audit = await database
    .prepare('SELECT id FROM support_events WHERE id=?1 AND ticket_id=?2')
    .bind(row.id, row.ticket_id)
    .first()
  if (!audit) throw new SupportError('history_unconfirmed')
  return supportReceiptSchema.parse(JSON.parse(row.response))
}
export async function replaySupportContact(
  rawDatabase: D1Database,
  actor: SupportActor,
  raw: unknown,
  key: string,
  instant?: string
) {
  const database = guardedFiscalDatabase(rawDatabase),
    now = supportClock(instant),
    input = supportChecked(supportContactInputSchema, raw)
  supportChecked(supportKey, key)
  await authorizeSupportActor(database, actor, now)
  const result = await replay(database, actor, key, await sha256Hex(canonicalJson({ action: 'created', input })))
  await authorizeSupportActor(database, actor, now)
  return result
}
interface CommitInput {
  row: TicketRow
  actor: SupportActor
  input: unknown
  action: 'created' | 'update' | 'reply' | 'note' | 'call' | 'attachment'
  body: string | null
  visibility: 'public' | 'internal'
  expected: number
  from: string | null
  hash: string
  options: SupportCommandOptions
  occurredAt?: string | null
  attachmentId?: string
}
async function commit(rawDatabase: D1Database, command: CommitInput, now: () => string) {
  const database = guardedFiscalDatabase(rawDatabase),
    { row, actor, options } = command
  const id = crypto.randomUUID(),
    nonce = crypto.randomUUID()
  const queueEmail = command.action === 'created' || (command.action === 'reply' && actor.kind === 'admin')
  const receipt = supportReceiptSchema.parse({
    source: 'cloudflare',
    commandId: id,
    publicRef: row.public_ref,
    version: command.expected + 1,
    state: row.state,
    updated: true,
    emailStatus: queueEmail ? 'queued' : 'not_requested',
    inventoryEffect: 'none',
    economicEffect: 'none'
  })
  const outbox = queueEmail
    ? await prepareEmailOutboxEnqueue(database, {
        sourceEventId: id,
        sourceKind: 'support',
        sourceId: row.id,
        eventType: command.action === 'created' ? 'support.ticket.received' : 'support.ticket.reply',
        now: row.updated_at
      })
    : null
  await authorizeSupportActor(database, actor, now)
  const binds = actorBinds(actor, options)
  const scope =
    actor.kind === 'anonymous'
      ? 'AND ?25 IS NULL AND ?26 IS NULL'
      : (actor.kind === 'customer' ? 'AND EXISTS(SELECT 1 FROM actor WHERE customer_id=?25) ' : 'AND ?25 IS ?25 ') +
        'AND (?26 IS NULL OR EXISTS(SELECT 1 FROM orders WHERE id=?26 AND customer_id=?25))'
  const statements = [
    database
      .prepare(
        'WITH actor AS MATERIALIZED (' +
          actorSql +
          ') ' +
          'INSERT INTO support_commands(id,nonce,actor_key,actor_id,actor_type,ticket_id,public_ref,action,idempotency_key,' +
          'payload_hash,input,snapshot,expected_version,result_version,from_state,to_state,response,created_at) ' +
          'SELECT ?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?19+1,?20,?21,?22,?23 ' +
          'WHERE EXISTS(SELECT 1 FROM actor) ' +
          scope +
          ' AND (?24 IS NULL OR EXISTS(' +
          staffSql.replaceAll('?1', instantSql) +
          ' AND i.id=?24))' +
          " AND (json_type(?17,'$.macro') IS NULL OR EXISTS(SELECT 1 FROM support_macro_commands m " +
          "WHERE m.id=json_extract(?17,'$.macro.revisionId') AND m.state='approved' " +
          'AND m.version=(SELECT MAX(version) FROM support_macro_commands WHERE macro_id=m.macro_id) ' +
          "AND json_extract(m.snapshot,'$.review.expiresAt')>" +
          instantSql +
          '))'
      )
      .bind(
        ...binds,
        id,
        nonce,
        actor.key,
        actor.claims?.identityId ?? null,
        actor.kind,
        row.id,
        row.public_ref,
        command.action,
        options.idempotencyKey,
        command.hash,
        canonicalJson(command.input),
        canonicalJson(snapshot(row)),
        command.expected,
        command.from,
        row.state,
        canonicalJson(receipt),
        row.updated_at,
        command.action === 'update' ? row.owner_id : null,
        row.customer_id,
        row.order_id
      )
  ]
  if (command.action === 'created') {
    statements.push(
      database
        .prepare(
          'INSERT INTO support_tickets(id,public_ref,customer_id,order_id,category,subject,requester,declared_order_reference,' +
            'product_slug,category_slug,state,priority,owner_id,next_action_at,sla_due_at,policy,retention_until,version,last_command_id,created_at,updated_at)' +
            ' SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,1,?18,?19,?19 ' +
            'WHERE EXISTS(SELECT 1 FROM support_commands WHERE id=?18 AND nonce=?20)'
        )
        .bind(
          row.id,
          row.public_ref,
          row.customer_id,
          row.order_id,
          row.category,
          row.subject,
          row.requester,
          row.declared_order_reference,
          row.product_slug,
          row.category_slug,
          row.state,
          row.priority,
          row.owner_id,
          row.next_action_at,
          row.sla_due_at,
          row.policy,
          row.retention_until,
          id,
          row.created_at,
          nonce
        )
    )
  } else {
    statements.push(
      database
        .prepare(
          'UPDATE support_tickets SET state=?1,priority=?2,owner_id=?3,next_action_at=?4,sla_due_at=?5,' +
            'version=version+1,last_command_id=?6,updated_at=?7 WHERE id=?8 AND version=?9 ' +
            'AND EXISTS(SELECT 1 FROM support_commands WHERE id=?6 AND nonce=?10)'
        )
        .bind(
          row.state,
          row.priority,
          row.owner_id,
          row.next_action_at,
          row.sla_due_at,
          id,
          row.updated_at,
          row.id,
          command.expected,
          nonce
        )
    )
  }
  statements.push(
    database
      .prepare(
        'INSERT INTO support_events(id,ticket_id,actor_type,actor_id,type,visibility,body,state,occurred_at,created_at)' +
          ' SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10 WHERE EXISTS(SELECT 1 FROM support_commands WHERE id=?1 AND nonce=?11)'
      )
      .bind(
        id,
        row.id,
        actor.kind,
        actor.claims?.identityId ?? null,
        command.action,
        command.visibility,
        command.body,
        row.state,
        command.occurredAt ?? null,
        row.updated_at,
        nonce
      )
  )
  if (command.attachmentId)
    statements.push(
      database
        .prepare(
          "UPDATE support_attachments SET state='quarantined',stored_at=?1,command_id=?2 WHERE id=?3 AND state='staging' " +
            'AND ticket_id=?4 AND actor_id=?5 AND EXISTS(SELECT 1 FROM support_commands WHERE id=?2 AND nonce=?6)'
        )
        .bind(row.updated_at, id, command.attachmentId, row.id, actor.claims?.identityId ?? null, nonce)
    )
  if (outbox) statements.push(outbox.statement)
  const guard = crypto.randomUUID()
  statements.push(
    database
      .prepare(
        'INSERT INTO support_guards(id,satisfied) SELECT ?1,EXISTS(SELECT 1 FROM support_commands c JOIN support_tickets t ' +
          'ON t.last_command_id=c.id JOIN support_events e ON e.id=c.id WHERE c.id=?2 AND c.nonce=?3 AND t.version=c.result_version ' +
          "AND (?4 IS NULL OR EXISTS(SELECT 1 FROM support_attachments WHERE id=?4 AND command_id=c.id AND state='quarantined')))"
      )
      .bind(guard, id, nonce, command.attachmentId ?? null)
  )
  statements.push(database.prepare('DELETE FROM support_guards WHERE id=?').bind(guard))
  try {
    await database.batch(statements)
  } catch {
    await authorizeSupportActor(database, actor, now)
    const existing = await replay(database, actor, options.idempotencyKey, command.hash, row.public_ref)
    if (existing) return existing
    const macroInput = supportAdminInputSchema.safeParse(command.input)
    if (actor.kind === 'admin' && macroInput.success && macroInput.data.action === 'reply' && macroInput.data.macro) {
      const { confirmed: _confirmed, ...selection } = macroInput.data.macro
      await previewSupportMacro(database, actor.claims, row.public_ref, selection, { now: options.now })
    }
    if (command.action !== 'created') {
      const current = await authorizeSupportTicket(database, actor, row.public_ref, now)
      if (current.version !== command.expected) throw new SupportError('version_conflict')
    }
    throw new SupportError('write_unconfirmed')
  }
  await authorizeSupportActor(database, actor, now)
  const proof = await database.prepare('SELECT id FROM support_commands WHERE id=? AND nonce=?').bind(id, nonce).first()
  if (!proof) throw new SupportError('write_unconfirmed')
  return receipt
}
export async function createSupportTicket(
  rawDatabase: D1Database,
  actor: SupportActor,
  raw: unknown,
  options: SupportCommandOptions
): Promise<SupportReceipt> {
  const database = guardedFiscalDatabase(rawDatabase),
    input = supportChecked(supportContactInputSchema, raw),
    now = supportClock(options.now),
    key = supportChecked(supportKey, options.idempotencyKey)
  const hash = await sha256Hex(canonicalJson({ action: 'created', input }))
  await authorizeSupportActor(database, actor, now)
  const existing = await replay(database, actor, key, hash)
  if (existing) {
    await authorizeSupportActor(database, actor, now)
    return existing
  }
  if (input.orderId) {
    if (actor.kind !== 'customer' || !actor.customerId) throw new SupportError('guest_verification_required')
    const order = await database
      .prepare('SELECT id FROM orders WHERE id=? AND customer_id=?')
      .bind(input.orderId, actor.customerId)
      .first()
    if (!order) throw new SupportError('not_found')
  }
  const policy = options.policy == null ? null : supportPolicySchema.parse(options.policy),
    instant = now()
  const plus = (minutes: number) =>
    new Date(Date.parse(instant) + minutes * 60000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const row: TicketRow = {
    id: crypto.randomUUID(),
    public_ref: 'SOP-' + crypto.randomUUID().replaceAll('-', '').slice(0, 24).toUpperCase(),
    customer_id: actor.customerId,
    order_id: input.orderId ?? null,
    category: input.category,
    subject: input.subject,
    requester: canonicalJson({ name: input.name, email: input.email, phone: input.phone ?? null }),
    declared_order_reference: input.orderReference ?? null,
    product_slug: input.productSlug ?? null,
    category_slug: input.categorySlug ?? null,
    state: 'open',
    priority: 'normal',
    owner_id: null,
    next_action_at: null,
    sla_due_at: policy?.responseMinutes ? plus(policy.responseMinutes) : null,
    policy: policy ? canonicalJson(policy) : null,
    retention_until: policy ? plus(policy.retentionDays * 1440) : null,
    version: 1,
    last_command_id: '',
    created_at: instant,
    updated_at: instant
  }
  return commit(
    database,
    {
      row,
      actor,
      input,
      action: 'created',
      body: input.message,
      visibility: 'public',
      expected: 0,
      from: null,
      hash,
      options: { ...options, idempotencyKey: key }
    },
    now
  )
}
export async function executeSupportAdminCommand(
  rawDatabase: D1Database,
  claims: VerifiedSessionClaims | null,
  ref: string,
  raw: unknown,
  options: SupportCommandOptions
) {
  const database = guardedFiscalDatabase(rawDatabase),
    now = supportClock(options.now),
    actor = await supportActor(database, claims, 'admin', now),
    input = supportChecked(supportAdminInputSchema, raw),
    key = supportChecked(supportKey, options.idempotencyKey),
    hash = await sha256Hex(canonicalJson({ ref, input }))
  const row = await authorizeSupportTicket(database, actor, ref, now)
  if (row.retention_until && row.retention_until <= now()) throw new SupportError('retention_expired')
  const existing = await replay(database, actor, key, hash, ref)
  if (existing) {
    await authorizeSupportActor(database, actor, now)
    return existing
  }
  if (row.version !== input.expectedVersion) throw new SupportError('version_conflict')
  if (input.action === 'reply' && input.macro) {
    const selection = input.macro
    const preview = await previewSupportMacro(
      database,
      claims,
      ref,
      {
        macroId: selection.macroId,
        revisionId: selection.revisionId,
        personalizations: selection.personalizations
      },
      { now: options.now }
    )
    if (preview.ticketVersion !== row.version || preview.message !== input.message)
      throw new SupportError('invalid_input')
  }
  const from = row.state
  // The persisted enum is validated independently; never accept a fabricated
  // client snapshot as a transition or ownership proof.
  const oldState = supportChecked(z.enum(['open', 'waiting_customer', 'waiting_provider', 'resolved', 'closed']), from)
  if (input.action === 'update') {
    if (
      !allowedSupportTransition(oldState, input.state) ||
      (['resolved', 'closed'].includes(input.state) && !input.resolution)
    )
      throw new SupportError('invalid_transition')
    if (
      input.ownerId &&
      !(await database
        .prepare(staffSql + ' AND i.id=?2')
        .bind(now(), input.ownerId)
        .first())
    )
      throw new SupportError('owner_unavailable')
    row.state = input.state
    row.priority = input.priority
    row.owner_id = input.ownerId
    row.next_action_at = input.nextActionAt
    row.sla_due_at = input.slaDueAt
  }
  if (input.action === 'call') {
    if (input.occurredAt > now()) throw new SupportError('invalid_input')
    row.next_action_at = input.nextActionAt
  }
  if (input.action === 'reply' && ['resolved', 'closed'].includes(oldState))
    throw new SupportError('invalid_transition')
  row.updated_at = now()
  return commit(
    database,
    {
      row,
      actor,
      input,
      action: input.action,
      body: input.action === 'update' ? (input.resolution ?? null) : input.message,
      visibility: ['note', 'call'].includes(input.action) ? 'internal' : 'public',
      expected: input.expectedVersion,
      from,
      hash,
      options: { ...options, idempotencyKey: key },
      occurredAt: input.action === 'call' ? input.occurredAt : null
    },
    now
  )
}
export async function replySupportCustomer(
  rawDatabase: D1Database,
  claims: VerifiedSessionClaims | null,
  ref: string,
  raw: unknown,
  options: SupportCommandOptions
) {
  const database = guardedFiscalDatabase(rawDatabase),
    now = supportClock(options.now),
    actor = await supportActor(database, claims, 'customer', now),
    input = supportChecked(supportCustomerReplySchema, raw),
    key = supportChecked(supportKey, options.idempotencyKey),
    hash = await sha256Hex(canonicalJson({ ref, input }))
  const row = await authorizeSupportTicket(database, actor, ref, now)
  if (row.retention_until && row.retention_until <= now()) throw new SupportError('retention_expired')
  const existing = await replay(database, actor, key, hash, ref)
  if (existing) {
    await authorizeSupportActor(database, actor, now)
    return existing
  }
  if (row.version !== input.expectedVersion) throw new SupportError('version_conflict')
  if (['resolved', 'closed'].includes(row.state)) throw new SupportError('invalid_transition')
  const from = row.state
  row.state = 'open'
  row.updated_at = now()
  return commit(
    database,
    {
      row,
      actor,
      input,
      action: 'reply',
      body: input.message,
      visibility: 'public',
      expected: input.expectedVersion,
      from,
      hash,
      options: { ...options, idempotencyKey: key }
    },
    now
  )
}
export async function recordSupportAttachment(
  rawDatabase: D1Database,
  actor: SupportActor,
  ref: string,
  attachmentId: string,
  expectedVersion: number,
  visibility: 'public' | 'internal',
  options: SupportCommandOptions
) {
  const database = guardedFiscalDatabase(rawDatabase),
    now = supportClock(options.now),
    row = await authorizeSupportTicket(database, actor, ref, now)
  if (row.retention_until && row.retention_until <= now()) throw new SupportError('retention_expired')
  const input = { action: 'attachment', attachmentId, expectedVersion, visibility },
    hash = await sha256Hex(canonicalJson({ ref, input }))
  const existing = await replay(database, actor, options.idempotencyKey, hash, ref)
  if (existing) return existing
  if (row.version !== expectedVersion) throw new SupportError('version_conflict')
  if (actor.kind === 'customer' && visibility !== 'public') throw new SupportError('forbidden')
  const from = row.state
  row.updated_at = now()
  return commit(
    database,
    {
      row,
      actor,
      input,
      action: 'attachment',
      attachmentId,
      body: 'Archivo recibido en cuarentena; no se ha declarado seguro.',
      visibility,
      expected: expectedVersion,
      from,
      hash,
      options
    },
    now
  )
}
export async function listSupportTickets(
  rawDatabase: D1Database,
  claims: VerifiedSessionClaims | null,
  kind: 'admin' | 'customer',
  page: SupportPage,
  instant?: string
) {
  assertPage(page)
  const database = guardedFiscalDatabase(rawDatabase),
    now = supportClock(instant),
    actor = await supportActor(database, claims, kind, now)
  const values: (string | number | null)[] = [actor.customerId],
    filters = ['(?1 IS NULL OR customer_id=?1)']
  for (const [column, value] of [
    ['state', page.state],
    ['category', page.category],
    ['owner_id', page.owner]
  ] as const) {
    if (value !== undefined) {
      values.push(value)
      filters.push(column + '=?' + values.length)
    }
  }
  if (page.q) {
    values.push(page.q)
    const queryIndex = values.length
    values.push(now())
    filters.push(
      '(((retention_until IS NULL OR retention_until>?' +
        values.length +
        ') AND instr(lower(subject),lower(?' +
        queryIndex +
        '))>0) ' +
        'OR instr(public_ref,upper(?' +
        queryIndex +
        '))>0)'
    )
  }
  const where = ' WHERE ' + filters.join(' AND ')
  const total = await database
    .prepare('SELECT count(*) AS n FROM support_tickets' + where)
    .bind(...values)
    .first<{ n: number }>()
  if (!total || !Number.isSafeInteger(total.n) || total.n < 0) throw new SupportError('read_unconfirmed')
  const rows = (
    await database
      .prepare(
        'SELECT * FROM support_tickets' +
          where +
          ' ORDER BY updated_at DESC,id DESC LIMIT ?' +
          (values.length + 1) +
          ' OFFSET ?' +
          (values.length + 2)
      )
      .bind(...values, page.perPage, (page.page - 1) * page.perPage)
      .all<TicketRow>()
  ).results
  for (const row of rows) await history(database, row)
  const dto = {
    source: 'cloudflare',
    items: rows.map((row) =>
      kind === 'admin'
        ? {
            ...summary(row, now()),
            priority: row.priority,
            ownerId: row.retention_until !== null && row.retention_until <= now() ? null : row.owner_id
          }
        : summary(row, now())
    ),
    pagination: { page: page.page, perPage: page.perPage, total: total.n, pages: Math.ceil(total.n / page.perPage) }
  }
  await authorizeSupportActor(database, actor, now)
  return kind === 'admin' ? supportAdminListSchema.parse(dto) : supportCustomerListSchema.parse(dto)
}
export async function readSupportTicket(
  rawDatabase: D1Database,
  claims: VerifiedSessionClaims | null,
  kind: 'admin' | 'customer',
  ref: string,
  page: SupportPage,
  attachmentsEnabled = false,
  instant?: string
) {
  assertPage(page)
  const database = guardedFiscalDatabase(rawDatabase),
    now = supportClock(instant),
    actor = await supportActor(database, claims, kind, now),
    row = await authorizeSupportTicket(database, actor, ref, now)
  const visibility = kind === 'customer' ? " AND visibility='public'" : ''
  const total = await database
    .prepare('SELECT count(*) AS n FROM support_events WHERE ticket_id=?' + visibility)
    .bind(row.id)
    .first<{ n: number }>()
  if (!total || !Number.isSafeInteger(total.n)) throw new SupportError('read_unconfirmed')
  const timeline = (
    await database
      .prepare(
        'SELECT id,type,actor_type AS actorType,body,visibility,state,created_at AS createdAt,occurred_at AS occurredAt ' +
          'FROM support_events WHERE ticket_id=?1' +
          visibility +
          ' ORDER BY created_at DESC,id DESC LIMIT ?2 OFFSET ?3'
      )
      .bind(row.id, page.perPage, (page.page - 1) * page.perPage)
      .all()
  ).results
  const expired = row.retention_until !== null && row.retention_until <= now()
  if (expired) for (const item of timeline) item.body = null
  const attachments = (
    await database
      .prepare(
        'SELECT a.id,a.filename,a.mime_type AS mimeType,a.byte_size AS byteSize,' +
          "CASE WHEN a.state='staging' THEN 'staging' WHEN s.verdict='infected' THEN 'infected' " +
          "WHEN s.verdict='clean' AND s.expires_at>?2 THEN 'clean' WHEN s.verdict='clean' THEN 'expired' ELSE 'quarantined' END AS state," +
          'a.visibility,a.created_at AS createdAt FROM support_attachments a LEFT JOIN support_attachment_scans s ON s.seq=' +
          '(SELECT MAX(seq) FROM support_attachment_scans WHERE attachment_id=a.id) WHERE a.ticket_id=?1' +
          (kind === 'customer' ? " AND a.visibility='public'" : '') +
          ' ORDER BY a.created_at DESC,a.id DESC LIMIT 100'
      )
      .bind(row.id, now())
      .all<{
        id: string
        filename: string
        mimeType: string
        byteSize: number
        state: string
        visibility: string
        createdAt: string
      }>()
  ).results.map((item) => ({
    ...item,
    filename: expired ? 'Archivo restringido por conservación' : item.filename,
    downloadable: attachmentsEnabled && !expired && item.state === 'clean'
  }))
  const context = expired
    ? {
        order: null,
        payment: null,
        fulfillment: null,
        returns: [],
        fiscal: null,
        redacted: ['order', 'payment', 'fiscal']
      }
    : await readSupportContext(database, actor.claims!, row.order_id, actor.customerId, now)
  const dto = {
    source: 'cloudflare',
    ...summary(row, now()),
    timeline,
    attachments,
    context,
    pagination: { page: page.page, perPage: page.perPage, total: total.n, pages: Math.ceil(total.n / page.perPage) },
    capabilities: {
      reply: !expired && !['resolved', 'closed'].includes(row.state),
      manage: kind === 'admin' && !expired,
      attachments: attachmentsEnabled && !expired,
      refunds: false,
      fiscal: false,
      inventory: false,
      carrier: false
    }
  }
  await authorizeSupportActor(database, actor, now)
  if ((await authorizeSupportTicket(database, actor, ref, now)).version !== row.version)
    throw new SupportError('read_unconfirmed')
  if (kind === 'customer') return supportCustomerTicketSchema.parse(dto)
  const staff = (
    await database
      .prepare(staffSql + ' ORDER BY i.id LIMIT 100')
      .bind(now())
      .all()
  ).results
  await authorizeSupportActor(database, actor, now)
  return supportAdminTicketSchema.parse({
    ...dto,
    priority: row.priority,
    ownerId: expired ? null : row.owner_id,
    requester: expired
      ? { name: 'Contacto restringido por conservación', email: '', phone: null }
      : JSON.parse(row.requester),
    declaredOrderReference: expired ? null : row.declared_order_reference,
    staff: expired ? [] : staff
  })
}
