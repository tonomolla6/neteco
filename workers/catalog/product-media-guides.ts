import {
  computeMediaGuidePayloadHash,
  upsertMediaGuideInputSchema,
  mediaUsageMetricInputSchema,
  type ProductMediaGuide,
  type UpsertMediaGuideInput,
  type MediaUsageMetricInput
} from '../../shared/product-media-guides'

export class ProductMediaGuidesError extends Error {
  constructor(
    readonly code:
      'invalid_input' | 'not_found' | 'unauthorized' | 'forbidden' | 'version_conflict' | 'idempotency_conflict'
  ) {
    super(code)
    this.name = 'ProductMediaGuidesError'
  }
}

interface ProductMediaGuideRow {
  id: string
  product_id: string
  guide_type: 'expert_demo' | 'dosage' | 'application' | 'assembly'
  title: string
  description: string | null
  expert_presenter: string | null
  expert_title: string | null
  video_url: string
  mime_type: 'video/mp4' | 'video/webm'
  duration_seconds: number
  aspect_ratio: '16:9' | '9:16' | '4:3' | '1:1'
  poster_url: string
  poster_optimized_webp: string | null
  poster_width: number
  poster_height: number
  subtitles_vtt_url: string | null
  subtitles_language: string
  transcript_text: string
  steps_json: string
  requires_consent: number
  status: 'draft' | 'published' | 'archived'
  sort_order: number
  version: number
  created_at: string
  updated_at: string
}

export async function upsertProductMediaGuide(
  db: D1Database,
  input: UpsertMediaGuideInput
): Promise<ProductMediaGuide> {
  const parsed = upsertMediaGuideInputSchema.safeParse(input)
  if (!parsed.success) throw new ProductMediaGuidesError('invalid_input')

  const currentTime = parsed.data.now ?? new Date().toISOString()
  const payloadHash = await computeMediaGuidePayloadHash(parsed.data)

  const existing = await db
    .prepare('SELECT id, version, created_at FROM product_media_guides WHERE id = ?')
    .bind(parsed.data.id)
    .first<{ id: string; version: number; created_at: string }>()

  if (existing) {
    if (existing.version !== parsed.data.expectedVersion) throw new ProductMediaGuidesError('version_conflict')
    const newVersion = existing.version + 1

    await db.batch([
      db
        .prepare(
          `UPDATE product_media_guides
           SET product_id = ?1, guide_type = ?2, title = ?3, description = ?4,
               expert_presenter = ?5, expert_title = ?6, video_url = ?7, mime_type = ?8,
               duration_seconds = ?9, aspect_ratio = ?10, poster_url = ?11, poster_optimized_webp = ?12,
               poster_width = ?13, poster_height = ?14, subtitles_vtt_url = ?15, subtitles_language = ?16,
               transcript_text = ?17, steps_json = ?18, requires_consent = ?19, status = ?20,
               sort_order = ?21, version = ?22, updated_at = ?23
           WHERE id = ?24 AND version = ?25`
        )
        .bind(
          parsed.data.productId,
          parsed.data.guideType,
          parsed.data.title,
          parsed.data.description ?? null,
          parsed.data.expertPresenter ?? null,
          parsed.data.expertTitle ?? null,
          parsed.data.videoUrl,
          parsed.data.mimeType,
          parsed.data.durationSeconds,
          parsed.data.aspectRatio,
          parsed.data.posterUrl,
          parsed.data.posterOptimizedWebp ?? null,
          parsed.data.posterWidth,
          parsed.data.posterHeight,
          parsed.data.subtitlesVttUrl ?? null,
          parsed.data.subtitlesLanguage,
          parsed.data.transcriptText,
          JSON.stringify(parsed.data.steps),
          parsed.data.requiresConsent ? 1 : 0,
          parsed.data.status,
          parsed.data.sortOrder,
          newVersion,
          currentTime,
          parsed.data.id,
          existing.version
        ),
      db
        .prepare(
          `INSERT INTO product_media_guides_commands (
            id, actor_id, guide_id, action, command_id,
            expected_version, applied_version, payload_hash, payload_json, created_at
          ) VALUES (
            ?1, ?2, ?3, 'upsert_guide', ?4,
            ?5, ?6, ?7, ?8, ?9
          )`
        )
        .bind(
          crypto.randomUUID(),
          parsed.data.actorId,
          parsed.data.id,
          parsed.data.commandId,
          existing.version,
          newVersion,
          payloadHash,
          JSON.stringify(parsed.data),
          currentTime
        )
    ])

    return {
      id: parsed.data.id,
      productId: parsed.data.productId,
      guideType: parsed.data.guideType,
      title: parsed.data.title,
      description: parsed.data.description ?? null,
      expertPresenter: parsed.data.expertPresenter ?? null,
      expertTitle: parsed.data.expertTitle ?? null,
      videoUrl: parsed.data.videoUrl,
      mimeType: parsed.data.mimeType,
      durationSeconds: parsed.data.durationSeconds,
      aspectRatio: parsed.data.aspectRatio,
      posterUrl: parsed.data.posterUrl,
      posterOptimizedWebp: parsed.data.posterOptimizedWebp ?? null,
      posterWidth: parsed.data.posterWidth,
      posterHeight: parsed.data.posterHeight,
      subtitlesVttUrl: parsed.data.subtitlesVttUrl ?? null,
      subtitlesLanguage: parsed.data.subtitlesLanguage,
      transcriptText: parsed.data.transcriptText,
      steps: parsed.data.steps,
      requiresConsent: parsed.data.requiresConsent,
      status: parsed.data.status,
      sortOrder: parsed.data.sortOrder,
      version: newVersion,
      createdAt: existing.created_at,
      updatedAt: currentTime
    }
  } else {
    if (parsed.data.expectedVersion !== 0) throw new ProductMediaGuidesError('version_conflict')

    await db.batch([
      db
        .prepare(
          `INSERT INTO product_media_guides (
            id, product_id, guide_type, title, description,
            expert_presenter, expert_title, video_url, mime_type,
            duration_seconds, aspect_ratio, poster_url, poster_optimized_webp,
            poster_width, poster_height, subtitles_vtt_url, subtitles_language,
            transcript_text, steps_json, requires_consent, status,
            sort_order, version, created_at, updated_at
          ) VALUES (
            ?1, ?2, ?3, ?4, ?5,
            ?6, ?7, ?8, ?9,
            ?10, ?11, ?12, ?13,
            ?14, ?15, ?16, ?17,
            ?18, ?19, ?20, ?21,
            ?22, 1, ?23, ?23
          )`
        )
        .bind(
          parsed.data.id,
          parsed.data.productId,
          parsed.data.guideType,
          parsed.data.title,
          parsed.data.description ?? null,
          parsed.data.expertPresenter ?? null,
          parsed.data.expertTitle ?? null,
          parsed.data.videoUrl,
          parsed.data.mimeType,
          parsed.data.durationSeconds,
          parsed.data.aspectRatio,
          parsed.data.posterUrl,
          parsed.data.posterOptimizedWebp ?? null,
          parsed.data.posterWidth,
          parsed.data.posterHeight,
          parsed.data.subtitlesVttUrl ?? null,
          parsed.data.subtitlesLanguage,
          parsed.data.transcriptText,
          JSON.stringify(parsed.data.steps),
          parsed.data.requiresConsent ? 1 : 0,
          parsed.data.status,
          parsed.data.sortOrder,
          currentTime
        ),
      db
        .prepare(
          `INSERT INTO product_media_guides_commands (
            id, actor_id, guide_id, action, command_id,
            expected_version, applied_version, payload_hash, payload_json, created_at
          ) VALUES (
            ?1, ?2, ?3, 'upsert_guide', ?4,
            0, 1, ?5, ?6, ?7
          )`
        )
        .bind(
          crypto.randomUUID(),
          parsed.data.actorId,
          parsed.data.id,
          parsed.data.commandId,
          payloadHash,
          JSON.stringify(parsed.data),
          currentTime
        )
    ])

    return {
      id: parsed.data.id,
      productId: parsed.data.productId,
      guideType: parsed.data.guideType,
      title: parsed.data.title,
      description: parsed.data.description ?? null,
      expertPresenter: parsed.data.expertPresenter ?? null,
      expertTitle: parsed.data.expertTitle ?? null,
      videoUrl: parsed.data.videoUrl,
      mimeType: parsed.data.mimeType,
      durationSeconds: parsed.data.durationSeconds,
      aspectRatio: parsed.data.aspectRatio,
      posterUrl: parsed.data.posterUrl,
      posterOptimizedWebp: parsed.data.posterOptimizedWebp ?? null,
      posterWidth: parsed.data.posterWidth,
      posterHeight: parsed.data.posterHeight,
      subtitlesVttUrl: parsed.data.subtitlesVttUrl ?? null,
      subtitlesLanguage: parsed.data.subtitlesLanguage,
      transcriptText: parsed.data.transcriptText,
      steps: parsed.data.steps,
      requiresConsent: parsed.data.requiresConsent,
      status: parsed.data.status,
      sortOrder: parsed.data.sortOrder,
      version: 1,
      createdAt: currentTime,
      updatedAt: currentTime
    }
  }
}

export async function listProductMediaGuides(db: D1Database, productId: string): Promise<ProductMediaGuide[]> {
  const rows = await db
    .prepare(
      `SELECT id, product_id, guide_type, title, description, expert_presenter, expert_title,
              video_url, mime_type, duration_seconds, aspect_ratio, poster_url, poster_optimized_webp,
              poster_width, poster_height, subtitles_vtt_url, subtitles_language, transcript_text,
              steps_json, requires_consent, status, sort_order, version, created_at, updated_at
       FROM product_media_guides
       WHERE product_id = ? AND status = 'published'
       ORDER BY sort_order ASC, created_at DESC`
    )
    .bind(productId)
    .all<ProductMediaGuideRow>()

  return (rows.results ?? []).map((row) => ({
    id: row.id,
    productId: row.product_id,
    guideType: row.guide_type,
    title: row.title,
    description: row.description ?? null,
    expertPresenter: row.expert_presenter ?? null,
    expertTitle: row.expert_title ?? null,
    videoUrl: row.video_url,
    mimeType: row.mime_type,
    durationSeconds: row.duration_seconds,
    aspectRatio: row.aspect_ratio,
    posterUrl: row.poster_url,
    posterOptimizedWebp: row.poster_optimized_webp ?? null,
    posterWidth: row.poster_width,
    posterHeight: row.poster_height,
    subtitlesVttUrl: row.subtitles_vtt_url ?? null,
    subtitlesLanguage: row.subtitles_language,
    transcriptText: row.transcript_text,
    steps: JSON.parse(row.steps_json || '[]'),
    requiresConsent: row.requires_consent === 1,
    status: row.status,
    sortOrder: row.sort_order,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }))
}

export async function getProductMediaGuideById(db: D1Database, guideId: string): Promise<ProductMediaGuide | null> {
  const row = await db
    .prepare(
      `SELECT id, product_id, guide_type, title, description, expert_presenter, expert_title,
              video_url, mime_type, duration_seconds, aspect_ratio, poster_url, poster_optimized_webp,
              poster_width, poster_height, subtitles_vtt_url, subtitles_language, transcript_text,
              steps_json, requires_consent, status, sort_order, version, created_at, updated_at
       FROM product_media_guides
       WHERE id = ?`
    )
    .bind(guideId)
    .first<ProductMediaGuideRow>()

  if (!row) return null

  return {
    id: row.id,
    productId: row.product_id,
    guideType: row.guide_type,
    title: row.title,
    description: row.description ?? null,
    expertPresenter: row.expert_presenter ?? null,
    expertTitle: row.expert_title ?? null,
    videoUrl: row.video_url,
    mimeType: row.mime_type,
    durationSeconds: row.duration_seconds,
    aspectRatio: row.aspect_ratio,
    posterUrl: row.poster_url,
    posterOptimizedWebp: row.poster_optimized_webp ?? null,
    posterWidth: row.poster_width,
    posterHeight: row.poster_height,
    subtitlesVttUrl: row.subtitles_vtt_url ?? null,
    subtitlesLanguage: row.subtitles_language,
    transcriptText: row.transcript_text,
    steps: JSON.parse(row.steps_json || '[]'),
    requiresConsent: row.requires_consent === 1,
    status: row.status,
    sortOrder: row.sort_order,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export async function recordMediaUsageMetric(
  db: D1Database,
  input: MediaUsageMetricInput
): Promise<{ recorded: boolean }> {
  const parsed = mediaUsageMetricInputSchema.safeParse(input)
  if (!parsed.success) throw new ProductMediaGuidesError('invalid_input')

  const currentTime = parsed.data.now ?? new Date().toISOString()
  // Zero out session_hash if consent is not granted, preventing any PII or persistent tracking
  const effectiveHash = parsed.data.consentVerified ? parsed.data.sessionHash : '0'.repeat(64)
  const consentFlag = parsed.data.consentVerified ? 1 : 0

  await db
    .prepare(
      `INSERT INTO product_media_usage_metrics (
        id, guide_id, event_type, play_position_seconds, session_hash, consent_verified, created_at
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6, ?7
      )`
    )
    .bind(
      crypto.randomUUID(),
      parsed.data.guideId,
      parsed.data.eventType,
      parsed.data.playPositionSeconds ?? null,
      effectiveHash,
      consentFlag,
      currentTime
    )
    .run()

  return { recorded: true }
}

export async function getMediaUsageStats(db: D1Database, guideId: string) {
  const rows = await db
    .prepare(
      `SELECT event_type, COUNT(*) as count
       FROM product_media_usage_metrics
       WHERE guide_id = ?
       GROUP BY event_type`
    )
    .bind(guideId)
    .all<{ event_type: string; count: number }>()

  const counts: Record<string, number> = {}
  for (const row of rows.results ?? []) {
    counts[row.event_type] = row.count
  }

  return {
    guideId,
    totalImpressions: counts['impression'] ?? 0,
    totalPlays: counts['play_start'] ?? 0,
    totalCompletions: counts['complete'] ?? 0,
    totalTranscriptViews: counts['transcript_view'] ?? 0
  }
}
