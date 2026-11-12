import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import {
  supportChallengeConfigurationSchema,
  supportOptionsSchema,
  type SupportChallengeConfiguration
} from '../../shared/support-operations'
import { supportFixture, CONTACT, POLICY } from './d1-support-fixture'
import { testUuid } from '../support/deterministic'

const configuration: SupportChallengeConfiguration = {
  provider: 'turnstile',
  siteKey: 'synthetic-public-site-key',
  action: 'neteco_support'
}
const options = {
  source: 'cloudflare',
  categories: ['product', 'order', 'shipping', 'payment', 'invoice', 'return', 'account', 'other'],
  policy: POLICY,
  attachments: false,
  challengeAvailable: false,
  privacyReviewRequired: false
}

describe('support public challenge contract', () => {
  it('preserves the legacy optional descriptor without publishing a made-up key', () => {
    expect(supportOptionsSchema.parse(options)).not.toHaveProperty('challenge')
    expect(supportChallengeConfigurationSchema.parse(configuration)).toEqual(configuration)
  })
  it.each([
    { ...configuration, provider: 'checkbox' },
    { ...configuration, action: 'catalog_upload' },
    { ...configuration, siteKey: '' },
    { ...configuration, siteKey: 'https://example.test/key' },
    { ...configuration, siteKey: 'key\n' },
    { ...configuration, siteKey: 'x'.repeat(201) },
    { ...configuration, secret: 'must-never-be-public' }
  ])('rejects a malformed or secret-bearing descriptor %#', (candidate) => {
    expect(supportChallengeConfigurationSchema.safeParse(candidate).success).toBe(false)
  })
  it('requires confirmed verifier availability for an advertised descriptor', () => {
    expect(supportOptionsSchema.safeParse({ ...options, challenge: configuration }).success).toBe(false)
    expect(
      supportOptionsSchema.parse({ ...options, challengeAvailable: true, challenge: configuration })
    ).toHaveProperty('challenge', configuration)
  })
  it('does not invoke hostile descriptor getters', () => {
    const getter = vi.fn(() => configuration.siteKey)
    const hostile = { provider: 'turnstile', action: 'neteco_support' }
    Object.defineProperty(hostile, 'siteKey', { enumerable: true, get: getter })
    expect(supportChallengeConfigurationSchema.safeParse(hostile).success).toBe(false)
    expect(getter).not.toHaveBeenCalled()
  })
})

describe('support challenge HTTP publication and immutable recovery', () => {
  let f: Awaited<ReturnType<typeof supportFixture>>
  beforeEach(async () => {
    f = await supportFixture()
  })
  afterEach(() => {
    f.sqlite.close()
  })

  it('does not advertise sitekey without a real configured verifier', async () => {
    f.deps.challengeConfiguration = configuration
    const response = await f.request('/api/support/options', 'GET', undefined, '')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ challengeAvailable: false })
    const second = await f.request('/api/support/options', 'GET', undefined, '')
    expect(await second.json()).not.toHaveProperty('challenge')
  })
  it('publishes only the public server-owned descriptor, privately and uncached', async () => {
    f.deps.challengeVerifier = vi.fn(async () => true)
    f.deps.challengeConfiguration = configuration
    const response = await f.request('/api/support/options', 'GET', undefined, '')
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    const dto = supportOptionsSchema.parse(await response.json())
    expect(dto.challenge).toEqual(configuration)
    expect(JSON.stringify(dto)).not.toContain(f.deps.contactPepper)
    expect(f.deps.challengeVerifier).not.toHaveBeenCalled()
  })
  it('configured verifier with absent descriptor remains backwards compatible', async () => {
    f.deps.challengeVerifier = vi.fn(async () => true)
    const response = await f.request('/api/support/options', 'GET', undefined, '')
    expect(response.status).toBe(200)
    const dto = supportOptionsSchema.parse(await response.json())
    expect(dto.challengeAvailable).toBe(true)
    expect(dto).not.toHaveProperty('challenge')
  })
  it('malformed server configuration fails closed without exposing it', async () => {
    f.deps.challengeVerifier = vi.fn(async () => true)
    // Fault injection crosses the configuration boundary, not its typed API.
    Object.defineProperty(f.deps, 'challengeConfiguration', {
      value: { ...configuration, secret: 'private-fixture-value' }
    })
    const response = await f.request('/api/support/options', 'GET', undefined, '')
    expect(response.status).toBe(503)
    expect(await response.text()).not.toContain('private-fixture-value')
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM support_commands').get()).toEqual({ n: 0 })
  })
  it('replays the same business/key with a renewed token before quota or verification', async () => {
    const optionResponse = await f.request('/api/support/options', 'GET', undefined, ''),
      cookie = optionResponse.headers.get('set-cookie')!.split(';')[0]!,
      key = testUuid()
    f.deps.challengeVerifier = vi.fn(async () => true)
    const first = await f.request(
      '/api/support/tickets',
      'POST',
      { ...CONTACT, challengeToken: 'original-temporary-token' },
      cookie,
      key
    )
    expect(first.status).toBe(201)
    const receipt = await first.json()
    f.sqlite.exec('UPDATE support_intake_limits SET used=6')
    const economic = f.economic()
    const replay = await f.request(
      '/api/support/tickets',
      'POST',
      { ...CONTACT, challengeToken: 'renewed-temporary-token' },
      cookie,
      key
    )
    expect(replay.status).toBe(201)
    expect(await replay.json()).toEqual(receipt)
    expect(f.deps.challengeVerifier).not.toHaveBeenCalled()
    expect(f.sqlite.prepare('SELECT used FROM support_intake_limits').get()).toEqual({ used: 6 })
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM support_commands').get()).toEqual({ n: 1 })
    expect(JSON.stringify(f.sqlite.prepare('SELECT input FROM support_commands').all())).not.toMatch(/temporary-token/)
    expect(f.economic()).toEqual(economic)
  })
  it('a renewable credential never permits changing the business for the same key', async () => {
    const optionResponse = await f.request('/api/support/options', 'GET', undefined, ''),
      cookie = optionResponse.headers.get('set-cookie')!.split(';')[0]!,
      key = testUuid()
    f.deps.challengeVerifier = vi.fn(async () => true)
    const first = await f.request(
      '/api/support/tickets',
      'POST',
      { ...CONTACT, challengeToken: 'first-token' },
      cookie,
      key
    )
    expect(first.status).toBe(201)
    const changed = await f.request(
      '/api/support/tickets',
      'POST',
      { ...CONTACT, subject: 'Changed business subject', challengeToken: 'new-token' },
      cookie,
      key
    )
    expect(changed.status).toBe(409)
    expect(await changed.json()).toEqual({ error: { code: 'idempotency_conflict' } })
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM support_commands').get()).toEqual({ n: 1 })
    expect(f.deps.challengeVerifier).not.toHaveBeenCalled()
  })
})
