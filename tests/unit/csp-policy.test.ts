import { describe, it, expect } from 'vitest'
import {
  generateCspNonce,
  buildStrictCsp,
  resolveCspMode,
  getCspHeaderName,
  applyStrictCspHeaders,
  injectNonceIntoHtml,
  strictSecurityHeaders
} from '../../shared/csp'
import { applicationSecurityHeaders } from '../../shared/http-security'

describe('SEC-034: Strict Content Security Policy', () => {
  describe('Nonce generation', () => {
    it('generates a cryptographically random, base64-encoded nonce per call', () => {
      const nonce1 = generateCspNonce()
      const nonce2 = generateCspNonce()

      expect(typeof nonce1).toBe('string')
      expect(typeof nonce2).toBe('string')
      expect(nonce1).not.toBe(nonce2)
      // Base64 with at least 16 bytes entropy (16 bytes = 22-24 chars in base64)
      expect(nonce1.length).toBeGreaterThanOrEqual(20)
      expect(/^[A-Za-z0-9+/=_-]+$/.test(nonce1)).toBe(true)
    })

    it('generates unique nonces across 100 consecutive requests', () => {
      const nonces = new Set<string>()
      for (let i = 0; i < 100; i++) {
        nonces.add(generateCspNonce())
      }
      expect(nonces.size).toBe(100)
    })
  })

  describe('Strict CSP Directive Specification', () => {
    it('builds strict CSP with response nonce and strict-dynamic', () => {
      const nonce = 'test-nonce-12345'
      const policy = buildStrictCsp({ nonce })

      expect(policy).toContain("default-src 'self'")
      expect(policy).toContain("base-uri 'self'")
      expect(policy).toContain("object-src 'none'")
      expect(policy).toContain("frame-ancestors 'none'")
      expect(policy).toContain("form-action 'self' https://sis-t.redsys.es:25443 https://sis.redsys.es")
      expect(policy).toContain('upgrade-insecure-requests')
      expect(policy).toContain("img-src 'self' data: blob:")
      expect(policy).toContain("font-src 'self' data:")
      expect(policy).toContain("connect-src 'self'")
      expect(policy).toContain("style-src 'self' 'unsafe-inline'")
      expect(policy).toContain(`script-src 'nonce-${nonce}' 'strict-dynamic' 'self' https:`)
      expect(policy).toContain("frame-src 'self'")
    })

    it('NEVER includes unsafe-eval in strict CSP', () => {
      const policy = buildStrictCsp({ nonce: 'nonce-sample' })
      expect(policy).not.toContain('unsafe-eval')
      expect(policy).not.toContain("'unsafe-eval'")
    })

    it('NEVER includes unsafe-inline in script-src in strict CSP', () => {
      const policy = buildStrictCsp({ nonce: 'nonce-sample' })
      const scriptSrcDirective = policy
        .split(';')
        .map((s) => s.trim())
        .find((s) => s.startsWith('script-src'))
      expect(scriptSrcDirective).toBeDefined()
      expect(scriptSrcDirective).not.toContain("'unsafe-inline'")
    })

    it('documents style unsafe-inline as a temporary measured exception for nuxt/ui', () => {
      // style-src allows 'unsafe-inline' specifically for nuxt/ui runtime CSS injection
      const policy = buildStrictCsp({ nonce: 'nonce-sample' })
      const styleSrcDirective = policy
        .split(';')
        .map((s) => s.trim())
        .find((s) => s.startsWith('style-src'))
      expect(styleSrcDirective).toContain("'unsafe-inline'")
      expect(styleSrcDirective).toContain("'self'")
    })

    it('includes static script hashes when supplied in options', () => {
      const hashes = ['sha256-abcdef1234567890=', 'sha256-9876543210fedcba=']
      const policy = buildStrictCsp({ nonce: 'nonce-abc', hashes })

      for (const hash of hashes) {
        expect(policy).toContain(`'${hash}'`)
      }
      expect(policy).toContain("'strict-dynamic'")
    })

    it('authorizes Cloudflare Turnstile origins in script-src and frame-src only when turnstile option is true', () => {
      const withoutTurnstile = buildStrictCsp({ nonce: 'nonce-sample', turnstile: false })
      expect(withoutTurnstile).not.toContain('challenges.cloudflare.com')

      const withTurnstile = buildStrictCsp({ nonce: 'nonce-sample', turnstile: true })
      expect(withTurnstile).toContain(
        "script-src 'nonce-nonce-sample' 'strict-dynamic' 'self' https: https://challenges.cloudflare.com"
      )
      expect(withTurnstile).toContain("frame-src 'self' https://challenges.cloudflare.com")
    })

    it('configures report-uri and report-to pointing to the violation report endpoint', () => {
      const policy = buildStrictCsp({ nonce: 'nonce-sample', reportUri: '/api/security/csp-reports' })
      expect(policy).toContain('report-uri /api/security/csp-reports')
      expect(policy).toContain('report-to csp-endpoint')
    })
  })

  describe('CSP Mode Switch (off | report-only | enforce)', () => {
    it.each([
      ['report-only', 'report-only'],
      ['enforce', 'enforce'],
      ['off', 'off'],
      [undefined, 'report-only'],
      ['', 'report-only'],
      ['unknown_mode', 'report-only'],
      ['REPORT-ONLY', 'report-only'],
      ['ENFORCE', 'enforce'],
      ['OFF', 'off']
    ])('resolves mode %s to %s (defaulting to report-only)', (input, expected) => {
      expect(resolveCspMode(input as unknown as string)).toBe(expected)
    })

    it('maps mode to corresponding header name', () => {
      expect(getCspHeaderName('enforce')).toBe('content-security-policy')
      expect(getCspHeaderName('report-only')).toBe('content-security-policy-report-only')
      expect(getCspHeaderName('off')).toBeNull()
    })

    it('applies Content-Security-Policy-Report-Only when mode is report-only', () => {
      const headers = new Headers()
      const applied = applyStrictCspHeaders(headers, {
        mode: 'report-only',
        nonce: 'nonce-ro-123'
      })

      expect(applied.has('content-security-policy-report-only')).toBe(true)
      expect(applied.has('content-security-policy')).toBe(false)
      expect(applied.get('content-security-policy-report-only')).toContain("'nonce-nonce-ro-123'")
      expect(applied.get('reporting-endpoints')).toBe('csp-endpoint="/api/security/csp-reports"')
    })

    it('applies Content-Security-Policy when mode is enforce', () => {
      const headers = new Headers()
      const applied = applyStrictCspHeaders(headers, {
        mode: 'enforce',
        nonce: 'nonce-enf-456'
      })

      expect(applied.has('content-security-policy')).toBe(true)
      expect(applied.has('content-security-policy-report-only')).toBe(false)
      expect(applied.get('content-security-policy')).toContain("'nonce-nonce-enf-456'")
      expect(applied.get('reporting-endpoints')).toBe('csp-endpoint="/api/security/csp-reports"')
    })

    it('clears CSP headers when mode is off', () => {
      const headers = new Headers({
        'content-security-policy': 'default-src self',
        'content-security-policy-report-only': 'default-src self'
      })
      const applied = applyStrictCspHeaders(headers, {
        mode: 'off',
        nonce: 'nonce-off'
      })

      expect(applied.has('content-security-policy')).toBe(false)
      expect(applied.has('content-security-policy-report-only')).toBe(false)
    })
  })

  describe('HTML Nonce Injection', () => {
    it('injects nonce attribute into script tags without nonce', () => {
      const html =
        '<html><head><script src="/app.js"></script></head><body><script>console.log(1)</script></body></html>'
      const transformed = injectNonceIntoHtml(html, 'my-nonce-777')

      expect(transformed).toContain('<script nonce="my-nonce-777" src="/app.js"></script>')
      expect(transformed).toContain('<script nonce="my-nonce-777">console.log(1)</script>')
    })

    it('preserves existing nonce attributes on script tags', () => {
      const html = '<script nonce="existing-nonce" src="/vendor.js"></script>'
      const transformed = injectNonceIntoHtml(html, 'new-nonce')

      expect(transformed).toBe('<script nonce="existing-nonce" src="/vendor.js"></script>')
    })

    it('injects nonce into script tags with type="module"', () => {
      const html = '<script type="module" src="/entry.js"></script>'
      const transformed = injectNonceIntoHtml(html, 'module-nonce')

      expect(transformed).toContain('<script nonce="module-nonce" type="module" src="/entry.js"></script>')
    })

    it('does not alter non-script tags like descriptions or spans', () => {
      const html = '<p>Use script execution with caution</p><description>script</description>'
      const transformed = injectNonceIntoHtml(html, 'nonce-x')

      expect(transformed).toBe(html)
    })
  })

  describe('strictSecurityHeaders contract helper', () => {
    it('produces strict security headers with report-only by default', () => {
      const headers = strictSecurityHeaders('production', { nonce: 'nonce-prod' })

      expect(headers['content-security-policy-report-only']).toBeDefined()
      expect(headers['content-security-policy-report-only']).toContain("'nonce-nonce-prod'")
      expect(headers['strict-transport-security']).toBe('max-age=63072000; includeSubDomains; preload')
      expect(headers['x-frame-options']).toBe('DENY')
      expect(headers['x-content-type-options']).toBe('nosniff')
    })

    it('produces enforced CSP when mode is enforce', () => {
      const headers = strictSecurityHeaders('production', { mode: 'enforce', nonce: 'nonce-enf' })

      expect(headers['content-security-policy']).toBeDefined()
      expect(headers['content-security-policy']).toContain("'nonce-nonce-enf'")
      expect(headers['content-security-policy-report-only']).toBeUndefined()
    })
  })

  describe('Backward compatibility in applicationSecurityHeaders', () => {
    it('retains baseline CSP when called without strict options', () => {
      const legacy = applicationSecurityHeaders('production')
      expect(legacy['content-security-policy']).toBeDefined()
      expect(legacy['content-security-policy']).toContain("frame-ancestors 'none'")
      expect(legacy['strict-transport-security']).toBe('max-age=63072000; includeSubDomains; preload')
    })

    it('upgrades to strict CSP when strict: true is passed', () => {
      const strict = applicationSecurityHeaders('production', { strict: true, cspMode: 'enforce', nonce: 'nonce-up' })
      expect(strict['content-security-policy']).toContain("'nonce-nonce-up'")
      expect(strict['content-security-policy']).not.toMatch(/script-src[^;]*'unsafe-inline'/)
    })
  })
})
