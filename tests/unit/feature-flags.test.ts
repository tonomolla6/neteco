import { describe, expect, it } from 'vitest'
import { featureFlagMatches, featureTargetingSchema } from '../../server/utils/feature-flags'

const future = new Date('2030-01-01T00:00:00Z')
const now = new Date('2026-08-13T00:00:00Z')

describe('feature flag targeting', () => {
  it('fails closed for disabled, expired or unmatched contexts', () => {
    const targeting = featureTargetingSchema.parse({ environments: ['production'], percentage: 100 })
    expect(
      featureFlagMatches(
        { key: 'test.flag', enabled: false, expiresAt: future, targeting },
        { environment: 'production' },
        now
      )
    ).toBe(false)
    expect(
      featureFlagMatches(
        { key: 'test.flag', enabled: true, expiresAt: now, targeting },
        { environment: 'production' },
        now
      )
    ).toBe(false)
    expect(
      featureFlagMatches(
        { key: 'test.flag', enabled: true, expiresAt: future, targeting },
        { environment: 'staging' },
        now
      )
    ).toBe(false)
  })

  it('enforces role, customer and deterministic percentage targeting', () => {
    const restricted = featureTargetingSchema.parse({
      roles: ['buyer'],
      customerIds: ['3d6f0a15-a4bd-449f-980d-207b762637a6'],
      percentage: 100
    })
    const flag = { key: 'test.flag', enabled: true, expiresAt: future, targeting: restricted }
    expect(featureFlagMatches(flag, { environment: 'production', roles: ['viewer'] }, now)).toBe(false)
    expect(featureFlagMatches(flag, { environment: 'production', roles: ['buyer'], customerId: null }, now)).toBe(false)
    expect(
      featureFlagMatches(
        flag,
        {
          environment: 'production',
          roles: ['buyer'],
          customerId: '3d6f0a15-a4bd-449f-980d-207b762637a6'
        },
        now
      )
    ).toBe(true)

    const none = { ...flag, targeting: featureTargetingSchema.parse({ percentage: 0 }) }
    expect(featureFlagMatches(none, { environment: 'production', subjectId: 'one' }, now)).toBe(false)
    const rollout = { ...flag, targeting: featureTargetingSchema.parse({ percentage: 50 }) }
    expect(featureFlagMatches(rollout, { environment: 'production' }, now)).toBe(false)
    const firstEvaluation = featureFlagMatches(rollout, { environment: 'production', subjectId: 'stable-subject' }, now)
    expect(typeof firstEvaluation).toBe('boolean')
    expect(featureFlagMatches(rollout, { environment: 'production', subjectId: 'stable-subject' }, now)).toBe(
      firstEvaluation
    )
  })

  it('fails closed when persisted targeting is malformed', () => {
    expect(
      featureFlagMatches(
        {
          key: 'test.flag',
          enabled: true,
          expiresAt: future,
          targeting: { environments: ['unknown'], percentage: 100 } as never
        },
        { environment: 'production' },
        now
      )
    ).toBe(false)
  })
})
