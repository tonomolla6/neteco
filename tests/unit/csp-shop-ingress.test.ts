import { describe, it, expect, vi, beforeEach } from 'vitest'
import shopWorker from '../../workers/shop'

const mockRenderer = vi.hoisted(() => ({
  fetch: vi.fn(async (request: Request) => {
    const url = new URL(request.url)
    const isPrivate = ['/carrito', '/checkout', '/cuenta'].some((p) => url.pathname.startsWith(p))
    return new Response(
      `<!DOCTYPE html><html><head><title>Neteco</title><script src="/_nuxt/entry.js"></script></head><body><h1>Content</h1></body></html>`,
      {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          ...(isPrivate ? { 'cache-control': 'private, no-store' } : {})
        }
      }
    )
  })
}))

vi.mock('#neteco/nitro-renderer', () => ({ default: mockRenderer }))

function context(): ExecutionContext {
  return { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext
}

describe('SEC-034: Shop Ingress Strict CSP Integration', () => {
  beforeEach(() => {
    mockRenderer.fetch.mockClear()
  })

  it('intercepts CSP violation reports before renderer or legacy routing', async () => {
    const env = {
      APP_ENV: 'test',
      CSP_MODE: 'report-only'
    } as unknown as CloudflareEnv

    const request = new Request('https://preprod.neteco.es/api/security/csp-reports', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'cf-connecting-ip': '192.0.2.10'
      },
      body: JSON.stringify({
        'csp-report': {
          'document-uri': 'https://neteco.es/catalogo',
          'blocked-uri': 'https://tracker.bad/pixel.png',
          'effective-directive': 'img-src',
          disposition: 'report'
        }
      })
    })

    const response = await shopWorker.fetch(request, env, context())
    expect(response.status).toBe(204)
    expect(mockRenderer.fetch).not.toHaveBeenCalled()
  })

  it('applies Content-Security-Policy-Report-Only by default on HTML responses', async () => {
    const env = {
      APP_ENV: 'preview'
      // No CSP_MODE -> defaults to report-only
    } as unknown as CloudflareEnv

    const request = new Request('https://preview.neteco.es/catalogo')
    const response = await shopWorker.fetch(request, env, context())

    expect(response.headers.get('content-type')).toContain('text/html')
    const cspReportOnly = response.headers.get('content-security-policy-report-only')
    expect(cspReportOnly).not.toBeNull()
    expect(cspReportOnly).toContain('script-src')
    expect(cspReportOnly).toContain('strict-dynamic')
    expect(cspReportOnly).toContain('object-src')
    expect(cspReportOnly).not.toContain('unsafe-eval')
    expect(response.headers.get('reporting-endpoints')).toContain('csp-endpoint')
  })

  it('applies Content-Security-Policy when CSP_MODE is enforce', async () => {
    const env = {
      APP_ENV: 'production',
      CSP_MODE: 'enforce'
    } as unknown as CloudflareEnv

    const request = new Request('https://neteco.es/catalogo')
    const response = await shopWorker.fetch(request, env, context())

    expect(response.headers.get('content-type')).toContain('text/html')
    const csp = response.headers.get('content-security-policy')
    expect(csp).not.toBeNull()
    expect(csp).toContain('script-src')
    expect(csp).toContain('strict-dynamic')
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("base-uri 'self'")
    expect(csp).toContain("form-action 'self' https://sis-t.redsys.es:25443 https://sis.redsys.es")
    expect(csp).not.toContain('unsafe-eval')
    expect(response.headers.has('content-security-policy-report-only')).toBe(false)
  })

  it('disables CSP headers when CSP_MODE is off', async () => {
    const env = {
      APP_ENV: 'production',
      CSP_MODE: 'off'
    } as unknown as CloudflareEnv

    const request = new Request('https://neteco.es/catalogo')
    const response = await shopWorker.fetch(request, env, context())

    expect(response.headers.has('content-security-policy')).toBe(false)
    expect(response.headers.has('content-security-policy-report-only')).toBe(false)
  })

  it('injects nonces into HTML script tags and generates unique nonces across requests', async () => {
    const env = {
      APP_ENV: 'preprod',
      CSP_MODE: 'report-only'
    } as unknown as CloudflareEnv

    const response1 = await shopWorker.fetch(new Request('https://preprod.neteco.es/catalogo'), env, context())
    const response2 = await shopWorker.fetch(new Request('https://preprod.neteco.es/catalogo'), env, context())

    const csp1 = response1.headers.get('content-security-policy-report-only')!
    const csp2 = response2.headers.get('content-security-policy-report-only')!

    const nonce1Match = csp1.match(/'nonce-([^']+)'/)
    const nonce2Match = csp2.match(/'nonce-([^']+)'/)

    expect(nonce1Match).not.toBeNull()
    expect(nonce2Match).not.toBeNull()
    expect(nonce1Match![1]).not.toBe(nonce2Match![1])

    const html1 = await response1.text()
    expect(html1).toContain(`<script nonce="${nonce1Match![1]}" src="/_nuxt/entry.js"></script>`)
  })

  it('includes Cloudflare Turnstile origins in strict CSP on enabled /contacto', async () => {
    const env = {
      APP_ENV: 'preprod',
      CSP_MODE: 'enforce',
      SUPPORT_ENABLED: 'true',
      SUPPORT_TURNSTILE_ENABLED: 'true'
    } as unknown as CloudflareEnv

    const response = await shopWorker.fetch(new Request('https://preprod.neteco.es/contacto'), env, context())
    const csp = response.headers.get('content-security-policy')!
    expect(csp).toContain('https://challenges.cloudflare.com')
  })

  it('preserves private cache-control and security restrictions on private routes', async () => {
    const env = {
      APP_ENV: 'preprod',
      CSP_MODE: 'report-only'
    } as unknown as CloudflareEnv

    const response = await shopWorker.fetch(new Request('https://preprod.neteco.es/carrito'), env, context())
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('x-frame-options')).toBe('DENY')
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive')
    expect(response.headers.has('content-security-policy-report-only')).toBe(true)
  })
})
