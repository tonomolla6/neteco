import { z } from 'zod'
import { useDatabase } from '../../../db/client'
import { requireCustomerAccount } from '../../../utils/account'

const paramsSchema = z.object({ id: z.string().uuid() })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, paramsSchema.parse)
  const account = await requireCustomerAccount(event)
  if (id === account.session.sessionId) {
    throw createError({ statusCode: 409, statusMessage: 'Usa “Cerrar sesión” para revocar la sesión actual' })
  }
  const sql = useDatabase()
  const [revoked] = await sql<{ id: string }[]>`
    UPDATE auth_sessions SET revoked_at = now()
    WHERE id = ${id} AND identity_id = ${account.profile.id} AND revoked_at IS NULL
    RETURNING id
  `
  if (!revoked) throw createError({ statusCode: 404, statusMessage: 'Sesión no encontrada' })
  return { ok: true }
})
