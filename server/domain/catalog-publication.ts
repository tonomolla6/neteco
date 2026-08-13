export interface PublicationVariant {
  sku: string
  ean?: string | null
  gtin?: string | null
  mpn?: string | null
  identifierExceptionReason?: string | null
  priceCents: number
  unitBase: string
  unitLabel: string
  contentQuantity: number
  minimumQuantity: number
  quantityIncrement: number
  maximumQuantity?: number | null
  weightGrams: number
  widthMm: number
  heightMm: number
  depthMm: number
  backorderAllowed: boolean
  leadTimeDays?: number | null
}

export interface PublicationCandidate {
  name: string
  shortDescription?: string | null
  description?: string | null
  categoryStatus: string
  brandStatus?: string | null
  image?: string | null
  imageAlt?: string | null
  imageRightsOwner?: string | null
  imageRightsLicense?: string | null
  imageAuthorizedAt?: string | null
  variants: PublicationVariant[]
}

export interface PublicationIssue {
  code: string
  path: string
  message: string
}

export function validGtin(value: string) {
  if (!/^\d{8}$|^\d{12,14}$/.test(value)) return false
  const digits = [...value].map(Number)
  const check = digits.pop()!
  const sum = digits.reverse().reduce((total, digit, index) => total + digit * (index % 2 === 0 ? 3 : 1), 0)
  return (10 - (sum % 10)) % 10 === check
}

export function catalogPublicationIssues(candidate: PublicationCandidate): PublicationIssue[] {
  const issues: PublicationIssue[] = []
  const add = (code: string, path: string, message: string) => issues.push({ code, path, message })
  if (candidate.name.trim().length < 3) add('product.name', 'name', 'Falta un nombre válido')
  if ((candidate.shortDescription?.trim().length ?? 0) < 20) {
    add('product.short_description', 'shortDescription', 'La descripción corta debe tener al menos 20 caracteres')
  }
  if ((candidate.description?.trim().length ?? 0) < 40) {
    add('product.description', 'description', 'La descripción debe tener al menos 40 caracteres')
  }
  if (candidate.categoryStatus !== 'published') add('category.status', 'category', 'La categoría no está publicada')
  if (candidate.brandStatus !== 'published') add('brand.status', 'brand', 'La marca no está publicada')
  if (!candidate.image?.trim()) add('media.primary', 'image', 'Falta la imagen principal exacta del producto')
  if ((candidate.imageAlt?.trim().length ?? 0) < 5) add('media.alt', 'imageAlt', 'Falta un texto alternativo útil')
  if (!candidate.imageRightsOwner?.trim()) add('media.owner', 'imageRightsOwner', 'Falta el propietario de la imagen')
  if (!candidate.imageRightsLicense?.trim())
    add('media.license', 'imageRightsLicense', 'Falta la licencia o autorización')
  if (!candidate.imageAuthorizedAt || Number.isNaN(Date.parse(candidate.imageAuthorizedAt))) {
    add('media.authorization', 'imageAuthorizedAt', 'Falta la fecha de autorización de uso')
  }
  if (!candidate.variants.length) add('variant.missing', 'variants', 'Falta al menos una variante')
  const seenSkus = new Set<string>()
  candidate.variants.forEach((variant, index) => {
    const path = `variants.${index}`
    const sku = variant.sku.trim().toUpperCase()
    if (!/^[A-Z0-9][A-Z0-9._/-]{0,63}$/.test(sku)) add('variant.sku', `${path}.sku`, 'SKU inválido')
    if (seenSkus.has(sku)) add('variant.sku_duplicate', `${path}.sku`, 'SKU duplicado en el producto')
    seenSkus.add(sku)
    if (variant.ean && !validGtin(variant.ean)) add('variant.ean', `${path}.ean`, 'EAN con formato o control inválido')
    if (variant.gtin && !validGtin(variant.gtin))
      add('variant.gtin', `${path}.gtin`, 'GTIN con formato o control inválido')
    if (
      !variant.ean &&
      !variant.gtin &&
      !variant.mpn?.trim() &&
      (variant.identifierExceptionReason?.trim().length ?? 0) < 10
    ) {
      add(
        'variant.identifier',
        `${path}.identifierExceptionReason`,
        'Indica EAN/GTIN/MPN o documenta una excepción de al menos 10 caracteres'
      )
    }
    if (!Number.isSafeInteger(variant.priceCents) || variant.priceCents <= 0) {
      add('variant.price', `${path}.price`, 'Precio inválido')
    }
    if (!variant.unitBase.trim() || !variant.unitLabel.trim() || variant.contentQuantity <= 0) {
      add('variant.unit', `${path}.unit`, 'Unidad comercial incompleta')
    }
    if (variant.minimumQuantity <= 0 || variant.quantityIncrement <= 0) {
      add('variant.quantity', `${path}.minimumQuantity`, 'MOQ e incremento deben ser positivos')
    }
    if (variant.maximumQuantity != null && variant.maximumQuantity < variant.minimumQuantity) {
      add('variant.maximum', `${path}.maximumQuantity`, 'El máximo no puede ser menor que el mínimo')
    }
    if ([variant.weightGrams, variant.widthMm, variant.heightMm, variant.depthMm].some((value) => value <= 0)) {
      add('variant.logistics', `${path}.weightGrams`, 'Peso y dimensiones logísticas deben ser positivos')
    }
    if (variant.backorderAllowed && variant.leadTimeDays == null) {
      add('variant.lead_time', `${path}.leadTimeDays`, 'El backorder exige un plazo de entrega')
    }
  })
  return issues
}
