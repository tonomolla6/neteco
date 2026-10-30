import { authorizeD1Session, type VerifiedSessionClaims } from './authorization'
import {
  type UpsertEditorialArticleInput,
  type ReviewEditorialArticleInput,
  type CatalogEditorialArticle,
  upsertEditorialArticleInputSchema,
  reviewEditorialArticleInputSchema,
  evaluateEditorialQuality
} from '../../shared/catalog-editorial-content'

export class EditorialContentError extends Error {
  constructor(
    readonly code: string,
    message?: string
  ) {
    super(message ? `${code}: ${message}` : code)
    this.name = 'EditorialContentError'
  }
}

async function sha256Hex(data: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data))
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('')
}

export async function authorizeCatalog(
  database: D1Database,
  claims: VerifiedSessionClaims,
  now?: string
): Promise<void> {
  const resWrite = await authorizeD1Session(database, claims, 'catalog.write', {
    now,
    requireMfa: true
  })
  if (resWrite.allowed) return

  const resManage = await authorizeD1Session(database, claims, 'administration.manage', {
    now,
    requireMfa: true
  })
  if (resManage.allowed) return

  if (resWrite.code === 'unauthenticated' || resManage.code === 'unauthenticated') {
    throw new EditorialContentError('unauthenticated', 'Session unauthenticated or expired')
  }
  throw new EditorialContentError('forbidden', 'Requires catalog.write permission')
}

export type EditorialContentOptions = {
  now?: string
}

export async function upsertEditorialArticle(
  database: D1Database,
  claims: VerifiedSessionClaims,
  rawInput: UpsertEditorialArticleInput,
  options?: EditorialContentOptions
): Promise<CatalogEditorialArticle> {
  const now = options?.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  await authorizeCatalog(database, claims, now)

  const input = upsertEditorialArticleInputSchema.parse(rawInput)

  // Validate editorial quality, professional intent & anti-duplication
  const quality = evaluateEditorialQuality({
    bodyMarkdown: input.bodyMarkdown,
    applicationScope: input.applicationScope,
    surfaceCompatibility: input.surfaceCompatibility,
    dilutionDosageGuide: input.dilutionDosageGuide,
    safetyAndPpe: input.safetyAndPpe,
    supplierReferenceText: input.supplierReferenceText
  })

  if (!quality.isValid) {
    if (quality.similarityScore > 0.35) {
      throw new EditorialContentError(
        'supplier_content_duplicated',
        `El contenido editorial duplica el texto del proveedor (similitud ${(quality.similarityScore * 100).toFixed(1)}%). Debe ser original.`
      )
    }
    if (!quality.surpassesSupplier) {
      throw new EditorialContentError(
        'supplier_content_not_surpassed',
        'El contenido editorial debe superar en profundidad técnica y detalle al proveedor.'
      )
    }
    throw new EditorialContentError('invalid_editorial_quality', quality.reasons.join('; '))
  }

  const existing = await database
    .prepare(
      `SELECT id, version, status FROM catalog_editorial_articles
       WHERE target_type = ? AND target_id = ?`
    )
    .bind(input.targetType, input.targetId)
    .first<{ id: string; version: number; status: string }>()

  const payloadHash = await sha256Hex(JSON.stringify(input))

  if (existing) {
    if (input.expectedVersion !== undefined && input.expectedVersion !== existing.version) {
      throw new EditorialContentError(
        'version_conflict',
        `Expected version ${input.expectedVersion}, found ${existing.version}`
      )
    }

    const nextVersion = existing.version + 1
    await database
      .prepare(
        `UPDATE catalog_editorial_articles
         SET title = ?, summary = ?, body_markdown = ?, application_scope = ?,
             surface_compatibility_json = ?, dilution_dosage_guide = ?,
             safety_and_ppe_json = ?, technical_standards_json = ?,
             supplier_reference_text = ?, supplier_similarity_score = ?,
             version = ?, updated_at = ?
         WHERE id = ? AND version = ?`
      )
      .bind(
        input.title,
        input.summary,
        input.bodyMarkdown,
        input.applicationScope,
        JSON.stringify(input.surfaceCompatibility),
        input.dilutionDosageGuide,
        JSON.stringify(input.safetyAndPpe),
        JSON.stringify(input.technicalStandards),
        input.supplierReferenceText ?? null,
        quality.similarityScore,
        nextVersion,
        now,
        existing.id,
        existing.version
      )
      .run()

    // Command & audit
    const commandId = crypto.randomUUID()
    await database
      .prepare(
        `INSERT INTO catalog_editorial_article_commands (
           command_id, article_id, actor_id, action,
           expected_version, result_version, payload_hash, input_json, created_at
         ) VALUES (?, ?, ?, 'update', ?, ?, ?, ?, ?)`
      )
      .bind(
        commandId,
        existing.id,
        claims.identityId,
        existing.version,
        nextVersion,
        payloadHash,
        JSON.stringify(input),
        now
      )
      .run()

    await database
      .prepare(
        `INSERT INTO catalog_editorial_article_audit (
           command_id, actor_id, article_id, action, payload_hash, input_json, created_at
         ) VALUES (?, ?, ?, 'update', ?, ?, ?)`
      )
      .bind(commandId, claims.identityId, existing.id, payloadHash, JSON.stringify(input), now)
      .run()

    return (await getEditorialArticle(database, input.targetType, input.targetId))!
  } else {
    const articleId = crypto.randomUUID()
    await database
      .prepare(
        `INSERT INTO catalog_editorial_articles (
           id, target_type, target_id, title, summary, body_markdown,
           application_scope, surface_compatibility_json, dilution_dosage_guide,
           safety_and_ppe_json, technical_standards_json, supplier_reference_text,
           supplier_similarity_score, status, author_identity_id,
           version, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, 1, ?, ?)`
      )
      .bind(
        articleId,
        input.targetType,
        input.targetId,
        input.title,
        input.summary,
        input.bodyMarkdown,
        input.applicationScope,
        JSON.stringify(input.surfaceCompatibility),
        input.dilutionDosageGuide,
        JSON.stringify(input.safetyAndPpe),
        JSON.stringify(input.technicalStandards),
        input.supplierReferenceText ?? null,
        quality.similarityScore,
        claims.identityId,
        now,
        now
      )
      .run()

    // Command & audit
    const commandId = crypto.randomUUID()
    await database
      .prepare(
        `INSERT INTO catalog_editorial_article_commands (
           command_id, article_id, actor_id, action,
           expected_version, result_version, payload_hash, input_json, created_at
         ) VALUES (?, ?, ?, 'create', 0, 1, ?, ?, ?)`
      )
      .bind(commandId, articleId, claims.identityId, payloadHash, JSON.stringify(input), now)
      .run()

    await database
      .prepare(
        `INSERT INTO catalog_editorial_article_audit (
           command_id, actor_id, article_id, action, payload_hash, input_json, created_at
         ) VALUES (?, ?, ?, 'create', ?, ?, ?)`
      )
      .bind(commandId, claims.identityId, articleId, payloadHash, JSON.stringify(input), now)
      .run()

    return (await getEditorialArticle(database, input.targetType, input.targetId))!
  }
}

export async function reviewEditorialArticle(
  database: D1Database,
  claims: VerifiedSessionClaims,
  rawInput: ReviewEditorialArticleInput,
  options?: EditorialContentOptions
): Promise<CatalogEditorialArticle> {
  const now = options?.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  await authorizeCatalog(database, claims, now)

  const input = reviewEditorialArticleInputSchema.parse(rawInput)

  const existing = await database
    .prepare(`SELECT id, target_type, target_id, version, status FROM catalog_editorial_articles WHERE id = ?`)
    .bind(input.articleId)
    .first<{ id: string; target_type: string; target_id: string; version: number; status: string }>()

  if (!existing) {
    throw new EditorialContentError('not_found', 'Article not found')
  }

  if (existing.version !== input.expectedVersion) {
    throw new EditorialContentError(
      'version_conflict',
      `Expected version ${input.expectedVersion}, found ${existing.version}`
    )
  }

  const nextVersion = existing.version + 1
  await database
    .prepare(
      `UPDATE catalog_editorial_articles
       SET status = ?, reviewer_identity_id = ?, version = ?, updated_at = ?
       WHERE id = ? AND version = ?`
    )
    .bind(input.decision, claims.identityId, nextVersion, now, existing.id, existing.version)
    .run()

  const payloadHash = await sha256Hex(JSON.stringify(input))
  const commandId = crypto.randomUUID()
  await database
    .prepare(
      `INSERT INTO catalog_editorial_article_commands (
         command_id, article_id, actor_id, action,
         expected_version, result_version, payload_hash, input_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      commandId,
      existing.id,
      claims.identityId,
      input.decision,
      existing.version,
      nextVersion,
      payloadHash,
      JSON.stringify(input),
      now
    )
    .run()

  await database
    .prepare(
      `INSERT INTO catalog_editorial_article_audit (
         command_id, actor_id, article_id, action, payload_hash, input_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(commandId, claims.identityId, existing.id, input.decision, payloadHash, JSON.stringify(input), now)
    .run()

  return (await getEditorialArticle(database, existing.target_type as 'product' | 'category', existing.target_id))!
}

export async function getEditorialArticle(
  database: D1Database,
  targetType: 'product' | 'category',
  targetId: string
): Promise<CatalogEditorialArticle | null> {
  const row = await database
    .prepare(
      `SELECT id, target_type, target_id, title, summary, body_markdown,
              application_scope, surface_compatibility_json, dilution_dosage_guide,
              safety_and_ppe_json, technical_standards_json, supplier_reference_text,
              supplier_similarity_score, status, author_identity_id, reviewer_identity_id,
              version, created_at, updated_at
       FROM catalog_editorial_articles
       WHERE target_type = ? AND target_id = ?`
    )
    .bind(targetType, targetId)
    .first<{
      id: string
      target_type: string
      target_id: string
      title: string
      summary: string
      body_markdown: string
      application_scope: string
      surface_compatibility_json: string
      dilution_dosage_guide: string
      safety_and_ppe_json: string
      technical_standards_json: string
      supplier_reference_text: string | null
      supplier_similarity_score: number
      status: string
      author_identity_id: string
      reviewer_identity_id: string | null
      version: number
      created_at: string
      updated_at: string
    }>()

  if (!row) return null

  return {
    id: row.id,
    targetType: row.target_type as CatalogEditorialArticle['targetType'],
    targetId: row.target_id,
    title: row.title,
    summary: row.summary,
    bodyMarkdown: row.body_markdown,
    applicationScope: row.application_scope,
    surfaceCompatibility: JSON.parse(row.surface_compatibility_json),
    dilutionDosageGuide: row.dilution_dosage_guide,
    safetyAndPpe: JSON.parse(row.safety_and_ppe_json),
    technicalStandards: JSON.parse(row.technical_standards_json),
    supplierReferenceText: row.supplier_reference_text,
    supplierSimilarityScore: row.supplier_similarity_score,
    status: row.status as CatalogEditorialArticle['status'],
    authorIdentityId: row.author_identity_id,
    reviewerIdentityId: row.reviewer_identity_id,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export async function listEditorialArticles(
  database: D1Database,
  filters?: { targetType?: 'product' | 'category'; status?: string }
): Promise<CatalogEditorialArticle[]> {
  let query = `
    SELECT id, target_type, target_id, title, summary, body_markdown,
           application_scope, surface_compatibility_json, dilution_dosage_guide,
           safety_and_ppe_json, technical_standards_json, supplier_reference_text,
           supplier_similarity_score, status, author_identity_id, reviewer_identity_id,
           version, created_at, updated_at
    FROM catalog_editorial_articles
    WHERE 1=1
  `
  const bindings: unknown[] = []
  if (filters?.targetType) {
    query += ` AND target_type = ?`
    bindings.push(filters.targetType)
  }
  if (filters?.status) {
    query += ` AND status = ?`
    bindings.push(filters.status)
  }
  query += ` ORDER BY updated_at DESC`

  const rows = await database
    .prepare(query)
    .bind(...bindings)
    .all<{
      id: string
      target_type: 'product' | 'category'
      target_id: string
      title: string
      summary: string
      body_markdown: string
      application_scope: string
      surface_compatibility_json: string
      dilution_dosage_guide: string
      safety_and_ppe_json: string
      technical_standards_json: string
      supplier_reference_text: string | null
      supplier_similarity_score: number
      status: 'draft' | 'in_review' | 'approved' | 'published' | 'archived'
      author_identity_id: string
      reviewer_identity_id: string | null
      version: number
      created_at: string
      updated_at: string
    }>()

  return (rows.results || []).map((row) => ({
    id: row.id,
    targetType: row.target_type,
    targetId: row.target_id,
    title: row.title,
    summary: row.summary,
    bodyMarkdown: row.body_markdown,
    applicationScope: row.application_scope,
    surfaceCompatibility: JSON.parse(row.surface_compatibility_json),
    dilutionDosageGuide: row.dilution_dosage_guide,
    safetyAndPpe: JSON.parse(row.safety_and_ppe_json),
    technicalStandards: JSON.parse(row.technical_standards_json),
    supplierReferenceText: row.supplier_reference_text,
    supplierSimilarityScore: row.supplier_similarity_score,
    status: row.status,
    authorIdentityId: row.author_identity_id,
    reviewerIdentityId: row.reviewer_identity_id,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }))
}
