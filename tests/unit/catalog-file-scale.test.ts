import { describe, expect, it } from 'vitest'
import {
  auditCatalogFileScale,
  catalogFileScaleCsvBytes,
  catalogFileScaleRecords
} from '../../scripts/lib/catalog-file-scale'
import { catalogTabularColumns, exportCatalogCsv, validateCatalogRecords } from '../../shared/catalog-tabular-core'
import { catalogTypedAttributeValuesSchema, CATALOG_TYPED_ATTRIBUTE_KINDS } from '../../shared/catalog-typed-attributes'
import { catalogRecord } from '../support/catalog-tabular-fixture'

describe('real file-scale proof contract (small bounded fixtures only)', () => {
  it('includes all six strict typed representations in every row without losing legacy JSON or claiming reference authority', async () => {
    const records = catalogFileScaleRecords(3)
    const legacy = JSON.parse(catalogRecord().product_attributes_json)
    let definitionIds: string[] | undefined
    for (const [index, record] of records.entries()) {
      const attributes = JSON.parse(record.product_attributes_json)
      const typed = catalogTypedAttributeValuesSchema.parse(attributes.typed)
      expect(attributes.attrs).toEqual([{ k: 'Nota legacy', v: 'Conservar Ñ 🧼' }])
      expect(typed.values).toHaveLength(6)
      const ids = typed.values.map((entry) => entry.definitionId)
      expect(new Set(ids).size).toBe(6)
      if (definitionIds) expect(ids).toEqual(definitionIds)
      definitionIds = ids
      const reference = typed.values[5]!.value
      expect(reference).toMatch(/^[0-9a-f-]{36}$/)
      expect(reference).not.toBe(record.product_id)
      expect(typed.values.map((entry) => entry.value)).toEqual([
        `  Escala ${index} 😀  `,
        index / 100,
        { quantity: index / 100, unit: 'l' },
        index % 2 === 1,
        ['blue'],
        reference
      ])
      for (const [key, value] of Object.entries(legacy)) if (key !== 'image') expect(attributes[key]).toEqual(value)
    }
    const result = await auditCatalogFileScale(3)
    expect(result.typed).toEqual({
      kinds: [...CATALOG_TYPED_ATTRIBUTE_KINDS],
      valuesPerRow: 6,
      totalValues: 18,
      referenceAuthorityAccepted: false
    })
    expect(result.fullFilePassed).toBe(true)
    expect(result.scope).toContain('no D1')
  })
  it('produces unique semantically valid71-column rows with Unicode and typed JSON', () => {
    const records = catalogFileScaleRecords(3)
    expect(validateCatalogRecords(records).valid).toBe(true)
    for (const key of ['product_id', 'variant_id', 'asset_id', 'sku', 'product_slug'] as const)
      expect(new Set(records.map((record) => record[key])).size).toBe(3)
    expect(Object.keys(records[0]!)).toEqual([...catalogTabularColumns])
    expect(records[2]!.product_name).toContain('Ñ 🧼')
    expect(JSON.parse(records[2]!.product_attributes_json).etiqueta).toBe('Ñ 🧼 "fila 2"')
  })
  it('measures the exact UTF-8 CSV envelope including BOM, quoting and multiline Unicode', () => {
    const records = catalogFileScaleRecords(3)
    expect(catalogFileScaleCsvBytes(records)).toBe(exportCatalogCsv(records).byteLength)
  })
  it('roundtrips real CSV and ExcelJS XLSX through the actual guarded decoder without mocks', async () => {
    const phases: string[] = []
    const result = await auditCatalogFileScale(3, (phase) => phases.push(phase))
    expect(result.fullFilePassed).toBe(true)
    expect(result.csv).toMatchObject({ outcome: 'passed', rows: 3, samples: [0, 1, 2] })
    expect(result.xlsx).toMatchObject({ outcome: 'passed', rows: 3, samples: [0, 1, 2] })
    expect(phases).toContain('decode_csv')
    expect(phases).toContain('decode_xlsx')
    expect(result.xlsx.bytes).toBeLessThanOrEqual(20_000_000)
  })
  it.each([0, -1, 25_001, 1.5, NaN])('rejects row budget %s before allocating records', (count) => {
    expect(() => catalogFileScaleRecords(count)).toThrow('Invalid scale row count')
  })
})
