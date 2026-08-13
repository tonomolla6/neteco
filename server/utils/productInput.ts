import { z } from 'zod'
import { catalogPublicationIssues } from '../domain/catalog-publication'

// Validación compartida del alta/edición de productos del backoffice.
// Los precios llegan en euros (IVA incluido) y se guardan en céntimos.
const optionalIdentifier = z.string().trim().max(64).optional().nullable()
const imagePath = z
  .string()
  .trim()
  .regex(
    /^(?:\/img\/products\/[a-zA-Z0-9_./-]+|\/media\/[0-9a-f]{8}-[0-9a-f-]{27})$/i,
    'La ruta de imagen no es válida'
  )
  .optional()
  .nullable()

export const productInput = z
  .object({
    name: z.string().trim().min(3, 'El nombre es demasiado corto'),
    brand: z.string().trim().optional().nullable(),
    categoryId: z.number().int().positive('Elige una familia'),
    shortDesc: z.string().trim().min(5, 'Falta la descripción corta'),
    description: z.string().trim().min(5, 'Falta la descripción'),
    usage: z.string().trim().optional().nullable(),
    badges: z.array(z.enum(['eco', 'alimentaria', 'concentrado'])).default([]),
    visual: z.object({
      type: z.string().min(1),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Color inválido')
    }),
    featured: z.boolean().default(false),
    active: z.boolean().default(false),
    image: imagePath,
    imageAlt: z.string().trim().max(240).optional().nullable(),
    imageRightsOwner: z.string().trim().max(200).optional().nullable(),
    imageRightsLicense: z.string().trim().max(200).optional().nullable(),
    imageAuthorizedAt: z.string().date().optional().nullable(),
    series: z.string().trim().optional().nullable(),
    // características técnicas ordenadas (Material, Gramaje, EAN…); el orden del array es el de la ficha
    attrs: z
      .array(
        z
          .object({
            k: z.string().trim().min(1, 'Hay una característica sin nombre'),
            v: z.string().trim().min(1, 'Hay una característica sin valor')
          })
          .strict()
      )
      .default([]),
    variants: z
      .array(
        z
          .object({
            id: z.number().int().optional(),
            format: z.string().trim().min(1, 'Hay un formato sin nombre'),
            sku: z
              .string()
              .trim()
              .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/)
              .optional()
              .nullable(),
            ean: optionalIdentifier,
            gtin: optionalIdentifier,
            mpn: optionalIdentifier,
            identifierExceptionReason: z.string().trim().max(500).optional().nullable(),
            price: z.number().positive('Hay una variante sin precio válido'),
            stock: z.number().int().min(0).default(100),
            unitBase: z.string().trim().min(1).max(40).default('unit'),
            unitLabel: z.string().trim().min(1).max(80).default('unidad'),
            contentQuantity: z.number().positive().default(1),
            unitsPerCase: z.number().int().positive().default(1),
            casesPerPallet: z.number().int().positive().optional().nullable(),
            minimumQuantity: z.number().int().positive().default(1),
            quantityIncrement: z.number().int().positive().default(1),
            maximumQuantity: z.number().int().positive().optional().nullable(),
            weightGrams: z.number().int().nonnegative().default(0),
            widthMm: z.number().int().nonnegative().default(0),
            heightMm: z.number().int().nonnegative().default(0),
            depthMm: z.number().int().nonnegative().default(0),
            safetyStock: z.number().int().nonnegative().default(0),
            backorderAllowed: z.boolean().default(false),
            leadTimeDays: z.number().int().nonnegative().optional().nullable(),
            color: z
              .string()
              .regex(/^#[0-9a-fA-F]{6}$/, 'Color de variante inválido (usa #rrggbb)')
              .optional()
              .nullable(),
            image: imagePath
          })
          .strict()
      )
      .min(1, 'El producto necesita al menos una variante')
  })
  .strict()
  .superRefine((input, context) => {
    if (!input.active) return
    const issues = catalogPublicationIssues({
      name: input.name,
      shortDescription: input.shortDesc,
      description: input.description,
      categoryStatus: 'published',
      brandStatus: 'published',
      image: input.image,
      imageAlt: input.imageAlt,
      imageRightsOwner: input.imageRightsOwner,
      imageRightsLicense: input.imageRightsLicense,
      imageAuthorizedAt: input.imageAuthorizedAt,
      variants: input.variants.map((variant) => ({
        ...variant,
        sku: variant.sku ?? '',
        priceCents: Math.round(variant.price * 100)
      }))
    })
    for (const issue of issues) {
      context.addIssue({ code: 'custom', path: issue.path.split('.'), message: issue.message })
    }
  })

export type ProductInput = z.infer<typeof productInput>
