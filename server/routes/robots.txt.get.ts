import { PRIVATE_ROBOTS_PREFIXES } from '../utils/robots'

export default defineEventHandler((event) => {
  const runtime = useRuntimeConfig(event)
  const origin = String(runtime.public.baseUrl).replace(/\/$/, '')
  setHeader(event, 'content-type', 'text/plain; charset=utf-8')
  setHeader(event, 'cache-control', 'public, max-age=3600')
  return [
    `User-agent: *`,
    `Allow: /`,
    ...PRIVATE_ROBOTS_PREFIXES.map((path) => `Disallow: ${path}`),
    `Disallow: /api`,
    `Sitemap: ${origin}/sitemap.xml`,
    ``
  ].join('\n')
})
