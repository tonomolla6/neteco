import * as OTPAuth from 'otpauth'
import { randomBytes } from 'node:crypto'
import { hashOpaqueToken } from '../utils/secrets'

export const TOTP_PERIOD_SECONDS = 30

export function createTotpEnrollment(email: string) {
  const secret = new OTPAuth.Secret({ size: 20 }).base32
  const totp = new OTPAuth.TOTP({
    issuer: 'NETECO',
    label: email,
    algorithm: 'SHA1',
    digits: 6,
    period: TOTP_PERIOD_SECONDS,
    secret
  })
  return { secret, uri: totp.toString() }
}

export function validateTotp(input: {
  secret: string
  token: string
  timestamp?: number
  lastUsedStep?: number | null
}) {
  if (!/^\d{6}$/.test(input.token)) return null
  const timestamp = input.timestamp ?? Date.now()
  const totp = new OTPAuth.TOTP({
    issuer: 'NETECO',
    label: 'account',
    algorithm: 'SHA1',
    digits: 6,
    period: TOTP_PERIOD_SECONDS,
    secret: OTPAuth.Secret.fromBase32(input.secret)
  })
  const delta = totp.validate({ token: input.token, timestamp, window: 1 })
  if (delta === null) return null
  const step = OTPAuth.TOTP.counter({ period: TOTP_PERIOD_SECONDS, timestamp }) + delta
  if (input.lastUsedStep !== undefined && input.lastUsedStep !== null && step <= input.lastUsedStep) return null
  return step
}

export function generateRecoveryCodes(count = 8) {
  if (!Number.isSafeInteger(count) || count < 4 || count > 20) throw new RangeError('Recovery code count is invalid')
  return Array.from({ length: count }, () => {
    const value = randomBytes(8).toString('hex').toUpperCase()
    return `${value.slice(0, 4)}-${value.slice(4, 8)}-${value.slice(8, 12)}-${value.slice(12)}`
  })
}

export function normalizeRecoveryCode(code: string) {
  return code.replace(/[^A-Za-z0-9]/g, '').toUpperCase()
}

export function recoveryCodeHashes(codes: string[], pepper: string) {
  return codes.map((code) => hashOpaqueToken(normalizeRecoveryCode(code), pepper))
}

export function findRecoveryCode(code: string, hashes: string[], pepper: string) {
  const candidate = hashOpaqueToken(normalizeRecoveryCode(code), pepper)
  const index = hashes.indexOf(candidate)
  return index < 0 ? null : { index, remaining: hashes.filter((_, current) => current !== index) }
}
