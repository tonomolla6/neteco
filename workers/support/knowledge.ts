import { z } from 'zod'
import {
  SUPPORT_KNOWLEDGE_CATEGORIES,
  supportKnowledgeQuerySchema,
  supportKnowledgeListSchema,
  supportKnowledgeFeedbackInputSchema,
  supportKnowledgeFeedbackReceiptSchema,
  type SupportKnowledgeQuery
} from '../../shared/support-knowledge'
import { catalogPolicyUuidSchema } from '../../shared/catalog-publication-policy'
import { cmsNow, cmsPublishedValiditySql, type CmsPublicationDependencies } from '../cms/publication-gate'
import { spanishFoldSql } from '../catalog/search'

export interface SupportKnowledgeDependencies extends CmsPublicationDependencies {
  feedbackEnabled?: boolean
}
export class SupportKnowledgeError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}
function fail(code: string): never {
  throw new SupportKnowledgeError(code)
}
const categorySql = SUPPORT_KNOWLEDGE_CATEGORIES.map((value) => `'${value.id}'`).join(',')
function eligible(now: string) {
  return `SELECT release.id publication_id,release.page_id,release.version_id,release.slug,release.published_at,cv.document,
  json_extract(cv.document,'$.supportKnowledge.category') category,
  json_extract(cv.document,'$.supportKnowledge.reviewDueAt') review_due_at
  FROM content_publications release JOIN content_publication_states head ON head.page_id=release.page_id
  JOIN content_versions cv ON cv.id=release.version_id AND cv.page_id=release.page_id
  WHERE ${cmsPublishedValiditySql('release', 'head', now)}
  AND json_extract(cv.document,'$.seo.noindex')=0
  AND json_extract(cv.document,'$.supportKnowledge.category') IN (${categorySql})
  AND json_extract(cv.document,'$.supportKnowledge.reviewDueAt')>${now}
  AND json_extract(cv.document,'$.supportKnowledge.reviewDueAt')>release.published_at`
}
function normalizedQuery(q: string) {
  return q.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim()
}
const rowsSchema = z.array(z.record(z.unknown()))
export async function listSupportKnowledge(deps: SupportKnowledgeDependencies, input: SupportKnowledgeQuery) {
  if (!deps.enabled) fail('knowledge_unavailable')
  const parsed = supportKnowledgeQuerySchema.safeParse(input)
  if (!parsed.success) fail('invalid_input')
  const query = parsed.data
  async function snapshot() {
    const cte = `WITH eligible AS (${eligible('?1')})`
    const text = `coalesce(json_extract(document,'$.title'),'')||' '||coalesce(json_extract(document,'$.seo.description'),'')||' '||coalesce((SELECT group_concat(coalesce(json_extract(b.value,'$.text'),'')||' '||coalesce(json_extract(b.value,'$.title'),'')||' '||coalesce(json_extract(b.value,'$.label'),'')||' '||coalesce((SELECT group_concat(value,' ') FROM json_each(b.value,'$.items')),''),' ') FROM json_each(document,'$.blocks') b),'')`
    // Literal substring search preserves escaped-LIKE semantics without D1's
    // small LIKE pattern limit rejecting legitimate long queries.
    const where = `WHERE (?2='' OR instr(${spanishFoldSql(text)}, ?3)>0) AND (?4='' OR category=?4)`
    const args = [cmsNow(deps), query.q.trim(), normalizedQuery(query.q), query.category ?? '']
    const result = await deps.database.batch([
      deps.database.prepare(`${cte} SELECT count(*) total FROM eligible ${where}`).bind(...args),
      deps.database
        .prepare(
          `${cte} SELECT page_id,version_id,slug,published_at,category,review_due_at,json_extract(document,'$.title') title,json_extract(document,'$.seo.description') excerpt FROM eligible ${where} ORDER BY ${spanishFoldSql("json_extract(document,'$.title')")},slug,page_id LIMIT ?5 OFFSET ?6`
        )
        .bind(...args, query.perPage, (query.page - 1) * query.perPage),
      deps.database.prepare(`${cte} SELECT DISTINCT category FROM eligible ORDER BY category`).bind(args[0])
    ])
    if (result.some((item) => !item.success)) fail('knowledge_unavailable')
    const count = rowsSchema.parse(result[0]!.results),
      items = rowsSchema.parse(result[1]!.results),
      categories = rowsSchema.parse(result[2]!.results)
    return supportKnowledgeListSchema.parse({
      source: 'cloudflare',
      items: items.map((item) => ({
        id: item.page_id,
        versionId: item.version_id,
        slug: item.slug,
        title: item.title,
        excerpt: item.excerpt,
        category: item.category,
        reviewedAt: item.published_at,
        reviewDueAt: item.review_due_at
      })),
      categories: categories.map((item) => ({
        id: item.category,
        label: SUPPORT_KNOWLEDGE_CATEGORIES.find((category) => category.id === item.category)?.label
      })),
      total: count[0]?.total,
      page: query.page,
      perPage: query.perPage,
      feedbackEnabled: deps.feedbackEnabled === true
    })
  }
  const first = await snapshot(),
    last = await snapshot()
  if (JSON.stringify(first) !== JSON.stringify(last)) fail('knowledge_unavailable')
  return last
}
async function keyHash(key: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')
}
export async function readSupportKnowledgeFeedback(deps: SupportKnowledgeDependencies, key: string) {
  if (!deps.enabled || !deps.feedbackEnabled) fail('feedback_unavailable')
  if (!catalogPolicyUuidSchema.safeParse(key).success) fail('invalid_input')
  const row = await deps.database
    .prepare('SELECT response FROM support_knowledge_feedback WHERE idempotency_key=?')
    .bind(await keyHash(key))
    .first<{ response: string }>()
  return row === null ? null : supportKnowledgeFeedbackReceiptSchema.parse(JSON.parse(row.response))
}
export async function recordSupportKnowledgeFeedback(deps: SupportKnowledgeDependencies, input: unknown, key: string) {
  if (!deps.enabled || !deps.feedbackEnabled) fail('feedback_unavailable')
  const parsed = supportKnowledgeFeedbackInputSchema.safeParse(input)
  if (!parsed.success || !catalogPolicyUuidSchema.safeParse(key).success) fail('invalid_input')
  const body = parsed.data
  function match(receipt: NonNullable<Awaited<ReturnType<typeof readSupportKnowledgeFeedback>>>) {
    if (receipt.pageId !== body.pageId || receipt.versionId !== body.versionId || receipt.helpful !== body.helpful)
      fail('idempotency_conflict')
    return receipt
  }
  const prior = await readSupportKnowledgeFeedback(deps, key)
  if (prior) return match(prior)
  const receipt = supportKnowledgeFeedbackReceiptSchema.parse({
      source: 'cloudflare',
      feedbackId: crypto.randomUUID(),
      ...body,
      recorded: true
    }),
    now = cmsNow(deps)
  try {
    const row = await deps.database
      .prepare(
        `INSERT INTO support_knowledge_feedback(id,idempotency_key,page_id,version_id,publication_id,helpful,response,created_at)
      SELECT ?2,?3,page_id,version_id,publication_id,?4,?5,?1 FROM (${eligible('?1')}) WHERE page_id=?6 AND version_id=?7 RETURNING response`
      )
      .bind(
        now,
        receipt.feedbackId,
        await keyHash(key),
        body.helpful ? 1 : 0,
        JSON.stringify(receipt),
        body.pageId,
        body.versionId
      )
      .first<{ response: string }>()
    if (!row) fail('article_unavailable')
    return supportKnowledgeFeedbackReceiptSchema.parse(JSON.parse(row.response))
  } catch (error) {
    const recovered = await readSupportKnowledgeFeedback(deps, key)
    if (recovered) return match(recovered)
    if (error instanceof SupportKnowledgeError) throw error
    const message = String(error)
    if (message.includes('knowledge_article_unavailable')) fail('article_unavailable')
    fail('feedback_unavailable')
  }
}
