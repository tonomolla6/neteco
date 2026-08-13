import { useDatabase } from '../../db/client'

function xml(value: string | number) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

export default defineEventHandler(async (event) => {
  const runtime = useRuntimeConfig(event)
  const origin = String(runtime.public.baseUrl).replace(/\/$/, '')
  const sql = useDatabase()
  const items = await sql<
    Array<{
      id: string
      sku: string
      slug: string
      name: string
      description: string
      brand: string
      image: string
      gtin: string | null
      mpn: string | null
      priceCents: number
      available: number
      backorderAllowed: boolean
      shippingLabel: string
    }>
  >`
    SELECT variant.id, variant.sku, product.slug, product.name,
           COALESCE(product.short_description, product.description, product.name) AS description,
           COALESCE(brand.name, 'NETECO') AS brand, product.attributes ->> 'image' AS image,
           COALESCE(variant.gtin, variant.ean) AS gtin, variant.mpn,
           variant.price_gross_cents AS "priceCents",
           greatest(COALESCE(sum(balance.physical_quantity - balance.blocked_quantity), 0)
             - variant.safety_stock - COALESCE((
               SELECT sum(reservation.quantity)::int FROM inventory_reservations reservation
               WHERE reservation.variant_id = variant.id AND reservation.status = 'active'
                 AND reservation.expires_at > now()
             ), 0), 0)::int AS available,
           variant.backorder_allowed AS "backorderAllowed", profile.kind AS "shippingLabel"
    FROM variants variant
    JOIN products product ON product.id = variant.product_id
    LEFT JOIN brands brand ON brand.id = product.brand_id
    JOIN shipping_profiles profile ON profile.id = variant.shipping_profile_id
    JOIN media_assets asset ON asset.source_url = product.attributes ->> 'image'
      AND asset.rights_status = 'approved' AND asset.quarantine_status = 'clean'
    LEFT JOIN inventory_balances balance ON balance.variant_id = variant.id
    WHERE product.status = 'published' AND variant.status = 'published'
      AND product.attributes ->> 'image' LIKE '/media/%'
    GROUP BY variant.id, product.id, brand.name, profile.kind
    ORDER BY variant.sku
  `
  const entries = items
    .map((item) => {
      const identifier = item.gtin
        ? `<g:gtin>${xml(item.gtin)}</g:gtin>`
        : item.mpn
          ? `<g:mpn>${xml(item.mpn)}</g:mpn>`
          : '<g:identifier_exists>false</g:identifier_exists>'
      const availability = item.available > 0 ? 'in_stock' : item.backorderAllowed ? 'backorder' : 'out_of_stock'
      return `<item><g:id>${xml(`neteco_${item.id}`)}</g:id><title>${xml(item.name)}</title><description>${xml(item.description)}</description><link>${xml(`${origin}/producto/${item.slug}?sku=${encodeURIComponent(item.sku)}`)}</link><g:image_link>${xml(`${origin}${item.image}`)}</g:image_link><g:availability>${availability}</g:availability><g:price>${(item.priceCents / 100).toFixed(2)} EUR</g:price><g:condition>new</g:condition><g:brand>${xml(item.brand)}</g:brand>${identifier}<g:shipping_label>${xml(item.shippingLabel)}</g:shipping_label><g:return_policy_label>neteco-standard</g:return_policy_label></item>`
    })
    .join('')
  setHeader(event, 'content-type', 'application/xml; charset=utf-8')
  setHeader(event, 'cache-control', 'public, max-age=900')
  setHeader(event, 'x-robots-tag', 'noindex, nofollow')
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:g="http://base.google.com/ns/1.0"><channel><title>NETECO</title><link>${xml(origin)}</link><description>Catálogo contractual NETECO</description>${entries}</channel></rss>`
})
