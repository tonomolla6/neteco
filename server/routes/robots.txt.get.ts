export default defineEventHandler((event) => {
  const runtime = useRuntimeConfig(event)
  const origin = String(runtime.public.baseUrl).replace(/\/$/, '')
  setHeader(event, 'content-type', 'text/plain; charset=utf-8')
  setHeader(event, 'cache-control', 'public, max-age=3600')
  return [
    `User-agent: *`,
    `Allow: /`,
    `Disallow: /admin`,
    `Disallow: /cuenta`,
    `Disallow: /checkout`,
    `Disallow: /pedido`,
    `Disallow: /buscar`,
    `Sitemap: ${origin}/sitemap.xml`,
    ``
  ].join('\n')
})
