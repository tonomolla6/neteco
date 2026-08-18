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
    expect(validGtin('x96385074')).toBe(false)
    expect(validGtin('96385074x')).toBe(false)
    expect(validGtin('x036000291452')).toBe(false)
    expect(validGtin('036000291452x')).toBe(false)
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

  it('reports exact paths and actionable messages for every publication blocker', () => {
    expect(
      catalogPublicationIssues({
        name: 'ab',
        shortDescription: 'x'.repeat(19),
        description: 'x'.repeat(39),
        categoryStatus: 'draft',
        brandStatus: 'draft',
        image: ' ',
        imageAlt: 'abcd',
        imageRightsOwner: ' ',
        imageRightsLicense: ' ',
        imageAuthorizedAt: 'not-a-date',
        variants: [
          {
            ...complete.variants[0]!,
            sku: 'bad sku',
            ean: '4006381333932',
            gtin: '123',
            mpn: null,
            identifierExceptionReason: 'short',
            priceCents: 0,
            unitBase: '',
            unitLabel: '',
            contentQuantity: 0,
            minimumQuantity: 1,
            quantityIncrement: 0,
            maximumQuantity: 0,
            weightGrams: 0,
            backorderAllowed: true,
            leadTimeDays: null
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
    ).toEqual([
      { code: 'product.name', path: 'name', message: 'Falta un nombre válido' },
      {
        code: 'product.short_description',
        path: 'shortDescription',
        message: 'La descripción corta debe tener al menos 20 caracteres'
      },
      {
        code: 'product.description',
        path: 'description',
        message: 'La descripción debe tener al menos 40 caracteres'
      },
      { code: 'category.status', path: 'category', message: 'La categoría no está publicada' },
      { code: 'brand.status', path: 'brand', message: 'La marca no está publicada' },
      { code: 'media.primary', path: 'image', message: 'Falta la imagen principal exacta del producto' },
      { code: 'media.alt', path: 'imageAlt', message: 'Falta un texto alternativo útil' },
      { code: 'media.owner', path: 'imageRightsOwner', message: 'Falta el propietario de la imagen' },
      { code: 'media.license', path: 'imageRightsLicense', message: 'Falta la licencia o autorización' },
      {
        code: 'media.authorization',
        path: 'imageAuthorizedAt',
        message: 'Falta la fecha de autorización de uso'
      },
      { code: 'variant.sku', path: 'variants.0.sku', message: 'SKU inválido' },
      { code: 'variant.ean', path: 'variants.0.ean', message: 'EAN con formato o control inválido' },
      { code: 'variant.gtin', path: 'variants.0.gtin', message: 'GTIN con formato o control inválido' },
      { code: 'variant.price', path: 'variants.0.price', message: 'Precio inválido' },
      { code: 'variant.unit', path: 'variants.0.unit', message: 'Unidad comercial incompleta' },
      {
        code: 'variant.quantity',
        path: 'variants.0.minimumQuantity',
        message: 'MOQ e incremento deben ser positivos'
      },
      {
        code: 'variant.maximum',
        path: 'variants.0.maximumQuantity',
        message: 'El máximo no puede ser menor que el mínimo'
      },
      {
        code: 'variant.logistics',
        path: 'variants.0.weightGrams',
        message: 'Peso y dimensiones logísticas deben ser positivos'
      },
      {
        code: 'variant.lead_time',
        path: 'variants.0.leadTimeDays',
        message: 'El backorder exige un plazo de entrega'
      },
      {
        code: 'variant.identifier',
        path: 'variants.1.identifierExceptionReason',
        message: 'Indica EAN/GTIN/MPN o documenta una excepción de al menos 10 caracteres'
      }
    ])
  })

  it('enforces publication boundaries and each independent commercial-unit field', () => {
    const issueCodes = (candidate: PublicationCandidate) =>
      catalogPublicationIssues(candidate).map((issue) => issue.code)
    const withVariant = (variant: Partial<PublicationCandidate['variants'][number]>) => ({
      ...complete,
      variants: [{ ...complete.variants[0]!, ...variant }]
    })

    expect(issueCodes({ ...complete, name: 'abc' })).not.toContain('product.name')
    expect(issueCodes({ ...complete, name: 'ab' })).toContain('product.name')
    expect(issueCodes({ ...complete, shortDescription: 'x'.repeat(20) })).not.toContain('product.short_description')
    expect(issueCodes({ ...complete, shortDescription: 'x'.repeat(19) })).toContain('product.short_description')
    expect(issueCodes({ ...complete, description: 'x'.repeat(40) })).not.toContain('product.description')
    expect(issueCodes({ ...complete, description: 'x'.repeat(39) })).toContain('product.description')
    expect(issueCodes({ ...complete, imageAlt: 'abcde' })).not.toContain('media.alt')
    expect(issueCodes({ ...complete, imageAlt: 'abcd' })).toContain('media.alt')

    expect(issueCodes(withVariant({ identifierExceptionReason: 'x'.repeat(10), ean: null }))).not.toContain(
      'variant.identifier'
    )
    expect(issueCodes(withVariant({ identifierExceptionReason: 'x'.repeat(9), ean: null }))).toContain(
      'variant.identifier'
    )
    expect(issueCodes(withVariant({ priceCents: 1 }))).not.toContain('variant.price')
    expect(issueCodes(withVariant({ priceCents: 0 }))).toContain('variant.price')

    for (const variant of [{ unitBase: '' }, { unitLabel: '' }, { contentQuantity: 0 }]) {
      expect(issueCodes(withVariant(variant))).toContain('variant.unit')
    }
    expect(issueCodes(withVariant({ minimumQuantity: 0 }))).toContain('variant.quantity')
    expect(issueCodes(withVariant({ quantityIncrement: 0 }))).toContain('variant.quantity')
    expect(issueCodes(withVariant({ minimumQuantity: 2, maximumQuantity: 2 }))).not.toContain('variant.maximum')
    expect(issueCodes(withVariant({ minimumQuantity: 2, maximumQuantity: 1 }))).toContain('variant.maximum')

    for (const variant of [{ weightGrams: 0 }, { widthMm: 0 }, { heightMm: 0 }, { depthMm: 0 }]) {
      expect(issueCodes(withVariant(variant))).toContain('variant.logistics')
    }
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
