import type { H3Event } from 'h3'

export async function requireAdmin(event: H3Event) {
  const session = await getUserSession(event)
  const user = session.user as any
  if (!user?.id || user.role !== 'admin') {
    throw createError({ statusCode: 403, statusMessage: 'Acceso solo para administradores' })
  }
  return user
}
