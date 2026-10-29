import { z } from 'zod'
import { catalogPolicyOwnJson } from '../../shared/catalog-publication-policy'
import { fiscalUuid, fiscalInstant } from '../../shared/fiscal-issuance'
import { refundKey } from '../../shared/order-refunds'
import { authorizeD1Session, type VerifiedSessionClaims } from '../catalog/authorization'
import { canonicalJson, sha256Hex } from '../catalog/inventory'
import { guardedFiscalDatabase, FiscalD1EvidenceError } from '../fiscal/d1-boundary'

export class RefundError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'RefundError'
  }
}
export function checked<T>(schema: { parse(value: unknown): T }, value: unknown, code = 'invalid_input'): T {
  try {
    return schema.parse(catalogPolicyOwnJson(value))
  } catch {
    throw new RefundError(code)
  }
}
export const claimsSchema = z
  .object({
    identityId: fiscalUuid,
    sessionId: fiscalUuid,
    sessionVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
  })
  .strict()
export type RefundCommandOptions = { now?: string }
export function clock(options: RefundCommandOptions = {}) {
  const initial = options.now === undefined ? Date.now() : Date.parse(checked(fiscalInstant, options.now)),
    start = Date.now()
  return () => new Date(initial + Math.max(0, Date.now() - start)).toISOString().replace(/\.\d{3}Z$/, 'Z')
}
export const sqlClock = `COALESCE(?1,strftime('%Y-%m-%dT%H:%M:%SZ','now'))`
export const authSql = `EXISTS(SELECT 1 FROM auth_sessions s JOIN identities i ON i.id=s.identity_id
 JOIN identity_roles role ON role.identity_id=i.id JOIN role_permissions permission ON permission.role_code=role.role_code
 WHERE i.id=?2 AND s.id=?3 AND s.identity_id=i.id AND s.session_version=?4 AND i.session_version=s.session_version
 AND i.status IN('active','pending') AND i.email_verified_at IS NOT NULL AND i.email_verified_at<=${sqlClock}
 AND s.mfa_verified=1 AND s.revoked_at IS NULL AND s.created_at<=${sqlClock} AND s.expires_at>${sqlClock}
 AND role.granted_at<=${sqlClock} AND (role.expires_at IS NULL OR role.expires_at>${sqlClock})
 AND permission.permission_code='administration.manage')`
export async function admin(database: D1Database, raw: VerifiedSessionClaims, now: () => string) {
  const claims = checked(claimsSchema, raw, 'unauthenticated')
  const result = await authorizeD1Session(guardedFiscalDatabase(database), claims, 'administration.manage', {
    now: now(),
    requireMfa: true
  })
  if (!result.allowed) throw new RefundError(result.code)
  if (result.identityId !== claims.identityId || result.sessionId !== claims.sessionId)
    throw new FiscalD1EvidenceError()
  return claims
}
export function guard(database: D1Database, condition: string, bindings: unknown[] = []) {
  return database
    .prepare(`INSERT INTO refund_atomic_guards(id,passed) SELECT 1,0 WHERE NOT (${condition})`)
    .bind(...bindings)
}
export function authorizationGuard(database: D1Database, claims: VerifiedSessionClaims, options: RefundCommandOptions) {
  return guard(database, authSql, [options.now ?? null, claims.identityId, claims.sessionId, claims.sessionVersion])
}
export const hash = (value: unknown) => sha256Hex(canonicalJson(catalogPolicyOwnJson(value)))
export function parsedJson(value: string, code = 'read_unconfirmed'): unknown {
  try {
    return catalogPolicyOwnJson(JSON.parse(value))
  } catch {
    throw new RefundError(code)
  }
}
/** Provider metadata may be class fields, but never inherited/accessor claims. */
export function providerMetadata(provider: object) {
  const result: Record<string, unknown> = {}
  for (const key of ['name', 'environment', 'mappingFingerprint']) {
    const member = Object.getOwnPropertyDescriptor(provider, key)
    if (!member || !Object.hasOwn(member, 'value')) throw new RefundError('provider_configuration_unconfirmed')
    result[key] = member.value
  }
  return checked(
    z
      .object({
        name: z.enum(['local_fake', 'redsys', 'beply']),
        environment: z.enum(['local_validation', 'sandbox', 'production']),
        mappingFingerprint: z.string().regex(/^[0-9a-f]{64}$/)
      })
      .strict(),
    result,
    'provider_configuration_unconfirmed'
  )
}
export function providerMethod<TArgs extends unknown[], TResult = unknown>(
  provider: object,
  key: string,
  required = true
): ((...args: TArgs) => Promise<TResult>) | null {
  let target: object | null = provider
  for (
    let depth = 0;
    target && target !== Object.prototype && depth < 4;
    depth++, target = Object.getPrototypeOf(target)
  ) {
    const descriptor = Object.getOwnPropertyDescriptor(target, key)
    if (!descriptor) continue
    if (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function')
      throw new RefundError('provider_configuration_unconfirmed')
    return descriptor.value.bind(provider)
  }
  if (required) throw new RefundError('provider_configuration_unconfirmed')
  return null
}
export const later = (now: string, seconds: number) =>
  new Date(Date.parse(now) + seconds * 1000).toISOString().replace('.000Z', 'Z')
const commandSchema = z
  .object({
    kind: z.string().min(1).max(40),
    target_id: fiscalUuid,
    payload_hash: z.string().regex(/^[0-9a-f]{64}$/),
    response_json: z.string().max(131072)
  })
  .strict()
export async function replay(
  database: D1Database,
  claims: VerifiedSessionClaims,
  key: string,
  kind: string,
  payloadHash: string
): Promise<unknown | null> {
  checked(refundKey, key)
  const row = await database
    .prepare(
      'SELECT kind,target_id,payload_hash,response_json FROM financial_commands WHERE actor_id=?1 AND command_key=?2'
    )
    .bind(claims.identityId, key)
    .first()
  if (row === null) return null
  const stored = checked(commandSchema, row, 'read_unconfirmed')
  if (stored.kind !== kind || stored.payload_hash !== payloadHash) throw new RefundError('idempotency_conflict')
  try {
    return catalogPolicyOwnJson(JSON.parse(stored.response_json))
  } catch {
    throw new RefundError('read_unconfirmed')
  }
}
export function commandStatement(
  database: D1Database,
  claims: VerifiedSessionClaims,
  key: string,
  kind: string,
  target: string,
  payloadHash: string,
  response: unknown,
  now: string
) {
  return database
    .prepare(
      'INSERT INTO financial_commands(actor_id,command_key,kind,target_id,payload_hash,response_json,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7)'
    )
    .bind(claims.identityId, key, kind, target, payloadHash, canonicalJson(response), now)
}
export function eventStatement(
  database: D1Database,
  input: {
    scope: 'policy' | 'refund' | 'credit'
    target: string
    kind: string
    now: string
    actor?: string
    generation?: number
    reason?: string
    evidenceRef?: string
    id?: string
  }
) {
  return database
    .prepare(
      'INSERT INTO financial_events(id,scope,target_id,event_kind,actor_id,generation,reason,evidence_ref,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)'
    )
    .bind(
      input.id ?? crypto.randomUUID(),
      input.scope,
      input.target,
      input.kind,
      input.actor ?? null,
      input.generation ?? null,
      input.reason ?? null,
      input.evidenceRef ?? null,
      input.now
    )
}
