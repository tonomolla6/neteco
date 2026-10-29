import { describe, expect, it } from 'vitest'
import { catalogRecord } from '../support/catalog-tabular-fixture'
import { catalogImportScaleTypedValues } from '../../scripts/lib/catalog-import-scale-typed-fixture'
import {
  validateTypedAttributeValues,
  type CatalogTypedAttributeDefinition
} from '../../shared/catalog-typed-attributes'

const reference = '00590000-0000-4000-8000-000000000099'
const definitions = [
  { kind: 'text', config: { maxLength: 500 } },
  { kind: 'number', config: { precision: 2 } },
  { kind: 'unit', config: { precision: 2, units: ['l'] } },
  { kind: 'boolean', config: {} },
  { kind: 'list', config: { options: [{ code: 'blue', label: 'Azul', status: 'active' }] } },
  { kind: 'reference', config: {} }
].map((item, index) => ({
  ...item,
  id: `00590000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  categoryId: 1,
  categoryUuid: '00590000-0000-4000-8000-000000000010',
  code: `scale_${item.kind}`,
  label: `Synthetic ${item.kind}`,
  revision: 1,
  status: 'active'
})) as CatalogTypedAttributeDefinition[]

describe('typed scale fixture without runtime or remote authority', () => {
  it.each([0, 1, 24_999])('builds six exact valid types at row %i and retains the 71-column file shape', (index) => {
    const typed = catalogImportScaleTypedValues(definitions, reference, index)
    expect(validateTypedAttributeValues(typed, definitions, { categoryId: 1, mode: 'write' })).toMatchObject({
      success: true
    })
    expect(typed.values).toHaveLength(6)
    expect(typed.values[3]!.value).toBe(index % 2 === 1)
    expect(typed.values[5]!.value).toBe(reference)
    expect(new Set(typed.values.map((value) => value.definitionId)).size).toBe(6)
    const base = catalogRecord(),
      attrs = JSON.parse(base.product_attributes_json)
    const record = { ...base, product_attributes_json: JSON.stringify({ ...attrs, typed }) }
    expect(Object.keys(record)).toHaveLength(71)
    expect(JSON.parse(record.product_attributes_json)).toMatchObject(attrs)
    if (index === 0) expect(typed.values[1]!.value).toBe(0)
  })
  it('rejects incomplete or retired definitions rather than weakening the dataset', () => {
    expect(() => catalogImportScaleTypedValues(definitions.slice(1), reference, 0)).toThrow()
    expect(() =>
      catalogImportScaleTypedValues(
        definitions.map((d) => ({ ...d, status: 'retired' })),
        reference,
        0
      )
    ).toThrow()
    expect(() => catalogImportScaleTypedValues(definitions, 'not-a-product-uuid', 0)).toThrow()
  })
})
