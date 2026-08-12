import * as OTPAuth from 'otpauth'
import { describe, expect, it, vi } from 'vitest'
import {
  createTotpEnrollment,
  findRecoveryCode,
  generateRecoveryCodes,
  normalizeRecoveryCode,
  recoveryCodeHashes,
  TOTP_PERIOD_SECONDS,
  validateTotp
} from '../../server/domain/mfa'

describe('MFA domain', () => {
  const secret = 'JBSWY3DPEHPK3PXP'
  const timestamp = 1_786_540_000_000

  it('creates interoperable enrollments and strong one-time recovery codes', () => {
    const enrollment = createTotpEnrollment('owner@example.test')
    expect(enrollment.secret).toMatch(/^[A-Z2-7]+$/)
    expect(enrollment.uri).toContain('otpauth://totp/NETECO:owner%40example.test')
    expect(enrollment.uri).toContain('issuer=NETECO')

    const codes = generateRecoveryCodes()
    expect(codes).toHaveLength(8)
    expect(new Set(codes)).toHaveLength(8)
    expect(codes.every((code) => /^[A-F0-9]{4}(?:-[A-F0-9]{4}){3}$/.test(code))).toBe(true)
    expect(generateRecoveryCodes(4)).toHaveLength(4)
    for (const invalid of [3, 21, 4.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => generateRecoveryCodes(invalid)).toThrow(RangeError)
    }
  })

  it('validates a current TOTP and rejects malformed, stale and replayed tokens', () => {
    const token = OTPAuth.TOTP.generate({
      secret: OTPAuth.Secret.fromBase32(secret),
      period: TOTP_PERIOD_SECONDS,
      timestamp
    })
    const step = validateTotp({ secret, token, timestamp })
    expect(step).toBe(OTPAuth.TOTP.counter({ period: TOTP_PERIOD_SECONDS, timestamp }))
    expect(validateTotp({ secret, token: 'abc', timestamp })).toBeNull()
    expect(validateTotp({ secret, token, timestamp: timestamp + 120_000 })).toBeNull()
    expect(validateTotp({ secret, token, timestamp, lastUsedStep: step })).toBeNull()
    expect(validateTotp({ secret, token, timestamp, lastUsedStep: undefined })).toBe(step)
    expect(validateTotp({ secret, token, timestamp, lastUsedStep: null })).toBe(step)
    vi.useFakeTimers()
    vi.setSystemTime(timestamp)
    expect(validateTotp({ secret, token })).toBe(step)
    vi.useRealTimers()
  })

  it('normalizes, hashes, finds and consumes a recovery code', () => {
    const pepper = 'a-long-independent-test-pepper'
    const hashes = recoveryCodeHashes(['ABCD-1234-EFGH-5678', 'IJKL-9012-MNOP-3456'], pepper)
    expect(normalizeRecoveryCode('abcd 1234-efgh.5678')).toBe('ABCD1234EFGH5678')
    expect(findRecoveryCode('abcd1234efgh5678', hashes, pepper)).toEqual({ index: 0, remaining: [hashes[1]] })
    expect(findRecoveryCode('invalid', hashes, pepper)).toBeNull()
  })
})
