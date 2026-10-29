import { describe, expect, it, vi } from 'vitest'
import {
  catalogTypedAttributeDefinitionSchema,
  catalogTypedAttributeValuesSchema,
  createCatalogTypedAttributeDefinitionSchema,
  updateCatalogTypedAttributeDefinitionSchema,
  validateTypedAttributeValues,
  type CatalogTypedAttributeDefinition
} from '../../shared/catalog-typed-attributes'

const product = '10000000-0000-4000-8000-000000000001'
const target = '10000000-0000-4000-8000-000000000002'
const categoryUuid = '20000000-0000-4000-8000-000000000001'
const definitions = [
  ['text', { maxLength: 500 }],
  ['number', { precision: 2, min: -10, max: 10 }],
  ['unit', { precision: 2, units: ['ml', 'l'], min: 0 }],
  ['boolean', {}],
  [
    'list',
    {
      options: [
        { code: 'green', label: 'Verde', status: 'active' },
        { code: 'old', label: 'Anterior', status: 'retired' }
      ]
    }
  ],
  ['reference', {}]
].map(([kind, config], index) => ({
  id: `30000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  categoryId: 10,
  categoryUuid,
  code: String(kind),
  kind,
  label: `Atributo ${kind}`,
  revision: 1,
  status: 'active',
  config
})) as CatalogTypedAttributeDefinition[]
const context = { categoryId: 10, mode: 'write' as const, productId: product }
const envelope = (values: unknown[]) => ({ version: 1, values })
function entry(index: number, value: unknown, revision = 1) {
  return { definitionId: definitions[index]!.id, revision, value }
}

describe('category typed attributes own-data contract', () => {
  it('rejects every C0 control and DEL in text values and definition labels', () => {
    for (const code of [...Array.from({ length: 32 }, (_, index) => index), 127]) {
      const text = `left${String.fromCodePoint(code)}right`
      expect(validateTypedAttributeValues(envelope([entry(0, text)]), definitions, context).success).toBe(false)
      expect(catalogTypedAttributeDefinitionSchema.safeParse({ ...definitions[0], label: text }).success).toBe(false)
    }
  })
  it('preserves printable boundaries, C1 and supplementary Unicode without broadening the control policy', () => {
    for (const text of [
      'left right',
      'left~right',
      'left\u0080right',
      'left\u009fright',
      'Fórmula Ω 🧪',
      'Cafe\u0301'
    ]) {
      const raw = envelope([entry(0, text)])
      expect(validateTypedAttributeValues(raw, definitions, context)).toEqual({ success: true, data: raw })
      expect(catalogTypedAttributeDefinitionSchema.parse({ ...definitions[0], label: text }).label).toBe(text)
    }
  })
  it('defines all six kinds and preserves false, zero, empty list and exact Unicode text', () => {
    definitions.forEach((definition) =>
      expect(catalogTypedAttributeDefinitionSchema.parse(definition)).toEqual(definition)
    )
    const raw = envelope([
      entry(0, '  Fórmula Ω  '),
      entry(1, 0),
      entry(2, { quantity: 0, unit: 'ml' }),
      entry(3, false),
      entry(4, []),
      entry(5, target)
    ])
    expect(validateTypedAttributeValues(raw, definitions, context)).toEqual({ success: true, data: raw })
  })
  it.each([
    [0, 123],
    [0, ''],
    [0, 'x'.repeat(501)],
    [0, 'unsafe\u0000'],
    [1, '1'],
    [1, true],
    [1, NaN],
    [1, Infinity],
    [1, 10.01],
    [1, -10.01],
    [1, 0.001],
    [1, 0.1 + 0.2],
    [2, { quantity: 1, unit: 'kg' }],
    [2, { quantity: -1, unit: 'ml' }],
    [2, { quantity: 1, unit: 'ml', extra: true }],
    [3, 'false'],
    [3, 0],
    [3, null],
    [4, ['green', 'green']],
    [4, ['unknown']],
    [4, ['old']],
    [4, 'green'],
    [5, 'https://example.invalid/item'],
    [5, product],
    [5, [target]]
  ])('rejects invalid value kind index %i: %j', (index, value) => {
    expect(validateTypedAttributeValues(envelope([entry(Number(index), value)]), definitions, context).success).toBe(
      false
    )
  })
  it('rejects values from a different explicit category, unknown definition or missing revision', () => {
    expect(
      validateTypedAttributeValues(envelope([entry(0, 'hello')]), definitions, { ...context, categoryId: 11 }).success
    ).toBe(false)
    expect(validateTypedAttributeValues(envelope([entry(0, 'hello', 2)]), definitions, context).success).toBe(false)
    expect(validateTypedAttributeValues(envelope([entry(0, 'hello')]), [], context).success).toBe(false)
  })
  it('requires latest active revision for writes but validates historical snapshots without reinterpretation', () => {
    const latest = { ...definitions[0]!, revision: 2, status: 'retired' as const, config: { maxLength: 2 } }
    const all = [...definitions, latest] as CatalogTypedAttributeDefinition[]
    const raw = envelope([entry(0, 'historical text')])
    expect(validateTypedAttributeValues(raw, all, context).success).toBe(false)
    expect(validateTypedAttributeValues(raw, all, { ...context, mode: 'historical' }).success).toBe(true)
    expect(
      validateTypedAttributeValues(envelope([entry(4, ['old'])]), definitions, { ...context, mode: 'historical' })
        .success
    ).toBe(true)
  })
  it('bounds numbers and accepts only the configured numeric round-trip precision without coercion', () => {
    const numeric = { ...definitions[1]!, config: { precision: 6 } } as CatalogTypedAttributeDefinition
    expect(validateTypedAttributeValues(envelope([entry(1, 1e9)]), [numeric], context).success).toBe(true)
    expect(validateTypedAttributeValues(envelope([entry(1, -1e9)]), [numeric], context).success).toBe(true)
    expect(validateTypedAttributeValues(envelope([entry(1, 1e9 + 1)]), [numeric], context).success).toBe(false)
    expect(validateTypedAttributeValues(envelope([entry(1, 1e-7)]), [numeric], context).success).toBe(false)
  })
  it('bounds the namespace and does not accept duplicate identities or extra keys', () => {
    expect(catalogTypedAttributeValuesSchema.safeParse(envelope([entry(0, 'a'), entry(0, 'b')])).success).toBe(false)
    expect(
      catalogTypedAttributeValuesSchema.safeParse(
        envelope(
          Array.from({ length: 33 }, (_, index) => ({
            ...entry(0, 'a'),
            definitionId: `30000000-0000-4000-8000-${String(index).padStart(12, '0')}`
          }))
        )
      ).success
    ).toBe(false)
    expect(catalogTypedAttributeValuesSchema.safeParse({ ...envelope([]), extra: true }).success).toBe(false)
    expect(catalogTypedAttributeValuesSchema.safeParse(envelope([{ ...entry(0, 'a'), extra: true }])).success).toBe(
      false
    )
  })
  it('never invokes getters or accepts pollution keys, cycles or sparse arrays', () => {
    const getter = vi.fn(() => [])
    const hostile = {
      version: 1,
      get values() {
        return getter()
      }
    }
    expect(catalogTypedAttributeValuesSchema.safeParse(hostile).success).toBe(false)
    expect(getter).not.toHaveBeenCalled()
    expect(
      catalogTypedAttributeValuesSchema.safeParse(JSON.parse('{"version":1,"values":[],"__proto__":{}}')).success
    ).toBe(false)
    const cycle: unknown[] = []
    cycle.push(cycle)
    expect(catalogTypedAttributeValuesSchema.safeParse(envelope(cycle)).success).toBe(false)
    expect(catalogTypedAttributeValuesSchema.safeParse(envelope(new Array(1))).success).toBe(false)
  })
  it('uses strict kind/config and immutable identity fields in updates', () => {
    const base = {
      categoryId: 10,
      code: 'finish',
      kind: 'list',
      label: 'Acabado',
      config: definitions[4]!.config,
      expectedVersion: 0,
      reason: 'Definición sintética'
    }
    expect(createCatalogTypedAttributeDefinitionSchema.safeParse(base).success).toBe(true)
    expect(createCatalogTypedAttributeDefinitionSchema.safeParse({ ...base, kind: 'number' }).success).toBe(false)
    expect(
      updateCatalogTypedAttributeDefinitionSchema.safeParse({
        label: 'Nuevo título',
        config: base.config,
        expectedVersion: 1,
        reason: base.reason,
        code: 'renamed'
      }).success
    ).toBe(false)
    expect(
      createCatalogTypedAttributeDefinitionSchema.safeParse({
        ...base,
        config: {
          options: Array.from({ length: 101 }, (_, index) => ({
            code: `option_${index}`,
            label: 'Opción',
            status: 'active'
          }))
        }
      }).success
    ).toBe(false)
  })
})
