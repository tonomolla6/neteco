import { randomUUID } from 'node:crypto'
import type { H3Event } from 'h3'
import { getRequestIP, getRequestHeader } from 'h3'
import { useDatabase } from '../db/client'
import { privacyHash } from './rate-limit'
import { primaryRole } from '../../shared/identity-roles'
export { primaryRole } from '../../shared/identity-roles'

export interface IdentityProfile {
  id: string
  email: string
  name: string | null
  phone: string | null
  status: string
  sessionVersion: number
  emailVerified: boolean
  mfaEnabled: boolean
  roles: string[]
  company: string | null
}

export async function identityProfile(identityId: string) {
  const sql = useDatabase()
  const [identity] = await sql<IdentityProfile[]>`
    SELECT i.id, i.email::text, c.name, c.phone, i.status,
           i.session_version AS "sessionVersion", i.email_verified_at IS NOT NULL AS "emailVerified",
           mfa.verified_at IS NOT NULL AS "mfaEnabled", company.legal_name AS company,
           COALESCE(array_agg(DISTINCT roles.role_code) FILTER (WHERE roles.role_code IS NOT NULL),
                    ARRAY['customer']::text[]) AS roles
    FROM identities i
    LEFT JOIN customers c ON c.id = i.customer_id
    LEFT JOIN identity_roles roles ON roles.identity_id = i.id
      AND (roles.expires_at IS NULL OR roles.expires_at > now())
    LEFT JOIN identity_mfa mfa ON mfa.identity_id = i.id
    LEFT JOIN LATERAL (
      SELECT organizations.legal_name
      FROM company_members membership
      JOIN companies organizations ON organizations.id = membership.company_id
      WHERE membership.identity_id = i.id AND membership.status = 'active'
      ORDER BY membership.accepted_at NULLS LAST, organizations.created_at
      LIMIT 1
    ) company ON true
    WHERE i.id = ${identityId}
    GROUP BY i.id, c.name, c.phone, mfa.verified_at, company.legal_name
  `
  return identity
}

function publicUser(profile: IdentityProfile, mfaVerified: boolean) {
  return {
    id: profile.id,
    email: profile.email,
    name: profile.name,
    phone: profile.phone,
    company: profile.company,
    role: primaryRole(profile.roles),
    roles: profile.roles,
    emailVerified: profile.emailVerified,
    mfaVerified
  }
}

export async function refreshAuthenticatedSession(
  event: H3Event,
  profile: IdentityProfile,
  mfaVerified: boolean,
  sessionId: string
) {
  const config = useRuntimeConfig(event)
  const sessionDays = Number(config.auth.sessionDays)
  const user = publicUser(profile, mfaVerified)
  await replaceUserSession(
    event,
    { user, sessionId, sessionVersion: profile.sessionVersion },
    { maxAge: sessionDays * 24 * 60 * 60 }
  )
  return user
}

export async function startAuthenticatedSession(event: H3Event, profile: IdentityProfile, mfaVerified: boolean) {
  const config = useRuntimeConfig(event)
  const sessionId = randomUUID()
  const sessionDays = Number(config.auth.sessionDays)
  const expiresAt = new Date(Date.now() + sessionDays * 24 * 60 * 60_000)
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? 'unknown'
  const userAgent = getRequestHeader(event, 'user-agent') ?? 'unknown'
  const sql = useDatabase()
  await sql`
    INSERT INTO auth_sessions (
      id, identity_id, session_version, mfa_verified, ip_hash, user_agent_hash, expires_at
    ) VALUES (
      ${sessionId}, ${profile.id}, ${profile.sessionVersion}, ${mfaVerified}, ${privacyHash(ip)},
      ${privacyHash(userAgent)}, ${expiresAt}
    )
  `
  const user = publicUser(profile, mfaVerified)
  await setUserSession(
    event,
    { user, sessionId, sessionVersion: profile.sessionVersion },
    { maxAge: sessionDays * 24 * 60 * 60 }
  )
  return user
}

export async function requireAuthenticatedIdentity(event: H3Event) {
  const session = await requireUserSession(event)
  if (!session.sessionId || !session.user?.id || session.sessionVersion === undefined) {
    await clearUserSession(event)
    throw createError({ statusCode: 401, statusMessage: 'Sesión no válida' })
  }
  const sql = useDatabase()
  const [active] = await sql<
    Array<{ identityId: string; sessionVersion: number; mfaVerified: boolean; status: string }>
  >`
    SELECT s.identity_id AS "identityId", i.session_version AS "sessionVersion",
           s.mfa_verified AS "mfaVerified", i.status
    FROM auth_sessions s
    JOIN identities i ON i.id = s.identity_id
    WHERE s.id = ${session.sessionId} AND s.identity_id = ${session.user.id}
      AND s.revoked_at IS NULL AND s.expires_at > now()
      AND s.session_version = i.session_version
  `
  if (!active || !['pending', 'active'].includes(active.status) || active.sessionVersion !== session.sessionVersion) {
    await clearUserSession(event)
    throw createError({ statusCode: 401, statusMessage: 'La sesión ha caducado' })
  }
  await sql`UPDATE auth_sessions SET last_seen_at = now() WHERE id = ${session.sessionId}`
  const profile = await identityProfile(active.identityId)
  if (!profile) throw createError({ statusCode: 401, statusMessage: 'Identidad no disponible' })
  return { session, profile, mfaVerified: active.mfaVerified }
}

export async function requireVerifiedIdentity(event: H3Event) {
  const authenticated = await requireAuthenticatedIdentity(event)
  if (!authenticated.profile.emailVerified) {
    throw createError({ statusCode: 403, statusMessage: 'Debes verificar tu email' })
  }
  return authenticated
}

export async function requirePermission(event: H3Event, permission: string, options?: { mfa?: boolean }) {
  const authenticated = await requireVerifiedIdentity(event)
  // La MFA es obligatoria en todos los entornos salvo `local`, donde se relaja para poder
  // revisar el panel sin depender de una aplicación de autenticación. `APP_ENV` solo vale
  // `local` en la máquina de desarrollo, así que staging y producción no cambian.
  const mfaRequired = Boolean(options?.mfa) && useRuntimeConfig(event).appEnv !== 'local'
  if (mfaRequired && !authenticated.mfaVerified) {
    throw createError({ statusCode: 403, statusMessage: 'Se requiere autenticación multifactor' })
  }
  const sql = useDatabase()
  const [allowed] = await sql<{ allowed: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM identity_roles assigned
      JOIN role_permissions granted ON granted.role_code = assigned.role_code
      WHERE assigned.identity_id = ${authenticated.profile.id}
        AND granted.permission_code = ${permission}
        AND (assigned.expires_at IS NULL OR assigned.expires_at > now())
    ) AS allowed
  `
  if (!allowed?.allowed) throw createError({ statusCode: 403, statusMessage: 'Permiso insuficiente' })
  return authenticated
}

export async function revokeCurrentSession(event: H3Event) {
  const session = await getUserSession(event)
  if (session.sessionId) {
    const sql = useDatabase()
    await sql`UPDATE auth_sessions SET revoked_at = now() WHERE id = ${session.sessionId}`
  }
  await clearUserSession(event)
}
