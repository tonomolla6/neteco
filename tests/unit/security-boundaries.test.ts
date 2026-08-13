import { describe, expect, it } from 'vitest'
import { abuseLimitRule, sensitiveRateLimit, SENSITIVE_RATE_LIMIT_POLICIES } from '../../server/utils/abuse-limit'
import { csvCell, safeCsvValue } from '../../server/utils/csv'
import { assertPublicOutboundTarget, validatedOutboundHttpsUrl } from '../../server/utils/outbound-url'
import { privateCookieOptions } from '../../server/utils/private-cookie'
import { applicationSecurityHeaders } from '../../server/utils/security-headers'

describe('security boundaries', () => {
  it.each([
    ['GET', '/api/search', 'search', 60, 60],
    ['POST', '/api/cart/items', 'cart', 120, 60],
    ['POST', '/api/orders', 'order-create', 10, 600],
    ['POST', '/api/checkout/pay', 'checkout-pay', 10, 600],
    ['POST', '/api/support/tickets', 'support-contact', 5, 3600],
    ['POST', '/api/analytics/events', 'analytics-events', 120, 60],
    ['POST', '/api/payments/redsys/notification', 'redsys-webhook', 120, 60],
    ['POST', '/api/webhooks/email', 'email-webhook', 240, 60],
    ['POST', '/api/admin/media', 'admin-media-upload', 20, 3600],
    ['GET', '/api/admin/orders', 'admin-api', 300, 60]
  ])('maps %s %s to its bounded budget', (method, path, scope, limit, windowSeconds) => {
    expect(abuseLimitRule(method, path)).toEqual({ scope, limit, windowSeconds })
  })

  it('does not rate-limit unrelated public reads through the abuse middleware', () => {
    expect(abuseLimitRule('GET', '/api/products')).toBeNull()
  })

  it('versions every endpoint-level authentication, account and newsletter budget in one catalog', () => {
    expect(SENSITIVE_RATE_LIMIT_POLICIES).toEqual({
      login: { limit: 5, windowSeconds: 900 },
      register: { limit: 3, windowSeconds: 3600 },
      'forgot-password': { limit: 3, windowSeconds: 3600 },
      'reset-password': { limit: 5, windowSeconds: 900 },
      'verify-email': { limit: 10, windowSeconds: 900 },
      'mfa-complete': { limit: 6, windowSeconds: 300 },
      'mfa-setup': { limit: 6, windowSeconds: 300 },
      'account-password': { limit: 5, windowSeconds: 900 },
      'account-email-change': { limit: 3, windowSeconds: 3600 },
      'professional-account': { limit: 5, windowSeconds: 3600 },
      'newsletter-subscribe': { limit: 3, windowSeconds: 3600 },
      'newsletter-confirm': { limit: 10, windowSeconds: 900 },
      'newsletter-unsubscribe': { limit: 20, windowSeconds: 900 }
    })
    expect(sensitiveRateLimit('login', 'User@Example.Test')).toEqual({
      scope: 'login',
      subject: 'User@Example.Test',
      limit: 5,
      windowSeconds: 900
    })
    expect(sensitiveRateLimit('reset-password')).toEqual({
      scope: 'reset-password',
      limit: 5,
      windowSeconds: 900
    })
  })

  it.each(['=1+1', '+cmd|calc', '-2+3', '@SUM(A1:A2)', '  =HYPERLINK("https://attacker.invalid")'])(
    'neutralizes spreadsheet formula payload %s',
    (payload) => {
      expect(safeCsvValue(payload)).toBe(`'${payload}`)
      expect(csvCell(payload)).toBe(`"'${payload.replaceAll('"', '""')}"`)
    }
  )

  it('quotes ordinary CSV values without changing their meaning', () => {
    expect(csvCell('texto, "seguro"')).toBe('"texto, ""seguro"""')
  })

  it.each([
    'http://provider.example.test/api',
    'https://localhost/api',
    'https://metadata.google.internal/',
    'https://127.0.0.1/api',
    'https://10.1.2.3/api',
    'https://172.16.0.1/api',
    'https://192.168.1.1/api',
    'https://169.254.169.254/latest/meta-data',
    'https://[::1]/api',
    'https://[fd00::1]/api',
    'https://user:password@provider.example.test/api',
    'https://provider.example.test/api?redirect=https://attacker.invalid',
    'not-a-url'
  ])('rejects unsafe outbound provider destination %s', (destination) => {
    expect(() => validatedOutboundHttpsUrl(destination)).toThrow()
  })

  it('accepts a public HTTPS provider path and strips only its trailing slash', () => {
    expect(validatedOutboundHttpsUrl('https://tenant.beply.es/api/3/')).toBe('https://tenant.beply.es/api/3')
    expect(validatedOutboundHttpsUrl('https://tenant.beply.es/api/3/', ['beply.es'])).toBe(
      'https://tenant.beply.es/api/3'
    )
    expect(() => validatedOutboundHttpsUrl('https://attacker.invalid/proxy', ['beply.es'])).toThrow('allowlist')
  })

  it('rejects DNS rebinding to private addresses before an outbound request', async () => {
    await expect(
      assertPublicOutboundTarget('https://api.beply.es/v3', ['beply.es'], async () => ['169.254.169.254'])
    ).rejects.toThrow('DNS resolved to a local, private')
    await expect(
      assertPublicOutboundTarget('https://api.beply.es/v3', ['beply.es'], async () => ['::1'])
    ).rejects.toThrow('DNS resolved to a local, private')
    await expect(
      assertPublicOutboundTarget('https://api.beply.es/v3?type=PDF&lang=es_ES', ['beply.es'], async () => ['8.8.8.8'])
    ).resolves.toBe('https://api.beply.es/v3?type=PDF&lang=es_ES')
  })

  it('sets private cookie flags centrally and requires Secure in production', () => {
    expect(privateCookieOptions(60, 'production')).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 60
    })
    expect(privateCookieOptions(60, 'test').secure).toBe(false)
    expect(() => privateCookieOptions(0, 'production')).toThrow('positive integer')
  })

  it('adds HSTS only to the production security-header contract', () => {
    const production = applicationSecurityHeaders('production')
    expect(production['strict-transport-security']).toBe('max-age=63072000; includeSubDomains; preload')
    expect(production['content-security-policy']).toContain("frame-ancestors 'none'")
    expect(applicationSecurityHeaders('test')).not.toHaveProperty('strict-transport-security')
  })
})
