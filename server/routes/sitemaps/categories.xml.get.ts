import { useDatabase } from '../../db/client'

function xml(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

export default defineEventHandler(async (event) => {
  const runtime = useRuntimeConfig(event)
  const origin = String(runtime.public.baseUrl).replace(/\/$/, '')
  const sql = useDatabase()
  const entries = await sql<{ slug: string; updatedAt: Date }[]>`
    SELECT slug, updated_at AS "updatedAt" FROM categories
    WHERE status = 'published' ORDER BY slug
  `
  const urls = entries
    .map(
      (entry) =>
        `<url><loc>${xml(`${origin}/categoria/${entry.slug}`)}</loc><lastmod>${entry.updatedAt.toISOString()}</lastmod></url>`
    )
    .join('')
  setHeader(event, 'content-type', 'application/xml; charset=utf-8')
  setHeader(event, 'cache-control', 'public, max-age=3600')
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`
})
