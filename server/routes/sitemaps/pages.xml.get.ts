import { parsePublishedSections } from '../../../shared/published-sections'

function xml(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

export default defineEventHandler((event) => {
  const runtime = useRuntimeConfig(event)
  const origin = String(runtime.public.baseUrl).replace(/\/$/, '')
  const paths = [
    '/',
    '/catalogo',
    '/pedido-rapido',
    '/envios',
    '/formas-de-pago',
    '/devoluciones',
    '/ayuda',
    '/accesibilidad',
    '/contacto',
    ...parsePublishedSections(runtime.public.publishedSections).map((section) => `/${section}`)
  ]
  const urls = paths.map((path) => `<url><loc>${xml(`${origin}${path}`)}</loc></url>`).join('')
  setHeader(event, 'content-type', 'application/xml; charset=utf-8')
  setHeader(event, 'cache-control', 'public, max-age=3600')
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`
})
