import type { z } from 'zod'
import { catalogPolicyOwnJson, catalogPolicyInstantSchema } from '../../shared/catalog-publication-policy'
import {
  analyticsMeasurementPolicySchema,
  analyticsEnvironmentSchema,
  type AnalyticsMeasurementPolicy
} from '../../shared/analytics-measurement'
import { authorizeD1Session, type VerifiedSessionClaims } from '../catalog/authorization'
import { guardedFiscalDatabase } from '../fiscal/d1-boundary'

export interface AnalyticsMeasurementDependencies {
  database: D1Database
  origin: string
  environment: 'local' | 'preview' | 'production'
  enabled?: boolean
  policy?: AnalyticsMeasurementPolicy | null
  /** Dedicated pseudonym namespace, never a newsletter/session signing key. */
  sessionPepper?: Uint8Array
  now?: () => string
}
export class AnalyticsMeasurementError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}
export function analyticsChecked<T, I>(schema: z.ZodType<T, z.ZodTypeDef, I>, input: unknown): T {
  try {
    return schema.parse(catalogPolicyOwnJson(input))
  } catch {
    throw new AnalyticsMeasurementError('service_unavailable')
  }
}
export function analyticsClock(deps: Pick<AnalyticsMeasurementDependencies, 'now'>): string {
  try {
    return catalogPolicyInstantSchema.parse(deps.now?.() ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'))
  } catch {
    throw new AnalyticsMeasurementError('configuration_unavailable')
  }
}
/** Retention can use this policy gate while acquisition remains disabled. */
export function analyticsAssertPolicy(deps: AnalyticsMeasurementDependencies): AnalyticsMeasurementPolicy {
  try {
    const policy = analyticsMeasurementPolicySchema.parse(deps.policy)
    const environment = analyticsEnvironmentSchema.parse(deps.environment)
    const origin = new URL(deps.origin)
    if (
      origin.protocol !== 'https:' ||
      origin.origin !== deps.origin ||
      policy.environment !== environment ||
      policy.approvedAt > analyticsClock(deps)
    )
      throw new Error('invalid_analytics_authority')
    return policy
  } catch {
    throw new AnalyticsMeasurementError('configuration_unavailable')
  }
}
export function analyticsAssertEnabled(deps: AnalyticsMeasurementDependencies): AnalyticsMeasurementPolicy {
  if (deps.enabled !== true) throw new AnalyticsMeasurementError('feature_unavailable')
  return analyticsAssertPolicy(deps)
}
/** Final synchronous gate: no crypto/SQL await may separate this check from
 * releasing a private result or binding a write to the captured authority. */
export function analyticsAssertCurrentPolicy(
  deps: AnalyticsMeasurementDependencies,
  expected: AnalyticsMeasurementPolicy,
  expectedOrigin: string
): void {
  const current = analyticsAssertPolicy(deps)
  if (
    analyticsStableJson(current) !== analyticsStableJson(expected) ||
    deps.origin !== expectedOrigin ||
    deps.environment !== expected.environment
  )
    throw new AnalyticsMeasurementError('configuration_unavailable')
}
export function analyticsAssertCurrentConfiguration(
  deps: AnalyticsMeasurementDependencies,
  expected: AnalyticsMeasurementPolicy,
  expectedOrigin: string
): void {
  if (deps.enabled !== true) throw new AnalyticsMeasurementError('feature_unavailable')
  analyticsAssertCurrentPolicy(deps, expected, expectedOrigin)
}
export function analyticsStableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(analyticsStableJson).join(',')}]`
  return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${analyticsStableJson(item)}`)
    .join(',')}}`
}
export async function analyticsHash(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')
}
export async function analyticsPolicyFingerprint(policy: AnalyticsMeasurementPolicy): Promise<string> {
  return analyticsHash(analyticsStableJson(analyticsMeasurementPolicySchema.parse(policy)))
}
export function analyticsDatabase(deps: Pick<AnalyticsMeasurementDependencies, 'database'>) {
  return guardedFiscalDatabase(deps.database)
}
export async function analyticsAuthorizeAdmin(
  deps: AnalyticsMeasurementDependencies,
  claims: VerifiedSessionClaims
): Promise<void> {
  const result = await authorizeD1Session(analyticsDatabase(deps), claims, 'administration.manage', {
    now: analyticsClock(deps),
    requireMfa: true
  })
  if (!result.allowed) throw new AnalyticsMeasurementError(result.code)
}
export const ANALYTICS_ADMIN_AUTHORITY_SQL = `EXISTS(SELECT 1 FROM auth_sessions s JOIN identities i ON i.id=s.identity_id AND i.session_version=s.session_version
 WHERE s.id=?2 AND i.id=?3 AND s.session_version=?4 AND s.revoked_at IS NULL AND s.mfa_verified=1
 AND s.created_at<=?1 AND s.expires_at>?1 AND i.status IN('active','pending') AND i.email_verified_at IS NOT NULL AND i.email_verified_at<=?1
 AND EXISTS(SELECT 1 FROM identity_roles assigned JOIN role_permissions granted ON granted.role_code=assigned.role_code
 WHERE assigned.identity_id=i.id AND granted.permission_code='administration.manage' AND assigned.granted_at<=?1
 AND (assigned.expires_at IS NULL OR assigned.expires_at>?1)))`
export function analyticsAdminBinds(deps: AnalyticsMeasurementDependencies, claims: VerifiedSessionClaims) {
  return [analyticsClock(deps), claims.sessionId, claims.identityId, claims.sessionVersion] as const
}
export async function analyticsAssertUnchanged(deps: AnalyticsMeasurementDependencies, expected: string) {
  const policy = analyticsAssertEnabled(deps),
    origin = deps.origin
  if ((await analyticsPolicyFingerprint(policy)) !== expected)
    throw new AnalyticsMeasurementError('configuration_unavailable')
  // Hashing yields too: withdrawing authority while it runs must be observed.
  analyticsAssertCurrentConfiguration(deps, policy, origin)
}
