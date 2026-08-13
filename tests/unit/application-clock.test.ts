import { afterEach, describe, expect, it, vi } from 'vitest'
import { applicationNow } from '../../server/utils/application-clock'
import { FIXED_TEST_INSTANT } from '../fixtures/deterministic'

afterEach(() => {
  vi.useRealTimers()
})

describe('application clock', () => {
  it('uses an explicit fixed instant only in the test environment', () => {
    expect(applicationNow({ APP_ENV: 'test', NETECO_TEST_NOW: FIXED_TEST_INSTANT }).toISOString()).toBe(
      FIXED_TEST_INSTANT
    )
    expect(() => applicationNow({ APP_ENV: 'test', NETECO_TEST_NOW: 'not-a-date' })).toThrow('valid ISO timestamp')
  })

  it('ignores the test override outside the test environment', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2030-01-02T03:04:05.000Z'))
    expect(applicationNow({ APP_ENV: 'production', NETECO_TEST_NOW: FIXED_TEST_INSTANT }).toISOString()).toBe(
      '2030-01-02T03:04:05.000Z'
    )
  })
})
