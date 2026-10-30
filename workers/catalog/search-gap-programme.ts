import {
  SEARCH_GAP_BASELINE_DAYS,
  searchGapBacklogQuerySchema,
  searchGapCaseSchema,
  searchGapCommandSchema,
  judgeSearchGap,
  type SearchGapCase,
  type SearchGapCommand,
  type SearchGapVerdict
} from '../../shared/search-gap-programme'
import { normalizeSynonymTerm } from '../../shared/search-synonyms'
import { cmsPublishedValiditySql } from '../cms/publication-gate'
import { authorizeD1Session, type VerifiedSessionClaims } from './authorization'

/**
 * SEO-025. Closed loop: first-party zero-result analytics -> governed case with measured baseline ->
 * one recorded action (synonym / content / assortment / redirect) that must reference a real, live object ->
 * measured outcome (zero-result rate before vs after) with an explicit "insufficient data" verdict.
 */
export class SearchGapError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}
const fail = (code: string): never => {
  throw new SearchGapError(code)
}
const DAY = 86_400_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const keyValid = (key: string) => /^[A-Za-z0-9._:-]{1,200}$/.test(key)

function instant(value?: string) {
  if (value === undefined) return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString().replace(/\.\d{3}Z$/, 'Z') !== value)
    fail('invalid_input')
  return value
}
const dayOf = (value: string, offsetDays = 0) =>
  new Date(Date.parse(value) + offsetDays * DAY).toISOString().slice(0, 10)

async function authorize(database: D1Database, claims: VerifiedSessionClaims, now: string) {
  const result = await authorizeD1Session(database, claims, 'catalog.write', { requireMfa: true, now })
  if (!result.allowed) fail(result.code)
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`
  return JSON.stringify(value)
}
async function sha256(value: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('')
}

interface CaseRow {
  id: string
  environment: 'local' | 'preview' | 'production'
  term_normalized: string
  status: 'open' | 'actioned' | 'dismissed'
  action_type: SearchGapCase['actionType']
  reference_id: string | null
  note: string | null
  baseline_from: string
  baseline_to: string
  baseline_searches: number
  baseline_zero_results: number
  actioned_at: string | null
  version: number
  created_at: string
  updated_at: string
}
const toCase = (row: CaseRow): SearchGapCase =>
  searchGapCaseSchema.parse({
    id: row.id,
    environment: row.environment,
    term: row.term_normalized,
    status: row.status,
    actionType: row.action_type,
    referenceId: row.reference_id,
    note: row.note,
    baseline: {
      from: row.baseline_from,
      to: row.baseline_to,
      searches: row.baseline_searches,
      zeroResults: row.baseline_zero_results
    },
    actionedAt: row.actioned_at,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  })
const rate = (zero: number, searches: number) => (searches > 0 ? Number((zero / searches).toFixed(4)) : 0)

async function windowTotals(
  database: D1Database,
  environment: string,
  term: string,
  from: string,
  to: string
): Promise<{ searches: number; zeroResults: number }> {
  const row = await database
    .prepare(
      `SELECT COALESCE(SUM(searches_count),0) s, COALESCE(SUM(zero_results_count),0) z FROM search_analytics_daily
       WHERE environment=?1 AND term_normalized=?2 AND day BETWEEN ?3 AND ?4`
    )
    .bind(environment, term, from, to)
    .first<{ s: number; z: number }>()
  return { searches: Number(row?.s ?? 0), zeroResults: Number(row?.z ?? 0) }
}

export async function listSearchGapBacklog(
  database: D1Database,
  claims: VerifiedSessionClaims,
  raw: unknown,
  at?: string
) {
  const parsed = searchGapBacklogQuerySchema.safeParse(raw ?? {})
  if (!parsed.success) return fail('invalid_input')
  const q = parsed.data,
    now = instant(at)
  await authorize(database, claims, now)
  const rows = await database
    .prepare(
      `SELECT d.term_normalized term, SUM(d.searches_count) s, SUM(d.zero_results_count) z,
        EXISTS(SELECT 1 FROM search_synonyms_current y WHERE y.source_normalized=d.term_normalized AND y.active=1) syn,
        EXISTS(SELECT 1 FROM search_merchandising_current m WHERE m.term_normalized=d.term_normalized AND m.kind='redirect'
          AND m.status='active' AND m.valid_from<=?5 AND m.valid_until>?5) red,
        (SELECT c.id FROM search_gap_cases c WHERE c.environment=?1 AND c.term_normalized=d.term_normalized AND c.status IN('open','actioned')) case_id,
        (SELECT c.status FROM search_gap_cases c WHERE c.environment=?1 AND c.term_normalized=d.term_normalized AND c.status IN('open','actioned')) case_status
       FROM search_analytics_daily d
       WHERE d.environment=?1 AND d.day BETWEEN ?2 AND ?3
       GROUP BY d.term_normalized
       HAVING SUM(d.searches_count)>=?4 AND SUM(d.zero_results_count)>0
       ORDER BY z DESC, s DESC, d.term_normalized ASC
       LIMIT ?6`
    )
    .bind(q.environment, dayOf(now, 1 - q.days), dayOf(now), q.minSearches, now, q.limit)
    .all<{
      term: string
      s: number
      z: number
      syn: number
      red: number
      case_id: string | null
      case_status: string | null
    }>()
  return {
    source: 'cloudflare' as const,
    environment: q.environment,
    window: { from: dayOf(now, 1 - q.days), to: dayOf(now) },
    items: (rows.results ?? []).map((row) => ({
      term: row.term,
      searches: Number(row.s),
      zeroResults: Number(row.z),
      zeroRate: rate(Number(row.z), Number(row.s)),
      coverage: { synonym: row.syn === 1, redirect: row.red === 1 },
      caseId: row.case_id,
      caseStatus: row.case_status,
      suggestion: row.syn === 1 || row.red === 1 ? ('measure_existing' as const) : ('triage' as const)
    }))
  }
}

export async function listSearchGapCases(
  database: D1Database,
  claims: VerifiedSessionClaims,
  raw: unknown,
  at?: string
) {
  const status = (raw as { status?: unknown } | null)?.status
  if (status !== undefined && !['open', 'actioned', 'dismissed'].includes(String(status))) fail('invalid_input')
  await authorize(database, claims, instant(at))
  const rows = await database
    .prepare(`SELECT * FROM search_gap_cases WHERE (?1 IS NULL OR status=?1) ORDER BY updated_at DESC, id LIMIT 100`)
    .bind(status ?? null)
    .all<CaseRow>()
  return { source: 'cloudflare' as const, items: (rows.results ?? []).map(toCase) }
}

async function verifyReference(
  database: D1Database,
  row: CaseRow,
  command: Extract<SearchGapCommand, { action: 'record_action' }>,
  now: string
) {
  const ref = command.referenceId
  let found: unknown = null
  switch (command.actionType) {
    case 'synonym':
      found = await database
        .prepare('SELECT 1 FROM search_synonyms_current WHERE synonym_id=?1 AND active=1 AND source_normalized=?2')
        .bind(ref, row.term_normalized)
        .first()
      break
    case 'redirect':
      found = await database
        .prepare(
          `SELECT 1 FROM search_merchandising_current WHERE rule_id=?1 AND kind='redirect' AND status='active'
           AND term_normalized=?2 AND valid_from<=?3 AND valid_until>?3`
        )
        .bind(ref, row.term_normalized, now)
        .first()
      break
    case 'content':
      found = await database
        .prepare(
          `SELECT 1 FROM content_publications r JOIN content_publication_states h ON h.page_id=r.page_id
           WHERE r.slug=?1 AND ${cmsPublishedValiditySql('r', 'h', '?2')}`
        )
        .bind(ref, now)
        .first()
      break
    case 'assortment':
      found = await database.prepare("SELECT 1 FROM products WHERE id=?1 AND status='published'").bind(ref).first()
      break
  }
  if (!found) fail('invalid_reference')
}

export async function executeSearchGapCommand(
  database: D1Database,
  claims: VerifiedSessionClaims,
  input: unknown,
  options: { idempotencyKey: string; now?: string }
): Promise<SearchGapCase> {
  const parsed = searchGapCommandSchema.safeParse(input)
  if (!parsed.success || !keyValid(options.idempotencyKey)) return fail('invalid_input')
  const command = parsed.data,
    now = instant(options.now)
  await authorize(database, claims, now)
  const payloadHash = await sha256(canonical(command))
  const prior = await database
    .prepare('SELECT payload_hash,response FROM search_gap_events WHERE actor_id=?1 AND idempotency_key=?2')
    .bind(claims.identityId, options.idempotencyKey)
    .first<{ payload_hash: string; response: string }>()
  if (prior) {
    if (prior.payload_hash !== payloadHash) fail('idempotency_conflict')
    return searchGapCaseSchema.parse(JSON.parse(prior.response))
  }
  const eventSql = `INSERT INTO search_gap_events(id,case_id,actor_id,idempotency_key,payload_hash,action,version,response,created_at)
    VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)`
  const run = async (statements: D1PreparedStatement[]) => {
    try {
      await database.batch(statements)
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      if (message.includes('search_gap_cases_live_term')) fail('duplicate_case')
      if (message.includes('search_gap_events') && message.includes('UNIQUE')) fail('version_conflict')
      throw error
    }
  }

  if (command.action === 'open') {
    const term = normalizeSynonymTerm(command.term)
    if (term.length < 2) fail('invalid_input')
    const live = await database
      .prepare(
        "SELECT 1 FROM search_gap_cases WHERE environment=?1 AND term_normalized=?2 AND status IN('open','actioned')"
      )
      .bind(command.environment, term)
      .first()
    if (live) fail('duplicate_case')
    const from = dayOf(now, 1 - SEARCH_GAP_BASELINE_DAYS),
      to = dayOf(now)
    const totals = await windowTotals(database, command.environment, term, from, to)
    if (totals.searches < 20 || totals.zeroResults === 0) fail('not_eligible')
    const id = crypto.randomUUID()
    const item = searchGapCaseSchema.parse({
      id,
      environment: command.environment,
      term,
      status: 'open',
      actionType: null,
      referenceId: null,
      note: null,
      baseline: { from, to, ...totals },
      actionedAt: null,
      version: 1,
      createdAt: now,
      updatedAt: now
    })
    await run([
      database
        .prepare(
          `INSERT INTO search_gap_cases(id,environment,term_normalized,status,baseline_from,baseline_to,baseline_searches,baseline_zero_results,version,created_at,updated_at)
           VALUES(?1,?2,?3,'open',?4,?5,?6,?7,1,?8,?8)`
        )
        .bind(id, command.environment, term, from, to, totals.searches, totals.zeroResults, now),
      database
        .prepare(eventSql)
        .bind(
          crypto.randomUUID(),
          id,
          claims.identityId,
          options.idempotencyKey,
          payloadHash,
          'open',
          1,
          JSON.stringify(item),
          now
        )
    ])
    return item
  }

  const row = await database.prepare('SELECT * FROM search_gap_cases WHERE id=?1').bind(command.id).first<CaseRow>()
  if (!row) return fail('not_found')
  if (row.version !== command.expectedVersion) fail('version_conflict')
  if (row.status !== 'open') fail('invalid_state')
  let next: CaseRow
  if (command.action === 'record_action') {
    await verifyReference(database, row, command, now)
    next = {
      ...row,
      status: 'actioned',
      action_type: command.actionType,
      reference_id: command.referenceId,
      note: command.note ?? row.note,
      actioned_at: now,
      version: row.version + 1,
      updated_at: now
    }
  } else {
    next = { ...row, status: 'dismissed', note: command.note, version: row.version + 1, updated_at: now }
  }
  const item = toCase(next)
  await run([
    database
      .prepare(
        `INSERT INTO search_gap_events(id,case_id,actor_id,idempotency_key,payload_hash,action,version,response,created_at)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)`
      )
      .bind(
        crypto.randomUUID(),
        row.id,
        claims.identityId,
        options.idempotencyKey,
        payloadHash,
        command.action,
        next.version,
        JSON.stringify(item),
        now
      ),
    database
      .prepare(
        `UPDATE search_gap_cases SET status=?1,action_type=?2,reference_id=?3,note=?4,actioned_at=?5,version=?6,updated_at=?7
         WHERE id=?8 AND version=?9`
      )
      .bind(
        next.status,
        next.action_type,
        next.reference_id,
        next.note,
        next.actioned_at,
        next.version,
        now,
        row.id,
        row.version
      )
  ])
  return item
}

export interface SearchGapMeasurement {
  caseId: string
  term: string
  verdict: SearchGapVerdict
  baseline: { from: string; to: string; searches: number; zeroResults: number; zeroRate: number }
  after: { from: string; to: string; days: number; searches: number; zeroResults: number; zeroRate: number }
}

export async function measureSearchGapCase(
  database: D1Database,
  claims: VerifiedSessionClaims,
  id: string,
  at?: string
): Promise<SearchGapMeasurement> {
  if (!UUID.test(id)) fail('invalid_input')
  const now = instant(at)
  await authorize(database, claims, now)
  const row = await database.prepare('SELECT * FROM search_gap_cases WHERE id=?1').bind(id).first<CaseRow>()
  if (!row) return fail('not_found')
  const to = dayOf(now),
    from = row.actioned_at ? dayOf(row.actioned_at, 1) : to
  const days = row.actioned_at ? Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / DAY) + 1) : 0
  const after = row.actioned_at
    ? await windowTotals(database, row.environment, row.term_normalized, from, to)
    : { searches: 0, zeroResults: 0 }
  return {
    caseId: row.id,
    term: row.term_normalized,
    verdict: judgeSearchGap({
      actioned: row.status === 'actioned',
      baselineSearches: row.baseline_searches,
      baselineZero: row.baseline_zero_results,
      afterSearches: after.searches,
      afterZero: after.zeroResults,
      afterDays: days
    }),
    baseline: {
      from: row.baseline_from,
      to: row.baseline_to,
      searches: row.baseline_searches,
      zeroResults: row.baseline_zero_results,
      zeroRate: rate(row.baseline_zero_results, row.baseline_searches)
    },
    after: { from, to, days, ...after, zeroRate: rate(after.zeroResults, after.searches) }
  }
}
