import {
  type ProposeMediaEnrichmentInput,
  type DecideMediaEnrichmentInput,
  type ApplyMediaEnrichmentInput,
  type MediaAiEnrichmentRecord,
  type BackgroundRemovalProposal,
  type CropProposalItem,
  type MetadataProposal,
  type MediaAiEnrichmentType,
  type MediaAiApprovalStatus,
  ProposeMediaEnrichmentInputSchema,
  DecideMediaEnrichmentInputSchema,
  ApplyMediaEnrichmentInputSchema,
  MediaAiEnrichmentError,
  mediaAiPayloadHash,
  validateProhibitedInventions
} from '../../shared/media-ai-enrichment'
import { authorizeD1Session, type VerifiedSessionClaims } from './authorization'

interface MediaAiEnrichmentRow {
  id: string
  asset_id: string
  actor_id: string
  enrichment_type: MediaAiEnrichmentType
  original_metadata_json: string
  background_removal_json: string | null
  proposed_crops_json: string | null
  proposed_metadata_json: string | null
  prohibited_invention_check_json: string
  requires_human_approval: number
  approval_status: MediaAiApprovalStatus
  human_decided_at: string | null
  human_decider_id: string | null
  human_notes: string | null
  applied_to_asset_at: string | null
  version: number
  created_at: string
  updated_at: string
}

export interface MediaAiOperationOptions {
  idempotencyKey: string
  now?: () => string
}

function getIsoNow(options?: MediaAiOperationOptions): string {
  const custom = options?.now?.()
  if (custom) return custom
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

async function verifyMediaAiAuth(database: D1Database, claims: VerifiedSessionClaims, now: string): Promise<void> {
  const authDirect = await authorizeD1Session(database, claims, 'media.ai_enrich', { now, requireMfa: false })
  if (authDirect.allowed) return

  const authMedia = await authorizeD1Session(database, claims, 'media.write', { now, requireMfa: false })
  if (authMedia.allowed) return

  const authAdmin = await authorizeD1Session(database, claims, 'administration.manage', { now, requireMfa: false })
  if (authAdmin.allowed) return

  throw new MediaAiEnrichmentError(
    'unauthorized',
    'Permisos insuficientes: se requiere media.ai_enrich, media.write o administration.manage'
  )
}

export async function proposeD1MediaAiEnrichment(
  database: D1Database,
  claims: VerifiedSessionClaims,
  rawInput: unknown,
  options: MediaAiOperationOptions
): Promise<MediaAiEnrichmentRecord> {
  const parsed = ProposeMediaEnrichmentInputSchema.safeParse(rawInput)
  if (!parsed.success) {
    throw new MediaAiEnrichmentError('invalid_input', `Entrada inválida: ${parsed.error.message}`)
  }
  const input = parsed.data
  const now = getIsoNow(options)

  await verifyMediaAiAuth(database, claims, now)

  const payloadHash = await mediaAiPayloadHash('propose_enrichment', input)

  // 1. Idempotency check
  const existingCommand = await database
    .prepare(
      `SELECT payload_hash, receipt_json FROM media_ai_enrichment_commands
       WHERE actor_id = ?1 AND idempotency_key = ?2`
    )
    .bind(claims.identityId, options.idempotencyKey)
    .first<{ payload_hash: string; receipt_json: string }>()

  if (existingCommand) {
    if (existingCommand.payload_hash !== payloadHash) {
      throw new MediaAiEnrichmentError(
        'idempotency_conflict',
        'La clave de idempotencia ya fue utilizada con una carga distinta'
      )
    }
    return JSON.parse(existingCommand.receipt_json)
  }

  // 2. Read media asset
  const asset = await database
    .prepare(
      `SELECT id, storage_key, original_name, mime_type, byte_size, alt_text, metadata FROM media_assets WHERE id = ?1`
    )
    .bind(input.assetId)
    .first<{
      id: string
      storage_key: string
      original_name: string
      mime_type: string
      byte_size: number
      alt_text: string
      metadata: string
    }>()

  if (!asset) {
    throw new MediaAiEnrichmentError('not_found', `Activo multimedia ${input.assetId} no encontrado`)
  }

  // 3. Strict prohibited invention guardrail
  const inventionCheck = validateProhibitedInventions(
    `${input.options?.instruction || ''} ${input.options?.requestedAltKeywords?.join(' ') || ''}`
  )

  if (!inventionCheck.passed) {
    throw new MediaAiEnrichmentError(
      'prohibited_invention_detected',
      `Solicitud rechazada: La IA tiene prohibido inventar envases, claims o usos no certificados (términos detectados: ${inventionCheck.flaggedTokens.join(', ')})`
    )
  }

  let originalMetadata: Record<string, unknown>
  try {
    originalMetadata = JSON.parse(asset.metadata)
  } catch {
    originalMetadata = {}
  }

  // 4. Generate visual enrichment proposals
  let backgroundRemoval: BackgroundRemovalProposal | null = null
  if (input.enrichmentType === 'remove_background' || input.enrichmentType === 'full_visual_enrichment') {
    backgroundRemoval = {
      maskDescription: 'Máscara perimetral de recorte limpio sin alterar el envase físico',
      alphaCutoutStorageKey: `media/cutouts/${asset.id}-transparent.png`,
      backgroundType: 'transparent',
      edgeAccuracyScore: 0.98,
      noPackagingInvented: true
    }
  }

  let proposedCrops: CropProposalItem[] | null = null
  if (input.enrichmentType === 'propose_crops' || input.enrichmentType === 'full_visual_enrichment') {
    proposedCrops = [
      { ratio: '1:1', purpose: 'catalog_thumbnail', x: 0, y: 0, width: 800, height: 800 },
      { ratio: '4:3', purpose: 'gallery_main', x: 0, y: 50, width: 800, height: 600 },
      { ratio: '16:9', purpose: 'banner', x: 0, y: 100, width: 800, height: 450 }
    ]
  }

  let proposedMetadata: MetadataProposal | null = null
  if (input.enrichmentType === 'propose_metadata' || input.enrichmentType === 'full_visual_enrichment') {
    const prodName = input.options?.contextProductName ? ` de ${input.options.contextProductName}` : ''
    const suggestedAltText = `Envase original${prodName} en fondo limpio neutro, presentación técnica Neteco (${asset.original_name})`

    proposedMetadata = {
      suggestedAltText,
      dominantColors: ['#FFFFFF', '#1E3A8A'],
      focalPoint: { x: 0.5, y: 0.5 },
      noFictionalClaimsOrBadges: true
    }
  }

  const enrichmentId = crypto.randomUUID()

  const record: MediaAiEnrichmentRecord = {
    id: enrichmentId,
    assetId: input.assetId,
    actorId: claims.identityId,
    enrichmentType: input.enrichmentType,
    originalMetadata,
    backgroundRemoval,
    proposedCrops,
    proposedMetadata,
    prohibitedInventionCheck: inventionCheck,
    requiresHumanApproval: true,
    approvalStatus: 'pending_approval',
    humanDecidedAt: null,
    humanDeciderId: null,
    humanNotes: null,
    appliedToAssetAt: null,
    version: 1,
    createdAt: now,
    updatedAt: now
  }

  // Write to D1
  await database
    .prepare(
      `INSERT INTO media_ai_enrichments (
        id, asset_id, actor_id, enrichment_type, original_metadata_json,
        background_removal_json, proposed_crops_json, proposed_metadata_json,
        prohibited_invention_check_json, requires_human_approval, approval_status,
        human_decided_at, human_decider_id, human_notes, applied_to_asset_at,
        version, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1, 'pending_approval', NULL, NULL, NULL, NULL, 1, ?10, ?10)`
    )
    .bind(
      record.id,
      record.assetId,
      record.actorId,
      record.enrichmentType,
      JSON.stringify(record.originalMetadata),
      record.backgroundRemoval ? JSON.stringify(record.backgroundRemoval) : null,
      record.proposedCrops ? JSON.stringify(record.proposedCrops) : null,
      record.proposedMetadata ? JSON.stringify(record.proposedMetadata) : null,
      JSON.stringify(record.prohibitedInventionCheck),
      now
    )
    .run()

  // Record command in append-only table
  const commandId = crypto.randomUUID()
  await database
    .prepare(
      `INSERT INTO media_ai_enrichment_commands (
        command_id, enrichment_id, actor_id, action, idempotency_key,
        expected_version, result_version, payload_hash, input_json, receipt_json, created_at
      ) VALUES (?1, ?2, ?3, 'propose_enrichment', ?4, 0, 1, ?5, ?6, ?7, ?8)`
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

export async function decideD1MediaAiEnrichment(
  database: D1Database,
  claims: VerifiedSessionClaims,
  enrichmentId: string,
  rawInput: unknown,
  options: MediaAiOperationOptions
): Promise<MediaAiEnrichmentRecord> {
  const parsed = DecideMediaEnrichmentInputSchema.safeParse(rawInput)
  if (!parsed.success) {
    throw new MediaAiEnrichmentError('invalid_input', `Decisión inválida: ${parsed.error.message}`)
  }
  const input = parsed.data
  const now = getIsoNow(options)

  await verifyMediaAiAuth(database, claims, now)

  const payloadHash = await mediaAiPayloadHash('human_decision', { enrichmentId, ...input })

  // Idempotency check
  const existingCommand = await database
    .prepare(
      `SELECT payload_hash, receipt_json FROM media_ai_enrichment_commands
       WHERE actor_id = ?1 AND idempotency_key = ?2`
    )
    .bind(claims.identityId, options.idempotencyKey)
    .first<{ payload_hash: string; receipt_json: string }>()

  if (existingCommand) {
    if (existingCommand.payload_hash !== payloadHash) {
      throw new MediaAiEnrichmentError(
        'idempotency_conflict',
        'La clave de idempotencia ya fue utilizada con una carga distinta'
      )
    }
    return JSON.parse(existingCommand.receipt_json)
  }

  const row = await database
    .prepare(`SELECT * FROM media_ai_enrichments WHERE id = ?1`)
    .bind(enrichmentId)
    .first<MediaAiEnrichmentRow>()

  if (!row) {
    throw new MediaAiEnrichmentError('not_found', `Propuesta de enriquecimiento ${enrichmentId} no encontrada`)
  }

  // CAS check
  if (row.version !== input.expectedVersion) {
    throw new MediaAiEnrichmentError(
      'concurrency_conflict',
      `Conflicto de concurrencia: versión esperada (${input.expectedVersion}) != actual (${row.version})`
    )
  }

  const newStatus =
    input.decision === 'approve' ? 'approved' : input.decision === 'reject' ? 'rejected' : 'modified_and_approved'

  const proposedMetadata = row.proposed_metadata_json ? JSON.parse(row.proposed_metadata_json) : null
  if (proposedMetadata && input.modifiedAltText) {
    proposedMetadata.suggestedAltText = input.modifiedAltText
  }

  const proposedCrops = input.modifiedCrops ? JSON.stringify(input.modifiedCrops) : row.proposed_crops_json

  const finalNotes = input.humanNotes ?? row.human_notes
  const newVersion = row.version + 1

  await database
    .prepare(
      `UPDATE media_ai_enrichments
       SET approval_status = ?1,
           human_decided_at = ?2,
           human_decider_id = ?3,
           human_notes = ?4,
           proposed_metadata_json = ?5,
           proposed_crops_json = ?6,
           version = ?7,
           updated_at = ?8
       WHERE id = ?9 AND version = ?10`
    )
    .bind(
      newStatus,
      now,
      claims.identityId,
      finalNotes,
      proposedMetadata ? JSON.stringify(proposedMetadata) : null,
      proposedCrops,
      newVersion,
      now,
      enrichmentId,
      row.version
    )
    .run()

  const updatedRecord: MediaAiEnrichmentRecord = {
    id: row.id,
    assetId: row.asset_id,
    actorId: row.actor_id,
    enrichmentType: row.enrichment_type,
    originalMetadata: JSON.parse(row.original_metadata_json),
    backgroundRemoval: row.background_removal_json ? JSON.parse(row.background_removal_json) : null,
    proposedCrops: proposedCrops ? JSON.parse(proposedCrops) : null,
    proposedMetadata,
    prohibitedInventionCheck: JSON.parse(row.prohibited_invention_check_json),
    requiresHumanApproval: true,
    approvalStatus: newStatus,
    humanDecidedAt: now,
    humanDeciderId: claims.identityId,
    humanNotes: finalNotes,
    appliedToAssetAt: row.applied_to_asset_at,
    version: newVersion,
    createdAt: row.created_at,
    updatedAt: now
  }

  // Record command
  const commandId = crypto.randomUUID()
  await database
    .prepare(
      `INSERT INTO media_ai_enrichment_commands (
        command_id, enrichment_id, actor_id, action, idempotency_key,
        expected_version, result_version, payload_hash, input_json, receipt_json, created_at
      ) VALUES (?1, ?2, ?3, 'human_decision', ?4, ?5, ?6, ?7, ?8, ?9, ?10)`
    )
    .bind(
      commandId,
      enrichmentId,
      claims.identityId,
      options.idempotencyKey,
      input.expectedVersion,
      newVersion,
      payloadHash,
      JSON.stringify(input),
      JSON.stringify(updatedRecord),
      now
    )
    .run()

  return updatedRecord
}

export async function applyD1MediaAiEnrichment(
  database: D1Database,
  claims: VerifiedSessionClaims,
  enrichmentId: string,
  rawInput: unknown,
  options: MediaAiOperationOptions
): Promise<{ applied: boolean; assetId: string; version: number }> {
  const parsed = ApplyMediaEnrichmentInputSchema.safeParse(rawInput)
  if (!parsed.success) {
    throw new MediaAiEnrichmentError('invalid_input', `Entrada inválida: ${parsed.error.message}`)
  }
  const input = parsed.data
  const now = getIsoNow(options)

  await verifyMediaAiAuth(database, claims, now)

  const payloadHash = await mediaAiPayloadHash('apply_enrichment', { enrichmentId, ...input })

  // Idempotency check
  const existingCommand = await database
    .prepare(
      `SELECT payload_hash, receipt_json FROM media_ai_enrichment_commands
       WHERE actor_id = ?1 AND idempotency_key = ?2`
    )
    .bind(claims.identityId, options.idempotencyKey)
    .first<{ payload_hash: string; receipt_json: string }>()

  if (existingCommand) {
    if (existingCommand.payload_hash !== payloadHash) {
      throw new MediaAiEnrichmentError(
        'idempotency_conflict',
        'La clave de idempotencia ya fue utilizada con una carga distinta'
      )
    }
    return JSON.parse(existingCommand.receipt_json)
  }

  const row = await database
    .prepare(`SELECT * FROM media_ai_enrichments WHERE id = ?1`)
    .bind(enrichmentId)
    .first<MediaAiEnrichmentRow>()

  if (!row) {
    throw new MediaAiEnrichmentError('not_found', `Propuesta de enriquecimiento ${enrichmentId} no encontrada`)
  }

  // CAS check
  if (row.version !== input.expectedVersion) {
    throw new MediaAiEnrichmentError(
      'concurrency_conflict',
      `Conflicto de concurrencia: versión esperada (${input.expectedVersion}) != actual (${row.version})`
    )
  }

  // Strict approval check: MUST be approved or modified_and_approved
  if (row.approval_status !== 'approved' && row.approval_status !== 'modified_and_approved') {
    throw new MediaAiEnrichmentError(
      'not_approved',
      `No se puede aplicar un enriquecimiento que no haya sido aprobado por revisión humana (estado: ${row.approval_status})`
    )
  }

  if (row.asset_id !== input.targetAssetId) {
    throw new MediaAiEnrichmentError('invalid_input', 'La propuesta pertenece a otro activo multimedia')
  }

  const proposedMeta = row.proposed_metadata_json ? JSON.parse(row.proposed_metadata_json) : null
  const proposedCrops = row.proposed_crops_json ? JSON.parse(row.proposed_crops_json) : null
  const backgroundRemoval = row.background_removal_json ? JSON.parse(row.background_removal_json) : null

  // Fetch current media asset
  const asset = await database
    .prepare(`SELECT alt_text, metadata FROM media_assets WHERE id = ?1`)
    .bind(input.targetAssetId)
    .first<{ alt_text: string; metadata: string }>()

  if (!asset) {
    throw new MediaAiEnrichmentError('not_found', `Activo multimedia ${input.targetAssetId} no encontrado`)
  }

  let assetMeta: Record<string, unknown>
  try {
    assetMeta = JSON.parse(asset.metadata)
  } catch {
    assetMeta = {}
  }

  assetMeta.aiEnrichment = {
    enrichmentId: row.id,
    appliedAt: now,
    appliedBy: claims.identityId,
    crops: proposedCrops,
    backgroundRemoval,
    dominantColors: proposedMeta?.dominantColors
  }

  const newAltText = proposedMeta?.suggestedAltText || asset.alt_text

  const newVersion = row.version + 1
  const receipt = {
    applied: true,
    assetId: input.targetAssetId,
    version: newVersion
  }

  // Atomic: the asset is only touched while the enrichment is still at the reviewed version, and
  // the immutable command row (UNIQUE enrichment/result_version) rolls back a lost race.
  await database.batch([
    database
      .prepare(
        `UPDATE media_assets
         SET alt_text = ?1,
             metadata = ?2
         WHERE id = ?3
           AND EXISTS (SELECT 1 FROM media_ai_enrichments WHERE id = ?4 AND version = ?5)`
      )
      .bind(newAltText, JSON.stringify(assetMeta), input.targetAssetId, enrichmentId, row.version),
    database
      .prepare(
        `UPDATE media_ai_enrichments
         SET applied_to_asset_at = ?1,
             version = ?2,
             updated_at = ?3
         WHERE id = ?4 AND version = ?5`
      )
      .bind(now, newVersion, now, enrichmentId, row.version),
    database
      .prepare(
        `INSERT INTO media_ai_enrichment_commands (
          command_id, enrichment_id, actor_id, action, idempotency_key,
          expected_version, result_version, payload_hash, input_json, receipt_json, created_at
        ) VALUES (?1, ?2, ?3, 'apply_enrichment', ?4, ?5, ?6, ?7, ?8, ?9, ?10)`
      )
      .bind(
        crypto.randomUUID(),
        enrichmentId,
        claims.identityId,
        options.idempotencyKey,
        input.expectedVersion,
        newVersion,
        payloadHash,
        JSON.stringify(input),
        JSON.stringify(receipt),
        now
      )
  ])

  return receipt
}

export async function readD1MediaAiEnrichment(
  database: D1Database,
  claims: VerifiedSessionClaims,
  enrichmentId: string
): Promise<MediaAiEnrichmentRecord> {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  await verifyMediaAiAuth(database, claims, now)

  const row = await database
    .prepare(`SELECT * FROM media_ai_enrichments WHERE id = ?1`)
    .bind(enrichmentId)
    .first<MediaAiEnrichmentRow>()

  if (!row) {
    throw new MediaAiEnrichmentError('not_found', `Enriquecimiento ${enrichmentId} no encontrado`)
  }

  return {
    id: row.id,
    assetId: row.asset_id,
    actorId: row.actor_id,
    enrichmentType: row.enrichment_type,
    originalMetadata: JSON.parse(row.original_metadata_json),
    backgroundRemoval: row.background_removal_json ? JSON.parse(row.background_removal_json) : null,
    proposedCrops: row.proposed_crops_json ? JSON.parse(row.proposed_crops_json) : null,
    proposedMetadata: row.proposed_metadata_json ? JSON.parse(row.proposed_metadata_json) : null,
    prohibitedInventionCheck: JSON.parse(row.prohibited_invention_check_json),
    requiresHumanApproval: true,
    approvalStatus: row.approval_status,
    humanDecidedAt: row.human_decided_at,
    humanDeciderId: row.human_decider_id,
    humanNotes: row.human_notes,
    appliedToAssetAt: row.applied_to_asset_at,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export async function listD1MediaAiEnrichments(
  database: D1Database,
  claims: VerifiedSessionClaims,
  filters?: { assetId?: string; status?: string }
): Promise<MediaAiEnrichmentRecord[]> {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  await verifyMediaAiAuth(database, claims, now)

  let sql = `SELECT * FROM media_ai_enrichments WHERE 1=1`
  const params: unknown[] = []

  if (filters?.assetId) {
    params.push(filters.assetId)
    sql += ` AND asset_id = ?${params.length}`
  }
  if (filters?.status) {
    params.push(filters.status)
    sql += ` AND approval_status = ?${params.length}`
  }

  sql += ` ORDER BY created_at DESC LIMIT 50`

  const statement = database.prepare(sql)
  const rows =
    params.length > 0
      ? (await statement.bind(...params).all<MediaAiEnrichmentRow>()).results
      : (await statement.all<MediaAiEnrichmentRow>()).results

  return (rows || []).map((row) => ({
    id: row.id,
    assetId: row.asset_id,
    actorId: row.actor_id,
    enrichmentType: row.enrichment_type,
    originalMetadata: JSON.parse(row.original_metadata_json),
    backgroundRemoval: row.background_removal_json ? JSON.parse(row.background_removal_json) : null,
    proposedCrops: row.proposed_crops_json ? JSON.parse(row.proposed_crops_json) : null,
    proposedMetadata: row.proposed_metadata_json ? JSON.parse(row.proposed_metadata_json) : null,
    prohibitedInventionCheck: JSON.parse(row.prohibited_invention_check_json),
    requiresHumanApproval: true,
    approvalStatus: row.approval_status,
    humanDecidedAt: row.human_decided_at,
    humanDeciderId: row.human_decider_id,
    humanNotes: row.human_notes,
    appliedToAssetAt: row.applied_to_asset_at,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }))
}
