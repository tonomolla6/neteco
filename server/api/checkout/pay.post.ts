import { z } from 'zod'

const schema = z.object({
  orderId: z.string(),
  token: z.string(),
  method: z.enum(['tarjeta', 'bizum']),
  card: z.object({ number: z.string(), exp: z.string(), cvc: z.string() }).optional(),
  bizumPhone: z.string().optional()
})

// Pasarela SIMULADA para la demo: aquí se integraría Redsys/Stripe en producción.
export default defineEventHandler(async (event) => {
  const body = await readValidatedBody(event, schema.parse)
  const db = useDb()

  const order = db
    .prepare('SELECT id, status FROM orders WHERE id = ? AND token = ?')
    .get(body.orderId, body.token) as any
  if (!order) throw createError({ statusCode: 404, statusMessage: 'Pedido no encontrado' })
  if (order.status !== 'pendiente_pago') {
    throw createError({ statusCode: 400, statusMessage: 'Este pedido no admite pago' })
  }

  // latencia simulada del TPV
  await new Promise((r) => setTimeout(r, 900))

  if (body.method === 'tarjeta') {
    const num = (body.card?.number ?? '').replace(/\s/g, '')
    if (num.length < 12) {
      return { ok: false, error: 'Número de tarjeta no válido.' }
    }
    if (num.endsWith('0000')) {
      return { ok: false, error: 'Pago rechazado por el banco emisor (tarjeta de prueba terminada en 0000).' }
    }
  }
  if (body.method === 'bizum' && (body.bizumPhone ?? '').replace(/\D/g, '').length < 9) {
    return { ok: false, error: 'Introduce un teléfono válido para Bizum.' }
  }

  db.prepare('UPDATE orders SET status = ?, payment_method = ? WHERE id = ?').run(
    'pagado',
    body.method,
    order.id
  )
  return { ok: true }
})
