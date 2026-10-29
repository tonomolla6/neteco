import {
  supportContactInputSchema,
  supportOptionsSchema,
  supportChallengeConfigurationSchema,
  SUPPORT_CATEGORIES
} from '../../shared/support-operations'
import { canonicalAddress } from '../auth/edge-limit'
import { sha256Hex } from '../catalog/inventory'
import { createSupportTicket, replaySupportContact, SupportError, type SupportActor } from './operations'
import { receiveSupportScan } from './attachments'
import {
  supportBoundary,
  supportFailure,
  supportJson,
  supportPolicy,
  supportRequestKey,
  supportBody,
  supportRawBody,
  supportHttpActor,
  ownsSupportNamespace,
  type SupportHttpDependencies
} from './http'
export { type SupportHttpDependencies } from './http'
export const ownsSupportContactNamespace = (path: string) => ownsSupportNamespace(path, '/api/support')
const INTAKE_COOKIE = 'neteco-support-intake-v1'
function cookieToken(request: Request) {
  const matches = (request.headers.get('cookie') ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(INTAKE_COOKIE + '='))
  if (matches.length !== 1) return null
  const token = matches[0]!.slice(INTAKE_COOKIE.length + 1)
  return /^[0-9a-f]{64}$/.test(token) ? token : null
}
async function subjectHash(value: string, pepper: string | undefined) {
  if (typeof pepper !== 'string' || pepper.length < 32 || pepper.startsWith('local-only-'))
    throw new SupportError('abuse_control_unavailable')
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pepper),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  return [
    ...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('neteco:support:v1:' + value)))
  ]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}
export async function handleSupportContactHttp(
  request: Request,
  deps: SupportHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsSupportContactNamespace(url.pathname)) return null
  try {
    const scanner = url.pathname === '/api/support/attachments/scan-receipts'
    const boundary = await supportBoundary(request, deps, scanner ? 'scanner' : 'contact')
    if (boundary) return boundary
    if (scanner) {
      if (request.method !== 'POST') return supportJson({ error: { code: 'method_not_allowed' } }, 405)
      if (!deps.storage || !deps.scanReceiptVerifier) throw new SupportError('scanner_unavailable')
      const payload = await supportRawBody(request)
      return supportJson(
        await receiveSupportScan(
          deps.database,
          deps.storage,
          request,
          payload.body,
          deps.scanReceiptVerifier,
          payload.rawBody
        )
      )
    }
    if (url.pathname === '/api/support/options' && request.method === 'GET') {
      if (url.searchParams.size) throw new SupportError('invalid_input')
      const previous = cookieToken(request),
        token = previous ?? (await sha256Hex(crypto.randomUUID() + crypto.randomUUID()))
      return supportJson(
        supportOptionsSchema.parse({
          source: 'cloudflare',
          categories: SUPPORT_CATEGORIES,
          policy: supportPolicy(deps),
          attachments: !!deps.storage,
          challengeAvailable: !!deps.challengeVerifier,
          ...(deps.challengeVerifier && deps.challengeConfiguration
            ? {
                challenge: supportChallengeConfigurationSchema.parse(deps.challengeConfiguration)
              }
            : {}),
          privacyReviewRequired: deps.policy == null
        }),
        200,
        previous
          ? {}
          : {
              'Set-Cookie':
                INTAKE_COOKIE + '=' + token + '; Max-Age=86400; Path=/api/support; HttpOnly; Secure; SameSite=Lax'
            }
      )
    }
    if (url.pathname !== '/api/support/tickets') throw new SupportError('invalid_input')
    if (request.method !== 'POST') return supportJson({ error: { code: 'method_not_allowed' } }, 405)
    if (url.searchParams.size) throw new SupportError('invalid_input')
    let actor: SupportActor
    if (/(?:^|;)\s*neteco-session=/.test(request.headers.get('cookie') ?? ''))
      actor = await supportHttpActor(request, deps, 'customer')
    else {
      const token = cookieToken(request)
      if (!token) throw new SupportError('contact_context_required')
      actor = {
        kind: 'anonymous',
        claims: null,
        customerId: null,
        key: 'anonymous:' + (await subjectHash('cookie:' + token, deps.contactPepper))
      }
    }
    const key = supportRequestKey(request),
      parsed = supportContactInputSchema.safeParse(await supportBody(request))
    if (!parsed.success) throw new SupportError('invalid_input')
    const { challengeToken, ...contact } = parsed.data
    const replay = await replaySupportContact(deps.database, actor, contact, key)
    if (replay) return supportJson(replay, 201)
    const address = canonicalAddress(request.headers.get('cf-connecting-ip'))
    if (!address) throw new SupportError('abuse_control_unavailable')
    const hash = await subjectHash('ip:' + address, deps.contactPepper),
      now = Math.floor(Date.now() / 1000),
      quota = await deps.database
        .prepare(
          'INSERT INTO support_intake_limits(subject_hash,used,expires_at) VALUES(?1,1,?2+3600) ' +
            'ON CONFLICT(subject_hash) DO UPDATE SET used=CASE WHEN expires_at<=?2 THEN 1 ELSE MIN(used+1,6) END,' +
            'expires_at=CASE WHEN expires_at<=?2 THEN ?2+3600 ELSE expires_at END RETURNING used,expires_at'
        )
        .bind(hash, now)
        .first<{ used: number; expires_at: number }>()
    if (!quota || !Number.isSafeInteger(quota.used) || quota.used < 1)
      throw new SupportError('abuse_control_unavailable')
    if (quota.used > 5)
      return supportJson({ error: { code: 'rate_limited' } }, 429, {
        'Retry-After': String(Math.max(1, quota.expires_at - now))
      })
    if (quota.used >= 3) {
      if (!deps.challengeVerifier) throw new SupportError('challenge_unavailable')
      if (!challengeToken || !(await deps.challengeVerifier({ token: challengeToken, request })))
        throw new SupportError('challenge_required')
    }
    return supportJson(
      await createSupportTicket(deps.database, actor, contact, {
        idempotencyKey: key,
        policy: supportPolicy(deps)
      }),
      201
    )
  } catch (error) {
    return supportFailure(error)
  }
}
