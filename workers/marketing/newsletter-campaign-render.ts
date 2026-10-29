import {
  newsletterCampaignDocumentSchema,
  newsletterPreviewSchema,
  type NewsletterCampaignDocument
} from '../../shared/newsletter-editorial'
import { publicationValidityExpression } from '../catalog/publication-validity'
import { cmsPublishedValiditySql } from '../cms/publication-gate'
import { readCmsPublicPage } from '../cms/public-http'
import {
  NewsletterEditorialError,
  assertEditorialEnabled,
  authorizeEditorial,
  editorialNow,
  type NewsletterEditorialDependencies
} from './newsletter-editorial-core'
import { editorialCampaignHead, editorialCampaignVersion } from './newsletter-campaigns'

export function editorialPercent(document: NewsletterCampaignDocument) {
  return (100 * document.blocks.filter((b) => b.kind === 'editorial').length) / document.blocks.length
}
export function editorialTargetPath(
  target: Extract<NewsletterCampaignDocument['blocks'][number], { type: 'link' }>['target']
) {
  return target.type === 'static' ? target.path : `/${target.type === 'cms' ? 'contenido' : 'producto'}/${target.slug}`
}
export async function validateEditorialLinks(deps: NewsletterEditorialDependencies, doc: NewsletterCampaignDocument) {
  for (const block of doc.blocks) {
    if (block.type !== 'link' || block.target.type === 'static') continue
    if (block.target.type === 'cms') {
      if (!deps.cmsPublication?.enabled) throw new NewsletterEditorialError('source_unavailable')
      try {
        await readCmsPublicPage(
          { ...deps.cmsPublication, database: deps.database, now: () => editorialNow(deps) },
          block.target.slug
        )
      } catch {
        throw new NewsletterEditorialError('source_unavailable')
      }
    } else {
      const row = await deps.database
        .prepare(
          `SELECT p.id FROM products p JOIN categories c ON c.id=p.category_id AND c.status='published' AND c.legacy_id IS NOT NULL
 WHERE p.slug=?1 AND p.status='published' AND p.legacy_id IS NOT NULL AND ${publicationValidityExpression('p', '?2')}
 AND EXISTS(SELECT 1 FROM variants v WHERE v.product_id=p.id AND v.status='published' AND v.legacy_id IS NOT NULL)`
        )
        .bind(block.target.slug, editorialNow(deps))
        .first()
      if (!row) throw new NewsletterEditorialError('source_unavailable')
    }
  }
}
/** Execution-time counterpart, not a historical approval exemption. */
export function editorialLinksSql(document: string, cmsEnabled: boolean) {
  const staticPaths = "'/catalogo','/ayuda','/contacto','/envios','/devoluciones','/formas-de-pago','/accesibilidad'"
  // Join the materialized source projections at this SELECT boundary. Putting
  // another SELECT inside each CASE branch makes SQLite inherit the entire
  // publication-predicate height through the surrounding cap/lease guards.
  return `NOT EXISTS(SELECT 1 FROM json_each(${document},'$.blocks') link
 LEFT JOIN newsletter_live_products product_source ON product_source.slug=json_extract(link.value,'$.target.slug') AND json_extract(link.value,'$.target.type')='product'
 ${cmsEnabled ? `LEFT JOIN newsletter_live_content cms_source ON cms_source.slug=json_extract(link.value,'$.target.slug') AND json_extract(link.value,'$.target.type')='cms'` : ''}
 WHERE json_extract(link.value,'$.type')='link'
 AND COALESCE(CASE json_extract(link.value,'$.target.type')
 WHEN 'static' THEN json_extract(link.value,'$.target.path') IN(${staticPaths})
 WHEN 'cms' THEN ${cmsEnabled ? 'cms_source.slug IS NOT NULL' : '0'}
 WHEN 'product' THEN product_source.slug IS NOT NULL ELSE 0 END,0)=0)`
}
/** Keep the large shared publication predicates at the top query level rather
 * than nesting them in CASE/markers: D1's expression-depth limit is 100. */
export function editorialSourcesCte(clock: string, cmsEnabled: boolean) {
  return `WITH newsletter_link_slugs AS MATERIALIZED(SELECT json_extract(block.value,'$.target.slug') AS slug,json_extract(block.value,'$.target.type') AS type
 FROM newsletter_editorial_deliveries delivery JOIN newsletter_editorial_versions version ON version.id=delivery.version_id AND version.campaign_id=delivery.campaign_id,json_each(version.document,'$.blocks') block
 WHERE delivery.id=?2 AND json_extract(block.value,'$.type')='link'),
 newsletter_live_products AS MATERIALIZED(SELECT product.slug FROM products product JOIN categories category ON category.id=product.category_id AND category.status='published' AND category.legacy_id IS NOT NULL
 WHERE product.slug IN(SELECT slug FROM newsletter_link_slugs WHERE type='product') AND ${publicationValidityExpression('product', clock)} AND product.status='published' AND product.legacy_id IS NOT NULL
 AND EXISTS(SELECT 1 FROM variants variant WHERE variant.product_id=product.id AND variant.status='published' AND variant.legacy_id IS NOT NULL))${cmsEnabled ? `,newsletter_live_content AS MATERIALIZED(SELECT release.slug FROM content_publications release JOIN content_publication_states head ON head.page_id=release.page_id WHERE release.slug IN(SELECT slug FROM newsletter_link_slugs WHERE type='cms') AND ${cmsPublishedValiditySql('release', 'head', clock)})` : ''}`
}
export function renderNewsletterCampaign(
  raw: NewsletterCampaignDocument,
  context: { origin: string; preview: boolean; unsubscribeUrl?: string; preferenceUrl?: string }
) {
  const doc = newsletterCampaignDocumentSchema.parse(raw),
    origin = new URL(context.origin)
  if (origin.protocol !== 'https:' || origin.origin !== context.origin)
    throw new NewsletterEditorialError('configuration_unavailable')
  const escape = (text: string) =>
    text
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;')
  const safe = (url: string | undefined) => {
    if (!url) throw new NewsletterEditorialError('configuration_unavailable')
    const parsed = new URL(url)
    if (parsed.origin !== origin.origin) throw new NewsletterEditorialError('configuration_unavailable')
    return url
  }
  const text: string[] = [],
    html: string[] = []
  for (const b of doc.blocks) {
    if (b.type === 'heading') {
      text.push(b.text)
      html.push(`<h2>${escape(b.text)}</h2>`)
    } else if (b.type === 'paragraph') {
      text.push(b.text)
      html.push(`<p>${escape(b.text).replaceAll('\n', '<br>')}</p>`)
    } else {
      const link = new URL(editorialTargetPath(b.target), origin).toString()
      text.push(context.preview ? `${b.label} — enlace desactivado en preview` : `${b.label}: ${link}`)
      html.push(
        context.preview
          ? `<p><span>${escape(b.label)} (enlace desactivado)</span></p>`
          : `<p><a href="${escape(link)}" rel="noreferrer">${escape(b.label)}</a></p>`
      )
    }
  }
  const footer = context.preview
    ? '<p>Datos sintéticos. Preferencias y baja desactivadas en preview. No se envía ningún correo.</p>'
    : `<p><a href="${escape(safe(context.preferenceUrl))}">Elegir temas y frecuencia</a> · <a href="${escape(safe(context.unsubscribeUrl))}">Darme de baja</a></p>`
  text.push(
    context.preview
      ? 'Datos sintéticos. Preferencias y baja desactivadas.'
      : `Preferencias: ${safe(context.preferenceUrl)}\nBaja: ${safe(context.unsubscribeUrl)}`
  )
  return {
    subject: doc.subject,
    text: text.join('\n\n'),
    html: `<div lang="es" style="font-family:Arial,sans-serif;line-height:1.6;color:#172033;max-width:600px;margin:0 auto;padding:24px"><h1>${escape(doc.name)}</h1>${html.join('')}${footer}</div>`
  }
}
export async function previewNewsletterCampaign(
  deps: NewsletterEditorialDependencies,
  claims: Parameters<typeof authorizeEditorial>[1],
  campaignId: string
) {
  assertEditorialEnabled(deps)
  await authorizeEditorial(deps, claims)
  const head = await editorialCampaignHead(deps, campaignId),
    doc = await editorialCampaignVersion(deps, campaignId, head.draft_version_id)
  const rendered = renderNewsletterCampaign(doc, { origin: deps.publicOrigin, preview: true })
  await authorizeEditorial(deps, claims)
  const live = await editorialCampaignHead(deps, campaignId)
  if (live.revision !== head.revision || live.draft_version_id !== head.draft_version_id)
    throw new NewsletterEditorialError('version_conflict')
  return newsletterPreviewSchema.parse({
    source: 'cloudflare',
    campaignId,
    versionId: head.draft_version_id,
    synthetic: true,
    externalDelivery: false,
    ...rendered,
    editorialPercent: editorialPercent(doc),
    actionsEnabled: false
  })
}
