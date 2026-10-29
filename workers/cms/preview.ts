import { defaults, seal, unseal } from 'iron-webcrypto'
import { z } from 'zod'
import { ironCrypto } from '../auth/iron-crypto'
import {
  catalogPolicyUuidSchema as uuid,
  catalogPolicyInstantSchema as instant
} from '../../shared/catalog-publication-policy'
import { cmsNow, cmsSource, CmsPublicationError, type CmsPublicationDependencies } from './publication-gate'
import { sha256Hex } from '../catalog/inventory'
const claimsSchema = z
  .object({
    audience: z.literal('neteco-cms-preview-v1'),
    id: uuid,
    pageId: uuid,
    versionId: uuid,
    segment: z.literal('default'),
    device: z.enum(['responsive', 'desktop', 'mobile']),
    createdAt: instant,
    expiresAt: instant,
    origin: z.string()
  })
  .strict()
export function cmsPreviewConfigured(deps: CmsPublicationDependencies) {
  const config = deps.preview
  if (
    !config ||
    typeof config.secret !== 'string' ||
    config.secret.length < 48 ||
    config.secret.length > 1024 ||
    config.secret.startsWith('local-only-') ||
    new Set(config.secret).size < 12
  )
    return false
  try {
    const origin = new URL(config.origin)
    return origin.protocol === 'https:' && origin.origin === config.origin
  } catch {
    return false
  }
}
export async function sealCmsPreview(
  deps: CmsPublicationDependencies,
  input: { id: string; pageId: string; versionId: string; device: 'responsive' | 'desktop' | 'mobile' }
) {
  if (!cmsPreviewConfigured(deps) || !deps.preview) throw new CmsPublicationError('preview_unavailable')
  const createdAt = cmsNow(deps),
    expiresAt = new Date(Date.parse(createdAt) + 1800000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const claims = claimsSchema.parse({
    ...input,
    audience: 'neteco-cms-preview-v1',
    segment: 'default',
    createdAt,
    expiresAt,
    origin: deps.preview.origin
  })
  const token = await seal(ironCrypto, claims, deps.preview.secret, { ...defaults, ttl: 1800000 })
  return { token, hash: await sha256Hex(token), claims }
}
export async function verifyCmsPreview(deps: CmsPublicationDependencies, token: string) {
  if (!cmsPreviewConfigured(deps) || !deps.preview || typeof token !== 'string' || token.length > 4096)
    throw new CmsPublicationError('not_found')
  let raw: unknown
  try {
    raw = await unseal(ironCrypto, token, deps.preview.secret, { ...defaults, ttl: 1800000 })
  } catch {
    throw new CmsPublicationError('not_found')
  }
  const parsed = claimsSchema.safeParse(raw)
  if (!parsed.success) throw new CmsPublicationError('not_found')
  const claims = parsed.data,
    now = cmsNow(deps)
  if (
    claims.origin !== deps.preview.origin ||
    claims.createdAt > now ||
    claims.expiresAt <= now ||
    Date.parse(claims.expiresAt) - Date.parse(claims.createdAt) !== 1800000
  )
    throw new CmsPublicationError('not_found')
  const row = await deps.database
    .prepare(
      `SELECT id,page_id,version_id,device,segment,created_at,expires_at FROM content_previews p
 WHERE p.id=? AND p.token_hash=? AND p.expires_at>? AND NOT EXISTS(SELECT 1 FROM content_preview_revocations WHERE preview_id=p.id)`
    )
    .bind(claims.id, await sha256Hex(token), now)
    .first()
  if (row === null) throw new CmsPublicationError('not_found')
  const confirmed = cmsSource(
    z
      .object({
        id: uuid,
        page_id: uuid,
        version_id: uuid,
        device: z.enum(['responsive', 'desktop', 'mobile']),
        segment: z.literal('default'),
        created_at: instant,
        expires_at: instant
      })
      .strict(),
    row
  )
  if (
    confirmed.page_id !== claims.pageId ||
    confirmed.version_id !== claims.versionId ||
    confirmed.device !== claims.device ||
    confirmed.created_at !== claims.createdAt ||
    confirmed.expires_at !== claims.expiresAt
  )
    throw new CmsPublicationError('not_found')
  return claims
}
