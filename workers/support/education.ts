import { z } from 'zod'
import { questionsSimilar, tokenizeQuestion } from '../../shared/support-faq-assistant'
import {
  computeDeflection,
  educationCommandSchema,
  educationDetectInputSchema,
  educationNextStatus,
  type DeflectionTurn,
  type EducationStatus
} from '../../shared/support-insights'
import { cmsNow, type CmsPublicationDependencies } from '../cms/publication-gate'
import { sha256Hex } from '../catalog/inventory'
import type { VerifiedSessionClaims } from '../catalog/authorization'
import { supportKnowledgeEligibleSql } from './knowledge'
import {
  guardedCommand,
  insightFail,
  insightHash,
  insightNow,
  plainCommand,
  replayedCommand,
  requireSupportAdmin,
  runGuardedBatch,
  uuidKey
} from './insight-commands'

const TURN_SCAN_LIMIT = 5000
export interface EducationReceipt {
  candidateId: string
  status: EducationStatus
  version: number
}
export interface EducationDetectReceipt {
  runId: string
  created: number
  updated: number
  scannedTurns: number
}

export async function detectEducationCandidates(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  rawInput: unknown,
  idempotencyKey: string,
  now: string
): Promise<EducationDetectReceipt> {
  const admin = await requireSupportAdmin(db, claims, now)
  const parsed = educationDetectInputSchema.safeParse(rawInput)
  if (!parsed.success) return insightFail('invalid_input')
  const input = parsed.data
  const key = uuidKey(idempotencyKey)
  const payloadHash = await insightHash('education_detect', input)
  const replay = await replayedCommand<EducationDetectReceipt>(db, admin.identityId, key, payloadHash)
  if (replay) return replay

  const turns = (
    await db
      .prepare(
        `SELECT t.question,t.created_at FROM support_faq_turns t
         WHERE t.created_at>=?1 AND t.created_at<?2
           AND (t.outcome<>'answered' OR EXISTS(SELECT 1 FROM support_faq_handoffs h WHERE h.turn_id=t.id))
         ORDER BY t.created_at,t.id LIMIT ?3`
      )
      .bind(input.from + 'T00:00:00Z', input.to + 'T00:00:00Z', TURN_SCAN_LIMIT + 1)
      .all<{ question: string; created_at: string }>()
  ).results
  if (turns.length > TURN_SCAN_LIMIT) return insightFail('window_too_large')
  const existing = (
    await db
      .prepare('SELECT id,rep_tokens,first_seen_at FROM support_education_candidates')
      .all<{ id: string; rep_tokens: string; first_seen_at: string }>()
  ).results
  interface Cluster {
    id: string | null
    rep: string[]
    count: number
    first: string
    last: string
    sample: string
    firstSeen: string | null
  }
  const clusters: Cluster[] = existing.map((row) => ({
    id: row.id,
    rep: JSON.parse(row.rep_tokens) as string[],
    count: 0,
    first: '',
    last: '',
    sample: '',
    firstSeen: row.first_seen_at
  }))
  for (const turn of turns) {
    const tokens = tokenizeQuestion(turn.question)
    if (tokens.length === 0) continue
    let cluster = clusters.find((candidate) => questionsSimilar(tokens, candidate.rep))
    if (!cluster) {
      cluster = {
        id: null,
        rep: tokens.slice(0, 30),
        count: 0,
        first: turn.created_at,
        last: turn.created_at,
        sample: turn.question,
        firstSeen: null
      }
      clusters.push(cluster)
    }
    if (cluster.count === 0) {
      cluster.first = turn.created_at
      cluster.sample = turn.question
    }
    cluster.count++
    cluster.last = turn.created_at
  }
  const runId = crypto.randomUUID()
  const statements: D1PreparedStatement[] = []
  let created = 0,
    updated = 0
  for (const cluster of clusters) {
    if (cluster.id !== null && cluster.count > 0) {
      updated++
      statements.push(
        db
          .prepare(
            `UPDATE support_education_candidates SET occurrences=?1,last_seen_at=max(last_seen_at,?2),first_seen_at=min(first_seen_at,?3),updated_at=?4 WHERE id=?5`
          )
          .bind(cluster.count, cluster.last, cluster.first, now, cluster.id)
      )
    } else if (cluster.id === null && cluster.count >= input.minOccurrences) {
      created++
      statements.push(
        db
          .prepare(
            `INSERT INTO support_education_candidates(id,cluster_key,sample_question,rep_tokens,occurrences,first_seen_at,last_seen_at,status,version,created_at,updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,'detected',1,?8,?8)`
          )
          .bind(
            crypto.randomUUID(),
            await sha256Hex(cluster.rep.join(' ')),
            cluster.sample,
            JSON.stringify(cluster.rep),
            cluster.count,
            cluster.first,
            cluster.last,
            now
          )
      )
    }
  }
  const receipt: EducationDetectReceipt = { runId, created, updated, scannedTurns: turns.length }
  const commandId = crypto.randomUUID()
  try {
    await db.batch([
      plainCommand(db, {
        id: commandId,
        scope: 'education',
        actorId: admin.identityId,
        key,
        payloadHash,
        subjectId: runId,
        receipt,
        now
      }),
      ...statements
    ])
  } catch {
    const raced = await replayedCommand<EducationDetectReceipt>(db, admin.identityId, key, payloadHash)
    if (raced) return raced
    return insightFail('service_unavailable')
  }
  return receipt
}

const listSchema = z
  .object({
    status: z.enum(['detected', 'in_review', 'approved', 'published', 'rejected']).optional(),
    limit: z.number().int().min(1).max(100).default(50)
  })
  .strict()
export async function listEducationCandidates(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  query: { status?: string; limit?: number },
  now: string
) {
  await requireSupportAdmin(db, claims, now)
  const parsed = listSchema.safeParse(query)
  if (!parsed.success) return insightFail('invalid_input')
  const rows = await db
    .prepare(
      `SELECT id,sample_question,occurrences,first_seen_at,last_seen_at,status,target_kind,target_page_id,target_product_slug,review_notes,safety_reviewed,published_at,version
       FROM support_education_candidates WHERE (?1 IS NULL OR status=?1) ORDER BY occurrences DESC,id LIMIT ?2`
    )
    .bind(parsed.data.status ?? null, parsed.data.limit)
    .all<Record<string, string | number | null>>()
  return {
    items: rows.results.map((row) => ({
      id: row.id as string,
      sampleQuestion: row.sample_question as string,
      occurrences: row.occurrences as number,
      firstSeenAt: row.first_seen_at as string,
      lastSeenAt: row.last_seen_at as string,
      status: row.status as EducationStatus,
      targetKind: row.target_kind as string | null,
      targetPageId: row.target_page_id as string | null,
      targetProductSlug: row.target_product_slug as string | null,
      reviewNotes: row.review_notes as string | null,
      safetyReviewed: row.safety_reviewed === 1,
      publishedAt: row.published_at as string | null,
      version: row.version as number
    }))
  }
}

export async function commandEducationCandidate(
  deps: Pick<CmsPublicationDependencies, 'database' | 'now'> & { enabled?: boolean },
  claims: VerifiedSessionClaims | null,
  candidateId: string,
  rawCommand: unknown,
  idempotencyKey: string
): Promise<EducationReceipt> {
  const db = deps.database
  const now = insightNow(deps.now)
  const admin = await requireSupportAdmin(db, claims, now)
  const parsed = educationCommandSchema.safeParse(rawCommand)
  if (!parsed.success || !z.string().uuid().safeParse(candidateId).success) return insightFail('invalid_input')
  const command = parsed.data
  const key = uuidKey(idempotencyKey)
  const payloadHash = await insightHash('education', { candidateId, command })
  const replay = await replayedCommand<EducationReceipt>(db, admin.identityId, key, payloadHash)
  if (replay) return replay
  const row = await db
    .prepare('SELECT status,version,target_kind FROM support_education_candidates WHERE id=?1')
    .bind(candidateId)
    .first<{ status: EducationStatus; version: number; target_kind: string | null }>()
  if (!row) return insightFail('not_found')
  if (row.version !== command.expectedVersion) return insightFail('concurrency_conflict')
  const next = educationNextStatus(row.status, command.action)
  if (!next) return insightFail('invalid_transition')

  let set = 'status=?2,reviewer_id=?3,version=version+1,updated_at=?4'
  const extra: unknown[] = []
  if (command.action === 'approve') {
    set += ',review_notes=?8,target_kind=?9,safety_reviewed=1,reviewed_at=?4'
    extra.push(command.reviewNotes, command.targetKind)
  } else if (command.action === 'reject') {
    set += ',review_notes=?8,reviewed_at=?4'
    extra.push(command.reviewNotes)
  } else if (command.action === 'publish') {
    set = 'status=?2,version=version+1,updated_at=?4' // the approving expert stays the recorded reviewer
    const live = command.targetPageId
      ? await db
          .prepare(`SELECT 1 ok FROM (${supportKnowledgeEligibleSql('?1')}) WHERE page_id=?2`)
          .bind(cmsNow({ now: () => now }), command.targetPageId)
          .first()
      : await db
          .prepare("SELECT 1 ok FROM products WHERE slug=?1 AND status='published'")
          .bind(command.targetProductSlug)
          .first()
    if (!live) return insightFail('target_unavailable')
    if ((row.target_kind === 'pdp') !== (command.targetProductSlug !== undefined)) return insightFail('invalid_input')
    set += ',target_page_id=?8,target_product_slug=?9,published_at=?4'
    extra.push(command.targetPageId ?? null, command.targetProductSlug ?? null)
  }
  const placeholders = command.action === 'start_review' ? [] : extra
  const commandId = crypto.randomUUID()
  const receipt: EducationReceipt = { candidateId, status: next, version: row.version + 1 }
  // ?5..?7 are fixed: id, expected version, expected status; ?8.. are action specific.
  const bound: unknown[] = [
    candidateId,
    next,
    admin.identityId,
    now,
    candidateId,
    command.expectedVersion,
    row.status,
    ...placeholders
  ]
  const statements = [
    db
      .prepare(`UPDATE support_education_candidates SET ${set} WHERE id=?5 AND version=?6 AND status=?7`)
      .bind(...bound),
    guardedCommand(db, {
      id: commandId,
      scope: 'education',
      actorId: admin.identityId,
      key,
      payloadHash,
      subjectId: candidateId,
      receipt,
      now
    }),
    db
      .prepare(
        `INSERT INTO support_education_events(id,candidate_id,actor_id,action,from_status,to_status,result_version,created_at)
         SELECT ?1,?2,?3,?4,?5,?6,?7,?8 WHERE EXISTS(SELECT 1 FROM support_insight_commands WHERE id=?9)`
      )
      .bind(
        crypto.randomUUID(),
        candidateId,
        admin.identityId,
        command.action,
        row.status,
        next,
        row.version + 1,
        now,
        commandId
      )
  ]
  return runGuardedBatch<EducationReceipt>(db, statements, {
    id: commandId,
    actorId: admin.identityId,
    key,
    payloadHash,
    receipt
  })
}

export async function measureEducationDeflection(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  candidateId: string,
  now: string,
  windowDays = 14
) {
  await requireSupportAdmin(db, claims, now)
  if (
    !z.string().uuid().safeParse(candidateId).success ||
    !Number.isInteger(windowDays) ||
    windowDays < 7 ||
    windowDays > 60
  )
    return insightFail('invalid_input')
  const candidate = await db
    .prepare('SELECT status,rep_tokens,published_at,target_kind FROM support_education_candidates WHERE id=?1')
    .bind(candidateId)
    .first<{ status: string; rep_tokens: string; published_at: string | null; target_kind: string | null }>()
  if (!candidate) return insightFail('not_found')
  if (candidate.status !== 'published' || !candidate.published_at) return insightFail('invalid_transition')
  const published = Date.parse(candidate.published_at),
    span = windowDays * 86_400_000
  const from = new Date(published - span).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const to = new Date(Math.min(Date.parse(now), published + span)).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const rows = (
    await db
      .prepare(
        `SELECT t.question,t.created_at,t.outcome,f.helpful,EXISTS(SELECT 1 FROM support_faq_handoffs h WHERE h.turn_id=t.id) handoff
         FROM support_faq_turns t LEFT JOIN support_faq_feedback f ON f.turn_id=t.id
         WHERE t.created_at>=?1 AND t.created_at<?2 ORDER BY t.created_at LIMIT ?3`
      )
      .bind(from, to > from ? to : from, TURN_SCAN_LIMIT + 1)
      .all<{ question: string; created_at: string; outcome: string; helpful: number | null; handoff: number }>()
  ).results
  if (rows.length > TURN_SCAN_LIMIT) return insightFail('window_too_large')
  const rep = JSON.parse(candidate.rep_tokens) as string[]
  const turns: DeflectionTurn[] = rows
    .filter((row) => questionsSimilar(tokenizeQuestion(row.question), rep))
    .map((row) => ({
      createdAt: row.created_at,
      escalated: row.outcome !== 'answered' || row.handoff === 1,
      helpful: row.helpful === null ? null : row.helpful === 1
    }))
  return {
    candidateId,
    publishedAt: candidate.published_at,
    ...computeDeflection({ publishedAt: candidate.published_at, now, windowDays, turns })
  }
}
