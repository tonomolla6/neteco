import { useDatabase } from '../db/client'

function xml(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

export default defineEventHandler(async (event) => {
  const runtime = useRuntimeConfig(event)
  const origin = String(runtime.public.baseUrl).replace(/\/$/, '')
  const sql = useDatabase()
  const entries = await sql<{ path: string; updatedAt: Date }[]>`
    SELECT ${'/producto/'} || slug AS path, updated_at AS "updatedAt"
    FROM products WHERE status = 'published'
    UNION ALL
    SELECT ${'/categoria/'} || slug AS path, updated_at AS "updatedAt"
    FROM categories WHERE status = 'published'
    ORDER BY path
  `
  const fixed = [
    { path: '/', updatedAt: null },
    { path: '/catalogo', updatedAt: null },
    { path: '/envios', updatedAt: null },
    { path: '/formas-de-pago', updatedAt: null },
    { path: '/devoluciones', updatedAt: null },
    { path: '/ayuda', updatedAt: null },
    { path: '/accesibilidad', updatedAt: null },
    { path: '/contacto', updatedAt: null }
  ]
  const urls = [...fixed, ...entries]
    .map(
      (entry) =>
        `<url><loc>${xml(`${origin}${entry.path}`)}</loc>${entry.updatedAt ? `<lastmod>${entry.updatedAt.toISOString()}</lastmod>` : ''}</url>`
    )
    .join('')
  setHeader(event, 'content-type', 'application/xml; charset=utf-8')
  setHeader(event, 'cache-control', 'public, max-age=3600')
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`
})
