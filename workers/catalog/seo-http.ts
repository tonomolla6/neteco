import { NOINDEX_HEADER } from '../../server/utils/robots'
import { publicationValidityExpression, assertCurrentPublicationValidity } from './publication-validity'
import { z } from 'zod'
import { catalogPolicyInstantSchema, catalogPolicyUuidSchema } from '../../shared/catalog-publication-policy'
import { readThinLandingSlugs } from '../content/resource-hub'
import { cmsPublishedValiditySql, cmsSource, type CmsPublicationDependencies } from '../cms/publication-gate'

export interface D1SeoDependencies {
  database: D1Database
  origin: string
  environment: 'local' | 'preprod' | 'production'
  now?: string
  /** Opt-in only: absent/disabled preserves the existing five-route contract. */
  cmsPublication?: Omit<CmsPublicationDependencies, 'database'>
}

const PAGE_SIZE = 1000
const MAX_SITEMAP_ENTRIES = 50_000
const MAX_SITEMAP_BYTES = 50_000_000
const ROUTES = new Set([
  '/robots.txt',
  '/sitemap.xml',
  '/sitemaps/pages.xml',
  '/sitemaps/categories.xml',
  '/sitemaps/products.xml'
])
/** Resolve ownership before applying SEO-specific environment authority. */
export function ownsD1SeoNamespace(path: string, cmsEnabled = false) {
  return ROUTES.has(path) || (cmsEnabled === true && path === '/sitemaps/content.xml')
}
// Same useful, existing static pages as server/routes/sitemaps/pages.xml.get.ts.
// Dynamic CMS pages have a separate, opt-in shard. Private UI routes never do.
const STATIC_PAGES = [
  '/',
  '/catalogo',
  '/envios',
  '/formas-de-pago',
  '/devoluciones',
  '/ayuda',
  '/accesibilidad',
  '/contacto'
]
const PRIVATE_PATHS = [
  '/admin',
  '/cuenta',
  '/carrito',
  '/checkout',
  '/pedido',
  '/pedidos',
  '/auth',
  '/login',
  '/registro',
  '/recuperar-clave',
  '/restablecer-clave',
  '/verificar-email',
  '/buscar',
  '/newsletter',
  '/api'
]

// Preserve the public category API's ancestor-publication rule. A published
// child below a hidden/draft parent is not a discoverable category page.
const CATEGORY_CTE = `WITH RECURSIVE published_categories AS (
  SELECT id, legacy_id, slug, updated_at FROM categories WHERE parent_id IS NULL AND status = 'published'
  UNION ALL
  SELECT child.id, child.legacy_id, child.slug, child.updated_at FROM categories child
  JOIN published_categories parent ON parent.id = child.parent_id WHERE child.status = 'published'
)`
// Traverse unmapped published ancestors: the category API promotes a mapped
// descendant to a root when its parent's legacy_id is null. Only emitted rows
// must have a stable public ID; null IDs collide in that API's legacy-keyed Map.
const CATEGORY_COUNT = `${CATEGORY_CTE} SELECT count(*) AS total FROM published_categories WHERE legacy_id IS NOT NULL`
// Match the current product detail contract, including usable legacy mappings:
// a list-only product with no public detail/variant must not become a dead URL.
// The HTTP slug is [a-z0-9][a-z0-9-]{0,179}; SQLite GLOB/length ignore text
// after NUL, so reject NUL separately instead of accepting an unservable suffix.
const PRODUCT_FROM = `FROM products p
  JOIN categories c ON c.id = p.category_id AND c.status = 'published' AND c.legacy_id IS NOT NULL
  WHERE p.status = 'published' AND p.legacy_id IS NOT NULL
    AND ${publicationValidityExpression('p')}
    AND length(p.slug) BETWEEN 1 AND 180
    AND p.slug GLOB '[a-z0-9]*' AND p.slug NOT GLOB '*[^a-z0-9-]*'
    AND instr(p.slug, char(0)) = 0
    AND EXISTS (SELECT 1 FROM variants v WHERE v.product_id = p.id AND v.status = 'published' AND v.legacy_id IS NOT NULL)`

const CMS_CLOCK = "COALESCE(?1,strftime('%Y-%m-%dT%H:%M:%SZ','now'))"
function cmsFrom(deps: D1SeoDependencies, thinLandings: readonly string[] = []) {
  return `FROM content_publications release
 JOIN content_publication_states head ON head.page_id=release.page_id
 JOIN content_versions version ON version.id=release.version_id AND version.page_id=release.page_id
 WHERE ${cmsPublishedValiditySql('release', 'head', CMS_CLOCK)}
 AND json_type(version.document,'$.seo.noindex')='false'
 ${thinLandings.length ? `AND release.slug NOT IN (${thinLandings.map((slug) => `'${slug}'`).join(',')})` : ''}
 AND (json_type(version.document,'$.resourceHub') IS NULL
   OR json_type(version.document,'$.resourceHub')='null'
   OR (json_type(version.document,'$.resourceHub')='object'
     AND json_type(version.document,'$.resourceHub.reviewedAt')='text'
     AND json_type(version.document,'$.resourceHub.reviewDueAt')='text'
     AND julianday(json_extract(version.document,'$.resourceHub.reviewedAt'))<=julianday(${CMS_CLOCK})
     AND julianday(json_extract(version.document,'$.resourceHub.reviewDueAt'))>julianday(${CMS_CLOCK})))
 ${deps.cmsPublication?.bucket && deps.cmsPublication.images ? '' : "AND NOT EXISTS(SELECT 1 FROM json_each(version.document,'$.blocks') block WHERE json_extract(block.value,'$.type')='image')"}`
}
const cmsEntrySchema = z
  .object({
    uuid: catalogPolicyUuidSchema,
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,159}$/),
    updatedAt: catalogPolicyInstantSchema,
    canonicalType: z.enum(['contenido', 'recursos']).optional()
  })
  .strict()
function cmsClock(deps: D1SeoDependencies) {
  const value = deps.cmsPublication?.now?.() ?? deps.now
  if (value === undefined) return null
  const instant = canonicalInstant(value)
  if (instant === null) throw new Error('invalid_cms_seo_clock')
  return new Date(instant).toISOString().slice(0, 19) + 'Z'
}

interface SeoEntry {
  slug: string
  updatedAt: string
  uuid?: string
  canonicalType?: 'contenido' | 'recursos'
}
interface SeoCount {
  total: number
}

function xml(value: string) {
  // Existing sitemap serializer, with apostrophes escaped as well.
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function canonicalInstant(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return null
  const instant = Date.parse(value)
  if (!Number.isFinite(instant)) return null
  const canonical = new Date(instant).toISOString()
  return (value.includes('.') ? canonical : canonical.replace('.000Z', 'Z')) === value ? instant : null
}

function configuration(deps: D1SeoDependencies) {
  if (!['local', 'preprod', 'production'].includes(deps.environment) || typeof deps.origin !== 'string') return null
  try {
    const origin = new URL(deps.origin)
    if (origin.protocol !== 'https:' || origin.origin !== deps.origin || deps.origin.length > 2000) return null
    if (
      deps.environment === 'production' &&
      (origin.hostname === 'localhost' ||
        origin.hostname.endsWith('.invalid') ||
        origin.hostname.endsWith('.localhost'))
    )
      return null
    const now = deps.now === undefined ? Date.now() : canonicalInstant(deps.now)
    return now === null ? null : { origin: origin.origin, now, production: deps.environment === 'production' }
  } catch {
    return null
  }
}

function response(request: Request, body: string, status: number, headers: Record<string, string>) {
  return new Response(request.method === 'HEAD' ? null : body, { status, headers })
}

function error(request: Request, code: string, status: number, extra: Record<string, string> = {}) {
  return response(request, JSON.stringify({ error: { code } }), status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-robots-tag': NOINDEX_HEADER,
    ...extra
  })
}

function sitemap(body: string, root: 'urlset' | 'sitemapindex') {
  const rendered = `<?xml version="1.0" encoding="UTF-8"?><${root} xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${body}</${root}>`
  if (new TextEncoder().encode(rendered).byteLength > MAX_SITEMAP_BYTES) throw new Error('sitemap_too_large')
  return rendered
}

function location(origin: string, path: string) {
  const value = `${origin}${path}`
  if (value.length > 2048) throw new Error('sitemap_location_too_long')
  return xml(value)
}

function urlEntry(
  origin: string,
  type: 'producto' | 'categoria' | 'contenido' | 'recursos',
  entry: SeoEntry,
  now: number
) {
  if (!entry.slug || entry.slug === '.' || entry.slug === '..') throw new Error('invalid_public_slug')
  const loc = location(origin, `/${type}/${encodeURIComponent(entry.slug)}`)
  const modified = typeof entry.updatedAt === 'string' ? canonicalInstant(entry.updatedAt) : null
  // Never fabricate a modification date, turn SQLite defaults into a timezone
  // assertion, or advertise a future timestamp as an already-published change.
  const lastmod = modified !== null && modified <= now ? `<lastmod>${xml(entry.updatedAt)}</lastmod>` : ''
  return `<url><loc>${loc}</loc>${lastmod}</url>`
}

function count(results: Array<SeoCount | SeoEntry> | undefined) {
  const row = results?.[0] as SeoCount | undefined
  if (!row || !Number.isSafeInteger(row.total) || row.total < 0) throw new Error('invalid_seo_count')
  return row.total
}

function pageCount(total: number) {
  return Math.max(1, Math.ceil(total / PAGE_SIZE))
}

export async function handleD1SeoRequest(request: Request, deps: D1SeoDependencies): Promise<Response | null> {
  const url = new URL(request.url)
  const cmsEnabled = deps.cmsPublication?.enabled === true,
    content = cmsEnabled && url.pathname === '/sitemaps/content.xml'
  if (!ownsD1SeoNamespace(url.pathname, cmsEnabled)) return null
  if (request.method !== 'GET' && request.method !== 'HEAD')
    return error(request, 'method_not_allowed', 405, { allow: 'GET, HEAD' })
  const config = configuration(deps)
  if (!config) return error(request, 'service_unavailable', 503)
  const paginated = content || url.pathname === '/sitemaps/categories.xml' || url.pathname === '/sitemaps/products.xml'
  const query = [...url.searchParams.keys()]
  if (query.some((key) => key !== 'page') || query.length > 1 || (!paginated && query.length))
    return error(request, 'invalid_query', 400)
  const rawPage = url.searchParams.get('page')
  if (rawPage !== null && (!/^[1-9]\d{0,4}$/.test(rawPage) || Number(rawPage) > MAX_SITEMAP_ENTRIES))
    return error(request, 'invalid_query', 400)
  const page = rawPage === null ? 1 : Number(rawPage)
  const headers: Record<string, string> = {
    'content-type': url.pathname === '/robots.txt' ? 'text/plain; charset=utf-8' : 'application/xml; charset=utf-8',
    'cache-control':
      config.production && (url.pathname === '/robots.txt' || url.pathname === '/sitemaps/pages.xml')
        ? 'public, max-age=300'
        : 'private, no-store',
    'cdn-cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  }
  if (!config.production) headers['x-robots-tag'] = NOINDEX_HEADER
  try {
    let body: string
    // SEO-028: thin / duplicate landings are noindex, so they must not be advertised. Slugs are validated before inlining.
    const thin =
      cmsEnabled && (content || url.pathname === '/sitemap.xml')
        ? (await readThinLandingSlugs(deps.cmsPublication!)).filter((slug) => /^[a-z0-9][a-z0-9-]{0,159}$/.test(slug))
        : []
    if (url.pathname === '/robots.txt') {
      body = config.production
        ? [
            'User-agent: *',
            'Allow: /',
            ...PRIVATE_PATHS.map((path) => `Disallow: ${path}`),
            `Sitemap: ${config.origin}/sitemap.xml`,
            ''
          ].join('\n')
        : 'User-agent: *\nDisallow: /\n'
    } else if (url.pathname === '/sitemaps/pages.xml') {
      body = sitemap(
        STATIC_PAGES.map((path) => `<url><loc>${location(config.origin, path)}</loc></url>`).join(''),
        'urlset'
      )
    } else if (url.pathname === '/sitemap.xml') {
      const statements = [
        deps.database.prepare(CATEGORY_COUNT),
        deps.database.prepare(`SELECT count(*) AS total ${PRODUCT_FROM}`)
      ]
      if (cmsEnabled)
        statements.push(deps.database.prepare(`SELECT count(*) AS total ${cmsFrom(deps, thin)}`).bind(cmsClock(deps)))
      const counts = await deps.database.batch<SeoCount>(statements)
      if (cmsEnabled && (counts.length !== 3 || counts.some((result) => result.success !== true)))
        throw new Error('cms_seo_read_unconfirmed')
      const categories = pageCount(count(counts[0]?.results))
      const products = pageCount(count(counts[1]?.results))
      const cmsPages = cmsEnabled ? pageCount(count(counts[2]?.results)) : 0
      if (categories + products + cmsPages + 1 > MAX_SITEMAP_ENTRIES) throw new Error('sitemap_index_too_large')
      const paths = ['/sitemaps/pages.xml']
      for (const [name, pages] of [
        ['categories', categories],
        ['products', products],
        ['content', cmsPages]
      ] as const) {
        for (let number = 1; number <= pages; number++)
          paths.push(`/sitemaps/${name}.xml${number === 1 ? '' : `?page=${number}`}`)
      }
      body = sitemap(
        paths.map((path) => `<sitemap><loc>${location(config.origin, path)}</loc></sitemap>`).join(''),
        'sitemapindex'
      )
    } else {
      const categories = url.pathname === '/sitemaps/categories.xml'
      const countSql = content
        ? `SELECT count(*) AS total ${cmsFrom(deps, thin)}`
        : categories
          ? CATEGORY_COUNT
          : `SELECT count(*) AS total ${PRODUCT_FROM}`
      const rowsSql = content
        ? `SELECT release.id AS uuid,release.slug,release.published_at AS updatedAt,
 CASE WHEN json_type(version.document,'$.resourceHub')='object' THEN 'recursos' ELSE 'contenido' END AS canonicalType
 ${cmsFrom(deps, thin)} ORDER BY release.slug,release.id LIMIT ?2 OFFSET ?3`
        : categories
          ? `${CATEGORY_CTE} SELECT slug, updated_at AS updatedAt FROM published_categories WHERE legacy_id IS NOT NULL ORDER BY slug LIMIT ? OFFSET ?`
          : `SELECT p.id AS uuid, p.slug, p.updated_at AS updatedAt ${PRODUCT_FROM} ORDER BY p.slug LIMIT ? OFFSET ?`
      // Count and bounded slice observe the same D1 batch snapshot. No per-row
      // queries, private IDs, request cookies or caller-controlled SQL fragments.
      const instant = content ? cmsClock(deps) : null
      const results = await deps.database.batch<SeoCount | SeoEntry>(
        content
          ? [
              deps.database.prepare(countSql).bind(instant),
              deps.database.prepare(rowsSql).bind(instant, PAGE_SIZE, (page - 1) * PAGE_SIZE)
            ]
          : [deps.database.prepare(countSql), deps.database.prepare(rowsSql).bind(PAGE_SIZE, (page - 1) * PAGE_SIZE)]
      )
      if (content && (results.length !== 2 || results.some((result) => result.success !== true)))
        throw new Error('cms_seo_read_unconfirmed')
      const total = count(results[0]?.results)
      if (pageCount(total) > MAX_SITEMAP_ENTRIES) throw new Error('sitemap_dataset_too_large')
      if (page > pageCount(total)) return error(request, 'not_found', 404)
      const entries = content
        ? cmsSource(z.array(cmsEntrySchema).max(PAGE_SIZE), results[1]?.results)
        : ((results[1]?.results ?? []) as SeoEntry[])
      if (entries.length !== Math.min(PAGE_SIZE, Math.max(0, total - (page - 1) * PAGE_SIZE)))
        throw new Error('inconsistent_seo_page')
      if (content && entries.length) {
        // A withdrawal or media verdict changed while the snapshot resolved:
        // fail closed, never emit a partial page with stale discovery totals.
        const current = await deps.database
          .prepare(
            `SELECT count(*) AS total ${cmsFrom(deps, thin)}
 AND EXISTS(SELECT 1 FROM json_each(?2) item WHERE json_extract(item.value,'$.uuid')=release.id
 AND json_extract(item.value,'$.slug')=release.slug AND json_extract(item.value,'$.updatedAt')=release.published_at
 AND json_extract(item.value,'$.canonicalType')=CASE WHEN json_type(version.document,'$.resourceHub')='object' THEN 'recursos' ELSE 'contenido' END)`
          )
          .bind(cmsClock(deps), JSON.stringify(entries))
          .first<SeoCount>()
        if (count(current === null ? undefined : [current]) !== entries.length)
          throw new Error('cms_publication_validity_changed')
      } else if (!categories && !content) {
        const ids = entries.map((entry) => entry.uuid)
        if (ids.some((id) => typeof id !== 'string')) throw new Error('invalid_seo_product_identity')
        await assertCurrentPublicationValidity(
          deps.database,
          ids.filter((id): id is string => typeof id === 'string')
        )
      }
      body = sitemap(
        entries
          .map((entry) =>
            urlEntry(
              config.origin,
              content ? (entry.canonicalType ?? 'contenido') : categories ? 'categoria' : 'producto',
              entry,
              config.now
            )
          )
          .join(''),
        'urlset'
      )
    }
    return response(request, body, 200, headers)
  } catch {
    return error(request, 'service_unavailable', 503)
  }
}
