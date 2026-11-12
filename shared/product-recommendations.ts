import { z } from 'zod'
import type { ProductCardData } from './types/catalog'

/**
 * Franjas de recomendación de la tienda (ficha, carrito y portada).
 *
 * Cada franja dice de dónde sale (`basis`) y el título se elige con ese dato: «Los clientes que
 * vieron esto también vieron» solo aparece cuando hay co-visualización real; si la franja
 * viene de la misma familia o de lo más vendido, el título lo dice así. Nada de prueba social
 * inventada.
 */
export const RECOMMENDATION_STRIPS = ['bought_together', 'also_viewed', 'for_you', 'trending'] as const
export type RecommendationStripKind = (typeof RECOMMENDATION_STRIPS)[number]

export const RECOMMENDATION_BASES = [
  'co_purchase',
  'curated',
  'co_view',
  'category',
  'recent_views',
  'views',
  'bestsellers',
  'featured'
] as const
export type RecommendationBasis = (typeof RECOMMENDATION_BASES)[number]

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,179}$/)
const slugList = (max: number) =>
  z
    .string()
    .max(4000)
    .optional()
    .transform((value) => [...new Set((value ?? '').split(',').filter(Boolean))])
    .pipe(z.array(slug).max(max))

export const productRecommendationsQuerySchema = z
  .object({
    product: slug.optional(),
    cart: slugList(30),
    recent: slugList(12),
    strips: z
      .string()
      .max(200)
      .optional()
      .transform((value) => [...new Set((value ?? RECOMMENDATION_STRIPS.join(',')).split(',').filter(Boolean))])
      .pipe(z.array(z.enum(RECOMMENDATION_STRIPS)).min(1).max(4)),
    limit: z.coerce.number().int().min(1).max(12).default(8)
  })
  .strict()

export type ProductRecommendationsQuery = z.infer<typeof productRecommendationsQuerySchema>

export function parseProductRecommendationsQuery(params: URLSearchParams): ProductRecommendationsQuery | null {
  const raw: Record<string, string> = {}
  for (const [key, value] of params) {
    if (key in raw) return null
    raw[key] = value
  }
  const parsed = productRecommendationsQuerySchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

export interface RecommendationStrip {
  kind: RecommendationStripKind
  basis: RecommendationBasis
  items: ProductCardData[]
}

export interface ProductRecommendationsResponse {
  source: 'cloudflare'
  strips: RecommendationStrip[]
}

/** Título honesto según de dónde sale la franja. */
export function recommendationTitle(strip: Pick<RecommendationStrip, 'kind' | 'basis'>): string {
  switch (strip.kind) {
    case 'bought_together':
      return strip.basis === 'co_purchase' ? 'Comprados juntos frecuentemente' : 'Se suele pedir con'
    case 'also_viewed':
      return strip.basis === 'co_view'
        ? 'Los clientes que vieron esto también vieron'
        : strip.basis === 'curated'
          ? 'Alternativas a este producto'
          : 'Más productos de esta familia'
    case 'for_you':
      return strip.basis === 'recent_views' ? 'Recomendado para ti' : 'Lo más pedido'
    case 'trending':
      return strip.basis === 'views'
        ? 'Tendencias esta semana'
        : strip.basis === 'bestsellers'
          ? 'Lo más pedido este mes'
          : 'Destacados'
  }
}

/** Línea de contexto bajo el título, solo cuando aporta. */
export function recommendationSubtitle(strip: Pick<RecommendationStrip, 'kind' | 'basis'>): string {
  if (strip.kind === 'for_you' && strip.basis === 'recent_views') return 'Según los productos que has visto.'
  if (strip.kind === 'bought_together' && strip.basis === 'co_purchase')
    return 'Otros clientes los pidieron en el mismo pedido.'
  return ''
}
