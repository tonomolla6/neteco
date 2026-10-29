import { z } from 'zod'
import {
  promotionalContentSchema,
  promotionalContextSchema,
  PROMOTIONAL_CANDIDATE_LIMIT,
  type PromotionalContent,
  type PromotionalContext
} from '../../shared/promotional-content'
import { cmsDocumentSchema } from '../../shared/cms-commands'
import { catalogPolicyUuidSchema } from '../../shared/catalog-publication-policy'
import { cmsNow, cmsPublishedValiditySql, type CmsPublicationDependencies } from './publication-gate'

export class PromotionalContentError extends Error {
  constructor(public readonly code: 'invalid_input' | 'service_unavailable' | 'history_unconfirmed') {
    super(code)
    this.name = 'PromotionalContentError'
  }
}
const rowSchema = z
  .object({
    page_id: catalogPolicyUuidSchema,
    publication_id: catalogPolicyUuidSchema,
    version: z.number().int().min(1),
    document: z.string().max(262144),
    media: z.string().max(10000)
  })
  .strict()
// Read canonical CMS heads, immutable versions and approved media links together.
// Owned image bytes are still checked by the existing /api/content-media boundary.
// No draft/preview grant is accepted by this public placement selector.
const selectionSql = `SELECT release.page_id,release.id AS publication_id,version.version,version.document,
 COALESCE((SELECT json_group_object(link.block_id,'/api/content-media/'||link.id||'/image?w=1200&format=webp')
 FROM content_media_links link WHERE link.owner_id=release.id AND link.version_id=release.version_id),'{}') AS media
 FROM content_publications release
 JOIN content_publication_states head ON head.page_id=release.page_id
 JOIN content_versions version ON version.id=release.version_id AND version.page_id=release.page_id
 WHERE ${cmsPublishedValiditySql('release', 'head', '?1')}
 AND json_type(version.document,'$.promotional')='object'
 AND EXISTS(SELECT 1 FROM json_each(version.document,'$.promotional.placements') WHERE value=?2)
 AND (json_array_length(version.document,'$.promotional.paths')=0 OR EXISTS(SELECT 1 FROM json_each(version.document,'$.promotional.paths') WHERE value=?3))
 AND (json_array_length(version.document,'$.promotional.categorySlugs')=0 OR EXISTS(SELECT 1 FROM json_each(version.document,'$.promotional.categorySlugs') WHERE value=?4))
 AND (json_array_length(version.document,'$.promotional.productSlugs')=0 OR EXISTS(SELECT 1 FROM json_each(version.document,'$.promotional.productSlugs') WHERE value=?5))
 ORDER BY json_extract(version.document,'$.promotional.priority') DESC,release.page_id ASC LIMIT ?6`
async function select(deps: CmsPublicationDependencies, context: PromotionalContext, now: string) {
  const result = await deps.database
    .prepare(selectionSql)
    .bind(
      now,
      context.placement,
      context.path,
      context.categorySlug ?? null,
      context.productSlug ?? null,
      PROMOTIONAL_CANDIDATE_LIMIT + 1
    )
    .all()
  if (result.success !== true) throw new PromotionalContentError('service_unavailable')
  const rows = z.array(rowSchema).max(PROMOTIONAL_CANDIDATE_LIMIT).safeParse(result.results)
  if (!rows.success) throw new PromotionalContentError('history_unconfirmed')
  return rows.data.map((row) => {
    const document = cmsDocumentSchema.parse(JSON.parse(row.document))
    if (!document.promotional) throw new PromotionalContentError('history_unconfirmed')
    return {
      pageId: row.page_id,
      publicationId: row.publication_id,
      version: row.version,
      title: document.title,
      format: document.promotional.format,
      blocks: document.blocks,
      media: JSON.parse(row.media)
    }
  })
}
/** Context-only, read-only selection. The final statement rechecks publication,
 * rights/scan evidence and all selectors; there are no awaits after its result
 * is projected. A withdrawn release cannot be revived by an earlier rowset. */
export async function readD1PromotionalContent(
  deps: CmsPublicationDependencies,
  rawContext: unknown
): Promise<PromotionalContent> {
  const parsed = promotionalContextSchema.safeParse(rawContext)
  if (!parsed.success) throw new PromotionalContentError('invalid_input')
  try {
    if (!deps.enabled)
      return promotionalContentSchema.parse({
        source: 'cloudflare',
        placement: parsed.data.placement,
        items: [],
        evaluatedAt: cmsNow(deps)
      })
    await select(deps, parsed.data, cmsNow(deps))
    const evaluatedAt = cmsNow(deps),
      items = await select(deps, parsed.data, evaluatedAt)
    return promotionalContentSchema.parse({
      source: 'cloudflare',
      placement: parsed.data.placement,
      items: items.slice(0, 6),
      evaluatedAt
    })
  } catch (error) {
    if (error instanceof PromotionalContentError) throw error
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      throw new PromotionalContentError('history_unconfirmed')
    throw new PromotionalContentError('service_unavailable')
  }
}
