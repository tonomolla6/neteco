import { describe, expect, it } from 'vitest'
import { resolveWalletPayment } from '../../workers/payments/wallet-capabilities'

const now = '2026-10-29T12:00:00Z'
const context = { origin: 'https://shop.example', terminal: '001', environment: 'sandbox' as const, now }
const verified = {
  method: 'apple_pay',
  approved: true,
  bankSupported: true,
  domainVerified: true,
  terminalEnabled: true,
  origin: 'https://shop.example',
  terminal: '001',
  environment: 'sandbox',
  validUntil: '2026-10-30T12:00:00Z'
}

function resolve(method: unknown, evidence: unknown, deviceAvailable: unknown = true, overrides = {}) {
  return resolveWalletPayment({ method, evidence, deviceAvailable, ...context, ...overrides })
}

describe('wallet capability gate', () => {
  it.each(['apple_pay', 'google_pay'])('allows %s with all matching evidence', (method) => {
    expect(resolve(method, { ...verified, method })).toEqual({ method, fallback: 'redirect' })
  })
  it('does not apply Apple approval to Google Pay', () => {
    expect(resolve('google_pay', verified)).toEqual({ method: 'redirect' })
  })
  it.each(['apple_pay', 'google_pay'])('falls back for unsupported device: %s', (method) => {
    expect(resolve(method, verified, false)).toEqual({ method: 'redirect' })
  })
  it.each(['approved', 'bankSupported', 'domainVerified', 'terminalEnabled'])('fails closed without %s', (key) => {
    expect(resolve('apple_pay', { ...verified, [key]: false })).toEqual({ method: 'redirect' })
    expect(resolve('google_pay', { ...verified, [key]: undefined })).toEqual({ method: 'redirect' })
  })
  it.each([
    { origin: 'https://other.example' },
    { origin: 'http://shop.example' },
    { origin: 'https://shop.example/path' },
    { terminal: '002' },
    { environment: 'production' },
    { validUntil: now },
    { validUntil: '2026-10-28T12:00:00Z' },
    { validUntil: 'invalid' },
    { validUntil: '2026-02-30T00:00:00Z' },
    { validUntil: '2026-10-30T12:00:00.000Z' },
    { approved: 'true' },
    { bankSupported: 1 },
    { unknown: true }
  ])('falls back on invalid or mismatched evidence %#', (change) => {
    expect(resolve('apple_pay', { ...verified, ...change })).toEqual({ method: 'redirect' })
  })
  it.each([null, undefined, {}, [], 'approved'])('fails closed on malformed evidence %#', (evidence) => {
    expect(resolve('google_pay', evidence)).toEqual({ method: 'redirect' })
  })
  it.each([undefined, null, 'card', 'APPLE_PAY', 'redirect'])('uses Redirect for unknown method %#', (method) => {
    expect(resolve(method, verified)).toEqual({ method: 'redirect' })
  })
  it.each([undefined, null, 1, 'true'])('requires explicit device support %#', (available) => {
    expect(
      resolveWalletPayment({ method: 'apple_pay', evidence: verified, deviceAvailable: available, ...context })
    ).toEqual({ method: 'redirect' })
  })
  it.each([
    { now: 'invalid' },
    { now: '2026-10-29T12:00:00.000Z' },
    { origin: 'https://shop.example/' },
    { terminal: '1' },
    { environment: 'production' }
  ])('fails closed when runtime context differs or is invalid %#', (override) => {
    expect(resolve('apple_pay', verified, true, override)).toEqual({ method: 'redirect' })
  })
})
