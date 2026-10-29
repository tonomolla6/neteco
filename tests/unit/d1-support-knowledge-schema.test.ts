import { describe, expect, it } from 'vitest'
import { cmsCreateInputSchema, cmsDocumentSchema, cmsUpdateInputSchema } from '../../shared/cms-commands'
import { cmsDocument } from './d1-cms-fixture'

describe('CMS optional help metadata stays in the existing authoring contract', () => {
  it('accepts explicit category/review date and preserves the metadata through document/create/update schemas', () => {
    const supportKnowledge = { category: 'facturas', reviewDueAt: '2099-01-01T00:00:00Z' }
    expect(cmsDocumentSchema.parse(cmsDocument({ supportKnowledge }))).toMatchObject({ supportKnowledge })
    expect(cmsCreateInputSchema.parse({ ...cmsDocument({ supportKnowledge }), expectedVersion: 0 })).toMatchObject({
      supportKnowledge
    })
    expect(cmsUpdateInputSchema.parse({ ...cmsDocument({ supportKnowledge }), expectedVersion: 1 })).toMatchObject({
      supportKnowledge
    })
  })
  it('keeps legacy documents unchanged and does not accept invented approval flags or default review dates', () => {
    expect(Object.hasOwn(cmsDocumentSchema.parse(cmsDocument()), 'supportKnowledge')).toBe(false)
    for (const supportKnowledge of [
      { category: 'facturas' },
      { category: 'facturas', reviewDueAt: '2099-01-01T00:00:00Z', chemicalApproved: true }
    ])
      expect(cmsDocumentSchema.safeParse(cmsDocument({ supportKnowledge })).success).toBe(false)
  })
})
