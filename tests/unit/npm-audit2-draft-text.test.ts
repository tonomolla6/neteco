import { describe, expect, it } from 'vitest'
import { updateVariantInputSchema } from '../../shared/catalog-draft-authoring'

describe('catalog draft text limits retain UTF-16 validation', () => {
  it('accepts a reason whose trimmed UTF-16 length reaches the minimum', () => {
    const result = updateVariantInputSchema.safeParse({ expectedVersion: 1, reason: ' 😀a ', format: 'Unit' })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.reason).toBe('😀a')
  })

  it('rejects a reason below the minimum with the previous diagnostic', () => {
    const result = updateVariantInputSchema.safeParse({ expectedVersion: 1, reason: '😀', format: 'Unit' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0]).toMatchObject({
        code: 'too_small',
        message: 'String must contain at least 3 character(s)',
        path: ['reason']
      })
    }
  })

  it('accepts the maximum format length and rejects an extra UTF-16 unit', () => {
    const input = { expectedVersion: 1, reason: 'Valid reason', format: '😀'.repeat(80) }
    expect(updateVariantInputSchema.safeParse(input).success).toBe(true)
    for (const format of [input.format + 'a', 'x'.repeat(161)]) {
      const result = updateVariantInputSchema.safeParse({ ...input, format })
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues).toHaveLength(1)
        expect(result.error.issues[0]).toMatchObject({
          code: 'too_big',
          message: 'String must contain at most 160 character(s)',
          path: ['format']
        })
      }
    }
  })
})
