import { describe, expect, it } from 'vitest'
import {
  catalogTabularColumns,
  exportCatalogCsv,
  parseCatalogCsv,
  validateCatalogRecords
} from '../../shared/catalog-tabular-core'
import { exportCatalogXlsx, parseCatalogXlsx } from '../../server/services/catalog-tabular'
import { catalogRecord } from '../support/catalog-tabular-fixture'

const definitionId = '10000000-0000-4000-8000-000000000058'
const namespace = (value: unknown = false) => ({ version: 1, values: [{ definitionId, revision: 1, value }] })
function row(typed: unknown, present = true) {
  const original = catalogRecord()
  return {
    ...original,
    product_attributes_json: JSON.stringify({
      ...JSON.parse(original.product_attributes_json),
      attrs: [{ k: 'Legado', v: 'Conservar 😀' }],
      custom: { array: [0, false, null] },
      ...(present ? { typed } : {})
    })
  }
}
describe('typed values stay inside the existing 71-column tabular contract', () => {
  it.each(
    [
      null,
      [],
      { version: 2, values: [] },
      { version: 1, values: [], hidden: true },
      { version: 1, values: [{ definitionId: 'not-a-uuid', revision: 1, value: 0 }] },
      { version: 1, values: [{ definitionId, revision: 0, value: 0 }] },
      { version: 1, values: [...namespace().values, ...namespace(0).values] },
      namespace(null),
      namespace({ quantity: 0, unit: 'unknown' }),
      namespace({ quantity: 0 }),
      namespace(1e10)
    ].map((typed) => [typed])
  )('rejects malformed typed namespace %j with field-level evidence before import', (typed) => {
    const validation = validateCatalogRecords([row(typed)])
    expect(validation.valid).toBe(false)
    expect(validation.issues).toContainEqual(
      expect.objectContaining({ row: 2, field: 'product_attributes_json', code: 'field.invalid' })
    )
    expect(validation.dataset.products).toHaveLength(0)
  })
  it('keeps absent namespaces and explicit empty values distinct without creating definitions', () => {
    const absent = validateCatalogRecords([row(undefined, false)])
    const empty = validateCatalogRecords([row({ version: 1, values: [] })])
    expect(absent.issues).toEqual([])
    expect(empty.issues).toEqual([])
    expect(absent.dataset.products[0]!.attributes).not.toHaveProperty('typed')
    expect(empty.dataset.products[0]!.attributes).toHaveProperty('typed', { version: 1, values: [] })
  })
  it('round-trips all six representations through UTF-8 CSV and XLSX with legacy and unknown JSON intact', async () => {
    const values = [
      '  Español 😀 é  ',
      0,
      { quantity: 0.25, unit: 'l' },
      false,
      ['blue', 'green'],
      '20000000-0000-4000-8000-000000000058'
    ]
    const typed = {
      version: 1,
      values: values.map((value, index) => ({
        definitionId: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        revision: index + 1,
        value
      }))
    }
    const original = row(typed)
    expect(catalogTabularColumns).toHaveLength(71)
    expect(catalogTabularColumns[16]).toBe('product_attributes_json')
    const csv = parseCatalogCsv(exportCatalogCsv([original]))
    const xlsx = await parseCatalogXlsx(await exportCatalogXlsx([original]))
    for (const records of [csv, xlsx]) {
      expect(records).toEqual([original])
      const validation = validateCatalogRecords(records)
      expect(validation.issues).toEqual([])
      expect(validation.dataset.products[0]!.attributes).toEqual(JSON.parse(original.product_attributes_json))
    }
  })
})
