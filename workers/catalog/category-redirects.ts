import { z } from 'zod'
import { categoryHasControls } from '../../shared/catalog-category-commands'
import { catalogPolicyOwnJson } from '../../shared/catalog-publication-policy'

const slugSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
const headers = {
  'Cache-Control': 'private, no-store',
  Pragma: 'no-cache',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer'
}
const invalid = () => Response.json({ error: { code: 'invalid_input' } }, { status: 400, headers })
export function ownsD1CategoryRedirectNamespace(pathname: string) {
  let candidate = pathname
  for (let attempt = 0; attempt < 4; attempt++) {
    if (/^\/categoria(?:[/\\%]|$)/.test(candidate)) return true
    try {
      const decoded = decodeURIComponent(candidate)
      if (decoded === candidate) return false
      candidate = decoded
    } catch {
      return false
    }
  }
  return false
}
const queryKeys = new Set([
  'brand',
  'badge',
  'envase',
  'talla',
  'cap',
  'color',
  'medida',
  'acabado',
  'min',
  'max',
  'sort',
  'page',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content'
])
function safeQuery(url: URL): string | null {
  if (url.search.length > 8192) return null
  const output = new URLSearchParams(),
    seen = new Set<string>()
  for (const [key, value] of url.searchParams) {
    if (!queryKeys.has(key)) continue
    if (seen.has(key) || value.length > 2000 || categoryHasControls(value)) return null
    seen.add(key)
    output.set(key, value)
  }
  const result = output.toString()
  return result ? `?${result}` : ''
}
/** Alias is bound to immutable category identity, not a mutable path. Resolve
 * directly to its current slug only while the complete public ancestry passes.
 * Throws a sanitized outage; ingress must fail closed instead of SSR fallback. */
export async function handleD1CategoryRedirect(request: Request, database: D1Database): Promise<Response | null> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null
  const url = new URL(request.url)
  if (!ownsD1CategoryRedirectNamespace(url.pathname)) return null
  const match = /^\/categoria\/([^/]+)$/.exec(url.pathname)
  if (!match) return invalid()
  let slug: string
  try {
    slug = decodeURIComponent(match[1]!)
  } catch {
    return invalid()
  }
  if (!slugSchema.safeParse(slug).success) return invalid()
  try {
    const result: unknown = await database
      .prepare(
        `WITH RECURSIVE target AS (
      SELECT category.id,category.slug FROM catalog_category_aliases alias JOIN categories category ON category.id=alias.category_uuid
      WHERE alias.slug=?1 AND category.slug<>?1 AND NOT EXISTS(SELECT 1 FROM categories WHERE slug=?1)
    ),ancestors AS (
      SELECT category.id,category.parent_id,category.status,category.legacy_id,0 AS depth,0 AS cycle,json_array(category.id) AS visited
      FROM categories category JOIN target ON target.id=category.id
      UNION ALL SELECT parent.id,parent.parent_id,parent.status,parent.legacy_id,child.depth+1,
        EXISTS(SELECT 1 FROM json_each(child.visited) WHERE value=parent.id),json_insert(child.visited,'$[#]',parent.id)
      FROM ancestors child JOIN categories parent ON parent.id=child.parent_id WHERE child.cycle=0 AND child.depth<128
    ) SELECT target.slug,EXISTS(SELECT 1 FROM ancestors WHERE parent_id IS NULL)
      AND NOT EXISTS(SELECT 1 FROM ancestors WHERE cycle=1 OR status<>'published' OR legacy_id IS NULL OR legacy_id NOT BETWEEN 1 AND 9007199254740991) AS visible FROM target`
      )
      .bind(slug)
      .all()
    if (!result || typeof result !== 'object' || Object.getOwnPropertyDescriptor(result, 'success')?.value !== true)
      throw new Error('category_redirect_unavailable')
    const rows: unknown = Object.getOwnPropertyDescriptor(result, 'results')?.value
    const parsed = z
      .array(z.object({ slug: slugSchema, visible: z.union([z.literal(0), z.literal(1)]) }).strict())
      .max(1)
      .safeParse(catalogPolicyOwnJson(rows))
    if (!parsed.success) throw new Error('category_redirect_unavailable')
    const target = parsed.data[0]
    if (!target || target.visible !== 1) return null
    const query = safeQuery(url)
    if (query === null) return invalid()
    return new Response(null, { status: 301, headers: { ...headers, Location: `/categoria/${target.slug}${query}` } })
  } catch {
    throw new Error('category_redirect_unavailable')
  }
}
