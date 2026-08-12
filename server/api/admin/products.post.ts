export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const body = await readValidatedBody(event, productInput.parse)
  const db = useDb()

  if (!db.prepare('SELECT 1 FROM categories WHERE id = ?').get(body.categoryId)) {
    throw createError({ statusCode: 400, statusMessage: 'La familia elegida no existe' })
  }

  const slug = ensureUniqueSlug(db, 'products', slugify(body.name))

  try {
    const id = db.transaction(() => {
      const info = db
        .prepare(
          `INSERT INTO products (name, slug, brand, category_id, short_desc, description, usage, badges, visual, featured, active, series, attrs)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
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
          JSON.stringify(body.attrs)
        )
      const pid = Number(info.lastInsertRowid)
      const ins = db.prepare(
        'INSERT INTO variants (product_id, format, sku, price, stock, units, unit_label, color, image) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      body.variants.forEach((v, i) => {
        const u = unitsFor(v.format, body.name)
        ins.run(
          pid,
          v.format,
          v.sku?.trim() || `NE-${pid}-${i + 1}`,
          Math.round(v.price * 100),
          v.stock,
          u?.[0] ?? null,
          u?.[1] ?? null,
          v.color || null,
          v.image || null
        )
      })
      return pid
    })()
    return { id, slug }
  } catch (e: any) {
    if (String(e?.message).includes('UNIQUE')) {
      throw createError({ statusCode: 400, statusMessage: 'Hay una referencia (SKU) que ya existe en otro producto' })
    }
    throw e
  }
})
