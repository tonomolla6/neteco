import { describe, expect, it } from 'vitest'
import { parseChatWidget, parseCspOrigins } from '../../shared/chat-widget'
import { buildStrictCsp } from '../../shared/csp'
import { applicationSecurityHeaders } from '../../shared/http-security'

/**
 * Hueco para un chat flotante de un proveedor externo. No se desarrolla el chat: solo se
 * carga su script si está configurado, y la CSP admite su origen solo por configuración.
 */
describe('external chat widget configuration', () => {
  it('loads nothing when the script URL is empty or not https', () => {
    expect(parseChatWidget({})).toBeNull()
    expect(parseChatWidget({ chatWidgetSrc: '', chatWidgetId: 'abc' })).toBeNull()
    expect(parseChatWidget({ chatWidgetSrc: 'http://chat.example/w.js' })).toBeNull()
    expect(parseChatWidget({ chatWidgetSrc: 'javascript:alert(1)' })).toBeNull()
    expect(parseChatWidget({ chatWidgetSrc: 'https://user:pw@chat.example/w.js' })).toBeNull()
  })

  it('needs consent by default (the provider may set cookies) unless told it does not', () => {
    expect(parseChatWidget({ chatWidgetSrc: 'https://chat.example/w.js', chatWidgetId: ' site-42 ' })).toEqual({
      src: 'https://chat.example/w.js',
      id: 'site-42',
      origin: 'https://chat.example',
      requiresConsent: true
    })
    expect(
      parseChatWidget({ chatWidgetSrc: 'https://chat.example/w.js', chatWidgetCookies: 'false' })?.requiresConsent
    ).toBe(false)
  })
})

describe('CSP origins for the chat widget come only from configuration', () => {
  it('accepts bare https origins and drops anything else', () => {
    expect(
      parseCspOrigins(
        "https://chat.example, http://plain.example, https://cdn.chat.example:8443 ;javascript:x, https://x.example/path, 'unsafe-inline', *"
      )
    ).toEqual(['https://chat.example', 'https://cdn.chat.example:8443'])
    expect(parseCspOrigins('')).toEqual([])
    expect(parseCspOrigins(undefined)).toEqual([])
  })

  it('adds the configured origins to script, connect, frame and img sources, and nothing by default', () => {
    const base = buildStrictCsp({ nonce: 'n' })
    expect(base).not.toContain('chat.example')
    const csp = buildStrictCsp({ nonce: 'n', extraOrigins: ['https://chat.example'] })
    for (const directive of ['script-src', 'connect-src', 'frame-src', 'img-src']) {
      const value = csp.split('; ').find((part) => part.startsWith(`${directive} `))!
      expect(value).toContain('https://chat.example')
    }
    expect(csp).not.toMatch(/unsafe-eval|script-src[^;]*unsafe-inline/)
  })

  it('passes the origins through the application security headers', () => {
    const headers = applicationSecurityHeaders('production', {
      strict: true,
      cspMode: 'enforce',
      nonce: 'n',
      extraOrigins: ['https://chat.example']
    })
    expect(headers['content-security-policy']).toContain("connect-src 'self' https://chat.example")
  })
})
