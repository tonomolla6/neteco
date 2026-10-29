import { buildStrictCsp, getCspHeaderName, resolveCspMode, type CspMode } from './csp'

export interface ApplicationSecurityHeadersOptions {
  turnstile?: boolean
  strict?: boolean
  cspMode?: CspMode
  nonce?: string
  hashes?: string[]
  reportUri?: string
}

/** Pure header policy shared by Nitro and the outer Worker. Third-party
 * challenge permissions are explicit and do not enable the challenge itself.
 * Supports SEC-034 strict CSP mode with nonces/hashes when strict or cspMode is requested. */
export function applicationSecurityHeaders(
  environment: string,
  options: ApplicationSecurityHeadersOptions = {}
): Record<string, string> {
  const challenge = options.turnstile === true ? ' https://challenges.cloudflare.com' : ''
  const isStrict = options.strict === true || options.cspMode !== undefined

  const headers: Record<string, string> = {
    'referrer-policy': 'strict-origin-when-cross-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'cross-origin-opener-policy': 'same-origin',
    ...(environment === 'production'
      ? { 'strict-transport-security': 'max-age=63072000; includeSubDomains; preload' }
      : {})
  }

  if (isStrict) {
    const mode = resolveCspMode(options.cspMode)
    if (mode !== 'off') {
      const strictPolicy = buildStrictCsp({
        nonce: options.nonce,
        hashes: options.hashes,
        turnstile: options.turnstile,
        reportUri: options.reportUri
      })
      const headerName = getCspHeaderName(mode)
      if (headerName) {
        headers[headerName] = strictPolicy
        headers['reporting-endpoints'] = `csp-endpoint="${options.reportUri ?? '/api/security/csp-reports'}"`
      }
    }
    return headers
  }

  // Baseline backward-compatible policy
  headers['content-security-policy'] = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self' https://sis-t.redsys.es:25443 https://sis.redsys.es",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    `script-src 'self' 'unsafe-inline'${challenge}`,
    `frame-src 'self'${challenge}`,
    "connect-src 'self'"
  ].join('; ')

  return headers
}
