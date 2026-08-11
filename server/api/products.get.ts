// Listado de productos con filtros multi-valor y facetas estilo "layered navigation":
// cada faceta se calcula aplicando todos los filtros MENOS el suyo propio, para que
// las opciones no desaparezcan al marcarlas.
const TALLA_ORDER = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL']

export default defineEventHandler((event) => {
  const db = useDb()
  const q = getQuery(event)

  const multi = (val: unknown) =>
    String(val)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)

  const parts: Array<{ key: string; sql: string; params: any[] }> = [
    // los productos ocultos/descatalogados nunca aparecen en la web
    { key: 'active', sql: 'p.active = 1', params: [] }
  ]

  if (q.category) {
    const cat = db.prepare('SELECT id FROM categories WHERE slug = ?').get(String(q.category)) as
      | { id: number }
      | undefined
    if (!cat) throw createError({ statusCode: 404, statusMessage: 'Categoría no encontrada' })
    const all = db.prepare('SELECT id, parent_id AS parentId FROM categories').all() as Array<{
      id: number
      parentId: number | null
    }>
    const ids = [cat.id]
    let frontier = [cat.id]
    while (frontier.length) {
      const next = all.filter((c) => c.parentId != null && frontier.includes(c.parentId)).map((c) => c.id)
      ids.push(...next)
      frontier = next
    }
    parts.push({ key: 'category', sql: `p.category_id IN (${ids.map(() => '?').join(',')})`, params: ids })
  }

  if (q.q) {
    const like = `%${String(q.q).trim()}%`
    parts.push({
      key: 'q',
      sql: '(p.name LIKE ? OR p.brand LIKE ? OR p.short_desc LIKE ? OR EXISTS (SELECT 1 FROM variants v WHERE v.product_id = p.id AND v.sku LIKE ?))',
      params: [like, like, like, like]
    })
  }

  if (q.badge) {
    const list = multi(q.badge)
    if (list.length) {
      parts.push({
        key: 'badge',
        sql: `(${list.map(() => 'p.badges LIKE ?').join(' OR ')})`,
        params: list.map((b) => `%"${b}"%`)
      })
    }
  }

  if (q.brand) {
    const list = multi(q.brand)
    if (list.length) {
      parts.push({ key: 'brand', sql: `p.brand IN (${list.map(() => '?').join(',')})`, params: list })
    }
  }

  if (q.envase) {
    const list = multi(q.envase).filter((v) => /^[a-z]+$/.test(v))
    if (list.length) {
      parts.push({
        key: 'envase',
        sql: `(${list.map(() => 'p.visual LIKE ?').join(' OR ')})`,
        params: list.map((t) => `%"type":"${t}"%`)
      })
    }
  }

  if (q.talla) {
    const list = multi(q.talla)
    if (list.length) {
      parts.push({
        key: 'talla',
        sql: `EXISTS (SELECT 1 FROM variants v WHERE v.product_id = p.id AND v.format IN (${list.map(() => '?').join(',')}))`,
        params: list.map((t) => `Talla ${t}`)
      })
    }
  }

  if (q.capacidad) {
    // valores tipo "5-L", "0.75-L", "100-ud" (units-etiqueta)
    const pairs = multi(q.capacidad)
      .map((v) => {
        const m = v.match(/^([\d.]+)-(.+)$/)
        return m ? [Number(m[1]), m[2]] : null
      })
      .filter((p): p is [number, string] => !!p && Number.isFinite(p[0]))
    if (pairs.length) {
      parts.push({
        key: 'capacidad',
        sql: `EXISTS (SELECT 1 FROM variants v WHERE v.product_id = p.id AND (${pairs
          .map(() => '(v.units = ? AND v.unit_label = ?)')
          .join(' OR ')}))`,
        params: pairs.flat()
      })
    }
  }

  // ejes de variante estilo mantelería: formato «[Medida · ][Acabado · ]Color Nombre (COD)»
  if (q.color) {
    const list = multi(q.color)
    if (list.length) {
      parts.push({
        key: 'color',
        sql: `EXISTS (SELECT 1 FROM variants v WHERE v.product_id = p.id AND (${list.map(() => 'v.format LIKE ?').join(' OR ')}))`,
        params: list.map((c) => `%Color ${c}`)
      })
    }
  }
  if (q.medida) {
    // las medidas llevan comas («1,20 × 50 m») → separador '|'
    const list = String(q.medida).split('|').map((s) => s.trim()).filter(Boolean)
    if (list.length) {
      parts.push({
        key: 'medida',
        sql: `EXISTS (SELECT 1 FROM variants v WHERE v.product_id = p.id AND (${list.map(() => 'v.format LIKE ?').join(' OR ')}))`,
        params: list.map((m) => `${m} · %`)
      })
    }
  }
  if (q.acabado) {
    const list = multi(q.acabado)
    if (list.length) {
      parts.push({
        key: 'acabado',
        sql: `EXISTS (SELECT 1 FROM variants v WHERE v.product_id = p.id AND (${list.map(() => 'v.format LIKE ?').join(' OR ')}))`,
        params: list.map((a) => `%${a} · Color %`)
      })
    }
  }

  const priceMin = q.price_min != null && q.price_min !== '' ? Math.round(Number(q.price_min) * 100) : null
  const priceMax = q.price_max != null && q.price_max !== '' ? Math.round(Number(q.price_max) * 100) : null
  if ((priceMin != null && !Number.isNaN(priceMin)) || (priceMax != null && !Number.isNaN(priceMax))) {
    const sqls: string[] = []
    const ps: number[] = []
    if (priceMin != null && !Number.isNaN(priceMin)) {
      sqls.push('(SELECT MIN(v.price) FROM variants v WHERE v.product_id = p.id) >= ?')
      ps.push(priceMin)
    }
    if (priceMax != null && !Number.isNaN(priceMax)) {
      sqls.push('(SELECT MIN(v.price) FROM variants v WHERE v.product_id = p.id) <= ?')
      ps.push(priceMax)
    }
    parts.push({ key: 'price', sql: `(${sqls.join(' AND ')})`, params: ps })
  }

  if (q.featured) parts.push({ key: 'featured', sql: 'p.featured = 1', params: [] })

  const where = (exclude: string[] = []) => {
    const use = parts.filter((p) => !exclude.includes(p.key))
    return {
      sql: use.length ? `WHERE ${use.map((p) => p.sql).join(' AND ')}` : '',
      params: use.flatMap((p) => p.params)
    }
  }

  const sortSql =
    {
      price_asc: 'minPrice ASC',
      price_desc: 'minPrice DESC',
      name: 'p.name COLLATE NOCASE ASC'
    }[String(q.sort ?? '')] ?? 'p.featured DESC, p.name COLLATE NOCASE ASC'

  const limit = Math.min(Number(q.limit) || 24, 500)
  const page = Math.max(Number(q.page) || 1, 1)

  const w = where()
  const { total } = db.prepare(`SELECT COUNT(*) AS total FROM products p ${w.sql}`).get(...w.params) as {
    total: number
  }

  const rows = db
    .prepare(
      `SELECT p.id, p.name, p.slug, p.brand, p.badges, p.visual, p.image, p.featured, p.short_desc AS shortDesc, p.category_id AS categoryId,
        (SELECT MIN(v.price) FROM variants v WHERE v.product_id = p.id) AS minPrice,
        (SELECT COUNT(*) FROM variants v WHERE v.product_id = p.id) AS formats
       FROM products p ${w.sql}
       ORDER BY ${sortSql}
       LIMIT ? OFFSET ?`
    )
    .all(...w.params, limit, (page - 1) * limit) as any[]

  let facets: any
  if (q.facets) {
    const rowsFor = (exclude: string[]) => {
      const wx = where(exclude)
      return db
        .prepare(
          `SELECT p.id, p.brand, p.badges, p.visual, p.category_id AS categoryId,
            (SELECT MIN(v.price) FROM variants v WHERE v.product_id = p.id) AS minPrice
           FROM products p ${wx.sql}`
        )
        .all(...wx.params) as any[]
    }
    const tally = (values: string[]) => {
      const map = new Map<string, number>()
      for (const v of values) map.set(v, (map.get(v) ?? 0) + 1)
      return [...map.entries()].map(([value, n]) => ({ value, n })).sort((a, b) => b.n - a.n)
    }

    const brands = tally(rowsFor(['brand']).map((r) => r.brand))
    const badges = tally(rowsFor(['badge']).flatMap((r) => JSON.parse(r.badges) as string[]))
    const envases = tally(rowsFor(['envase']).map((r) => JSON.parse(r.visual).type))

    const priceCtx = rowsFor(['price'])
      .map((r) => r.minPrice)
      .filter((n) => n != null)
    const price = priceCtx.length ? { min: Math.min(...priceCtx), max: Math.max(...priceCtx) } : null

    const tallaIds = rowsFor(['talla']).map((r) => r.id)
    let tallas: Array<{ value: string; n: number }> = []
    if (tallaIds.length) {
      tallas = (
        db
          .prepare(
            `SELECT v.format AS value, COUNT(DISTINCT v.product_id) AS n
             FROM variants v
             WHERE v.product_id IN (${tallaIds.map(() => '?').join(',')}) AND v.format LIKE 'Talla %'
             GROUP BY v.format`
          )
          .all(...tallaIds) as any[]
      )
        .map((r) => ({ value: String(r.value).replace('Talla ', ''), n: r.n }))
        .sort((a, b) => {
          const ia = TALLA_ORDER.indexOf(a.value)
          const ib = TALLA_ORDER.indexOf(b.value)
          return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib)
        })
    }

    const capIds = rowsFor(['capacidad']).map((r) => r.id)
    let capacidades: Array<{ value: string; units: number; label: string; n: number }> = []
    if (capIds.length) {
      const CAP_ORDER: Record<string, number> = { L: 0, kg: 1, ud: 2 }
      capacidades = (
        db
          .prepare(
            `SELECT v.units AS units, v.unit_label AS label, COUNT(DISTINCT v.product_id) AS n
             FROM variants v
             WHERE v.product_id IN (${capIds.map(() => '?').join(',')})
               AND v.units IS NOT NULL AND v.unit_label IS NOT NULL
             GROUP BY v.units, v.unit_label`
          )
          .all(...capIds) as any[]
      )
        .map((r) => ({ value: `${r.units}-${r.label}`, units: r.units, label: r.label, n: r.n }))
        .sort((a, b) => (CAP_ORDER[a.label] ?? 9) - (CAP_ORDER[b.label] ?? 9) || a.units - b.units)
    }

    // ejes de variante (colores/medidas/acabados) parseados del formato «… · Color Nombre (COD)»
    const parseAxes = (format: string) => {
      const segs = String(format).split(' · ')
      const colorM = segs.at(-1)?.match(/^Color (.+)$/)
      return { colorName: colorM?.[1] ?? null, axes: colorM ? segs.slice(0, -1) : [] }
    }
    const variantRowsFor = (excludeKey: string) => {
      const ids = rowsFor([excludeKey]).map((r) => r.id)
      if (!ids.length) return []
      return db
        .prepare(
          `SELECT v.product_id AS pid, v.format, v.color FROM variants v WHERE v.product_id IN (${ids.map(() => '?').join(',')})`
        )
        .all(...ids) as any[]
    }
    const colorMap = new Map<string, { pids: Set<number>; hex: string | null }>()
    for (const r of variantRowsFor('color')) {
      const { colorName } = parseAxes(r.format)
      if (!colorName) continue
      const e = colorMap.get(colorName) ?? { pids: new Set<number>(), hex: null }
      e.pids.add(r.pid)
      if (!e.hex && r.color) e.hex = r.color
      colorMap.set(colorName, e)
    }
    const colores = [...colorMap.entries()]
      .map(([value, e]) => ({ value, n: e.pids.size, hex: e.hex }))
      .sort((a, b) => b.n - a.n || a.value.localeCompare(b.value))
    const tallyAxis = (excludeKey: string, wantMedida: boolean) => {
      const map = new Map<string, Set<number>>()
      for (const r of variantRowsFor(excludeKey)) {
        const { axes, colorName } = parseAxes(r.format)
        if (!colorName) continue
        for (const a of axes) {
          if (/\d/.test(a) !== wantMedida) continue
          const s = map.get(a) ?? new Set<number>()
          s.add(r.pid)
          map.set(a, s)
        }
      }
      return [...map.entries()].map(([value, s]) => ({ value, n: s.size })).sort((a, b) => b.n - a.n)
    }
    const medidas = tallyAxis('medida', true)
    const acabados = tallyAxis('acabado', false)

    // distribución por categoría directa (útil en la página de búsqueda)
    const catNames = new Map(
      (db.prepare('SELECT id, name, slug FROM categories').all() as any[]).map((c) => [c.id, c])
    )
    const catCounts = new Map<number, number>()
    for (const r of rowsFor(['category'])) catCounts.set(r.categoryId, (catCounts.get(r.categoryId) ?? 0) + 1)
    const categories = [...catCounts.entries()]
      .map(([id, n]) => ({ ...(catNames.get(id) ?? { name: '?', slug: '' }), n }))
      .sort((a, b) => b.n - a.n)

    facets = { brands, badges, envases, tallas, capacidades, colores, medidas, acabados, price, categories }
  }

  return {
    items: rows.map((r) => ({ ...r, badges: JSON.parse(r.badges), visual: JSON.parse(r.visual) })),
    total,
    page,
    pages: Math.max(Math.ceil(total / limit), 1),
    facets
  }
})
