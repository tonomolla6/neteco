import { describe, expect, it } from 'vitest'
import { assertCatalogImportRenderedReview } from '../../scripts/lib/audit-native-catalog-import-browser'
import { projectCatalogImportJobReviewEntry } from '../../shared/catalog-import-job-review'
import { validateCatalogRecords } from '../../shared/catalog-tabular-core'
import { catalogRecord, catalogFixtureIds } from '../support/catalog-tabular-fixture'

function fixture() {
  const validation = validateCatalogRecords([catalogRecord()])
  if (!validation.valid) throw new Error('invalid_review_fixture')
  const product = validation.dataset.products[0]!
  const entry = projectCatalogImportJobReviewEntry(
    { kind: 'products', itemId: product.id, payload: JSON.stringify(product) },
    { warehouseId: catalogFixtureIds.shipping }
  )
  if (entry.kind !== 'products') throw new Error('invalid_review_kind')
  return {
    entry,
    rendered: JSON.parse(JSON.stringify({ claimed: entry.claimed, after: entry.after })) as {
      claimed: Record<string, unknown>
      after: Record<string, unknown>
    }
  }
}

describe('compiled catalog diff compares exact JSON wire values', () => {
  it('accepts the real validated nested null-prototype payload rendered as DOM JSON', () => {
    const { entry, rendered } = fixture()
    expect(Object.getPrototypeOf(entry.claimed.attributes.imageRights)).toBeNull()
    expect(() => assertCatalogImportRenderedReview(rendered, entry)).not.toThrow()
  })

  it.each(['changed', 'missing', 'scalar-type', 'nested'] as const)(
    'still refuses %s rendered values',
    (corruption) => {
      const { entry, rendered } = fixture()
      if (corruption === 'changed') rendered.claimed.name = 'Different product'
      if (corruption === 'missing') delete rendered.after.publishedAt
      if (corruption === 'scalar-type') rendered.after.publishedAt = 'null'
      if (corruption === 'nested') {
        const attributes = rendered.claimed.attributes as Record<string, unknown>
        attributes.imageRights = { owner: 'Different owner' }
      }
      expect(() => assertCatalogImportRenderedReview(rendered, entry)).toThrow()
    }
  )
})
