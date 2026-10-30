import { createHash, randomUUID } from 'node:crypto'
import {
  type CampaignContentPipelineRecord,
  type CampaignDocument,
  type CheckResult,
  type CheckViolation,
  type PublishCampaignNowInput,
  type QaSignoffInput,
  type RollbackCampaignInput,
  type RunCampaignChecksInput,
  type SaveDraftInput,
  type SchedulePublicationInput,
  CampaignPipelineError,
  publishCampaignNowSchema,
  qaSignoffSchema,
  rollbackCampaignSchema,
  runCampaignChecksSchema,
  saveDraftSchema,
  schedulePublicationSchema
} from '../../shared/campaign-pipeline'

function computeHash(data: unknown): string {
  return createHash('sha256').update(JSON.stringify(data)).digest('hex')
}

export function renderCampaignPreview(
  doc: CampaignDocument,
  opts: { previewMode?: boolean; draftVersion?: number } = {}
): { html: string; meta: { headline: string; description: string }; previewBanner: boolean } {
  const sectionsHtml = doc.sections
    .map((s) => {
      const imgHtml = s.imageUrl
        ? `<img src="${s.imageUrl}" alt="${s.imageAlt ?? ''}" ${s.imageWidth ? `width="${s.imageWidth}"` : ''} ${s.imageHeight ? `height="${s.imageHeight}"` : ''} loading="lazy" />`
        : ''
      const ctaHtml = s.ctaUrl
        ? `<a href="${s.ctaUrl}" ${s.ctaAriaLabel ? `aria-label="${s.ctaAriaLabel}"` : ''} class="cta-btn">${s.ctaText ?? 'Ver'}</a>`
        : ''
      const bodyHtml = s.body ? `<p>${s.body}</p>` : ''
      const level = s.headingLevel ?? 'h2'
      return `
        <section id="${s.id}" class="campaign-section type-${s.type}">
          <${level}>${s.heading}</${level}>
          ${bodyHtml}
          ${imgHtml}
          ${ctaHtml}
        </section>
      `
    })
    .join('\n')

  const bannerHtml = opts.previewMode
    ? `<div class="preview-mode-banner" role="status">MODO PREVIEW - Versión borrador ${opts.draftVersion ?? 1} (Sin desplegar código)</div>`
    : ''

  const html = `
    ${bannerHtml}
    <main class="campaign-container">
      <header>
        <h1>${doc.headline}</h1>
      </header>
      ${sectionsHtml}
    </main>
  `

  return {
    html: html.trim(),
    meta: {
      headline: doc.headline,
      description: doc.metaDescription
    },
    previewBanner: Boolean(opts.previewMode)
  }
}

export function evaluateCampaignPerformance(doc: CampaignDocument): CheckResult {
  const violations: CheckViolation[] = []
  let penalty = 0

  for (const s of doc.sections) {
    if (s.imageUrl) {
      if (!s.imageWidth || !s.imageHeight) {
        violations.push({
          code: 'missing_dimensions',
          sectionId: s.id,
          severity: 'warning',
          message: `Section ${s.id} image missing width or height dimensions`
        })
        penalty += 15
      }

      if (s.imageBytesEstimate && s.imageBytesEstimate > 500000) {
        violations.push({
          code: 'image_too_heavy',
          sectionId: s.id,
          severity: 'blocker',
          message: `Image in section ${s.id} exceeds 500 KB (${Math.round(s.imageBytesEstimate / 1024)} KB)`
        })
        penalty += 35
      } else if (s.imageBytesEstimate && s.imageBytesEstimate > 250000) {
        violations.push({
          code: 'image_too_heavy',
          sectionId: s.id,
          severity: 'warning',
          message: `Image in section ${s.id} exceeds recommended 250 KB`
        })
        penalty += 20
      }

      if (s.imageFormat === 'png' || s.imageFormat === 'jpeg') {
        violations.push({
          code: 'unoptimized_image_format',
          sectionId: s.id,
          severity: 'warning',
          message: `Section ${s.id} uses legacy image format ${s.imageFormat}; consider webp or avif`
        })
        penalty += 10
      }
    }
  }

  const score = Math.max(0, 100 - penalty)
  const passed = score >= 80 && !violations.some((v) => v.severity === 'blocker')

  return {
    checkType: 'performance',
    passed,
    score,
    violations,
    details: { totalSections: doc.sections.length, penaltyTotal: penalty }
  }
}

export function evaluateCampaignAccessibility(doc: CampaignDocument): CheckResult {
  const violations: CheckViolation[] = []
  let penalty = 0

  for (const s of doc.sections) {
    if (s.imageUrl) {
      if (typeof s.imageAlt !== 'string' || s.imageAlt.trim().length === 0) {
        violations.push({
          code: 'missing_image_alt',
          sectionId: s.id,
          severity: 'blocker',
          message: `Section ${s.id} image is missing descriptive alt text`
        })
        penalty += 40
      }
    }

    if (s.ctaUrl) {
      const hasDescriptiveText = s.ctaText && s.ctaText.trim().length > 2
      const hasAriaLabel = s.ctaAriaLabel && s.ctaAriaLabel.trim().length > 3
      if (!hasDescriptiveText && !hasAriaLabel) {
        violations.push({
          code: 'missing_cta_label',
          sectionId: s.id,
          severity: 'blocker',
          message: `Call to action in section ${s.id} has no accessible label or descriptive text`
        })
        penalty += 30
      }
    }

    if (s.headingLevel === 'h4') {
      violations.push({
        code: 'heading_hierarchy_skip',
        sectionId: s.id,
        severity: 'warning',
        message: `Section ${s.id} skips directly to h4; maintains improper semantic heading structure`
      })
      penalty += 15
    }

    if (s.theme) {
      const { textColor, backgroundColor } = s.theme
      if (textColor.toLowerCase() === backgroundColor.toLowerCase()) {
        violations.push({
          code: 'identical_colors',
          sectionId: s.id,
          severity: 'blocker',
          message: `Section ${s.id} textColor matches backgroundColor, content invisible`
        })
        penalty += 50
      }
    }
  }

  const score = Math.max(0, 100 - penalty)
  const passed = score >= 85 && !violations.some((v) => v.severity === 'blocker')

  return {
    checkType: 'accessibility',
    passed,
    score,
    violations,
    details: { totalSections: doc.sections.length, penaltyTotal: penalty }
  }
}

interface RawCampaignRow {
  id: string
  campaign_slug: string
  title: string
  current_version: number
  published_version: number | null
  previous_published_version: number | null
  status: string
  publish_at: string | null
  unpublish_at: string | null
  document_json: string
  version: number
  created_at: string
  updated_at: string
  created_by: string
}

interface RawCheckRow {
  id: string
  pipeline_id: string
  content_version: number
  check_type: string
  passed: number
  score: number
  violations_json: string
  details_json: string
  actor_id: string | null
  created_at: string
}

function mapCampaignRow(row: RawCampaignRow, checks: CheckResult[] = []): CampaignContentPipelineRecord {
  return {
    id: row.id,
    campaignSlug: row.campaign_slug,
    title: row.title,
    currentVersion: Number(row.current_version),
    publishedVersion: row.published_version !== null ? Number(row.published_version) : null,
    previousPublishedVersion: row.previous_published_version !== null ? Number(row.previous_published_version) : null,
    status: row.status as CampaignContentPipelineRecord['status'],
    publishAt: row.publish_at,
    unpublishAt: row.unpublish_at,
    document: JSON.parse(row.document_json) as CampaignDocument,
    version: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
    checks
  }
}

async function checkIdempotency(
  db: D1Database,
  commandId: string,
  payloadHash: string
): Promise<{ exists: boolean; pipelineId?: string }> {
  const existing = await db
    .prepare('SELECT command_id, pipeline_id, payload_hash FROM campaign_pipeline_commands WHERE command_id = ?')
    .bind(commandId)
    .first<{ command_id: string; pipeline_id: string; payload_hash: string }>()

  if (!existing) return { exists: false }
  if (existing.payload_hash !== payloadHash) {
    throw new CampaignPipelineError('idempotency_conflict', 409, 'Command payload hash does not match original command')
  }
  return { exists: true, pipelineId: existing.pipeline_id }
}

export async function saveCampaignDraft(
  db: D1Database,
  input: SaveDraftInput,
  actorId: string,
  nowIso: string
): Promise<CampaignContentPipelineRecord> {
  const validated = saveDraftSchema.parse(input)
  const payloadHash = computeHash(validated)

  const idemp = await checkIdempotency(db, validated.commandId, payloadHash)
  if (idemp.exists && idemp.pipelineId) {
    return getCampaignPipeline(db, idemp.pipelineId)
  }

  const existing = await db
    .prepare('SELECT * FROM campaign_content_pipeline WHERE campaign_slug = ?')
    .bind(validated.campaignSlug)
    .first<RawCampaignRow>()

  let id: string
  if (existing) {
    id = existing.id
    const nextCurrentVersion = Number(existing.current_version) + 1
    const res = (await db
      .prepare(
        `
        UPDATE campaign_content_pipeline
        SET title = ?,
            document_json = ?,
            current_version = ?,
            status = 'draft',
            version = version + 1,
            updated_at = ?
        WHERE id = ? AND version = ?
      `
      )
      .bind(
        validated.title,
        JSON.stringify(validated.document),
        nextCurrentVersion,
        nowIso,
        existing.id,
        existing.version
      )
      .run()) as { meta?: { changes?: number }; success?: boolean }

    if (res?.meta?.changes === 0) {
      throw new CampaignPipelineError('concurrency_conflict', 409, 'CAS update failed')
    }
  } else {
    id = randomUUID()
    await db
      .prepare(
        `
        INSERT INTO campaign_content_pipeline (
          id, campaign_slug, title, current_version, published_version,
          previous_published_version, status, publish_at, unpublish_at,
          document_json, version, created_at, updated_at, created_by
        ) VALUES (?, ?, ?, 1, NULL, NULL, 'draft', NULL, NULL, ?, 1, ?, ?, ?)
      `
      )
      .bind(id, validated.campaignSlug, validated.title, JSON.stringify(validated.document), nowIso, nowIso, actorId)
      .run()
  }

  await db
    .prepare(
      `
      INSERT INTO campaign_pipeline_commands (
        id, command_id, actor_id, action, pipeline_id, payload_hash, payload_json, created_at
      ) VALUES (?, ?, ?, 'save_draft', ?, ?, ?, ?)
    `
    )
    .bind(randomUUID(), validated.commandId, actorId, id, payloadHash, JSON.stringify(validated), nowIso)
    .run()

  return getCampaignPipeline(db, id)
}

export async function getCampaignPipeline(db: D1Database, pipelineId: string): Promise<CampaignContentPipelineRecord> {
  const row = await db
    .prepare('SELECT * FROM campaign_content_pipeline WHERE id = ?')
    .bind(pipelineId)
    .first<RawCampaignRow>()

  if (!row) {
    throw new CampaignPipelineError('campaign_not_found', 404, `Campaign ${pipelineId} not found`)
  }

  const checkRows = await db
    .prepare(
      'SELECT * FROM campaign_pipeline_checks WHERE pipeline_id = ? AND content_version = ? ORDER BY created_at DESC'
    )
    .bind(pipelineId, row.current_version)
    .all<RawCheckRow>()

  const checks: CheckResult[] = (checkRows.results ?? []).map((c) => ({
    checkType: c.check_type as CheckResult['checkType'],
    passed: c.passed === 1,
    score: Number(c.score),
    violations: JSON.parse(c.violations_json),
    details: JSON.parse(c.details_json)
  }))

  return mapCampaignRow(row, checks)
}

export async function listCampaignPipelines(db: D1Database, limit = 50): Promise<CampaignContentPipelineRecord[]> {
  const rows = await db
    .prepare('SELECT * FROM campaign_content_pipeline ORDER BY created_at DESC LIMIT ?')
    .bind(limit)
    .all<RawCampaignRow>()

  return (rows.results ?? []).map((r) => mapCampaignRow(r))
}

export async function runCampaignChecks(
  db: D1Database,
  input: RunCampaignChecksInput,
  actorId: string,
  nowIso: string
): Promise<{ performancePassed: boolean; accessibilityPassed: boolean; checks: CheckResult[] }> {
  const validated = runCampaignChecksSchema.parse(input)
  const payloadHash = computeHash(validated)

  const idemp = await checkIdempotency(db, validated.commandId, payloadHash)
  if (idemp.exists && idemp.pipelineId) {
    const pipe = await getCampaignPipeline(db, idemp.pipelineId)
    const perf = pipe.checks?.find((c) => c.checkType === 'performance')
    const a11y = pipe.checks?.find((c) => c.checkType === 'accessibility')
    return {
      performancePassed: Boolean(perf?.passed),
      accessibilityPassed: Boolean(a11y?.passed),
      checks: pipe.checks ?? []
    }
  }

  const current = await getCampaignPipeline(db, validated.pipelineId)
  if (current.version !== validated.expectedVersion) {
    throw new CampaignPipelineError('concurrency_conflict', 409, 'Campaign was modified by another actor')
  }

  const perfResult = evaluateCampaignPerformance(current.document)
  const a11yResult = evaluateCampaignAccessibility(current.document)

  // Save checks
  for (const check of [perfResult, a11yResult]) {
    await db
      .prepare(
        `
        INSERT INTO campaign_pipeline_checks (
          id, pipeline_id, content_version, check_type, passed, score,
          violations_json, details_json, actor_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .bind(
        randomUUID(),
        validated.pipelineId,
        current.currentVersion,
        check.checkType,
        check.passed ? 1 : 0,
        check.score,
        JSON.stringify(check.violations),
        JSON.stringify(check.details),
        actorId,
        nowIso
      )
      .run()
  }

  await db
    .prepare(
      `
      INSERT INTO campaign_pipeline_commands (
        id, command_id, actor_id, action, pipeline_id, payload_hash, payload_json, created_at
      ) VALUES (?, ?, ?, 'run_checks', ?, ?, ?, ?)
    `
    )
    .bind(
      randomUUID(),
      validated.commandId,
      actorId,
      validated.pipelineId,
      payloadHash,
      JSON.stringify(validated),
      nowIso
    )
    .run()

  return {
    performancePassed: perfResult.passed,
    accessibilityPassed: a11yResult.passed,
    checks: [perfResult, a11yResult]
  }
}

export async function qaSignoffCampaign(
  db: D1Database,
  input: QaSignoffInput,
  actorId: string,
  nowIso: string
): Promise<CampaignContentPipelineRecord> {
  const validated = qaSignoffSchema.parse(input)
  const payloadHash = computeHash(validated)

  const idemp = await checkIdempotency(db, validated.commandId, payloadHash)
  if (idemp.exists && idemp.pipelineId) {
    return getCampaignPipeline(db, idemp.pipelineId)
  }

  const current = await getCampaignPipeline(db, validated.pipelineId)
  if (current.version !== validated.expectedVersion) {
    throw new CampaignPipelineError('concurrency_conflict', 409, 'Campaign was modified by another actor')
  }

  // Acceptance Criterion: performance & accessibility checks must pass before QA approval
  const checkRows = await db
    .prepare('SELECT check_type, passed FROM campaign_pipeline_checks WHERE pipeline_id = ? AND content_version = ?')
    .bind(validated.pipelineId, current.currentVersion)
    .all<{ check_type: string; passed: number }>()

  const perfPassed = checkRows.results?.some((c) => c.check_type === 'performance' && c.passed === 1)
  const a11yPassed = checkRows.results?.some((c) => c.check_type === 'accessibility' && c.passed === 1)

  if (!perfPassed || !a11yPassed) {
    throw new CampaignPipelineError(
      'qa_checks_unmet',
      400,
      'Performance and accessibility checks must pass before QA signoff'
    )
  }

  // Record QA review check
  await db
    .prepare(
      `
      INSERT INTO campaign_pipeline_checks (
        id, pipeline_id, content_version, check_type, passed, score,
        violations_json, details_json, actor_id, created_at
      ) VALUES (?, ?, ?, 'qa_review', 1, 100, '[]', ?, ?, ?)
    `
    )
    .bind(
      randomUUID(),
      validated.pipelineId,
      current.currentVersion,
      JSON.stringify({ notes: validated.notes }),
      actorId,
      nowIso
    )
    .run()

  const res = (await db
    .prepare(
      `
      UPDATE campaign_content_pipeline
      SET status = 'qa_approved',
          version = version + 1,
          updated_at = ?
      WHERE id = ? AND version = ?
    `
    )
    .bind(nowIso, validated.pipelineId, validated.expectedVersion)
    .run()) as { meta?: { changes?: number }; success?: boolean }

  if (res?.meta?.changes === 0) {
    throw new CampaignPipelineError('concurrency_conflict', 409, 'CAS update failed')
  }

  await db
    .prepare(
      `
      INSERT INTO campaign_pipeline_commands (
        id, command_id, actor_id, action, pipeline_id, payload_hash, payload_json, created_at
      ) VALUES (?, ?, ?, 'qa_signoff', ?, ?, ?, ?)
    `
    )
    .bind(
      randomUUID(),
      validated.commandId,
      actorId,
      validated.pipelineId,
      payloadHash,
      JSON.stringify(validated),
      nowIso
    )
    .run()

  return getCampaignPipeline(db, validated.pipelineId)
}

export async function scheduleCampaignPublication(
  db: D1Database,
  input: SchedulePublicationInput,
  actorId: string,
  nowIso: string
): Promise<CampaignContentPipelineRecord> {
  const validated = schedulePublicationSchema.parse(input)
  const payloadHash = computeHash(validated)

  const idemp = await checkIdempotency(db, validated.commandId, payloadHash)
  if (idemp.exists && idemp.pipelineId) {
    return getCampaignPipeline(db, idemp.pipelineId)
  }

  const current = await getCampaignPipeline(db, validated.pipelineId)
  if (current.version !== validated.expectedVersion) {
    throw new CampaignPipelineError('concurrency_conflict', 409, 'Campaign was modified by another actor')
  }

  if (current.status !== 'qa_approved' && current.status !== 'published') {
    throw new CampaignPipelineError(
      'campaign_not_approved_for_schedule',
      400,
      `Cannot schedule campaign with status ${current.status}; must be qa_approved`
    )
  }

  const res = (await db
    .prepare(
      `
      UPDATE campaign_content_pipeline
      SET status = 'scheduled',
          publish_at = ?,
          unpublish_at = ?,
          version = version + 1,
          updated_at = ?
      WHERE id = ? AND version = ?
    `
    )
    .bind(validated.publishAt, validated.unpublishAt ?? null, nowIso, validated.pipelineId, validated.expectedVersion)
    .run()) as { meta?: { changes?: number }; success?: boolean }

  if (res?.meta?.changes === 0) {
    throw new CampaignPipelineError('concurrency_conflict', 409, 'CAS update failed')
  }

  await db
    .prepare(
      `
      INSERT INTO campaign_pipeline_commands (
        id, command_id, actor_id, action, pipeline_id, payload_hash, payload_json, created_at
      ) VALUES (?, ?, ?, 'schedule_publication', ?, ?, ?, ?)
    `
    )
    .bind(
      randomUUID(),
      validated.commandId,
      actorId,
      validated.pipelineId,
      payloadHash,
      JSON.stringify(validated),
      nowIso
    )
    .run()

  return getCampaignPipeline(db, validated.pipelineId)
}

export async function publishCampaignNow(
  db: D1Database,
  input: PublishCampaignNowInput,
  actorId: string,
  nowIso: string
): Promise<CampaignContentPipelineRecord> {
  const validated = publishCampaignNowSchema.parse(input)
  const payloadHash = computeHash(validated)

  const idemp = await checkIdempotency(db, validated.commandId, payloadHash)
  if (idemp.exists && idemp.pipelineId) {
    return getCampaignPipeline(db, idemp.pipelineId)
  }

  const current = await getCampaignPipeline(db, validated.pipelineId)
  if (current.version !== validated.expectedVersion) {
    throw new CampaignPipelineError('concurrency_conflict', 409, 'Campaign was modified by another actor')
  }

  if (current.status !== 'qa_approved' && current.status !== 'scheduled') {
    throw new CampaignPipelineError(
      'campaign_not_approved_for_publish',
      400,
      `Cannot publish campaign in ${current.status} status; must be qa_approved or scheduled`
    )
  }

  const prevPublished = current.publishedVersion
  const newPublished = current.currentVersion

  const res = (await db
    .prepare(
      `
      UPDATE campaign_content_pipeline
      SET status = 'published',
          published_version = ?,
          previous_published_version = ?,
          publish_at = ?,
          version = version + 1,
          updated_at = ?
      WHERE id = ? AND version = ?
    `
    )
    .bind(newPublished, prevPublished, nowIso, nowIso, validated.pipelineId, validated.expectedVersion)
    .run()) as { meta?: { changes?: number }; success?: boolean }

  if (res?.meta?.changes === 0) {
    throw new CampaignPipelineError('concurrency_conflict', 409, 'CAS update failed')
  }

  await db
    .prepare(
      `
      INSERT INTO campaign_pipeline_commands (
        id, command_id, actor_id, action, pipeline_id, payload_hash, payload_json, created_at
      ) VALUES (?, ?, ?, 'publish_now', ?, ?, ?, ?)
    `
    )
    .bind(
      randomUUID(),
      validated.commandId,
      actorId,
      validated.pipelineId,
      payloadHash,
      JSON.stringify(validated),
      nowIso
    )
    .run()

  return getCampaignPipeline(db, validated.pipelineId)
}

export async function rollbackCampaignPublication(
  db: D1Database,
  input: RollbackCampaignInput,
  actorId: string,
  nowIso: string
): Promise<CampaignContentPipelineRecord> {
  const validated = rollbackCampaignSchema.parse(input)
  const payloadHash = computeHash(validated)

  const idemp = await checkIdempotency(db, validated.commandId, payloadHash)
  if (idemp.exists && idemp.pipelineId) {
    return getCampaignPipeline(db, idemp.pipelineId)
  }

  const current = await getCampaignPipeline(db, validated.pipelineId)
  if (current.version !== validated.expectedVersion) {
    throw new CampaignPipelineError('concurrency_conflict', 409, 'Campaign was modified by another actor')
  }

  if (!current.previousPublishedVersion) {
    throw new CampaignPipelineError(
      'no_previous_version_to_rollback',
      400,
      'No previous published version exists for rollback'
    )
  }

  const rolledBackVersion = current.previousPublishedVersion

  const res = (await db
    .prepare(
      `
      UPDATE campaign_content_pipeline
      SET status = 'rolled_back',
          published_version = ?,
          version = version + 1,
          updated_at = ?
      WHERE id = ? AND version = ?
    `
    )
    .bind(rolledBackVersion, nowIso, validated.pipelineId, validated.expectedVersion)
    .run()) as { meta?: { changes?: number }; success?: boolean }

  if (res?.meta?.changes === 0) {
    throw new CampaignPipelineError('concurrency_conflict', 409, 'CAS update failed')
  }

  await db
    .prepare(
      `
      INSERT INTO campaign_pipeline_commands (
        id, command_id, actor_id, action, pipeline_id, payload_hash, payload_json, created_at
      ) VALUES (?, ?, ?, 'rollback_published', ?, ?, ?, ?)
    `
    )
    .bind(
      randomUUID(),
      validated.commandId,
      actorId,
      validated.pipelineId,
      payloadHash,
      JSON.stringify(validated),
      nowIso
    )
    .run()

  return getCampaignPipeline(db, validated.pipelineId)
}
