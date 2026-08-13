import { describe, expect, it } from 'vitest'
import { request } from 'undici'
import { deterministicTestData, deterministicUuid, FIXED_TEST_INSTANT } from '../fixtures/deterministic'
import { assertLocalTestUrl } from '../support/no-external-network'

describe('deterministic test fixtures', () => {
  it('repeats IDs, tokens, emails and time for the same isolated namespace', () => {
    const first = deterministicTestData('unit:repeatable')
    const second = deterministicTestData('unit:repeatable')
    expect([first.uuid(), first.uuid(), first.token(), first.email(), first.date().toISOString()]).toEqual([
      second.uuid(),
      second.uuid(),
      second.token(),
      second.email(),
      FIXED_TEST_INSTANT
    ])
    expect(deterministicUuid('unit:valid')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
  })

  it('separates namespaces and rejects external HTTP origins', () => {
    expect(deterministicTestData('unit:first').uuid()).not.toBe(deterministicTestData('unit:second').uuid())
    expect(() => assertLocalTestUrl('https://api.example.invalid/path')).toThrow('External network access')
    expect(() => assertLocalTestUrl('http://127.0.0.1:3100/api/health/live')).not.toThrow()
    expect(() => assertLocalTestUrl('/api/health/live')).not.toThrow()
  })

  it('blocks lower-level Undici requests before DNS or socket access', async () => {
    await expect(request('https://api.example.invalid/path')).rejects.toThrow('External network access')
  })
})
