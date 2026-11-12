import { z } from 'zod'

/**
 * «¿Cuándo me llega?» con el código postal y nada más.
 *
 * En España las dos primeras cifras del código postal identifican la provincia (01-52).
 * Con eso basta para cotizar una fecha estimada; la dirección completa se pide al pagar.
 */
const PROVINCES = [
  'Álava',
  'Albacete',
  'Alicante',
  'Almería',
  'Ávila',
  'Badajoz',
  'Illes Balears',
  'Barcelona',
  'Burgos',
  'Cáceres',
  'Cádiz',
  'Castellón',
  'Ciudad Real',
  'Córdoba',
  'A Coruña',
  'Cuenca',
  'Girona',
  'Granada',
  'Guadalajara',
  'Gipuzkoa',
  'Huelva',
  'Huesca',
  'Jaén',
  'León',
  'Lleida',
  'La Rioja',
  'Lugo',
  'Madrid',
  'Málaga',
  'Murcia',
  'Navarra',
  'Ourense',
  'Asturias',
  'Palencia',
  'Las Palmas',
  'Pontevedra',
  'Salamanca',
  'Santa Cruz de Tenerife',
  'Cantabria',
  'Segovia',
  'Sevilla',
  'Soria',
  'Tarragona',
  'Teruel',
  'Toledo',
  'Valencia',
  'Valladolid',
  'Bizkaia',
  'Zamora',
  'Zaragoza',
  'Ceuta',
  'Melilla'
] as const

export function provinceForPostalCode(postalCode: string): string | null {
  const value = postalCode.trim()
  if (!/^\d{5}$/.test(value)) return null
  return PROVINCES[Number(value.slice(0, 2)) - 1] ?? null
}

/** Petición de la ficha: la población es opcional y, si falta, se usa la provincia. */
export const productDeliveryRequestSchema = z
  .object({
    variantId: z.string().uuid(),
    quantity: z.number().int().positive().max(10_000),
    postalCode: z
      .string()
      .trim()
      .regex(/^\d{5}$/)
      .refine((value) => provinceForPostalCode(value) !== null, 'Código postal desconocido'),
    city: z.string().trim().min(2).max(120).optional()
  })
  .strict()
  .transform((input) => {
    const region = provinceForPostalCode(input.postalCode)!
    return { ...input, city: input.city ?? region, region }
  })
