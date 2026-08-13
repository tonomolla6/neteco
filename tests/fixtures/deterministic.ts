import { createHash } from 'node:crypto'

export const FIXED_TEST_INSTANT = '2026-08-13T12:00:00.000Z'

function digest(value: string) {
  return createHash('sha256').update(`neteco-test-v1:${value}`, 'utf8').digest()
}

export function deterministicUuid(value: string) {
  const bytes = digest(value).subarray(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export interface DeterministicTestData {
  readonly namespace: string
  uuid(label?: string): string
  token(label?: string): string
  email(label?: string): string
  date(offsetMilliseconds?: number): Date
}

export function deterministicTestData(namespace: string, fixedInstant = FIXED_TEST_INSTANT): DeterministicTestData {
  if (!namespace.trim()) throw new Error('A deterministic test namespace is required')
  const counters = new Map<string, number>()
  const next = (label: string) => {
    const sequence = counters.get(label) ?? 0
    counters.set(label, sequence + 1)
    return `${namespace}:${label}:${sequence}`
  }
  return {
    namespace,
    uuid: (label = 'uuid') => deterministicUuid(next(label)),
    token: (label = 'token') => digest(next(label)).toString('hex'),
    email: (label = 'email') => `${digest(next(label)).toString('hex').slice(0, 24)}@integration.invalid`,
    date: (offsetMilliseconds = 0) => new Date(Date.parse(fixedInstant) + offsetMilliseconds)
  }
}
