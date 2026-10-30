import {
  detectHiddenIncentives,
  evaluateUgcReviewPayloadHash,
  moderateUgcReviewSchema,
  scanPhotoAntivirus,
  scanTextForPii,
  submitUgcReviewSchema,
  withdrawUgcReviewSchema,
  type PublicUgcPhoto,
  type PublicUgcReview,
  type SubmitUgcReviewInput,
  type ModerateUgcReviewInput,
  type WithdrawUgcReviewInput,
  type UgcPhotoMimeType
} from '../../shared/ugc-reviews'

export class UgcReviewError extends Error {
  constructor(
    readonly code:
      | 'invalid_input'
      | 'not_found'
      | 'unauthorized'
      | 'forbidden'
      | 'version_conflict'
      | 'idempotency_conflict'
      | 'malware_detected'
      | 'already_withdrawn'
      | 'cannot_withdraw'
  ) {
    super(code)
    this.name = 'UgcReviewError'
  }
}

export const liveAdminSql = (param: string) =>
  `EXISTS(SELECT 1 FROM identities i JOIN identity_roles ir ON ir.identity_id = i.id
     JOIN role_permissions rp ON rp.role_code = ir.role_code
     WHERE i.id = ${param} AND i.status = 'active' AND rp.permission_code = 'administration.manage'
       AND (ir.expires_at IS NULL OR ir.expires_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now')))`

export async function requireAdmin(db: D1Database, identityId: string): Promise<void> {
  const row = await db
    .prepare(`SELECT ${liveAdminSql('?1')} AS ok`)
    .bind(identityId)
    .first<{ ok: number }>()
  if (!row?.ok) throw new UgcReviewError('forbidden')
}

interface UgcReviewRow {
  id: string
  product_id: string
  customer_id: string
  order_id: string | null
  rating: number
  title: string
  content: string
  display_name: string
  is_verified_buyer: number
  moderation_status: string
  moderation_reason: string | null
  moderated_at: string | null
  moderated_by: string | null
  consent_accepted: number
  consent_version: string
  consent_at: string
  license_terms: string
  rights_confirmed: number
  has_incentive: number
  incentive_type: string
  incentive_description: string | null
  hidden_incentive_suspected: number
  pii_detected: number
  pii_details_json: string
  pii_redacted_content: string | null
  withdrawn_at: string | null
  withdrawn_by: string | null
  withdrawn_reason: string | null
  version: number
  created_at: string
  updated_at: string
}

interface UgcPhotoRow {
  id: string
  review_id: string
  storage_key: string
  photo_url: string
  mime_type: string
  file_size_bytes: number
  sha256: string
  width: number
  height: number
  antivirus_status: string
  antivirus_scanner: string
  antivirus_scan_at: string | null
  antivirus_signature: string | null
  moderation_status: string
  moderation_reason: string | null
  sort_order: number
  created_at: string
}

export interface SubmitUgcReviewParams {
  actorId: string
  now?: string
  input: SubmitUgcReviewInput & { photos?: Array<SubmitUgcReviewInput['photos'][number] & { base64Data?: string }> }
}

export interface UgcReviewResult {
  id: string
  productId: string
  rating: number
  title: string
  content: string
  displayName: string
  isVerifiedBuyer: boolean
  moderationStatus: string
  hasIncentive: boolean
  incentiveType: string
  hiddenIncentiveSuspected: boolean
  piiDetected: boolean
  piiDetails: unknown[]
  piiRedactedContent: string | null
  version: number
  photos: Array<{
    id: string
    photoUrl: string
    mimeType: string
    width: number
    height: number
    antivirusStatus: string
    moderationStatus: string
  }>
  createdAt: string
}

export async function submitUgcReview(db: D1Database, params: SubmitUgcReviewParams): Promise<UgcReviewResult> {
  const parsed = submitUgcReviewSchema.safeParse(params.input)
  if (!parsed.success) throw new UgcReviewError('invalid_input')

  const now = params.now ?? new Date().toISOString()
  const reviewId = params.input.commandId // deterministic review ID tied to commandId
  const payloadHash = await evaluateUgcReviewPayloadHash(parsed.data)

  // 1. Idempotency check
  const existingCmd = await db
    .prepare('SELECT applied_version, payload_hash FROM ugc_commands WHERE entity_id = ? AND command_id = ?')
    .bind(reviewId, params.input.commandId)
    .first<{ applied_version: number; payload_hash: string }>()

  if (existingCmd) {
    if (existingCmd.payload_hash !== payloadHash) throw new UgcReviewError('idempotency_conflict')
    const existing = await getUgcReviewById(db, reviewId)
    if (existing) return existing
  }

  // 2. Buyer verification
  let isVerifiedBuyer = 0
  if (params.input.orderId) {
    const orderMatch = await db
      .prepare('SELECT 1 FROM orders WHERE id = ? AND customer_id = ?')
      .bind(params.input.orderId, params.actorId)
      .first()
    if (orderMatch) isVerifiedBuyer = 1
  } else {
    const anyOrder = await db.prepare('SELECT 1 FROM orders WHERE customer_id = ?').bind(params.actorId).first()
    if (anyOrder) isVerifiedBuyer = 1
  }

  // 3. PII Scan
  const piiScan = scanTextForPii(parsed.data.content)

  // 4. Hidden Incentive Check
  const incCheck = detectHiddenIncentives(parsed.data.content, parsed.data.incentiveType)

  // 5. Antivirus scan on photos
  const rawPhotos = parsed.data.photos ?? []
  let anyMalware = false

  const processedPhotos = rawPhotos.map((photo, index) => {
    const photoId = `photo-${reviewId}-${index + 1}`
    let avStatus: 'clean' | 'infected' | 'quarantined' = 'clean'
    let avSig: string | null = null

    if (photo.base64Data) {
      const buffer = Buffer.from(photo.base64Data, 'base64')
      const scan = scanPhotoAntivirus({
        bytes: buffer,
        mimeType: photo.mimeType,
        sha256: photo.sha256,
        now
      })
      avStatus = scan.status
      avSig = scan.signature
      if (scan.status === 'infected' || scan.status === 'quarantined') {
        anyMalware = true
      }
    }

    const photoModStatus = avStatus === 'clean' ? 'pending' : 'quarantined'

    return {
      id: photoId,
      storageKey: photo.storageKey,
      photoUrl: photo.photoUrl,
      mimeType: photo.mimeType,
      fileSizeBytes: photo.fileSizeBytes,
      sha256: photo.sha256,
      width: photo.width,
      height: photo.height,
      antivirusStatus: avStatus,
      antivirusScanner: 'neteco-antivirus-gateway-v1',
      antivirusScanAt: now,
      antivirusSignature: avSig,
      moderationStatus: photoModStatus,
      sortOrder: index
    }
  })

  const reviewModerationStatus = anyMalware ? 'quarantined' : 'pending'
  const moderationReason = anyMalware ? 'Contiene fotografía infectada o dañada bloqueada por antivirus' : null

  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO ugc_reviews (
          id, product_id, customer_id, order_id, rating, title, content,
          display_name, is_verified_buyer, moderation_status, moderation_reason,
          consent_accepted, consent_version, consent_at, license_terms, rights_confirmed,
          has_incentive, incentive_type, incentive_description, hidden_incentive_suspected,
          pii_detected, pii_details_json, pii_redacted_content,
          version, created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6, ?7,
          ?8, ?9, ?10, ?11,
          1, ?12, ?13, ?14, 1,
          ?15, ?16, ?17, ?18,
          ?19, ?20, ?21,
          1, ?13, ?13
        )`
      )
      .bind(
        reviewId,
        parsed.data.productId,
        params.actorId,
        parsed.data.orderId ?? null,
        parsed.data.rating,
        parsed.data.title,
        parsed.data.content,
        parsed.data.displayName,
        isVerifiedBuyer,
        reviewModerationStatus,
        moderationReason,
        parsed.data.consentVersion ?? '2026-ugc-v1',
        now,
        parsed.data.licenseTerms,
        parsed.data.hasIncentive ? 1 : 0,
        parsed.data.incentiveType,
        parsed.data.incentiveDescription ?? null,
        incCheck.hiddenIncentiveSuspected ? 1 : 0,
        piiScan.piiDetected ? 1 : 0,
        JSON.stringify(piiScan.piiMatches),
        piiScan.piiDetected ? piiScan.redactedText : null
      ),
    db
      .prepare(
        `INSERT INTO ugc_commands (
          id, actor_id, entity_id, action, command_id,
          expected_version, applied_version, payload_hash, payload_json, created_at
        ) VALUES (
          ?1, ?2, ?3, 'submit_ugc_review', ?4,
          0, 1, ?5, ?6, ?7
        )`
      )
      .bind(
        `cmd-audit-${reviewId}`,
        params.actorId,
        reviewId,
        params.input.commandId,
        payloadHash,
        JSON.stringify(parsed.data),
        now
      )
  ]

  for (const p of processedPhotos) {
    statements.push(
      db
        .prepare(
          `INSERT INTO ugc_review_photos (
            id, review_id, storage_key, photo_url, mime_type, file_size_bytes,
            sha256, width, height, antivirus_status, antivirus_scanner, antivirus_scan_at,
            antivirus_signature, moderation_status, sort_order, created_at
          ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6,
            ?7, ?8, ?9, ?10, ?11, ?12,
            ?13, ?14, ?15, ?12
          )`
        )
        .bind(
          p.id,
          reviewId,
          p.storageKey,
          p.photoUrl,
          p.mimeType,
          p.fileSizeBytes,
          p.sha256,
          p.width,
          p.height,
          p.antivirusStatus,
          p.antivirusScanner,
          p.antivirusScanAt,
          p.antivirusSignature,
          p.moderationStatus,
          p.sortOrder
        )
    )
  }

  await db.batch(statements)

  return {
    id: reviewId,
    productId: params.input.productId,
    rating: params.input.rating,
    title: params.input.title,
    content: params.input.content,
    displayName: params.input.displayName,
    isVerifiedBuyer: isVerifiedBuyer === 1,
    moderationStatus: reviewModerationStatus,
    hasIncentive: params.input.hasIncentive,
    incentiveType: params.input.incentiveType,
    hiddenIncentiveSuspected: incCheck.hiddenIncentiveSuspected,
    piiDetected: piiScan.piiDetected,
    piiDetails: piiScan.piiMatches,
    piiRedactedContent: piiScan.piiDetected ? piiScan.redactedText : null,
    version: 1,
    photos: processedPhotos.map((p) => ({
      id: p.id,
      photoUrl: p.photoUrl,
      mimeType: p.mimeType,
      width: p.width,
      height: p.height,
      antivirusStatus: p.antivirusStatus,
      moderationStatus: p.moderationStatus
    })),
    createdAt: now
  }
}

export interface ModerateUgcReviewParams {
  actorId: string
  now?: string
  input: ModerateUgcReviewInput
}

export async function moderateUgcReview(db: D1Database, params: ModerateUgcReviewParams): Promise<UgcReviewResult> {
  await requireAdmin(db, params.actorId)

  const parsed = moderateUgcReviewSchema.safeParse(params.input)
  if (!parsed.success) throw new UgcReviewError('invalid_input')

  const now = params.now ?? new Date().toISOString()
  const payloadHash = await evaluateUgcReviewPayloadHash(parsed.data)

  const review = await db
    .prepare('SELECT id, version, moderation_status FROM ugc_reviews WHERE id = ?')
    .bind(params.input.reviewId)
    .first<{ id: string; version: number; moderation_status: string }>()

  if (!review) throw new UgcReviewError('not_found')
  if (review.version !== params.input.expectedVersion) throw new UgcReviewError('version_conflict')

  const targetStatus =
    params.input.action === 'approve' ? 'approved' : params.input.action === 'reject' ? 'rejected' : 'quarantined'
  const newVersion = review.version + 1

  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE ugc_reviews SET
          moderation_status = ?1, moderation_reason = ?2, moderated_at = ?3,
          moderated_by = ?4, version = ?5, updated_at = ?3
        WHERE id = ?6 AND version = ?7`
      )
      .bind(targetStatus, params.input.reason, now, params.actorId, newVersion, params.input.reviewId, review.version),
    db
      .prepare(
        `INSERT INTO ugc_commands (
          id, actor_id, entity_id, action, command_id,
          expected_version, applied_version, payload_hash, payload_json, created_at
        ) VALUES (
          ?1, ?2, ?3, 'moderate_ugc_review', ?4,
          ?5, ?6, ?7, ?8, ?9
        )`
      )
      .bind(
        `cmd-audit-${params.input.commandId}`,
        params.actorId,
        params.input.reviewId,
        params.input.commandId,
        review.version,
        newVersion,
        payloadHash,
        JSON.stringify(parsed.data),
        now
      )
  ]

  // If specific photo moderations provided:
  if (params.input.photoModerations && params.input.photoModerations.length > 0) {
    for (const pm of params.input.photoModerations) {
      const photoStatus = pm.action === 'approve' ? 'approved' : pm.action === 'reject' ? 'rejected' : 'quarantined'
      statements.push(
        db
          .prepare(
            `UPDATE ugc_review_photos SET
              moderation_status = ?1, moderation_reason = ?2
            WHERE id = ?3 AND review_id = ?4`
          )
          .bind(photoStatus, pm.reason ?? null, pm.photoId, params.input.reviewId)
      )
    }
  } else if (targetStatus === 'approved') {
    // Default: approve clean photos
    statements.push(
      db
        .prepare(
          `UPDATE ugc_review_photos SET moderation_status = 'approved'
           WHERE review_id = ?1 AND antivirus_status = 'clean'`
        )
        .bind(params.input.reviewId)
    )
  }

  await db.batch(statements)

  const updated = await getUgcReviewById(db, params.input.reviewId)
  if (!updated) throw new UgcReviewError('not_found')
  return updated
}

export async function moderateUgcPhoto(
  db: D1Database,
  params: {
    actorId: string
    photoId: string
    reviewId: string
    action: 'approve' | 'reject' | 'quarantine'
    reason?: string
    now?: string
  }
): Promise<void> {
  await requireAdmin(db, params.actorId)

  await db
    .prepare(
      `UPDATE ugc_review_photos SET moderation_status = ?1, moderation_reason = ?2
       WHERE id = ?3 AND review_id = ?4`
    )
    .bind(params.action, params.reason ?? null, params.photoId, params.reviewId)
    .run()
}

export interface WithdrawUgcReviewParams {
  actorId: string
  now?: string
  input: WithdrawUgcReviewInput
}

export async function withdrawUgcReview(db: D1Database, params: WithdrawUgcReviewParams): Promise<UgcReviewResult> {
  const parsed = withdrawUgcReviewSchema.safeParse(params.input)
  if (!parsed.success) throw new UgcReviewError('invalid_input')

  const now = params.now ?? new Date().toISOString()
  const payloadHash = await evaluateUgcReviewPayloadHash(parsed.data)

  const review = await db
    .prepare('SELECT id, customer_id, version, moderation_status FROM ugc_reviews WHERE id = ?')
    .bind(params.input.reviewId)
    .first<{ id: string; customer_id: string; version: number; moderation_status: string }>()

  if (!review) throw new UgcReviewError('not_found')
  if (review.moderation_status === 'withdrawn') throw new UgcReviewError('already_withdrawn')
  if (review.version !== params.input.expectedVersion) throw new UgcReviewError('version_conflict')

  // Check authority: Author customer OR Admin
  if (review.customer_id !== params.actorId) {
    await requireAdmin(db, params.actorId)
  }

  const newVersion = review.version + 1

  await db.batch([
    db
      .prepare(
        `UPDATE ugc_reviews SET
          moderation_status = 'withdrawn', withdrawn_at = ?1, withdrawn_by = ?2,
          withdrawn_reason = ?3, version = ?4, updated_at = ?1
        WHERE id = ?5 AND version = ?6`
      )
      .bind(
        now,
        params.actorId,
        params.input.reason + (params.input.notes ? `: ${params.input.notes}` : ''),
        newVersion,
        params.input.reviewId,
        review.version
      ),
    db
      .prepare(
        `INSERT INTO ugc_commands (
          id, actor_id, entity_id, action, command_id,
          expected_version, applied_version, payload_hash, payload_json, created_at
        ) VALUES (
          ?1, ?2, ?3, 'withdraw_ugc_review', ?4,
          ?5, ?6, ?7, ?8, ?9
        )`
      )
      .bind(
        `cmd-audit-${params.input.commandId}`,
        params.actorId,
        params.input.reviewId,
        params.input.commandId,
        review.version,
        newVersion,
        payloadHash,
        JSON.stringify(parsed.data),
        now
      )
  ])

  const updated = await getUgcReviewById(db, params.input.reviewId)
  if (!updated) throw new UgcReviewError('not_found')
  return updated
}

export async function redactUgcPii(
  db: D1Database,
  params: {
    actorId: string
    reviewId: string
    redactedContent: string
    expectedVersion: number
    commandId: string
    now?: string
  }
): Promise<void> {
  const review = await db
    .prepare('SELECT id, customer_id, version FROM ugc_reviews WHERE id = ?')
    .bind(params.reviewId)
    .first<{ id: string; customer_id: string; version: number }>()

  if (!review) throw new UgcReviewError('not_found')
  if (review.version !== params.expectedVersion) throw new UgcReviewError('version_conflict')
  if (review.customer_id !== params.actorId) {
    await requireAdmin(db, params.actorId)
  }

  const now = params.now ?? new Date().toISOString()
  const newVersion = review.version + 1

  await db.batch([
    db
      .prepare(
        `UPDATE ugc_reviews SET
          pii_redacted_content = ?1, pii_detected = 0, version = ?2, updated_at = ?3
        WHERE id = ?4 AND version = ?5`
      )
      .bind(params.redactedContent, newVersion, now, params.reviewId, review.version),
    db
      .prepare(
        `INSERT INTO ugc_commands (
          id, actor_id, entity_id, action, command_id,
          expected_version, applied_version, payload_hash, payload_json, created_at
        ) VALUES (
          ?1, ?2, ?3, 'redact_ugc_pii', ?4,
          ?5, ?6, ?7, ?8, ?9
        )`
      )
      .bind(
        `cmd-audit-${params.commandId}`,
        params.actorId,
        params.reviewId,
        params.commandId,
        review.version,
        newVersion,
        await evaluateUgcReviewPayloadHash({ redactedContent: params.redactedContent }),
        JSON.stringify({ redactedContent: params.redactedContent }),
        now
      )
  ])
}

export async function getUgcReviewById(db: D1Database, reviewId: string): Promise<UgcReviewResult | null> {
  const row = await db.prepare('SELECT * FROM ugc_reviews WHERE id = ?').bind(reviewId).first<UgcReviewRow>()

  if (!row) return null

  const photoRows = await db
    .prepare('SELECT * FROM ugc_review_photos WHERE review_id = ? ORDER BY sort_order ASC')
    .bind(reviewId)
    .all<UgcPhotoRow>()

  const photos = (photoRows.results ?? []).map((p) => ({
    id: p.id,
    photoUrl: p.photo_url,
    mimeType: p.mime_type,
    width: p.width,
    height: p.height,
    antivirusStatus: p.antivirus_status,
    moderationStatus: p.moderation_status
  }))

  let piiDetails: unknown[]
  try {
    piiDetails = JSON.parse(row.pii_details_json)
  } catch {
    piiDetails = []
  }

  return {
    id: row.id,
    productId: row.product_id,
    rating: row.rating,
    title: row.title,
    content: row.content,
    displayName: row.display_name,
    isVerifiedBuyer: row.is_verified_buyer === 1,
    moderationStatus: row.moderation_status,
    hasIncentive: row.has_incentive === 1,
    incentiveType: row.incentive_type,
    hiddenIncentiveSuspected: row.hidden_incentive_suspected === 1,
    piiDetected: row.pii_detected === 1,
    piiDetails,
    piiRedactedContent: row.pii_redacted_content,
    version: row.version,
    photos,
    createdAt: row.created_at
  }
}

export async function listPublicUgcReviews(
  db: D1Database,
  params: {
    productId: string
    page?: number
    limit?: number
  }
): Promise<{ reviews: PublicUgcReview[]; total: number }> {
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 50)
  const page = Math.max(params.page ?? 1, 1)
  const offset = (page - 1) * limit

  const countRow = await db
    .prepare("SELECT COUNT(*) AS total FROM ugc_reviews WHERE product_id = ? AND moderation_status = 'approved'")
    .bind(params.productId)
    .first<{ total: number }>()

  const total = countRow?.total ?? 0

  const rows = await db
    .prepare(
      `SELECT * FROM ugc_reviews
       WHERE product_id = ?1 AND moderation_status = 'approved'
       ORDER BY created_at DESC
       LIMIT ?2 OFFSET ?3`
    )
    .bind(params.productId, limit, offset)
    .all<UgcReviewRow>()

  const reviewRows = (rows.results ?? []) as UgcReviewRow[]
  if (reviewRows.length === 0) return { reviews: [], total }

  const reviewIds = reviewRows.map((r) => r.id)
  const placeholders = reviewIds.map(() => '?').join(',')

  const photoRows = await db
    .prepare(
      `SELECT * FROM ugc_review_photos
       WHERE review_id IN (${placeholders})
         AND moderation_status = 'approved'
         AND antivirus_status = 'clean'
       ORDER BY sort_order ASC`
    )
    .bind(...reviewIds)
    .all<UgcPhotoRow>()

  const photosByReview = new Map<string, PublicUgcPhoto[]>()
  for (const p of photoRows.results ?? []) {
    const list = photosByReview.get(p.review_id) ?? []
    list.push({
      id: p.id,
      photoUrl: p.photo_url,
      mimeType: p.mime_type as UgcPhotoMimeType,
      width: p.width,
      height: p.height,
      sortOrder: p.sort_order
    })
    photosByReview.set(p.review_id, list)
  }

  const reviews: PublicUgcReview[] = reviewRows.map((r) => {
    let incentiveBadge = 'Opinión contrastada'
    if (r.has_incentive === 1) {
      incentiveBadge =
        r.incentive_type === 'free_sample'
          ? 'Muestra comercial gratuita comunicada'
          : `Compensación comunicada (${r.incentive_type})`
    } else if (r.is_verified_buyer === 1) {
      incentiveBadge = 'Compra verificada sin compensación'
    }

    return {
      id: r.id,
      productId: r.product_id,
      rating: r.rating,
      title: r.title,
      content: r.pii_redacted_content ?? r.content,
      displayName: r.display_name,
      isVerifiedBuyer: r.is_verified_buyer === 1,
      photos: photosByReview.get(r.id) ?? [],
      incentiveBadge,
      incentiveDisclosure: r.has_incentive === 1 ? r.incentive_description : null,
      createdAt: r.created_at
    }
  })

  return { reviews, total }
}

export async function listAdminUgcReviews(
  db: D1Database,
  params: {
    status?: string
    requirePiiReview?: boolean
    requireIncentiveReview?: boolean
    limit?: number
    offset?: number
  }
): Promise<{ reviews: UgcReviewResult[]; total: number }> {
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 100)
  const offset = Math.max(params.offset ?? 0, 0)

  let sql = 'SELECT * FROM ugc_reviews WHERE 1=1'
  const binds: unknown[] = []

  if (params.status) {
    binds.push(params.status)
    sql += ` AND moderation_status = ?${binds.length}`
  }

  if (params.requirePiiReview) {
    sql += ' AND pii_detected = 1'
  }

  if (params.requireIncentiveReview) {
    sql += ' AND hidden_incentive_suspected = 1'
  }

  sql += ` ORDER BY created_at ASC LIMIT ?${binds.length + 1} OFFSET ?${binds.length + 2}`
  binds.push(limit, offset)

  const rows = await db
    .prepare(sql)
    .bind(...binds)
    .all<UgcReviewRow>()

  const reviewRows = (rows.results ?? []) as UgcReviewRow[]
  const fullReviews: UgcReviewResult[] = []

  for (const r of reviewRows) {
    const full = await getUgcReviewById(db, r.id)
    if (full) fullReviews.push(full)
  }

  return { reviews: fullReviews, total: fullReviews.length }
}
