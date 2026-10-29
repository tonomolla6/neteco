import { describe, expect, it } from 'vitest'
import type { CatalogTypedAttributeDefinition } from '../../shared/catalog-typed-attributes'
import {
  catalogTypedAttributeDefinitionsViewSchema,
  catalogTypedAttributeProductViewSchema,
  catalogTypedAttributeValuesReceiptSchema,
  updateCatalogTypedAttributeValuesSchema,
  catalogTypedAttributeDefinitionHttpUpdateSchema
} from '../../shared/catalog-typed-attribute-views'

const id = '0058ca00-0000-4000-8000-000000000001'
const commandId = '0058ca00-0000-4000-8000-000000000009'
const definition: CatalogTypedAttributeDefinition = {
  id,
  categoryId: 7,
  categoryUuid: 'c1',
  code: 'alimentaria',
  kind: 'boolean',
  label: 'Uso alimentario',
  revision: 1,
  status: 'active',
  config: {}
}
const typed = { version: 1, values: [{ definitionId: id, revision: 1, value: false }] }
const product = { id: 1, uuid: 'p1', categoryId: 7, categoryUuid: 'c1', catalogVersion: 2, status: 'draft' }
const definitionsView = () => ({
  source: 'cloudflare',
  categoryId: 7,
  categoryUuid: 'c1',
  definitions: [definition],
  capabilities: { read: true, create: false, update: false, retire: false }
})
const productView = () => ({
  source: 'cloudflare',
  product,
  typed,
  definitions: [definition],
  capabilities: { read: true, update: true }
})

describe('typed catalog private views and values command contracts', () => {
  it('accepts an authoritative read without inventing write capabilities or UUIDs for legacy durable IDs', () => {
    expect(catalogTypedAttributeDefinitionsViewSchema.parse(definitionsView())).toEqual(definitionsView())
    expect(catalogTypedAttributeProductViewSchema.parse(productView())).toEqual(productView())
  })
  it('accepts current and exact historical revisions without collapsing their shared definition ID', () => {
    const view = productView()
    view.definitions.push({ ...definition, revision: 2, label: 'Uso alimentario actual', status: 'retired' })
    expect(catalogTypedAttributeProductViewSchema.safeParse(view).success).toBe(true)
  })
  it('rejects a duplicate revision, category mismatch or absent pinned revision', () => {
    expect(
      catalogTypedAttributeProductViewSchema.safeParse({ ...productView(), definitions: [definition, definition] })
        .success
    ).toBe(false)
    expect(
      catalogTypedAttributeDefinitionsViewSchema.safeParse({ ...definitionsView(), categoryUuid: 'other' }).success
    ).toBe(false)
    expect(catalogTypedAttributeProductViewSchema.safeParse({ ...productView(), definitions: [] }).success).toBe(false)
  })
  it('requires current typed boolean capabilities and a Cloudflare source, never a string or legacy fallback', () => {
    for (const value of [
      { ...definitionsView(), source: 'node' },
      { ...definitionsView(), capabilities: { read: true, create: 'true', update: false, retire: false } },
      { ...productView(), capabilities: { read: false, update: true } }
    ]) {
      const schema =
        'product' in value ? catalogTypedAttributeProductViewSchema : catalogTypedAttributeDefinitionsViewSchema
      expect(schema.safeParse(value).success).toBe(false)
    }
  })
  it('accepts full replacement with false intact and normalizes only the command reason', () => {
    expect(
      updateCatalogTypedAttributeValuesSchema.parse({ expectedVersion: 2, reason: ' Ajuste técnico ', typed })
    ).toEqual({
      expectedVersion: 2,
      reason: 'Ajuste técnico',
      typed
    })
    expect(
      updateCatalogTypedAttributeValuesSchema.safeParse({ expectedVersion: 0, reason: 'Ajuste', typed }).success
    ).toBe(false)
    expect(
      updateCatalogTypedAttributeValuesSchema.safeParse({ expectedVersion: 2, reason: 'Ajuste', typed, price: 1 })
        .success
    ).toBe(false)
  })
  it('validates a durable values receipt and rejects unsupported actions or extra authority', () => {
    const receipt = {
      source: 'cloudflare',
      action: 'update_values',
      commandId,
      productId: 1,
      productUuid: 'p1',
      catalogVersion: 3,
      typed,
      updated: true
    }
    expect(catalogTypedAttributeValuesReceiptSchema.parse(receipt)).toEqual(receipt)
    expect(catalogTypedAttributeValuesReceiptSchema.safeParse({ ...receipt, action: 'publish' }).success).toBe(false)
    expect(catalogTypedAttributeValuesReceiptSchema.safeParse({ ...receipt, approved: true }).success).toBe(false)
  })
  it('distinguishes update from retirement and rejects immutable definition identity in either body', () => {
    expect(
      catalogTypedAttributeDefinitionHttpUpdateSchema.parse({
        action: 'update',
        label: 'Etiqueta nueva',
        config: {},
        expectedVersion: 1,
        reason: 'Corrección'
      })
    ).toMatchObject({ action: 'update' })
    expect(
      catalogTypedAttributeDefinitionHttpUpdateSchema.parse({
        action: 'retire',
        expectedVersion: 1,
        reason: 'Retirada'
      })
    ).toMatchObject({ action: 'retire' })
    expect(
      catalogTypedAttributeDefinitionHttpUpdateSchema.safeParse({
        action: 'update',
        label: 'Nueva',
        config: {},
        expectedVersion: 1,
        reason: 'Cambio',
        kind: 'text'
      }).success
    ).toBe(false)
  })
  it('does not invoke getters or accept cycles, inherited fields or sparse definition lists', () => {
    let calls = 0
    const getter = { ...productView() }
    Object.defineProperty(getter, 'source', {
      enumerable: true,
      get() {
        calls++
        return 'cloudflare'
      }
    })
    expect(catalogTypedAttributeProductViewSchema.safeParse(getter).success).toBe(false)
    expect(calls).toBe(0)
    const cyclic: Record<string, unknown> = productView()
    cyclic.extra = cyclic
    expect(catalogTypedAttributeProductViewSchema.safeParse(cyclic).success).toBe(false)
    expect(
      catalogTypedAttributeProductViewSchema.safeParse(
        Object.assign(Object.create({ source: 'cloudflare' }), { ...productView(), source: undefined })
      ).success
    ).toBe(false)
    expect(
      catalogTypedAttributeProductViewSchema.safeParse({ ...productView(), definitions: new Array(1) }).success
    ).toBe(false)
  })
})
