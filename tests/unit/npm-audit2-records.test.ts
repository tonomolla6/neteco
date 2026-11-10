import { describe, expect, it } from 'vitest'
import { createNotificationInputSchema } from '../../shared/account-notifications'
import { campaignDocumentSchema } from '../../shared/campaign-pipeline'

describe('Zod records retain string keys and their value validation', () => {
  it('accepts arbitrary notification metadata and applies the empty default', () => {
    const metadata = createNotificationInputSchema.shape.metadata
    expect(metadata.parse(undefined)).toEqual({})
    expect(metadata.parse({ number: 1, nested: { enabled: true } })).toEqual({ number: 1, nested: { enabled: true } })
    expect(metadata.safeParse([]).success).toBe(false)
  })

  it('accepts string tracking tags and rejects non-string values', () => {
    const tags = campaignDocumentSchema.shape.trackingTags
    expect(tags.parse({ channel: 'email' })).toEqual({ channel: 'email' })
    expect(tags.safeParse({ channel: 1 }).success).toBe(false)
  })
})
