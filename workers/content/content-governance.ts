import { z } from 'zod'
import {
  buildTrustJsonLd,
  contentGovernanceCommandSchema,
  evaluateTrust,
  parseAssetPayload,
  reviewBucket,
  claimSchema,
  sourceSchema,
  type AssetKind,
  type ContentGovernanceCommand,
  type GovernanceClaim,
  type GovernanceSource
} from '../../shared/content-governance'
import { authorizeD1Session, type VerifiedSessionClaims } from '../catalog/authorization'
import { cmsPublishedValiditySql } from '../cms/publication-gate'

/**
 * SEO-029/030/031. Every identity, timestamp and credential comes from the server session / admin input;
 * the HTTP body can never carry actor, signature time or publication time (strict schemas).
 */
export class ContentGovernanceError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}
const fail = (code: string): never => {
  throw new ContentGovernanceError(code)
}
const DAY = 86_400_000
const WRITE = 'catalog.write'
const SIGN = 'catalog.publish'
const keyValid = (key: string) => /^[A-Za-z0-9._:-]{1,200}$/.test(key)
const nowInstant = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
function instant(value?: string) {
  if (value === undefined) return nowInstant()
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString().replace(/\.\d{3}Z$/, 'Z') !== value)
    fail('invalid_input')
  return value
}
const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / DAY)

async function authorize(database: D1Database, claims: VerifiedSessionClaims, permission: string, now: string) {
  const result = await authorizeD1Session(database, claims, permission, { requireMfa: true, now })
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

interface AuthorRow {
  id: string
  display_name: string
  bio: string
  experience: string
  credentials: string | null
  status: 'active' | 'archived'
  version: number
  created_at: string
  updated_at: string
}
interface GovernanceRow {
  slug: string
  owner_name: string
  sensitivity: 'regulation' | 'product' | 'general'
  next_review_at: string
  author_id: string | null
  reviewer_id: string | null
  sources: string
  claims: string
  retire_at: string | null
  redirect_to: string | null
  last_saved_by: string
  signed_off_at: string | null
  signed_off_by: string | null
  version: number
  created_at: string
  updated_at: string
}
interface AssetRow {
  slug: string
  kind: AssetKind
  title: string
  summary: string
  methodology: string
  data_as_of: string
  payload: string
  status: 'draft' | 'published' | 'retired'
  published_at: string | null
  retired_at: string | null
  version: number
  created_at: string
  updated_at: string
}
const toAuthor = (row: AuthorRow) => ({
  id: row.id,
  displayName: row.display_name,
  bio: row.bio,
  experience: row.experience,
  credentials: row.credentials,
  status: row.status,
  version: row.version,
  createdAt: row.created_at,
  updatedAt: row.updated_at
})
const sourcesOf = (row: GovernanceRow) => z.array(sourceSchema).parse(JSON.parse(row.sources))
const claimsOf = (row: GovernanceRow) => z.array(claimSchema).parse(JSON.parse(row.claims))
function toGovernance(row: GovernanceRow, people: Map<string, AuthorRow>, now: string) {
  const author = row.author_id ? people.get(row.author_id) : undefined,
    reviewer = row.reviewer_id ? people.get(row.reviewer_id) : undefined
  const sources = sourcesOf(row),
    claims = claimsOf(row)
  return {
    slug: row.slug,
    ownerName: row.owner_name,
    sensitivity: row.sensitivity,
    nextReviewAt: row.next_review_at,
    bucket: reviewBucket(row.next_review_at, now),
    authorId: row.author_id,
    reviewerId: row.reviewer_id,
    sources,
    claims,
    retirement: row.retire_at ? { retireAt: row.retire_at, redirectTo: row.redirect_to } : null,
    signedOffAt: row.signed_off_at,
    signedOffBy: row.signed_off_by,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    trust: evaluateTrust(
      {
        ownerName: row.owner_name,
        sensitivity: row.sensitivity,
        nextReviewAt: row.next_review_at,
        hasAuthor: row.author_id !== null,
        hasReviewer: row.reviewer_id !== null,
        authorStatus: author?.status ?? null,
        reviewerStatus: reviewer?.status ?? null,
        signedOffAt: row.signed_off_at,
        sourceCount: sources.length,
        claims
      },
      now
    )
  }
}
const toAsset = (row: AssetRow) => ({
  slug: row.slug,
  kind: row.kind,
  title: row.title,
  summary: row.summary,
  methodology: row.methodology,
  dataAsOf: row.data_as_of,
  payload: JSON.parse(row.payload) as Record<string, unknown>,
  status: row.status,
  publishedAt: row.published_at,
  retiredAt: row.retired_at,
  version: row.version,
  createdAt: row.created_at,
  updatedAt: row.updated_at
})

async function loadPeople(database: D1Database, ids: Array<string | null>) {
  const wanted = Array.from(new Set(ids.filter((id): id is string => !!id)))
  const map = new Map<string, AuthorRow>()
  if (!wanted.length) return map
  const rows = await database
    .prepare('SELECT * FROM content_authors WHERE id IN(SELECT value FROM json_each(?1))')
    .bind(JSON.stringify(wanted))
    .all<AuthorRow>()
  for (const row of rows.results ?? []) map.set(row.id, row)
  return map
}

export async function readContentGovernanceOverview(database: D1Database, claims: VerifiedSessionClaims, at?: string) {
  const now = instant(at)
  await authorize(database, claims, WRITE, now)
  const [authors, governance, assets, unmanaged] = await database.batch<Record<string, unknown>>([
    database.prepare('SELECT * FROM content_authors ORDER BY display_name,id LIMIT 200'),
    database.prepare('SELECT * FROM content_governance ORDER BY next_review_at,slug LIMIT 500'),
    database.prepare('SELECT * FROM content_assets ORDER BY slug LIMIT 200'),
    database.prepare(
      `SELECT slug FROM (
         SELECT p.slug FROM content_pages p JOIN content_versions v ON v.id=p.draft_version_id
          WHERE json_type(v.document,'$.resourceHub')='object'
         UNION
         SELECT r.slug FROM content_publications r JOIN content_versions v ON v.id=r.version_id
          WHERE json_type(v.document,'$.resourceHub')='object')
       WHERE slug NOT IN(SELECT slug FROM content_governance) ORDER BY slug LIMIT 200`
    )
  ])
  const authorRows = (authors!.results ?? []) as unknown as AuthorRow[]
  const people = new Map(authorRows.map((row) => [row.id, row]))
  return {
    source: 'cloudflare' as const,
    now,
    authors: authorRows.map(toAuthor),
    governance: ((governance!.results ?? []) as unknown as GovernanceRow[]).map((row) =>
      toGovernance(row, people, now)
    ),
    assets: ((assets!.results ?? []) as unknown as AssetRow[]).map(toAsset),
    unmanagedResources: ((unmanaged!.results ?? []) as Array<{ slug: string }>).map((row) => row.slug)
  }
}

type Entity = 'author' | 'governance' | 'asset'
export interface GovernanceResult {
  entity: Entity
  item: Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
}

export async function executeContentGovernanceCommand(
  database: D1Database,
  claims: VerifiedSessionClaims,
  input: unknown,
  options: { idempotencyKey: string; now?: string }
): Promise<GovernanceResult> {
  const parsed = contentGovernanceCommandSchema.safeParse(input)
  if (!parsed.success || !keyValid(options.idempotencyKey)) return fail('invalid_input')
  const command = parsed.data,
    now = instant(options.now),
    today = now.slice(0, 10)
  await authorize(database, claims, command.action === 'sign_off' ? SIGN : WRITE, now)
  const payloadHash = await sha256(canonical(command))
  const prior = await database
    .prepare('SELECT payload_hash,response FROM content_governance_events WHERE actor_id=?1 AND idempotency_key=?2')
    .bind(claims.identityId, options.idempotencyKey)
    .first<{ payload_hash: string; response: string }>()
  if (prior) {
    if (prior.payload_hash !== payloadHash) fail('idempotency_conflict')
    return JSON.parse(prior.response) as GovernanceResult
  }
  const eventSql = `INSERT INTO content_governance_events(id,entity,entity_key,actor_id,idempotency_key,payload_hash,action,version,response,created_at)
    VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)`
  const event = (entity: Entity, key: string, version: number, result: GovernanceResult) =>
    database
      .prepare(eventSql)
      .bind(
        crypto.randomUUID(),
        entity,
        key,
        claims.identityId,
        options.idempotencyKey,
        payloadHash,
        command.action,
        version,
        JSON.stringify(result),
        now
      )
  const commit = async (statements: D1PreparedStatement[], result: GovernanceResult) => {
    // Live authorization is checked again right before the atomic batch (revocation between read and write).
    await authorize(database, claims, command.action === 'sign_off' ? SIGN : WRITE, now)
    try {
      await database.batch(statements)
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      if (message.includes('UNIQUE')) fail('version_conflict')
      if (message.includes('CHECK constraint') || message.includes('FOREIGN KEY')) fail('invalid_state')
      throw error
    }
    return result
  }

  switch (command.action) {
    case 'save_author':
      return saveAuthor(database, command, now, event, commit)
    case 'save_governance':
      return saveGovernance(database, claims, command, now, today, event, commit)
    case 'sign_off':
      return signOff(database, claims, command, now, event, commit)
    case 'save_asset':
      return saveAsset(database, command, now, today, event, commit)
    case 'publish_asset':
    case 'retire_asset':
      return transitionAsset(database, command, now, event, commit)
  }
}

type EventFactory = (entity: Entity, key: string, version: number, result: GovernanceResult) => D1PreparedStatement
type Commit = (statements: D1PreparedStatement[], result: GovernanceResult) => Promise<GovernanceResult>

async function saveAuthor(
  database: D1Database,
  command: Extract<ContentGovernanceCommand, { action: 'save_author' }>,
  now: string,
  event: EventFactory,
  commit: Commit
) {
  if (command.id === undefined) {
    if (command.expectedVersion !== 0) return fail('invalid_input')
    const row: AuthorRow = {
      id: crypto.randomUUID(),
      display_name: command.displayName,
      bio: command.bio,
      experience: command.experience,
      credentials: command.credentials ?? null,
      status: command.status,
      version: 1,
      created_at: now,
      updated_at: now
    }
    const result = { entity: 'author' as const, item: toAuthor(row) }
    return commit(
      [
        database
          .prepare(
            `INSERT INTO content_authors(id,display_name,bio,experience,credentials,status,version,created_at,updated_at)
             VALUES(?1,?2,?3,?4,?5,?6,1,?7,?7)`
          )
          .bind(row.id, row.display_name, row.bio, row.experience, row.credentials, row.status, now),
        event('author', row.id, 1, result)
      ],
      result
    )
  }
  if (command.expectedVersion < 1) return fail('invalid_input')
  const current = await database
    .prepare('SELECT * FROM content_authors WHERE id=?1')
    .bind(command.id)
    .first<AuthorRow>()
  if (!current) return fail('not_found')
  if (current.version !== command.expectedVersion) fail('version_conflict')
  const next: AuthorRow = {
    ...current,
    display_name: command.displayName,
    bio: command.bio,
    experience: command.experience,
    credentials: command.credentials ?? null,
    status: command.status,
    version: current.version + 1,
    updated_at: now > current.created_at ? now : current.created_at
  }
  const result = { entity: 'author' as const, item: toAuthor(next) }
  return commit(
    [
      event('author', next.id, next.version, result),
      database
        .prepare(
          `UPDATE content_authors SET display_name=?1,bio=?2,experience=?3,credentials=?4,status=?5,version=?6,updated_at=?7
           WHERE id=?8 AND version=?9`
        )
        .bind(
          next.display_name,
          next.bio,
          next.experience,
          next.credentials,
          next.status,
          next.version,
          next.updated_at,
          next.id,
          current.version
        )
    ],
    result
  )
}

async function saveGovernance(
  database: D1Database,
  claims: VerifiedSessionClaims,
  command: Extract<ContentGovernanceCommand, { action: 'save_governance' }>,
  now: string,
  today: string,
  event: EventFactory,
  commit: Commit
) {
  const horizon = command.sensitivity === 'general' ? 730 : 365
  const ahead = daysBetween(today, command.nextReviewAt)
  if (ahead < 1 || ahead > horizon) fail('date_out_of_range')
  if (command.retirement && command.retirement.retireAt <= today) fail('date_out_of_range')
  const page = await database.prepare('SELECT 1 x FROM content_pages WHERE slug=?1').bind(command.slug).first()
  if (!page) fail('unknown_page')
  const people = await loadPeople(database, [command.authorId, command.reviewerId])
  for (const id of [command.authorId, command.reviewerId]) {
    if (!id) continue
    const person = people.get(id)
    if (!person) fail('unknown_person')
    if (person?.status === 'archived') fail('person_archived')
  }
  const current = await database
    .prepare('SELECT * FROM content_governance WHERE slug=?1')
    .bind(command.slug)
    .first<GovernanceRow>()
  if ((current?.version ?? 0) !== command.expectedVersion) fail('version_conflict')
  const row: GovernanceRow = {
    slug: command.slug,
    owner_name: command.ownerName,
    sensitivity: command.sensitivity,
    next_review_at: command.nextReviewAt,
    author_id: command.authorId,
    reviewer_id: command.reviewerId,
    sources: JSON.stringify(command.sources),
    claims: JSON.stringify(command.claims),
    retire_at: command.retirement?.retireAt ?? null,
    redirect_to: command.retirement?.redirectTo ?? null,
    last_saved_by: claims.identityId,
    // Any content-plan edit invalidates a previous technical sign-off.
    signed_off_at: null,
    signed_off_by: null,
    version: (current?.version ?? 0) + 1,
    created_at: current?.created_at ?? now,
    updated_at: now
  }
  const result = { entity: 'governance' as const, item: toGovernance(row, people, now) }
  const write = current
    ? database
        .prepare(
          `UPDATE content_governance SET owner_name=?1,sensitivity=?2,next_review_at=?3,author_id=?4,reviewer_id=?5,sources=?6,
             claims=?7,retire_at=?8,redirect_to=?9,last_saved_by=?10,signed_off_at=NULL,signed_off_by=NULL,version=?11,updated_at=?12
           WHERE slug=?13 AND version=?14`
        )
        .bind(
          row.owner_name,
          row.sensitivity,
          row.next_review_at,
          row.author_id,
          row.reviewer_id,
          row.sources,
          row.claims,
          row.retire_at,
          row.redirect_to,
          row.last_saved_by,
          row.version,
          now,
          row.slug,
          current.version
        )
    : database
        .prepare(
          `INSERT INTO content_governance(slug,owner_name,sensitivity,next_review_at,author_id,reviewer_id,sources,claims,retire_at,redirect_to,last_saved_by,version,created_at,updated_at)
           VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,1,?12,?12)`
        )
        .bind(
          row.slug,
          row.owner_name,
          row.sensitivity,
          row.next_review_at,
          row.author_id,
          row.reviewer_id,
          row.sources,
          row.claims,
          row.retire_at,
          row.redirect_to,
          row.last_saved_by,
          now
        )
  return commit([event('governance', row.slug, row.version, result), write], result)
}

async function signOff(
  database: D1Database,
  claims: VerifiedSessionClaims,
  command: Extract<ContentGovernanceCommand, { action: 'sign_off' }>,
  now: string,
  event: EventFactory,
  commit: Commit
) {
  const current = await database
    .prepare('SELECT * FROM content_governance WHERE slug=?1')
    .bind(command.slug)
    .first<GovernanceRow>()
  if (!current) return fail('not_found')
  if (current.version !== command.expectedVersion) fail('version_conflict')
  // Separation of duties: the person who last edited the plan cannot approve it.
  if (current.last_saved_by === claims.identityId) fail('same_actor')
  const people = await loadPeople(database, [current.author_id, current.reviewer_id])
  const pending = toGovernance(current, people, now).trust.issues.filter((issue) => issue !== 'not_signed_off')
  if (pending.length) fail('incomplete_trust')
  const row: GovernanceRow = {
    ...current,
    signed_off_at: now,
    signed_off_by: claims.identityId,
    version: current.version + 1,
    updated_at: now
  }
  const result = { entity: 'governance' as const, item: toGovernance(row, people, now) }
  return commit(
    [
      event('governance', row.slug, row.version, result),
      database
        .prepare(
          `UPDATE content_governance SET signed_off_at=?1,signed_off_by=?2,version=?3,updated_at=?1 WHERE slug=?4 AND version=?5`
        )
        .bind(now, claims.identityId, row.version, row.slug, current.version)
    ],
    result
  )
}

async function saveAsset(
  database: D1Database,
  command: Extract<ContentGovernanceCommand, { action: 'save_asset' }>,
  now: string,
  today: string,
  event: EventFactory,
  commit: Commit
) {
  if (command.dataAsOf > today) fail('date_out_of_range')
  const payload = parseAssetPayload(command.kind, command.payload)
  if (!payload) return fail('invalid_input')
  const current = await database
    .prepare('SELECT * FROM content_assets WHERE slug=?1')
    .bind(command.slug)
    .first<AssetRow>()
  if ((current?.version ?? 0) !== command.expectedVersion) fail('version_conflict')
  if (current?.status === 'retired') fail('invalid_state')
  const row: AssetRow = {
    slug: command.slug,
    kind: command.kind,
    title: command.title,
    summary: command.summary,
    methodology: command.methodology,
    data_as_of: command.dataAsOf,
    payload: JSON.stringify(payload),
    // An edit always returns the asset to draft: changed data must be republished deliberately.
    status: 'draft',
    published_at: null,
    retired_at: null,
    version: (current?.version ?? 0) + 1,
    created_at: current?.created_at ?? now,
    updated_at: now
  }
  const result = { entity: 'asset' as const, item: toAsset(row) }
  const write = current
    ? database
        .prepare(
          `UPDATE content_assets SET kind=?1,title=?2,summary=?3,methodology=?4,data_as_of=?5,payload=?6,status='draft',
             published_at=NULL,version=?7,updated_at=?8 WHERE slug=?9 AND version=?10`
        )
        .bind(
          row.kind,
          row.title,
          row.summary,
          row.methodology,
          row.data_as_of,
          row.payload,
          row.version,
          now,
          row.slug,
          current.version
        )
    : database
        .prepare(
          `INSERT INTO content_assets(slug,kind,title,summary,methodology,data_as_of,payload,status,version,created_at,updated_at)
           VALUES(?1,?2,?3,?4,?5,?6,?7,'draft',1,?8,?8)`
        )
        .bind(row.slug, row.kind, row.title, row.summary, row.methodology, row.data_as_of, row.payload, now)
  return commit([event('asset', row.slug, row.version, result), write], result)
}

async function transitionAsset(
  database: D1Database,
  command: Extract<ContentGovernanceCommand, { action: 'publish_asset' | 'retire_asset' }>,
  now: string,
  event: EventFactory,
  commit: Commit
) {
  const current = await database
    .prepare('SELECT * FROM content_assets WHERE slug=?1')
    .bind(command.slug)
    .first<AssetRow>()
  if (!current) return fail('not_found')
  if (current.version !== command.expectedVersion) fail('version_conflict')
  const publishing = command.action === 'publish_asset'
  if (publishing ? current.status !== 'draft' : current.status === 'retired') fail('invalid_state')
  const row: AssetRow = publishing
    ? { ...current, status: 'published', published_at: now, version: current.version + 1, updated_at: now }
    : { ...current, status: 'retired', retired_at: now, version: current.version + 1, updated_at: now }
  const result = { entity: 'asset' as const, item: toAsset(row) }
  return commit(
    [
      event('asset', row.slug, row.version, result),
      database
        .prepare(
          `UPDATE content_assets SET status=?1,published_at=?2,retired_at=?3,version=?4,updated_at=?5 WHERE slug=?6 AND version=?7`
        )
        .bind(row.status, row.published_at, row.retired_at, row.version, now, row.slug, current.version)
    ],
    result
  )
}

/* ---------------- public reads (no authentication, only verified / published data) ---------------- */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export async function readPublicTrust(database: D1Database, slug: string, options: { origin: string; now?: string }) {
  if (!SLUG.test(slug) || slug.length > 160) return fail('not_found')
  const now = instant(options.now),
    today = now.slice(0, 10)
  const row = await database.prepare('SELECT * FROM content_governance WHERE slug=?1').bind(slug).first<GovernanceRow>()
  if (!row) return fail('not_found')
  if (row.retire_at && row.retire_at <= today) return { status: 'retired' as const, slug, redirectTo: row.redirect_to }
  const published = await database
    .prepare(
      `SELECT json_extract(v.document,'$.title') title FROM content_publications r
         JOIN content_publication_states h ON h.page_id=r.page_id
         JOIN content_versions v ON v.id=r.version_id AND v.page_id=r.page_id
        WHERE r.slug=?1 AND ${cmsPublishedValiditySql('r', 'h', '?2')}`
    )
    .bind(slug, now)
    .first<{ title: string }>()
  if (!published) return fail('not_found')
  const people = await loadPeople(database, [row.author_id, row.reviewer_id])
  const item = toGovernance(row, people, now)
  if (item.trust.state !== 'verified' || !row.signed_off_at) return fail('not_found')
  const author = people.get(row.author_id!)!,
    reviewer = people.get(row.reviewer_id!)!
  const profile = (value: AuthorRow) => ({
    name: value.display_name,
    bio: value.bio,
    experience: value.experience,
    credentials: value.credentials
  })
  const sources: GovernanceSource[] = item.sources
  const claimsOut = item.claims.map((claim: GovernanceClaim) => ({
    text: claim.text,
    category: claim.category,
    evidence: sources[claim.sourceIndex!]!
  }))
  return {
    status: 'active' as const,
    slug,
    author: profile(author),
    reviewer: profile(reviewer),
    sources,
    claims: claimsOut,
    lastReviewedAt: row.signed_off_at,
    nextReviewAt: row.next_review_at,
    jsonLd: buildTrustJsonLd({
      url: `${options.origin}/recursos/${slug}`,
      headline: String(published.title ?? slug),
      dateModified: row.signed_off_at,
      author: profile(author),
      reviewer: profile(reviewer),
      sources
    })
  }
}

export async function listPublicAssets(database: D1Database) {
  const rows = await database
    .prepare(
      `SELECT slug,kind,title,summary,data_as_of,published_at FROM content_assets WHERE status='published'
       ORDER BY kind,slug LIMIT 200`
    )
    .all<{ slug: string; kind: string; title: string; summary: string; data_as_of: string; published_at: string }>()
  return {
    items: (rows.results ?? []).map((row) => ({
      slug: row.slug,
      kind: row.kind,
      title: row.title,
      summary: row.summary,
      dataAsOf: row.data_as_of,
      publishedAt: row.published_at
    }))
  }
}

export async function readPublicAsset(database: D1Database, slug: string) {
  if (!SLUG.test(slug) || slug.length > 160) return fail('not_found')
  const row = await database
    .prepare("SELECT * FROM content_assets WHERE slug=?1 AND status='published'")
    .bind(slug)
    .first<AssetRow>()
  if (!row) return fail('not_found')
  const { slug: s, kind, title, summary, methodology, dataAsOf, payload, publishedAt } = toAsset(row)
  return { slug: s, kind, title, summary, methodology, dataAsOf, publishedAt: publishedAt!, payload }
}
