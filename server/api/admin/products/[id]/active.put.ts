import { z } from 'zod'

const schema = z.object({ active: z.boolean() })

// Interruptor rápido publicar/ocultar sin tocar el resto de la ficha
export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const db = useDb()
  const id = Number(getRouterParam(event, 'id'))
  const { active } = await readValidatedBody(event, schema.parse)
  const info = db.prepare('UPDATE products SET active = ? WHERE id = ?').run(active ? 1 : 0, id)
  if (!info.changes) throw createError({ statusCode: 404, statusMessage: 'Producto no encontrado' })
  return { id, active }
})
