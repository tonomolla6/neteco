import { describe, expect, it, vi } from 'vitest'
import {
  CATALOG_NATIVE_IMPORT_MAX_BYTES,
  CATALOG_NATIVE_IMPORT_MAX_ROWS,
  nativeImportCommandInputSchema,
  nativeImportInputSchema,
  nativeImportInvalidSchema,
  nativeImportPreviewSchema,
  nativeImportReceiptSchema
} from '../../shared/catalog-native-import'
import { catalogTabularColumns } from '../../shared/catalog-tabular-core'
import { catalogRecord } from '../support/catalog-tabular-fixture'

const hash = 'a'.repeat(64)
const id = '11111111-1111-4111-8111-111111111111'
const counts = { products: 1, variants: 2, assets: 3, mappings: 3 }
const preview = () => ({
  source: 'cloudflare',
  outcome: 'preview',
  id,
  hash,
  createdAt: '2026-10-04T10:00:00Z',
  expiresAt: '2026-10-04T11:00:00Z',
  status: 'pending',
  counts,
  policy: { publication: 'draft_only', media: 'pending_verification', priceStock: 'authorized_initialization' }
})
const invalid = () => ({
  source: 'cloudflare',
  outcome: 'invalid',
  issues: [{ code: 'invalid_record', row: 1, field: 'sku', message: 'Registro inválido.' }]
})
const receipt = () => ({
  source: 'cloudflare',
  action: 'apply',
  previewId: id,
  previewHash: hash,
  commandId: id,
  counts,
  updated: true
})

describe('bounded native catalog import contracts', () => {
  it('accepts exact 71-column records without coercion or trimming source fields', () => {
    expect(CATALOG_NATIVE_IMPORT_MAX_ROWS).toBe(500)
    expect(CATALOG_NATIVE_IMPORT_MAX_BYTES).toBe(900_000)
    expect(catalogTabularColumns).toHaveLength(71)
    const record = { ...catalogRecord(), product_name: '  Nombre conservado  ' }
    expect(nativeImportInputSchema.parse({ records: [record] })).toEqual({ records: [record] })
    expect(nativeImportInputSchema.safeParse({ records: Array.from({ length: 500 }, () => record) }).success).toBe(true)
    expect(nativeImportInputSchema.safeParse({ records: Array.from({ length: 501 }, () => record) }).success).toBe(
      false
    )
    expect(nativeImportInputSchema.safeParse({ records: [] }).success).toBe(false)
    expect(
      nativeImportInputSchema.safeParse({ records: [{ ...catalogRecord(), description: 'x'.repeat(20_000) }] }).success
    ).toBe(true)
    expect(
      nativeImportInputSchema.safeParse({ records: [{ ...catalogRecord(), description: 'x'.repeat(20_001) }] }).success
    ).toBe(false)
    expect(nativeImportInputSchema.safeParse({ records: [{ ...record, product_legacy_id: 1 }] }).success).toBe(false)
    const { sku: _sku, ...missing } = record
    expect(nativeImportInputSchema.safeParse({ records: [missing] }).success).toBe(false)
    expect(nativeImportInputSchema.safeParse({ records: [{ ...record, unexpected: '' }] }).success).toBe(false)
    expect(nativeImportInputSchema.safeParse({ records: [record], csv: '' }).success).toBe(false)
  })

  it('requires strict command hashes and bounded trimmed reasons', () => {
    expect(nativeImportCommandInputSchema.parse({ previewHash: hash, reason: '  Alta autorizada  ' }).reason).toBe(
      'Alta autorizada'
    )
    for (const reason of ['  a  ', 'x'.repeat(501), 'válido\npero control']) {
      expect(nativeImportCommandInputSchema.safeParse({ previewHash: hash, reason }).success).toBe(false)
    }
    expect(nativeImportCommandInputSchema.safeParse({ previewHash: 'A'.repeat(64), reason: 'Alta' }).success).toBe(
      false
    )
    expect(
      nativeImportCommandInputSchema.safeParse({ previewHash: hash, reason: 'Alta', authorized: true }).success
    ).toBe(false)
  })

  it('enforces real ordered preview instants, fixed safe policy, status and bounded counts', () => {
    expect(nativeImportPreviewSchema.safeParse(preview()).success).toBe(true)
    for (const status of ['expired', 'applied', 'reverted']) {
      expect(nativeImportPreviewSchema.safeParse({ ...preview(), status }).success).toBe(true)
    }
    for (const createdAt of ['2026-02-30T10:00:00Z', '2026-10-04T25:00:00Z', '2026-10-04T10:00:00.000Z']) {
      expect(nativeImportPreviewSchema.safeParse({ ...preview(), createdAt }).success).toBe(false)
    }
    for (const expiresAt of [preview().createdAt, '2026-10-04T09:00:00Z', '2026-11-31T10:00:00Z']) {
      expect(nativeImportPreviewSchema.safeParse({ ...preview(), expiresAt }).success).toBe(false)
    }
    for (const value of [0, 501, 1.5]) {
      expect(nativeImportPreviewSchema.safeParse({ ...preview(), counts: { ...counts, assets: value } }).success).toBe(
        false
      )
    }
    expect(
      nativeImportPreviewSchema.safeParse({ ...preview(), policy: { ...preview().policy, publication: 'published' } })
        .success
    ).toBe(false)
    expect(nativeImportPreviewSchema.safeParse({ ...preview(), counts: { ...counts, extra: 1 } }).success).toBe(false)
    expect(
      nativeImportPreviewSchema.safeParse({ ...preview(), policy: { ...preview().policy, extra: true } }).success
    ).toBe(false)
  })

  it('accepts bounded issues and apply/revert receipts without extra authority', () => {
    expect(nativeImportInvalidSchema.safeParse(invalid()).success).toBe(true)
    expect(
      nativeImportInvalidSchema.safeParse({
        ...invalid(),
        issues: Array.from({ length: 100 }, () => invalid().issues[0])
      }).success
    ).toBe(true)
    expect(nativeImportInvalidSchema.safeParse({ ...invalid(), issues: [] }).success).toBe(false)
    expect(
      nativeImportInvalidSchema.safeParse({
        ...invalid(),
        issues: Array.from({ length: 101 }, () => invalid().issues[0])
      }).success
    ).toBe(false)
    expect(
      nativeImportInvalidSchema.safeParse({ ...invalid(), issues: [{ ...invalid().issues[0], row: 0 }] }).success
    ).toBe(false)
    expect(
      nativeImportInvalidSchema.safeParse({ ...invalid(), issues: [{ ...invalid().issues[0], secret: 'extra' }] })
        .success
    ).toBe(false)
    expect(nativeImportReceiptSchema.safeParse(receipt()).success).toBe(true)
    expect(nativeImportReceiptSchema.safeParse({ ...receipt(), action: 'revert' }).success).toBe(true)
    expect(nativeImportReceiptSchema.safeParse({ ...receipt(), updated: false }).success).toBe(false)
    expect(nativeImportReceiptSchema.safeParse({ ...receipt(), counts: { ...counts, variants: 501 } }).success).toBe(
      false
    )
  })

  it('rejects accessors, prototype data, forbidden keys, sparse arrays and non-JSON data before execution', () => {
    const cases = [
      { schema: nativeImportInputSchema, value: { records: [catalogRecord()] } },
      { schema: nativeImportCommandInputSchema, value: { previewHash: hash, reason: 'Alta' } },
      { schema: nativeImportPreviewSchema, value: preview() },
      { schema: nativeImportInvalidSchema, value: invalid() },
      { schema: nativeImportReceiptSchema, value: receipt() }
    ]
    for (const { schema, value } of cases) {
      const getter = vi.fn(() => 'secret')
      expect(
        schema.safeParse(Object.defineProperty({ ...value }, 'source', { enumerable: true, get: getter })).success
      ).toBe(false)
      expect(getter).not.toHaveBeenCalled()
      expect(schema.safeParse(Object.assign(Object.create({ inherited: true }), value)).success).toBe(false)
      expect(schema.safeParse({ ...value, optional: undefined }).success).toBe(false)
      expect(schema.safeParse(JSON.parse(`{"__proto__":{},${JSON.stringify(value).slice(1)}`)).success).toBe(false)
      expect(schema.safeParse({ ...value, extra: true }).success).toBe(false)
    }
    const getter = vi.fn(() => 'secret')
    const record = Object.defineProperty(catalogRecord(), 'sku', { enumerable: true, get: getter })
    expect(nativeImportInputSchema.safeParse({ records: [record] }).success).toBe(false)
    expect(getter).not.toHaveBeenCalled()
    expect(nativeImportInputSchema.safeParse({ records: new Array(1) }).success).toBe(false)
    expect(
      nativeImportInputSchema.safeParse({ records: Object.assign([catalogRecord()], { extra: true }) }).success
    ).toBe(false)
  })
})
