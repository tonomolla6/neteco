/** Pure header policy shared by Nitro and the outer Worker. Third-party
 * challenge permissions are explicit and do not enable the challenge itself. */
export function applicationSecurityHeaders(environment: string, options: { turnstile?: boolean } = {}) {
  const challenge = options.turnstile === true ? ' https://challenges.cloudflare.com' : ''
  return {
    'content-security-policy': [
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
    ].join('; '),
    'referrer-policy': 'strict-origin-when-cross-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'cross-origin-opener-policy': 'same-origin',
    ...(environment === 'production'
      ? { 'strict-transport-security': 'max-age=63072000; includeSubDomains; preload' }
      : {})
  }
}
