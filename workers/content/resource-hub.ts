import { z } from 'zod'
import { cmsNow, cmsPublishedValiditySql, type CmsPublicationDependencies } from '../cms/publication-gate'
import { readCmsPublicPage } from '../cms/public-http'
import { cmsDocumentSchema } from '../../shared/cms-commands'
import {
  resourceHubDetailSchema,
  resourceHubListSchema,
  resourceHubQuerySchema,
  resourceHubSummarySchema,
  type ResourceHubList
} from '../../shared/resource-hub'
import { publicationValidityExpression } from '../catalog/publication-validity'
import { evaluateLandingSet, type LandingVerdict } from '../../shared/landing-quality'
export class ResourceHubError extends Error {
  constructor(readonly code: 'invalid_input' | 'not_found' | 'content_unavailable' | 'limit_exceeded') {
    super(code)
  }
}
function fail(code: ResourceHubError['code']): never {
  throw new ResourceHubError(code)
}
const publicationRowSchema = z
  .object({
    id: z.string(),
    page_id: z.string(),
    version_id: z.string(),
    slug: z.string(),
    published_at: z.string(),
    document: z.string()
  })
  .strict()
const productRowSchema = z
  .object({ id: z.number().int().positive(), name: z.string(), slug: z.string().regex(/^[a-z0-9-]+$/) })
  .strict()
const categoryRowSchema = z.object({ slug: z.string().regex(/^[a-z0-9-]+$/), name: z.string() }).strict()
async function guarded<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof ResourceHubError) throw error
    return fail('content_unavailable')
  }
}
async function snapshot(deps: CmsPublicationDependencies, extras: D1PreparedStatement[] = []) {
  if (!deps.enabled) fail('not_found')
  const now = cmsNow(deps)
  const results = await deps.database.batch([
    deps.database
      .prepare(
        `SELECT r.id,r.page_id,r.version_id,r.slug,r.published_at,v.document
    FROM content_publications r JOIN content_publication_states h ON h.page_id=r.page_id
    JOIN content_versions v ON v.id=r.version_id AND v.page_id=r.page_id
    WHERE ${cmsPublishedValiditySql('r', 'h', '?1')} AND json_type(v.document,'$.resourceHub')='object'
    ORDER BY r.published_at DESC,r.id DESC LIMIT 1001`
      )
      .bind(now),
    ...extras
  ])
  if (results.some((result) => !result.success)) fail('content_unavailable')
  const result = results[0]!
  if (!result.success) fail('content_unavailable')
  if (result.results.length > 1000 || new TextEncoder().encode(JSON.stringify(result.results)).length > 2 * 1024 * 1024)
    fail('limit_exceeded')
  const rows = result.results
    .map((raw) => {
      const row = publicationRowSchema.parse(raw)
      const doc = cmsDocumentSchema.parse(JSON.parse(String(row.document))),
        editorial = doc.resourceHub
      if (!editorial || doc.slug !== row.slug) fail('content_unavailable')
      return { row, doc, editorial }
    })
    .filter(({ editorial }) => editorial.reviewedAt <= now && editorial.reviewDueAt > now)
  const verdicts = await landingVerdicts(deps.database, rows)
  const items = rows.map((item) => ({ ...item, landing: verdicts.get(item.doc.slug) ?? null }))
  return { items, links: results.slice(1).map((result) => result.results) }
}
/** SEO-028: offer is counted from live published products, never from what the editor declares. */
async function landingVerdicts(
  database: D1Database,
  rows: Array<{
    doc: { slug: string; blocks: unknown[] }
    editorial: { kind: string; category: { slug: string }; relatedProducts: number[] }
    row: { published_at: string }
  }>
) {
  const landings = rows.filter(({ editorial }) => editorial.kind === 'landing')
  if (!landings.length) return new Map<string, LandingVerdict>()
  const wanted = Array.from(new Set(landings.flatMap(({ editorial }) => editorial.relatedProducts))).sort(
    (a, b) => a - b
  )
  const live = new Set<number>()
  if (wanted.length) {
    const found = await database
      .prepare(
        `SELECT p.legacy_id id FROM products p WHERE p.legacy_id IN(SELECT value FROM json_each(?1)) AND p.status='published' AND ${publicationValidityExpression('p')}`
      )
      .bind(JSON.stringify(wanted))
      .all<{ id: number }>()
    for (const row of found.results ?? []) live.add(Number(row.id))
  }
  return evaluateLandingSet(
    landings.map(({ doc, editorial, row }) => ({
      slug: doc.slug,
      kind: editorial.kind,
      publishedAt: row.published_at,
      categorySlug: editorial.category.slug,
      liveProductCount: editorial.relatedProducts.filter((id) => live.has(id)).length,
      blocks: doc.blocks as Array<{ type: string; text?: string; items?: string[] }>
    }))
  )
}
export async function listLandingCoverage(deps: CmsPublicationDependencies) {
  return guarded(async () => (await source(deps)).flatMap((item) => (item.landing ? [item.landing] : [])))
}
/** Slugs of landings that must stay out of the sitemap (thin / doorway). */
export async function readThinLandingSlugs(deps: CmsPublicationDependencies) {
  return (await listLandingCoverage(deps)).filter((v) => !v.indexable).map((v) => v.slug)
}
async function source(deps: CmsPublicationDependencies) {
  return (await snapshot(deps)).items
}
type Source = Awaited<ReturnType<typeof source>>
function summary(item: Source[number]) {
  return resourceHubSummarySchema.parse({
    slug: item.doc.slug,
    title: item.doc.title,
    description: item.doc.seo.description,
    editorial: item.editorial,
    publishedAt: item.row.published_at,
    canonicalPath: `/recursos/${item.doc.slug}`,
    noindex: item.doc.seo.noindex || item.landing?.indexable === false
  })
}
async function coherent(deps: CmsPublicationDependencies, first: Source) {
  if (JSON.stringify(await source(deps)) !== JSON.stringify(first)) fail('content_unavailable')
}
export async function listD1ResourceHub(deps: CmsPublicationDependencies, raw: unknown): Promise<ResourceHubList> {
  return guarded(async () => {
    const parsed = resourceHubQuerySchema.safeParse(raw)
    if (!parsed.success) fail('invalid_input')
    const q = parsed.data,
      first = await source(deps),
      term = q.q.toLocaleLowerCase('es')
    const selected = first.filter(
      (item) =>
        (!q.category || item.editorial.category.slug === q.category) &&
        (!q.kind || item.editorial.kind === q.kind) &&
        (!term ||
          `${item.doc.title} ${item.doc.seo.description} ${item.editorial.category.label}`
            .toLocaleLowerCase('es')
            .includes(term))
    )
    const categories = Array.from(
      new Map(first.map((item) => [item.editorial.category.slug, item.editorial.category])).values()
    ).sort((a, b) => a.slug.localeCompare(b.slug))
    if (categories.length > 100) fail('limit_exceeded')
    const dto = resourceHubListSchema.parse({
      source: 'cloudflare',
      items: selected.slice((q.page - 1) * q.perPage, q.page * q.perPage).map(summary),
      categories,
      page: q.page,
      perPage: q.perPage,
      total: selected.length,
      pages: Math.ceil(selected.length / q.perPage),
      noindex: !!q.q || q.page > 1 || !!q.category || !!q.kind,
      canonicalPath: '/recursos'
    })
    await coherent(deps, first)
    return dto
  })
}
export async function readD1ResourceHub(deps: CmsPublicationDependencies, slug: string) {
  return guarded(async () => {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 160) fail('not_found')
    const first = await source(deps),
      item = first.find((item) => item.doc.slug === slug)
    if (!item) fail('not_found')
    const page = await readCmsPublicPage(deps, slug)
    if (
      page.preview ||
      page.pageId !== item.row.page_id ||
      JSON.stringify(page.resourceHub) !== JSON.stringify(item.editorial)
    )
      fail('content_unavailable')
    const related = () => [
      deps.database
        .prepare(
          `SELECT p.legacy_id id,p.name,p.slug FROM products p WHERE p.legacy_id IN(SELECT value FROM json_each(?1)) AND p.status='published' AND ${publicationValidityExpression('p')} ORDER BY p.legacy_id`
        )
        .bind(JSON.stringify(item.editorial.relatedProducts)),
      deps.database
        .prepare(
          "SELECT slug,name FROM categories WHERE slug IN(SELECT value FROM json_each(?1)) AND status='published' ORDER BY slug"
        )
        .bind(JSON.stringify(item.editorial.relatedCategories))
    ]
    const links = await deps.database.batch(related())
    if (links.some((r) => !r.success)) fail('content_unavailable')
    const products = z.array(productRowSchema).parse(links[0]!.results),
      categories = z.array(categoryRowSchema).parse(links[1]!.results)
    const resourceSlugs = new Set([
      ...item.editorial.relatedResources,
      ...(item.editorial.pillarSlug ? [item.editorial.pillarSlug] : [])
    ])
    const relatedResources = first
      .filter((other) => other.doc.slug !== slug && resourceSlugs.has(other.doc.slug))
      .map(summary)
    const allowedCommerceLinks = new Set([
      ...products.map((row) => `/producto/${row.slug}`),
      ...categories.flatMap((row) => [`/categoria/${row.slug}`, `/catalogo?familia=${row.slug}`]),
      ...relatedResources.map((row) => row.canonicalPath)
    ])
    const blocks = page.blocks.filter((block) => {
      if (block.type !== 'cta' || block.href.startsWith('https://')) return true
      let path = block.href
      try {
        for (let n = 0; n < 4; n++) {
          const decoded = decodeURIComponent(path)
          if (decoded === path) break
          path = decoded
        }
      } catch {
        return false
      }
      return (
        !/^\/(?:producto|categoria|catalogo|recursos)(?:\/|\?|$)/i.test(path) || allowedCommerceLinks.has(block.href)
      )
    })
    const dto = resourceHubDetailSchema.parse({
      source: 'cloudflare',
      version: page.version,
      preview: false,
      blocks,
      media: page.media,
      ...summary(item),
      editorial: item.editorial,
      relatedProducts: products,
      relatedCategories: categories,
      relatedResources
    })
    const final = await snapshot(deps, related())
    if (
      JSON.stringify(final.links) !== JSON.stringify(links.map((r) => r.results)) ||
      JSON.stringify(final.items) !== JSON.stringify(first)
    )
      fail('content_unavailable')
    return dto
  })
}
