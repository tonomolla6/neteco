import { describe, expect, it, vi } from 'vitest'
import {
  catalogImportJobReceiptSchema,
  catalogImportJobCommandInputSchema
} from '../../shared/catalog-import-job-commands'

const id = '00570000-0000-4000-8000-000000000001'
const hash = 'a'.repeat(64)
const receipt = () => ({
  source: 'cloudflare',
  action: 'apply',
  jobId: id,
  jobHash: hash,
  commandId: id,
  counts: { products: 601, variants: 601, assets: 601, mappings: 601 },
  updated: true
})

describe('strict whole-job command receipts', () => {
  it('accepts apply and revert receipts for all 25000 rows without authority extras', () => {
    expect(catalogImportJobReceiptSchema.parse(receipt())).toEqual(receipt())
    expect(
      catalogImportJobReceiptSchema.safeParse({
        ...receipt(),
        action: 'revert',
        counts: { products: 25000, variants: 25000, assets: 25000, mappings: 25000 }
      }).success
    ).toBe(true)
  })
  it('rejects missing fields, extra fields, malformed identifiers and nonboolean success', () => {
    for (const key of Object.keys(receipt())) {
      const missing = Object.fromEntries(Object.entries(receipt()).filter(([field]) => field !== key))
      expect(catalogImportJobReceiptSchema.safeParse(missing).success).toBe(false)
    }
    for (const extra of [{ published: true }, { outcome: 'receipt' }, { reason: 'Authority' }])
      expect(catalogImportJobReceiptSchema.safeParse({ ...receipt(), ...extra }).success).toBe(false)
    for (const patch of [
      { source: 'sqlite' },
      { action: 'seal' },
      { jobId: 'bad' },
      { commandId: 'bad' },
      { jobHash: 'A'.repeat(64) },
      { jobHash: 'a'.repeat(63) },
      { updated: false },
      { updated: 1 }
    ])
      expect(catalogImportJobReceiptSchema.safeParse({ ...receipt(), ...patch }).success).toBe(false)
  })
  it('rejects missing, extra, noninteger and out-of-range counts without coercion', () => {
    for (const field of Object.keys(receipt().counts)) {
      const missing = Object.fromEntries(Object.entries(receipt().counts).filter(([key]) => key !== field))
      expect(catalogImportJobReceiptSchema.safeParse({ ...receipt(), counts: missing }).success).toBe(false)
      for (const value of [null, 0, -1, 25001, 1.5, '1', Infinity, NaN])
        expect(
          catalogImportJobReceiptSchema.safeParse({ ...receipt(), counts: { ...receipt().counts, [field]: value } })
            .success
        ).toBe(false)
    }
    expect(
      catalogImportJobReceiptSchema.safeParse({ ...receipt(), counts: { ...receipt().counts, extra: 1 } }).success
    ).toBe(false)
  })
  it('rejects getters and foreign prototypes without invoking accessors', () => {
    const getter = vi.fn(() => hash)
    const raw = { ...receipt() }
    Object.defineProperty(raw, 'jobHash', { enumerable: true, get: getter })
    expect(catalogImportJobReceiptSchema.safeParse(raw).success).toBe(false)
    const counts = { ...receipt().counts }
    Object.defineProperty(counts, 'products', { enumerable: true, get: getter })
    expect(catalogImportJobReceiptSchema.safeParse({ ...receipt(), counts }).success).toBe(false)
    expect(getter).not.toHaveBeenCalled()
    expect(catalogImportJobReceiptSchema.safeParse(Object.assign(Object.create({}), receipt())).success).toBe(false)
    const symbol = { ...receipt(), [Symbol('secret')]: 1 }
    expect(catalogImportJobReceiptSchema.safeParse(symbol).success).toBe(false)
  })
  it('reuses the existing strict previewHash command contract and trimmed bounded reason', () => {
    expect(catalogImportJobCommandInputSchema.parse({ previewHash: hash, reason: '  Whole job approved  ' })).toEqual({
      previewHash: hash,
      reason: 'Whole job approved'
    })
    for (const reason of ['', 'a', 'x'.repeat(501), 'unsafe\ncontrol'])
      expect(catalogImportJobCommandInputSchema.safeParse({ previewHash: hash, reason }).success).toBe(false)
    expect(catalogImportJobCommandInputSchema.safeParse({ jobHash: hash, reason: 'Approved' }).success).toBe(false)
    expect(
      catalogImportJobCommandInputSchema.safeParse({
        previewHash: hash,
        reason: 'Approved',
        now: '2026-10-04T00:00:00Z'
      }).success
    ).toBe(false)
  })
})
