import { describe, expect, it } from 'vitest'
import { inventoryCountImportProposalInputSchema } from '../../shared/inventory-count-import'

describe('inventory count import validation after Zod migration', () => {
  const input = {
    csv: 'sku,quantity\nABC,1',
    previewHash: 'a'.repeat(64),
    reason: '  stock count  ',
    reference: ' REF  '
  }

  it('preserves normalization of reason and reference', () => {
    expect(inventoryCountImportProposalInputSchema.parse(input)).toMatchObject({
      reason: 'stock count',
      reference: 'REF'
    })
  })

  it('rejects short or control-character values', () => {
    for (const change of [{ reason: 'short' }, { reference: 'ab' }, { reference: 'A\nB' }]) {
      expect(inventoryCountImportProposalInputSchema.safeParse({ ...input, ...change }).success).toBe(false)
    }
  })
})
