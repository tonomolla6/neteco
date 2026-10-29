import { getProductsComparison, InvalidCompareRequestError, CompareProductNotFoundError } from './product-compare'
import type { EffectivePricingOptions } from './pricing'

export interface ProductCompareHttpEnvironment {
  database: D1Database
  pricingOptions?: EffectivePricingOptions
}

export function ownsProductCompareNamespace(pathname: string): boolean {
  return pathname === '/api/products/compare' || pathname === '/api/products/compare/'
}

export async function handleProductCompareHttp(
  request: Request,
  env: ProductCompareHttpEnvironment
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsProductCompareNamespace(url.pathname)) {
    return null
  }

  if (request.method !== 'GET') {
    return Response.json(
      { error: { code: 'method_not_allowed' } },
      {
        status: 405,
        headers: {
          allow: 'GET',
          'cache-control': 'private, no-store'
        }
      }
    )
  }

  const rawSlugs = url.searchParams.get('slugs')
  if (!rawSlugs) {
    return Response.json(
      { error: { code: 'invalid_compare_request' } },
      {
        status: 400,
        headers: {
          'cache-control': 'private, no-store'
        }
      }
    )
  }

  try {
    const comparison = await getProductsComparison(env.database, rawSlugs, env.pricingOptions)
    return Response.json(comparison, {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'public, max-age=60, stale-while-revalidate=300'
      }
    })
  } catch (error) {
    if (error instanceof InvalidCompareRequestError) {
      return Response.json(
        { error: { code: 'invalid_compare_request' } },
        {
          status: 400,
          headers: {
            'cache-control': 'private, no-store'
          }
        }
      )
    }

    if (error instanceof CompareProductNotFoundError) {
      return Response.json(
        { error: { code: 'product_not_found' } },
        {
          status: 404,
          headers: {
            'cache-control': 'private, no-store'
          }
        }
      )
    }

    return Response.json(
      { error: { code: 'catalog_unavailable' } },
      {
        status: 503,
        headers: {
          'cache-control': 'private, no-store'
        }
      }
    )
  }
}
