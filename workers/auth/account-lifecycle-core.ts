import { z } from 'zod'
import type { VerifiedSessionClaims } from '../catalog/authorization'
import { catalogPolicyInstantSchema } from '../../shared/catalog-publication-policy'
import { AccountPreferencesError, authorizeD1AccountPreferences } from './account-preferences'

export type AccountLifecycleCode =
  | 'invalid_input'
  | 'unauthenticated'
  | 'email_unverified'
  | 'mfa_required'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'consent_required'
  | 'insufficient_history'
  | 'locked'
  | 'limit_reached'
  | 'unavailable'
export class AccountLifecycleError extends Error {
  constructor(readonly code: AccountLifecycleCode) {
    super(code)
  }
}
export function lifecycleFail(code: AccountLifecycleCode): never {
  throw new AccountLifecycleError(code)
}
export interface AccountLifecycleOptions {
  now?: () => string
}
export const lifecycleUuid = z.string().uuid()
/** Current canonical instant, honouring the injected test clock. */
export function lifecycleNow(options: AccountLifecycleOptions): string {
  const value = options.now?.() ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  if (!catalogPolicyInstantSchema.safeParse(value).success) lifecycleFail('unavailable')
  return value
}
/** Live customer authority (active session, verified email, MFA when enrolled). */
export async function customerAuthority(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  options: AccountLifecycleOptions
) {
  try {
    return await authorizeD1AccountPreferences(db, claims, options)
  } catch (error) {
    if (error instanceof AccountPreferencesError)
      return lifecycleFail(error.code === 'conflict' || error.code === 'invalid_input' ? 'unavailable' : error.code)
    throw error
  }
}
export async function finalCustomer(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  customerId: string,
  options: AccountLifecycleOptions
) {
  if ((await customerAuthority(db, claims, options)).customerId !== customerId) lifecycleFail('unauthenticated')
}
export function lifecycleBindings(claims: VerifiedSessionClaims | null, now: string) {
  if (!claims) lifecycleFail('unauthenticated')
  return [now, claims.sessionId, claims.identityId, claims.sessionVersion]
}
export function boolInt(value: boolean) {
  return value ? 1 : 0
}
