import { z } from 'zod'

// Validación compartida del alta/edición de productos del backoffice.
// Los precios llegan en euros (IVA incluido) y se guardan en céntimos.
export const productInput = z.object({
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
  active: z.boolean().default(true),
  series: z.string().trim().optional().nullable(),
  // características técnicas ordenadas (Material, Gramaje, EAN…); el orden del array es el de la ficha
  attrs: z
    .array(
      z.object({
        k: z.string().trim().min(1, 'Hay una característica sin nombre'),
        v: z.string().trim().min(1, 'Hay una característica sin valor')
      })
    )
    .default([]),
  variants: z
    .array(
      z.object({
        id: z.number().int().optional(),
        format: z.string().trim().min(1, 'Hay un formato sin nombre'),
        sku: z.string().trim().optional().nullable(),
        price: z.number().positive('Hay una variante sin precio válido'),
        stock: z.number().int().min(0).default(100),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Color de variante inválido (usa #rrggbb)').optional().nullable(),
        image: z.string().trim().optional().nullable()
      })
    )
    .min(1, 'El producto necesita al menos una variante')
})

export type ProductInput = z.infer<typeof productInput>
