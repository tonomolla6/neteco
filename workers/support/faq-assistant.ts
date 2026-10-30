import { z } from 'zod'
import {
  assistantAskInputSchema,
  assistantFeedbackInputSchema,
  assistantHandoffInputSchema,
  assessRisk,
  CHEMICAL_NOTICE,
  EMERGENCY_NOTICE,
  redactQuestion,
  selectGroundedAnswer,
  type ApprovedArticle,
  type AssistantOutcome,
  type AssistantReason,
  type AssistantSource,
  type GroundedSelection
} from '../../shared/support-faq-assistant'
import { b2bSlaState, addHours, dayWindowSchema } from '../../shared/support-insights'
import { cmsNow, type CmsPublicationDependencies } from '../cms/publication-gate'
import { sha256Hex } from '../catalog/inventory'
import type { VerifiedSessionClaims } from '../catalog/authorization'
import { supportKnowledgeEligibleSql } from './knowledge'
import {
  guardedCommand,
  insightFail,
  insightHash,
  insightNow,
  replayedCommand,
  requireSupportAdmin,
  runGuardedBatch,
  uuidKey
} from './insight-commands'

export const FAQ_HANDOFF_SLA_HOURS = 24
export type FaqAssistantDependencies = Pick<CmsPublicationDependencies, 'database' | 'enabled' | 'now'>
export interface FaqAssistantReply {
  turnId: string
  outcome: AssistantOutcome
  reason: AssistantReason
  answer: string | null
  confidenceBp: number
  sources: AssistantSource[]
  notice: string | null
  handoff: { available: true; handoffId: string | null }
  createdAt: string
}

function passagesOf(document: Record<string, unknown>): string[] {
  const blocks = Array.isArray(document.blocks) ? (document.blocks as Array<Record<string, unknown>>) : []
  const out: string[] = []
  for (const block of blocks) {
    for (const field of ['title', 'text', 'label'] as const)
      if (typeof block[field] === 'string') out.push(block[field] as string)
    if (Array.isArray(block.items)) for (const item of block.items) if (typeof item === 'string') out.push(item)
  }
  return out
}
/** Approved = published CMS revision, explicit supportKnowledge opt-in, indexable, review date still in the future. */
export async function loadApprovedArticles(
  deps: FaqAssistantDependencies,
  category: string | undefined
): Promise<ApprovedArticle[]> {
  const result = await deps.database
    .prepare(
      `SELECT page_id,version_id,slug,published_at,category,document FROM (${supportKnowledgeEligibleSql('?1')}) WHERE (?2='' OR category=?2) ORDER BY slug LIMIT 100`
    )
    .bind(cmsNow(deps), category ?? '')
    .all<{
      page_id: string
      version_id: string
      slug: string
      published_at: string
      category: string
      document: string
    }>()
  const articles: ApprovedArticle[] = []
  for (const row of result.results) {
    let document: Record<string, unknown>
    try {
      document = JSON.parse(row.document) as Record<string, unknown>
    } catch {
      continue
    }
    const seo = (document.seo ?? {}) as Record<string, unknown>
    articles.push({
      pageId: row.page_id,
      versionId: row.version_id,
      slug: row.slug,
      title: String(document.title ?? ''),
      description: typeof seo.description === 'string' ? seo.description : '',
      category: row.category,
      reviewedAt: row.published_at,
      passages: passagesOf(document)
    })
  }
  return articles
}

interface TurnRow {
  id: string
  payload_hash: string
  question: string
  outcome: AssistantOutcome
  reason: AssistantReason
  confidence_bp: number
  sources: string
  answer: string | null
  created_at: string
  handoff_id: string | null
}
function replyOf(row: TurnRow): FaqAssistantReply {
  const notice =
    row.reason === 'emergency'
      ? EMERGENCY_NOTICE
      : row.outcome === 'answered' && assessRisk(row.question) === 'chemical'
        ? CHEMICAL_NOTICE
        : null
  return {
    turnId: row.id,
    outcome: row.outcome,
    reason: row.reason,
    answer: row.answer,
    confidenceBp: row.confidence_bp,
    sources: JSON.parse(row.sources) as AssistantSource[],
    notice,
    handoff: { available: true, handoffId: row.handoff_id },
    createdAt: row.created_at
  }
}
const TURN_SELECT = `SELECT t.id,t.payload_hash,t.question,t.outcome,t.reason,t.confidence_bp,t.sources,t.answer,t.created_at,h.id handoff_id
  FROM support_faq_turns t LEFT JOIN support_faq_handoffs h ON h.turn_id=t.id`

export async function askFaqAssistant(
  deps: FaqAssistantDependencies,
  input: unknown,
  idempotencyKey: string,
  customerId: string | null
): Promise<FaqAssistantReply> {
  const parsed = assistantAskInputSchema.safeParse(input)
  if (!parsed.success) return insightFail('invalid_input')
  const key = uuidKey(idempotencyKey)
  if (!deps.enabled) return insightFail('knowledge_unavailable')
  const now = insightNow(deps.now)
  const { question, category } = parsed.data
  const redacted = redactQuestion(question)
  if (redacted.length < 3) return insightFail('invalid_input')
  const payloadHash = await insightHash('faq_ask', { question: redacted, category: category ?? null })
  const keyHash = await sha256Hex('faq-ask:' + key)
  const find = () => deps.database.prepare(`${TURN_SELECT} WHERE t.idempotency_hash=?1`).bind(keyHash).first<TurnRow>()
  const prior = await find()
  if (prior) return prior.payload_hash === payloadHash ? replyOf(prior) : insightFail('idempotency_conflict')

  let selection: GroundedSelection
  try {
    selection = selectGroundedAnswer(question, await loadApprovedArticles(deps, category), assessRisk(question))
  } catch {
    selection = {
      outcome: 'uncertain',
      reason: 'knowledge_unavailable',
      answer: null,
      confidenceBp: 0,
      sources: [],
      notice: null
    }
  }
  const turnId = crypto.randomUUID()
  try {
    await deps.database
      .prepare(
        `INSERT INTO support_faq_turns(id,idempotency_hash,payload_hash,customer_id,question,category,outcome,reason,confidence_bp,sources,answer,created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)`
      )
      .bind(
        turnId,
        keyHash,
        payloadHash,
        customerId,
        redacted,
        category ?? null,
        selection.outcome,
        selection.reason,
        selection.confidenceBp,
        JSON.stringify(selection.sources),
        selection.answer,
        now
      )
      .run()
  } catch {
    const raced = await find()
    if (raced) return raced.payload_hash === payloadHash ? replyOf(raced) : insightFail('idempotency_conflict')
    return insightFail('service_unavailable')
  }
  return {
    turnId,
    outcome: selection.outcome,
    reason: selection.reason,
    answer: selection.answer,
    confidenceBp: selection.confidenceBp,
    sources: selection.sources,
    notice: selection.notice,
    handoff: { available: true, handoffId: null },
    createdAt: now
  }
}

export interface FaqHandoffReceipt {
  handoffId: string
  status: 'open' | 'claimed' | 'resolved'
  slaDueAt: string
  version: number
}
export async function requestFaqHandoff(
  deps: FaqAssistantDependencies,
  input: unknown,
  customerId: string | null
): Promise<FaqHandoffReceipt> {
  const parsed = assistantHandoffInputSchema.safeParse(input)
  if (!parsed.success) return insightFail('invalid_input')
  const { turnId, contactEmail, note } = parsed.data
  if (!customerId && !contactEmail) return insightFail('invalid_input')
  const now = insightNow(deps.now)
  const turn = await deps.database.prepare('SELECT id FROM support_faq_turns WHERE id=?1').bind(turnId).first()
  if (!turn) return insightFail('not_found')
  await deps.database
    .prepare(
      `INSERT INTO support_faq_handoffs(id,turn_id,customer_id,contact_email,note,status,sla_due_at,version,created_at,updated_at)
       VALUES (?1,?2,?3,?4,?5,'open',?6,1,?7,?7) ON CONFLICT(turn_id) DO NOTHING`
    )
    .bind(
      crypto.randomUUID(),
      turnId,
      customerId,
      contactEmail ?? null,
      note ?? null,
      addHours(now, FAQ_HANDOFF_SLA_HOURS),
      now
    )
    .run()
  const row = await deps.database
    .prepare('SELECT id,status,sla_due_at,version FROM support_faq_handoffs WHERE turn_id=?1')
    .bind(turnId)
    .first<{ id: string; status: FaqHandoffReceipt['status']; sla_due_at: string; version: number }>()
  if (!row) return insightFail('service_unavailable')
  return { handoffId: row.id, status: row.status, slaDueAt: row.sla_due_at, version: row.version }
}

export async function recordFaqFeedback(deps: FaqAssistantDependencies, input: unknown) {
  const parsed = assistantFeedbackInputSchema.safeParse(input)
  if (!parsed.success) return insightFail('invalid_input')
  const { turnId, helpful } = parsed.data
  const now = insightNow(deps.now)
  const turn = await deps.database.prepare('SELECT id FROM support_faq_turns WHERE id=?1').bind(turnId).first()
  if (!turn) return insightFail('not_found')
  await deps.database
    .prepare(
      'INSERT INTO support_faq_feedback(turn_id,helpful,created_at) VALUES (?1,?2,?3) ON CONFLICT(turn_id) DO NOTHING'
    )
    .bind(turnId, helpful ? 1 : 0, now)
    .run()
  const row = await deps.database
    .prepare('SELECT helpful FROM support_faq_feedback WHERE turn_id=?1')
    .bind(turnId)
    .first<{ helpful: number }>()
  if (!row) return insightFail('service_unavailable')
  if ((row.helpful === 1) !== helpful) return insightFail('idempotency_conflict')
  return { turnId, helpful, recorded: true as const }
}

// ------------------------------------------------------------ administrative side
const listQuerySchema = z
  .object({
    status: z.enum(['open', 'claimed', 'resolved']).optional(),
    limit: z.number().int().min(1).max(100).default(50)
  })
  .strict()
export async function listFaqHandoffs(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  query: { status?: string; limit?: number },
  now: string
) {
  await requireSupportAdmin(db, claims, now)
  const parsed = listQuerySchema.safeParse(query)
  if (!parsed.success) return insightFail('invalid_input')
  const rows = await db
    .prepare(
      `SELECT h.id,h.turn_id,h.status,h.contact_email,h.customer_id,h.note,h.owner_id,h.sla_due_at,h.version,h.created_at,h.resolved_at,
              t.question,t.reason,t.outcome
       FROM support_faq_handoffs h JOIN support_faq_turns t ON t.id=h.turn_id
       WHERE (?1 IS NULL OR h.status=?1) ORDER BY h.sla_due_at,h.id LIMIT ?2`
    )
    .bind(parsed.data.status ?? null, parsed.data.limit)
    .all<Record<string, string | number | null>>()
  return {
    items: rows.results.map((row) => ({
      id: row.id as string,
      turnId: row.turn_id as string,
      status: row.status as string,
      contactEmail: row.contact_email as string | null,
      hasCustomer: row.customer_id !== null,
      note: row.note as string | null,
      ownerId: row.owner_id as string | null,
      question: row.question as string,
      reason: row.reason as string,
      outcome: row.outcome as string,
      slaDueAt: row.sla_due_at as string,
      slaState:
        row.status === 'resolved'
          ? (row.resolved_at as string) <= (row.sla_due_at as string)
            ? 'met'
            : 'breached'
          : b2bSlaState(
              { createdAt: row.created_at as string, slaDueAt: row.sla_due_at as string, firstResponseAt: null },
              now
            ),
      version: row.version as number,
      createdAt: row.created_at as string
    }))
  }
}

const handoffCommandSchema = z
  .object({ action: z.enum(['claim', 'resolve']), expectedVersion: z.number().int().min(1).max(9_007_199_254_740_990) })
  .strict()
export async function commandFaqHandoff(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  handoffId: string,
  rawCommand: unknown,
  idempotencyKey: string,
  now: string
) {
  const admin = await requireSupportAdmin(db, claims, now)
  const parsed = handoffCommandSchema.safeParse(rawCommand)
  if (!parsed.success || !z.string().uuid().safeParse(handoffId).success) return insightFail('invalid_input')
  const command = parsed.data
  const key = uuidKey(idempotencyKey)
  const payloadHash = await insightHash('faq_handoff', { handoffId, command })
  const replay = await replayedCommand<FaqHandoffReceipt>(db, admin.identityId, key, payloadHash)
  if (replay) return replay
  const row = await db
    .prepare('SELECT status,version FROM support_faq_handoffs WHERE id=?1')
    .bind(handoffId)
    .first<{ status: FaqHandoffReceipt['status']; version: number }>()
  if (!row) return insightFail('not_found')
  if (row.version !== command.expectedVersion) return insightFail('concurrency_conflict')
  const next =
    command.action === 'claim' && row.status === 'open'
      ? 'claimed'
      : command.action === 'resolve' && row.status === 'claimed'
        ? 'resolved'
        : null
  if (!next) return insightFail('invalid_transition')
  const commandId = crypto.randomUUID()
  const receipt = { handoffId, status: next, slaDueAt: '', version: row.version + 1 }
  const current = await db
    .prepare('SELECT sla_due_at FROM support_faq_handoffs WHERE id=?1')
    .bind(handoffId)
    .first<{ sla_due_at: string }>()
  receipt.slaDueAt = current?.sla_due_at ?? ''
  return runGuardedBatch<FaqHandoffReceipt>(
    db,
    [
      db
        .prepare(
          `UPDATE support_faq_handoffs SET status=?1,owner_id=COALESCE(owner_id,?2),version=version+1,updated_at=?3,resolved_at=?4
           WHERE id=?5 AND version=?6 AND status=?7`
        )
        .bind(
          next,
          admin.identityId,
          now,
          next === 'resolved' ? now : null,
          handoffId,
          command.expectedVersion,
          row.status
        ),
      guardedCommand(db, {
        id: commandId,
        scope: 'faq_handoff',
        actorId: admin.identityId,
        key,
        payloadHash,
        subjectId: handoffId,
        receipt,
        now
      })
    ],
    { id: commandId, actorId: admin.identityId, key, payloadHash, receipt }
  )
}

export async function readFaqAssistantStats(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  window: { from: string; to: string },
  now: string
) {
  await requireSupportAdmin(db, claims, now)
  const parsed = dayWindowSchema.safeParse(window)
  if (!parsed.success) return insightFail('invalid_input')
  const from = parsed.data.from + 'T00:00:00Z',
    to = parsed.data.to + 'T00:00:00Z'
  const row = await db
    .prepare(
      `SELECT count(*) turns,
         COALESCE(sum(t.outcome='answered'),0) answered,
         COALESCE(sum(t.outcome='uncertain'),0) uncertain,
         COALESCE(sum(t.outcome='handoff_required'),0) handoff_required,
         COALESCE(sum(h.id IS NOT NULL),0) handoff_requested,
         COALESCE(sum(f.helpful=1),0) helpful,
         COALESCE(sum(f.helpful=0),0) not_helpful
       FROM support_faq_turns t
       LEFT JOIN support_faq_handoffs h ON h.turn_id=t.id
       LEFT JOIN support_faq_feedback f ON f.turn_id=t.id
       WHERE t.created_at>=?1 AND t.created_at<?2`
    )
    .bind(from, to)
    .first<Record<string, number>>()
  const turns = row?.turns ?? 0
  const bp = (n: number) => (turns === 0 ? 0 : Math.round((n / turns) * 10000))
  return {
    from: parsed.data.from,
    to: parsed.data.to,
    turns,
    answered: row?.answered ?? 0,
    uncertain: row?.uncertain ?? 0,
    handoffRequired: row?.handoff_required ?? 0,
    handoffRequested: row?.handoff_requested ?? 0,
    helpful: row?.helpful ?? 0,
    notHelpful: row?.not_helpful ?? 0,
    answeredRateBp: bp(row?.answered ?? 0),
    handoffRateBp: bp(row?.handoff_requested ?? 0)
  }
}
