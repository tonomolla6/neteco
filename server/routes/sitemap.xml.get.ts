function xml(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

export default defineEventHandler((event) => {
  const runtime = useRuntimeConfig(event)
  const origin = String(runtime.public.baseUrl).replace(/\/$/, '')
  const sitemaps = ['pages', 'categories', 'products']
    .map((name) => `<sitemap><loc>${xml(`${origin}/sitemaps/${name}.xml`)}</loc></sitemap>`)
    .join('')
  setHeader(event, 'content-type', 'application/xml; charset=utf-8')
  setHeader(event, 'cache-control', 'public, max-age=3600')
  return `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${sitemaps}</sitemapindex>`
})
