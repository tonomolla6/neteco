import {
  CATALOG_TYPED_ATTRIBUTE_KINDS,
  validateTypedAttributeValues,
  type CatalogTypedAttributeDefinition,
  type CatalogTypedAttributeValues
} from '../../shared/catalog-typed-attributes'

/** Pure synthetic fixture builder. Public eligibility is established separately
 * in disposable D1 before the protected baseline, never by these values. */
export function catalogImportScaleTypedValues(
  definitions: readonly CatalogTypedAttributeDefinition[],
  referenceId: string,
  index: number
): CatalogTypedAttributeValues {
  if (
    !Number.isSafeInteger(index) ||
    index < 0 ||
    definitions.length !== 6 ||
    new Set(definitions.map((d) => d.kind)).size !== 6
  )
    throw new Error('invalid_typed_scale_fixture')
  const samples = {
    text: `  Escala ${index} 😀  `,
    number: (index % 10_000) / 100,
    unit: { quantity: (index % 1_000) / 100, unit: 'l' as const },
    boolean: index % 2 === 1,
    list: ['blue'],
    reference: referenceId
  }
  const typed: CatalogTypedAttributeValues = {
    version: 1,
    values: CATALOG_TYPED_ATTRIBUTE_KINDS.map((kind) => {
      const definition = definitions.find((d) => d.kind === kind)!
      return { definitionId: definition.id, revision: definition.revision, value: samples[kind] }
    })
  }
  const result = validateTypedAttributeValues(typed, definitions, {
    categoryId: definitions[0]!.categoryId,
    mode: 'write'
  })
  if (!result.success) throw new Error('invalid_typed_scale_fixture')
  return result.data
}
