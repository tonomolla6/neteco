import {
  type CatalogAiGenerationRecord,
  type VerifiableClaimItem,
  type DuplicateCheckResult,
  type MatchedDuplicateProduct,
  type CatalogAiScope,
  type CatalogAiApprovalStatus,
  GenerateCatalogContentInputSchema,
  ReviewCatalogGenerationInputSchema,
  ApplyCatalogGenerationInputSchema,
  CatalogAiGenerationError,
  catalogAiPayloadHash,
  computeTextSimilarity
} from '../../shared/catalog-ai-generation'
import { authorizeD1Session, type VerifiedSessionClaims } from './authorization'

interface CatalogAiGenerationRow {
  id: string
  product_id: string | null
  target_scope: CatalogAiScope
  actor_id: string
  sources_json: string
  prompt: string
  generated_title: string | null
  generated_short_description: string | null
  generated_description: string | null
  generated_usage: string | null
  generated_attributes_json: string | null
  verifiable_claims_json: string
  duplicate_check_json: string
  is_ai_generated: number
  ai_model_name: string
  approval_status: CatalogAiApprovalStatus
  human_reviewed_at: string | null
  human_reviewer_id: string | null
  applied_content_json: string | null
  review_notes: string | null
  version: number
  created_at: string
  updated_at: string
}

export interface CatalogAiOperationOptions {
  idempotencyKey: string
  now?: () => string
}

function getIsoNow(options?: CatalogAiOperationOptions): string {
  const custom = options?.now?.()
  if (custom) return custom
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

async function verifyCatalogAiAuth(database: D1Database, claims: VerifiedSessionClaims, now: string): Promise<void> {
  const authDirect = await authorizeD1Session(database, claims, 'catalog.ai_generate', { now, requireMfa: true })
  if (authDirect.allowed) return

  const authCatalog = await authorizeD1Session(database, claims, 'catalog.write', { now, requireMfa: true })
  if (authCatalog.allowed) return

  const authAdmin = await authorizeD1Session(database, claims, 'administration.manage', { now, requireMfa: true })
  if (authAdmin.allowed) return

  throw new CatalogAiGenerationError(
    'unauthorized',
    'Permisos insuficientes: se requiere catalog.ai_generate, catalog.write o administration.manage'
  )
}

async function recoverConcurrentAiReceipt<T>(
  error: unknown,
  database: D1Database,
  claims: VerifiedSessionClaims,
  options: CatalogAiOperationOptions,
  payloadHash: string,
  permission?: 'catalog.publish'
): Promise<T> {
  if (
    !(error instanceof Error) ||
    !/UNIQUE constraint failed: catalog_ai_generation_commands\.(?:generation_id|actor_id)/.test(error.message)
  )
    throw error
  const now = getIsoNow(options)
  await verifyCatalogAiAuth(database, claims, now)
  if (permission) {
    const authorization = await authorizeD1Session(database, claims, permission, { now, requireMfa: true })
    if (!authorization.allowed) throw new CatalogAiGenerationError('unauthorized', 'Se requiere permiso de publicación')
  }
  const command = await database
    .prepare(
      `SELECT payload_hash, receipt_json FROM catalog_ai_generation_commands
     WHERE actor_id = ?1 AND idempotency_key = ?2`
    )
    .bind(claims.identityId, options.idempotencyKey)
    .first<{ payload_hash: string; receipt_json: string }>()
  if (!command) throw new CatalogAiGenerationError('concurrency_conflict', 'Otra operación confirmó esta versión')
  if (command.payload_hash !== payloadHash) {
    throw new CatalogAiGenerationError(
      'idempotency_conflict',
      'La clave de idempotencia ya fue utilizada con una carga distinta'
    )
  }
  return JSON.parse(command.receipt_json) as T
}

export async function checkD1CatalogDuplicates(
  database: D1Database,
  text: string,
  title?: string
): Promise<DuplicateCheckResult> {
  const products = await database
    .prepare(`SELECT id, name, short_description, description FROM products LIMIT 100`)
    .all<{ id: string; name: string; short_description: string | null; description: string | null }>()

  const rows = products.results || []
  const matches: MatchedDuplicateProduct[] = []
  let maxScore = 0

  const queryComposite = `${title || ''} ${text}`.trim()

  for (const prod of rows) {
    const prodComposite = `${prod.name} ${prod.short_description || ''} ${prod.description || ''}`.trim()
    const score = computeTextSimilarity(queryComposite, prodComposite)
    if (score > 0.2) {
      matches.push({
        productId: prod.id,
        name: prod.name,
        similarityScore: score
      })
    }
    if (score > maxScore) {
      maxScore = score
    }
  }

  matches.sort((a, b) => b.similarityScore - a.similarityScore)

  const duplicateRisk = maxScore > 0.7 ? 'high' : maxScore > 0.4 ? 'medium' : maxScore > 0.2 ? 'low' : 'none'

  return {
    maxSimilarityScore: maxScore,
    duplicateRisk,
    matchedProducts: matches
  }
}

export async function generateD1CatalogContent(
  database: D1Database,
  claims: VerifiedSessionClaims,
  rawInput: unknown,
  options: CatalogAiOperationOptions
): Promise<CatalogAiGenerationRecord> {
  const parsed = GenerateCatalogContentInputSchema.safeParse(rawInput)
  if (!parsed.success) {
    throw new CatalogAiGenerationError('invalid_input', `Entrada inválida: ${parsed.error.message}`)
  }
  const input = parsed.data
  const now = getIsoNow(options)

  await verifyCatalogAiAuth(database, claims, now)

  const payloadHash = await catalogAiPayloadHash('generate_catalog_content', input)

  // 1. Idempotency check
  const existingCommand = await database
    .prepare(
      `SELECT payload_hash, receipt_json FROM catalog_ai_generation_commands
       WHERE actor_id = ?1 AND idempotency_key = ?2`
    )
    .bind(claims.identityId, options.idempotencyKey)
    .first<{ payload_hash: string; receipt_json: string }>()

  if (existingCommand) {
    if (existingCommand.payload_hash !== payloadHash) {
      throw new CatalogAiGenerationError(
        'idempotency_conflict',
        'La clave de idempotencia ya fue utilizada con una carga distinta'
      )
    }
    return JSON.parse(existingCommand.receipt_json)
  }

  // 2. Extract verifiable claims from technical sources
  const verifiableClaims: VerifiableClaimItem[] = []
  for (const source of input.sources) {
    for (const claim of source.verifiedClaims) {
      const isEco = /biodegrad|oecd|eco|sostenible/i.test(claim)
      const isSafety = /exento|seguridad|epi|guantes|cloro|alcali/i.test(claim)
      const isEfficacy = /eficacia|potente|minutos|rapido|rendimiento/i.test(claim)
      const isTechnical = /ph|densidad|dilucion|temperatura/i.test(claim)
      const category = isEco
        ? 'eco'
        : isSafety
          ? 'safety'
          : isEfficacy
            ? 'efficacy'
            : isTechnical
              ? 'technical'
              : 'regulatory'

      verifiableClaims.push({
        claimText: claim,
        sourceRef: source.id,
        verified: true,
        hazardClpCompliant: true,
        category
      })
    }
  }

  if (verifiableClaims.length === 0) {
    throw new CatalogAiGenerationError(
      'unverified_claims',
      'Las fuentes técnicas no contienen ningún claim verificable'
    )
  }

  // 3. Duplicate detection against existing catalog products
  const duplicateCheck = await checkD1CatalogDuplicates(
    database,
    `${input.prompt} ${input.sources.map((s) => s.textSnippet).join(' ')}`,
    input.productName
  )

  // 4. Content synthesis
  const sourceSnippets = input.sources.map((s) => s.textSnippet).join('. ')
  const claimsText = input.sources.flatMap((s) => s.verifiedClaims).join('. ')

  const generatedTitle = `${input.productName} Profesional Neteco`
  const generatedShortDescription = `Solución técnica profesional para ${input.productName.toLowerCase()}. Formulación garantizada con claims verificados.`
  const generatedDescription =
    `Producto de limpieza química avanzada para uso técnico e industrial. ` +
    `${sourceSnippets}. ` +
    `Propiedades verificadas: ${claimsText}. Cumple normativas técnicas y de seguridad aplicables.`
  const usageClaim = verifiableClaims.find((c) => /minuto|tiempo|actua/i.test(c.claimText))?.claimText
  const generatedUsage =
    `Modo de empleo recomendado: Aplicar según las especificaciones técnicas del fabricante. ` +
    (usageClaim
      ? `Instrucciones técnicas: ${usageClaim}. `
      : `Dejar actuar entre 5 y 30 minutos según grado de incrustación. `) +
    `Aclarar con abundante agua si procede.`
  const generatedAttributes: Record<string, unknown> = {
    gama: 'profesional',
    origen: 'fabricacion_propia',
    pH: verifiableClaims.find((c) => /ph/i.test(c.claimText))?.claimText || 'neutro (7.0)',
    normativa: verifiableClaims.find((c) => /une|iso|oecd/i.test(c.claimText))?.claimText || 'UNE-EN estandar'
  }

  const generationId = crypto.randomUUID()
  const aiModelName = 'neteco-catalog-gen-v1'

  const record: CatalogAiGenerationRecord = {
    id: generationId,
    productId: input.productId ?? null,
    targetScope: input.targetScope,
    actorId: claims.identityId,
    sources: input.sources,
    prompt: input.prompt,
    generatedTitle,
    generatedShortDescription,
    generatedDescription,
    generatedUsage,
    generatedAttributes,
    verifiableClaims,
    duplicateCheck,
    isAiGenerated: true,
    aiModelName,
    approvalStatus: 'pending_review',
    humanReviewedAt: null,
    humanReviewerId: null,
    appliedContent: null,
    reviewNotes: null,
    version: 1,
    createdAt: now,
    updatedAt: now
  }

  // Write to D1
  await database
    .prepare(
      `INSERT INTO catalog_ai_generations (
        id, product_id, target_scope, actor_id, sources_json, prompt,
        generated_title, generated_short_description, generated_description,
        generated_usage, generated_attributes_json, verifiable_claims_json,
        duplicate_check_json, is_ai_generated, ai_model_name, approval_status,
        human_reviewed_at, human_reviewer_id, applied_content_json, review_notes,
        version, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 1, ?14, 'pending_review', NULL, NULL, NULL, NULL, 1, ?15, ?15)`
    )
    .bind(
      record.id,
      record.productId,
      record.targetScope,
      record.actorId,
      JSON.stringify(record.sources),
      record.prompt,
      record.generatedTitle,
      record.generatedShortDescription,
      record.generatedDescription,
      record.generatedUsage,
      JSON.stringify(record.generatedAttributes),
      JSON.stringify(record.verifiableClaims),
      JSON.stringify(record.duplicateCheck),
      record.aiModelName,
      now
    )
    .run()

  // Record command in append-only table
  const commandId = crypto.randomUUID()
  await database
    .prepare(
      `INSERT INTO catalog_ai_generation_commands (
        command_id, generation_id, actor_id, action, idempotency_key,
        expected_version, result_version, payload_hash, input_json, receipt_json, created_at
      ) VALUES (?1, ?2, ?3, 'generate_catalog_content', ?4, 0, 1, ?5, ?6, ?7, ?8)`
    )
    .bind(
      commandId,
      record.id,
      claims.identityId,
      options.idempotencyKey,
      payloadHash,
      JSON.stringify(input),
      JSON.stringify(record),
      now
    )
    .run()

  return record
}

export async function reviewD1CatalogAiGeneration(
  database: D1Database,
  claims: VerifiedSessionClaims,
  generationId: string,
  rawInput: unknown,
  options: CatalogAiOperationOptions
): Promise<CatalogAiGenerationRecord> {
  const parsed = ReviewCatalogGenerationInputSchema.safeParse(rawInput)
  if (!parsed.success) {
    throw new CatalogAiGenerationError('invalid_input', `Decisión de revisión inválida: ${parsed.error.message}`)
  }
  const input = parsed.data
  const now = getIsoNow(options)

  await verifyCatalogAiAuth(database, claims, now)

  const payloadHash = await catalogAiPayloadHash('human_review_decision', { generationId, ...input })

  // Idempotency check
  const existingCommand = await database
    .prepare(
      `SELECT payload_hash, receipt_json FROM catalog_ai_generation_commands
       WHERE actor_id = ?1 AND idempotency_key = ?2`
    )
    .bind(claims.identityId, options.idempotencyKey)
    .first<{ payload_hash: string; receipt_json: string }>()

  if (existingCommand) {
    if (existingCommand.payload_hash !== payloadHash) {
      throw new CatalogAiGenerationError(
        'idempotency_conflict',
        'La clave de idempotencia ya fue utilizada con una carga distinta'
      )
    }
    return JSON.parse(existingCommand.receipt_json)
  }

  const row = await database
    .prepare(`SELECT * FROM catalog_ai_generations WHERE id = ?1`)
    .bind(generationId)
    .first<CatalogAiGenerationRow>()

  if (!row) {
    throw new CatalogAiGenerationError('not_found', `Generación ${generationId} no encontrada`)
  }

  // CAS check
  if (row.version !== input.expectedVersion) {
    throw new CatalogAiGenerationError(
      'concurrency_conflict',
      `Conflicto de concurrencia: versión esperada (${input.expectedVersion}) != actual (${row.version})`
    )
  }

  if (row.actor_id === claims.identityId) {
    throw new CatalogAiGenerationError('unauthorized', 'La revisión requiere una persona distinta del autor')
  }

  const newStatus =
    input.decision === 'approve' ? 'approved' : input.decision === 'reject' ? 'rejected' : 'modified_and_approved'

  const finalShortDescription = input.modifiedContent?.shortDescription ?? row.generated_short_description
  const finalDescription = input.modifiedContent?.description ?? row.generated_description
  const finalUsage = input.modifiedContent?.usage ?? row.generated_usage
  const finalAttributes = input.modifiedContent?.attributes
    ? JSON.stringify(input.modifiedContent.attributes)
    : row.generated_attributes_json
  const finalNotes = input.reviewNotes ?? row.review_notes
  const newVersion = row.version + 1

  const reviewUpdate = database
    .prepare(
      `UPDATE catalog_ai_generations
       SET approval_status = ?1,
           human_reviewed_at = ?2,
           human_reviewer_id = ?3,
           review_notes = ?4,
           generated_short_description = ?5,
           generated_description = ?6,
           generated_usage = ?7,
           generated_attributes_json = ?8,
           version = ?9,
           updated_at = ?10
       WHERE id = ?11 AND version = ?12`
    )
    .bind(
      newStatus,
      now,
      claims.identityId,
      finalNotes,
      finalShortDescription,
      finalDescription,
      finalUsage,
      finalAttributes,
      newVersion,
      now,
      generationId,
      row.version
    )

  const updatedRecord: CatalogAiGenerationRecord = {
    id: row.id,
    productId: row.product_id,
    targetScope: row.target_scope,
    actorId: row.actor_id,
    sources: JSON.parse(row.sources_json),
    prompt: row.prompt,
    generatedTitle: row.generated_title,
    generatedShortDescription: finalShortDescription,
    generatedDescription: finalDescription,
    generatedUsage: finalUsage,
    generatedAttributes: finalAttributes ? JSON.parse(finalAttributes) : null,
    verifiableClaims: JSON.parse(row.verifiable_claims_json),
    duplicateCheck: JSON.parse(row.duplicate_check_json),
    isAiGenerated: true,
    aiModelName: row.ai_model_name,
    approvalStatus: newStatus,
    humanReviewedAt: now,
    humanReviewerId: claims.identityId,
    appliedContent: row.applied_content_json ? JSON.parse(row.applied_content_json) : null,
    reviewNotes: finalNotes,
    version: newVersion,
    createdAt: row.created_at,
    updatedAt: now
  }

  // Commit the review and its receipt together, rechecking the live authority in the batch.
  const commandId = crypto.randomUUID()
  const reviewCommand = database
    .prepare(
      `INSERT INTO catalog_ai_generation_commands (
        command_id, generation_id, actor_id, action, idempotency_key,
        expected_version, result_version, payload_hash, input_json, receipt_json, created_at
      ) VALUES (
        ?1, ?2, ?3, 'human_review_decision',
        CASE WHEN EXISTS (
          SELECT 1 FROM auth_sessions s JOIN identities i ON i.id = s.identity_id
          WHERE s.id = ?11 AND s.identity_id = ?3 AND s.session_version = ?12
            AND i.session_version = s.session_version AND s.revoked_at IS NULL
            AND s.mfa_verified = 1 AND i.status IN ('pending', 'active')
            AND i.email_verified_at IS NOT NULL AND i.email_verified_at <= ?10
            AND s.created_at <= ?10 AND s.expires_at > max(?10, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
            AND EXISTS (
              SELECT 1 FROM identity_roles r JOIN role_permissions p ON p.role_code = r.role_code
              WHERE r.identity_id = i.id
                AND p.permission_code IN ('catalog.ai_generate', 'catalog.write', 'administration.manage')
                AND r.granted_at <= ?10
                AND (r.expires_at IS NULL OR r.expires_at > max(?10, strftime('%Y-%m-%dT%H:%M:%SZ', 'now')))
            )
        ) AND EXISTS (
          SELECT 1 FROM catalog_ai_generations g WHERE g.id = ?2 AND g.version = ?6
            AND g.human_reviewer_id = ?3 AND g.actor_id <> ?3
        ) THEN ?4 ELSE NULL END,
        ?5, ?6, ?7, ?8, ?9, ?10
      )`
    )
    .bind(
      commandId,
      generationId,
      claims.identityId,
      options.idempotencyKey,
      input.expectedVersion,
      newVersion,
      payloadHash,
      JSON.stringify(input),
      JSON.stringify(updatedRecord),
      now,
      claims.sessionId,
      claims.sessionVersion
    )
  try {
    await database.batch([reviewUpdate, reviewCommand])
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes('NOT NULL constraint failed: catalog_ai_generation_commands.idempotency_key')
    )
      throw new CatalogAiGenerationError('unauthorized', 'La autorización o revisión ya no es válida')
    return recoverConcurrentAiReceipt<CatalogAiGenerationRecord>(error, database, claims, options, payloadHash)
  }

  return updatedRecord
}

export async function applyD1CatalogAiGeneration(
  database: D1Database,
  claims: VerifiedSessionClaims,
  generationId: string,
  rawInput: unknown,
  options: CatalogAiOperationOptions
): Promise<{ applied: boolean; targetProductId: string; version: number }> {
  const parsed = ApplyCatalogGenerationInputSchema.safeParse(rawInput)
  if (!parsed.success) {
    throw new CatalogAiGenerationError('invalid_input', `Entrada inválida: ${parsed.error.message}`)
  }
  const input = parsed.data
  const now = getIsoNow(options)

  await verifyCatalogAiAuth(database, claims, now)
  const publisher = await authorizeD1Session(database, claims, 'catalog.publish', { now, requireMfa: true })
  if (!publisher.allowed) throw new CatalogAiGenerationError('unauthorized', 'Se requiere permiso de publicación')

  const payloadHash = await catalogAiPayloadHash('apply_to_product', { generationId, ...input })

  // Idempotency check
  const existingCommand = await database
    .prepare(
      `SELECT payload_hash, receipt_json FROM catalog_ai_generation_commands
       WHERE actor_id = ?1 AND idempotency_key = ?2`
    )
    .bind(claims.identityId, options.idempotencyKey)
    .first<{ payload_hash: string; receipt_json: string }>()

  if (existingCommand) {
    if (existingCommand.payload_hash !== payloadHash) {
      throw new CatalogAiGenerationError(
        'idempotency_conflict',
        'La clave de idempotencia ya fue utilizada con una carga distinta'
      )
    }
    return JSON.parse(existingCommand.receipt_json)
  }

  const row = await database
    .prepare(`SELECT * FROM catalog_ai_generations WHERE id = ?1`)
    .bind(generationId)
    .first<CatalogAiGenerationRow>()

  if (!row) {
    throw new CatalogAiGenerationError('not_found', `Generación ${generationId} no encontrada`)
  }

  // CAS check
  if (row.version !== input.expectedVersion) {
    throw new CatalogAiGenerationError(
      'concurrency_conflict',
      `Conflicto de concurrencia: versión esperada (${input.expectedVersion}) != actual (${row.version})`
    )
  }

  // Strict approval check: MUST be approved or modified_and_approved
  if (row.approval_status !== 'approved' && row.approval_status !== 'modified_and_approved') {
    throw new CatalogAiGenerationError(
      'not_approved',
      `No se puede aplicar contenido que no haya sido aprobado previamente por revisión humana (estado actual: ${row.approval_status})`
    )
  }
  if (!row.human_reviewer_id || row.human_reviewer_id === row.actor_id) {
    throw new CatalogAiGenerationError('not_approved', 'Se requiere una revisión independiente')
  }

  const appliedContent = {
    appliedAt: now,
    appliedBy: claims.identityId,
    targetProductId: input.targetProductId,
    shortDescription: row.generated_short_description,
    description: row.generated_description,
    usage: row.generated_usage,
    attributes: row.generated_attributes_json ? JSON.parse(row.generated_attributes_json) : {},
    aiAttribution: {
      isAiGenerated: true,
      generationId: row.id,
      modelName: row.ai_model_name,
      reviewedBy: row.human_reviewer_id,
      reviewedAt: row.human_reviewed_at
    }
  }

  const target = await database
    .prepare('SELECT id FROM products WHERE id = ?1')
    .bind(input.targetProductId)
    .first<{ id: string }>()
  if (!target) {
    throw new CatalogAiGenerationError('not_found', `Producto ${input.targetProductId} no encontrado`)
  }
  if (row.product_id && row.product_id !== input.targetProductId) {
    throw new CatalogAiGenerationError(
      'invalid_input',
      'La generación pertenece a otro producto y no puede aplicarse a este'
    )
  }

  const newVersion = row.version + 1
  const receipt = {
    applied: true,
    targetProductId: input.targetProductId,
    version: newVersion
  }

  // One atomic batch: the product is only touched while the generation is still at the version
  // that was reviewed, and the immutable command row (UNIQUE generation/result_version) rolls
  // everything back if a concurrent apply won the race.
  try {
    await database.batch([
      database
        .prepare(
          `UPDATE products
         SET short_description = COALESCE(?1, short_description),
             description = COALESCE(?2, description),
             usage = COALESCE(?3, usage),
             updated_at = ?4
         WHERE id = ?5
           AND EXISTS (SELECT 1 FROM catalog_ai_generations WHERE id = ?6 AND version = ?7)`
        )
        .bind(
          row.generated_short_description,
          row.generated_description,
          row.generated_usage,
          now,
          input.targetProductId,
          generationId,
          row.version
        ),
      database
        .prepare(
          `UPDATE catalog_ai_generations
         SET applied_content_json = ?1,
             version = ?2,
             updated_at = ?3
         WHERE id = ?4 AND version = ?5`
        )
        .bind(JSON.stringify(appliedContent), newVersion, now, generationId, row.version),
      database
        .prepare(
          `INSERT INTO catalog_ai_generation_commands (
          command_id, generation_id, actor_id, action, idempotency_key,
          expected_version, result_version, payload_hash, input_json, receipt_json, created_at
        ) VALUES (
          ?1, ?2, ?3, 'apply_to_product',
          CASE WHEN EXISTS (
            SELECT 1 FROM auth_sessions s
            JOIN identities i ON i.id = s.identity_id
            WHERE s.id = ?11 AND s.identity_id = ?3 AND s.session_version = ?12
              AND i.session_version = s.session_version AND s.revoked_at IS NULL
              AND s.mfa_verified = 1 AND i.status IN ('pending', 'active')
              AND i.email_verified_at IS NOT NULL AND i.email_verified_at <= ?10
              AND s.created_at <= ?10 AND s.expires_at > max(?10, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
              AND EXISTS (
                SELECT 1 FROM identity_roles r JOIN role_permissions p ON p.role_code = r.role_code
                WHERE r.identity_id = i.id AND p.permission_code = 'catalog.publish'
                  AND r.granted_at <= ?10
                  AND (r.expires_at IS NULL OR r.expires_at > max(?10, strftime('%Y-%m-%dT%H:%M:%SZ', 'now')))
              )
          ) AND EXISTS (
            SELECT 1 FROM catalog_ai_generations g JOIN products p ON p.id = ?13
            WHERE g.id = ?2 AND g.version = ?6
              AND g.approval_status IN ('approved', 'modified_and_approved')
              AND g.human_reviewer_id IS NOT NULL AND g.human_reviewer_id <> g.actor_id
              AND (g.product_id IS NULL OR g.product_id = p.id)
          ) THEN ?4 ELSE NULL END,
          ?5, ?6, ?7, ?8, ?9, ?10
        )`
        )
        .bind(
          crypto.randomUUID(),
          generationId,
          claims.identityId,
          options.idempotencyKey,
          input.expectedVersion,
          newVersion,
          payloadHash,
          JSON.stringify(input),
          JSON.stringify(receipt),
          now,
          claims.sessionId,
          claims.sessionVersion,
          input.targetProductId
        )
    ])
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes('NOT NULL constraint failed: catalog_ai_generation_commands.idempotency_key')
    )
      throw new CatalogAiGenerationError('unauthorized', 'La autorización o revisión ya no es válida')
    return recoverConcurrentAiReceipt<typeof receipt>(error, database, claims, options, payloadHash, 'catalog.publish')
  }
  return receipt
}

export async function readD1CatalogAiGeneration(
  database: D1Database,
  claims: VerifiedSessionClaims,
  generationId: string
): Promise<CatalogAiGenerationRecord> {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  await verifyCatalogAiAuth(database, claims, now)

  const row = await database
    .prepare(`SELECT * FROM catalog_ai_generations WHERE id = ?1`)
    .bind(generationId)
    .first<CatalogAiGenerationRow>()

  if (!row) {
    throw new CatalogAiGenerationError('not_found', `Generación ${generationId} no encontrada`)
  }

  return {
    id: row.id,
    productId: row.product_id,
    targetScope: row.target_scope,
    actorId: row.actor_id,
    sources: JSON.parse(row.sources_json),
    prompt: row.prompt,
    generatedTitle: row.generated_title,
    generatedShortDescription: row.generated_short_description,
    generatedDescription: row.generated_description,
    generatedUsage: row.generated_usage,
    generatedAttributes: row.generated_attributes_json ? JSON.parse(row.generated_attributes_json) : null,
    verifiableClaims: JSON.parse(row.verifiable_claims_json),
    duplicateCheck: JSON.parse(row.duplicate_check_json),
    isAiGenerated: true,
    aiModelName: row.ai_model_name,
    approvalStatus: row.approval_status,
    humanReviewedAt: row.human_reviewed_at,
    humanReviewerId: row.human_reviewer_id,
    appliedContent: row.applied_content_json ? JSON.parse(row.applied_content_json) : null,
    reviewNotes: row.review_notes,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export async function listD1CatalogAiGenerations(
  database: D1Database,
  claims: VerifiedSessionClaims,
  filters?: { productId?: string; status?: string }
): Promise<CatalogAiGenerationRecord[]> {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  await verifyCatalogAiAuth(database, claims, now)

  let sql = `SELECT * FROM catalog_ai_generations WHERE 1=1`
  const params: unknown[] = []

  if (filters?.productId) {
    params.push(filters.productId)
    sql += ` AND product_id = ?${params.length}`
  }
  if (filters?.status) {
    params.push(filters.status)
    sql += ` AND approval_status = ?${params.length}`
  }

  sql += ` ORDER BY created_at DESC LIMIT 50`

  const statement = database.prepare(sql)
  const rows =
    params.length > 0
      ? (await statement.bind(...params).all<CatalogAiGenerationRow>()).results
      : (await statement.all<CatalogAiGenerationRow>()).results

  return (rows || []).map((row) => ({
    id: row.id,
    productId: row.product_id,
    targetScope: row.target_scope,
    actorId: row.actor_id,
    sources: JSON.parse(row.sources_json),
    prompt: row.prompt,
    generatedTitle: row.generated_title,
    generatedShortDescription: row.generated_short_description,
    generatedDescription: row.generated_description,
    generatedUsage: row.generated_usage,
    generatedAttributes: row.generated_attributes_json ? JSON.parse(row.generated_attributes_json) : null,
    verifiableClaims: JSON.parse(row.verifiable_claims_json),
    duplicateCheck: JSON.parse(row.duplicate_check_json),
    isAiGenerated: true,
    aiModelName: row.ai_model_name,
    approvalStatus: row.approval_status,
    humanReviewedAt: row.human_reviewed_at,
    humanReviewerId: row.human_reviewer_id,
    appliedContent: row.applied_content_json ? JSON.parse(row.applied_content_json) : null,
    reviewNotes: row.review_notes,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }))
}
