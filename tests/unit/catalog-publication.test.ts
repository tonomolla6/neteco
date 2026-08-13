import { describe, expect, it } from 'vitest'
import { catalogPublicationIssues, validGtin, type PublicationCandidate } from '../../server/domain/catalog-publication'

const complete: PublicationCandidate = {
  name: 'Detergente profesional 5 L',
  shortDescription: 'Detergente profesional concentrado para superficies lavables.',
  description: 'Fórmula profesional documentada para la limpieza diaria de superficies lavables y resistentes al agua.',
  categoryStatus: 'published',
  brandStatus: 'published',
  image: '/img/products/detergente/principal.jpg',
  imageAlt: 'Garrafa de detergente profesional de cinco litros',
  imageRightsOwner: 'NETECO',
  imageRightsLicense: 'Fotografía propia autorizada para ecommerce',
  imageAuthorizedAt: '2026-08-13',
  variants: [
    {
      sku: 'DET-5L',
      ean: '4006381333931',
      gtin: null,
      mpn: null,
      identifierExceptionReason: null,
      priceCents: 1599,
      unitBase: 'l',
      unitLabel: 'litro',
      contentQuantity: 5,
      minimumQuantity: 1,
      quantityIncrement: 1,
      maximumQuantity: 20,
      weightGrams: 5200,
      widthMm: 180,
      heightMm: 320,
      depthMm: 130,
      backorderAllowed: false,
      leadTimeDays: null
    }
  ]
}

describe('catalog publication gate', () => {
  it('validates standard GTIN check digits and formats', () => {
    expect(validGtin('96385074')).toBe(true)
    expect(validGtin('036000291452')).toBe(true)
    expect(validGtin('4006381333931')).toBe(true)
    expect(validGtin('10012345000017')).toBe(true)
    expect(validGtin('4006381333932')).toBe(false)
    expect(validGtin('ABC')).toBe(false)
  })

  it('accepts a complete, attributable and shippable product', () => {
    expect(catalogPublicationIssues(complete)).toEqual([])
    expect(
      catalogPublicationIssues({
        ...complete,
        variants: [
          {
            ...complete.variants[0]!,
            ean: null,
            gtin: null,
            mpn: null,
            identifierExceptionReason: 'El fabricante no asigna código comercial'
          }
        ]
      })
    ).toEqual([])
  })

  it('reports every blocking field with stable machine-readable codes', () => {
    const issues = catalogPublicationIssues({
      name: 'x',
      shortDescription: null,
      description: null,
      categoryStatus: 'draft',
      brandStatus: null,
      image: null,
      imageAlt: null,
      imageRightsOwner: null,
      imageRightsLicense: null,
      imageAuthorizedAt: 'not-a-date',
      variants: [
        {
          sku: ' bad sku ',
          ean: '4006381333932',
          gtin: '123',
          mpn: null,
          identifierExceptionReason: 'short',
          priceCents: 1.5,
          unitBase: '',
          unitLabel: '',
          contentQuantity: 0,
          minimumQuantity: 2,
          quantityIncrement: 0,
          maximumQuantity: 1,
          weightGrams: 0,
          widthMm: 0,
          heightMm: 0,
          depthMm: 0,
          backorderAllowed: true,
          leadTimeDays: null
        },
        {
          ...complete.variants[0]!,
          sku: 'BAD SKU',
          ean: null,
          gtin: null,
          mpn: 'MPN-1',
          maximumQuantity: null,
          backorderAllowed: true,
          leadTimeDays: 3
        },
        {
          ...complete.variants[0]!,
          sku: 'NO-ID',
          ean: null,
          gtin: null,
          mpn: null,
          identifierExceptionReason: 'short'
        }
      ]
    })
    const codes = issues.map((issue) => issue.code)
    expect(codes).toEqual(
      expect.arrayContaining([
        'product.name',
        'product.short_description',
        'product.description',
        'category.status',
        'brand.status',
        'media.primary',
        'media.alt',
        'media.owner',
        'media.license',
        'media.authorization',
        'variant.sku',
        'variant.sku_duplicate',
        'variant.ean',
        'variant.gtin',
        'variant.identifier',
        'variant.price',
        'variant.unit',
        'variant.quantity',
        'variant.maximum',
        'variant.logistics',
        'variant.lead_time'
      ])
    )
  })

  it('reports a product with no variants', () => {
    expect(catalogPublicationIssues({ ...complete, variants: [] }).map((issue) => issue.code)).toContain(
      'variant.missing'
    )
    expect(
      catalogPublicationIssues({
        ...complete,
        variants: [
          {
            ...complete.variants[0]!,
            ean: null,
            gtin: null,
            mpn: null,
            identifierExceptionReason: undefined
          }
        ]
      }).map((issue) => issue.code)
    ).toContain('variant.identifier')
  })
})
