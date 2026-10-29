import { z } from 'zod'
import { cmsDocumentSchema } from '../../shared/cms-commands'
import {
  catalogPolicyOwnJson,
  catalogPolicyInstantSchema,
  catalogPolicyUuidSchema
} from '../../shared/catalog-publication-policy'
import { ownedBytes } from '../media/public-delivery'
import { detectMediaType } from '../../shared/media-envelope'
export interface CmsPublicationDependencies {
  database: D1Database
  enabled: boolean
  bucket?: Pick<R2Bucket, 'get'>
  images?: Pick<ImagesBinding, 'input'>
  preview?: { secret: string; origin: string }
  now?: () => string
}
export class CmsPublicationError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}
export function cmsNow(deps: Pick<CmsPublicationDependencies, 'now'>) {
  return catalogPolicyInstantSchema.parse(deps.now?.() ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'))
}
export function cmsSource<T, I>(schema: z.ZodType<T, z.ZodTypeDef, I>, value: unknown): T {
  try {
    return schema.parse(catalogPolicyOwnJson(value))
  } catch {
    throw new CmsPublicationError('read_unconfirmed')
  }
}
export const cmsVersionRowSchema = z
  .object({
    id: catalogPolicyUuidSchema,
    page_id: catalogPolicyUuidSchema,
    version: z.number().int().min(1),
    document: z.string().max(262144)
  })
  .strict()
export async function cmsVersion(database: D1Database, pageId: string, versionId: string) {
  const raw = await database
    .prepare('SELECT id,page_id,version,document FROM content_versions WHERE page_id=? AND id=?')
    .bind(pageId, versionId)
    .first()
  if (raw === null) throw new CmsPublicationError('not_found')
  const row = cmsSource(cmsVersionRowSchema, raw)
  return { ...row, document: cmsSource(cmsDocumentSchema, JSON.parse(row.document)) }
}
export const cmsEvidenceSchema = z
  .object({
    upload_id: catalogPolicyUuidSchema,
    object_key: z.string(),
    checksum: z.string().regex(/^[0-9a-f]{64}$/),
    byte_size: z.number().int().min(1).max(10485760),
    r2_etag: z.string().min(1),
    content_type: z.enum(['image/png', 'image/jpeg']),
    scan_receipt_id: catalogPolicyUuidSchema,
    rights_decision_id: catalogPolicyUuidSchema
  })
  .strict()
export type CmsEvidence = z.infer<typeof cmsEvidenceSchema>
// Asset-level evidence is reused; product_media_publications is deliberately absent.
export const cmsAssetEvidenceSql = `SELECT u.id AS upload_id,u.object_key,u.checksum,u.byte_size,u.r2_etag,u.content_type,
 s.id AS scan_receipt_id,r.id AS rights_decision_id FROM media_uploads u
 JOIN media_scan_receipts s ON s.upload_id=u.id AND s.seq=(SELECT max(seq) FROM media_scan_receipts WHERE upload_id=u.id)
 JOIN media_rights_decisions r ON r.upload_id=u.id AND r.seq=(SELECT max(seq) FROM media_rights_decisions WHERE upload_id=u.id)
 WHERE u.storage_status='quarantined' AND u.stored_at<=?1 AND u.r2_etag IS NOT NULL
 AND u.object_key='quarantine/'||u.id||'/'||u.checksum AND u.content_type IN ('image/png','image/jpeg')
 AND s.verdict='clean' AND s.scanned_at<=?1 AND s.expires_at>?1 AND s.received_at<=?1
 AND s.checksum=u.checksum AND s.byte_size=u.byte_size AND s.object_key=u.object_key
 AND r.decision='approved' AND r.created_at<=?1 AND r.evidence_authorized_at<=substr(?1,1,10)`
export async function cmsEvidence(deps: CmsPublicationDependencies, uploadId: string) {
  const row = await deps.database
    .prepare(`SELECT * FROM (${cmsAssetEvidenceSql}) WHERE upload_id=?2`)
    .bind(cmsNow(deps), uploadId)
    .first()
  if (row === null) throw new CmsPublicationError('media_blocked')
  return cmsSource(cmsEvidenceSchema, row)
}
export async function cmsOwnedImage(deps: CmsPublicationDependencies, evidence: CmsEvidence) {
  if (!deps.bucket) throw new CmsPublicationError('media_unavailable')
  const object = await deps.bucket.get(evidence.object_key)
  if (!object || object.etag !== evidence.r2_etag || object.size !== evidence.byte_size)
    throw new CmsPublicationError('media_blocked')
  const bytes = await ownedBytes(object.body, 10485760, evidence.byte_size)
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('')
  if (digest !== evidence.checksum || detectMediaType(bytes) !== evidence.content_type)
    throw new CmsPublicationError('media_blocked')
  if (JSON.stringify(await cmsEvidence(deps, evidence.upload_id)) !== JSON.stringify(evidence))
    throw new CmsPublicationError('media_blocked')
  return bytes
}
export async function cmsDocumentMedia(deps: CmsPublicationDependencies, document: z.infer<typeof cmsDocumentSchema>) {
  const result: Array<{ blockId: string; evidence: CmsEvidence }> = []
  for (const block of document.blocks) {
    if (block.type !== 'image') continue
    if (!deps.images) throw new CmsPublicationError('media_unavailable')
    const evidence = await cmsEvidence(deps, block.assetId)
    await cmsOwnedImage(deps, evidence)
    result.push({ blockId: block.id, evidence })
  }
  return result
}
/** Exact links pinned to the approved version, with fresh legal/scanner verdicts. */
export function cmsLinksValidSql(owner: string, version: string, now: string) {
  // Same balanced conjunction pattern as catalogue/media validity: SQL AND
  // retains its three-valued semantics, without a linear expression height
  // inherited by delivery/lease predicates that reuse this authority.
  function balancedConjunction(clauses: readonly string[]): string {
    if (clauses.length === 1) return `(${clauses[0]})`
    if (!clauses.length) throw new Error('empty_publication_conjunction')
    const middle = Math.floor(clauses.length / 2)
    return `(${balancedConjunction(clauses.slice(0, middle))} AND ${balancedConjunction(clauses.slice(middle))})`
  }
  const media = `NOT EXISTS(
 SELECT 1 FROM content_media_links l JOIN media_uploads u ON u.id=l.upload_id
 JOIN media_scan_receipts s ON s.id=l.scan_receipt_id AND s.upload_id=u.id
 JOIN media_rights_decisions r ON r.id=l.rights_decision_id AND r.upload_id=u.id
 WHERE ${balancedConjunction([
   `l.owner_id=${owner}`,
   'l.version_id=cv.id',
   "l.block_id=json_extract(b.value,'$.id')",
   "u.id=json_extract(b.value,'$.assetId')",
   "u.storage_status='quarantined'",
   `u.stored_at<=${now}`,
   'u.r2_etag IS NOT NULL',
   "u.object_key='quarantine/'||u.id||'/'||u.checksum",
   "u.content_type IN ('image/png','image/jpeg')",
   "s.verdict='clean'",
   `s.scanned_at<=${now}`,
   `s.expires_at>${now}`,
   `s.received_at<=${now}`,
   's.seq=(SELECT max(seq) FROM media_scan_receipts WHERE upload_id=u.id)',
   's.checksum=u.checksum',
   's.object_key=u.object_key',
   's.byte_size=u.byte_size',
   "r.decision='approved'",
   `r.created_at<=${now}`,
   'r.seq=(SELECT max(seq) FROM media_rights_decisions WHERE upload_id=u.id)'
 ])})`
  return `NOT EXISTS(SELECT 1 FROM content_versions cv,json_each(cv.document,'$.blocks') b
 WHERE ${balancedConjunction([`cv.id=${version}`, "json_extract(b.value,'$.type')='image'", media])})`
}
/** Shared by public lookups, redirect and sitemap consumers. Bind server time. */
export function cmsPublishedValiditySql(
  publicationAlias = 'release',
  stateAlias = 'head',
  now = "strftime('%Y-%m-%dT%H:%M:%SZ','now')"
) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(publicationAlias) || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(stateAlias))
    throw new Error('invalid_cms_sql_alias')
  return `${stateAlias}.publication_id=${publicationAlias}.id AND ${publicationAlias}.published_at<=${now} AND ${cmsLinksValidSql(`${publicationAlias}.id`, `${publicationAlias}.version_id`, now)}`
}
