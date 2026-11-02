import {
  DEFAULT_GLOBAL_MODAL_COOLDOWN_SECONDS,
  DESKTOP_MAX_VIEWPORT_HEIGHT_PERCENT,
  MAX_MOBILE_VIEWPORT_HEIGHT_PERCENT,
  MIN_MODAL_TIME_ON_PAGE_SECONDS,
  adminMarketingModalDetailSchema,
  adminMarketingModalInputSchema,
  adminMarketingModalIntentHash,
  adminMarketingModalItemSchema,
  adminMarketingModalListSchema,
  adminMarketingModalPolicyInputSchema,
  adminMarketingModalPolicyIntentHash,
  adminMarketingModalPolicyReceiptSchema,
  adminMarketingModalQuerySchema,
  adminMarketingModalReceiptSchema,
  isMarketingModalProhibitedRoute,
  marketingModalDefinitionHash,
  marketingModalDefinitionSchema,
  marketingModalEligibilityInputSchema,
  marketingModalEligibilityResponseSchema,
  marketingModalInteractionHash,
  marketingModalInteractionInputSchema,
  marketingModalInteractionReceiptSchema,
  marketingModalPolicySchema,
  matchesModalRoutePrefix,
  selectMarketingModalVariant,
  type AdminMarketingModalDetail,
  type AdminMarketingModalItem,
  type AdminMarketingModalList,
  type AdminMarketingModalPolicyReceipt,
  type AdminMarketingModalReceipt,
  type MarketingModalAudienceSegment,
  type MarketingModalDefinition,
  type MarketingModalEligibilityResponse,
  type MarketingModalInteractionReceipt,
  type MarketingModalPolicy,
  type MarketingModalPriorityTier,
  type MarketingModalRejectionReason
} from '../../shared/marketing-modals'
import { catalogPolicyInstantSchema, catalogPolicyUuidSchema } from '../../shared/catalog-publication-policy'
import { authorizeD1Session, type VerifiedSessionClaims } from '../catalog/authorization'

export class MarketingModalError extends Error {
  constructor(
    readonly code:
      | 'invalid_input'
      | 'unauthenticated'
      | 'email_unverified'
      | 'mfa_required'
      | 'forbidden'
      | 'not_found'
      | 'version_conflict'
      | 'idempotency_conflict'
      | 'code_immutable'
      | 'code_conflict'
      | 'modal_retired'
      | 'history_unconfirmed'
      | 'service_unavailable'
  ) {
    super(code)
  }
}

type Options = { now?: string }
type CommandOptions = Options & { idempotencyKey: string }

function fail(code: MarketingModalError['code']): never {
  throw new MarketingModalError(code)
}

function nowInstant(options?: Options): string {
  const candidate = options?.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const parsed = catalogPolicyInstantSchema.safeParse(candidate)
  if (!parsed.success) fail('invalid_input')
  return parsed.data
}

function parseOrFail<T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  value: unknown,
  code: MarketingModalError['code'] = 'invalid_input'
): T {
  const result = schema.safeParse(value)
  if (!result.success) fail(code)
  return result.data
}

/** Live administration authority, parameterised so each caller binds its own placeholders. */
function actorAuthoritySql(p: { session: string; identity: string; version: string; now: string }) {
  return `EXISTS(SELECT 1 FROM auth_sessions s JOIN identities i ON i.id=s.identity_id AND i.session_version=s.session_version
 WHERE s.id=${p.session} AND s.identity_id=${p.identity} AND s.session_version=${p.version} AND s.revoked_at IS NULL AND s.mfa_verified=1
 AND s.created_at<=${p.now} AND s.expires_at>${p.now}
 AND i.status IN ('active','pending') AND i.email_verified_at IS NOT NULL AND i.email_verified_at<=${p.now}
 AND EXISTS(SELECT 1 FROM identity_roles r JOIN role_permissions p ON p.role_code=r.role_code
 WHERE r.identity_id=i.id AND p.permission_code='administration.manage'
 AND r.granted_at<=${p.now} AND (r.expires_at IS NULL OR r.expires_at>${p.now})))`
}

async function authorizeAdmin(db: D1Database, claims: VerifiedSessionClaims, now: string) {
  const auth = await authorizeD1Session(db, claims, 'administration.manage', {
    requireMfa: true,
    now
  })
  if (!auth.allowed) fail(auth.code)
}

async function assertFinalAuthority(db: D1Database, claims: VerifiedSessionClaims, now: string) {
  const row = await db
    .prepare(
      `SELECT 1 AS allowed WHERE ${actorAuthoritySql({ session: '?1', identity: '?2', version: '?3', now: '?4' })}`
    )
    .bind(claims.sessionId, claims.identityId, claims.sessionVersion, now)
    .first()
  if (!row) {
    await authorizeAdmin(db, claims, now)
    fail('forbidden')
  }
}

export async function computeMarketingVisitorHash(visitorToken: string, hmacPepper: string): Promise<string> {
  if (typeof visitorToken !== 'string' || visitorToken.length < 8 || visitorToken.length > 200) {
    fail('invalid_input')
  }
  if (typeof hmacPepper !== 'string' || hmacPepper.length < 16) {
    fail('service_unavailable')
  }
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(hmacPepper),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`neteco:marketing-modals:visitor:v1:${visitorToken}`)
  )
  return Array.from(new Uint8Array(signature), (b) => b.toString(16).padStart(2, '0')).join('')
}

export async function readD1MarketingModalPolicy(db: D1Database, options: Options = {}): Promise<MarketingModalPolicy> {
  const _now = nowInstant(options)
  const row = await db
    .prepare(
      `SELECT version, global_cooldown_seconds, updated_at, updated_by
       FROM marketing_modal_policies WHERE id='default'`
    )
    .first<{
      version: number
      global_cooldown_seconds: number
      updated_at: string
      updated_by: string
    }>()
  if (!row) {
    return marketingModalPolicySchema.parse({
      version: 0,
      globalCooldownSeconds: DEFAULT_GLOBAL_MODAL_COOLDOWN_SECONDS,
      updatedAt: null,
      updatedBy: null
    })
  }
  return parseOrFail(
    marketingModalPolicySchema,
    {
      version: row.version,
      globalCooldownSeconds: row.global_cooldown_seconds,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by
    },
    'history_unconfirmed'
  )
}

export async function updateD1MarketingModalPolicy(
  db: D1Database,
  claims: VerifiedSessionClaims,
  raw: unknown,
  options: CommandOptions
): Promise<AdminMarketingModalPolicyReceipt> {
  const now = nowInstant(options)
  await authorizeAdmin(db, claims, now)
  const commandId = parseOrFail(catalogPolicyUuidSchema, options.idempotencyKey)
  const input = parseOrFail(adminMarketingModalPolicyInputSchema, raw)
  const payloadHash = await adminMarketingModalPolicyIntentHash(input)

  const existingCmd = await db
    .prepare(
      `SELECT command_id, actor_id, applied_version, global_cooldown_seconds, payload_hash, created_at
       FROM marketing_modal_policy_commands WHERE command_id=?1`
    )
    .bind(commandId)
    .first<{
      command_id: string
      actor_id: string
      applied_version: number
      global_cooldown_seconds: number
      payload_hash: string
      created_at: string
    }>()

  if (existingCmd) {
    if (existingCmd.actor_id !== claims.identityId || existingCmd.payload_hash !== payloadHash) {
      fail('idempotency_conflict')
    }
    await assertFinalAuthority(db, claims, now)
    return parseOrFail(
      adminMarketingModalPolicyReceiptSchema,
      {
        source: 'cloudflare',
        commandId,
        payloadHash,
        policy: {
          version: existingCmd.applied_version,
          globalCooldownSeconds: existingCmd.global_cooldown_seconds,
          updatedAt: existingCmd.created_at,
          updatedBy: existingCmd.actor_id
        }
      },
      'history_unconfirmed'
    )
  }

  const currentPolicy = await readD1MarketingModalPolicy(db, { now })
  if (currentPolicy.version !== input.expectedVersion) {
    fail('version_conflict')
  }
  const nextVersion = input.expectedVersion + 1

  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO marketing_modal_policy_commands(
             command_id, actor_id, session_id, session_version, expected_version,
             applied_version, global_cooldown_seconds, payload_hash, reason, created_at
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`
        )
        .bind(
          commandId,
          claims.identityId,
          claims.sessionId,
          claims.sessionVersion,
          input.expectedVersion,
          nextVersion,
          input.globalCooldownSeconds,
          payloadHash,
          input.reason,
          now
        ),
      input.expectedVersion === 0
        ? db
            .prepare(
              `INSERT INTO marketing_modal_policies(id, version, global_cooldown_seconds, updated_by, updated_at, command_id)
               VALUES ('default', 1, ?1, ?2, ?3, ?4)`
            )
            .bind(input.globalCooldownSeconds, claims.identityId, now, commandId)
        : db
            .prepare(
              `UPDATE marketing_modal_policies
               SET version=?1, global_cooldown_seconds=?2, updated_by=?3, updated_at=?4, command_id=?5
               WHERE id='default' AND version=?6`
            )
            .bind(nextVersion, input.globalCooldownSeconds, claims.identityId, now, commandId, input.expectedVersion),
      db
        .prepare(
          `INSERT INTO marketing_modal_guards(command_id, valid)
           SELECT ?1, CASE WHEN (${actorAuthoritySql({ session: '?2', identity: '?3', version: '?4', now: '?5' })})
             AND EXISTS(SELECT 1 FROM marketing_modal_policies WHERE id='default' AND version=?6 AND command_id=?1)
             THEN 1 ELSE 0 END`
        )
        .bind(commandId, claims.sessionId, claims.identityId, claims.sessionVersion, now, nextVersion),
      db.prepare(`DELETE FROM marketing_modal_guards WHERE command_id=?1`).bind(commandId)
    ])
  } catch (error) {
    const msg = error instanceof Error ? error.message : ''
    if (msg.includes('UNIQUE') || msg.includes('version_conflict') || msg.includes('CHECK')) {
      fail('version_conflict')
    }
    throw error
  }

  await assertFinalAuthority(db, claims, now)
  const policy = await readD1MarketingModalPolicy(db, { now })
  return parseOrFail(
    adminMarketingModalPolicyReceiptSchema,
    {
      source: 'cloudflare',
      commandId,
      payloadHash,
      policy
    },
    'history_unconfirmed'
  )
}

interface ModalVersionRow {
  modal_id: string
  code: string
  current_version: number
  head_status: string
  head_created_at: string
  updated_at: string
  version: number
  definition_json: string
  definition_hash: string
  created_by: string
  created_at: string
  command_id: string
  actor_id: string
  expected_version: number
  applied_version: number
  payload_hash: string
  command_definition_hash: string
  reason: string
  command_at: string
  audit_match: number
  impressions: number
  dismissals: number
  conversions: number
}

const modalVersionSelectSql = `SELECT
  m.id AS modal_id, m.code, m.current_version, m.status AS head_status,
  m.created_at AS head_created_at, m.updated_at,
  v.version, v.definition_json, v.definition_hash, v.created_by, v.created_at,
  c.command_id, c.actor_id, c.expected_version, c.applied_version, c.payload_hash,
  c.definition_hash AS command_definition_hash, c.reason, c.created_at AS command_at,
  EXISTS(SELECT 1 FROM marketing_modal_audit a
    WHERE a.command_id=c.command_id AND a.modal_id=m.id AND a.version=v.version
      AND a.status=v.status AND a.actor_id=c.actor_id AND a.definition_hash=c.definition_hash
      AND a.payload_hash=c.payload_hash AND a.reason=c.reason AND a.created_at=c.created_at) AS audit_match,
  (SELECT count(*) FROM marketing_modal_interactions i WHERE i.modal_id=m.id AND i.event_type='impression') AS impressions,
  (SELECT count(*) FROM marketing_modal_interactions i WHERE i.modal_id=m.id AND i.event_type='dismiss') AS dismissals,
  (SELECT count(*) FROM marketing_modal_interactions i WHERE i.modal_id=m.id AND i.event_type='convert') AS conversions
FROM marketing_modals m
JOIN marketing_modal_versions v ON v.modal_id=m.id
LEFT JOIN marketing_modal_commands c ON c.modal_id=m.id AND c.applied_version=v.version`

async function verifyModalRow(row: ModalVersionRow | null): Promise<{
  item: AdminMarketingModalItem
  row: ModalVersionRow
}> {
  if (!row) fail('not_found')
  let rawDef: unknown
  try {
    rawDef = JSON.parse(row.definition_json)
  } catch {
    fail('history_unconfirmed')
  }
  const definition = parseOrFail(marketingModalDefinitionSchema, rawDef, 'history_unconfirmed')
  if (
    definition.id !== row.modal_id ||
    definition.code !== row.code ||
    definition.version !== row.version ||
    definition.version !== row.applied_version ||
    definition.version !== row.expected_version + 1 ||
    row.created_by !== row.actor_id ||
    row.created_at !== row.command_at ||
    !row.audit_match ||
    row.definition_hash !== row.command_definition_hash ||
    (await marketingModalDefinitionHash(definition)) !== row.definition_hash
  ) {
    fail('history_unconfirmed')
  }
  const item = parseOrFail(
    adminMarketingModalItemSchema,
    {
      definition,
      stats: {
        impressions: Number(row.impressions ?? 0),
        dismissals: Number(row.dismissals ?? 0),
        conversions: Number(row.conversions ?? 0)
      },
      createdAt: row.head_created_at,
      updatedAt: row.updated_at
    },
    'history_unconfirmed'
  )
  return { item, row }
}

function triggerValueOf(trigger: MarketingModalDefinition['trigger']): number {
  switch (trigger.kind) {
    case 'time_on_page':
    case 'exit_intent':
      return trigger.minSeconds
    case 'scroll_depth':
      return trigger.minPercent
    case 'page_views':
      return trigger.minPageViews
  }
}

export async function executeD1AdminMarketingModal(
  db: D1Database,
  claims: VerifiedSessionClaims,
  raw: unknown,
  options: CommandOptions
): Promise<AdminMarketingModalReceipt> {
  const now = nowInstant(options)
  await authorizeAdmin(db, claims, now)
  const commandId = parseOrFail(catalogPolicyUuidSchema, options.idempotencyKey)

  const existingRow = await db
    .prepare(`${modalVersionSelectSql} WHERE c.command_id=?1`)
    .bind(commandId)
    .first<ModalVersionRow>()

  let input: ReturnType<typeof adminMarketingModalInputSchema.parse> | null = null
  let payloadHash = ''
  if (raw !== undefined) {
    const parsedInput = adminMarketingModalInputSchema.safeParse(raw)
    if (parsedInput.success) {
      input = parsedInput.data
      payloadHash = await adminMarketingModalIntentHash(input)
    }
  }

  if (existingRow) {
    const { item, row } = await verifyModalRow(existingRow)
    if (!input || row.actor_id !== claims.identityId || row.payload_hash !== payloadHash) {
      fail('idempotency_conflict')
    }
    await assertFinalAuthority(db, claims, now)
    return parseOrFail(
      adminMarketingModalReceiptSchema,
      {
        source: 'cloudflare',
        commandId,
        modalId: item.definition.id,
        version: row.applied_version,
        status: item.definition.status,
        payloadHash: row.payload_hash,
        definitionHash: row.definition_hash,
        item,
        createdAt: row.command_at
      },
      'history_unconfirmed'
    )
  }

  if (!input) fail('invalid_input')
  const def = input.definition
  const definitionHash = await marketingModalDefinitionHash(def)

  const [byId, byCode] = await Promise.all([
    db
      .prepare(`SELECT id, code, current_version, status FROM marketing_modals WHERE id=?1`)
      .bind(def.id)
      .first<{ id: string; code: string; current_version: number; status: string }>(),
    db.prepare(`SELECT id FROM marketing_modals WHERE code=?1`).bind(def.code).first<{ id: string }>()
  ])

  if (input.expectedVersion === 0) {
    if (byId) fail('version_conflict')
    if (byCode) fail('code_conflict')
  } else {
    if (!byId) fail('not_found')
    if (byId.status === 'retired') fail('modal_retired')
    if (byId.code !== def.code) fail('code_immutable')
    if (byId.current_version !== input.expectedVersion) fail('version_conflict')
  }

  const definitionJson = JSON.stringify(def)
  const triggerVal = triggerValueOf(def.trigger)

  try {
    await db.batch([
      input.expectedVersion === 0
        ? db
            .prepare(
              `INSERT INTO marketing_modals(
                 id, code, current_version, status, priority, priority_tier,
                 starts_at, ends_at, created_at, updated_at
               ) VALUES (?1, ?2, 1, ?3, ?4, ?5, ?6, ?7, ?8, ?8)`
            )
            .bind(def.id, def.code, def.status, def.priority, def.priorityTier, def.startsAt, def.endsAt, now)
        : db
            .prepare(
              `UPDATE marketing_modals
               SET current_version=?1, status=?2, priority=?3, priority_tier=?4,
                   starts_at=?5, ends_at=?6, updated_at=max(updated_at, ?7)
               WHERE id=?8 AND code=?9 AND current_version=?10 AND status<>'retired'`
            )
            .bind(
              def.version,
              def.status,
              def.priority,
              def.priorityTier,
              def.startsAt,
              def.endsAt,
              now,
              def.id,
              def.code,
              input.expectedVersion
            ),
      db
        .prepare(
          `INSERT INTO marketing_modal_versions(
             modal_id, version, status, title, body, cta_label, cta_path,
             objective, ab_variant_json, trigger_kind, trigger_value,
             audience_segments_json, marketing_consent, include_prefixes_json, exclude_prefixes_json,
             priority, priority_tier, max_impressions_per_visitor, frequency_window_seconds,
             starts_at, ends_at, definition_json, definition_hash, created_by, created_at
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25)`
        )
        .bind(
          def.id,
          def.version,
          def.status,
          def.title,
          def.body,
          def.ctaLabel,
          def.ctaPath,
          def.objective,
          def.abVariant ? JSON.stringify(def.abVariant) : null,
          def.trigger.kind,
          triggerVal,
          JSON.stringify(def.audience.segments),
          def.audience.marketingConsent,
          JSON.stringify(def.targeting.includePrefixes),
          JSON.stringify(def.targeting.excludePrefixes),
          def.priority,
          def.priorityTier,
          def.frequency.maxImpressionsPerVisitor,
          def.frequency.windowSeconds,
          def.startsAt,
          def.endsAt,
          definitionJson,
          definitionHash,
          claims.identityId,
          now
        ),
      db
        .prepare(
          `INSERT INTO marketing_modal_commands(
             command_id, modal_id, actor_id, session_id, session_version,
             expected_version, applied_version, payload_hash, definition_hash, reason, created_at
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`
        )
        .bind(
          commandId,
          def.id,
          claims.identityId,
          claims.sessionId,
          claims.sessionVersion,
          input.expectedVersion,
          def.version,
          payloadHash,
          definitionHash,
          input.reason,
          now
        ),
      db
        .prepare(
          `INSERT INTO marketing_modal_audit(
             command_id, modal_id, version, status, actor_id,
             definition_hash, payload_hash, reason, created_at
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
        )
        .bind(
          commandId,
          def.id,
          def.version,
          def.status,
          claims.identityId,
          definitionHash,
          payloadHash,
          input.reason,
          now
        ),
      db
        .prepare(
          `INSERT INTO marketing_modal_guards(command_id, valid)
           SELECT ?1, CASE WHEN EXISTS(
             SELECT 1 FROM marketing_modals m
             WHERE m.id=?2 AND m.code=?3 AND m.current_version=?4 AND m.status=?5
           ) THEN 1 ELSE 0 END`
        )
        .bind(commandId, def.id, def.code, def.version, def.status),
      db.prepare(`DELETE FROM marketing_modal_guards WHERE command_id=?1`).bind(commandId)
    ])
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    if (message.includes('retired')) fail('modal_retired')
    if (
      message.includes('UNIQUE') ||
      message.includes('CHECK') ||
      message.includes('immutable') ||
      message.includes('identity_conflict')
    ) {
      fail('version_conflict')
    }
    throw error
  }

  const savedRow = await db
    .prepare(`${modalVersionSelectSql} WHERE c.command_id=?1`)
    .bind(commandId)
    .first<ModalVersionRow>()
  const { item, row } = await verifyModalRow(savedRow)
  await assertFinalAuthority(db, claims, now)

  return parseOrFail(
    adminMarketingModalReceiptSchema,
    {
      source: 'cloudflare',
      commandId,
      modalId: item.definition.id,
      version: row.applied_version,
      status: item.definition.status,
      payloadHash: row.payload_hash,
      definitionHash: row.definition_hash,
      item,
      createdAt: row.command_at
    },
    'history_unconfirmed'
  )
}

export async function readD1AdminMarketingModalCommand(
  db: D1Database,
  claims: VerifiedSessionClaims,
  commandId: string,
  expectedPayloadHash: string,
  options: Options = {}
): Promise<{
  source: 'cloudflare'
  outcome: 'applied'
  receipt: AdminMarketingModalReceipt | AdminMarketingModalPolicyReceipt
}> {
  const now = nowInstant(options)
  await authorizeAdmin(db, claims, now)
  const id = parseOrFail(catalogPolicyUuidSchema, commandId)
  if (!/^[0-9a-f]{64}$/.test(expectedPayloadHash)) fail('invalid_input')

  const modalCmdRow = await db
    .prepare(`${modalVersionSelectSql} WHERE c.command_id=?1`)
    .bind(id)
    .first<ModalVersionRow>()

  if (modalCmdRow) {
    const { item, row } = await verifyModalRow(modalCmdRow)
    if (row.actor_id !== claims.identityId || row.payload_hash !== expectedPayloadHash) {
      fail('idempotency_conflict')
    }
    await assertFinalAuthority(db, claims, now)
    return {
      source: 'cloudflare',
      outcome: 'applied',
      receipt: parseOrFail(
        adminMarketingModalReceiptSchema,
        {
          source: 'cloudflare',
          commandId: id,
          modalId: item.definition.id,
          version: row.applied_version,
          status: item.definition.status,
          payloadHash: row.payload_hash,
          definitionHash: row.definition_hash,
          item,
          createdAt: row.command_at
        },
        'history_unconfirmed'
      )
    }
  }

  const policyCmdRow = await db
    .prepare(
      `SELECT command_id, actor_id, applied_version, global_cooldown_seconds, payload_hash, created_at
       FROM marketing_modal_policy_commands WHERE command_id=?1`
    )
    .bind(id)
    .first<{
      command_id: string
      actor_id: string
      applied_version: number
      global_cooldown_seconds: number
      payload_hash: string
      created_at: string
    }>()

  if (policyCmdRow) {
    if (policyCmdRow.actor_id !== claims.identityId || policyCmdRow.payload_hash !== expectedPayloadHash) {
      fail('idempotency_conflict')
    }
    await assertFinalAuthority(db, claims, now)
    return {
      source: 'cloudflare',
      outcome: 'applied',
      receipt: parseOrFail(
        adminMarketingModalPolicyReceiptSchema,
        {
          source: 'cloudflare',
          commandId: id,
          payloadHash: policyCmdRow.payload_hash,
          policy: {
            version: policyCmdRow.applied_version,
            globalCooldownSeconds: policyCmdRow.global_cooldown_seconds,
            updatedAt: policyCmdRow.created_at,
            updatedBy: policyCmdRow.actor_id
          }
        },
        'history_unconfirmed'
      )
    }
  }

  fail('not_found')
}

export async function listD1AdminMarketingModals(
  db: D1Database,
  claims: VerifiedSessionClaims,
  rawQuery: unknown,
  options: Options = {}
): Promise<AdminMarketingModalList> {
  const now = nowInstant(options)
  await authorizeAdmin(db, claims, now)
  const query = parseOrFail(adminMarketingModalQuerySchema, rawQuery)
  const search = query.q.trim().toLowerCase()

  const filterSql = `WHERE v.version=m.current_version
    AND (?1='' OR instr(lower(m.code), ?1)>0 OR instr(lower(v.title), ?1)>0)
    AND (?2='all' OR m.status=?2)`

  const [countRow, rows, policy] = await Promise.all([
    db
      .prepare(
        `SELECT count(*) AS total FROM marketing_modals m
         JOIN marketing_modal_versions v ON v.modal_id=m.id ${filterSql}`
      )
      .bind(search, query.status)
      .first<{ total: number }>(),
    db
      .prepare(
        `${modalVersionSelectSql} ${filterSql}
         ORDER BY m.priority DESC, m.updated_at DESC, m.code ASC
         LIMIT ?3 OFFSET ?4`
      )
      .bind(search, query.status, query.perPage, (query.page - 1) * query.perPage)
      .all<ModalVersionRow>(),
    readD1MarketingModalPolicy(db, { now })
  ])

  const items: AdminMarketingModalItem[] = []
  for (const row of rows.results) {
    items.push((await verifyModalRow(row)).item)
  }

  await assertFinalAuthority(db, claims, now)
  return parseOrFail(
    adminMarketingModalListSchema,
    {
      source: 'cloudflare',
      policy,
      items,
      total: Number(countRow?.total ?? 0),
      page: query.page,
      perPage: query.perPage
    },
    'history_unconfirmed'
  )
}

export async function readD1AdminMarketingModal(
  db: D1Database,
  claims: VerifiedSessionClaims,
  modalId: string,
  rawQuery: { historyPage?: number } = {},
  options: Options = {}
): Promise<AdminMarketingModalDetail> {
  const now = nowInstant(options)
  await authorizeAdmin(db, claims, now)
  const id = parseOrFail(catalogPolicyUuidSchema, modalId)
  const historyPage = rawQuery.historyPage ?? 1
  if (!Number.isSafeInteger(historyPage) || historyPage < 1 || historyPage > 10_000) {
    fail('invalid_input')
  }

  const headRow = await db
    .prepare(`${modalVersionSelectSql} WHERE m.id=?1 AND v.version=m.current_version`)
    .bind(id)
    .first<ModalVersionRow>()
  const { item } = await verifyModalRow(headRow)

  const historyRows = await db
    .prepare(`${modalVersionSelectSql} WHERE m.id=?1 ORDER BY v.version DESC LIMIT 25 OFFSET ?2`)
    .bind(id, (historyPage - 1) * 25)
    .all<ModalVersionRow>()

  const history = []
  for (const hRow of historyRows.results) {
    const verified = await verifyModalRow(hRow)
    history.push({
      definition: verified.item.definition,
      actorId: verified.row.actor_id,
      reason: verified.row.reason,
      createdAt: verified.row.command_at
    })
  }

  await assertFinalAuthority(db, claims, now)
  return parseOrFail(
    adminMarketingModalDetailSchema,
    {
      source: 'cloudflare',
      item,
      history,
      historyTotal: item.definition.version,
      historyPage
    },
    'history_unconfirmed'
  )
}

async function resolveVisitorContextFromD1(
  db: D1Database,
  claims: VerifiedSessionClaims | null | undefined,
  now: string
): Promise<{ segment: MarketingModalAudienceSegment; newsletterSubscribed: boolean }> {
  if (!claims) return { segment: 'anonymous', newsletterSubscribed: false }
  const uuid =
    catalogPolicyUuidSchema.safeParse(claims.sessionId).success &&
    catalogPolicyUuidSchema.safeParse(claims.identityId).success &&
    Number.isSafeInteger(claims.sessionVersion) &&
    claims.sessionVersion >= 1
  if (!uuid) return { segment: 'anonymous', newsletterSubscribed: false }

  const row = await db
    .prepare(
      `SELECT
         i.id AS identity_id,
         c.id AS customer_id,
         EXISTS(SELECT 1 FROM companies co WHERE co.customer_id=c.id AND co.status='approved' AND co.created_at<=?1) AS company_approved,
         EXISTS(SELECT 1 FROM newsletter_subscriptions ns WHERE ns.email_normalized=lower(trim(i.email)) AND ns.status IN ('pending','confirmed')) AS newsletter_subscribed
       FROM auth_sessions s
       JOIN identities i ON i.id=s.identity_id AND i.session_version=s.session_version
       LEFT JOIN customers c ON c.id=i.customer_id AND c.status='active' AND c.created_at<=?1
       WHERE s.id=?2 AND s.identity_id=?3 AND s.session_version=?4
         AND s.revoked_at IS NULL AND s.created_at<=?1 AND s.expires_at>?1
         AND i.status IN ('pending','active') AND i.email_verified_at IS NOT NULL AND i.email_verified_at<=?1`
    )
    .bind(now, claims.sessionId, claims.identityId, claims.sessionVersion)
    .first<{
      identity_id: string
      customer_id: string | null
      company_approved: number
      newsletter_subscribed: number
    }>()

  if (!row) return { segment: 'anonymous', newsletterSubscribed: false }
  const segment: MarketingModalAudienceSegment = Number(row.company_approved) === 1 ? 'professional' : 'customer'
  return {
    segment,
    newsletterSubscribed: Number(row.newsletter_subscribed) === 1
  }
}

const REJECTION_PRECEDENCE: MarketingModalRejectionReason[] = [
  'converted_permanently',
  'dismissed_permanently',
  'consent_mismatch',
  'frequency_cap_reached',
  'exit_intent_mobile_forbidden',
  'trigger_not_met',
  'session_limit_reached',
  'outside_validity_window',
  'not_published',
  'no_matching_modal'
]

function rejectionRank(reason: MarketingModalRejectionReason): number {
  const index = REJECTION_PRECEDENCE.indexOf(reason)
  return index === -1 ? REJECTION_PRECEDENCE.length : index
}

function tierRank(tier: MarketingModalPriorityTier): number {
  if (tier === 'critical') return 3
  if (tier === 'high') return 2
  return 1
}

export async function evaluateD1MarketingModalEligibility(
  db: D1Database,
  rawInput: unknown,
  options: {
    now?: string
    claims?: VerifiedSessionClaims | null
    audienceSegment?: MarketingModalAudienceSegment
    visitorToken?: string | null
    hmacPepper?: string
  } = {}
): Promise<MarketingModalEligibilityResponse> {
  const now = nowInstant(options)
  const input = parseOrFail(marketingModalEligibilityInputSchema, rawInput)
  const policy = await readD1MarketingModalPolicy(db, { now })
  const globalCooldownSeconds = policy.globalCooldownSeconds

  const reject = (reason: MarketingModalRejectionReason): MarketingModalEligibilityResponse =>
    marketingModalEligibilityResponseSchema.parse({
      source: 'cloudflare',
      eligible: false,
      reason,
      globalCooldownSeconds,
      modal: null,
      evaluatedAt: now
    })

  // Rule 1: Never on prohibited routes (/carrito, /checkout, /pago*, /cuenta/seguridad, legal pages, admin/auth)
  if (isMarketingModalProhibitedRoute(input.path)) {
    return reject('prohibited_route')
  }

  // Rule 2: Never in the first 5s nor on initial page load
  if (input.isInitialLoad || input.timeOnPageSeconds < MIN_MODAL_TIME_ON_PAGE_SECONDS) {
    return reject('initial_load_guard')
  }

  // Rule 3a: Maximum 1 simultaneous modal
  if (input.activeModalOpen) {
    return reject('active_modal_open')
  }

  // Rule 3b: Maximum 1 modal per pageview
  if (input.pageViewModalsShown >= 1) {
    return reject('page_view_limit_reached')
  }

  // Resolve visitor audience and server-side interaction ledger (only when analytical consent is granted)
  const resolvedVisitor = options.audienceSegment
    ? { segment: options.audienceSegment, newsletterSubscribed: input.newsletterSubscribed }
    : await resolveVisitorContextFromD1(db, options.claims, now)

  const dismissedModalIds = new Set<string>(input.dismissedModalIds)
  const convertedModalIds = new Set<string>(input.convertedModalIds)
  const convertedObjectives = new Set<string>(input.convertedObjectives)
  const serverImpressionsByModal = new Map<string, string[]>()
  let latestDismissedAt: string | null = input.lastDismissedAt ?? null

  let visitorHash: string | null = null
  if (input.analyticsConsent && options.visitorToken && options.hmacPepper) {
    visitorHash = await computeMarketingVisitorHash(options.visitorToken, options.hmacPepper)
    const interactions = await db
      .prepare(
        `SELECT modal_id, event_type, objective, occurred_at
         FROM marketing_modal_interactions
         WHERE visitor_hash=?1
         ORDER BY occurred_at DESC
         LIMIT 250`
      )
      .bind(visitorHash)
      .all<{ modal_id: string; event_type: string; objective: string; occurred_at: string }>()

    for (const row of interactions.results) {
      if (row.event_type === 'dismiss') {
        dismissedModalIds.add(row.modal_id)
        if (!latestDismissedAt || row.occurred_at > latestDismissedAt) {
          latestDismissedAt = row.occurred_at
        }
      } else if (row.event_type === 'convert') {
        convertedModalIds.add(row.modal_id)
        convertedObjectives.add(row.objective)
      } else if (row.event_type === 'impression') {
        const list = serverImpressionsByModal.get(row.modal_id) ?? []
        list.push(row.occurred_at)
        serverImpressionsByModal.set(row.modal_id, list)
      }
    }
  }

  // Rule 4: Configurable global cooldown after closing any modal
  if (latestDismissedAt) {
    const elapsedSeconds = (Date.parse(now) - Date.parse(latestDismissedAt)) / 1000
    if (elapsedSeconds < globalCooldownSeconds) {
      return reject('global_cooldown_active')
    }
  }

  // Load candidate published modals ordered by priorityTier, priority DESC, updated_at DESC, code ASC
  const candidateRows = await db
    .prepare(
      `SELECT v.definition_json, v.definition_hash, m.updated_at
       FROM marketing_modals m
       JOIN marketing_modal_versions v ON v.modal_id=m.id AND v.version=m.current_version
       WHERE m.status='published'
       ORDER BY
         CASE m.priority_tier WHEN 'critical' THEN 3 WHEN 'high' THEN 2 ELSE 1 END DESC,
         m.priority DESC,
         m.updated_at DESC,
         m.code ASC
       LIMIT 100`
    )
    .all<{ definition_json: string; definition_hash: string; updated_at: string }>()

  if (candidateRows.results.length === 0) {
    return reject('no_matching_modal')
  }

  const candidates: MarketingModalDefinition[] = []
  for (const row of candidateRows.results) {
    let parsedJson: unknown
    try {
      parsedJson = JSON.parse(row.definition_json)
    } catch {
      continue
    }
    const parsedDef = marketingModalDefinitionSchema.safeParse(parsedJson)
    if (!parsedDef.success) continue
    if ((await marketingModalDefinitionHash(parsedDef.data)) !== row.definition_hash) continue
    candidates.push(parsedDef.data)
  }

  candidates.sort((a, b) => {
    const tierDiff = tierRank(b.priorityTier) - tierRank(a.priorityTier)
    if (tierDiff !== 0) return tierDiff
    if (b.priority !== a.priority) return b.priority - a.priority
    return a.code.localeCompare(b.code)
  })

  // Reported reason is the strongest one across candidates (fixed precedence), never the
  // first encountered, so the answer does not depend on code-sort order.
  let reportedRejection: MarketingModalRejectionReason = 'no_matching_modal'
  const recordRejection = (reason: MarketingModalRejectionReason) => {
    if (rejectionRank(reason) < rejectionRank(reportedRejection)) {
      reportedRejection = reason
    }
  }
  // Audience and route mismatches are silent: a modal that is not for this visitor or page is
  // not a candidate, so its existence and targeting are never disclosed.

  const nowMs = Date.parse(now)

  for (const def of candidates) {
    if (def.status !== 'published') {
      recordRejection('not_published')
      continue
    }
    // Validity window
    if (def.startsAt > now || (def.endsAt !== null && def.endsAt <= now)) {
      recordRejection('outside_validity_window')
      continue
    }
    // Rule 3c: Max 1 per session unless critical priority
    if (input.sessionModalsShown >= 1 && def.priorityTier !== 'critical') {
      recordRejection('session_limit_reached')
      continue
    }
    // Route exclusions and inclusions
    if (def.targeting.excludePrefixes.some((prefix) => matchesModalRoutePrefix(input.path, prefix))) {
      continue
    }
    if (!def.targeting.includePrefixes.some((prefix) => matchesModalRoutePrefix(input.path, prefix))) {
      continue
    }
    // Rule 5a: Permanent exclusion after conversion (modal ID, objective, or newsletter subscription)
    const newsletterAlreadyConverted =
      def.objective === 'newsletter_subscription' &&
      (input.newsletterSubscribed || resolvedVisitor.newsletterSubscribed)
    if (convertedModalIds.has(def.id) || convertedObjectives.has(def.objective) || newsletterAlreadyConverted) {
      recordRejection('converted_permanently')
      continue
    }
    // Rule 5b: Permanent exclusion after closing the same modal
    if (dismissedModalIds.has(def.id)) {
      recordRejection('dismissed_permanently')
      continue
    }
    // Audience segment (silent, see above)
    if (!def.audience.segments.includes(resolvedVisitor.segment)) {
      continue
    }
    // Marketing consent targeting
    if (def.audience.marketingConsent === 'with_consent' && !input.marketingConsent) {
      recordRejection('consent_mismatch')
      continue
    }
    if (def.audience.marketingConsent === 'without_consent' && input.marketingConsent) {
      recordRejection('consent_mismatch')
      continue
    }
    // Frequency cap within rolling window
    const windowStartMs = nowMs - def.frequency.windowSeconds * 1000
    const serverImps = (serverImpressionsByModal.get(def.id) ?? []).filter((ts) => {
      const t = Date.parse(ts)
      return t >= windowStartMs && t <= nowMs
    }).length
    const clientImps = (input.impressionsByModal[def.id] ?? []).filter((ts) => {
      const t = Date.parse(ts)
      return t >= windowStartMs && t <= nowMs
    }).length
    const effectiveImpressions = Math.max(serverImps, clientImps)
    if (effectiveImpressions >= def.frequency.maxImpressionsPerVisitor) {
      recordRejection('frequency_cap_reached')
      continue
    }
    // Trigger evaluation & mobile exit-intent prohibition
    if (def.trigger.kind === 'exit_intent') {
      if (input.viewport === 'mobile') {
        recordRejection('exit_intent_mobile_forbidden')
        continue
      }
      if (!input.exitIntent || input.timeOnPageSeconds < def.trigger.minSeconds) {
        recordRejection('trigger_not_met')
        continue
      }
    } else if (def.trigger.kind === 'time_on_page') {
      if (input.timeOnPageSeconds < def.trigger.minSeconds) {
        recordRejection('trigger_not_met')
        continue
      }
    } else if (def.trigger.kind === 'scroll_depth') {
      if (input.scrollPercent < def.trigger.minPercent) {
        recordRejection('trigger_not_met')
        continue
      }
    } else if (def.trigger.kind === 'page_views') {
      if (input.pageViewsInSession < def.trigger.minPageViews) {
        recordRejection('trigger_not_met')
        continue
      }
    }

    // Winner found! Resolve A/B variant and mobile/desktop presentation
    const seed = input.variantSeed || visitorHash || options.visitorToken || 'default'
    const variant = def.abVariant ? selectMarketingModalVariant(def.id, def.abVariant.splitPercent, seed) : 'A'
    const content = variant === 'B' && def.abVariant ? def.abVariant : def

    return marketingModalEligibilityResponseSchema.parse({
      source: 'cloudflare',
      eligible: true,
      reason: 'eligible',
      globalCooldownSeconds,
      modal: {
        id: def.id,
        code: def.code,
        version: def.version,
        title: content.title,
        body: content.body,
        ctaLabel: content.ctaLabel,
        ctaPath: content.ctaPath,
        objective: def.objective,
        variant,
        priority: def.priority,
        priorityTier: def.priorityTier,
        triggerKind: def.trigger.kind,
        presentation: {
          layout: input.viewport === 'mobile' ? 'bottom_sheet' : 'centered_dialog',
          maxViewportHeightPercent:
            input.viewport === 'mobile' ? MAX_MOBILE_VIEWPORT_HEIGHT_PERCENT : DESKTOP_MAX_VIEWPORT_HEIGHT_PERCENT,
          reducedMotion: input.prefersReducedMotion,
          closePersistent: true
        }
      },
      evaluatedAt: now
    })
  }

  return reject(reportedRejection)
}

export async function recordD1MarketingModalInteraction(
  db: D1Database,
  rawInput: unknown,
  options: {
    now?: string
    visitorToken?: string | null
    hmacPepper?: string
    analyticsConsentCookie?: boolean
  } = {}
): Promise<MarketingModalInteractionReceipt> {
  const now = nowInstant(options)
  const input = parseOrFail(marketingModalInteractionInputSchema, rawInput)
  const consented =
    options.analyticsConsentCookie !== undefined
      ? options.analyticsConsentCookie && input.analyticsConsent
      : input.analyticsConsent

  // Without analytical consent, frequency/dismissal/conversion state stays strictly in the browser
  if (!consented || !options.visitorToken || !options.hmacPepper) {
    return marketingModalInteractionReceiptSchema.parse({
      source: 'cloudflare',
      eventId: input.eventId,
      recorded: false,
      persisted: 'browser_only',
      replayed: false,
      reason: 'analytics_consent_required'
    })
  }

  const visitorHash = await computeMarketingVisitorHash(options.visitorToken, options.hmacPepper)
  const payloadHash = await marketingModalInteractionHash({
    modalId: input.modalId,
    modalVersion: input.modalVersion,
    variant: input.variant,
    eventType: input.eventType,
    objective: input.objective
  })

  const existing = await db
    .prepare(
      `SELECT event_id, visitor_hash, payload_hash
       FROM marketing_modal_interactions WHERE event_id=?1`
    )
    .bind(input.eventId)
    .first<{ event_id: string; visitor_hash: string; payload_hash: string }>()

  if (existing) {
    if (existing.visitor_hash !== visitorHash || existing.payload_hash !== payloadHash) {
      fail('idempotency_conflict')
    }
    return marketingModalInteractionReceiptSchema.parse({
      source: 'cloudflare',
      eventId: input.eventId,
      recorded: true,
      persisted: 'server_d1',
      replayed: true,
      reason: 'recorded'
    })
  }

  const modalVersionExists = await db
    .prepare(`SELECT 1 FROM marketing_modal_versions WHERE modal_id=?1 AND version=?2`)
    .bind(input.modalId, input.modalVersion)
    .first()
  if (!modalVersionExists) {
    fail('not_found')
  }

  // Server clock only: a client-supplied timestamp could backdate impressions and bypass the window.
  const occurredAt = now
  try {
    await db
      .prepare(
        `INSERT INTO marketing_modal_interactions(
           event_id, visitor_hash, modal_id, modal_version,
           variant_key, event_type, objective, payload_hash, occurred_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
      )
      .bind(
        input.eventId,
        visitorHash,
        input.modalId,
        input.modalVersion,
        input.variant,
        input.eventType,
        input.objective,
        payloadHash,
        occurredAt
      )
      .run()
  } catch (error) {
    // A concurrent identical request may win the primary key race: treat it as a replay.
    const message = error instanceof Error ? error.message : ''
    if (!message.includes('UNIQUE')) throw error
    const raced = await db
      .prepare(`SELECT visitor_hash, payload_hash FROM marketing_modal_interactions WHERE event_id=?1`)
      .bind(input.eventId)
      .first<{ visitor_hash: string; payload_hash: string }>()
    if (!raced || raced.visitor_hash !== visitorHash || raced.payload_hash !== payloadHash) {
      fail('idempotency_conflict')
    }
    return marketingModalInteractionReceiptSchema.parse({
      source: 'cloudflare',
      eventId: input.eventId,
      recorded: true,
      persisted: 'server_d1',
      replayed: true,
      reason: 'recorded'
    })
  }

  return marketingModalInteractionReceiptSchema.parse({
    source: 'cloudflare',
    eventId: input.eventId,
    recorded: true,
    persisted: 'server_d1',
    replayed: false,
    reason: 'recorded'
  })
}
