import { createHmac } from 'node:crypto'
import { expect, it } from 'vitest'
import { deriveAdminAuditIpHash } from '../../workers/auth/admin-audit-network'

const pepper = 'synthetic-audit-pepper-for-local-tests-only-0123456789'
const request = (ip?: string, extra: Record<string, string> = {}) =>
  new Request('https://audit.neteco.test', {
    headers: { ...(ip === undefined ? {} : { 'CF-Connecting-IP': ip }), ...extra }
  })
it('pseudonymizes only the canonical Cloudflare ingress address with a purpose-separated keyed hash', async () => {
  const expected = createHmac('sha256', pepper).update('neteco:admin-audit:request-ip:v1:192.0.2.85').digest('hex')
  expect(await deriveAdminAuditIpHash(request('192.000.002.085'), pepper)).toBe(expected)
  expect(await deriveAdminAuditIpHash(request('192.0.2.85'), pepper)).toBe(expected)
  expect(await deriveAdminAuditIpHash(request('192.0.2.85'), pepper + '-rotated')).not.toBe(expected)
  expect(expected).not.toBe(createHmac('sha256', pepper).update('neteco:admin-audit:edge:v1:192.0.2.85').digest('hex'))
})
it.each([undefined, '999.2.3.4', '192.0.2.85, 198.51.100.2', 'not-an-address'])(
  'rejects untrusted address %s rather than using a forwarding-header fallback',
  async (ip) => {
    await expect(deriveAdminAuditIpHash(request(ip, { 'X-Forwarded-For': '192.0.2.85' }), pepper)).rejects.toThrow(
      'service_unavailable'
    )
  }
)
it.each(['short', 'local-only-synthetic-pepper-is-not-a-production-secret'])(
  'rejects an unsafe pepper without exposing it',
  async (invalid) => {
    await expect(deriveAdminAuditIpHash(request('192.0.2.85'), invalid)).rejects.toThrow('service_unavailable')
  }
)
