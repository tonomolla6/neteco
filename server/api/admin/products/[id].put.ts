export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const db = useDb()
  const id = Number(getRouterParam(event, 'id'))
  const body = await readValidatedBody(event, productInput.parse)

  const existing = db.prepare('SELECT id, name, slug FROM products WHERE id = ?').get(id) as any
  if (!existing) throw createError({ statusCode: 404, statusMessage: 'Producto no encontrado' })
  if (!db.prepare('SELECT 1 FROM categories WHERE id = ?').get(body.categoryId)) {
    throw createError({ statusCode: 400, statusMessage: 'La familia elegida no existe' })
  }

  // el slug solo cambia si cambia el nombre (las URLs se mantienen estables al editar precios)
  const slug =
    body.name === existing.name ? existing.slug : ensureUniqueSlug(db, 'products', slugify(body.name), id)

  try {
    db.transaction(() => {
      db.prepare(
        `UPDATE products SET name = ?, slug = ?, brand = ?, category_id = ?, short_desc = ?, description = ?,
           usage = ?, badges = ?, visual = ?, featured = ?, active = ?, series = ? WHERE id = ?`
      ).run(
        body.name,
        slug,
        body.brand || null,
        body.categoryId,
        body.shortDesc,
        body.description,
        body.usage || null,
        JSON.stringify(body.badges),
        JSON.stringify(body.visual),
        body.featured ? 1 : 0,
        body.active ? 1 : 0,
        body.series || null,
        id
      )

      const currentIds = (db.prepare('SELECT id FROM variants WHERE product_id = ?').all(id) as any[]).map(
        (r) => r.id as number
      )
      const keptIds = body.variants.filter((v) => v.id != null).map((v) => v.id as number)
      const removed = currentIds.filter((vid) => !keptIds.includes(vid))
      if (removed.length) {
        db.prepare(`DELETE FROM variants WHERE id IN (${removed.map(() => '?').join(',')})`).run(...removed)
      }

      const upd = db.prepare(
        'UPDATE variants SET format = ?, sku = ?, price = ?, stock = ?, units = ?, unit_label = ?, color = ?, image = ? WHERE id = ? AND product_id = ?'
      )
      const ins = db.prepare(
        'INSERT INTO variants (product_id, format, sku, price, stock, units, unit_label, color, image) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      body.variants.forEach((v, i) => {
        const u = unitsFor(v.format, body.name)
        const sku = v.sku?.trim() || `NE-${id}-${i + 1}`
        const extra = [u?.[0] ?? null, u?.[1] ?? null, v.color || null, v.image || null]
        if (v.id != null) upd.run(v.format, sku, Math.round(v.price * 100), v.stock, ...extra, v.id, id)
        else ins.run(id, v.format, sku, Math.round(v.price * 100), v.stock, ...extra)
      })
    })()
    return { id, slug }
  } catch (e: any) {
    if (String(e?.message).includes('UNIQUE')) {
      throw createError({ statusCode: 400, statusMessage: 'Hay una referencia (SKU) que ya existe en otro producto' })
    }
    throw e
  }
})
