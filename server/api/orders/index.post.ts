import { z } from 'zod'

const schema = z.object({
  customer: z.object({
    name: z.string().min(2, 'Indica el nombre completo'),
    company: z.string().optional().default(''),
    nif: z.string().optional().default(''),
    email: z.string().email('Email no válido'),
    phone: z.string().min(6, 'Indica un teléfono de contacto'),
    address: z.string().min(4, 'Indica la dirección'),
    zip: z.string().min(4, 'Indica el código postal'),
    city: z.string().min(2, 'Indica la población'),
    province: z.string().optional().default('Valencia'),
    notes: z.string().optional().default('')
  }),
  shippingMethod: z.enum(['reparto', 'envio', 'recogida']),
  paymentMethod: z.enum(['tarjeta', 'bizum', 'transferencia']),
  items: z
    .array(z.object({ variantId: z.number().int().positive(), qty: z.number().int().min(1).max(999) }))
    .min(1, 'El carrito está vacío')
})

export default defineEventHandler(async (event) => {
  const body = await readValidatedBody(event, schema.parse)
  const db = useDb()

  // precios siempre desde la base de datos, nunca del cliente
  const lines = body.items.map(({ variantId, qty }) => {
    const v = db
      .prepare(
        `SELECT v.id, v.format, v.sku, v.price, p.id AS productId, p.name, p.active
         FROM variants v JOIN products p ON p.id = v.product_id WHERE v.id = ?`
      )
      .get(variantId) as any
    if (!v) throw createError({ statusCode: 400, statusMessage: `Artículo no disponible (ref. ${variantId})` })
    if (!v.active) throw createError({ statusCode: 400, statusMessage: `«${v.name}» ya no está disponible; retíralo del carrito` })
    return { ...v, qty }
  })

  const subtotal = lines.reduce((acc, l) => acc + l.price * l.qty, 0)
  const shippingCost = body.shippingMethod === 'envio' && subtotal < 15000 ? 590 : 0
  const total = subtotal + shippingCost
  const tax = total - Math.round(total / 1.21)

  const session = await getUserSession(event)
  const userId = (session.user as any)?.id ?? null

  const id = `NE-${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 36 ** 2)
    .toString(36)
    .toUpperCase()
    .padStart(2, '0')}`
  const token = crypto.randomUUID()
  const status = body.paymentMethod === 'transferencia' ? 'pendiente_transferencia' : 'pendiente_pago'
  const c = body.customer

  db.transaction(() => {
    db.prepare(
      `INSERT INTO orders (id, token, user_id, status, name, company, nif, email, phone, address, zip, city, province, notes,
         shipping_method, shipping_cost, payment_method, subtotal, tax, total)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, token, userId, status,
      c.name, c.company, c.nif, c.email.toLowerCase(), c.phone, c.address, c.zip, c.city, c.province, c.notes,
      body.shippingMethod, shippingCost, body.paymentMethod, subtotal, tax, total
    )
    const ins = db.prepare(
      `INSERT INTO order_items (order_id, product_id, variant_id, name, format, sku, price, qty)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const l of lines) ins.run(id, l.productId, l.id, l.name, l.format, l.sku, l.price, l.qty)
  })()

  return { id, token, status, total }
})
