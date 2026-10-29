import {
  evaluateFraudRisk,
  computeReviewsQaPayloadHash,
  submitReviewInputSchema,
  submitQuestionInputSchema,
  moderateReviewInputSchema,
  moderateQuestionInputSchema,
  merchantReplyReviewInputSchema,
  officialAnswerQuestionInputSchema,
  revokeConsentInputSchema,
  type PublicProductReview,
  type PublicProductQuestion
} from '../../shared/product-reviews-qa'

export class ProductReviewsQaError extends Error {
  constructor(
    readonly code:
      | 'invalid_input'
      | 'not_found'
      | 'unauthorized'
      | 'forbidden'
      | 'version_conflict'
      | 'idempotency_conflict'
      | 'duplicate_submission'
  ) {
    super(code)
    this.name = 'ProductReviewsQaError'
  }
}

interface ProductReviewRow {
  id: string
  product_id: string
  customer_id: string
  order_id: string | null
  rating: number
  title: string
  content: string
  is_verified_buyer: number
  moderation_status: string
  fraud_status: string
  fraud_score: number
  fraud_reasons_json: string
  merchant_response: string | null
  merchant_responded_at: string | null
  display_name: string
  version: number
  created_at: string
  updated_at: string
}

interface ProductQuestionRow {
  id: string
  product_id: string
  customer_id: string
  title: string
  content: string
  is_verified_buyer: number
  moderation_status: string
  fraud_status: string
  fraud_score: number
  official_answer: string | null
  answered_at: string | null
  display_name: string
  version: number
  created_at: string
  updated_at: string
}

interface SubmitReviewParams {
  productId: string
  customerId: string
  actorId: string
  orderId?: string
  rating: number
  title: string
  content: string
  displayName: string
  consentAccepted: boolean
  commandId: string
  now?: string
}

interface SubmitQuestionParams {
  productId: string
  customerId: string
  actorId: string
  title: string
  content: string
  displayName: string
  consentAccepted: boolean
  commandId: string
  now?: string
}

interface ModerateReviewParams {
  reviewId: string
  actorId: string
  action: 'approve' | 'reject' | 'quarantine'
  reason: string
  expectedVersion: number
  commandId: string
  now?: string
}

interface ModerateQuestionParams {
  questionId: string
  actorId: string
  action: 'approve' | 'reject'
  reason: string
  expectedVersion: number
  commandId: string
  now?: string
}

interface MerchantReplyReviewParams {
  reviewId: string
  actorId: string
  merchantResponse: string
  expectedVersion: number
  commandId: string
  now?: string
}

interface OfficialAnswerQuestionParams {
  questionId: string
  actorId: string
  officialAnswer: string
  expectedVersion: number
  commandId: string
  now?: string
}

interface RevokeConsentParams {
  entityId: string
  entityType: 'review' | 'question'
  customerId: string
  actorId: string
  anonymizeOnly?: boolean
  expectedVersion: number
  commandId: string
  now?: string
}

export async function submitProductReview(db: D1Database, params: SubmitReviewParams) {
  const parsed = submitReviewInputSchema.safeParse({
    productId: params.productId,
    orderId: params.orderId,
    rating: params.rating,
    title: params.title,
    content: params.content,
    displayName: params.displayName,
    consentAccepted: params.consentAccepted,
    commandId: params.commandId
  })
  if (!parsed.success) throw new ProductReviewsQaError('invalid_input')

  const currentTime = params.now ?? new Date().toISOString()
  const payloadHash = await computeReviewsQaPayloadHash(parsed.data)

  // Check idempotency replay
  const existingCmd = await db
    .prepare(
      'SELECT applied_version, payload_hash FROM product_reviews_qa_commands WHERE entity_id = ? AND command_id = ?'
    )
    .bind(params.commandId, params.commandId)
    .first<{ applied_version: number; payload_hash: string }>()

  if (existingCmd) {
    if (existingCmd.payload_hash !== payloadHash) throw new ProductReviewsQaError('idempotency_conflict')
    const existingRev = await db
      .prepare('SELECT * FROM product_reviews WHERE id = ?')
      .bind(params.commandId)
      .first<ProductReviewRow>()
    if (existingRev) {
      return {
        id: existingRev.id,
        productId: existingRev.product_id,
        rating: existingRev.rating,
        title: existingRev.title,
        content: existingRev.content,
        isVerifiedBuyer: existingRev.is_verified_buyer === 1,
        moderationStatus: existingRev.moderation_status,
        fraudStatus: existingRev.fraud_status,
        fraudScore: existingRev.fraud_score,
        displayName: existingRev.display_name,
        version: existingRev.version,
        createdAt: existingRev.created_at
      }
    }
  }

  // Verify buyer status strictly from orders
  let isVerifiedBuyer = 0
  if (params.orderId) {
    const orderMatch = await db
      .prepare(
        `SELECT 1 FROM orders o
         JOIN order_lines l ON l.order_id = o.id
         JOIN variants v ON v.id = l.variant_id
         WHERE o.id = ?1 AND o.customer_id = ?2 AND v.product_id = ?3
           AND (
             EXISTS(SELECT 1 FROM order_fulfillments f WHERE f.order_id = o.id AND f.status = 'delivered')
             OR NOT EXISTS(SELECT 1 FROM order_fulfillments f WHERE f.order_id = o.id)
           )`
      )
      .bind(params.orderId, params.customerId, params.productId)
      .first()
    if (orderMatch) isVerifiedBuyer = 1
  } else {
    // Check if customer has any order for this product
    const anyOrderMatch = await db
      .prepare(
        `SELECT 1 FROM orders o
         JOIN order_lines l ON l.order_id = o.id
         JOIN variants v ON v.id = l.variant_id
         WHERE o.customer_id = ?1 AND v.product_id = ?2
           AND (
             EXISTS(SELECT 1 FROM order_fulfillments f WHERE f.order_id = o.id AND f.status = 'delivered')
             OR NOT EXISTS(SELECT 1 FROM order_fulfillments f WHERE f.order_id = o.id)
           )`
      )
      .bind(params.customerId, params.productId)
      .first()
    if (anyOrderMatch) isVerifiedBuyer = 1
  }

  // Count recent submissions in the last hour for velocity check
  const oneHourAgo = new Date(new Date(currentTime).getTime() - 3600000).toISOString()
  const velocityRow = await db
    .prepare('SELECT COUNT(*) as count FROM product_reviews WHERE customer_id = ? AND created_at >= ?')
    .bind(params.customerId, oneHourAgo)
    .first<{ count: number }>()
  const velocityCount = velocityRow?.count ?? 0

  // Evaluate fraud risk
  const fraud = evaluateFraudRisk(params.title, params.content, velocityCount)
  const moderationStatus = fraud.status === 'clean' ? 'pending' : 'quarantined'

  const reviewId = params.commandId

  // Write review and command atomically
  await db.batch([
    db
      .prepare(
        `INSERT INTO product_reviews (
          id, product_id, customer_id, order_id, rating, title, content, is_verified_buyer,
          moderation_status, fraud_status, fraud_score, fraud_reasons_json,
          consent_accepted, consent_version, consent_at, display_name, version,
          created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
          ?9, ?10, ?11, ?12,
          1, '2026-v1', ?13, ?14, 1,
          ?13, ?13
        )`
      )
      .bind(
        reviewId,
        params.productId,
        params.customerId,
        params.orderId ?? null,
        params.rating,
        params.title,
        params.content,
        isVerifiedBuyer,
        moderationStatus,
        fraud.status,
        fraud.score,
        JSON.stringify(fraud.reasons),
        currentTime,
        params.displayName
      ),
    db
      .prepare(
        `INSERT INTO product_reviews_qa_commands (
          id, actor_id, entity_id, entity_type, action, command_id,
          expected_version, applied_version, payload_hash, payload_json, created_at
        ) VALUES (
          ?1, ?2, ?3, 'review', 'submit_review', ?4,
          0, 1, ?5, ?6, ?7
        )`
      )
      .bind(
        crypto.randomUUID(),
        params.actorId,
        reviewId,
        params.commandId,
        payloadHash,
        JSON.stringify(parsed.data),
        currentTime
      )
  ])

  return {
    id: reviewId,
    productId: params.productId,
    rating: params.rating,
    title: params.title,
    content: params.content,
    isVerifiedBuyer: isVerifiedBuyer === 1,
    moderationStatus,
    fraudStatus: fraud.status,
    fraudScore: fraud.score,
    displayName: params.displayName,
    version: 1,
    createdAt: currentTime
  }
}

export async function submitProductQuestion(db: D1Database, params: SubmitQuestionParams) {
  const parsed = submitQuestionInputSchema.safeParse({
    productId: params.productId,
    title: params.title,
    content: params.content,
    displayName: params.displayName,
    consentAccepted: params.consentAccepted,
    commandId: params.commandId
  })
  if (!parsed.success) throw new ProductReviewsQaError('invalid_input')

  const currentTime = params.now ?? new Date().toISOString()
  const payloadHash = await computeReviewsQaPayloadHash(parsed.data)

  const questionId = params.commandId

  // Check buyer status
  const anyOrderMatch = await db
    .prepare(
      `SELECT 1 FROM orders o
       JOIN order_lines l ON l.order_id = o.id
       JOIN variants v ON v.id = l.variant_id
       WHERE o.customer_id = ?1 AND v.product_id = ?2
         AND (
           EXISTS(SELECT 1 FROM order_fulfillments f WHERE f.order_id = o.id AND f.status = 'delivered')
           OR NOT EXISTS(SELECT 1 FROM order_fulfillments f WHERE f.order_id = o.id)
         )`
    )
    .bind(params.customerId, params.productId)
    .first()
  const isVerifiedBuyer = anyOrderMatch ? 1 : 0

  const fraud = evaluateFraudRisk(params.title, params.content, 0)
  const moderationStatus = fraud.status === 'clean' ? 'pending' : 'rejected'

  await db.batch([
    db
      .prepare(
        `INSERT INTO product_questions (
          id, product_id, customer_id, title, content, is_verified_buyer,
          moderation_status, fraud_status, fraud_score,
          consent_accepted, consent_version, consent_at, display_name, version,
          created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6,
          ?7, ?8, ?9,
          1, '2026-v1', ?10, ?11, 1,
          ?10, ?10
        )`
      )
      .bind(
        questionId,
        params.productId,
        params.customerId,
        params.title,
        params.content,
        isVerifiedBuyer,
        moderationStatus,
        fraud.status,
        fraud.score,
        currentTime,
        params.displayName
      ),
    db
      .prepare(
        `INSERT INTO product_reviews_qa_commands (
          id, actor_id, entity_id, entity_type, action, command_id,
          expected_version, applied_version, payload_hash, payload_json, created_at
        ) VALUES (
          ?1, ?2, ?3, 'question', 'submit_question', ?4,
          0, 1, ?5, ?6, ?7
        )`
      )
      .bind(
        crypto.randomUUID(),
        params.actorId,
        questionId,
        params.commandId,
        payloadHash,
        JSON.stringify(parsed.data),
        currentTime
      )
  ])

  return {
    id: questionId,
    productId: params.productId,
    title: params.title,
    content: params.content,
    isVerifiedBuyer: isVerifiedBuyer === 1,
    moderationStatus,
    officialAnswer: null,
    displayName: params.displayName,
    version: 1,
    createdAt: currentTime
  }
}

export async function moderateProductReview(db: D1Database, params: ModerateReviewParams) {
  const parsed = moderateReviewInputSchema.safeParse({
    reviewId: params.reviewId,
    action: params.action,
    reason: params.reason,
    expectedVersion: params.expectedVersion,
    commandId: params.commandId
  })
  if (!parsed.success) throw new ProductReviewsQaError('invalid_input')

  const currentTime = params.now ?? new Date().toISOString()
  const payloadHash = await computeReviewsQaPayloadHash(parsed.data)

  const review = await db
    .prepare('SELECT id, version, moderation_status FROM product_reviews WHERE id = ?')
    .bind(params.reviewId)
    .first<{ id: string; version: number; moderation_status: string }>()

  if (!review) throw new ProductReviewsQaError('not_found')
  if (review.version !== params.expectedVersion) throw new ProductReviewsQaError('version_conflict')

  const targetStatus =
    params.action === 'approve' ? 'approved' : params.action === 'reject' ? 'rejected' : 'quarantined'
  const newVersion = review.version + 1

  await db.batch([
    db
      .prepare(
        'UPDATE product_reviews SET moderation_status = ?1, version = ?2, updated_at = ?3 WHERE id = ?4 AND version = ?5'
      )
      .bind(targetStatus, newVersion, currentTime, params.reviewId, review.version),
    db
      .prepare(
        `INSERT INTO product_reviews_qa_commands (
          id, actor_id, entity_id, entity_type, action, command_id,
          expected_version, applied_version, payload_hash, payload_json, created_at
        ) VALUES (
          ?1, ?2, ?3, 'review', 'moderate_review', ?4,
          ?5, ?6, ?7, ?8, ?9
        )`
      )
      .bind(
        crypto.randomUUID(),
        params.actorId,
        params.reviewId,
        params.commandId,
        review.version,
        newVersion,
        payloadHash,
        JSON.stringify(parsed.data),
        currentTime
      )
  ])

  return {
    id: params.reviewId,
    moderationStatus: targetStatus,
    version: newVersion,
    updatedAt: currentTime
  }
}

export async function moderateProductQuestion(db: D1Database, params: ModerateQuestionParams) {
  const parsed = moderateQuestionInputSchema.safeParse({
    questionId: params.questionId,
    action: params.action,
    reason: params.reason,
    expectedVersion: params.expectedVersion,
    commandId: params.commandId
  })
  if (!parsed.success) throw new ProductReviewsQaError('invalid_input')

  const currentTime = params.now ?? new Date().toISOString()
  const payloadHash = await computeReviewsQaPayloadHash(parsed.data)

  const question = await db
    .prepare('SELECT id, version, moderation_status FROM product_questions WHERE id = ?')
    .bind(params.questionId)
    .first<{ id: string; version: number; moderation_status: string }>()

  if (!question) throw new ProductReviewsQaError('not_found')
  if (question.version !== params.expectedVersion) throw new ProductReviewsQaError('version_conflict')

  const targetStatus = params.action === 'approve' ? 'approved' : 'rejected'
  const newVersion = question.version + 1

  await db.batch([
    db
      .prepare(
        'UPDATE product_questions SET moderation_status = ?1, version = ?2, updated_at = ?3 WHERE id = ?4 AND version = ?5'
      )
      .bind(targetStatus, newVersion, currentTime, params.questionId, question.version),
    db
      .prepare(
        `INSERT INTO product_reviews_qa_commands (
          id, actor_id, entity_id, entity_type, action, command_id,
          expected_version, applied_version, payload_hash, payload_json, created_at
        ) VALUES (
          ?1, ?2, ?3, 'question', 'moderate_question', ?4,
          ?5, ?6, ?7, ?8, ?9
        )`
      )
      .bind(
        crypto.randomUUID(),
        params.actorId,
        params.questionId,
        params.commandId,
        question.version,
        newVersion,
        payloadHash,
        JSON.stringify(parsed.data),
        currentTime
      )
  ])

  return {
    id: params.questionId,
    moderationStatus: targetStatus,
    version: newVersion,
    updatedAt: currentTime
  }
}

export async function merchantReplyProductReview(db: D1Database, params: MerchantReplyReviewParams) {
  const parsed = merchantReplyReviewInputSchema.safeParse({
    reviewId: params.reviewId,
    merchantResponse: params.merchantResponse,
    expectedVersion: params.expectedVersion,
    commandId: params.commandId
  })
  if (!parsed.success) throw new ProductReviewsQaError('invalid_input')

  const currentTime = params.now ?? new Date().toISOString()
  const payloadHash = await computeReviewsQaPayloadHash(parsed.data)

  const review = await db
    .prepare('SELECT id, version FROM product_reviews WHERE id = ?')
    .bind(params.reviewId)
    .first<{ id: string; version: number }>()

  if (!review) throw new ProductReviewsQaError('not_found')
  if (review.version !== params.expectedVersion) throw new ProductReviewsQaError('version_conflict')

  const newVersion = review.version + 1

  await db.batch([
    db
      .prepare(
        `UPDATE product_reviews
         SET merchant_response = ?1, merchant_responded_at = ?2, merchant_responder_id = ?3,
             version = ?4, updated_at = ?2
         WHERE id = ?5 AND version = ?6`
      )
      .bind(params.merchantResponse, currentTime, params.actorId, newVersion, params.reviewId, review.version),
    db
      .prepare(
        `INSERT INTO product_reviews_qa_commands (
          id, actor_id, entity_id, entity_type, action, command_id,
          expected_version, applied_version, payload_hash, payload_json, created_at
        ) VALUES (
          ?1, ?2, ?3, 'review', 'merchant_reply_review', ?4,
          ?5, ?6, ?7, ?8, ?9
        )`
      )
      .bind(
        crypto.randomUUID(),
        params.actorId,
        params.reviewId,
        params.commandId,
        review.version,
        newVersion,
        payloadHash,
        JSON.stringify(parsed.data),
        currentTime
      )
  ])

  return {
    id: params.reviewId,
    merchantResponse: params.merchantResponse,
    merchantRespondedAt: currentTime,
    version: newVersion,
    updatedAt: currentTime
  }
}

export async function officialAnswerProductQuestion(db: D1Database, params: OfficialAnswerQuestionParams) {
  const parsed = officialAnswerQuestionInputSchema.safeParse({
    questionId: params.questionId,
    officialAnswer: params.officialAnswer,
    expectedVersion: params.expectedVersion,
    commandId: params.commandId
  })
  if (!parsed.success) throw new ProductReviewsQaError('invalid_input')

  const currentTime = params.now ?? new Date().toISOString()
  const payloadHash = await computeReviewsQaPayloadHash(parsed.data)

  const question = await db
    .prepare('SELECT id, version FROM product_questions WHERE id = ?')
    .bind(params.questionId)
    .first<{ id: string; version: number }>()

  if (!question) throw new ProductReviewsQaError('not_found')
  if (question.version !== params.expectedVersion) throw new ProductReviewsQaError('version_conflict')

  const newVersion = question.version + 1

  await db.batch([
    db
      .prepare(
        `UPDATE product_questions
         SET official_answer = ?1, answered_at = ?2, answered_by = ?3,
             moderation_status = 'answered', version = ?4, updated_at = ?2
         WHERE id = ?5 AND version = ?6`
      )
      .bind(params.officialAnswer, currentTime, params.actorId, newVersion, params.questionId, question.version),
    db
      .prepare(
        `INSERT INTO product_reviews_qa_commands (
          id, actor_id, entity_id, entity_type, action, command_id,
          expected_version, applied_version, payload_hash, payload_json, created_at
        ) VALUES (
          ?1, ?2, ?3, 'question', 'official_answer_question', ?4,
          ?5, ?6, ?7, ?8, ?9
        )`
      )
      .bind(
        crypto.randomUUID(),
        params.actorId,
        params.questionId,
        params.commandId,
        question.version,
        newVersion,
        payloadHash,
        JSON.stringify(parsed.data),
        currentTime
      )
  ])

  return {
    id: params.questionId,
    officialAnswer: params.officialAnswer,
    answeredAt: currentTime,
    moderationStatus: 'answered',
    version: newVersion,
    updatedAt: currentTime
  }
}

export async function revokeReviewQaConsent(db: D1Database, params: RevokeConsentParams) {
  const parsed = revokeConsentInputSchema.safeParse({
    entityId: params.entityId,
    entityType: params.entityType,
    anonymizeOnly: params.anonymizeOnly,
    expectedVersion: params.expectedVersion,
    commandId: params.commandId
  })
  if (!parsed.success) throw new ProductReviewsQaError('invalid_input')

  const currentTime = params.now ?? new Date().toISOString()
  const payloadHash = await computeReviewsQaPayloadHash(parsed.data)

  const table = params.entityType === 'review' ? 'product_reviews' : 'product_questions'
  const record = await db
    .prepare(`SELECT id, customer_id, version FROM ${table} WHERE id = ?`)
    .bind(params.entityId)
    .first<{ id: string; customer_id: string; version: number }>()

  if (!record) throw new ProductReviewsQaError('not_found')
  if (record.customer_id !== params.customerId) throw new ProductReviewsQaError('forbidden')
  if (record.version !== params.expectedVersion) throw new ProductReviewsQaError('version_conflict')

  const newVersion = record.version + 1
  const updateSql = params.anonymizeOnly
    ? `UPDATE ${table} SET display_name = 'Cliente verificado', consent_accepted = 0, version = ?1, updated_at = ?2 WHERE id = ?3 AND version = ?4`
    : `UPDATE ${table} SET moderation_status = 'rejected', consent_accepted = 0, version = ?1, updated_at = ?2 WHERE id = ?3 AND version = ?4`

  await db.batch([
    db.prepare(updateSql).bind(newVersion, currentTime, params.entityId, record.version),
    db
      .prepare(
        `INSERT INTO product_reviews_qa_commands (
          id, actor_id, entity_id, entity_type, action, command_id,
          expected_version, applied_version, payload_hash, payload_json, created_at
        ) VALUES (
          ?1, ?2, ?3, ?4, 'revoke_consent', ?5,
          ?6, ?7, ?8, ?9, ?10
        )`
      )
      .bind(
        crypto.randomUUID(),
        params.actorId,
        params.entityId,
        params.entityType,
        params.commandId,
        record.version,
        newVersion,
        payloadHash,
        JSON.stringify(parsed.data),
        currentTime
      )
  ])

  return {
    id: params.entityId,
    anonymized: true,
    version: newVersion,
    updatedAt: currentTime
  }
}

export async function listPublicProductReviews(
  db: D1Database,
  productId: string
): Promise<{ items: PublicProductReview[]; total: number; averageRating: number }> {
  const rows = await db
    .prepare(
      `SELECT id, product_id, rating, title, content, is_verified_buyer, display_name,
              merchant_response, merchant_responded_at, created_at
       FROM product_reviews
       WHERE product_id = ? AND moderation_status = 'approved'
       ORDER BY created_at DESC
       LIMIT 50`
    )
    .bind(productId)
    .all<ProductReviewRow>()

  const items: PublicProductReview[] = (rows.results ?? []).map((row) => ({
    id: row.id,
    productId: row.product_id,
    rating: row.rating,
    title: row.title,
    content: row.content,
    isVerifiedBuyer: row.is_verified_buyer === 1,
    displayName: row.display_name,
    merchantResponse: row.merchant_response ?? null,
    merchantRespondedAt: row.merchant_responded_at ?? null,
    createdAt: row.created_at
  }))

  const total = items.length
  const averageRating = total > 0 ? Number((items.reduce((sum, item) => sum + item.rating, 0) / total).toFixed(1)) : 0

  return { items, total, averageRating }
}

export async function listPublicProductQuestions(
  db: D1Database,
  productId: string
): Promise<{ items: PublicProductQuestion[]; total: number }> {
  const rows = await db
    .prepare(
      `SELECT id, product_id, title, content, is_verified_buyer, display_name,
              official_answer, answered_at, created_at
       FROM product_questions
       WHERE product_id = ? AND moderation_status IN ('approved', 'answered')
       ORDER BY created_at DESC
       LIMIT 50`
    )
    .bind(productId)
    .all<ProductQuestionRow>()

  const items: PublicProductQuestion[] = (rows.results ?? []).map((row) => ({
    id: row.id,
    productId: row.product_id,
    title: row.title,
    content: row.content,
    isVerifiedBuyer: row.is_verified_buyer === 1,
    displayName: row.display_name,
    officialAnswer: row.official_answer ?? null,
    answeredAt: row.answered_at ?? null,
    createdAt: row.created_at
  }))

  return { items, total: items.length }
}

export async function listAdminProductReviews(db: D1Database) {
  const rows = await db
    .prepare(
      `SELECT id, product_id, customer_id, rating, title, content, is_verified_buyer,
              moderation_status, fraud_status, fraud_score, fraud_reasons_json,
              merchant_response, display_name, version, created_at, updated_at
       FROM product_reviews
       ORDER BY created_at DESC
       LIMIT 100`
    )
    .all<ProductReviewRow>()

  return { reviews: rows.results ?? [] }
}

export async function listAdminProductQuestions(db: D1Database) {
  const rows = await db
    .prepare(
      `SELECT id, product_id, customer_id, title, content, is_verified_buyer,
              moderation_status, fraud_status, fraud_score,
              official_answer, display_name, version, created_at, updated_at
       FROM product_questions
       ORDER BY created_at DESC
       LIMIT 100`
    )
    .all<ProductQuestionRow>()

  return { questions: rows.results ?? [] }
}
