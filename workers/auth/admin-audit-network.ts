import { canonicalAddress } from './edge-limit'

/** Only valid behind Cloudflare's trusted ingress. Never persist the address,
 * use a login-session address as action evidence, or trust forwarding headers.
 */
export async function deriveAdminAuditIpHash(request: Request, pepper: string): Promise<string> {
  const address = canonicalAddress(request.headers.get('CF-Connecting-IP'))
  if (!address || typeof pepper !== 'string' || pepper.length < 32 || pepper.startsWith('local-only-'))
    throw new Error('service_unavailable')
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pepper),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const digest = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`neteco:admin-audit:request-ip:v1:${address}`)
  )
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
