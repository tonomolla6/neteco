import type { H3Event } from 'h3'
import { useDatabase } from '../db/client'
import { requireVerifiedIdentity } from './auth-session'

export async function requireCustomerAccount(event: H3Event) {
  const authenticated = await requireVerifiedIdentity(event)
  const sql = useDatabase()
  const [account] = await sql<{ customerId: string }[]>`
    SELECT customer_id AS "customerId" FROM identities WHERE id = ${authenticated.profile.id}
  `
  if (!account?.customerId)
    throw createError({ statusCode: 409, statusMessage: 'La identidad no tiene perfil de cliente' })
  return { ...authenticated, customerId: account.customerId }
}
