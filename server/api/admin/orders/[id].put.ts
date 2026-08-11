import { z } from 'zod'

const schema = z.object({
  status: z.enum([
    'pendiente_pago',
    'pendiente_transferencia',
    'pagado',
    'preparando',
    'enviado',
    'entregado',
    'cancelado'
  ])
})

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const db = useDb()
  const id = String(getRouterParam(event, 'id'))
  const body = await readValidatedBody(event, schema.parse)
  const info = db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(body.status, id)
  if (!info.changes) throw createError({ statusCode: 404, statusMessage: 'Pedido no encontrado' })
  return { id, status: body.status }
})
