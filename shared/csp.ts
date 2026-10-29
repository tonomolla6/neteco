/**
 * SEC-034: Strict Content Security Policy with nonces, static inline hashes,
 * strict-dynamic, Redsys payment form-action, and violation reporting.
 *
 * Strict policy rules:
 * - Nonce per response for scripts (no external dependencies).
 * - Static inline hashes when configured.
 * - strict-dynamic for modern CSP3 browsers.
 * - object-src 'none', base-uri 'self', frame-ancestors 'none'.
 * - form-action 'self' + Redsys endpoints (production and sandbox).
 * - upgrade-insecure-requests.
 * - connect-src / img-src / font-src only genuine origins (self, data:, blob:).
 * - NEVER 'unsafe-eval' and NEVER script 'unsafe-inline'.
 * - style 'unsafe-inline' retained only as a temporary measured exception required
 *   by @nuxt/ui and Tailwind runtime stylesheet / CSS variable injection.
 * - Switch: off | report-only | enforce (defaults to report-only).
 */

export type CspMode = 'off' | 'report-only' | 'enforce'

export interface CspDirectivesOptions {
  nonce?: string
  hashes?: string[]
  strictDynamic?: boolean
  turnstile?: boolean
  reportUri?: string
  reportToGroup?: string
  upgradeInsecureRequests?: boolean
}

export interface StrictCspApplyOptions extends CspDirectivesOptions {
  mode?: CspMode
  path?: string
}

export interface StrictSecurityHeadersOptions extends CspDirectivesOptions {
  mode?: CspMode
  path?: string
}

const REDSYS_FORM_ACTIONS = 'https://sis-t.redsys.es:25443 https://sis.redsys.es'
const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com'
const DEFAULT_REPORT_URI = '/api/security/csp-reports'
const DEFAULT_REPORT_TO_GROUP = 'csp-endpoint'

/**
 * Generates a cryptographically random 16-byte nonce, base64-encoded.
 * Compatible with both Cloudflare Workers and Node.js runtimes.
 */
export function generateCspNonce(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  if (typeof btoa === 'function') {
    let binary = ''
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]!)
    }
    return btoa(binary)
  }
  return Buffer.from(bytes).toString('base64')
}

/**
 * Normalizes user-supplied or environment CSP mode string.
 * Defaults to 'report-only' when unset, empty, or unrecognized.
 */
export function resolveCspMode(rawMode?: unknown): CspMode {
  if (typeof rawMode !== 'string') return 'report-only'
  const normalized = rawMode.trim().toLowerCase()
  if (normalized === 'enforce') return 'enforce'
  if (normalized === 'off') return 'off'
  if (normalized === 'report-only' || normalized === 'report_only') return 'report-only'
  return 'report-only'
}

/**
 * Maps the active CSP mode to the corresponding standard HTTP header name.
 */
export function getCspHeaderName(
  mode: CspMode
): 'content-security-policy' | 'content-security-policy-report-only' | null {
  if (mode === 'enforce') return 'content-security-policy'
  if (mode === 'report-only') return 'content-security-policy-report-only'
  return null
}

/**
 * Builds the strict Content Security Policy string.
 * Style 'unsafe-inline' is retained as a temporary measured exception for @nuxt/ui.
 * Script 'unsafe-inline' and 'unsafe-eval' are STRICTLY PROHIBITED.
 */
export function buildStrictCsp(options: CspDirectivesOptions = {}): string {
  const nonce = options.nonce ?? generateCspNonce()
  const strictDynamic = options.strictDynamic !== false
  const turnstile = options.turnstile === true
  const hashes = Array.isArray(options.hashes) ? options.hashes.filter(Boolean) : []
  const reportUri = options.reportUri ?? DEFAULT_REPORT_URI
  const reportToGroup = options.reportToGroup ?? DEFAULT_REPORT_TO_GROUP
  const upgrade = options.upgradeInsecureRequests !== false

  const scriptParts: string[] = [`'nonce-${nonce}'`]
  for (const hash of hashes) {
    const formatted = hash.startsWith("'") && hash.endsWith("'") ? hash : `'${hash}'`
    scriptParts.push(formatted)
  }
  if (strictDynamic) {
    scriptParts.push("'strict-dynamic'")
  }
  scriptParts.push("'self'")
  // Fallback for older browsers that do not support strict-dynamic or nonces
  scriptParts.push('https:')
  if (turnstile) {
    scriptParts.push(TURNSTILE_ORIGIN)
  }

  const frameParts: string[] = ["'self'"]
  if (turnstile) {
    frameParts.push(TURNSTILE_ORIGIN)
  }

  const directives: string[] = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    `form-action 'self' ${REDSYS_FORM_ACTIONS}`,
    ...(upgrade ? ['upgrade-insecure-requests'] : []),
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    // TEMPORARY EXCEPTION: Nuxt UI runtime styles and CSS variable injections
    // require style-src 'unsafe-inline' until ahead-of-time CSS extraction is complete.
    "style-src 'self' 'unsafe-inline'",
    `script-src ${scriptParts.join(' ')}`,
    `frame-src ${frameParts.join(' ')}`,
    `report-uri ${reportUri}`,
    `report-to ${reportToGroup}`
  ]

  return directives.join('; ')
}

/**
 * Applies strict CSP and reporting headers to a Headers instance.
 */
export function applyStrictCspHeaders(headers: Headers, options: StrictCspApplyOptions): Headers {
  const mode = resolveCspMode(options.mode)
  const reportUri = options.reportUri ?? DEFAULT_REPORT_URI

  // Clear existing CSP headers
  headers.delete('content-security-policy')
  headers.delete('content-security-policy-report-only')

  if (mode === 'off') {
    headers.delete('reporting-endpoints')
    return headers
  }

  const cspString = buildStrictCsp(options)
  const headerName = getCspHeaderName(mode)
  if (headerName) {
    headers.set(headerName, cspString)
    headers.set('reporting-endpoints', `csp-endpoint="${reportUri}"`)
  }

  return headers
}

/**
 * Injects a nonce attribute into `<script>` tags that lack one.
 * Ignores data scripts like `<script type="application/ld+json">`.
 */
export function injectNonceIntoHtml(html: string, nonce: string): string {
  if (!html || !nonce) return html

  // Matches <script ...> tags
  return html.replace(/<script\b([^>]*)>/gi, (match, attributes: string) => {
    // If nonce is already present, preserve it
    if (/\bnonce\s*=/i.test(attributes)) {
      return match
    }

    // If it's a data script like application/json or application/ld+json, leave it untouched
    if (/type\s*=\s*["'](?:application\/(?:ld\+)?json)["']/i.test(attributes)) {
      return match
    }

    // Inject nonce attribute immediately after <script
    const trimmed = attributes.trimStart()
    if (trimmed.length > 0) {
      return `<script nonce="${nonce}" ${trimmed}>`
    }
    return `<script nonce="${nonce}">`
  })
}

/**
 * Returns full security headers contract including strict CSP for edge and Nitro servers.
 */
export function strictSecurityHeaders(
  environment: string,
  options: StrictSecurityHeadersOptions = {}
): Record<string, string> {
  const mode = resolveCspMode(options.mode)
  const nonce = options.nonce ?? generateCspNonce()
  const reportUri = options.reportUri ?? DEFAULT_REPORT_URI

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

  if (mode !== 'off') {
    const cspValue = buildStrictCsp({ ...options, nonce, reportUri })
    const headerName = getCspHeaderName(mode)
    if (headerName) {
      headers[headerName] = cspValue
      headers['reporting-endpoints'] = `csp-endpoint="${reportUri}"`
    }
  }

  return headers
}
