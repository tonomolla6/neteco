import { z } from 'zod'
import { catalogPolicyOwnJson, catalogPolicyInstantSchema } from '../../shared/catalog-publication-policy'
import { authorizeD1Session, type VerifiedSessionClaims } from '../catalog/authorization'
import type { SessionCookieConfiguration } from '../auth/session-cookie'
import type { NewsletterSecrets } from './newsletter'
import type { CmsPublicationDependencies } from '../cms/publication-gate'
import type { NewsletterEditorialTransport } from './newsletter-campaign-transport'

export interface NewsletterEditorialDependencies {
  database: D1Database
  /** Missing is OFF; data authoring does not enable any delivery. */
  enabled?: boolean
  publicOrigin: string
  now?: () => string
  newsletterSecrets?: NewsletterSecrets
  transport?: NewsletterEditorialTransport
  /** Synthetic preview only: cannot share the real delivery binding. */
  previewSenderFactory?: () => import('./newsletter-campaign-transport').NewsletterEditorialSender | undefined
  cmsPublication?: Omit<CmsPublicationDependencies, 'database'>
}
export interface NewsletterEditorialHttpDependencies extends NewsletterEditorialDependencies {
  session?: SessionCookieConfiguration
  edgeLimiter?: RateLimit
  rateLimitPepper?: string
  feedback?: { secret: Uint8Array; provider: 'local-fake' | 'cloudflare-email' }
}
export class NewsletterEditorialError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}
export function editorialNow(deps: Pick<NewsletterEditorialDependencies, 'now'>) {
  return catalogPolicyInstantSchema.parse(deps.now?.() ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'))
}
export function editorialEpoch(deps: Pick<NewsletterEditorialDependencies, 'now'>) {
  return Math.floor(Date.parse(editorialNow(deps)) / 1000)
}
export function editorialSource<T, I>(schema: z.ZodType<T, I>, input: unknown): T {
  try {
    return schema.parse(catalogPolicyOwnJson(input))
  } catch {
    throw new NewsletterEditorialError('read_unconfirmed')
  }
}
export function editorialJson<T, I>(schema: z.ZodType<T, I>, input: unknown): T {
  try {
    return editorialSource(schema, typeof input === 'string' ? JSON.parse(input) : input)
  } catch {
    throw new NewsletterEditorialError('read_unconfirmed')
  }
}
export function assertEditorialEnabled(deps: NewsletterEditorialDependencies) {
  if (deps.enabled !== true) throw new NewsletterEditorialError('feature_unavailable')
  const origin = new URL(deps.publicOrigin)
  if (origin.protocol !== 'https:' || origin.origin !== deps.publicOrigin)
    throw new NewsletterEditorialError('configuration_unavailable')
}
export async function authorizeEditorial(deps: NewsletterEditorialDependencies, claims: VerifiedSessionClaims) {
  const auth = await authorizeD1Session(deps.database, claims, 'administration.manage', {
    requireMfa: true,
    now: editorialNow(deps)
  })
  if (!auth.allowed) throw new NewsletterEditorialError(auth.code)
}
export const EDITORIAL_ACTOR_SQL = `EXISTS(SELECT 1 FROM auth_sessions s JOIN identities i ON i.id=s.identity_id AND i.session_version=s.session_version
 WHERE s.id=?2 AND i.id=?3 AND s.session_version=?4 AND s.revoked_at IS NULL AND s.mfa_verified=1
 AND s.created_at<=COALESCE(?1,strftime('%Y-%m-%dT%H:%M:%SZ','now')) AND s.expires_at>COALESCE(?1,strftime('%Y-%m-%dT%H:%M:%SZ','now')) AND i.status IN ('active','pending') AND i.email_verified_at<=COALESCE(?1,strftime('%Y-%m-%dT%H:%M:%SZ','now'))
 AND EXISTS(SELECT 1 FROM identity_roles r JOIN role_permissions p ON p.role_code=r.role_code
 WHERE r.identity_id=i.id AND p.permission_code='administration.manage' AND r.granted_at<=COALESCE(?1,strftime('%Y-%m-%dT%H:%M:%SZ','now')) AND (r.expires_at IS NULL OR r.expires_at>COALESCE(?1,strftime('%Y-%m-%dT%H:%M:%SZ','now')))))`
export function actorBinds(deps: NewsletterEditorialDependencies, claims: VerifiedSessionClaims) {
  return [deps.now ? editorialNow(deps) : null, claims.sessionId, claims.identityId, claims.sessionVersion] as const
}
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, v]) => `${JSON.stringify(key)}:${stableJson(v)}`)
    .join(',')}}`
}
export async function editorialHash(value: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('')
}
export function keyValue(input: string) {
  if (!/^[a-zA-Z0-9._:-]{1,200}$/.test(input)) throw new NewsletterEditorialError('invalid_input')
  return input
}
export function assertBatch(results: unknown, count: number) {
  const checked = editorialSource(z.array(z.object({ success: z.literal(true) }).passthrough()).length(count), results)
  return checked
}
export async function activeTopics(deps: NewsletterEditorialDependencies, codes: string[]) {
  const result = await deps.database
    .prepare(
      'SELECT count(*) AS n FROM newsletter_editorial_topics WHERE active=1 AND code IN(SELECT value FROM json_each(?))'
    )
    .bind(JSON.stringify(codes))
    .first()
  const row = editorialSource(z.object({ n: z.number().int().min(0) }).strict(), result)
  if (row.n !== codes.length) throw new NewsletterEditorialError('topic_unavailable')
}
