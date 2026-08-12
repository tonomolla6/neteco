import { useDatabase } from '../db/client'
import type { SerializableParameter } from 'postgres'

const SIZE_ORDER = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL']

interface FilterPart {
  key: string
  clause: string
  parameters: SerializableParameter[]
}

interface ProductRow {
  uuid: string
  id: number
  name: string
  slug: string
  brand: string
  badges: string[]
  visual: { type: string; color: string }
  image: string | null
  featured: boolean
  shortDesc: string | null
  categoryId: number
  minPrice: number
  formats: number
}

function compileWhere(parts: FilterPart[], excluded: string[] = []) {
  let position = 0
  const parameters: SerializableParameter[] = []
  const clauses = parts
    .filter((part) => !excluded.includes(part.key))
    .map((part) => {
      parameters.push(...part.parameters)
      return part.clause.replaceAll('?', () => `$${++position}`)
    })
  return { text: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', parameters }
}

function tally(values: Array<string | null | undefined>) {
  const counts = new Map<string, number>()
  for (const value of values) if (value) counts.set(value, (counts.get(value) ?? 0) + 1)
  return [...counts.entries()]
    .map(([value, n]) => ({ value, n }))
    .sort((left, right) => right.n - left.n || left.value.localeCompare(right.value, 'es'))
}

function parseAxes(format: string) {
  const segments = format.split(' · ')
  const color = segments.at(-1)?.match(/^Color (.+)$/)?.[1] ?? null
  return { color, axes: color ? segments.slice(0, -1) : [] }
}

export default defineEventHandler(async (event) => {
  const sql = useDatabase()
  const query = getQuery(event)
  const multi = (value: unknown) =>
    String(value ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .slice(0, 50)
  const filters: FilterPart[] = [{ key: 'active', clause: "p.status = 'published'", parameters: [] }]

  if (query.category) {
    const categorySlug = String(query.category).slice(0, 180)
    const descendants = await sql<{ id: string }[]>`
      WITH RECURSIVE tree AS (
        SELECT id FROM categories WHERE slug = ${categorySlug} AND status = 'published'
        UNION ALL
        SELECT child.id FROM categories child JOIN tree parent ON child.parent_id = parent.id
        WHERE child.status = 'published'
      )
      SELECT id FROM tree
    `
    if (!descendants.length) throw createError({ statusCode: 404, statusMessage: 'Categoría no encontrada' })
    filters.push({
      key: 'category',
      clause: 'p.category_id = ANY(?::uuid[])',
      parameters: [descendants.map((category) => category.id)]
    })
  }

  const search = String(query.q ?? '')
    .trim()
    .slice(0, 160)
  if (search) {
    filters.push({
      key: 'q',
      clause: `(p.search_document @@ websearch_to_tsquery('spanish', ?)
        OR p.name ILIKE ?
        OR b.name ILIKE ?
        OR EXISTS (SELECT 1 FROM variants search_variant
                   WHERE search_variant.product_id = p.id AND search_variant.sku ILIKE ?))`,
      parameters: [search, `%${search}%`, `%${search}%`, `%${search}%`]
    })
  }
  const badges = multi(query.badge)
  if (badges.length) {
    filters.push({
      key: 'badge',
      clause: `EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(COALESCE(p.attributes -> 'badges', '[]'::jsonb)) badge
        WHERE badge.value = ANY(?::text[])
      )`,
      parameters: [badges]
    })
  }
  const brands = multi(query.brand)
  if (brands.length) {
    filters.push({ key: 'brand', clause: 'b.name = ANY(?::text[])', parameters: [brands] })
  }
  const containers = multi(query.envase).filter((value) => /^[a-záéíóúñ-]+$/i.test(value))
  if (containers.length) {
    filters.push({
      key: 'envase',
      clause: "p.attributes #>> '{visual,type}' = ANY(?::text[])",
      parameters: [containers]
    })
  }
  const sizes = multi(query.talla).map((value) => `Talla ${value}`)
  if (sizes.length) {
    filters.push({
      key: 'talla',
      clause: `EXISTS (SELECT 1 FROM variants size_variant
                       WHERE size_variant.product_id = p.id AND size_variant.status = 'published'
                         AND size_variant.format = ANY(?::text[]))`,
      parameters: [sizes]
    })
  }
  const capacities = multi(query.capacidad)
    .map((value) => value.match(/^([\d.]+)-(.+)$/))
    .filter((match): match is RegExpMatchArray => !!match && Number.isFinite(Number(match[1])))
    .map((match) => [Number(match[1]), match[2]!] as const)
  if (capacities.length) {
    filters.push({
      key: 'capacidad',
      clause: `EXISTS (SELECT 1 FROM variants capacity_variant
                       WHERE capacity_variant.product_id = p.id AND capacity_variant.status = 'published'
                         AND (${capacities.map(() => '(capacity_variant.content_quantity = ? AND capacity_variant.unit_label = ?)').join(' OR ')}))`,
      parameters: capacities.flatMap(([amount, label]) => [amount, label])
    })
  }
  const colors = multi(query.color)
  if (colors.length) {
    filters.push({
      key: 'color',
      clause: `EXISTS (SELECT 1 FROM variants color_variant
                       WHERE color_variant.product_id = p.id AND color_variant.status = 'published'
                         AND color_variant.format ILIKE ANY(?::text[]))`,
      parameters: [colors.map((color) => `%Color ${color}`)]
    })
  }
  const measurements = String(query.medida ?? '')
    .split('|')
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 50)
  if (measurements.length) {
    filters.push({
      key: 'medida',
      clause: `EXISTS (SELECT 1 FROM variants measurement_variant
                       WHERE measurement_variant.product_id = p.id AND measurement_variant.status = 'published'
                         AND measurement_variant.format ILIKE ANY(?::text[]))`,
      parameters: [measurements.map((measurement) => `${measurement} · %`)]
    })
  }
  const finishes = multi(query.acabado)
  if (finishes.length) {
    filters.push({
      key: 'acabado',
      clause: `EXISTS (SELECT 1 FROM variants finish_variant
                       WHERE finish_variant.product_id = p.id AND finish_variant.status = 'published'
                         AND finish_variant.format ILIKE ANY(?::text[]))`,
      parameters: [finishes.map((finish) => `%${finish} · Color %`)]
    })
  }
  const priceMinimum = query.price_min === undefined ? null : Math.round(Number(query.price_min) * 100)
  const priceMaximum = query.price_max === undefined ? null : Math.round(Number(query.price_max) * 100)
  const priceClauses: string[] = []
  const priceParameters: number[] = []
  if (priceMinimum !== null && Number.isFinite(priceMinimum) && priceMinimum >= 0) {
    priceClauses.push('summary.min_price >= ?')
    priceParameters.push(priceMinimum)
  }
  if (priceMaximum !== null && Number.isFinite(priceMaximum) && priceMaximum >= 0) {
    priceClauses.push('summary.min_price <= ?')
    priceParameters.push(priceMaximum)
  }
  if (priceClauses.length) {
    filters.push({ key: 'price', clause: `(${priceClauses.join(' AND ')})`, parameters: priceParameters })
  }
  if (query.featured) filters.push({ key: 'featured', clause: 'p.featured = true', parameters: [] })

  const productSelect = `
    SELECT p.id AS uuid, p.legacy_id AS id, p.name, p.slug, COALESCE(b.name, 'NETECO') AS brand,
           COALESCE(p.attributes -> 'badges', '[]'::jsonb) AS badges,
           COALESCE(p.attributes -> 'visual', '{"type":"botella","color":"#64748b"}'::jsonb) AS visual,
           p.attributes ->> 'image' AS image, p.featured, p.short_description AS "shortDesc",
           c.legacy_id AS "categoryId", summary.min_price AS "minPrice", summary.formats
    FROM products p
    JOIN categories c ON c.id = p.category_id
    LEFT JOIN brands b ON b.id = p.brand_id
    JOIN LATERAL (
      SELECT min(price_gross_cents)::int AS min_price, count(*)::int AS formats
      FROM variants
      WHERE product_id = p.id AND status = 'published'
    ) summary ON summary.formats > 0`
  const rowsFor = async (excluded: string[] = []) => {
    const where = compileWhere(filters, excluded)
    return sql.unsafe<ProductRow[]>(
      `${productSelect} ${where.text} ORDER BY p.featured DESC, lower(p.name), p.id`,
      where.parameters
    )
  }

  const page = Math.max(Number.parseInt(String(query.page ?? '1'), 10) || 1, 1)
  const limit = Math.min(Math.max(Number.parseInt(String(query.limit ?? '24'), 10) || 24, 1), 100)
  const orderBy =
    {
      price_asc: 'summary.min_price ASC, lower(p.name), p.id',
      price_desc: 'summary.min_price DESC, lower(p.name), p.id',
      name: 'lower(p.name), p.id'
    }[String(query.sort ?? '')] ?? 'p.featured DESC, lower(p.name), p.id'
  const where = compileWhere(filters)
  const [count] = await sql.unsafe<{ total: number }[]>(
    `SELECT count(*)::int AS total
     FROM products p
     LEFT JOIN brands b ON b.id = p.brand_id
     JOIN LATERAL (
       SELECT min(price_gross_cents)::int AS min_price, count(*)::int AS formats
       FROM variants WHERE product_id = p.id AND status = 'published'
     ) summary ON summary.formats > 0
     ${where.text}`,
    where.parameters
  )
  const total = count?.total ?? 0
  const listingParameters = [...where.parameters, limit, (page - 1) * limit]
  const items = await sql.unsafe<ProductRow[]>(
    `${productSelect} ${where.text} ORDER BY ${orderBy}
     LIMIT $${listingParameters.length - 1} OFFSET $${listingParameters.length}`,
    listingParameters
  )

  let facets
  if (query.facets) {
    const [
      brandRows,
      badgeRows,
      containerRows,
      priceRows,
      sizeContext,
      capacityContext,
      colorContext,
      measurementContext,
      finishContext,
      categoryRows
    ] = await Promise.all([
      rowsFor(['brand']),
      rowsFor(['badge']),
      rowsFor(['envase']),
      rowsFor(['price']),
      rowsFor(['talla']),
      rowsFor(['capacidad']),
      rowsFor(['color']),
      rowsFor(['medida']),
      rowsFor(['acabado']),
      rowsFor(['category'])
    ])
    const brandsFacet = tally(brandRows.map((row) => row.brand))
    const badgesFacet = tally(badgeRows.flatMap((row) => row.badges))
    const containersFacet = tally(containerRows.map((row) => row.visual.type))
    const prices = priceRows.map((row) => row.minPrice).filter(Number.isFinite)
    const price = prices.length ? { min: Math.min(...prices), max: Math.max(...prices) } : null

    const variantsFor = async (context: ProductRow[]) => {
      if (!context.length) return []
      return sql.unsafe<Array<{ productId: string; format: string; units: number; label: string }>>(
        `SELECT product_id AS "productId", format, content_quantity::float8 AS units, unit_label AS label
         FROM variants WHERE status = 'published' AND product_id = ANY($1::uuid[])`,
        [context.map((row) => row.uuid)]
      )
    }
    const [sizeVariants, capacityVariants, colorVariants, measurementVariants, finishVariants] = await Promise.all([
      variantsFor(sizeContext),
      variantsFor(capacityContext),
      variantsFor(colorContext),
      variantsFor(measurementContext),
      variantsFor(finishContext)
    ])
    const sizesMap = new Map<string, Set<string>>()
    for (const variant of sizeVariants) {
      if (!variant.format.startsWith('Talla ')) continue
      const size = variant.format.slice(6)
      const products = sizesMap.get(size) ?? new Set<string>()
      products.add(variant.productId)
      sizesMap.set(size, products)
    }
    const tallas = [...sizesMap.entries()]
      .map(([value, products]) => ({ value, n: products.size }))
      .sort((left, right) => {
        const leftOrder = SIZE_ORDER.indexOf(left.value)
        const rightOrder = SIZE_ORDER.indexOf(right.value)
        return (leftOrder < 0 ? 999 : leftOrder) - (rightOrder < 0 ? 999 : rightOrder)
      })
    const capacityMap = new Map<string, { units: number; label: string; products: Set<string> }>()
    for (const variant of capacityVariants) {
      const value = `${variant.units}-${variant.label}`
      const entry = capacityMap.get(value) ?? {
        units: variant.units,
        label: variant.label,
        products: new Set<string>()
      }
      entry.products.add(variant.productId)
      capacityMap.set(value, entry)
    }
    const capacityOrder: Record<string, number> = { L: 0, kg: 1, ud: 2, unidad: 2 }
    const capacidades = [...capacityMap.entries()]
      .map(([value, entry]) => ({ value, units: entry.units, label: entry.label, n: entry.products.size }))
      .sort(
        (left, right) =>
          (capacityOrder[left.label] ?? 9) - (capacityOrder[right.label] ?? 9) || left.units - right.units
      )
    const colorMap = new Map<string, Set<string>>()
    for (const variant of colorVariants) {
      const { color } = parseAxes(variant.format)
      if (!color) continue
      const products = colorMap.get(color) ?? new Set<string>()
      products.add(variant.productId)
      colorMap.set(color, products)
    }
    const colores = [...colorMap.entries()]
      .map(([value, products]) => ({ value, n: products.size, hex: null }))
      .sort((left, right) => right.n - left.n || left.value.localeCompare(right.value, 'es'))
    const axisFacet = (variants: Awaited<ReturnType<typeof variantsFor>>, measurement: boolean) => {
      const values = new Map<string, Set<string>>()
      for (const variant of variants) {
        const axes = parseAxes(variant.format).axes
        for (const axis of axes) {
          if (/\d/.test(axis) !== measurement) continue
          const products = values.get(axis) ?? new Set<string>()
          products.add(variant.productId)
          values.set(axis, products)
        }
      }
      return [...values.entries()]
        .map(([value, products]) => ({ value, n: products.size }))
        .sort((left, right) => right.n - left.n || left.value.localeCompare(right.value, 'es'))
    }
    const categoryCounts = new Map<number, number>()
    for (const row of categoryRows) categoryCounts.set(row.categoryId, (categoryCounts.get(row.categoryId) ?? 0) + 1)
    const categoryIds = [...categoryCounts.keys()]
    const categoryNames = categoryIds.length
      ? await sql.unsafe<Array<{ id: number; name: string; slug: string }>>(
          'SELECT legacy_id AS id, name, slug FROM categories WHERE legacy_id = ANY($1::int[])',
          [categoryIds]
        )
      : []
    const categories = categoryNames
      .map((category) => ({ ...category, n: categoryCounts.get(category.id) ?? 0 }))
      .sort((left, right) => right.n - left.n || left.name.localeCompare(right.name, 'es'))
    facets = {
      brands: brandsFacet,
      badges: badgesFacet,
      envases: containersFacet,
      tallas,
      capacidades,
      colores,
      medidas: axisFacet(measurementVariants, true),
      acabados: axisFacet(finishVariants, false),
      price,
      categories
    }
  }

  return { items, total, page, pages: Math.max(Math.ceil(total / limit), 1), facets }
})
