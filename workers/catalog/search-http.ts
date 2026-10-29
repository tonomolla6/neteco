import { isValidPublicSearchQuery, searchPublishedProducts } from './search'

function json(value: unknown, status = 200) {
  return Response.json(value, {
    status,
    headers: {
      // Governed media metadata must expire/revoke alongside its byte gate.
      'Cache-Control': status === 200 ? 'private, no-store' : 'no-store',
      'CDN-Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...(status === 405 ? { Allow: 'GET' } : {})
    }
  })
}

export async function handlePublicSearchHttp(
  request: Request,
  dependencies: { database: D1Database }
): Promise<Response | null> {
  const url = new URL(request.url)
  if (url.pathname !== '/api/search') return null
  if (request.method !== 'GET') return json({ error: { code: 'method_not_allowed' } }, 405)
  const queries = url.searchParams.getAll('q')
  const query = queries[0] ?? ''
  if (queries.length > 1 || !isValidPublicSearchQuery(query)) {
    return json({ error: { code: 'invalid_query' } }, 400)
  }
  try {
    return json(await searchPublishedProducts(dependencies.database, query))
  } catch {
    return json({ error: { code: 'internal' } }, 500)
  }
}
