import { authorizeD1Session, type VerifiedSessionClaims } from './authorization'
import { madridDateKey, madridLocalDateTimeToInstant } from '../../server/utils/madrid-calendar'
import { catalogPolicyInstantSchema, catalogPolicyUuidSchema } from '../../shared/catalog-publication-policy'
import { canonicalJson } from './inventory'
import {
  shippingCalendarSnapshotSchema,
  shippingCalendarInputSchema,
  shippingCalendarReceiptSchema,
  shippingCalendarEtaSchema,
  shippingCalendarIntentHash,
  shippingCalendarConfigurationHash,
  type ShippingCalendarSnapshot,
  type ShippingCalendarReceipt,
  type ShippingCalendarCommand,
  type ShippingCalendarEta
} from '../../shared/shipping-calendar'
export class ShippingCalendarError extends Error {
  constructor(
    readonly code:
      | 'invalid_input'
      | 'unauthenticated'
      | 'email_unverified'
      | 'mfa_required'
      | 'forbidden'
      | 'version_conflict'
      | 'idempotency_conflict'
      | 'history_unconfirmed'
      | 'service_unavailable'
  ) {
    super(code)
    this.name = 'ShippingCalendarError'
  }
}
export interface ShippingCalendarOptions {
  now?: string
}
export interface ShippingCalendarEtaInput {
  now: string
  postalCode: string
  methodCode: 'pickup' | 'own_delivery' | 'parcel'
  serviceProfile: 'parcel' | 'pallet' | 'adr'
  zoneCode: string
  transitMinDays: number
  transitMaxDays: number
  stockLeadTimeDays: number | null
}
function fail(code: ShippingCalendarError['code']): never {
  throw new ShippingCalendarError(code)
}
function clock(options: ShippingCalendarOptions) {
  const started = Date.now(),
    base = options.now ?? new Date(started).toISOString().replace(/\.\d{3}Z$/, 'Z')
  if (!catalogPolicyInstantSchema.safeParse(base).success) fail('invalid_input')
  return () => new Date(Date.parse(base) + Math.max(0, Date.now() - started)).toISOString().replace(/\.\d{3}Z$/, 'Z')
}
/** Earliest point at which a fresh calendar calculation can move to another
 * local date/cutoff bucket. Stable within the bucket, including across DST. */
export function shippingCalendarRevalidationDeadline(snapshot: ShippingCalendarSnapshot, now: string): string | null {
  if (!snapshot.configuration) return null
  if (!catalogPolicyInstantSchema.safeParse(now).success) fail('invalid_input')
  const instant = new Date(now),
    date = madridDateKey(instant),
    cutoff = cutoffInstant(date, snapshot.configuration.cutoffLocalTime)
  const boundary =
    instant < cutoff
      ? cutoff
      : madridLocalDateTimeToInstant(
          `${new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)}T00:00`,
          'earlier'
        )
  return boundary.toISOString().replace(/\.\d{3}Z$/, 'Z')
}
function cutoffInstant(date: string, time: string) {
  // A repeated hour closes at its FIRST occurrence. A nonexistent local
  // minute closes at the first real minute after the spring clock jump.
  const nominal = Date.parse(`${date}T${time}:00Z`)
  for (let minute = 0; minute <= 180; minute++) {
    const local = new Date(nominal + minute * 60000).toISOString().slice(0, 16)
    try {
      return madridLocalDateTimeToInstant(local, 'earlier')
    } catch {
      /* DST gap */
    }
  }
  return fail('invalid_input')
}

/** Only server-resolved values may form this predicate. It is composed into
 * existing checkout rollback guards, not a new stock authority or saga. */
export async function shippingCalendarCurrentPredicate(
  db: D1Database,
  eta: ShippingCalendarEta | undefined,
  validUntil?: string | null
): Promise<string> {
  const parsed = shippingCalendarEtaSchema.safeParse(
    eta ?? {
      status: 'unknown',
      reason: 'calendar_not_configured',
      from: null,
      to: null,
      configurationVersion: 0,
      configurationHash: null
    }
  )
  if (!parsed.success) fail('history_unconfirmed')
  if (validUntil !== undefined && validUntil !== null && !catalogPolicyInstantSchema.safeParse(validUntil).success)
    fail('history_unconfirmed')
  const { results: tables } = await db
    .prepare(
      `SELECT name FROM sqlite_schema WHERE type='table' AND name IN('shipping_calendar_heads','shipping_calendar_commands','shipping_calendar_guards')`
    )
    .all<{ name: string }>()
  if (!tables.length && parsed.data.configurationVersion === 0) return '1'
  if (tables.length !== 3) fail('history_unconfirmed')
  const expected = parsed.data.configurationVersion,
    hash = parsed.data.configurationHash
  return `(COALESCE((SELECT version FROM shipping_calendar_heads WHERE id=1),0)=${expected}
   AND (SELECT count(*) FROM shipping_calendar_commands)=${expected}
   ${
     hash
       ? `AND EXISTS(SELECT 1 FROM shipping_calendar_heads h JOIN shipping_calendar_commands c ON c.actor_id=h.actor_id AND c.command_id=h.command_id
   WHERE h.id=1 AND c.result_version=h.version AND c.recorded_at=h.updated_at AND json_extract(c.receipt_json,'$.configurationHash')='${hash}')`
       : ''
   }
   ${validUntil ? `AND strftime('%Y-%m-%dT%H:%M:%SZ','now')<'${validUntil}'` : ''})`
}

/** Dates, rather than evaluation seconds, belong to quote eligibility hashes.
 * All operating days and closures come from reviewed configuration, never a
 * hardcoded national holiday feed or a carrier delivery guarantee. */
export function calculateShippingCalendarEta(
  snapshot: ShippingCalendarSnapshot,
  input: ShippingCalendarEtaInput
): ShippingCalendarEta {
  const parsed = shippingCalendarSnapshotSchema.safeParse(snapshot)
  if (!parsed.success) fail('history_unconfirmed')
  if (
    !catalogPolicyInstantSchema.safeParse(input.now).success ||
    ![input.transitMinDays, input.transitMaxDays].every(
      (value) => Number.isSafeInteger(value) && value >= 0 && value <= 365
    ) ||
    input.transitMinDays > input.transitMaxDays ||
    (input.stockLeadTimeDays !== null &&
      (!Number.isSafeInteger(input.stockLeadTimeDays) || input.stockLeadTimeDays < 0 || input.stockLeadTimeDays > 365))
  )
    fail('invalid_input')
  const unknown = (
    reason: 'calendar_not_configured' | 'lead_time_unknown' | 'no_operating_window'
  ): ShippingCalendarEta => ({
    status: 'unknown',
    reason,
    from: null,
    to: null,
    configurationVersion: snapshot.version,
    configurationHash: snapshot.configurationHash
  })
  const config = parsed.data.configuration
  if (!config) return unknown('calendar_not_configured')
  if (input.stockLeadTimeDays === null) return unknown('lead_time_unknown')
  const applicable = config.calendars.filter(
    (calendar) =>
      (!calendar.postalPrefixes.length ||
        calendar.postalPrefixes.some((prefix) => input.postalCode.startsWith(prefix))) &&
      (!calendar.methodCodes.length || calendar.methodCodes.includes(input.methodCode)) &&
      (!calendar.serviceProfiles.length || calendar.serviceProfiles.includes(input.serviceProfile)) &&
      (!calendar.zoneCodes.length || calendar.zoneCodes.includes(input.zoneCode))
  )
  const preparation = applicable.filter((calendar) => calendar.stage !== 'transit')
  const transit = applicable.filter((calendar) => calendar.stage !== 'preparation')
  if (!preparation.length || !transit.length) return unknown('calendar_not_configured')
  type Calendars = typeof applicable
  const operational = (date: string, calendars: Calendars) => {
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay() || 7
    return calendars.every(
      (calendar) => calendar.operatingWeekdays.includes(weekday) && !calendar.closedDates.includes(date)
    )
  }
  const nextDate = (date: string, days = 1) =>
    new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10)
  const advance = (initial: string, days: number, calendars: Calendars): string | null => {
    let current = initial,
      remaining = days
    // Zero-day dispatch/arrival still cannot promise a closed day.
    if (!remaining && operational(current, calendars)) return current
    for (let probe = 0; probe < 1098; probe++) {
      current = nextDate(current)
      if (operational(current, calendars)) {
        if (remaining > 0) remaining--
        if (!remaining) return current
      }
    }
    return null
  }
  const now = new Date(input.now)
  // Supplier lead_time_days is not declared a business-day SLA in the catalog.
  // Advance its calendar dates first, then apply the configured operating days.
  const start = nextDate(madridDateKey(now), input.stockLeadTimeDays)
  const dispatch = advance(
    start,
    config.preparationBusinessDays + (now >= cutoffInstant(madridDateKey(now), config.cutoffLocalTime) ? 1 : 0),
    preparation
  )
  if (!dispatch) return unknown('no_operating_window')
  const from = advance(dispatch, input.transitMinDays, transit),
    to = advance(dispatch, input.transitMaxDays, transit)
  if (!from || !to) return unknown('no_operating_window')
  return {
    status: 'estimated',
    from,
    to,
    configurationVersion: snapshot.version,
    configurationHash: snapshot.configurationHash!
  }
}

const empty: ShippingCalendarSnapshot = {
  source: 'cloudflare',
  version: 0,
  configuration: null,
  configurationHash: null,
  updatedAt: null
}
const authority = `WITH args AS MATERIALIZED(SELECT json_extract(?1,'$.identityId') identityId,json_extract(?1,'$.sessionId') sessionId,
 json_extract(?1,'$.sessionVersion') sessionVersion,COALESCE(json_extract(?1,'$.now'),strftime('%Y-%m-%dT%H:%M:%SZ','now')) now),
 authority AS MATERIALIZED(SELECT i.id FROM args a JOIN auth_sessions s ON s.id=a.sessionId JOIN identities i ON i.id=s.identity_id
 WHERE i.id=a.identityId AND s.session_version=a.sessionVersion AND i.session_version=s.session_version
 AND s.revoked_at IS NULL AND s.created_at<=a.now AND s.expires_at>a.now AND i.status IN('active','pending')
 AND i.email_verified_at IS NOT NULL AND i.email_verified_at<=a.now AND s.mfa_verified=1
 AND EXISTS(SELECT 1 FROM identity_roles r JOIN role_permissions p ON p.role_code=r.role_code
 WHERE r.identity_id=i.id AND p.permission_code='administration.manage' AND r.granted_at<=a.now AND(r.expires_at IS NULL OR r.expires_at>a.now)))`
async function authorize(db: D1Database, claims: VerifiedSessionClaims | null, now: string) {
  if (!claims) fail('unauthenticated')
  const result = await authorizeD1Session(db, claims, 'administration.manage', { now, requireMfa: true })
  if (!result.allowed) fail(result.code)
}
function args(claims: VerifiedSessionClaims | null, now: string | null) {
  return JSON.stringify({ ...claims, now })
}
async function finalAuthority(db: D1Database, claims: VerifiedSessionClaims | null, fresh: () => string) {
  if (!(await db.prepare(`${authority} SELECT id FROM authority`).bind(args(claims, fresh())).first())) {
    await authorize(db, claims, fresh())
    fail('forbidden')
  }
}
interface Row {
  actor_id: string
  command_id: string
  expected_version: number
  result_version: number
  input_json: string
  payload_hash: string
  receipt_json: string
  recorded_at: string
}
async function checkedCommand(row: Row): Promise<ShippingCalendarReceipt> {
  try {
    const input = shippingCalendarInputSchema.parse(JSON.parse(row.input_json))
    const receipt = shippingCalendarReceiptSchema.parse(JSON.parse(row.receipt_json))
    if (
      receipt.commandId !== row.command_id ||
      receipt.payloadHash !== row.payload_hash ||
      receipt.expectedVersion !== row.expected_version ||
      receipt.version !== row.result_version ||
      receipt.recordedAt !== row.recorded_at ||
      input.expectedVersion !== row.expected_version ||
      receipt.payloadHash !== (await shippingCalendarIntentHash(input)) ||
      receipt.configurationHash !== (await shippingCalendarConfigurationHash(input.configuration))
    )
      fail('history_unconfirmed')
    return receipt
  } catch {
    fail('history_unconfirmed')
  }
}
/** Private loader returns only configuration, never staff reason/reference or identity.
 * A genuinely pre-0078 schema has no configuration and therefore NO promised ETA.
 * Partial/malformed schemas and D1 outages are not converted into empty defaults. */
export async function readD1ShippingCalendarConfiguration(db: D1Database): Promise<ShippingCalendarSnapshot> {
  const { results: tables } = await db
    .prepare(
      `SELECT name FROM sqlite_schema WHERE type='table' AND name IN('shipping_calendar_heads','shipping_calendar_commands','shipping_calendar_guards')`
    )
    .all<{ name: string }>()
  if (!tables.length) return { ...empty }
  if (tables.length !== 3) fail('history_unconfirmed')
  const row = await db
    .prepare(
      `SELECT h.version,h.updated_at,c.*,
 (SELECT count(*) FROM shipping_calendar_commands) history_count
 FROM shipping_calendar_heads h LEFT JOIN shipping_calendar_commands c ON c.actor_id=h.actor_id AND c.command_id=h.command_id
 WHERE h.id=1`
    )
    .first<Row & { version: number; updated_at: string; history_count: number }>()
  if (!row) {
    if ((await db.prepare('SELECT count(*) AS n FROM shipping_calendar_commands').first<{ n: number }>())?.n !== 0)
      fail('history_unconfirmed')
    return { ...empty }
  }
  const receipt = await checkedCommand(row)
  if (row.version !== receipt.version || row.updated_at !== receipt.recordedAt || row.history_count !== row.version)
    fail('history_unconfirmed')
  return shippingCalendarSnapshotSchema.parse({
    source: 'cloudflare',
    version: row.version,
    configuration: shippingCalendarInputSchema.parse(JSON.parse(row.input_json)).configuration,
    configurationHash: receipt.configurationHash,
    updatedAt: receipt.recordedAt
  })
}
export async function readD1ShippingCalendars(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  options: ShippingCalendarOptions = {}
): Promise<ShippingCalendarSnapshot> {
  const fresh = clock(options)
  await authorize(db, claims, fresh())
  const result = await readD1ShippingCalendarConfiguration(db)
  await finalAuthority(db, claims, fresh)
  return result
}
async function command(db: D1Database, claims: VerifiedSessionClaims | null, key: string, hash: string) {
  const row = await db
    .prepare('SELECT * FROM shipping_calendar_commands WHERE actor_id=?1 AND command_id=?2')
    .bind(claims!.identityId, key)
    .first<Row>()
  if (!row) return null
  const receipt = await checkedCommand(row)
  if (receipt.payloadHash !== hash) fail('idempotency_conflict')
  return receipt
}
export async function readD1ShippingCalendarCommand(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  key: string,
  hash: string,
  options: ShippingCalendarOptions = {}
): Promise<ShippingCalendarCommand> {
  const fresh = clock(options)
  await authorize(db, claims, fresh())
  if (!catalogPolicyUuidSchema.safeParse(key).success || !/^[a-f0-9]{64}$/.test(hash)) fail('invalid_input')
  const receipt = await command(db, claims, key, hash)
  await finalAuthority(db, claims, fresh)
  return receipt
    ? { source: 'cloudflare', outcome: 'applied', receipt }
    : { source: 'cloudflare', outcome: 'unknown', receipt: null }
}
export async function updateD1ShippingCalendars(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  raw: unknown,
  options: ShippingCalendarOptions & { idempotencyKey: string }
): Promise<ShippingCalendarReceipt> {
  const fresh = clock(options)
  await authorize(db, claims, fresh())
  const parsed = shippingCalendarInputSchema.safeParse(raw)
  if (!parsed.success || !catalogPolicyUuidSchema.safeParse(options.idempotencyKey).success) fail('invalid_input')
  const input = parsed.data,
    key = options.idempotencyKey,
    hash = await shippingCalendarIntentHash(input)
  const previous = await command(db, claims, key, hash)
  if (previous) {
    await finalAuthority(db, claims, fresh)
    return previous
  }
  const snapshot = await readD1ShippingCalendarConfiguration(db)
  if (snapshot.version !== input.expectedVersion) {
    await finalAuthority(db, claims, fresh)
    fail('version_conflict')
  }
  const recordedAt = fresh(),
    receipt: ShippingCalendarReceipt = {
      source: 'cloudflare',
      commandId: key,
      payloadHash: hash,
      expectedVersion: input.expectedVersion,
      version: input.expectedVersion + 1,
      configurationHash: await shippingCalendarConfigurationHash(input.configuration),
      recordedAt
    }
  const guard = crypto.randomUUID(),
    payload = canonicalJson(input),
    response = canonicalJson(receipt)
  try {
    await db.batch([
      db
        .prepare(
          `${authority} INSERT INTO shipping_calendar_commands(actor_id,command_id,expected_version,result_version,input_json,payload_hash,receipt_json,recorded_at)
       SELECT id,?2,?3,?4,?5,?6,?7,?8 FROM authority WHERE ?3=COALESCE((SELECT version FROM shipping_calendar_heads WHERE id=1),0)
       AND NOT EXISTS(SELECT 1 FROM shipping_calendar_commands WHERE actor_id=id AND command_id=?2)`
        )
        .bind(
          args(claims, options.now === undefined ? null : fresh()),
          key,
          input.expectedVersion,
          receipt.version,
          payload,
          hash,
          response,
          recordedAt
        ),
      db
        .prepare(
          `${authority} INSERT INTO shipping_calendar_guards(id,valid) SELECT ?2,CASE WHEN EXISTS(SELECT 1 FROM authority)
       AND EXISTS(SELECT 1 FROM shipping_calendar_commands WHERE actor_id=json_extract(?1,'$.identityId') AND command_id=?3 AND payload_hash=?4 AND receipt_json=?5)
       THEN 1 ELSE 0 END`
        )
        .bind(args(claims, options.now === undefined ? null : fresh()), guard, key, hash, response),
      db.prepare('DELETE FROM shipping_calendar_guards WHERE id=?1').bind(guard)
    ])
  } catch {
    await finalAuthority(db, claims, fresh)
    const replay = await command(db, claims, key, hash)
    if (replay) {
      await finalAuthority(db, claims, fresh)
      return replay
    }
    if ((await readD1ShippingCalendarConfiguration(db)).version !== input.expectedVersion) {
      await finalAuthority(db, claims, fresh)
      fail('version_conflict')
    }
    fail('service_unavailable')
  }
  const committed = await command(db, claims, key, hash)
  if (!committed) fail('history_unconfirmed')
  await finalAuthority(db, claims, fresh)
  return committed
}
