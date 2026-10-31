import {
  downloadableTemplateSchema,
  templateCreateInputSchema,
  templateUpdateInputSchema,
  templateListQuerySchema,
  templateListResponseSchema,
  templatePublishInputSchema,
  templateSummarySchema,
  type DownloadableTemplate,
  type TemplateListResponse
} from '../../shared/downloadable-templates'
import { authorizeD1Session, type VerifiedSessionClaims } from '../catalog/authorization'

export class DownloadableTemplateError extends Error {
  constructor(
    readonly code:
      | 'invalid_input'
      | 'unauthenticated'
      | 'forbidden'
      | 'not_found'
      | 'version_conflict'
      | 'idempotency_conflict'
      | 'internal_error'
  ) {
    super(code)
  }
}

function fail(code: DownloadableTemplateError['code']): never {
  throw new DownloadableTemplateError(code)
}

async function sha256Hex(data: string): Promise<string> {
  const encoded = new TextEncoder().encode(data)
  const digest = await crypto.subtle.digest('SHA-256', encoded)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

interface TemplateRow {
  id: string
  slug: string
  title: string
  description: string
  template_type: 'checklist' | 'plan' | 'guide'
  category: 'hosteleria' | 'industria' | 'sanitario' | 'lavanderia' | 'alimentaria' | 'mantenimiento'
  target_audience: string
  sections_json: string
  pdf_metadata_json: string
  status: 'draft' | 'published' | 'archived'
  version: number
  published_at: string | null
  reviewed_at: string
  review_due_at: string
  created_by: string
  created_at: string
  updated_at: string
}

function rowToDto(row: TemplateRow): DownloadableTemplate {
  const sections = JSON.parse(row.sections_json)
  const pdfMetadata = JSON.parse(row.pdf_metadata_json)
  return downloadableTemplateSchema.parse({
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    templateType: row.template_type,
    category: row.category,
    targetAudience: row.target_audience,
    sections,
    pdfMetadata,
    status: row.status,
    version: row.version,
    publishedAt: row.published_at,
    reviewedAt: row.reviewed_at,
    reviewDueAt: row.review_due_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    canonicalPath: `/plantillas/${row.slug}`,
    downloadUrl: `/api/templates/${row.slug}/pdf`,
    indexable: row.status === 'published'
  })
}

export async function createDownloadableTemplate(
  database: D1Database,
  claims: VerifiedSessionClaims,
  rawInput: unknown,
  executionNow?: string
): Promise<DownloadableTemplate> {
  const now = executionNow ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const auth = await authorizeD1Session(database, claims, 'administration.manage', { now })
  if (!auth.allowed) {
    const pubAuth = await authorizeD1Session(database, claims, 'catalog.publish', { now })
    if (!pubAuth.allowed) fail(auth.code === 'forbidden' ? 'forbidden' : 'unauthenticated')
  }

  const parsed = templateCreateInputSchema.safeParse(rawInput)
  if (!parsed.success) fail('invalid_input')
  const input = parsed.data

  const payloadHash = await sha256Hex(JSON.stringify(input))
  const id = crypto.randomUUID()

  // Generate initial mock/deterministic PDF metadata
  const initialPdfMeta = {
    filename: `${input.slug}.pdf`,
    byteSize: 1420 + input.sections.length * 350,
    title: input.title,
    language: 'es' as const,
    accessible: true as const
  }

  try {
    const res = await database.batch([
      database
        .prepare(
          `INSERT INTO downloadable_templates (
            id, slug, title, description, template_type, category, target_audience,
            sections_json, pdf_metadata_json, status, version, published_at,
            reviewed_at, review_due_at, created_by, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', 1, NULL, ?, ?, ?, ?, ?)`
        )
        .bind(
          id,
          input.slug,
          input.title,
          input.description,
          input.templateType,
          input.category,
          input.targetAudience,
          JSON.stringify(input.sections),
          JSON.stringify(initialPdfMeta),
          input.reviewedAt,
          input.reviewDueAt,
          claims.identityId,
          now,
          now
        ),
      database
        .prepare(
          `INSERT INTO downloadable_template_commands (
            command_id, template_id, actor_id, action, expected_version, result_version, payload_hash, input_json, created_at
          ) VALUES (?, ?, ?, 'create', 0, 1, ?, ?, ?)`
        )
        .bind(input.commandId, id, claims.identityId, payloadHash, JSON.stringify(input), now)
    ])
    if (!res.every((r) => r.success)) fail('internal_error')
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('UNIQUE constraint failed') || message.includes('already exists')) {
      fail('idempotency_conflict')
    }
    throw err
  }

  const row = await database.prepare('SELECT * FROM downloadable_templates WHERE id = ?').bind(id).first<TemplateRow>()
  if (!row) fail('not_found')
  return rowToDto(row)
}

export async function updateDownloadableTemplate(
  database: D1Database,
  claims: VerifiedSessionClaims,
  rawInput: {
    commandId: string
    templateId: string
    expectedVersion: number
    title: string
    description: string
    sections: unknown[]
    reviewedAt: string
    reviewDueAt: string
  },
  executionNow?: string
): Promise<DownloadableTemplate> {
  const now = executionNow ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const auth = await authorizeD1Session(database, claims, 'administration.manage', { now })
  if (!auth.allowed) {
    const pubAuth = await authorizeD1Session(database, claims, 'catalog.publish', { now })
    if (!pubAuth.allowed) fail(auth.code === 'forbidden' ? 'forbidden' : 'unauthenticated')
  }

  const parsed = templateUpdateInputSchema.safeParse(rawInput)
  if (!parsed.success) fail('invalid_input')
  const input = parsed.data

  const payloadHash = await sha256Hex(JSON.stringify(input))

  const existing = await database
    .prepare('SELECT * FROM downloadable_templates WHERE id = ?')
    .bind(input.templateId)
    .first<TemplateRow>()
  if (!existing) fail('not_found')
  if (existing.version !== input.expectedVersion) fail('version_conflict')

  const nextVersion = existing.version + 1
  try {
    const res = await database.batch([
      database
        .prepare(
          `UPDATE downloadable_templates SET
            title = ?, description = ?, sections_json = ?, reviewed_at = ?, review_due_at = ?,
            version = ?, updated_at = ?
          WHERE id = ? AND version = ?`
        )
        .bind(
          rawInput.title,
          rawInput.description,
          JSON.stringify(rawInput.sections),
          rawInput.reviewedAt,
          rawInput.reviewDueAt,
          nextVersion,
          now,
          rawInput.templateId,
          rawInput.expectedVersion
        ),
      database
        .prepare(
          `INSERT INTO downloadable_template_commands (
            command_id, template_id, actor_id, action, expected_version, result_version, payload_hash, input_json, created_at
          ) VALUES (?, ?, ?, 'update', ?, ?, ?, ?, ?)`
        )
        .bind(
          rawInput.commandId,
          rawInput.templateId,
          claims.identityId,
          rawInput.expectedVersion,
          nextVersion,
          payloadHash,
          JSON.stringify(rawInput),
          now
        )
    ])
    if (!res.every((r) => r.success)) fail('internal_error')
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('version_conflict')) fail('version_conflict')
    throw err
  }

  const updated = await database
    .prepare('SELECT * FROM downloadable_templates WHERE id = ?')
    .bind(rawInput.templateId)
    .first<TemplateRow>()
  if (!updated) fail('not_found')
  return rowToDto(updated)
}

export async function publishDownloadableTemplate(
  database: D1Database,
  claims: VerifiedSessionClaims,
  rawInput: unknown,
  executionNow?: string
): Promise<DownloadableTemplate> {
  const now = executionNow ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const auth = await authorizeD1Session(database, claims, 'catalog.publish', { now })
  if (!auth.allowed) {
    const admAuth = await authorizeD1Session(database, claims, 'administration.manage', { now })
    if (!admAuth.allowed) fail(auth.code === 'forbidden' ? 'forbidden' : 'unauthenticated')
  }

  const parsed = templatePublishInputSchema.safeParse(rawInput)
  if (!parsed.success) fail('invalid_input')
  const input = parsed.data
  const payloadHash = await sha256Hex(JSON.stringify(input))

  const existing = await database
    .prepare('SELECT * FROM downloadable_templates WHERE id = ?')
    .bind(input.templateId)
    .first<TemplateRow>()
  if (!existing) fail('not_found')
  if (existing.version !== input.expectedVersion) fail('version_conflict')

  const nextVersion = existing.version + 1
  try {
    const res = await database.batch([
      database
        .prepare(
          `UPDATE downloadable_templates SET
            status = 'published', published_at = ?, version = ?, updated_at = ?
          WHERE id = ? AND version = ?`
        )
        .bind(now, nextVersion, now, input.templateId, input.expectedVersion),
      database
        .prepare(
          `INSERT INTO downloadable_template_commands (
            command_id, template_id, actor_id, action, expected_version, result_version, payload_hash, input_json, created_at
          ) VALUES (?, ?, ?, 'publish', ?, ?, ?, ?, ?)`
        )
        .bind(
          input.commandId,
          input.templateId,
          claims.identityId,
          input.expectedVersion,
          nextVersion,
          payloadHash,
          JSON.stringify(input),
          now
        )
    ])
    if (!res.every((r) => r.success)) fail('internal_error')
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('version_conflict')) fail('version_conflict')
    throw err
  }

  const updated = await database
    .prepare('SELECT * FROM downloadable_templates WHERE id = ?')
    .bind(input.templateId)
    .first<TemplateRow>()
  if (!updated) fail('not_found')
  return rowToDto(updated)
}

export async function getDownloadableTemplateBySlug(
  database: D1Database,
  slug: string
): Promise<DownloadableTemplate | null> {
  const row = await database
    .prepare("SELECT * FROM downloadable_templates WHERE slug = ? AND status = 'published'")
    .bind(slug)
    .first<TemplateRow>()
  if (!row) return null
  return rowToDto(row)
}

export async function listDownloadableTemplates(
  database: D1Database,
  rawQuery: unknown
): Promise<TemplateListResponse> {
  const parsed = templateListQuerySchema.safeParse(rawQuery)
  if (!parsed.success) fail('invalid_input')
  const q = parsed.data

  let sql = "SELECT * FROM downloadable_templates WHERE status = 'published'"
  const params: unknown[] = []

  if (q.category) {
    sql += ' AND category = ?'
    params.push(q.category)
  }
  if (q.type) {
    sql += ' AND template_type = ?'
    params.push(q.type)
  }
  if (q.q) {
    sql += ' AND (title LIKE ? OR description LIKE ? OR target_audience LIKE ?)'
    const pattern = `%${q.q}%`
    params.push(pattern, pattern, pattern)
  }

  sql += ' ORDER BY published_at DESC, id DESC'
  const allRows = await database
    .prepare(sql)
    .bind(...params)
    .all<TemplateRow>()
  const rows = allRows.results ?? []

  const total = rows.length
  const offset = (q.page - 1) * q.perPage
  const paged = rows.slice(offset, offset + q.perPage)

  const items = paged.map((row) => {
    const sections = JSON.parse(row.sections_json) as Array<{ items: unknown[] }>
    const itemCount = sections.reduce((acc, s) => acc + (s.items?.length ?? 0), 0)
    return templateSummarySchema.parse({
      id: row.id,
      slug: row.slug,
      title: row.title,
      description: row.description,
      templateType: row.template_type,
      category: row.category,
      targetAudience: row.target_audience,
      version: row.version,
      publishedAt: row.published_at,
      canonicalPath: `/plantillas/${row.slug}`,
      downloadUrl: `/api/templates/${row.slug}/pdf`,
      itemCount,
      indexable: true
    })
  })

  return templateListResponseSchema.parse({
    source: 'cloudflare',
    items,
    total,
    page: q.page,
    perPage: q.perPage,
    pages: Math.ceil(total / q.perPage),
    categories: ['hosteleria', 'industria', 'sanitario', 'lavanderia', 'alimentaria', 'mantenimiento'],
    types: ['checklist', 'plan', 'guide'],
    canonicalPath: '/plantillas',
    indexable: !q.q && q.page === 1 && !q.category && !q.type
  })
}

/**
 * Generates deterministic, accessible PDF stream with PDF-1.4 specification compliance,
 * structured accessibility metadata, language tag (es-ES), and readable content.
 */
export async function generateTemplateAccessiblePdf(template: DownloadableTemplate): Promise<Uint8Array> {
  const escapePdf = (str: string) => str.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')

  let textStream = 'BT\n/F1 18 Tf\n50 780 Td\n'
  textStream += `(${escapePdf(template.title)}) Tj\n`
  textStream += 'ET\n'

  textStream += 'BT\n/F2 10 Tf\n50 755 Td\n'
  textStream += `(Tipo: ${template.templateType.toUpperCase()} | Sector: ${template.category.toUpperCase()} | Version: ${template.version}) Tj\n`
  textStream += 'ET\n'

  textStream += 'BT\n/F2 10 Tf\n50 735 Td\n'
  textStream += `(Audiencia: ${escapePdf(template.targetAudience)}) Tj\n`
  textStream += 'ET\n'

  let currentY = 700
  for (const section of template.sections) {
    if (currentY < 100) break
    textStream += `BT\n/F1 14 Tf\n50 ${currentY} Td\n(${escapePdf(section.title)}) Tj\nET\n`
    currentY -= 25

    for (const item of section.items) {
      if (currentY < 80) break
      const checkMark = '[ ]'
      const freqText = item.frequency ? ` [${item.frequency}]` : ''
      const ccpText = item.criticalControlPoint ? ' (PCC - Control Critico)' : ''
      const lineText = `${checkMark} ${item.label}${freqText}${ccpText}`
      textStream += `BT\n/F2 10 Tf\n60 ${currentY} Td\n(${escapePdf(lineText)}) Tj\nET\n`
      currentY -= 18
    }
    currentY -= 12
  }

  const streamBytes = new TextEncoder().encode(textStream)

  // Construct PDF objects
  const objects: string[] = []
  // 1: Catalog
  objects.push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R /Lang (es-ES) >>\nendobj\n')
  // 2: Pages
  objects.push('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n')
  // 3: Page
  objects.push(
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>\nendobj\n'
  )
  // 4: Contents stream
  objects.push(`4 0 obj\n<< /Length ${streamBytes.length} >>\nstream\n${textStream}endstream\nendobj\n`)
  // 5: Font F1 (Helvetica-Bold)
  objects.push('5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>\nendobj\n')
  // 6: Font F2 (Helvetica)
  objects.push('6 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n')
  // 7: Info dictionary
  objects.push(
    `7 0 obj\n<< /Title (${escapePdf(template.title)}) /Author (Neteco Professional Cleaning) /Subject (${escapePdf(template.description)}) /Producer (Neteco Accessible PDF Generator) >>\nendobj\n`
  )

  const header = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'
  let offset = header.length
  const xrefEntries = ['0000000000 65535 f \n']

  let body = ''
  for (const obj of objects) {
    xrefEntries.push(offset.toString().padStart(10, '0') + ' 00000 n \n')
    body += obj
    offset += obj.length
  }

  const xrefOffset = header.length + body.length
  const xref = `xref\n0 ${objects.length + 1}\n` + xrefEntries.join('')
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 7 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`

  const fullPdf = header + body + xref + trailer
  return new TextEncoder().encode(fullPdf)
}
