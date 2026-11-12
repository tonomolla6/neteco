import { describe, expect, it, vi } from 'vitest'
import {
  createSupportScanVerifier,
  createSupportChallengeVerifier,
  SUPPORT_SCAN_AUDIENCE
} from '../../workers/runtime/support-adapters'
import { testNow } from '../support/deterministic'

const SECRET = 'synthetic-private-support-scanner-secret-0123456789abcdef'
const RECEIPT = {
  scope: 'support_attachment',
  id: '10000000-0000-4000-8000-000000000049',
  attachmentId: '20000000-0000-4000-8000-000000000049',
  checksum: 'a'.repeat(64),
  byteSize: 100,
  verdict: 'clean',
  scannerVersion: 'synthetic-scanner-not-real-av',
  scannedAt: '2026-10-03T00:00:00Z',
  expiresAt: '2026-10-04T00:00:00Z'
}
async function signature(raw: string, audience = SUPPORT_SCAN_AUDIENCE, secret = SECRET) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  return (
    'sha256=' +
    Array.from(
      new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(audience + raw))),
      (value) => value.toString(16).padStart(2, '0')
    ).join('')
  )
}
const scanner = (value: string) =>
  new Request('https://neteco.invalid/api/support/attachments/scan-receipts', {
    method: 'POST',
    headers: { 'x-neteco-support-scan-signature': value }
  })
describe('private support scanner runtime adapter', () => {
  it('requires a separate configured secret; there is no approval fallback', () => {
    for (const value of [undefined, '', 'short', 'local-only-' + 'x'.repeat(64), 'x'.repeat(4097)])
      expect(createSupportScanVerifier(value)).toBeUndefined()
  })
  it('verifies exact raw whitespace and dedicated audience before parsing or trusting receipt body', async () => {
    const verify = createSupportScanVerifier(SECRET)!,
      raw = JSON.stringify(RECEIPT, null, 2),
      signed = await signature(raw)
    expect(await verify(scanner(signed), { ...RECEIPT, verdict: 'infected' }, raw)).toEqual(RECEIPT)
    expect(await verify(scanner(signed), RECEIPT, JSON.stringify(RECEIPT))).toBeNull()
    expect(await verify(scanner(await signature(raw, '')), RECEIPT, raw)).toBeNull()
    expect(
      await verify(
        scanner(await signature(raw, SUPPORT_SCAN_AUDIENCE, 'another-dedicated-private-scanner-key')),
        RECEIPT,
        raw
      )
    ).toBeNull()
    const otherScope = JSON.stringify({ ...RECEIPT, scope: 'catalog_asset' })
    expect(await verify(scanner(await signature(otherScope)), RECEIPT, otherScope)).toBeNull()
  })
  it('rejects unbounded, malformed, unsigned or wrong-namespace receipts', async () => {
    const verify = createSupportScanVerifier(SECRET)!,
      raw = JSON.stringify(RECEIPT)
    for (const value of ['', 'sha256=broken', 'sha256=' + 'A'.repeat(64)])
      expect(await verify(scanner(value), RECEIPT, raw)).toBeNull()
    expect(await verify(scanner(await signature(raw)), RECEIPT, 'x'.repeat(16385))).toBeNull()
    expect(
      await verify(new Request('https://neteco.invalid/api/media/scan-receipts', { method: 'POST' }), RECEIPT, raw)
    ).toBeNull()
    expect(await verify(scanner(await signature('{')), RECEIPT, '{')).toBeNull()
  })
})

const ORIGIN = 'https://preprod.neteco.es',
  CHALLENGE_SECRET = 'synthetic-cloudflare-challenge-secret-0123456789abcdef'
const intake = (headers: Record<string, string> = {}) =>
  new Request(ORIGIN + '/api/support/tickets', { headers: { 'cf-connecting-ip': '192.0.2.49', ...headers } })
const proof = () => ({
  success: true,
  hostname: 'preprod.neteco.es',
  action: 'neteco_support',
  challenge_ts: new Date(testNow()).toISOString()
})
describe('explicit official Siteverify support port (offline transport tests)', () => {
  it('never constructs on missing/testing/unsafe configuration or contacts network at construction', () => {
    const fetcher = vi.fn()
    for (const value of [undefined, '', 'short', '1x0000000000000000000000000000000AA'])
      expect(createSupportChallengeVerifier(value, ORIGIN, fetcher)).toBeUndefined()
    for (const origin of [
      'http://preprod.neteco.es',
      'https://neteco.invalid',
      'https://support.test',
      ORIGIN + '/path'
    ])
      expect(createSupportChallengeVerifier(CHALLENGE_SECRET, origin, fetcher)).toBeUndefined()
    expect(createSupportChallengeVerifier(CHALLENGE_SECRET, ORIGIN, fetcher)).toBeTypeOf('function')
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('requires fixed endpoint, hostname, action, current one-time proof and trusted edge IP', async () => {
    const fetcher = vi.fn(async () => Response.json(proof())),
      verify = createSupportChallengeVerifier(CHALLENGE_SECRET, ORIGIN, fetcher)!
    expect(await verify({ token: 'synthetic-widget-token', request: intake() })).toBe(true)
    const [url, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify')
    expect(options).toMatchObject({ method: 'POST', redirect: 'error' })
    expect(Object.fromEntries(options.body as URLSearchParams)).toEqual({
      secret: CHALLENGE_SECRET,
      response: 'synthetic-widget-token',
      remoteip: '192.0.2.49'
    })
    expect(await verify({ token: '', request: intake() })).toBe(false)
    expect(await verify({ token: 'x'.repeat(2049), request: intake() })).toBe(false)
    expect(
      await verify({
        token: 'synthetic',
        request: intake({ 'cf-connecting-ip': 'bad', 'x-forwarded-for': '192.0.2.49' })
      })
    ).toBe(false)
    expect(fetcher).toHaveBeenCalledOnce()
  })
  it.each([
    { success: false },
    { hostname: 'foreign.example' },
    { action: 'login' },
    { challenge_ts: 'invalid' },
    { challenge_ts: '2020-01-01T00:00:00Z' }
  ])('rejects mismatched proof %# without retries', async (change) => {
    const fetcher = vi.fn(async () => Response.json({ ...proof(), ...change })),
      verify = createSupportChallengeVerifier(CHALLENGE_SECRET, ORIGIN, fetcher)!
    expect(await verify({ token: 'synthetic', request: intake() })).toBe(false)
    expect(fetcher).toHaveBeenCalledOnce()
  })
  it('treats outage/invalid JSON/oversized responses as unconfirmed and never logs secrets or retries', async () => {
    for (const response of [
      new Response('Unavailable', { status: 503 }),
      new Response('broken', { headers: { 'content-type': 'application/json' } }),
      new Response('x'.repeat(8193), { headers: { 'content-type': 'application/json' } })
    ]) {
      const fetcher = vi.fn(async () => response),
        verify = createSupportChallengeVerifier(CHALLENGE_SECRET, ORIGIN, fetcher)!
      expect(await verify({ token: 'synthetic', request: intake() })).toBe(false)
      expect(fetcher).toHaveBeenCalledOnce()
    }
    const fetcher = vi.fn(async () => {
        throw new Error('offline-transport-error')
      }),
      verify = createSupportChallengeVerifier(CHALLENGE_SECRET, ORIGIN, fetcher)!
    expect(await verify({ token: 'synthetic', request: intake() })).toBe(false)
    expect(fetcher).toHaveBeenCalledOnce()
  })
})
